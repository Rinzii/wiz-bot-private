import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

function resolveChannel(interaction) {
  const channel = interaction.options.getChannel("channel") || interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

export default {
  data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock a text channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName("channel").setDescription("Channel to lock").addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Lock", "Guild only.")] });
    }

    const channel = resolveChannel(interaction);
    if (!channel) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Lock", "Select a text channel.")] });
    }

    const reason = interaction.options.getString("reason") || "Channel locked";
    const everyone = interaction.guild.roles.everyone;

    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false, AddReactions: false }, `${reason} (by ${interaction.user.tag})`);
      return interaction.reply({ embeds: [infoEmbed("Lock", `Locked ${channel}.\nReason: ${reason}`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Lock", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Prevent @everyone from sending messages in a text channel.",
    usage: "/lock [channel:#general] [reason:<text>]",
    examples: ["/lock channel:#general reason:raid"],
    permissions: "Manage Channels"
  }
};
