import { PermissionFlagsBits, SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { infoEmbed, listEmbed } from "../../utils/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Debug / tracing controls (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("status").setDescription("Show current debug level and mirror channel"))
    .addSubcommand(s => s.setName("on").setDescription("Enable debug logging (sets level=debug)"))
    .addSubcommand(s => s.setName("off").setDescription("Disable debug logging (sets level=info and clears mirror)"))
    .addSubcommand(s =>
      s.setName("level").setDescription("Set the log level")
       .addStringOption(o =>
         o.setName("level").setDescription("Pick a log level")
          .addChoices(
            { name: "error", value: "error" },
            { name: "warn", value: "warn" },
            { name: "info", value: "info" },
            { name: "debug", value: "debug" },
            { name: "trace", value: "trace" }
          ).setRequired(true)))
    .addSubcommand(s =>
      s.setName("channel").setDescription("Set a channel to mirror logs into")
       .addChannelOption(o =>
         o.setName("channel").setDescription("Debug output channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)))
    .addSubcommand(s =>
      s.setName("tail").setDescription("Show the last N log lines")
       .addIntegerOption(o =>
         o.setName("lines").setDescription("Number of lines (default 20)").setMinValue(1).setMaxValue(100))),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug", "Guild only.")] });

    const logger = interaction.client.container.get("Logger");
    const debugState = interaction.client.container.get("DebugState");
    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug Status", `Level: **${logger.level}**\nMirror: ${debugState.channelId ? `<#${debugState.channelId}>` : "(none)"}`)] });
    }
    if (sub === "on") {
      logger.setLevel("debug");
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug", "Debug **enabled** (level=debug).")] });
    }
    if (sub === "off") {
      logger.setLevel("info"); debugState.channelId = ""; await logger.setMirror(null);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug", "Debug **disabled** (level=info). Mirror cleared.")] });
    }
    if (sub === "level") {
      const lvl = interaction.options.getString("level", true);
      logger.setLevel(lvl);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug", `Log level set to **${lvl}**.`)] });
    }
    if (sub === "channel") {
      const ch = interaction.options.getChannel("channel", true);
      debugState.channelId = ch.id;
      await logger.setMirror(async (msg) => {
        const channel = await interaction.client.channels.fetch(ch.id).catch(() => null);
        if (channel?.isTextBased?.()) await channel.send({ content: msg }).catch(() => {});
      });
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Debug", `Mirror channel set to <#${ch.id}>.`)] });
    }
    if (sub === "tail") {
      const n = interaction.options.getInteger("lines") ?? 20;
      const lines = logger.tail(n);
      const text = lines.map(l => `[${l.ts}] ${l.level.toUpperCase()} ${l.msg}`).join("\n").slice(0, 1900);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [listEmbed(`Last ${n} log line(s)`, text ? ["```text", text, "```"] : ["(no log entries)"])] });
    }
  },
  meta: {
    category: "debug",
    description: "Turn on/off debug logging, set level, tail logs, and mirror to a channel.",
    usage: "/debug <status|on|off|level|channel|tail> …",
    examples: ["/debug on", "/debug level trace", "/debug tail lines:50"],
    permissions: "Administrator"
  }
};
