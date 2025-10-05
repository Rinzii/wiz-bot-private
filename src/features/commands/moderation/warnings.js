import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { TOKENS } from "../../../app/container/index.js";
import { listEmbed } from "../../../shared/utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("warnings").setDescription("List latest warnings for a user")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed("Warnings", ["Guild only."])] });
    }
    const user = interaction.options.getUser("user", true);
    const svc = interaction.client.container.get(TOKENS.WarningService);
    const list = await svc.list(interaction.guildId, user.id, 10);
    const lines = list.length
      ? list.map(w => `• ${w.reason} — <t:${Math.floor(new Date(w.createdAt).getTime()/1000)}:R> by <@${w.modId}>`)
      : ["No warnings found."];
    return interaction.reply({ embeds: [listEmbed(`Warnings for ${user.tag}`, lines)] });
  },
  meta: {
    category: "moderation",
    description: "Show the most recent warnings for a user.",
    usage: "/warnings user:@User",
    examples: ["/warnings user:@User"]
  }
};
