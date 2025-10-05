import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed, listEmbed } from "../../utils/embeds.js";
import { TOKENS } from "../../container.js";

function formatCase(entry) {
  const lines = [
    `**Case:** #${entry.caseNumber}`,
    `**User:** <@${entry.userId}>`,
    `**Action:** ${entry.action}`,
    `**Reason:** ${entry.reason || "No reason"}`
  ];
  if (entry.durationMs) lines.push(`**Duration:** ${Math.round(entry.durationMs / 1000)}s`);
  return lines.join("\n");
}

export default {
  data: new SlashCommandBuilder()
    .setName("case")
    .setDescription("Moderation case lookup")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s
      .setName("show")
      .setDescription("Show a specific case")
      .addIntegerOption(o => o.setName("id").setDescription("Case number").setRequired(true)))
    .addSubcommand(s => s
      .setName("search")
      .setDescription("Search cases for a user")
      .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Case", "Guild only.")] });
    }

    const svc = interaction.client.container.get(TOKENS.ModerationLogService);
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      const id = interaction.options.getInteger("id", true);
      const entry = await svc.getByCase(interaction.guildId, id);
      if (!entry) {
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Case", "Case not found.")] });
      }
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed(`Case #${entry.caseNumber}`, formatCase(entry))] });
    }

    const user = interaction.options.getUser("user", true);
    const entries = await svc.list({ guildId: interaction.guildId, userId: user.id, limit: 10 });
    const lines = entries.map(e => `#${e.caseNumber} — ${e.action} — ${e.reason}`);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed(`Cases for ${user.tag}`, lines, "No cases found.")] });
  },
  meta: {
    category: "moderation",
    description: "Search the moderation case log.",
    usage: "/case show id:42 | /case search user:@User",
    examples: ["/case show id:100", "/case search user:@Trouble"],
    permissions: "Moderate Members"
  }
};
