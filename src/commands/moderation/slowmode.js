import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";

function resolveTargetChannel(interaction, optionName = "channel") {
  const channel = interaction.options.getChannel(optionName) || interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

export default {
  data: new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Configure channel slowmode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(s => s
      .setName("set")
      .setDescription("Enable slowmode")
      .addChannelOption(o => o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText))
      .addIntegerOption(o => o.setName("seconds").setDescription("Slowmode duration").setRequired(true).setMinValue(1).setMaxValue(21600)))
    .addSubcommand(s => s
      .setName("off")
      .setDescription("Disable slowmode")
      .addChannelOption(o => o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Slowmode", "Guild only.")] });
    }

    const sub = interaction.options.getSubcommand();
    const channel = resolveTargetChannel(interaction);
    if (!channel) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Slowmode", "Select a text channel.")] });
    }

    try {
      if (sub === "set") {
        const seconds = interaction.options.getInteger("seconds", true);
        await channel.setRateLimitPerUser(seconds, `Set by ${interaction.user.tag}`);
        return interaction.reply({ embeds: [infoEmbed("Slowmode", `Set slowmode in ${channel} to **${seconds}s**.`)] });
      }
      await channel.setRateLimitPerUser(0, `Cleared by ${interaction.user.tag}`);
      return interaction.reply({ embeds: [infoEmbed("Slowmode", `Disabled slowmode in ${channel}.`)] });
    } catch (err) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Slowmode", `Failed: ${err?.message || err}`)] });
    }
  },
  meta: {
    category: "moderation",
    description: "Enable or disable slowmode for a text channel.",
    usage: "/slowmode set [channel:#general] seconds:30 | /slowmode off [channel:#general]",
    examples: ["/slowmode set seconds:10", "/slowmode off channel:#general"],
    permissions: "Manage Channels"
  }
};
