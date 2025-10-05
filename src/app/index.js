import { Client, GatewayIntentBits, Partials } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "../config/index.js";
import { connectMongo } from "../infrastructure/database/mongoose.js";
import { Container, TOKENS } from "./container/index.js";
import { loadDirCommands, loadDirEvents, loadPlugins } from "./registry/loader.js";
import mongoose from "mongoose";
import { registerCoreServices } from "./container/registerCoreServices.js";

async function main() {
  await connectMongo();

  const container = new Container();

  const {
    logger,
    moderationService,
    allowedInviteService,
    debugState
  } = await registerCoreServices({ container, config: CONFIG });
  void allowedInviteService;

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
