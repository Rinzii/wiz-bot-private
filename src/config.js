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

const antiSpamDefaults = {
  msgWindowMs: 15_000,
  msgMaxInWindow: 10,
  linkWindowMs: 45_000,
  linkMaxInWindow: 6
};
const antiSpamFileCfg = fileCfg?.antiSpam || {};

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
  }
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}
