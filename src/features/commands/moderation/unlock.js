import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";

function resolveChannel(interaction) {
  const channel = interaction.options.getChannel("channel") || interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

export default {
  data: new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock a text channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName("channel").setDescription("Channel to unlock").addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unlock", "Guild only.")] });
    }

    const channel = resolveChannel(interaction);
    if (!channel) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unlock", "Select a text channel.")] });
    }

    const everyone = interaction.guild.roles.everyone;

    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: null, AddReactions: null }, `Unlock by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [infoEmbed("Unlock", `Unlocked ${channel}.`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Unlock", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Allow @everyone to send messages again in a text channel.",
    usage: "/unlock [channel:#general]",
    examples: ["/unlock channel:#general"],
    permissions: "Manage Channels"
  }
};
