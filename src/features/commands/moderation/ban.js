import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";
import { parseDuration } from "../../../shared/utils/time.js";

export default {
  data: new SlashCommandBuilder()
    .setName("ban").setDescription("Ban a member")
    .addUserOption(o => o.setName("user").setDescription("User to ban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .addStringOption(o => o.setName("duration").setDescription("Duration (e.g. 7d12h)"))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Ban", "Guild only.")]
      });
    }
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const durationInput = interaction.options.getString("duration");

    let parsedDuration = null;
    if (durationInput) {
      try {
        parsedDuration = parseDuration(durationInput);
        if (!parsedDuration?.ms) parsedDuration = null;
      } catch (err) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [infoEmbed("Ban", `Invalid duration: ${err?.message || err}`)]
        });
      }
    }

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Ban", "User not in guild.")]
      });
    }

    const mod = interaction.client.container.get(TOKENS.ModerationService);
    try {
      await mod.ban({
        guild: interaction.guild,
        target: member,
        moderator: interaction.user,
        reason,
        durationMs: parsedDuration?.ms ?? null,
        metadata: { commandId: interaction.commandId }
      });
      const durationText = parsedDuration?.human ? `\n**Duration:** ${parsedDuration.human}` : "";
      return interaction.reply({
        embeds: [infoEmbed("Ban", `Banned **${user.tag}**\n**Reason:** ${reason}${durationText}`)]
      });
    } catch (e) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Ban", `Failed: ${e?.message || e}`)]
      });
    }
  },
  meta: {
    category: "moderation",
    description: "Ban a member from the server.",
    usage: "/ban user:@User [reason:<text>] [duration:<time>]",
    examples: ["/ban user:@Spammer reason:raid bot duration:7d"],
    permissions: "Ban Members"
  }
};
