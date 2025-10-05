export class Container {
  #map = new Map();
  set(key, value) { this.#map.set(key, value); }
  get(key) {
    if (!this.#map.has(key)) throw new Error(`Container missing: ${key}`);
    return this.#map.get(key);
  }
}

export const TOKENS = {
  Logger: "Logger",
  DebugState: "DebugState",
  WarningService: "WarningService",
  ModerationService: "ModerationService",
  ModerationLogService: "ModerationLogService",
  ChannelMapService: "ChannelMapService",
  StaffRoleService: "StaffRoleService",
  AntiSpamService: "AntiSpamService",
  RuntimeModerationState: "RuntimeModerationState",
  AllowedInviteService: "AllowedInviteService"
};
