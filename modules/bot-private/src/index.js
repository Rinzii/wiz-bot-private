import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRIVATE_TOKENS } from "./services/tokens.js";

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
      commandDirs: [resolve(__dirname, "commands")],
      eventDirs:   [resolve(__dirname, "events")],

      async register(container) {
        const { AntiRaidService } = await import("./services/AntiRaidService.js");
        const { MemberTracker } = await import("./services/MemberTracker.js");
        const { BrandNewAccountWatcher } = await import("./services/BrandNewAccountWatcher.js");

        // Resolve the host project's src/ directory relative to this plugin.
        const rootSrc = resolve(__dirname, "../../..", "src");
        const fromSrc = (rel) => pathToFileURL(resolve(rootSrc, rel)).href;
        const { CONFIG } = await import(fromSrc("config.js"));
        const { TOKENS } = await import(fromSrc("container.js"));
        const { formatDuration } = await import(fromSrc("utils/time.js"));

        const getModLog = async (g) => {
          try {
            const cms = container.get(TOKENS.ChannelMapService);
            const candidates = ["bot_log", "member_log", "action_log", "mod_log"];
            let id = null;
            for (const key of candidates) {
              const m = await cms.get(g.id, key);
              if (m?.channelId) { id = m.channelId; break; }
            }
            const finalId = id || CONFIG.modLogChannelId;
            if (!finalId) return null;
            const ch = g.channels.cache.get(finalId) ?? await g.channels.fetch(finalId).catch(() => null);
            return (ch && ch.isTextBased?.() && ch.type === 0) ? ch : null;
          } catch { return null; }
        };

        const logger = container.get(TOKENS.Logger);

        const tracker = new MemberTracker({ logger });

        const cms = container.get(TOKENS.ChannelMapService);
        const brandNewCfg = CONFIG.brandNew || {};
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

          const preferredId = brandNewCfg.alertChannelId || null;
          if (preferredId) {
            const direct = await tryFetch(preferredId);
            if (direct) return direct;
          }

          const fallbackId = CONFIG.modLogChannelId;
          if (fallbackId) {
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
        });

        tracker.addSubmodule(brandNewWatcher);

        container.set(PRIVATE_TOKENS.MemberTracker, tracker);
        container.set(PRIVATE_TOKENS.BrandNewAccountWatcher, brandNewWatcher);
        container.set(PRIVATE_TOKENS.AntiRaidService, new AntiRaidService(getModLog, 10));
      }
    };
  }
};
