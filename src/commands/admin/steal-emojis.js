import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { extractCustomEmojis, fetchExistingEmojiNames, ensureBotEmojiPermissions, createEmojiFromCdn } from "../../utils/emojiImporter.js";

export default {
  data: new SlashCommandBuilder()
    .setName("steal-emojis")
    .setDescription("Import custom emojis from provided text")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(option =>
      option
        .setName("text")
        .setDescription("Text containing custom emoji mentions")
        .setRequired(true)
        .setMaxLength(4000))
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Guild only." });
    }

    const text = interaction.options.getString("text", true);
    const emojiMentions = extractCustomEmojis(text);
    if (!emojiMentions.length) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "No emojis" });
    }

    try {
      await ensureBotEmojiPermissions(interaction);
    } catch (error) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: error.message ?? "Missing permissions" });
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const usedNames = await fetchExistingEmojiNames(interaction.guild);
      const reason = `Emoji import via /${interaction.commandName} by ${interaction.user.tag ?? interaction.user.username}`;

      for (const emoji of emojiMentions) {
        await createEmojiFromCdn(interaction.guild, emoji, usedNames, reason);
      }

      await interaction.editReply({ content: "Done" });
    } catch (error) {
      const message = error?.message ?? "Failed to import emojis";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Error: ${message}` });
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Error: ${message}` });
      }
    }
  },
  meta: {
    category: "admin",
    description: "Import custom emojis from a block of text.",
    usage: "/steal-emojis text:<message text>",
    examples: ["/steal-emojis text:<:smile:123>"],
    permissions: "Ban Members"
  }
};
