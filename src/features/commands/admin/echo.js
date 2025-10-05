import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { infoEmbed, successEmbed } from "../../../shared/utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("echo")
    .setDescription("Send a message as the bot")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o =>
      o.setName("message")
        .setDescription("The message to send")
        .setMaxLength(2000)
        .setRequired(true))
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel to send the message in")
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
        .setRequired(false))
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Echo", "Guild only.")] });
    }

    const message = interaction.options.getString("message", true).trim();
    if (!message.length) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Echo", "Message cannot be empty.")] });
    }

    const specifiedChannel = interaction.options.getChannel("channel");
    const targetChannel = specifiedChannel ?? interaction.channel;

    if (!targetChannel?.isTextBased?.() || targetChannel.type === ChannelType.DM || targetChannel.guildId !== interaction.guildId) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Echo", "Channel must be a text channel in this guild.")] });
    }

    try {
      await targetChannel.send({ content: message });
    } catch (error) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Echo", `Failed to send message: ${error?.message ?? "Unknown error"}`)]
      });
    }

    const suffix = specifiedChannel ? ` in <#${targetChannel.id}>` : "";

    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [successEmbed("Echo", `Message sent${suffix}.`)]
    });
  },
  meta: {
    category: "admin",
    description: "Send a custom message as the bot in any text-based guild channel.",
    usage: "/echo message:<text> [channel:#channel]",
    examples: ["/echo message:Hello team!", "/echo message:'Alert!' channel:#announcements"],
    permissions: "Manage Messages"
  }
};
