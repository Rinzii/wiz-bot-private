import { TOKENS } from "../container.js";

export default {
  name: "messageCreate",
  once: false,
  async execute(message) {
    if (!message.inGuild() || message.author?.bot) return;

    const container = message.client?.container;
    if (!container) return;

    let mentionTracker;
    try {
      mentionTracker = container.get(TOKENS.MentionTrackerService);
    } catch {
      return;
    }

    if (!mentionTracker?.handleMessage) return;

    try {
      await mentionTracker.handleMessage(message);
    } catch (error) {
      try {
        const logger = container.get(TOKENS.Logger);
        logger?.warn?.("mention_tracker.handle_failed", {
          guildId: message.guildId,
          messageId: message.id,
          error: String(error?.message || error)
        });
      } catch {
        // ignore logging failures
      }
    }
  }
};
