// Minimal structured logger with in-memory ring buffer and optional Discord mirroring

const LEVELS = ["error", "warn", "info", "debug", "trace"];
const MAX_BUFFER = 500;
const DEFAULT_RATE_LIMIT = { intervalMs: 1_000, burst: 30 };

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
  #fmt(level, msg, meta) {
    const ts = new Date().toISOString();
    return JSON.stringify({ ts, level, msg, ...meta });
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
    const line = this.#fmt(level, msg, meta);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    if (pushToBuffer) {
      this.#push({ ts: new Date().toISOString(), level, msg, meta });
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
