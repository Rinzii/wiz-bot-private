import { PRIVATE_TOKENS } from "../../domain/services/tokens.js";

export default {
  name: "guildBanAdd",
  once: false,
  async execute(ban) {
    try {
      const tracker = ban.client.container.get(PRIVATE_TOKENS.MemberTracker);
      tracker.onBan(ban);
    } catch {}
  }
};
