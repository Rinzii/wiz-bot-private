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
const fileScannerDefaults = {
  enabled: true,
  prefixBytes: 512,
  staffFlagChannelKey: "flag_log",
  staffActionChannelKey: "action_log",
  vtActionThreshold: 5,
  vtMuteDurationMs: 24 * 60 * 60_000
};
const fileScannerFileCfg = fileCfg?.fileScanner || {};
const virusTotalDefaults = {
  apiKey: "",
  pollIntervalMs: 5000,
  maxPolls: 12,
  maxFileBytes: 32 * 1024 * 1024
};
const virusTotalFileCfg = fileScannerFileCfg?.virusTotal || fileCfg?.virusTotal || {};

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
  fileScanner: {
    enabled: toBoolean(envOr("FILE_SCANNER_ENABLED", fileScannerFileCfg.enabled ?? fileScannerDefaults.enabled), fileScannerDefaults.enabled),
    prefixBytes: toNumber(envOr("FILE_SCANNER_PREFIX_BYTES", fileScannerFileCfg.prefixBytes ?? fileScannerDefaults.prefixBytes), fileScannerDefaults.prefixBytes),
    staffFlagChannelKey: envOr("FILE_SCANNER_FLAG_CHANNEL_KEY", fileScannerFileCfg.staffFlagChannelKey ?? fileScannerDefaults.staffFlagChannelKey) || "",
    staffActionChannelKey: envOr("FILE_SCANNER_ACTION_CHANNEL_KEY", fileScannerFileCfg.staffActionChannelKey ?? fileScannerDefaults.staffActionChannelKey) || "",
    vtActionThreshold: toNumber(envOr("FILE_SCANNER_VT_THRESHOLD", fileScannerFileCfg.vtActionThreshold ?? fileScannerDefaults.vtActionThreshold), fileScannerDefaults.vtActionThreshold),
    vtMuteDurationMs: toNumber(envOr("FILE_SCANNER_MUTE_DURATION_MS", fileScannerFileCfg.vtMuteDurationMs ?? fileScannerDefaults.vtMuteDurationMs), fileScannerDefaults.vtMuteDurationMs),
    virusTotal: {
      apiKey: envOr("VIRUSTOTAL_API_KEY", virusTotalFileCfg.apiKey ?? virusTotalDefaults.apiKey) || "",
      pollIntervalMs: toNumber(envOr("VIRUSTOTAL_POLL_INTERVAL_MS", virusTotalFileCfg.pollIntervalMs ?? virusTotalDefaults.pollIntervalMs), virusTotalDefaults.pollIntervalMs),
      maxPolls: toNumber(envOr("VIRUSTOTAL_MAX_POLLS", virusTotalFileCfg.maxPolls ?? virusTotalDefaults.maxPolls), virusTotalDefaults.maxPolls),
      maxFileBytes: toNumber(envOr("VIRUSTOTAL_MAX_FILE_BYTES", virusTotalFileCfg.maxFileBytes ?? virusTotalDefaults.maxFileBytes), virusTotalDefaults.maxFileBytes)
    }
  }
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}
