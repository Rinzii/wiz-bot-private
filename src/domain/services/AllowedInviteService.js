import { AllowedInviteModel } from "../../infrastructure/database/models/AllowedInvite.js";

function normalizeCode(code) {
  if (!code) return null;
  return String(code).trim().toLowerCase();
}

export class AllowedInviteService {
  #cache = new Map();

  constructor() {}

  async loadAll() {
    const docs = await AllowedInviteModel.find().lean();
    this.#cache.clear();
    for (const doc of docs) {
      if (!doc?.codeLower) continue;
      this.#cache.set(doc.codeLower, doc);
    }
    return this.#cache.size;
  }

  get size() {
    return this.#cache.size;
  }

  isAllowed(code) {
    const lowered = normalizeCode(code);
    if (!lowered) return false;
    return this.#cache.has(lowered);
  }

  list() {
    return [...this.#cache.values()].sort((a, b) => {
      return a.code.localeCompare(b.code, undefined, { sensitivity: "base" });
    });
  }

  async add({ code, url, guildId, guildName, iconUrl, addedBy }) {
    if (!code) throw new Error("Invite code required");
    const payload = {
      code,
      url,
      guildId,
      guildName,
      iconUrl: iconUrl || null,
      addedBy: addedBy || null
    };
    const doc = await AllowedInviteModel.findOneAndUpdate(
      { codeLower: normalizeCode(code) },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (doc?.codeLower) this.#cache.set(doc.codeLower, doc);
    return doc;
  }

  async remove(code) {
    const lowered = normalizeCode(code);
    if (!lowered) return false;
    const doc = await AllowedInviteModel.findOneAndDelete({ codeLower: lowered }).lean();
    if (doc?.codeLower) this.#cache.delete(doc.codeLower);
    return Boolean(doc);
  }
}
