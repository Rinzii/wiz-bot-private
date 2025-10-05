import { TOKENS } from "../container.js";
import { ModerationActionType } from "../services/moderationActions.js";

export default {
  name: "guildBanRemove",
  async execute(ban) {
    const guild = ban?.guild;
    const user = ban?.user;
    const client = guild?.client || ban?.client;
    const container = client?.container;
    if (!guild || !user || !container) return;

    let logService;
    let moderationService;
    try {
      logService = container.get(TOKENS.ModerationLogService);
      moderationService = container.get(TOKENS.ModerationService);
    } catch {
      return;
    }

    if (!logService || !moderationService) return;

    const entry = await logService.findLatestActive({
      guildId: guild.id,
      userId: user.id,
      action: ModerationActionType.Ban
    });

    if (!entry) return;

    moderationService.cancelTimerForEntry(entry);
    await logService.markCompleted(entry._id, {
      via: "manual",
      liftedAt: new Date().toISOString()
    });
  }
};
