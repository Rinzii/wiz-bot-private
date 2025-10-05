import { Client, GatewayIntentBits, Partials } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "./config.js";
import { connectMongo } from "./db/mongoose.js";
import { Container, TOKENS } from "./container.js";
import { WarningService } from "./services/WarningService.js";
import { ModerationService } from "./services/ModerationService.js";
import { ChannelMapService } from "./services/ChannelMapService.js";
import { StaffRoleService } from "./services/StaffRoleService.js"; // ← added
import { loadDirCommands, loadDirEvents, loadPlugins } from "./core/loader.js";
import { Logger } from "./utils/logger.js";
import mongoose from "mongoose";

async function main() {
  await connectMongo();

  const container = new Container();

  // Logger + Debug state
  const debugState = { channelId: CONFIG.debugChannelId || "" };
  const logger = new Logger({ level: CONFIG.logLevel, mirrorFn: null });
  container.set("Logger", logger);
  container.set("DebugState", debugState);

  // Core services
  container.set(TOKENS.WarningService, new WarningService());
  container.set(TOKENS.ModerationService, new ModerationService(logger));
  container.set(TOKENS.ChannelMapService, new ChannelMapService());
  container.set(TOKENS.StaffRoleService, new StaffRoleService()); // ← added

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
