import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

const MAX_FETCH_ITERATIONS = 10;
const BULK_DELETE_WINDOW = 13 * 24 * 60 * 60 * 1000; // just under 14 days

async function fetchMessages(channel, beforeId) {
  return channel.messages.fetch({ limit: 100, before: beforeId || undefined }).catch(() => null);
}

async function collectMessages(channel, predicate, amount) {
  const collected = [];
  let before;
  for (let i = 0; i < MAX_FETCH_ITERATIONS && collected.length < amount; i++) {
    const batch = await fetchMessages(channel, before);
    if (!batch || batch.size === 0) break;
    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const message of sorted) {
      if (Date.now() - message.createdTimestamp > BULK_DELETE_WINDOW) continue;
      if (predicate(message)) collected.push(message);
      if (collected.length >= amount) break;
    }
    before = sorted.at(-1)?.id;
    if (!before) break;
  }
  return collected;
}

async function deleteMessages(channel, messages) {
  if (!messages.length) return 0;
  const ids = messages.map(m => m.id);
  const deleted = await channel.bulkDelete(ids, true).catch(() => null);
  return deleted?.size || 0;
}

function ensureTextChannel(interaction) {
  const { channel } = interaction;
  if (!channel || !channel.isTextBased?.() || channel.type !== ChannelType.GuildText) {
    return false;
  }
  return true;
}

export default {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk delete messages with filters")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s => s
      .setName("recent")
      .setDescription("Delete the most recent messages")
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s
      .setName("user")
      .setDescription("Delete recent messages from a user")
      .addUserOption(o => o.setName("user").setDescription("User to target").setRequired(true))
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s
      .setName("contains")
      .setDescription("Delete messages containing text")
      .addStringOption(o => o.setName("text").setDescription("Substring to match").setRequired(true))
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s
      .setName("links")
      .setDescription("Delete recent messages containing links")
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s
      .setName("invites")
      .setDescription("Delete recent messages containing invites")
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s
      .setName("bots")
      .setDescription("Delete recent bot messages")
      .addIntegerOption(o => o.setName("count").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Purge", "Guild only.")] });
    }
    if (!ensureTextChannel(interaction)) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Purge", "Use in a text channel.")] });
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const { channel } = interaction;
    let deleted = 0;

    try {
      if (sub === "recent") {
        const count = interaction.options.getInteger("count", true);
        deleted = await channel.bulkDelete(count, true).then(col => col.size).catch(() => 0);
      } else if (sub === "user") {
        const user = interaction.options.getUser("user", true);
        const count = interaction.options.getInteger("count", true);
        const msgs = await collectMessages(channel, (m) => m.author?.id === user.id, count);
        deleted = await deleteMessages(channel, msgs);
      } else if (sub === "contains") {
        const text = interaction.options.getString("text", true).toLowerCase();
        const count = interaction.options.getInteger("count", true);
        const msgs = await collectMessages(channel, (m) => (m.content || "").toLowerCase().includes(text), count);
        deleted = await deleteMessages(channel, msgs);
      } else if (sub === "links") {
        const count = interaction.options.getInteger("count", true);
        const linkRegex = /https?:\/\/|discord\.gg\//i;
        const msgs = await collectMessages(channel, (m) => linkRegex.test(m.content || "") || (m.embeds?.length ?? 0) > 0 || (m.attachments?.size ?? 0) > 0, count);
        deleted = await deleteMessages(channel, msgs);
      } else if (sub === "invites") {
        const count = interaction.options.getInteger("count", true);
        const inviteRegex = /discord\.gg\//i;
        const msgs = await collectMessages(channel, (m) => inviteRegex.test(m.content || ""), count);
        deleted = await deleteMessages(channel, msgs);
      } else if (sub === "bots") {
        const count = interaction.options.getInteger("count", true);
        const msgs = await collectMessages(channel, (m) => Boolean(m.author?.bot), count);
        deleted = await deleteMessages(channel, msgs);
      }
    } catch (err) {
      return interaction.editReply({ embeds: [infoEmbed("Purge", `Failed: ${err?.message || err}`)] });
    }

    return interaction.editReply({ embeds: [infoEmbed("Purge", `Deleted **${deleted}** message(s).`)] });
  },
  meta: {
    category: "moderation",
    description: "Delete recent messages with optional filters.",
    usage: "/purge <recent|user|contains|links|invites|bots>",
    examples: [
      "/purge recent count:25",
      "/purge user user:@Spammer count:10",
      "/purge contains text:spam count:15"
    ],
    permissions: "Manage Messages"
  }
};
