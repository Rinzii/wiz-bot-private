import { WarningModel } from "../db/models/Warning.js";
import { ModerationActionType, normalizeReason } from "./moderationActions.js";

export class WarningService {
  #logService;
  constructor(logService) {
    this.#logService = logService;
  }

  async add(guildId, userId, modId, reason) {
    const normalizedReason = normalizeReason(reason);
    const doc = await WarningModel.create({ guildId, userId, modId, reason: normalizedReason });
    const warning = doc.toObject();
    if (this.#logService) {
      await this.#logService.record({
        guildId,
        userId,
        moderatorId: modId,
        action: ModerationActionType.Warn,
        reason: normalizedReason,
        durationMs: null,
        expiresAt: null,
        metadata: { warningId: warning._id?.toString?.() }
      });
    }
    return warning;
  }

  async list(guildId, userId, limit = 10) {
    return WarningModel.find({ guildId, userId }).sort({ createdAt: -1 }).limit(limit).lean();
  }
  async count(guildId, userId) {
    return WarningModel.countDocuments({ guildId, userId });
  }
}
