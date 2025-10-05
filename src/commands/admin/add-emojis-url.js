import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { fetchExistingEmojiNames, ensureBotEmojiPermissions, createEmojiFromUrl, isValidEmojiName } from "../../utils/emojiImporter.js";

export default {
  data: new SlashCommandBuilder()
    .setName("add-emojis-url")
    .setDescription("Add a single custom emoji from a direct image URL")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(option =>
      option
        .setName("name")
        .setDescription("Name to assign to the emoji")
        .setRequired(true)
        .setMaxLength(32))
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("Direct image URL")
        .setRequired(true)
        .setMaxLength(400))
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Guild only." });
    }

    const name = interaction.options.getString("name", true).trim();
    const url = interaction.options.getString("url", true).trim();

    if (!isValidEmojiName(name)) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Emoji name must be 2-32 characters (letters, numbers, underscores)." });
    }

    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "URL must start with http:// or https://" });
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

      await createEmojiFromUrl(interaction.guild, name, url, usedNames, reason);

      await interaction.editReply({ content: "Done" });
    } catch (error) {
      const message = error?.message ?? "Failed to add emoji";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Error: ${message}` });
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Error: ${message}` });
      }
    }
  },
  meta: {
    category: "admin",
    description: "Upload a custom emoji to this guild from a direct image URL.",
    usage: "/add-emojis-url name:<name> url:<image url>",
    examples: ["/add-emojis-url name:party url:https://example.com/party.png"],
    permissions: "Ban Members"
  }
};
