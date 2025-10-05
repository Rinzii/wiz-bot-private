// Minimal structured logger with in-memory ring buffer and optional Discord mirroring

import chalk, { chalkStderr } from "chalk";

const LEVELS = ["error", "warn", "info", "debug", "trace"];
const MAX_BUFFER = 500;
const DEFAULT_RATE_LIMIT = { intervalMs: 1_000, burst: 30 };

const LEVEL_STYLE = {
  error: ch => ch.red.bold,
  warn:  ch => ch.yellow.bold,
  info:  ch => ch.cyan,
  debug: ch => ch.blue,
  trace: ch => ch.gray,
};

const toPositive = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
};

export class Logger {
  constructor({ level = "info", mirrorFn = null, rateLimit = DEFAULT_RATE_LIMIT } = {}) {
    this.level = level;
    this.mirrorFn = mirrorFn;     // async (str) => void
    this.buffer = [];
    this.setRateLimit(rateLimit);
  }

  setLevel(level) { if (LEVELS.includes(level)) this.level = level; }
  async setMirror(fn) { this.mirrorFn = fn; }
  setRateLimit(rateLimit) {
    if (!rateLimit) {
      this.rateLimit = null;
      return;
    }

    const intervalMs = Math.max(1, Math.floor(toPositive(rateLimit.intervalMs, DEFAULT_RATE_LIMIT.intervalMs)));
    const burst = Math.max(1, Math.floor(toPositive(rateLimit.burst, DEFAULT_RATE_LIMIT.burst)));

    this.rateLimit = {
      intervalMs,
      burst,
      tokens: burst,
      lastRefill: Date.now(),
      suppressed: 0,
      active: false,
    };
  }

  #idx(l) { return LEVELS.indexOf(l); }
  #enabled(l) { return this.#idx(l) <= this.#idx(this.level); }
  #push(entry) {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }
  #fmt(ts, level, msg, meta) {
    return JSON.stringify({ ts, level, msg, ...meta });
  }

  #consoleLine(ts, level, msg, meta) {
    const chalkTarget = level === "error" || level === "warn" ? chalkStderr : chalk;
    const colorizeLevel = LEVEL_STYLE[level]?.(chalkTarget) ?? (text => text);
    const tsPart = chalkTarget.gray(ts);
    const levelLabel = colorizeLevel(level.toUpperCase().padEnd(5));
    const message = typeof msg === "string" ? msg : JSON.stringify(msg);

    let metaPart = "";
    if (meta !== undefined && meta !== null) {
      if (typeof meta === "string" || typeof meta === "number" || typeof meta === "boolean") {
        metaPart = chalkTarget.dim(String(meta));
      } else if (typeof meta === "object") {
        const keys = Object.keys(meta);
        if (keys.length > 0) {
          metaPart = chalkTarget.dim(JSON.stringify(meta));
        }
      }
    }

    return metaPart ? `${tsPart} ${levelLabel} ${message} ${metaPart}` : `${tsPart} ${levelLabel} ${message}`;
  }
  #consumeRateLimit() {
    const rl = this.rateLimit;
    if (!rl) return { allowed: true, flush: null, notify: false };

    const now = Date.now();
    let flush = null;

    if (now - rl.lastRefill >= rl.intervalMs) {
      const periods = Math.floor((now - rl.lastRefill) / rl.intervalMs);
      if (periods > 0) {
        rl.tokens = Math.min(rl.burst, rl.tokens + periods * rl.burst);
        rl.lastRefill = now;
        if (rl.suppressed > 0) {
          flush = rl.suppressed;
          rl.suppressed = 0;
          rl.active = false;
        }
      }
    }

    if (rl.tokens > 0) {
      rl.tokens -= 1;
      return { allowed: true, flush, notify: false };
    }

    rl.suppressed += 1;
    const notify = !rl.active;
    rl.active = true;
    return { allowed: false, flush, notify };
  }

  async #write(level, msg, meta = {}, { mirror = true, pushToBuffer = true } = {}) {
    const ts = new Date().toISOString();
    const line = this.#fmt(ts, level, msg, meta);
    const consoleLine = this.#consoleLine(ts, level, msg, meta);
    const streamIsTTY = level === "error" || level === "warn"
      ? Boolean(process.stderr?.isTTY)
      : Boolean(process.stdout?.isTTY);
    const output = streamIsTTY ? consoleLine : line;

    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);

    if (pushToBuffer) {
      this.#push({ ts, level, msg, meta });
    }

    if (mirror && this.mirrorFn && this.#enabled(level)) {
      try {
        const pretty = Object.keys(meta || {}).length
          ? "```json\n" + JSON.stringify(meta, null, 2) + "\n```"
          : "";
        await this.mirrorFn(`\`${level.toUpperCase()}\` ${msg}${pretty ? ` ${pretty}` : ""}`);
      } catch {/* ignore mirror failures */}
    }
  }

  async #log(level, msg, meta = {}, opts = {}) {
    const { skipRateLimit = false } = opts;
    const pushToBuffer = opts.pushToBuffer ?? true;
    const mirror = opts.mirror ?? true;

    if (!skipRateLimit) {
      const { allowed, flush, notify } = this.#consumeRateLimit();

      if (flush) {
        await this.#write("warn", "logger.rate_limit.flush", { suppressed: flush }, { mirror: false });
      }

      if (!allowed) {
        if (notify) {
          const rl = this.rateLimit;
          await this.#write("warn", "logger.rate_limit.hit", {
            intervalMs: rl.intervalMs,
            burst: rl.burst,
            suppressed: rl.suppressed,
          }, { mirror: false });
        }
        return;
      }
    }

    await this.#write(level, msg, meta, { mirror, pushToBuffer });
  }

  error(m, meta) { return this.#log("error", m, meta); }
  warn(m, meta)  { return this.#log("warn",  m, meta); }
  info(m, meta)  { return this.#log("info",  m, meta); }
  debug(m, meta) { return this.#log("debug", m, meta); }
  trace(m, meta) { return this.#log("trace", m, meta); }

  tail(n = 20) { return this.buffer.slice(-n); }
}
