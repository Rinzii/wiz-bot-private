export class Container {
  #map = new Map();
  set(key, value) { this.#map.set(key, value); }
  /**
   * Retrieve a dependency that must be present in the container.
   * Prefer {@link getOptional} when the binding is optional.
   * @throws {Error} When the binding is missing.
   */
  get(key) {
    if (!this.#map.has(key)) throw new Error(`Container missing: ${key}`);
    return this.#map.get(key);
  }
  /**
   * Retrieve an optional dependency. Returns {@code null} when the binding
   * is absent instead of throwing like {@link get}.
   */
  getOptional(key) {
    return this.#map.has(key) ? this.#map.get(key) ?? null : null;
  }
  has(key) {
    return this.#map.has(key);
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
  StaffMemberLogService: "StaffMemberLogService",
  AntiSpamService: "AntiSpamService",
  RuntimeModerationState: "RuntimeModerationState",
  VirusTotalService: "VirusTotalService",
  MentionTrackerService: "MentionTrackerService",
  AllowedInviteService: "AllowedInviteService",
  DisplayNamePolicyService: "DisplayNamePolicyService",
  GuildConfigService: "GuildConfigService",
  DashboardService: "DashboardService"
};
