import { ChannelMapModel } from "../db/models/ChannelMap.js";

export class ChannelMapService {
  async set(guildId, key, channelId, note = "") {
    return ChannelMapModel.findOneAndUpdate(
      { guildId, key },
      { $set: { channelId, note } },
      { new: true, upsert: true }
    ).lean();
  }
  async get(guildId, key) {
    return ChannelMapModel.findOne({ guildId, key }).lean();
  }
  async remove(guildId, key) {
    const r = await ChannelMapModel.deleteOne({ guildId, key });
    return r.deletedCount === 1;
  }
  async list(guildId) {
    return ChannelMapModel.find({ guildId }).sort({ key: 1 }).lean();
  }
}
