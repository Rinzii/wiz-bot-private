import { GuildConfigModel } from "../db/models/GuildConfig.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export class GuildConfigService {
  #ttl;
  #cache;

  constructor({ ttlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.#ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_CACHE_TTL_MS;
    this.#cache = new Map();
  }

  async get(guildId) {
    if (!guildId) return null;
    const cached = this.#cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const doc = await GuildConfigModel.findOne({ guildId }).lean();
    const value = this.#normalize(doc, guildId);
    this.#cache.set(guildId, { value, expiresAt: Date.now() + this.#ttl });
    return value;
  }

  async getModLogChannelId(guildId) {
    const config = await this.get(guildId);
    return config?.modLogChannelId || "";
  }

  async setModLogChannelId(guildId, channelId) {
    if (!guildId) throw new Error("guildId is required");
    const doc = await GuildConfigModel.findOneAndUpdate(
      { guildId },
      { modLogChannelId: channelId || "" },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    const value = this.#normalize(doc, guildId);
    this.#cache.set(guildId, { value, expiresAt: Date.now() + this.#ttl });
    return value.modLogChannelId;
  }

  invalidate(guildId) {
    if (!guildId) return;
    this.#cache.delete(guildId);
  }

  clear() {
    this.#cache.clear();
  }

  #normalize(doc, guildId) {
    if (!doc) {
      return {
        guildId,
        modLogChannelId: "",
        autoDeleteCommandSeconds: 0
      };
    }
    return {
      guildId: doc.guildId || guildId || null,
      modLogChannelId: typeof doc.modLogChannelId === "string" ? doc.modLogChannelId : "",
      autoDeleteCommandSeconds: Number.isFinite(doc.autoDeleteCommandSeconds)
        ? doc.autoDeleteCommandSeconds
        : 0
    };
  }
}
