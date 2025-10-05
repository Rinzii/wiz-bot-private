import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Kick", "Guild only.")] });
    }

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);

    if (!member) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Kick", "User not found in guild.")] });
    }

    if (!member.kickable) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Kick", "Cannot kick this member.")] });
    }

    try {
      await member.kick(reason);
      return interaction.reply({ embeds: [infoEmbed("Kick", `Kicked **${target.tag}**.\nReason: ${reason}`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Kick", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Kick a member from the guild.",
    usage: "/kick user:@User [reason:<text>]",
    examples: ["/kick user:@Spammer reason:raid"],
    permissions: "Kick Members"
  }
};
