import { PermissionsBitField } from "discord.js";
import { ModerationActionType, normalizeReason } from "./moderationActions.js";
import { scheduleWithMaxTimeout } from "../../shared/utils/time.js";

const MAX_TIMER_KEY_SIZE = 256;

export class ModerationService {
  #logger;
  #logService;
  #client;
  #timers = new Map();
  #timedHandlers = new Map();

  constructor(logger, logService) {
    this.#logger = logger;
    this.#logService = logService;
    this.registerTimedActionHandler(ModerationActionType.Ban, {
      onExpire: (entry) => this.#completeBan(entry)
    });
  }

  setClient(client) {
    this.#client = client;
  }

  canBan(member) {
    return member.permissions.has(PermissionsBitField.Flags.BanMembers);
  }

  async onClientReady() {
    if (!this.#logService) return;
    for (const [action] of this.#timedHandlers.entries()) {
      const pending = await this.#logService.getActiveTimedActions(action);
      for (const entry of pending) {
        if (!entry?.expiresAt || entry?.completedAt) continue;
        const expiresAt = new Date(entry.expiresAt).getTime();
        if (Number.isNaN(expiresAt)) continue;
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          await this.#invokeTimedHandler(entry, "startup");
          continue;
        }
        this.#scheduleTimer(entry, remaining);
      }
    }
  }

  async ban({ guild, target, moderator, reason, durationMs, metadata }) {
    if (!target?.bannable) throw new Error("Target not bannable (role/perms).");
    if (!guild) throw new Error("Missing guild instance for ban.");

    const normalizedReason = normalizeReason(reason);
    const expiresAt = durationMs ? new Date(Date.now() + durationMs) : null;

    await target.ban({ reason: this.#buildAuditReason(moderator, normalizedReason, expiresAt) });

    let entry = null;
    if (this.#logService) {
      entry = await this.#logService.record({
        guildId: guild.id,
        userId: target.id,
        moderatorId: moderator?.id,
        action: ModerationActionType.Ban,
        reason: normalizedReason,
        durationMs: durationMs ?? null,
        expiresAt,
        metadata: {
          ...(metadata || {}),
          targetTag: target?.user?.tag || null
        }
      });
    }

    if (expiresAt && entry) {
      this.#scheduleTimer(entry, expiresAt.getTime() - Date.now(), guild.id);
    }

    return entry;
  }

