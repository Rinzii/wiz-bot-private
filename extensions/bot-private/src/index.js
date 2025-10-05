import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_TOKENS } from "./domain/services/tokens.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const PLUGIN_META = {
  name: "bot-private",
  version: "1.0.0",
  description: "Private plugin that provides anti-raid protections and admin-only controls.",
  provides: { commands: ["antiraid"], events: ["guildMemberAdd", "guildBanAdd"] },
  permissionsNeeded: ["Administrator (to run /antiraid)", "Manage Channels (for lockdown rate limits)"],
  configKeysUsed: ["modLogChannelId", "brandNew.alertChannelId", "brandNew.thresholdMs", "brandNew.enabled"],
  requires: { host: "wiz-discord-bot >= 1.0.0" },
  author: "You",
  homepage: ""
};

export default {
  meta: PLUGIN_META,

  setup() {
    return {
      commandDirs: [resolve(__dirname, "features", "commands")],
      eventDirs:   [resolve(__dirname, "features", "events")],

      async register(container, context) {
        const { AntiRaidService } = await import("./domain/services/AntiRaidService.js");
        const { MemberTracker } = await import("./domain/services/MemberTracker.js");
        const { BrandNewAccountWatcher } = await import("./domain/services/BrandNewAccountWatcher.js");
        const { DashboardService } = await import("./domain/services/DashboardService.js");

        const config = context?.config;
        const tokens = context?.tokens;
        const formatDuration = context?.helpers?.formatDuration;
        const { WarningModel, ModerationActionModel } = context?.models || {};

        if (!config || !tokens || !formatDuration || !WarningModel || !ModerationActionModel) {
          throw new Error("bot-private plugin requires host context with config, tokens, helpers.formatDuration, and models");
        }

        const guildConfigService = container.get(tokens.GuildConfigService);
        const cms = container.get(tokens.ChannelMapService);

        const getModLog = async (g) => {
          try {
            const candidates = ["bot_log", "member_log", "action_log", "mod_log"];
            let id = null;
            for (const key of candidates) {
              const m = await cms.get(g.id, key);
              if (m?.channelId) { id = m.channelId; break; }
            }
            if (!id) {
              try {
                const dynamic = await guildConfigService.getModLogChannelId(g.id);
                if (dynamic) id = dynamic;
              } catch {/* ignore */}
            }
            const finalId = id || config.modLogChannelId;
            if (!finalId) return null;
            const ch = g.channels.cache.get(finalId) ?? await g.channels.fetch(finalId).catch(() => null);
            return (ch && ch.isTextBased?.() && ch.type === 0) ? ch : null;
          } catch { return null; }
        };

        const logger = container.get(tokens.Logger);

        const tracker = new MemberTracker({ logger });
        const brandNewCfg = config.brandNew || {};
        const brandNewChannelKeys = ["brand_new_alert", "member_log", "join_boost_log", "bot_log", "action_log", "mod_log"];

        const resolveAlertChannel = async (guild) => {
          if (!guild) return null;
          const seen = new Set();
          const tryFetch = async (id) => {
            if (!id || seen.has(id)) return null;
            seen.add(id);
            const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
            return (ch?.isTextBased?.() ? ch : null);
          };

          for (const key of brandNewChannelKeys) {
            try {
              const mapping = await cms.get(guild.id, key);
              if (!mapping?.channelId) continue;
              const mapped = await tryFetch(mapping.channelId);
              if (mapped) return mapped;
            } catch {/* ignore lookup errors */}
          }

          const fallbackIds = [];
          if (brandNewCfg.alertChannelId) fallbackIds.push(brandNewCfg.alertChannelId);
          try {
            const dynamic = await guildConfigService.getModLogChannelId(guild.id);
            if (dynamic) fallbackIds.push(dynamic);
          } catch {/* ignore */}
          if (config.modLogChannelId) fallbackIds.push(config.modLogChannelId);

          for (const fallbackId of fallbackIds) {
            const fallback = await tryFetch(fallbackId);
            if (fallback) return fallback;
          }
          return null;
        };

        const brandNewWatcher = new BrandNewAccountWatcher({
          logger,
          resolveChannel: resolveAlertChannel,
          thresholdMs: brandNewCfg.thresholdMs,
          enabled: brandNewCfg.enabled,
          formatDuration,
          colorResolver: (key) => {
            if (key === "alert") return config.colors?.alert ?? null;
            return null;
          },
        });

        tracker.addSubmodule(brandNewWatcher);

        container.set(PRIVATE_TOKENS.MemberTracker, tracker);
        container.set(PRIVATE_TOKENS.BrandNewAccountWatcher, brandNewWatcher);
        container.set(PRIVATE_TOKENS.AntiRaidService, new AntiRaidService(getModLog, 10));

        const dashboardService = new DashboardService({
          config: config.privateDashboard,
          logger,
          warningModel: WarningModel,
          moderationActionModel: ModerationActionModel
        });

        try {
          await dashboardService.start();
          logger?.info?.("dashboard.ready", { port: config.privateDashboard?.port });
        } catch (error) {
          logger?.error?.("dashboard.failed_to_start", { error: String(error?.message || error) });
        }

        container.set(PRIVATE_TOKENS.DashboardService, dashboardService);
        container.set(tokens.DashboardService, dashboardService);
      }
    };
  }
};
