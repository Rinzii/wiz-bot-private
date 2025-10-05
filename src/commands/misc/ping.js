import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Reply with pong + latency"),
  async execute(interaction) {
    const sent = await interaction.reply({ content: "Pinging...", fetchReply: true, flags: MessageFlags.Ephemeral });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const embed = infoEmbed("Pong!", `Round-trip latency: **${latency}ms**`);
    await interaction.editReply({ content: "", embeds: [embed] });
  },
  meta: {
    category: "general",
    description: "Latency health check.",
    usage: "/ping",
    examples: ["/ping"]
  }
};
