import { WarningModel } from "../db/models/Warning.js";

export class WarningService {
  async add(guildId, userId, modId, reason) {
    return WarningModel.create({ guildId, userId, modId, reason });
  }
  async list(guildId, userId, limit = 10) {
    return WarningModel.find({ guildId, userId }).sort({ createdAt: -1 }).limit(limit).lean();
  }
  async count(guildId, userId) {
    return WarningModel.countDocuments({ guildId, userId });
  }
}
