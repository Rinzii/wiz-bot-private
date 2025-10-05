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
  }
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}
