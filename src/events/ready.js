import { TOKENS } from "../container.js";

export default {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user?.tag}`);

    try {
      const moderationService = client.container.get(TOKENS.ModerationService);
      await moderationService.onClientReady?.();
    } catch (err) {
      client.container.get(TOKENS.Logger)?.error?.("moderation.init_failed", {
        error: String(err?.message || err)
      });
    }
  }
};
