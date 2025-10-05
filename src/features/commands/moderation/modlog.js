import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";

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

    const guildConfigService = interaction.client.container.get(TOKENS.GuildConfigService);

    if (sub === "where") {
      const channelId = await guildConfigService.getModLogChannelId(interaction.guildId);
      const channel = channelId ? `<#${channelId}>` : "Not configured.";
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", `Current channel: ${channel}`)] });
    }

    const channel = interaction.options.getChannel("channel", true);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Modlog", "Select a text channel.")] });
    }

    await guildConfigService.setModLogChannelId(interaction.guildId, channel.id);

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
