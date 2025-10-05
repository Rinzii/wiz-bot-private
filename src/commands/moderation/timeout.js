import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { parseDuration } from "../../utils/time.js";

export default {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member for a duration")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Duration (e.g. 30m, 1h30m)").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Timeout", "Guild only.")] });
    }

    const target = interaction.options.getUser("user", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";

    let durationMs;
    try {
      const parsed = parseDuration(durationInput);
      if (!parsed?.ms) throw new Error("Invalid duration");
      durationMs = parsed.ms;
    } catch (err) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Timeout", `Invalid duration: ${err?.message || err}`)]
      });
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Timeout", "User not found in guild.")] });
    }

    if (!member.moderatable) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Timeout", "Cannot timeout this member.")] });
    }

    try {
      await member.timeout(durationMs, reason);
      return interaction.reply({ embeds: [infoEmbed("Timeout", `Timed out **${target.tag}** for **${durationInput}**\nReason: ${reason}`)] });
    } catch (err) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Timeout", `Failed to timeout: ${err?.message || err}`)]
      });
    }
  },
  meta: {
    category: "moderation",
    description: "Timeout a member for a set duration.",
    usage: "/timeout user:@User duration:30m [reason:<text>]",
    examples: ["/timeout user:@Spammer duration:15m reason:Spam"],
    permissions: "Timeout Members"
  }
};
