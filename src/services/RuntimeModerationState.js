export class RuntimeModerationState {
  #raidMode = new Map();
  #linkRules = new Map();
  #spamThresholds = new Map();
  #spamAction = new Map();
  #massMentionLimit = new Map();
  #automodSettings = new Map();
  #notes = new Map();

  setRaidMode(guildId, active) {
    this.#raidMode.set(guildId, Boolean(active));
  }

  getRaidMode(guildId) {
    return Boolean(this.#raidMode.get(guildId));
  }

  #ensureLinkBucket(guildId) {
    if (!this.#linkRules.has(guildId)) {
      this.#linkRules.set(guildId, { allow: [], deny: [] });
    }
    return this.#linkRules.get(guildId);
  }

  addLinkRule(guildId, kind, rule) {
    const bucket = this.#ensureLinkBucket(guildId);
    const collection = kind === "deny" ? bucket.deny : bucket.allow;
    const entry = { ...rule, id: `${Date.now()}-${Math.random()}` };
    collection.push(entry);
    return entry;
  }

  removeLinkRule(guildId, kind, value) {
    const bucket = this.#ensureLinkBucket(guildId);
    const collection = kind === "deny" ? bucket.deny : bucket.allow;
    const before = collection.length;
    const lowered = String(value).toLowerCase();
    const filtered = collection.filter((entry) => entry.value.toLowerCase() !== lowered);
    if (filtered.length === before) return false;
    if (kind === "deny") bucket.deny = filtered; else bucket.allow = filtered;
    this.#linkRules.set(guildId, bucket);
    return true;
  }

  listLinkRules(guildId, kind) {
    const bucket = this.#ensureLinkBucket(guildId);
    return [...(kind === "deny" ? bucket.deny : bucket.allow)];
  }

  testLink(guildId, url) {
    const bucket = this.#ensureLinkBucket(guildId);
    const lower = String(url).toLowerCase();
    const matchFn = (entry) => {
      if (entry.type === "exact") {
        return lower === entry.value.toLowerCase();
      }
      try {
        return lower.includes(entry.value.toLowerCase());
      } catch {
        return false;
      }
    };
    const deny = bucket.deny.find(matchFn);
    if (deny) return { result: "deny", rule: deny };
    const allow = bucket.allow.find(matchFn);
    if (allow) return { result: "allow", rule: allow };
    return { result: "none", rule: null };
  }

  setSpamThresholds(guildId, thresholds) {
    this.#spamThresholds.set(guildId, { ...thresholds });
  }

  getSpamThresholds(guildId) {
    return this.#spamThresholds.get(guildId) || null;
  }

  setSpamAction(guildId, action) {
    this.#spamAction.set(guildId, action);
  }

  getSpamAction(guildId) {
    return this.#spamAction.get(guildId) || "warn";
  }

  setMassMentionLimit(guildId, limit) {
    this.#massMentionLimit.set(guildId, limit);
  }

  getMassMentionLimit(guildId) {
    return this.#massMentionLimit.get(guildId) || null;
  }

  setAutomod(guildId, key, enabled) {
    if (!this.#automodSettings.has(guildId)) {
      this.#automodSettings.set(guildId, {});
    }
    const entry = this.#automodSettings.get(guildId);
    entry[key] = Boolean(enabled);
    this.#automodSettings.set(guildId, entry);
  }

  getAutomod(guildId, key) {
    const entry = this.#automodSettings.get(guildId);
    return entry ? Boolean(entry[key]) : false;
  }

  addNote(guildId, userId, authorId, text) {
    if (!this.#notes.has(guildId)) this.#notes.set(guildId, new Map());
    const guildNotes = this.#notes.get(guildId);
    if (!guildNotes.has(userId)) guildNotes.set(userId, []);
    const note = { text, authorId, createdAt: new Date() };
    guildNotes.get(userId).push(note);
    return note;
  }

  getNotes(guildId, userId) {
    return this.#notes.get(guildId)?.get(userId) || [];
  }
}
