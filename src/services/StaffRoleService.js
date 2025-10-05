import { StaffRoleModel } from "../db/models/StaffRole.js";

const DEFAULT_KEYS = ["admin", "mod", "special"]; // extend if you standardize more keys later

export class StaffRoleService {
  constructor() {
    this.cache = new Map(); // key => { expires, ids }
    this.cacheTtlMs = 30_000;
  }

  #makeKey(guildId, keys = DEFAULT_KEYS) {
    return `${guildId}:${[...keys].sort().join(",")}`;
  }

  #getCached(guildId, keys) {
    const entry = this.cache.get(this.#makeKey(guildId, keys));
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.cache.delete(this.#makeKey(guildId, keys));
      return null;
    }
    return entry.ids;
  }

  #setCache(guildId, keys, ids) {
    this.cache.set(this.#makeKey(guildId, keys), {
      ids,
      expires: Date.now() + this.cacheTtlMs
    });
  }

  #invalidate(guildId) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${guildId}:`)) this.cache.delete(key);
    }
  }

  async add(guildId, key, roleId) {
    await StaffRoleModel.updateOne(
      { guildId, key, roleId },
      { $setOnInsert: { guildId, key, roleId } },
      { upsert: true }
    );
    this.#invalidate(guildId);
    return true;
  }

  async remove(guildId, key, roleId) {
    const r = await StaffRoleModel.deleteOne({ guildId, key, roleId });
    if (r.deletedCount) this.#invalidate(guildId);
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
    const cached = this.#getCached(guildId, keys);
    if (cached) return cached;
    const rows = await StaffRoleModel.find({ guildId, key: { $in: keys } }).lean();
    const ids = [...new Set(rows.map(r => r.roleId))];
    this.#setCache(guildId, keys, ids);
    return ids;
  }

  async distinctKeys(guildId) {
    const existing = await StaffRoleModel.distinct("key", { guildId });
    const set = new Set([...DEFAULT_KEYS, ...existing]);
    return [...set].sort();
  }
}
