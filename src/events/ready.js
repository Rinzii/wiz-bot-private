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

    try {
      const allowedInviteService = client.container.get(TOKENS.AllowedInviteService);
      client.container.get(TOKENS.Logger)?.info?.("invite_guard.allowlist_ready", { count: allowedInviteService.size });
    } catch (err) {
      client.container.get(TOKENS.Logger)?.error?.("invite_guard.allowlist_log_failed", {
        error: String(err?.message || err)
      });
    }
  }
};