  async softban({ guild, target, moderator, reason, deleteMessageSeconds = 86400, metadata }) {
    if (!target?.bannable) throw new Error("Target not bannable (role/perms).");
    if (!guild) throw new Error("Missing guild instance for softban.");

    const normalizedReason = normalizeReason(reason);
    const deleteSeconds = Number.isFinite(deleteMessageSeconds)
      ? Math.min(Math.max(Math.floor(deleteMessageSeconds), 0), 7 * 24 * 60 * 60)
      : 0;

    const auditReason = this.#buildAuditReason(moderator, normalizedReason, null);
    const banOptions = { reason: auditReason };
    if (deleteSeconds > 0) banOptions.deleteMessageSeconds = deleteSeconds;

    await target.ban(banOptions);

    let entry = null;
    if (this.#logService) {
      entry = await this.#logService.record({
        guildId: guild.id,
        userId: target.id,
        moderatorId: moderator?.id,
        action: ModerationActionType.Softban,
        reason: normalizedReason,
        durationMs: null,
        expiresAt: null,
        metadata: {
          deleteMessageSeconds: deleteSeconds,
          ...(metadata || {}),
          targetTag: target?.user?.tag || null
        }
      });
    }

    try {
      await guild.bans.remove(target.id, this.#buildAuditReason(moderator, "Softban release", null));
    } catch (err) {
      if (err?.code === 10026 || /unknown ban/i.test(err?.message || "")) {
        // Already removed
      } else {
        throw err;
      }
    }

    return entry;
  }

  registerTimedActionHandler(action, handler) {
    if (!action) throw new Error("action is required for timed handler registration");
    if (!handler || typeof handler.onExpire !== "function") {
      throw new Error("Timed handler must provide an onExpire function");
    }
    this.#timedHandlers.set(action, handler);
  }

  cancelTimerForEntry(entry) {
    if (!entry) return;
    const key = this.#timerKey(entry);
    if (!key) return;
    this.#clearTimer(key);
  }

  async expungeCase({ guildId, caseNumber, moderatorId, reason }) {
    if (!this.#logService) throw new Error("Moderation log service not configured");
    const numericCase = typeof caseNumber === "number" ? caseNumber : Number(caseNumber);
    if (!guildId || Number.isNaN(numericCase)) {
      throw new Error("guildId and numeric caseNumber are required to expunge");
    }
    const entry = await this.#logService.getByCase(guildId, numericCase);
    if (!entry || entry.expungedAt) return entry;
    this.cancelTimerForEntry(entry);
    return this.#logService.expunge({ guildId, caseNumber: numericCase, moderatorId, reason });
  }

  async bulkDelete(textChannel, amount) {
    const clamped = Math.min(Math.max(amount, 1), 100);
    const deleted = await textChannel.bulkDelete(clamped, true);
    return deleted.size;
  }

  #scheduleTimer(entry, delay, guildIdOverride = null) {
    if (!entry?._id || !entry?.expiresAt) return;
    const handler = this.#timedHandlers.get(entry.action || ModerationActionType.Ban);
    if (!handler?.onExpire) return;
    const key = this.#timerKey(entry);
    this.#clearTimer(key);
    if (delay <= 0) {
      const payload = { ...entry, guildId: guildIdOverride || entry.guildId };
      void this.#invokeTimedHandler(payload, "timer");
      return;
    }
    const action = () => {
      this.#timers.delete(key);
      const payload = { ...entry, guildId: guildIdOverride || entry.guildId };
      void this.#invokeTimedHandler(payload, "timer");
    };
    const timerHandle = scheduleWithMaxTimeout(action, delay);
    this.#timers.set(key, timerHandle);
  }

  #clearTimer(key) {
    const timer = this.#timers.get(key);
    if (!timer) return;
    try { timer.cancel?.(); } catch {}
    this.#timers.delete(key);
  }

  async #invokeTimedHandler(entry, source) {
    if (!entry) return;
    const action = entry.action || ModerationActionType.Ban;
    const handler = this.#timedHandlers.get(action);
    if (!handler?.onExpire) return;
    try {
      await handler.onExpire(entry, { source, action });
    } catch (err) {
      this.#logger?.error?.("moderation.timed_action.expire_failed", {
        entryId: String(entry?._id || entry?.id || "unknown"),
        action,
        source,
        error: String(err?.message || err)
      });
    }
  }

  async #completeBan(entry) {
    if (!entry) return;
    const entryId = String(entry?._id || entry?.id || "");
    if (this.#logService && entryId) {
      const fresh = await this.#logService.getById(entryId);
      if (!fresh || fresh.completedAt || fresh.expungedAt) return;
    }
    const guildId = entry.guildId;
    if (!guildId) return;
    if (!this.#client) throw new Error("ModerationService client not attached");
    const guild = await this.#client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;
    try {
      await guild.bans.remove(entry.userId, "Timed ban expired");
    } catch (err) {
      if (err?.code === 10026 || /unknown ban/i.test(err?.message || "")) {
        // Already unbanned
      } else {
        throw err;
      }
    }
    if (this.#logService && entryId) {
      await this.#logService.markCompleted(entryId, { liftedAt: new Date().toISOString(), via: "auto" });
    }
  }

  #buildAuditReason(moderator, reason, expiresAt) {
    const base = normalizeReason(reason);
    const modTag = moderator?.tag || moderator?.user?.tag;
    const durationSuffix = expiresAt ? ` (until ${expiresAt.toISOString()})` : "";
    if (modTag) return `${base} - by ${modTag}${durationSuffix}`.slice(0, 512);
    return `${base}${durationSuffix}`.slice(0, 512);
  }

  #timerKey(entry) {
    const idPart = typeof entry?._id === "string" ? entry._id : entry?._id?.toString?.() || entry?.id || "";
    const key = `${entry.action || ModerationActionType.Ban}:${entry.guildId}:${entry.userId}:${idPart}`;
    return key.length > MAX_TIMER_KEY_SIZE ? key.slice(-MAX_TIMER_KEY_SIZE) : key;
  }
}
