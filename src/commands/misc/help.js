import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { hasDefaultPerms, hasAppLevelPerms } from "../../utils/permissions.js";

function titleCase(s) {
  return String(s || "general")
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function collectVisible(interaction) {
  const byCat = new Map();
  const byName = new Map();

  for (const [name, cmd] of interaction.client.commands.entries()) {
    if (!cmd?.meta) continue; // only commands that opted into help
    if (!hasDefaultPerms(interaction.member, cmd)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await hasAppLevelPerms(interaction, cmd))) continue;

    const meta = cmd.meta;
    const rec = {
      name,
      desc: meta.description || cmd.data?.description || "—",
      usage: meta.usage || `/${name}`,
      examples: Array.isArray(meta.examples) ? meta.examples : [],
      permissionsLabel: meta.permissions || null,
      category: (meta.category || "general").toLowerCase()
    };

    byName.set(name, rec);
    if (!byCat.has(rec.category)) byCat.set(rec.category, []);
    byCat.get(rec.category).push(rec);
  }

  for (const [, items] of byCat) items.sort((a, b) => a.name.localeCompare(b.name));
  return { byCat, byName };
}

function buildOverview(byCat, interaction) {
  const fields = [];
  const cats = [...byCat.keys()].sort();

  for (const cat of cats) {
    const items = byCat.get(cat);
    const text = items
      .map(i => `\`/${i.name}\` — ${i.desc}`)
      .join("\n")
      .slice(0, 1024);

    fields.push({ name: titleCase(cat), value: text || "—", inline: false });
  }

  const embeds = [];
  for (let i = 0; i < fields.length; i += 24) {
    const slice = fields.slice(i, i + 24);
    embeds.push(
      new EmbedBuilder()
        .setAuthor({
          name: interaction.client.user?.username ?? "Bot",
          iconURL: interaction.client.user?.displayAvatarURL?.() ?? null
        })
        .setTitle("Help")
        .setDescription("Commands you can use now, grouped by category.")
        .addFields(slice)
        .setFooter({ text: "Tip: /help command:<name> for details" })
    );
  }
  return embeds.length ? embeds : [new EmbedBuilder().setTitle("Help").setDescription("No commands available.")];
}

function buildDetail(rec) {
  const spec = [
    `**Usage**\n\`${rec.usage}\``,
    rec.permissionsLabel ? `**Requires**\n${rec.permissionsLabel}` : null,
    rec.examples?.length ? `**Examples**\n${rec.examples.map(e => `\`${e}\``).join("\n")}` : null
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1024);

  return new EmbedBuilder()
    .setTitle(`/${rec.name}`)
    .setDescription(rec.desc)
    .addFields(
      { name: "Category", value: titleCase(rec.category), inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "Details", value: spec || "—", inline: false }
    );
}

export default {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help for commands you can use, or details for one")
    .addStringOption(o =>
      o.setName("command").setDescription("Command name for detailed help").setRequired(false)
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
    }

    const wanted = interaction.options.getString("command")?.toLowerCase() || null;
    const { byCat, byName } = await collectVisible(interaction);

    if (wanted) {
      const rec = byName.get(wanted);
      if (!rec) {
        return interaction.reply({
          content:
            `Either \`/${wanted}\` doesn't exist, lacks metadata, or you don't have permission to use it.`,
          flags: MessageFlags.Ephemeral
        });
      }
      return interaction.reply({ embeds: [buildDetail(rec)], flags: MessageFlags.Ephemeral });
    }

    const embeds = buildOverview(byCat, interaction);
    return interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
  },

  meta: {
    category: "general",
    description: "Clean, categorized help (no emoji). Use `/help command:<name>` for details.",
    usage: "/help [command]",
    examples: ["/help", "/help command:ban"]
  }
};
