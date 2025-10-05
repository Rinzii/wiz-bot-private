import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cfgPath = join(process.cwd(), "configs.json");
const fileCfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

const envOr = (name, fallback) => {
  const v = process.env[name];
  return (v !== undefined && String(v).trim() !== "") ? v : fallback;
};
const toList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
};
const toNumber = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toBoolean = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  const lower = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "enable", "enabled"].includes(lower)) return true;
  if (["false", "0", "no", "n", "off", "disable", "disabled"].includes(lower)) return false;
  return fallback;
};

const antiSpamDefaults = {
  msgWindowMs: 15_000,
  msgMaxInWindow: 10,
  linkWindowMs: 45_000,
  linkMaxInWindow: 6
};
const antiSpamFileCfg = fileCfg?.antiSpam || {};
const brandNewDefaults = {
  enabled: true,
  thresholdMs: 30 * 60_000,
  alertChannelId: ""
};
const brandNewFileCfg = fileCfg?.brandNew || {};

const rolesFileCfg = fileCfg?.roles || {};
const rawSkillRoles = Array.isArray(rolesFileCfg?.skillRoles) ? rolesFileCfg.skillRoles : [];
const skillRoles = rawSkillRoles
  .map((entry) => {
    if (!entry) return null;
    if (typeof entry === "string") {
      const val = String(entry).trim();
      return val ? { name: val, roleId: val } : null;
    }
    if (Array.isArray(entry) && entry.length >= 2) {
      const name = String(entry[0] ?? "").trim();
      const roleId = String(entry[1] ?? "").trim();
      return name && roleId ? { name, roleId } : null;
    }
    if (typeof entry === "object") {
      const name = String(("name" in entry ? entry.name : entry.label) ?? "").trim();
      const roleId = String(("roleId" in entry ? entry.roleId : entry.id) ?? "").trim();
      if (!name || !roleId) return null;
      return { name, roleId };
    }
    return null;
  })
  .filter((entry) => entry && entry.name && entry.roleId);
const skillRoleThreshold = String(rolesFileCfg?.skillRoleThreshold || "Proficient").trim() || "Proficient";

export const CONFIG = {
  token: envOr("DISCORD_TOKEN", fileCfg?.discord?.token || ""),
  clientId: envOr("DISCORD_CLIENT_ID", fileCfg?.discord?.clientId || ""),
  mongoUri: envOr("MONGO_URI", fileCfg?.mongo?.uri || "mongodb://localhost:27017/discord_modbot"),
  devGuildIds: toList(envOr("DEV_GUILD_IDS", fileCfg?.discord?.devGuildIds || [])),
  privateModuleDirs: toList(envOr("PRIVATE_MODULE_DIRS", fileCfg?.privateModuleDirs || [])),
  modLogChannelId: envOr("MOD_LOG_CHANNEL_ID", fileCfg?.modLogChannelId || ""),
  logLevel: envOr("LOG_LEVEL", "info"),
  debugChannelId: envOr("DEBUG_CHANNEL_ID", ""),
  antiSpam: {
    msgWindowMs: toNumber(envOr("ANTISPAM_MSG_WINDOW_MS", antiSpamFileCfg.msgWindowMs ?? antiSpamDefaults.msgWindowMs), antiSpamDefaults.msgWindowMs),
    msgMaxInWindow: toNumber(envOr("ANTISPAM_MSG_MAX", antiSpamFileCfg.msgMaxInWindow ?? antiSpamDefaults.msgMaxInWindow), antiSpamDefaults.msgMaxInWindow),
    linkWindowMs: toNumber(envOr("ANTISPAM_LINK_WINDOW_MS", antiSpamFileCfg.linkWindowMs ?? antiSpamDefaults.linkWindowMs), antiSpamDefaults.linkWindowMs),
    linkMaxInWindow: toNumber(envOr("ANTISPAM_LINK_MAX", antiSpamFileCfg.linkMaxInWindow ?? antiSpamDefaults.linkMaxInWindow), antiSpamDefaults.linkMaxInWindow)
  },
  brandNew: {
    enabled: toBoolean(envOr("BRAND_NEW_ENABLED", brandNewFileCfg.enabled ?? brandNewDefaults.enabled), brandNewDefaults.enabled),
    thresholdMs: toNumber(envOr("BRAND_NEW_THRESHOLD_MS", brandNewFileCfg.thresholdMs ?? brandNewDefaults.thresholdMs), brandNewDefaults.thresholdMs),
    alertChannelId: envOr("BRAND_NEW_ALERT_CHANNEL_ID", brandNewFileCfg.alertChannelId ?? brandNewDefaults.alertChannelId) || ""
  },
  roles: {
    skillRoles,
    skillRoleThreshold
  }
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}
