import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { TOKENS } from "../../container.js";
import { infoEmbed, successEmbed } from "../../utils/embeds.js";

const RESTART_DELAY_MS = 1500;

export default {
  data: new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot process")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [infoEmbed("Restart", "Guild only.")] });
    }

    const logger = interaction.client.container.get(TOKENS.Logger);
    await logger.warn("command.restart", {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [successEmbed("Restart", "Restarting bot…")] 
    });

    setTimeout(() => {
      const res = logger.info("command.restart.exit", { delayMs: RESTART_DELAY_MS });
      res?.catch?.(() => {});
      process.exit(0);
    }, RESTART_DELAY_MS).unref?.();
  },
  meta: {
    category: "admin",
    description: "Restart the bot safely (process exit so a supervisor can relaunch it).",
    usage: "/restart",
    examples: ["/restart"],
    permissions: "Administrator"
  }
};
