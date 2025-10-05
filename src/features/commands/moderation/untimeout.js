import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a timeout from a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Untimeout", "Guild only.")] });
    }

    const target = interaction.options.getUser("user", true);
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Untimeout", "User not found in guild.")] });
    }

    if (!member.isCommunicationDisabled()) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Untimeout", "Member is not currently timed out.")]
      });
    }

    try {
      await member.timeout(null, "Timeout cleared via command");
      return interaction.reply({ embeds: [infoEmbed("Untimeout", `Removed timeout for **${target.tag}**.`)] });
    } catch (err) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Untimeout", `Failed to remove timeout: ${err?.message || err}`)]
      });
    }
  },
  meta: {
    category: "moderation",
    description: "Remove an active communication timeout.",
    usage: "/untimeout user:@User",
    examples: ["/untimeout user:@Spammer"],
    permissions: "Timeout Members"
  }
};
