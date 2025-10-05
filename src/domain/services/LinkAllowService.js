/**
 * LinkAllowService
 * Stores and checks allowed links/patterns per guild.
 *
 * Types supported:
 *  - exact       : exact URL match (normalized)
 *  - host        : host match (e.g., "discord.gg" or "example.com")
 *  - path_prefix : URL path starts with this string (after the host), e.g. "/my/path"
 *  - substring   : URL string contains this substring
 *  - regex       : JS RegExp (string), tested against the full URL
 *  - invite_code : Discord invite code (e.g., "abcdEFG")
 *
 * Mongo collection: link_allow
 * Document: { guildId, type, value, note?, addedBy, createdAt }
 */

import { URL } from "node:url";

function tryNormalizeUrl(u) {
  try {
    const url = new URL(u);
    // Normalize: lowercase host, remove default ports, keep protocol http/https/discord
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(text) {
  // very loose URL matcher; discord messages often paste raw links
  const re = /\bhttps?:\/\/[^\s<>()]+|discord\.gg\/[a-zA-Z0-9-]+|discord\.com\/invite\/[a-zA-Z0-9-]+/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

// Normalize invites so we always check https://discord.gg/<code>
function normalizePotentialInvite(urlLike) {
  const m1 = urlLike.match(/discord\.gg\/([A-Za-z0-9-]+)/i);
  const m2 = urlLike.match(/discord\.com\/invite\/([A-Za-z0-9-]+)/i);
  const code = m1?.[1] || m2?.[1] || null;
  return code ? `https://discord.gg/${code}` : null;
}

export class LinkAllowService {
  /**
   * @param {import('mongodb').Db} db
   */
  constructor(db) {
    this.col = db.collection("link_allow");
  }

  async add(guildId, type, value, note, addedBy) {
    const doc = {
      guildId,
      type,
      value: String(value),
      note: note || "",
      addedBy: addedBy || "",
      createdAt: new Date()
    };
    await this.col.insertOne(doc);
    return doc;
  }

  async remove(guildId, type, value) {
    const { deletedCount } = await this.col.deleteOne({ guildId, type, value: String(value) });
    return deletedCount > 0;
  }

  async list(guildId) {
    return this.col.find({ guildId }).sort({ createdAt: -1 }).toArray();
  }

  async distinctTypes(guildId) {
    return this.col.distinct("type", { guildId });
  }

  async isAllowed(guildId, urlLike) {
    const inviteNorm = normalizePotentialInvite(urlLike);
    const asUrl = tryNormalizeUrl(urlLike);
    const doc = await this.col.find({ guildId }).toArray();

    for (const rule of doc) {
      if (rule.type === "invite_code" && inviteNorm) {
        // Compare codes only
        const code = inviteNorm.split("/").pop();
        if (code?.toLowerCase() === rule.value.toLowerCase()) return true;
      }

      if (rule.type === "exact" && asUrl) {
        const normRule = tryNormalizeUrl(rule.value);
        if (normRule && asUrl === normRule) return true;
      }

      if (rule.type === "host" && asUrl) {
        const host = new URL(asUrl).host.toLowerCase();
        if (host === String(rule.value).toLowerCase()) return true;
      }

      if (rule.type === "path_prefix" && asUrl) {
        const u = new URL(asUrl);
        const pref = String(rule.value);
        if (u.pathname.startsWith(pref)) return true;
      }

      if (rule.type === "substring") {
        if (String(asUrl || urlLike).includes(String(rule.value))) return true;
      }

      if (rule.type === "regex") {
        try {
          const rx = new RegExp(String(rule.value));
          if (rx.test(asUrl || urlLike)) return true;
        } catch {
          // ignore invalid regexes silently
        }
      }
    }
    return false;
  }

  // Expose small helpers (used by the event/command)
  static extractUrls(text) {
    return extractUrlsFromText(text || "");
  }
}
