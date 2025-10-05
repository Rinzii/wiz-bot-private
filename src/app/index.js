import { Client, GatewayIntentBits, Partials } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "../config/index.js";
import { connectMongo } from "../infrastructure/database/mongoose.js";
import { Container, TOKENS } from "./container/index.js";
import { WarningService } from "../domain/services/WarningService.js";
import { ModerationService } from "../domain/services/ModerationService.js";
import { ChannelMapService } from "../domain/services/ChannelMapService.js";
import { StaffRoleService } from "../domain/services/StaffRoleService.js";
import { AntiSpamService } from "../domain/services/AntiSpamService.js";
import { loadDirCommands, loadDirEvents, loadPlugins } from "./registry/loader.js";
import { Logger } from "../shared/utils/logger.js";
import mongoose from "mongoose";
import { ModerationLogService } from "../domain/services/ModerationLogService.js";
import { RuntimeModerationState } from "../domain/services/RuntimeModerationState.js";
import { StaffMemberLogService } from "../domain/services/StaffMemberLogService.js";
import { AllowedInviteService } from "../domain/services/AllowedInviteService.js";
import { VirusTotalService } from "../domain/services/VirusTotalService.js";
import { MentionTrackerService } from "../domain/services/MentionTrackerService.js";
import { DisplayNamePolicyService } from "../domain/services/DisplayNamePolicyService.js";
import { GuildConfigService } from "../domain/services/GuildConfigService.js";

async function main() {
  await connectMongo();

  const container = new Container();

  // Logger + Debug state
  const debugState = { channelId: CONFIG.debugChannelId || "" };
  const logger = new Logger({ level: CONFIG.logLevel, mirrorFn: null });
  container.set(TOKENS.Logger, logger);
  container.set(TOKENS.DebugState, debugState);

  // Core services
  const moderationLogService = new ModerationLogService();
  container.set(TOKENS.ModerationLogService, moderationLogService);

  const warningService = new WarningService(moderationLogService);
  container.set(TOKENS.WarningService, warningService);

  const moderationService = new ModerationService(logger, moderationLogService);
  container.set(TOKENS.ModerationService, moderationService);

  const channelMapService = new ChannelMapService();
  container.set(TOKENS.ChannelMapService, channelMapService);
  const staffRoleService = new StaffRoleService();
  container.set(TOKENS.StaffRoleService, staffRoleService);
  const guildConfigService = new GuildConfigService();
  container.set(TOKENS.GuildConfigService, guildConfigService);
  container.set(TOKENS.AntiSpamService, new AntiSpamService(CONFIG.antiSpam));
  container.set(TOKENS.RuntimeModerationState, new RuntimeModerationState());
  container.set(TOKENS.StaffMemberLogService, new StaffMemberLogService({
    channelMapService,
    fallbackChannelResolver: async (guild) => {
      if (!guild?.id) return CONFIG.channels?.staffMemberLogId || CONFIG.modLogChannelId || "";
      const dynamicId = await guildConfigService.getModLogChannelId(guild.id);
      return dynamicId || CONFIG.channels?.staffMemberLogId || CONFIG.modLogChannelId || "";
    },
    logger
  }));
  const allowedInviteService = new AllowedInviteService();
  container.set(TOKENS.AllowedInviteService, allowedInviteService);

  try {
    const count = await allowedInviteService.loadAll();
    logger?.info?.("invite_guard.allowlist_preload", { count });
  } catch (err) {
    logger?.error?.("invite_guard.allowlist_preload_failed", { error: String(err?.message || err) });
  }
  container.set(TOKENS.VirusTotalService, new VirusTotalService(CONFIG.fileScanner?.virusTotal || {}, logger));
  const mentionTrackerService = new MentionTrackerService({
    logger,
    channelMapService,
    staffRoleService,
    config: CONFIG.mentionTracker || {},
    fallbackChannelResolver: async (guild) => {
      if (!guild?.id) return CONFIG.modLogChannelId || "";
      const dynamicId = await guildConfigService.getModLogChannelId(guild.id);
      return dynamicId || CONFIG.modLogChannelId || "";
    }
  });
  container.set(TOKENS.MentionTrackerService, mentionTrackerService);

  const displayNamePolicyService = new DisplayNamePolicyService({
    logger,
    sweepIntervalMinutes: CONFIG.displayNamePolicy?.sweepIntervalMinutes ?? 60
  });
  container.set(TOKENS.DisplayNamePolicyService, displayNamePolicyService);

  // Plugins
  const pluginDirs = (CONFIG.privateModuleDirs || []).map(p => resolve(process.cwd(), p));
  const regs = await loadPlugins(pluginDirs);
  for (const r of regs) if (typeof r.register === "function") await r.register(container);

  // Intents/partials
  const intents = new Set([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
  const partials = new Set([Partials.Channel, Partials.GuildMember, Partials.Message]);
  for (const r of regs) { (r.intents || []).forEach(i => intents.add(i)); (r.partials || []).forEach(p => partials.add(p)); }

  const client = new Client({ intents: [...intents], partials: [...partials] });
  client.container = container;
  client.commands = new Map();

  if (container.has(TOKENS.DashboardService)) {
    try {
      const dashboardService = container.get(TOKENS.DashboardService);
      dashboardService?.setClient?.(client);
    } catch (error) {
      logger?.error?.("dashboard.attach_failed", { error: String(error?.message || error) });
    }
  }

  moderationService.setClient(client);

  // Commands
  await loadDirCommands(join(process.cwd(), "src", "features", "commands"), client.commands);
  for (const r of regs) for (const d of (r.commandDirs || [])) await loadDirCommands(resolve(d), client.commands);

  // Events
  await loadDirEvents(join(process.cwd(), "src", "features", "events"), client);
  for (const r of regs) for (const d of (r.eventDirs || [])) await loadDirEvents(resolve(d), client);

  // Login
  await client.login(CONFIG.token);

  // If DEBUG_CHANNEL_ID configured, hook mirror now
  if (CONFIG.debugChannelId) {
    try {
      const ch = await client.channels.fetch(CONFIG.debugChannelId).catch(() => null);
      if (ch?.isTextBased?.()) {
        await logger.setMirror(async (msg) => { await ch.send({ content: msg }).catch(() => {}); });
        debugState.channelId = CONFIG.debugChannelId;
        logger.info("debug.mirror.ready", { channelId: CONFIG.debugChannelId });
      }
    } catch {}
  }

  // Graceful shutdown
  const shutdown = async (code = 0) => {
    try { await client.destroy(); } catch {}
    try { await mongoose.connection?.close?.(); } catch {}
    process.exit(code);
  };
  process.on("SIGINT",  () => { console.log("Shutting down (SIGINT)…");  shutdown(0); });
  process.on("SIGTERM", () => { console.log("Shutting down (SIGTERM)…"); shutdown(0); });
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
