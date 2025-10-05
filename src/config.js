import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cfgPath = join(process.cwd(), "configs.json");
const fileCfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const channelsFileCfg = fileCfg?.channels || {};
const colorsFileCfg = fileCfg?.colors || {};

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

const parseColor = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const str = String(value).trim();
  if (!str) return fallback;
  const lower = str.toLowerCase();
  if (lower.startsWith("0x")) {
    const parsed = Number.parseInt(lower.slice(2), 16);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  if (str.startsWith("#")) {
    const parsed = Number.parseInt(str.slice(1), 16);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : fallback;
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
const colorDefaults = {
  green: 0x57F287,
  red: 0xED4245,
  neutral: 0x5865F2
};

export const CONFIG = {
  token: envOr("DISCORD_TOKEN", fileCfg?.discord?.token || ""),
  clientId: envOr("DISCORD_CLIENT_ID", fileCfg?.discord?.clientId || ""),
  mongoUri: envOr("MONGO_URI", fileCfg?.mongo?.uri || "mongodb://localhost:27017/discord_modbot"),
  devGuildIds: toList(envOr("DEV_GUILD_IDS", fileCfg?.discord?.devGuildIds || [])),
  privateModuleDirs: toList(envOr("PRIVATE_MODULE_DIRS", fileCfg?.privateModuleDirs || [])),
  modLogChannelId: envOr("MOD_LOG_CHANNEL_ID", fileCfg?.modLogChannelId || ""),
  logLevel: envOr("LOG_LEVEL", "info"),
  debugChannelId: envOr("DEBUG_CHANNEL_ID", ""),
  channels: {
    staffMemberLogId: envOr("STAFF_MEMBER_LOG_CHANNEL_ID", channelsFileCfg.staff_member_log ?? channelsFileCfg.staffMemberLogId ?? "")
  },
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
  colors: {
    green: parseColor(envOr("COLOR_GREEN", colorsFileCfg.green ?? colorDefaults.green), colorDefaults.green),
    red: parseColor(envOr("COLOR_RED", colorsFileCfg.red ?? colorDefaults.red), colorDefaults.red),
    neutral: parseColor(envOr("COLOR_DEFAULT", colorsFileCfg.default ?? colorsFileCfg.neutral ?? colorDefaults.neutral), colorDefaults.neutral)
  }
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}
