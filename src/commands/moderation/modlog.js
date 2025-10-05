import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../utils/embeds.js";
import { GuildConfigModel } from "../../db/models/GuildConfig.js";

export default {
  data: new SlashCommandBuilder()
    .setName("modlog")
    .setDescription("Manage moderation log channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName("where").setDescription("Show the current modlog channel"))
    .addSubcommand(s => s
      .setName("set")
      .setDescription("Set the modlog channel")
      .addChannelOption(o => o.setName("channel").setDescription("Channel").setRequired(true).addChannelTypes(ChannelType.GuildText))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", "Guild only.")] });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "where") {
      const config = await GuildConfigModel.findOne({ guildId: interaction.guildId }).lean();
      const channel = config?.modLogChannelId ? `<#${config.modLogChannelId}>` : "Not configured.";
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", `Current channel: ${channel}`)] });
    }

    const channel = interaction.options.getChannel("channel", true);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", "Select a text channel.")] });
    }

    await GuildConfigModel.findOneAndUpdate(
      { guildId: interaction.guildId },
      { modLogChannelId: channel.id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", `Set modlog channel to ${channel}.`)] });
  },
  meta: {
    category: "moderation",
    description: "Configure where moderation logs are sent.",
    usage: "/modlog where | /modlog set channel:#logs",
    examples: ["/modlog set channel:#mod-log"],
    permissions: "Manage Server"
  }
};
