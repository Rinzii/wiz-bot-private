import { Client, GatewayIntentBits, Partials } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "../config/index.js";
import { connectMongo } from "../infrastructure/database/mongoose.js";
import { Container, TOKENS } from "./container/index.js";
import { PluginManager } from "./registry/PluginManager.js";
import mongoose from "mongoose";
import { registerCoreServices } from "./container/registerCoreServices.js";
import { Logger } from "../shared/utils/logger.js";
import { WarningModel } from "../infrastructure/database/models/Warning.js";
import { ModerationActionModel } from "../infrastructure/database/models/ModerationAction.js";
import { formatDuration } from "../shared/utils/time.js";

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

  const pluginContext = {
    config: CONFIG,
    tokens: TOKENS,
    loggerClass: Logger,
    models: {
      WarningModel,
      ModerationActionModel
    },
    helpers: {
      formatDuration
    }
  };

  const pluginDirs = (CONFIG.privateModuleDirs || []).map((p) => resolve(process.cwd(), p));
  const pluginManager = new PluginManager({ pluginDirs });
  await pluginManager.load();
  await pluginManager.registerAll(container, pluginContext);

  const intents = pluginManager.collectIntents([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]);
  const partials = pluginManager.collectPartials([
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message
  ]);

  const client = new Client({ intents: [...intents], partials: [...partials] });
  client.container = container;
  client.commands = new Map();

  const dashboardService = container.getOptional(TOKENS.DashboardService);
  if (dashboardService) {
    try {
      dashboardService.setClient?.(client);

      await dashboardService.start();

      try {
        const url = dashboardService.getUrl?.();
        if (url) {
          logger?.info?.("dashboard.ready", { url });
        } else {
          logger?.info?.("dashboard.ready", { url: "(no url resolved)" });
        }
      } catch {}
    } catch (error) {
      logger?.error?.("dashboard.start_failed", { error: String(error?.message || error) });
    }
  }

  moderationService.setClient(client);

  await pluginManager.loadCommands({
    registry: client.commands,
    coreDirs: [join(process.cwd(), "src", "features", "commands")]
  });

  await pluginManager.loadEvents({
    client,
    coreDirs: [join(process.cwd(), "src", "features", "events")]
  });

  await client.login(CONFIG.token);

  if (CONFIG.debugChannelId) {
    try {
      const ch = await client.channels.fetch(CONFIG.debugChannelId).catch(() => null);
      if (ch?.isTextBased?.()) {
        await logger.setMirror(async (msg) => {
          await ch.send({ content: msg }).catch(() => {});
        });
        debugState.channelId = CONFIG.debugChannelId;
        logger.info("debug.mirror.ready", { channelId: CONFIG.debugChannelId });
      }
    } catch {}
  }

  const shutdown = async (code = 0) => {
    try {
      await client.destroy();
    } catch {}
    try {
      await mongoose.connection?.close?.();
    } catch {}
    try {
      await dashboardService?.stop?.();
    } catch {}
    process.exit(code);
  };

  process.on("SIGINT",  () => { console.log("Shutting down (SIGINT)…");  shutdown(0); });
  process.on("SIGTERM", () => { console.log("Shutting down (SIGTERM)…"); shutdown(0); });
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
