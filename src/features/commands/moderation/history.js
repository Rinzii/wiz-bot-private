import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { listEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";

function formatEntry(entry) {
  const when = `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>`;
  return `#${entry.caseNumber} — ${entry.action} — ${entry.reason} (${when})`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show a user's moderation history")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("History", [], "Guild only.")] });
    }

    const user = interaction.options.getUser("user", true);
    const svc = interaction.client.container.get(TOKENS.ModerationLogService);
    const entries = await svc.list({ guildId: interaction.guildId, userId: user.id, limit: 20 });
    const lines = entries.map(formatEntry);
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed(`History for ${user.tag}`, lines, "No history found.")] });
  },
  meta: {
    category: "moderation",
    description: "Display recent actions taken against a user.",
    usage: "/history user:@User",
    examples: ["/history user:@Trouble"],
    permissions: "Moderate Members"
  }
};
