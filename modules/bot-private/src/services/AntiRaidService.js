export class AntiRaidService {
  #states = new Map(); // guildId -> state
  constructor(getModLog, defaultThreshold = 10) {
    this.getModLog = getModLog;
    this.defaultThreshold = defaultThreshold;
  }
  ensure(gid) {
    if (!this.#states.has(gid)) {
      this.#states.set(gid, { armed: false, thresholdPerMinute: this.defaultThreshold, windowMs: 60_000, joins: [], lockdownActive: false });
    }
    return this.#states.get(gid);
  }
  arm(gid) { this.ensure(gid).armed = true; }
  disarm(gid) { const s = this.ensure(gid); s.armed = false; s.lockdownActive = false; }
  setThreshold(gid, perMinute) { this.ensure(gid).thresholdPerMinute = Math.max(1, perMinute); }
  getStatus(gid) { return this.ensure(gid); }

  recordJoin = async (guild) => {
    const s = this.ensure(guild.id);
    const now = Date.now();
    s.joins.push(now);
    const cutoff = now - s.windowMs;
    s.joins = s.joins.filter(ts => ts >= cutoff);
    if (!s.armed) return;
    if (s.joins.length >= s.thresholdPerMinute && !s.lockdownActive) {
      s.lockdownActive = true;
      await this.lockdown(guild, `Join spike: ${s.joins.length}/${Math.round(s.windowMs/1000)}s (>= ${s.thresholdPerMinute}/min)`);
    }
  };

  async lockdown(guild, reason) {
    const ch = await this.getModLog(guild);
    const textChannels = guild.channels.cache.filter(c => c?.isTextBased?.() && c.type === 0);
    for (const [, c] of textChannels) {
      try { if (typeof c.setRateLimitPerUser === "function") await c.setRateLimitPerUser(30, reason); } catch {}
    }
    try { await ch?.send(`⚠️ Anti-Raid Lockdown Activated — ${reason}`); } catch {}
  }

  async liftLockdown(guild, note) {
    const s = this.ensure(guild.id);
    s.lockdownActive = false;
    const ch = await this.getModLog(guild);
    const textChannels = guild.channels.cache.filter(c => c?.isTextBased?.() && c.type === 0);
    for (const [, c] of textChannels) {
      try { if (typeof c.setRateLimitPerUser === "function") await c.setRateLimitPerUser(0, "Lockdown lifted"); } catch {}
    }
    try { await ch?.send(`✅ Anti-Raid Lockdown Lifted${note ? ` — ${note}` : ""}`); } catch {}
  }
}
