import { replyEph, followUpEph } from "../../shared/utils/respond.js";
import { hasDefaultPerms, hasAppLevelPerms } from "../../shared/utils/permissions.js";
import { TOKENS } from "../../app/container/index.js";

export default {
  name: "interactionCreate",
  once: false,
  async execute(interaction) {
    const container = interaction.client?.container;

    if (interaction.isButton()) {
      try {
        const mentionTracker = container?.get(TOKENS.MentionTrackerService);
        if (mentionTracker) {
          const handled = await mentionTracker.handleInteraction(interaction);
          if (handled) return;
        }
      } catch {
        // ignore missing mention tracker service
      }
    }

    if (!interaction.isChatInputCommand()) return;

    if (!container) return;

    const commands = interaction.client.commands;
    const cmd = commands.get(interaction.commandName);
    if (!cmd) return;

    const logger = container.get(TOKENS.Logger);
    const started = Date.now();
    const meta = {
      user: `${interaction.user.tag} (${interaction.user.id})`,
      guild: interaction.guild ? `${interaction.guild.name} (${interaction.guildId})` : "DM",
      command: interaction.commandName,
      options: interaction.options.data?.map(d => ({
        name: d.name,
        value: d.value ?? d.user?.id ?? d.channel?.id ?? d.role?.id ?? null
      })) || []
    };

    // ---- Permission gates
    if (!interaction.inGuild()) {
      return replyEph(interaction, "Guild only.");
    }
    if (!hasDefaultPerms(interaction.member, cmd)) {
      logger?.warn?.("command.perms.discord_denied", meta);
      return replyEph(interaction, "You don’t have permission to use this command.");
    }
    if (!(await hasAppLevelPerms(interaction, cmd))) {
      logger?.warn?.("command.perms.app_denied", meta);
      return replyEph(interaction, "You don’t meet the role requirements for this command.");
    }
    // ---------------------

    logger?.debug?.("command.start", meta);

    try {
      await cmd.execute(interaction);
      logger?.info?.("command.ok", { ...meta, ms: Date.now() - started });
    } catch (err) {
      logger?.error?.("command.error", { ...meta, ms: Date.now() - started, err: String(err?.message || err) });
      const content = "There was an error while executing this command.";
      if (interaction.deferred || interaction.replied) await followUpEph(interaction, content);
      else await replyEph(interaction, content);
    }
  }
};
