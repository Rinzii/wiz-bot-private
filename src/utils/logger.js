// Minimal structured logger with in-memory ring buffer and optional Discord mirroring

const LEVELS = ["error", "warn", "info", "debug", "trace"];
const MAX_BUFFER = 500;

export class Logger {
  constructor({ level = "info", mirrorFn = null } = {}) {
    this.level = level;
    this.mirrorFn = mirrorFn;     // async (str) => void
    this.buffer = [];
  }

  setLevel(level) { if (LEVELS.includes(level)) this.level = level; }
  async setMirror(fn) { this.mirrorFn = fn; }

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
  async #log(level, msg, meta = {}) {
    const line = this.#fmt(level, msg, meta);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    this.#push({ ts: new Date().toISOString(), level, msg, meta });

    if (this.mirrorFn && this.#enabled(level)) {
      try {
        const pretty = Object.keys(meta || {}).length
          ? "```json\n" + JSON.stringify(meta, null, 2) + "\n```"
          : "";
        await this.mirrorFn(`\`${level.toUpperCase()}\` ${msg} ${pretty}`);
      } catch {/* ignore mirror failures */}
    }
  }

  error(m, meta) { return this.#log("error", m, meta); }
  warn(m, meta)  { return this.#log("warn",  m, meta); }
  info(m, meta)  { return this.#log("info",  m, meta); }
  debug(m, meta) { return this.#log("debug", m, meta); }
  trace(m, meta) { return this.#log("trace", m, meta); }

  tail(n = 20) { return this.buffer.slice(-n); }
}
