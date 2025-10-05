export const DEFAULT_CONFIG = Object.freeze({
  token: "",
  clientId: "",
  mongoUri: "mongodb://localhost:27017/discord_modbot",
  devGuildIds: [],
  privateModuleDirs: [],
  modLogChannelId: "",
  logLevel: "info",
  debugChannelId: "",
  channels: {
    staffMemberLogId: "",
    staffActionLogId: ""
  },
  antiSpam: {
    msgWindowMs: 15_000,
    msgMaxInWindow: 10,
    linkWindowMs: 45_000,
    linkMaxInWindow: 6
  },
  brandNew: {
    enabled: true,
    thresholdMs: 30 * 60_000,
    alertChannelId: ""
  },
  colors: {
    green: 0x57F287,
    red: 0xED4245,
    neutral: 0x5865F2,
    alert: 0xF05A66
  },
  fileScanner: {
    enabled: true,
    prefixBytes: 512,
    staffFlagChannelKey: "flag_log",
    staffActionChannelKey: "action_log",
    vtActionThreshold: 5,
    vtMuteDurationMs: 24 * 60 * 60_000,
    virusTotal: {
      apiKey: "",
      pollIntervalMs: 5_000,
      maxPolls: 12,
      maxFileBytes: 32 * 1024 * 1024
    }
  },
  mentionTracker: {
    enabled: false,
    staffFlagChannelKey: "flag_log",
    trackedRoleIds: [],
    trackedUserIds: [],
    additionalFlagChannelKeys: []
  },
  displayNamePolicy: {
    sweepIntervalMinutes: 60
  }
});
