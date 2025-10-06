/**
 * AntiSpamService
 * Tracks per-guild, per-user message/link rates in rolling windows.
 * If thresholds are exceeded, returns an instruction to ban.
 *
 * It is storage-less (in-memory). Reset on restart (fine for anti-spam).
 */

export class AntiSpamService {
  /**
   * @param {{
   *   msgWindowMs: number,         // e.g., 10_000
   *   msgMaxInWindow: number,      // e.g., 12
   *   linkWindowMs: number,        // e.g., 30_000
   *   linkMaxInWindow: number,     // e.g., 8
   * }} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    // guildId -> userId -> { msgs: number[], links: number[] }
    this.state = new Map();
  }

  _bucket(gid, uid) {
    if (!this.state.has(gid)) this.state.set(gid, new Map());
    const g = this.state.get(gid);
    if (!g.has(uid)) g.set(uid, { msgs: [], links: [] });
    return g.get(uid);
  }

  record(guildId, userId, linkCountNow = 0, nowTs = Date.now()) {
    const s = this._bucket(guildId, userId);

    // Push timestamps
    s.msgs.push(nowTs);
    for (let i = 0; i < linkCountNow; i++) s.links.push(nowTs);

    // Cull windows
    const msgCut = nowTs - this.cfg.msgWindowMs;
    const linkCut = nowTs - this.cfg.linkWindowMs;
    s.msgs = s.msgs.filter(t => t >= msgCut);
    s.links = s.links.filter(t => t >= linkCut);

    // Check thresholds
    if (s.msgs.length >= this.cfg.msgMaxInWindow) {
      return { shouldBan: true, reason: `Message spam: ${s.msgs.length}/${Math.round(this.cfg.msgWindowMs/1000)}s` };
    }
    if (s.links.length >= this.cfg.linkMaxInWindow) {
      return { shouldBan: true, reason: `Link spam: ${s.links.length}/${Math.round(this.cfg.linkWindowMs/1000)}s` };
    }
    return { shouldBan: false };
  }

  clear(guildId, userId) {
    const g = this.state.get(guildId);
    if (!g) return;
    g.delete(userId);
    if (g.size === 0) this.state.delete(guildId);
  }
}
