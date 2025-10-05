import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { DEFAULT_CONFIG } from "./defaults.js";

const CONFIG_FILES = ["config/default.jsonc", "config/local.jsonc"];

const ENV_OVERRIDES = [
  { env: "DISCORD_TOKEN", path: "token", parse: parseString },
  { env: "DISCORD_CLIENT_ID", path: "clientId", parse: parseString },
  { env: "MONGO_URI", path: "mongoUri", parse: parseString },
  { env: "DEV_GUILD_IDS", path: "devGuildIds", parse: parseList },
  { env: "PRIVATE_MODULE_DIRS", path: "privateModuleDirs", parse: parseList },
  { env: "MOD_LOG_CHANNEL_ID", path: "modLogChannelId", parse: parseString },
  { env: "LOG_LEVEL", path: "logLevel", parse: parseString },
  { env: "DEBUG_CHANNEL_ID", path: "debugChannelId", parse: parseString },
  { env: "STAFF_MEMBER_LOG_CHANNEL_ID", path: "channels.staffMemberLogId", parse: parseString },
  { env: "STAFF_ACTION_LOG_CHANNEL_ID", path: "channels.staffActionLogId", parse: parseString },
  { env: "ANTISPAM_MSG_WINDOW_MS", path: "antiSpam.msgWindowMs", parse: parseNumber },
  { env: "ANTISPAM_MSG_MAX", path: "antiSpam.msgMaxInWindow", parse: parseNumber },
  { env: "ANTISPAM_LINK_WINDOW_MS", path: "antiSpam.linkWindowMs", parse: parseNumber },
  { env: "ANTISPAM_LINK_MAX", path: "antiSpam.linkMaxInWindow", parse: parseNumber },
  { env: "BRAND_NEW_ENABLED", path: "brandNew.enabled", parse: parseBoolean },
  { env: "BRAND_NEW_THRESHOLD_MS", path: "brandNew.thresholdMs", parse: parseNumber },
  { env: "BRAND_NEW_ALERT_CHANNEL_ID", path: "brandNew.alertChannelId", parse: parseString },
  { env: "COLOR_GREEN", path: "colors.green", parse: parseColor },
  { env: "COLOR_RED", path: "colors.red", parse: parseColor },
  { env: "COLOR_DEFAULT", path: "colors.neutral", parse: parseColor },
  { env: "COLORS__ALERT_COLOR", path: "colors.alert", parse: parseColor },
  { env: "FILE_SCANNER_ENABLED", path: "fileScanner.enabled", parse: parseBoolean },
  { env: "FILE_SCANNER_PREFIX_BYTES", path: "fileScanner.prefixBytes", parse: parseNumber },
  { env: "FILE_SCANNER_FLAG_CHANNEL_KEY", path: "fileScanner.staffFlagChannelKey", parse: parseString },
  { env: "FILE_SCANNER_ACTION_CHANNEL_KEY", path: "fileScanner.staffActionChannelKey", parse: parseString },
  { env: "FILE_SCANNER_VT_THRESHOLD", path: "fileScanner.vtActionThreshold", parse: parseNumber },
  { env: "FILE_SCANNER_MUTE_DURATION_MS", path: "fileScanner.vtMuteDurationMs", parse: parseNumber },
  { env: "VIRUSTOTAL_API_KEY", path: "fileScanner.virusTotal.apiKey", parse: parseString },
  { env: "VIRUSTOTAL_POLL_INTERVAL_MS", path: "fileScanner.virusTotal.pollIntervalMs", parse: parseNumber },
  { env: "VIRUSTOTAL_MAX_POLLS", path: "fileScanner.virusTotal.maxPolls", parse: parseNumber },
  { env: "VIRUSTOTAL_MAX_FILE_BYTES", path: "fileScanner.virusTotal.maxFileBytes", parse: parseNumber },
  { env: "MENTION_TRACKER_ENABLED", path: "mentionTracker.enabled", parse: parseBoolean },
  { env: "MENTION_TRACKER_FLAG_CHANNEL_KEY", path: "mentionTracker.staffFlagChannelKey", parse: parseString },
  { env: "MENTION_TRACKER_EXTRA_FLAG_KEYS", path: "mentionTracker.additionalFlagChannelKeys", parse: parseList },
  { env: "MENTION_TRACKER_ROLE_IDS", path: "mentionTracker.trackedRoleIds", parse: parseList },
  { env: "MENTION_TRACKER_USER_IDS", path: "mentionTracker.trackedUserIds", parse: parseList },
  { env: "DISPLAY_NAME_SWEEP_INTERVAL_MINUTES", path: "displayNamePolicy.sweepIntervalMinutes", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_ENABLED", path: "privateDashboard.enabled", parse: parseBoolean },
  { env: "PRIVATE_DASHBOARD_PORT", path: "privateDashboard.port", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_BASE_PATH", path: "privateDashboard.basePath", parse: parseString },
  { env: "PRIVATE_DASHBOARD_GUILD_ALLOW_LIST", path: "privateDashboard.guildAllowList", parse: parseList },
  { env: "PRIVATE_DASHBOARD_USERNAME", path: "privateDashboard.username", parse: parseString },
  { env: "PRIVATE_DASHBOARD_PASSWORD_HASH", path: "privateDashboard.passwordHash", parse: parseString },
  { env: "PRIVATE_DASHBOARD_SESSION_SECRET", path: "privateDashboard.sessionSecret", parse: parseString },
  { env: "PRIVATE_DASHBOARD_SECURE_COOKIES", path: "privateDashboard.secureCookies", parse: parseSecureCookieMode },
  { env: "PRIVATE_DASHBOARD_TRUST_PROXY", path: "privateDashboard.trustProxy", parse: parseBoolean },
  { env: "PRIVATE_DASHBOARD_RATE_LIMIT_WINDOW_MS", path: "privateDashboard.rateLimit.windowMs", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_RATE_LIMIT_MAX", path: "privateDashboard.rateLimit.max", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_LOGIN_RATE_LIMIT_WINDOW_MS", path: "privateDashboard.loginRateLimit.windowMs", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_LOGIN_RATE_LIMIT_MAX", path: "privateDashboard.loginRateLimit.max", parse: parseNumber },
  { env: "PRIVATE_DASHBOARD_SESSION_MAX_AGE_MS", path: "privateDashboard.sessionMaxAgeMs", parse: parseNumber }
];

const layered = [DEFAULT_CONFIG, ...loadConfigLayers()].map(clonePlainObject);
const merged = layered.reduce((acc, layer) => deepMerge(acc, layer), {});
const withEnv = applyEnvOverrides(merged);
export const CONFIG = deepFreeze(withEnv);

if (!CONFIG.token || !CONFIG.clientId) {
  console.warn("[config] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID. Set env vars!");
}

function loadConfigLayers() {
  const cwd = process.cwd();
  const layers = [];
  for (const fileName of CONFIG_FILES) {
    const filePath = join(cwd, fileName);
    if (!existsSync(filePath)) continue;
    try {
      const rawText = readFileSync(filePath, "utf8");
      const raw = parseConfigFile(rawText, fileName);
      const normalized = normalizeLayer(raw);
      if (normalized && Object.keys(normalized).length) {
        layers.push(normalized);
      }
    } catch (error) {
      console.warn(`[config] Failed to read ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return layers;
}

function parseConfigFile(rawText, fileName) {
  const errors = [];
  const data = parseJsonc(rawText, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    const { line, column } = offsetToPosition(rawText, offset);
    const description = printParseErrorCode(error);
    throw new Error(`${description} at ${fileName}:${line}:${column}`);
  }
  if (!data || typeof data !== "object") return {};
  return data;
}

function offsetToPosition(text, offset) {
  const sliced = text.slice(0, offset);
  const lines = sliced.split(/\r?\n/);
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

function normalizeLayer(input) {
  if (!input || typeof input !== "object") return {};
  const layer = {};

  const maybeAssign = (path, value) => {
    if (value === undefined || value === null) return;
    setDeep(layer, path, clonePlainObject(value));
  };

  const directKeys = [
    "token",
    "clientId",
    "mongoUri",
    "devGuildIds",
    "privateModuleDirs",
    "modLogChannelId",
    "logLevel",
    "debugChannelId",
    "channels",
    "antiSpam",
    "brandNew",
    "colors",
    "fileScanner",
    "mentionTracker",
    "displayNamePolicy",
    "privateDashboard"
  ];

  for (const key of directKeys) {
    if (key in input) {
      if (key === "channels") {
        maybeAssign(key, normalizeChannels(input[key]));
      } else if (key === "colors") {
        maybeAssign(key, normalizeColors(input[key]));
      } else {
        maybeAssign(key, input[key]);
      }
    }
  }

  if (input.discord) {
    maybeAssign("token", input.discord.token);
    maybeAssign("clientId", input.discord.clientId);
    if (input.discord.devGuildIds !== undefined) {
      maybeAssign("devGuildIds", input.discord.devGuildIds);
    }
  }

  if (input.mongo) {
    maybeAssign("mongoUri", input.mongo.uri);
  }

  if (input.channels) {
    maybeAssign("channels", normalizeChannels(input.channels));
  }

  if (input.colors) {
    maybeAssign("colors", normalizeColors(input.colors));
  }

  return layer;
}

function normalizeChannels(value) {
  if (!value || typeof value !== "object") return {};
  const out = { ...value };
  if (value.staff_member_log && !out.staffMemberLogId) out.staffMemberLogId = value.staff_member_log;
  if (value.staff_action_log && !out.staffActionLogId) out.staffActionLogId = value.staff_action_log;
  if (out.staffMemberLogId !== undefined && out.staffMemberLogId !== null) {
    out.staffMemberLogId = String(out.staffMemberLogId).trim();
  }
  if (out.staffActionLogId !== undefined && out.staffActionLogId !== null) {
    out.staffActionLogId = String(out.staffActionLogId).trim();
  }
  return out;
}

function normalizeColors(value) {
  if (!value || typeof value !== "object") return {};
  const out = { ...value };
  if (out.default !== undefined && out.neutral === undefined) {
    out.neutral = out.default;
  }
  return out;
}

function applyEnvOverrides(base) {
  const result = clonePlainObject(base);
  for (const { env, path, parse } of ENV_OVERRIDES) {
    const raw = process.env[env];
    if (raw === undefined) continue;
    const parsed = parse(raw);
    if (parsed === undefined) continue;
    setDeep(result, path, parsed);
  }
  return result;
}

function parseString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function parseList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const str = String(value).trim();
  if (!str) return [];
  return str.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "enable", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "disable", "disabled"].includes(normalized)) return false;
  return undefined;
}

function parseSecureCookieMode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto") return "auto";
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  return parseBoolean(value);
}

function parseColor(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  const str = String(value).trim();
  if (!str) return undefined;
  if (str.startsWith("#")) {
    const parsed = Number.parseInt(str.slice(1), 16);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (str.toLowerCase().startsWith("0x")) {
    const parsed = Number.parseInt(str.slice(2), 16);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const numeric = Number(str);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : undefined;
}

function setDeep(target, path, value) {
  if (!path) return;
  const keys = path.split(".");
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!isPlainObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function deepMerge(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) {
    return [...override];
  }
  const result = isPlainObject(base) ? { ...base } : {};
  if (isPlainObject(override)) {
    for (const [key, value] of Object.entries(override)) {
      if (isPlainObject(value)) {
        result[key] = deepMerge(base?.[key], value);
      } else if (Array.isArray(value)) {
        result[key] = [...value];
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clonePlainObject(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function deepFreeze(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if ((isPlainObject(child) || Array.isArray(child)) && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
