import { strict as assert } from "node:assert";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

const DEFAULT_THRESHOLD_MS = 30 * 60_000;
const DEFAULT_DEBOUNCE_MS = 2 * 60_000;
const DEFAULT_ALERT_COLOR = 0xF05A66;

const asNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
};

const asColorNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
      return Number.parseInt(trimmed.replace("#", ""), 16);
    }
  }
  return null;
};

function defaultTimestampFormatter(ts) {
  const seconds = Math.floor(Number(ts) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown";
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

export class BrandNewAccountWatcher {
  constructor({
    logger,
    resolveChannel,
    thresholdMs = DEFAULT_THRESHOLD_MS,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    formatDuration,
    timestampFormatter,
    colorResolver,
    metrics,
  } = {}) {
    assert(typeof resolveChannel === "function", "resolveChannel must be a function");

    this.logger = logger || null;
    this.resolveChannel = resolveChannel;
    this.thresholdMs = asNumber(thresholdMs, DEFAULT_THRESHOLD_MS);
    this.enabled = enabled !== false;
    this.debounceMs = asNumber(debounceMs, DEFAULT_DEBOUNCE_MS);
    this.formatDuration = typeof formatDuration === "function"
      ? formatDuration
      : (ms) => `${Math.round(Math.max(ms, 0) / 1000)}s`;
    this.timestampFormatter = typeof timestampFormatter === "function"
      ? timestampFormatter
      : defaultTimestampFormatter;
    this.colorResolver = typeof colorResolver === "function" ? colorResolver : null;
    this.metrics = metrics ?? null;

    this.#recentAlerts = new Map();
    this.#cleanupInterval = setInterval(() => {
      try {
        this.#cleanup();
      } catch (err) {
        this.#log("error", "brandNewAccount.cleanup_failed", {
          error: err instanceof Error ? err.stack : String(err)
        });
      }
    }, Math.max(this.debounceMs, 60_000));
    this.#cleanupInterval.unref?.();
  }

  destroy() {
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
    }
  }

  onJoin(member) {
    this.#handleJoin(member).catch((err) => {
      this.#log("error", "brandNewAccount.unhandled", {
        guildId: member?.guild?.id || null,
        userId: member?.id || null,
        error: err instanceof Error ? err.stack : String(err)
      });
    });
  }

  async #handleJoin(member) {
    if (!this.enabled) return;
    if (!member?.guild || !member.user || member.user.bot) return;

    const guildId = member.guild.id;
    const user = member.user;
    const userId = member.id;

    const createdAtMs = this.#createdTimestamp(user);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return;

    const now = Date.now();
    let accountAgeMs = now - createdAtMs;

    if (!Number.isFinite(accountAgeMs)) return;

    if (accountAgeMs < 0) {
      await this.#log("warn", "brandNewAccount.negative_age", {
        guildId,
        userId,
        accountAgeMs,
        createdAtMs
      });
      accountAgeMs = 0;
    }

    if (accountAgeMs > this.thresholdMs) return;

    const key = `${guildId}:${userId}`;
    const lastAlertTs = this.#recentAlerts.get(key);
    if (lastAlertTs && now - lastAlertTs < this.debounceMs) {
      await this.#log("debug", "brandNewAccount.debounced", {
        guildId,
        userId,
        accountAgeMs,
        thresholdMs: this.thresholdMs,
      });
      return;
    }

    const channel = await this.resolveChannel(member.guild);
    if (!channel) {
      await this.#log("warn", "brandNewAccount.channel_missing", {
        guildId,
        userId,
        accountAgeMs,
        thresholdMs: this.thresholdMs,
      });
      return;
    }

    if (!channel.isTextBased?.()) {
      await this.#log("warn", "brandNewAccount.channel_not_text", {
        guildId,
        channelId: channel.id,
        userId,
      });
      return;
    }

    const me = member.guild.members.me
      ?? await member.guild.members.fetch(member.client.user.id).catch(() => null);

    if (!me) {
      await this.#log("error", "brandNewAccount.self_member_missing", {
        guildId,
        channelId: channel.id,
        userId,
      });
      return;
    }

    const permissions = channel.permissionsFor?.(me) ?? null;
    if (!permissions || !permissions.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
      await this.#log("error", "brandNewAccount.send_no_permission", {
        guildId,
        channelId: channel.id,
        userId,
        missing: "ViewChannel|SendMessages"
      });
      return;
    }

    if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
      await this.#log("error", "brandNewAccount.send_no_permission", {
        guildId,
        channelId: channel.id,
        userId,
        missing: "EmbedLinks"
      });
      return;
    }

    const embed = this.#buildEmbed(member, createdAtMs, accountAgeMs);

    try {
      await channel.send({ embeds: [embed] });
      this.#recentAlerts.set(key, now);
      await this.#log("info", "brandNewAccount.alert", {
        guildId,
        channelId: channel.id,
        userId,
        accountAgeMs,
        thresholdMs: this.thresholdMs,
      });
      if (this.metrics?.increment) {
        try { this.metrics.increment("mod.new_account_alerts"); } catch {}
      }
    } catch (err) {
      await this.#log("error", "brandNewAccount.send_failed", {
        guildId,
        channelId: channel.id,
        userId,
        accountAgeMs,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  #buildEmbed(member, createdAtMs, accountAgeMs) {
    const user = member.user;
    const tag = user.tag ?? this.#buildUsername(user);
    const avatarUrl = typeof user.displayAvatarURL === "function"
      ? user.displayAvatarURL({ size: 256 })
      : null;

    const lines = [
      `<@${member.id}>`,
      `Account created at: ${this.timestampFormatter(createdAtMs)}`,
      `Account age: ${this.formatDuration(accountAgeMs)}`
    ];

    return new EmbedBuilder()
      .setColor(this.#resolveColor())
      .setAuthor({ name: `New User Warning: ${tag}`, iconURL: avatarUrl ?? undefined })
      .setDescription(lines.join("\n"))
      .setFooter({ text: `ID: ${member.id}` })
      .setTimestamp(new Date());
  }

  #resolveColor() {
    if (this.colorResolver) {
      try {
        const value = this.colorResolver("alert");
        const asNum = asColorNumber(value);
        if (asNum !== null) return asNum;
      } catch {/* ignore palette lookup failures */}
    }
    return DEFAULT_ALERT_COLOR;
  }

  #buildUsername(user) {
    if (!user) return "Unknown";
    const discrim = typeof user.discriminator === "string" && user.discriminator !== "0"
      ? `#${user.discriminator}`
      : "";
    return `${user.username ?? "unknown"}${discrim}`;
  }

  #createdTimestamp(user) {
    if (!user) return Number.NaN;
    const candidates = [user.createdTimestamp, user.createdAt];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isFinite(c)) return c;
      if (c instanceof Date && !Number.isNaN(c.getTime())) return c.getTime();
    }
    return Number.NaN;
  }

  async #log(level, msg, meta) {
    const fn = this.logger?.[level];
    if (typeof fn !== "function") return;
    try {
      await fn.call(this.logger, msg, meta ?? {});
    } catch {/* ignore logger failures */}
  }

  #cleanup(now = Date.now()) {
    const entries = Array.from(this.#recentAlerts.entries());
    for (const [key, ts] of entries) {
      if (now - ts > this.debounceMs) this.#recentAlerts.delete(key);
    }
  }

  #recentAlerts;
  #cleanupInterval;
}

