import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { TOKENS } from "../../container.js";
import { infoEmbed } from "../../utils/embeds.js";

const MAX_DELETE_DAYS = 7;
const DEFAULT_DELETE_DAYS = 1;

export default {
  data: new SlashCommandBuilder()
    .setName("softban")
    .setDescription("Ban and immediately unban a member, deleting recent messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("User to softban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason"))
    .addIntegerOption(o => o
      .setName("days")
      .setDescription("Delete messages from the past N days (0-7)")
      .setMinValue(0)
      .setMaxValue(MAX_DELETE_DAYS)
    ),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Softban", "Guild only.")]
      });
    }

    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const deleteDaysInput = interaction.options.getInteger("days");
    const deleteDays = deleteDaysInput === null || deleteDaysInput === undefined
      ? DEFAULT_DELETE_DAYS
      : Math.min(Math.max(deleteDaysInput, 0), MAX_DELETE_DAYS);
    const deleteSeconds = deleteDays * 24 * 60 * 60;

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Softban", "User not in guild.")]
      });
    }

    if (!member.bannable) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Softban", "Cannot softban this member.")]
      });
    }

    const mod = interaction.client.container.get(TOKENS.ModerationService);

    try {
      await mod.softban({
        guild: interaction.guild,
        target: member,
        moderator: interaction.user,
        reason,
        deleteMessageSeconds: deleteSeconds,
        metadata: { commandId: interaction.commandId }
      });

      const pruneLabel = deleteDays === 1 ? "day" : `${deleteDays} days`;
      const pruneText = deleteDays > 0
        ? `\n**Deleted Messages:** Last ${pruneLabel}`
        : "";

      return interaction.reply({
        embeds: [infoEmbed("Softban", `Softbanned **${user.tag}**\n**Reason:** ${reason}${pruneText}`)]
      });
    } catch (err) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Softban", `Failed: ${err?.message || err}`)]
      });
    }
  },
  meta: {
    category: "moderation",
    description: "Softban a member to delete their recent messages.",
    usage: "/softban user:@User [reason:<text>] [days:<0-7>]",
    examples: ["/softban user:@Spammer reason:spam days:1"],
    permissions: "Ban Members"
  }
};
