import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, OverwriteType, MessageFlags } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";
import { infoEmbed, listEmbed } from "../../../shared/utils/embeds.js";

const CHANNEL_SPECS = [
  { key: "flag_log",         name: "🚩-flag-log" },
  { key: "experimental_log", name: "😲-experimental-log" },
  { key: "action_log",       name: "🔨-action-log" },
  { key: "join_boost_log",   name: "📥-join-boost-log" },
  { key: "member_log",       name: "👥-member-log" },
  { key: "message_log",      name: "💬-message-log" },
  { key: "bot_log",          name: "🤖-bot-log" }
];

async function ensureCategory(guild, name, overwrites) {
  let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (cat) {
    if (overwrites?.length) await cat.permissionOverwrites.set(overwrites).catch(() => {});
  } else {
    cat = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  }
  try { await cat.setPosition(0); } catch {}
  return cat;
}
async function ensureTextChannel(guild, name, parentId, overwrites) {
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  if (existing) {
    if (existing.parentId !== parentId) await existing.setParent(parentId, { lockPermissions: false }).catch(() => {});
    if (overwrites?.length) await existing.permissionOverwrites.set(overwrites).catch(() => {});
    return existing;
  }
  return guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId, permissionOverwrites: overwrites });
}

export default {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Server setup helpers")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("logs").setDescription("Create Staff Logs category & channels and map them")),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Setup", "Guild only.")] });

    const cms = interaction.client.container.get(TOKENS.ChannelMapService);
    const srs = interaction.client.container.get(TOKENS.StaffRoleService);

    const staffRoleIds = await srs.getAllRoleIdsForKeys(interaction.guildId, ["admin", "mod"]);
    if (!staffRoleIds.length) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Setup", "No staff roles mapped yet. Use `/staffroles add key:admin role:@Admins` and `/staffroles add key:mod role:@Moderators` first, then retry.")]
      });
    }

    const everyoneId = interaction.guild.roles.everyone.id;
    const overwrites = [
      { id: everyoneId, deny: ['ViewChannel'], type: OverwriteType.Role },
      ...staffRoleIds.map(id => ({ id, allow: ['ViewChannel','SendMessages','ReadMessageHistory'], type: OverwriteType.Role }))
    ];

    const cat = await ensureCategory(interaction.guild, "Staff Logs", overwrites);

    const created = [];
    for (const spec of CHANNEL_SPECS) {
      const ch = await ensureTextChannel(interaction.guild, spec.name, cat.id, overwrites);
      await cms.set(interaction.guildId, spec.key, ch.id, "auto-created by /setup logs");
      created.push(`• **${spec.key}** → <#${ch.id}>`);
    }

    const botLog = await cms.get(interaction.guildId, "bot_log");
    if (botLog?.channelId) await cms.set(interaction.guildId, "mod_log", botLog.channelId, "alias to bot_log");

    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Staff Logs setup complete", created)] });
  },
  meta: {
    category: "admin",
    description: "Creates locked Staff Logs category at top and wires channel map.",
    usage: "/setup logs",
    examples: ["/setup logs"],
    permissions: "Administrator"
  }
};
