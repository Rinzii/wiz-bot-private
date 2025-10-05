import { Client, GatewayIntentBits, Partials } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "./config.js";
import { connectMongo } from "./db/mongoose.js";
import { Container, TOKENS } from "./container.js";
import { WarningService } from "./services/WarningService.js";
import { ModerationService } from "./services/ModerationService.js";
import { ChannelMapService } from "./services/ChannelMapService.js";
import { StaffRoleService } from "./services/StaffRoleService.js";
import { AntiSpamService } from "./services/AntiSpamService.js";
import { loadDirCommands, loadDirEvents, loadPlugins } from "./core/loader.js";
import { Logger } from "./utils/logger.js";
import mongoose from "mongoose";
import { ModerationLogService } from "./services/ModerationLogService.js";
import { RuntimeModerationState } from "./services/RuntimeModerationState.js";
import { StaffMemberLogService } from "./services/StaffMemberLogService.js";
import { AllowedInviteService } from "./services/AllowedInviteService.js";
import { VirusTotalService } from "./services/VirusTotalService.js";
import { MentionTrackerService } from "./services/MentionTrackerService.js";
import { DisplayNamePolicyService } from "./services/DisplayNamePolicyService.js";

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
  container.set(TOKENS.StaffRoleService, new StaffRoleService());
  container.set(TOKENS.AntiSpamService, new AntiSpamService(CONFIG.antiSpam));
  container.set(TOKENS.RuntimeModerationState, new RuntimeModerationState());
  container.set(TOKENS.StaffMemberLogService, new StaffMemberLogService({
    channelMapService,
    fallbackChannelId: CONFIG.channels?.staffMemberLogId || "",
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
    fallbackChannelId: CONFIG.modLogChannelId
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

  moderationService.setClient(client);

  // Commands
  await loadDirCommands(join(process.cwd(), "src", "commands"), client.commands);
  for (const r of regs) for (const d of (r.commandDirs || [])) await loadDirCommands(resolve(d), client.commands);

  // Events
  await loadDirEvents(join(process.cwd(), "src", "events"), client);
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
