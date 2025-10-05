import { strict as assert } from "node:assert";

const MINUTE = 60_000;
const DEFAULT_LOG_DURATION = 30 * MINUTE;
const DEFAULT_CLEANUP_INTERVAL = 10 * MINUTE;
const DEFAULT_BAN_TRACK_MS = 5 * MINUTE;

function safeTimestamp(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return fallback;
}

export class MemberTracker {
  constructor({
    logger = null,
    logDurationMs = DEFAULT_LOG_DURATION,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL,
    banningTtlMs = DEFAULT_BAN_TRACK_MS,
  } = {}) {
    assert(logDurationMs > 0, "logDurationMs must be positive");
    assert(cleanupIntervalMs > 0, "cleanupIntervalMs must be positive");
    assert(banningTtlMs > 0, "banningTtlMs must be positive");

    this.logger = logger;
    this.logDurationMs = logDurationMs;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.banningTtlMs = banningTtlMs;

    this.entries = [];
    this.idMap = new Map();
    this.currentlyBanning = new Map();
    this.submodules = [];

    this.interval = setInterval(() => {
      try {
        this.trim();
      } catch (err) {
        this.#log("error", "memberTracker.trim.error", { error: err instanceof Error ? err.stack : String(err) });
      }
    }, this.cleanupIntervalMs);
    this.interval.unref?.();
  }

  destroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  trim(now = Date.now()) {
    const cutoff = this.logDurationMs;
    let firstIdx = this.entries.findIndex(entry => now - entry.entryAddedAt <= cutoff);

    if (firstIdx === -1) {
      if (this.entries.length) {
        for (const entry of this.entries) this.idMap.delete(entry.id);
        this.entries = [];
      }
    } else if (firstIdx > 0) {
      for (let i = 0; i < firstIdx; i++) this.idMap.delete(this.entries[i].id);
      this.entries = this.entries.slice(firstIdx);
    }

    for (const [id, ts] of [...this.currentlyBanning.entries()]) {
      if (now - ts > this.banningTtlMs) this.currentlyBanning.delete(id);
    }
  }

  onJoin(member, joinedAtTs) {
    if (!member) return;

    const joinedAt = safeTimestamp(joinedAtTs ?? member.joinedAt, Date.now());
    const entry = {
      tag: member.user?.tag ?? member.user?.username ?? "unknown",
      id: member.id,
      joinedAt,
      entryAddedAt: Date.now(),
      createdAt: safeTimestamp(member.user?.createdTimestamp ?? member.user?.createdAt, 0),
      purged: false,
      messageBlock: false,
    };

    if (!entry.id) {
      this.#log("warn", "memberTracker.join.missingId", {});
      return;
    }

    this.entries.push(entry);
    if (this.idMap.has(entry.id)) {
      this.#log("warn", "memberTracker.join.duplicate", { id: entry.id, tag: entry.tag });
    }
    this.idMap.set(entry.id, entry);

    for (const sub of this.submodules) {
      if (typeof sub?.on_join === "function") {
        try {
          sub.on_join(member, joinedAt);
        } catch (err) {
          this.#log("error", "memberTracker.submodule.on_join", { error: err instanceof Error ? err.stack : String(err) });
        }
      } else if (typeof sub?.onJoin === "function") {
        try {
          sub.onJoin(member, joinedAt);
        } catch (err) {
          this.#log("error", "memberTracker.submodule.onJoin", { error: err instanceof Error ? err.stack : String(err) });
        }
      }
    }
  }

  onBan(ban, now = Date.now()) {
    for (const sub of this.submodules) {
      if (typeof sub?.on_ban === "function") {
        try {
          sub.on_ban(ban, now);
        } catch (err) {
          this.#log("error", "memberTracker.submodule.on_ban", { error: err instanceof Error ? err.stack : String(err) });
        }
      } else if (typeof sub?.onBan === "function") {
        try {
          sub.onBan(ban, now);
        } catch (err) {
          this.#log("error", "memberTracker.submodule.onBan", { error: err instanceof Error ? err.stack : String(err) });
        }
      }
    }
  }

  addSubmodule(submodule) {
    if (submodule) this.submodules.push(submodule);
  }

  addPseudoEntry(user) {
    if (!user?.id) {
      this.#log("warn", "memberTracker.pseudo.missingId", {});
      return;
    }
    if (this.idMap.has(user.id)) {
      this.#log("error", "memberTracker.pseudo.duplicate", { id: user.id });
      return;
    }

    const entry = {
      tag: user.tag ?? user.username ?? "unknown",
      id: user.id,
      joinedAt: 0,
      entryAddedAt: Date.now(),
      createdAt: safeTimestamp(user.createdTimestamp ?? user.createdAt, 0),
      purged: false,
      messageBlock: false,
    };

    this.entries.push(entry);
    this.idMap.set(entry.id, entry);
  }

  get(id) {
    return this.idMap.get(id) ?? null;
  }

  markPurged(id) {
    const entry = this.idMap.get(id);
    if (entry) entry.purged = true;
  }

  setMessageBlock(id, value = true) {
    const entry = this.idMap.get(id);
    if (entry) entry.messageBlock = Boolean(value);
  }

  markCurrentlyBanning(id) {
    if (!id) return;
    this.currentlyBanning.set(id, Date.now());
  }

  isCurrentlyBanning(id) {
    const ts = this.currentlyBanning.get(id);
    if (!ts) return false;
    if (Date.now() - ts > this.banningTtlMs) {
      this.currentlyBanning.delete(id);
      return false;
    }
    return true;
  }

  #log(level, msg, meta) {
    const logger = this.logger;
    if (!logger) return;
    const fn = logger?.[level];
    if (typeof fn !== "function") return;
    try {
      const result = fn.call(logger, msg, meta ?? {});
      if (result?.catch) result.catch(() => {});
    } catch {}
  }
}
