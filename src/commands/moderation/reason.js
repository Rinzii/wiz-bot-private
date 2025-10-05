import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { TOKENS } from "../../container.js";

export default {
  data: new SlashCommandBuilder()
    .setName("reason")
    .setDescription("Update the reason for a moderation case")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addIntegerOption(o => o.setName("case_id").setDescription("Case number").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("New reason").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Reason", "Guild only.")] });
    }

    const caseId = interaction.options.getInteger("case_id", true);
    const reason = interaction.options.getString("reason", true);
    const svc = interaction.client.container.get(TOKENS.ModerationLogService);

    const updated = await svc.updateReason({ guildId: interaction.guildId, caseNumber: caseId, reason });
    if (!updated) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Reason", "Case not found.")] });
    }
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Reason", `Updated case #${updated.caseNumber}.`)] });
  },
  meta: {
    category: "moderation",
    description: "Edit the reason for a logged moderation action.",
    usage: "/reason case_id:42 reason:Updated reason",
    examples: ["/reason case_id:25 reason:Appeal accepted"],
    permissions: "Moderate Members"
  }
};
