import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { infoEmbed } from "../../../shared/utils/embeds.js";
import { TOKENS } from "../../../app/container/index.js";
import { parseDuration } from "../../../shared/utils/time.js";

export default {
  data: new SlashCommandBuilder()
    .setName("spam")
    .setDescription("Configure anti-spam settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(g => g
      .setName("thresholds")
      .setDescription("Rate limits")
      .addSubcommand(s => s
        .setName("set")
        .setDescription("Set spam thresholds")
        .addIntegerOption(o => o.setName("msgs_per_window").setDescription("Messages per window").setRequired(true).setMinValue(1))
        .addIntegerOption(o => o.setName("links_per_window").setDescription("Links per window").setRequired(true).setMinValue(0))
        .addIntegerOption(o => o.setName("window_sec").setDescription("Window duration in seconds").setRequired(true).setMinValue(5))))
    .addSubcommandGroup(g => g
      .setName("action")
      .setDescription("Automatic action")
      .addSubcommand(s => s
        .setName("set")
        .setDescription("Set spam action")
        .addStringOption(o => o.setName("value").setDescription("warn | timeout:<dur> | ban").setRequired(true)))),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", "Guild only.")] });
    }

    const runtime = interaction.client.container.get(TOKENS.RuntimeModerationState);
    const group = interaction.options.getSubcommandGroup();

    if (group === "thresholds") {
      const msgs = interaction.options.getInteger("msgs_per_window", true);
      const links = interaction.options.getInteger("links_per_window", true);
      const windowSec = interaction.options.getInteger("window_sec", true);
      runtime.setSpamThresholds(interaction.guildId, { msgs, links, windowSec });
      const antiSpam = interaction.client.container.get(TOKENS.AntiSpamService);
      antiSpam.cfg.msgMaxInWindow = msgs;
      antiSpam.cfg.linkMaxInWindow = links;
      antiSpam.cfg.msgWindowMs = windowSec * 1000;
      antiSpam.cfg.linkWindowMs = windowSec * 1000;
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", `Thresholds updated: **${msgs} msgs / ${links} links** per **${windowSec}s**.`)] });
    }

    const value = interaction.options.getString("value", true).toLowerCase();
    if (value === "warn" || value === "ban") {
      runtime.setSpamAction(interaction.guildId, value);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", `Spam action set to **${value}**.`)] });
    }
    if (value.startsWith("timeout:")) {
      const durationInput = value.split(":")[1];
      try {
        const parsed = parseDuration(durationInput);
        if (!parsed?.ms) throw new Error("Invalid duration");
        runtime.setSpamAction(interaction.guildId, `timeout:${parsed.ms}`);
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", `Spam action set to **timeout ${parsed.human || durationInput}**.`)] });
      } catch (err) {
        return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", `Invalid timeout duration: ${err?.message || err}`)] });
      }
    }
    return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Spam", "Unknown action. Use warn, ban, or timeout:<duration>.")] });
  },
  meta: {
    category: "moderation",
    description: "Adjust anti-spam thresholds and enforcement.",
    usage: "/spam thresholds set msgs_per_window:10 links_per_window:5 window_sec:30",
    examples: ["/spam action set value:timeout:10m"],
    permissions: "Manage Server"
  }
};
