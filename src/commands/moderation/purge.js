import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("purge").setDescription("Bulk delete recent messages (1-100)")
    .addIntegerOption(o => o.setName("amount").setDescription("Number to delete").setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Purge", "Guild only.")] });
    if (interaction.channel?.type !== ChannelType.GuildText) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Purge", "Use in a text channel.")] });
    }
    const amount = interaction.options.getInteger("amount", true);
    const svc = interaction.client.container.get("ModerationService");
    try {
      const deleted = await svc.bulkDelete(interaction.channel, amount);
      return interaction.reply({ embeds: [infoEmbed("Purge", `Deleted **${deleted}** message(s).`)] });
    } catch (e) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Purge", `Failed: ${e?.message || e}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Delete the last N messages in the current channel.",
    usage: "/purge amount:<1-100>",
    examples: ["/purge amount:25"],
    permissions: "Manage Messages"
  }
};
