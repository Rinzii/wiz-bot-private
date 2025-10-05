import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Remove a guild ban")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName("user").setDescription("User ID or tag").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unban", "Guild only.")] });
    }

    const input = interaction.options.getString("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const bans = await interaction.guild.bans.fetch().catch(() => null);
    if (!bans) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unban", "Unable to fetch ban list.")] });
    }

    const ban = bans.find(b => b.user.id === input || b.user.tag === input);
    if (!ban) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unban", "Ban not found.")] });
    }

    try {
      await interaction.guild.bans.remove(ban.user.id, reason);
      return interaction.reply({ embeds: [infoEmbed("Unban", `Removed ban for **${ban.user.tag}**.`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unban", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Remove a ban from the guild.",
    usage: "/unban user:<id|tag> [reason:<text>]",
    examples: ["/unban user:123456789012345678 reason:Appealed"],
    permissions: "Ban Members"
  }
};
