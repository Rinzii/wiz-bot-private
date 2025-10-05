import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { listEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("health")
    .setDescription("Guild health checks")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName("perms").setDescription("Audit common permission mistakes")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Health", [], "Guild only.")] });
    }

    const issues = [];
    const everyone = interaction.guild.roles.everyone;
    interaction.guild.channels.cache.forEach(channel => {
      if (channel.type !== ChannelType.GuildText) return;
      const perms = channel.permissionsFor(everyone);
      if (!perms) return;
      if (perms.has(PermissionFlagsBits.ManageMessages)) {
        issues.push(`${channel}: @everyone can Manage Messages`);
      }
      if (perms.has(PermissionFlagsBits.ManageChannels)) {
        issues.push(`${channel}: @everyone can Manage Channels`);
      }
      if (perms.has(PermissionFlagsBits.MentionEveryone)) {
        issues.push(`${channel}: @everyone can Mention @everyone`);
      }
    });

    const embed = listEmbed("Permission Audit", issues, "No obvious permission risks detected.");
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed] });
  },
  meta: {
    category: "moderation",
    description: "Check for risky permission grants.",
    usage: "/health perms",
    examples: ["/health perms"],
    permissions: "Manage Server"
  }
};
