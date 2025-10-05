import { Collection } from "discord.js";
import { findDefaultStaffChannel } from "../../shared/utils/staffChannels.js";

const CHANNEL_MAP_KEYS = [
  "staff_member_log",
  "member_log",
  "bot_log",
  "action_log",
  "mod_log"
];

function isTextSendable(channel) {
  if (!channel?.isTextBased?.()) return false;
  if (typeof channel.send !== "function") return false;
  if (channel.isThread?.()) return true;
  return channel.type === 0 || channel.type === 5 || channel.type === 15 || channel.type === 11 || channel.type === 12;
}

export class StaffMemberLogService {
  #missingWarned;
  #cache;

  constructor({ channelMapService, fallbackChannelId = "", fallbackChannelResolver = null, logger } = {}) {
    this.channelMapService = channelMapService;
    this.fallbackChannelId = typeof fallbackChannelId === "string" ? fallbackChannelId : "";
    this.fallbackChannelResolver = typeof fallbackChannelResolver === "function" ? fallbackChannelResolver : null;
    this.logger = logger;
    this.#missingWarned = new Set();
    this.#cache = new Collection();
  }

  async send(guild, payload) {
    if (!guild || !payload) return false;
    try {
      const channel = await this.#resolveChannel(guild);
      if (!channel) {
        this.#logMissing(guild.id);
        return false;
      }
      await channel.send(payload);
      return true;
    } catch (err) {
      this.clearCache(guild?.id);
      if (this.logger?.error) {
        await this.logger.error("staffMemberLog.send.failed", {
          guildId: guild?.id ?? null,
          error: err instanceof Error ? err.stack : String(err)
        });
      }
      return false;
    }
  }

  clearCache(guildId) {
    if (!guildId) return;
    this.#cache.delete(guildId);
    this.#missingWarned.delete(guildId);
  }

  async #resolveChannel(guild) {
    const cached = this.#cache.get(guild.id);
    if (cached?.channel && isTextSendable(cached.channel)) {
      return cached.channel;
    }

    const seen = new Set();
    const tryFetch = async (id) => {
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const fromCache = guild.channels.cache.get(id);
      if (isTextSendable(fromCache)) return fromCache;
      const fetched = await guild.channels.fetch(id).catch(() => null);
      return isTextSendable(fetched) ? fetched : null;
    };

    if (this.channelMapService) {
      for (const key of CHANNEL_MAP_KEYS) {
        try {
          const mapping = await this.channelMapService.get(guild.id, key);
          if (!mapping?.channelId) continue;
          const mapped = await tryFetch(mapping.channelId);
          if (mapped) {
            this.#cache.set(guild.id, { channel: mapped, resolvedAt: Date.now() });
            return mapped;
          }
        } catch (err) {
          if (this.logger?.warn) {
            await this.logger.warn("staffMemberLog.channelMap.error", {
              guildId: guild.id,
              key,
              error: err instanceof Error ? err.stack : String(err)
            });
          }
        }
      }
    }

    const defaultChannel = findDefaultStaffChannel(guild, CHANNEL_MAP_KEYS, isTextSendable);
    if (defaultChannel) {
      this.#cache.set(guild.id, { channel: defaultChannel, resolvedAt: Date.now() });
      return defaultChannel;
    }

    const fallbackId = await this.#resolveFallbackId(guild).catch(() => this.fallbackChannelId);
    const fallback = await tryFetch(fallbackId);
    if (fallback) {
      this.#cache.set(guild.id, { channel: fallback, resolvedAt: Date.now() });
      return fallback;
    }

    this.#cache.delete(guild.id);
    return null;
  }

  #logMissing(guildId) {
    if (!guildId || this.#missingWarned.has(guildId)) return;
    this.#missingWarned.add(guildId);
    if (this.logger?.warn) {
      this.logger.warn("staffMemberLog.missingChannel", { guildId }).catch(() => {});
    }
  }

  async #resolveFallbackId(guild) {
    if (!guild) return this.fallbackChannelId;
    if (!this.fallbackChannelResolver) return this.fallbackChannelId;
    try {
      const result = await this.fallbackChannelResolver(guild);
      if (typeof result === "string") return result;
      return this.fallbackChannelId;
    } catch (error) {
      if (this.logger?.warn) {
        await this.logger.warn("staffMemberLog.fallback.error", {
          guildId: guild?.id ?? null,
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => {});
      }
      return this.fallbackChannelId;
    }
  }
}
