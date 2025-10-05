import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "../../..");
const CONFIG_MODULE_PATH = join(ROOT_DIR, "src", "config", "index.js");
const CONFIG_MODULE_URL = pathToFileURL(CONFIG_MODULE_PATH);

const ENV_KEYS = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "MONGO_URI",
  "DEV_GUILD_IDS",
  "PRIVATE_MODULE_DIRS",
  "MOD_LOG_CHANNEL_ID",
  "LOG_LEVEL",
  "DEBUG_CHANNEL_ID",
  "STAFF_MEMBER_LOG_CHANNEL_ID",
  "STAFF_ACTION_LOG_CHANNEL_ID",
  "ANTISPAM_MSG_WINDOW_MS",
  "ANTISPAM_MSG_MAX",
  "ANTISPAM_LINK_WINDOW_MS",
  "ANTISPAM_LINK_MAX",
  "BRAND_NEW_ENABLED",
  "BRAND_NEW_THRESHOLD_MS",
  "BRAND_NEW_ALERT_CHANNEL_ID",
  "COLOR_GREEN",
  "COLOR_RED",
  "COLOR_DEFAULT",
  "COLORS__ALERT_COLOR",
  "FILE_SCANNER_ENABLED",
  "FILE_SCANNER_PREFIX_BYTES",
  "FILE_SCANNER_FLAG_CHANNEL_KEY",
  "FILE_SCANNER_ACTION_CHANNEL_KEY",
  "FILE_SCANNER_VT_THRESHOLD",
  "FILE_SCANNER_MUTE_DURATION_MS",
  "VIRUSTOTAL_API_KEY",
  "VIRUSTOTAL_POLL_INTERVAL_MS",
  "VIRUSTOTAL_MAX_POLLS",
  "VIRUSTOTAL_MAX_FILE_BYTES",
  "MENTION_TRACKER_ENABLED",
  "MENTION_TRACKER_FLAG_CHANNEL_KEY",
  "MENTION_TRACKER_EXTRA_FLAG_KEYS",
  "MENTION_TRACKER_ROLE_IDS",
  "MENTION_TRACKER_USER_IDS",
  "DISPLAY_NAME_SWEEP_INTERVAL_MINUTES"
];

function loadConfigSnapshot({ files = {}, env = {} } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "config-tests-"));
  const childEnv = { ...process.env };
  for (const key of ENV_KEYS) {
    delete childEnv[key];
  }
  for (const [key, value] of Object.entries(env)) {
    childEnv[key] = value;
  }

  try {
    for (const [fileName, contents] of Object.entries(files)) {
      const filePath = join(tempDir, fileName);
      const serialized = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
      const dirPath = dirname(filePath);
      if (!dirPath.startsWith(tempDir)) throw new Error("Invalid file path");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(filePath, `${serialized}\n`, "utf8");
    }

    const script = `
      import(${JSON.stringify(CONFIG_MODULE_URL.href)}).then((mod) => {
        console.log(JSON.stringify(mod.CONFIG));
      }).catch((error) => {
        console.error(error?.stack ?? error);
        process.exit(1);
      });
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: tempDir, env: childEnv, encoding: "utf8" }
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `Config loader exited with ${result.status}`);
    }

    const output = result.stdout.trim();
    return JSON.parse(output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("falls back to defaults when no files or env overrides are present", () => {
  const config = loadConfigSnapshot();
  assert.equal(config.mongoUri, "mongodb://localhost:27017/discord_modbot");
  assert.deepEqual(config.devGuildIds, []);
  assert.equal(config.brandNew.enabled, true);
  assert.equal(config.colors.neutral, 0x5865F2);
});

test("merges layered config files with normalization", () => {
  const config = loadConfigSnapshot({
    files: {
      "config/default.json": {
        brandNew: { enabled: false },
        channels: { staff_member_log: "111111111111111111" }
      },
      "config/local.json": {
        brandNew: { thresholdMs: 1234 },
        channels: { staffActionLogId: "222222222222222222" },
        antiSpam: { msgMaxInWindow: 20 }
      }
    }
  });

  assert.equal(config.brandNew.enabled, false);
  assert.equal(config.brandNew.thresholdMs, 1234);
  assert.equal(config.brandNew.alertChannelId, "");
  assert.equal(config.channels.staffMemberLogId, "111111111111111111");
  assert.equal(config.channels.staffActionLogId, "222222222222222222");
  assert.equal(config.antiSpam.msgMaxInWindow, 20);
  assert.equal(config.antiSpam.linkMaxInWindow, 6);
});

test("environment overrides have highest precedence and parse values", () => {
  const config = loadConfigSnapshot({
    files: {
      "config/default.json": {
        brandNew: { enabled: false }
      },
      "config/local.json": {
        brandNew: { enabled: false, alertChannelId: "should-be-overridden" },
        colors: { red: 0 },
        mentionTracker: {
          enabled: false,
          trackedRoleIds: ["roleA"],
          trackedUserIds: ["userA"],
          additionalFlagChannelKeys: ["alpha"]
        },
        antiSpam: { msgMaxInWindow: 10 },
        devGuildIds: ["base"]
      }
    },
    env: {
      BRAND_NEW_ENABLED: "true",
      BRAND_NEW_ALERT_CHANNEL_ID: "999999999999999999",
      COLOR_RED: "#00FF00",
      DEV_GUILD_IDS: "123, 456",
      MENTION_TRACKER_ENABLED: "enabled",
      MENTION_TRACKER_ROLE_IDS: "role1, role2 , role3",
      MENTION_TRACKER_USER_IDS: "user1",
      MENTION_TRACKER_EXTRA_FLAG_KEYS: "beta, gamma",
      ANTISPAM_MSG_MAX: "25"
    }
  });

  assert.equal(config.brandNew.enabled, true);
  assert.equal(config.brandNew.alertChannelId, "999999999999999999");
  assert.equal(config.colors.red, 0x00ff00);
  assert.deepEqual(config.devGuildIds, ["123", "456"]);
  assert.equal(config.antiSpam.msgMaxInWindow, 25);
  assert.equal(config.antiSpam.linkMaxInWindow, 6);
  assert.equal(config.mentionTracker.enabled, true);
  assert.deepEqual(config.mentionTracker.trackedRoleIds, ["role1", "role2", "role3"]);
  assert.deepEqual(config.mentionTracker.trackedUserIds, ["user1"]);
  assert.deepEqual(config.mentionTracker.additionalFlagChannelKeys, ["beta", "gamma"]);
});
