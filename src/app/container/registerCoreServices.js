import { TOKENS } from "./index.js";
import { Logger } from "../../shared/utils/logger.js";
import { WarningService } from "../../domain/services/WarningService.js";
import { ModerationService } from "../../domain/services/ModerationService.js";
import { ChannelMapService } from "../../domain/services/ChannelMapService.js";
import { StaffRoleService } from "../../domain/services/StaffRoleService.js";
import { AntiSpamService } from "../../domain/services/AntiSpamService.js";
import { ModerationLogService } from "../../domain/services/ModerationLogService.js";
import { RuntimeModerationState } from "../../domain/services/RuntimeModerationState.js";
import { StaffMemberLogService } from "../../domain/services/StaffMemberLogService.js";
import { AllowedInviteService } from "../../domain/services/AllowedInviteService.js";
import { VirusTotalService } from "../../domain/services/VirusTotalService.js";
import { MentionTrackerService } from "../../domain/services/MentionTrackerService.js";
import { DisplayNamePolicyService } from "../../domain/services/DisplayNamePolicyService.js";
import { GuildConfigService } from "../../domain/services/GuildConfigService.js";

function resolve(value, factory) {
  if (value !== undefined) return value;
  return typeof factory === "function" ? factory() : factory;
}

export async function registerCoreServices({ container, config, services = {} }) {
  const debugState = resolve(services.debugState, () => ({ channelId: config?.debugChannelId || "" }));
  container.set(TOKENS.DebugState, debugState);

  const logger = resolve(services.logger, () => new Logger({ level: config?.logLevel, mirrorFn: null }));
  container.set(TOKENS.Logger, logger);

  const moderationLogService = resolve(services.moderationLogService, () => new ModerationLogService());
  container.set(TOKENS.ModerationLogService, moderationLogService);

  const warningService = resolve(services.warningService, () => new WarningService(moderationLogService));
  container.set(TOKENS.WarningService, warningService);

  const moderationService = resolve(services.moderationService, () => new ModerationService(logger, moderationLogService));
  container.set(TOKENS.ModerationService, moderationService);

  const channelMapService = resolve(services.channelMapService, () => new ChannelMapService());
  container.set(TOKENS.ChannelMapService, channelMapService);

  const staffRoleService = resolve(services.staffRoleService, () => new StaffRoleService());
  container.set(TOKENS.StaffRoleService, staffRoleService);

  const guildConfigService = resolve(services.guildConfigService, () => new GuildConfigService());
  container.set(TOKENS.GuildConfigService, guildConfigService);

  const antiSpamService = resolve(services.antiSpamService, () => new AntiSpamService(config?.antiSpam));
  container.set(TOKENS.AntiSpamService, antiSpamService);

  const runtimeModerationState = resolve(services.runtimeModerationState, () => new RuntimeModerationState());
  container.set(TOKENS.RuntimeModerationState, runtimeModerationState);

  const staffMemberLogService = resolve(
    services.staffMemberLogService,
    () => new StaffMemberLogService({
      channelMapService,
      fallbackChannelResolver: async (guild) => {
        if (!guild?.id) return config?.channels?.staffMemberLogId || config?.modLogChannelId || "";
        const dynamicId = await guildConfigService.getModLogChannelId(guild.id);
        return dynamicId || config?.channels?.staffMemberLogId || config?.modLogChannelId || "";
      },
      logger
    })
  );
  container.set(TOKENS.StaffMemberLogService, staffMemberLogService);

  const allowedInviteService = resolve(services.allowedInviteService, () => new AllowedInviteService());
  container.set(TOKENS.AllowedInviteService, allowedInviteService);

  try {
    const count = await allowedInviteService.loadAll?.();
    if (typeof count === "number") {
      logger?.info?.("invite_guard.allowlist_preload", { count });
    } else if (allowedInviteService?.loadAll) {
      logger?.info?.("invite_guard.allowlist_preload", {});
    }
  } catch (error) {
    logger?.error?.("invite_guard.allowlist_preload_failed", { error: String(error?.message || error) });
  }

  const virusTotalService = resolve(
    services.virusTotalService,
    () => new VirusTotalService(config?.fileScanner?.virusTotal || {}, logger)
  );
  container.set(TOKENS.VirusTotalService, virusTotalService);

  const mentionTrackerService = resolve(
    services.mentionTrackerService,
    () => new MentionTrackerService({
      logger,
      channelMapService,
      staffRoleService,
      config: config?.mentionTracker || {},
      fallbackChannelResolver: async (guild) => {
        if (!guild?.id) return config?.modLogChannelId || "";
        const dynamicId = await guildConfigService.getModLogChannelId(guild.id);
        return dynamicId || config?.modLogChannelId || "";
      }
    })
  );
  container.set(TOKENS.MentionTrackerService, mentionTrackerService);

  const displayNamePolicyService = resolve(
    services.displayNamePolicyService,
    () => new DisplayNamePolicyService({
      logger,
      sweepIntervalMinutes: config?.displayNamePolicy?.sweepIntervalMinutes ?? 60
    })
  );
  container.set(TOKENS.DisplayNamePolicyService, displayNamePolicyService);

  return {
    logger,
    moderationService,
    allowedInviteService,
    mentionTrackerService,
    displayNamePolicyService,
    debugState,
    channelMapService,
    staffRoleService,
    guildConfigService,
    moderationLogService,
    warningService,
    staffMemberLogService,
    virusTotalService,
    antiSpamService,
    runtimeModerationState
  };
}
