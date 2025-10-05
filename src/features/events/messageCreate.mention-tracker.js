import { TOKENS } from "../../app/container/index.js";

export default {
  name: "messageCreate",
  once: false,
  async execute(message) {
    if (!message.inGuild() || message.author?.bot) return;

    const container = message.client?.container;
    if (!container) return;

    const mentionTracker = container.getOptional(TOKENS.MentionTrackerService);
    if (!mentionTracker) return;

    if (!mentionTracker?.handleMessage) return;

    try {
      await mentionTracker.handleMessage(message);
    } catch (error) {
      const logger = container.getOptional(TOKENS.Logger);
      logger?.warn?.("mention_tracker.handle_failed", {
        guildId: message.guildId,
        messageId: message.id,
        error: String(error?.message || error)
      });
    }
  }
};
