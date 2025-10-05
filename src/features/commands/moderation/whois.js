import { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";

function formatDate(date) {
  if (!date) return "Unknown";
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("whois")
    .setDescription("Display information about a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Use this command in a server." });
    }

    const target = interaction.options.getUser("user", true);
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const svc = interaction.client.container.get(TOKENS.ModerationLogService);
    const cases = await svc.list({ guildId: interaction.guildId, userId: target.id, limit: 5 });

    const roles = member ? member.roles.cache.filter(r => r.id !== interaction.guild.roles.everyone.id).map(r => r.toString()).join(", ") || "None" : "Not in guild";
    const embed = new EmbedBuilder()
      .setTitle(`Whois: ${target.tag}`)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "User ID", value: target.id, inline: true },
        { name: "Account Created", value: formatDate(target.createdAt), inline: true },
        { name: "Joined Server", value: member ? formatDate(member.joinedAt) : "Not present", inline: true },
        { name: "Roles", value: roles },
        { name: "Recent Cases", value: cases.length ? cases.map(c => `#${c.caseNumber} — ${c.action}`).join("\n") : "No recent cases" }
      )
      .setTimestamp(new Date());

    const perms = member?.permissions?.toArray?.() || [];
    if (perms.length) {
      const keyPerms = perms.filter(name => [
        "Administrator",
        "ManageGuild",
        "ManageMessages",
        "BanMembers",
        "KickMembers"
      ].includes(name));
      if (keyPerms.length) {
        embed.addFields({ name: "Key Permissions", value: keyPerms.map(p => `• ${p}`).join("\n") });
      }
    }

    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed] });
  },
  meta: {
    category: "moderation",
    description: "Show key details about a member.",
    usage: "/whois user:@User",
    examples: ["/whois user:@Member"],
    permissions: "Moderate Members"
  }
};
