import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { PRIVATE_TOKENS } from "../services/token.js";
import { infoEmbed } from "../../../src/utils/embeds.js";

const svc = (ix) => ix.client.container.get(PRIVATE_TOKENS.AntiRaidService);

export default {
  data: new SlashCommandBuilder()
    .setName("antiraid")
    .setDescription("Anti-raid controls")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName("status").setDescription("Show status"))
    .addSubcommand(s => s.setName("arm").setDescription("Arm anti-raid"))
    .addSubcommand(s => s.setName("disarm").setDescription("Disarm and lift lockdown"))
    .addSubcommand(s => s.setName("set-threshold")
      .setDescription("Set joins per minute")
      .addIntegerOption(o => o.setName("per_minute").setDescription("Joins per minute").setRequired(true).setMinValue(1))),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Anti-raid", "Guild only.")] });

    const ar = svc(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const s = ar.getStatus(interaction.guildId);
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [infoEmbed("Anti-raid Status",
          `State: **${s.armed ? "ARMED" : "DISARMED"}**\nThreshold: **${s.thresholdPerMinute}/min**\nLockdown: **${s.lockdownActive ? "ACTIVE" : "inactive"}**`)]
      });
    }
    if (sub === "arm") {
      ar.arm(interaction.guildId);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Anti-raid", "Armed.")] });
    }
    if (sub === "disarm") {
      ar.disarm(interaction.guildId);
      try { await ar.liftLockdown(interaction.guild, "Disarmed"); } catch {}
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Anti-raid", "Disarmed; lockdown lifted.")] });
    }
    if (sub === "set-threshold") {
      const per = interaction.options.getInteger("per_minute", true);
      ar.setThreshold(interaction.guildId, per);
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Anti-raid", `Threshold set to **${per}/min**.`)] });
    }
  },
  meta: {
    category: "security",
    description: "Monitor joins and auto-lock channels if a raid is detected.",
    usage: "/antiraid <status|arm|disarm|set-threshold>",
    examples: ["/antiraid status", "/antiraid set-threshold per_minute:20"],
    permissions: "Administrator"
  }
};
