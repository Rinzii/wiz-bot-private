import { StaffRoleModel } from "../db/models/StaffRole.js";

const DEFAULT_KEYS = ["admin", "mod"]; // extend if you standardize more keys later

export class StaffRoleService {
  async add(guildId, key, roleId) {
    await StaffRoleModel.updateOne(
      { guildId, key, roleId },
      { $setOnInsert: { guildId, key, roleId } },
      { upsert: true }
    );
    return true;
  }

  async remove(guildId, key, roleId) {
    const r = await StaffRoleModel.deleteOne({ guildId, key, roleId });
    return r.deletedCount === 1;
  }

  async list(guildId) {
    const rows = await StaffRoleModel.find({ guildId }).sort({ key: 1 }).lean();
    const out = {};
    for (const r of rows) {
      if (!out[r.key]) out[r.key] = [];
      out[r.key].push(r.roleId);
    }
    return out;
  }

  async getAllRoleIdsForKeys(guildId, keys = DEFAULT_KEYS) {
    const rows = await StaffRoleModel.find({ guildId, key: { $in: keys } }).lean();
    return [...new Set(rows.map(r => r.roleId))];
  }

  async distinctKeys(guildId) {
    const existing = await StaffRoleModel.distinct("key", { guildId });
    const set = new Set([...DEFAULT_KEYS, ...existing]);
    return [...set].sort();
  }
}
