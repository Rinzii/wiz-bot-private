import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { extractCustomEmojis, fetchExistingEmojiNames, ensureBotEmojiPermissions, createEmojiFromCdn } from "../../utils/emojiImporter.js";

const MESSAGE_URL_REGEX = /^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})$/;

export default {
  data: new SlashCommandBuilder()
    .setName("steal-emojis-message-url")
    .setDescription("Import custom emojis from a message link in this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("Link to a message containing custom emojis")
        .setRequired(true)
        .setMaxLength(200))
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Guild only." });
    }

    const url = interaction.options.getString("url", true).trim();
    const match = MESSAGE_URL_REGEX.exec(url);

    if (!match) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Invalid message URL." });
    }

    const [ , guildId, channelId, messageId ] = match;
    if (guildId !== interaction.guildId) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Message must be from this server." });
    }

    try {
      await ensureBotEmojiPermissions(interaction);
    } catch (error) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: error.message ?? "Missing permissions" });
    }

    let message;
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (!channel || channel.guildId !== interaction.guildId || !channel.isTextBased?.()) {
        return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Cannot access that message." });
      }

      message = await channel.messages.fetch(messageId);
    } catch (error) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Failed to fetch message." });
    }

    const emojiMentions = extractCustomEmojis(message?.content ?? "");
    if (!emojiMentions.length) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: "No emojis" });
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
      const messageText = error?.message ?? "Failed to import emojis";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Error: ${messageText}` });
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: `Error: ${messageText}` });
      }
    }
  },
  meta: {
    category: "admin",
    description: "Import custom emojis from a message link in this guild.",
    usage: "/steal-emojis-message-url url:<message link>",
    examples: ["/steal-emojis-message-url url:https://discord.com/channels/..."],
    permissions: "Ban Members"
  }
};
