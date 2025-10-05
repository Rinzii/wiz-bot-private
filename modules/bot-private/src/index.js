import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRIVATE_TOKENS } from "./services/tokens.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const PLUGIN_META = {
  name: "bot-private",
  version: "1.0.0",
  description: "Private plugin that provides anti-raid protections and admin-only controls.",
  provides: { commands: ["antiraid"], events: ["guildMemberAdd"] },
  permissionsNeeded: ["Administrator (to run /antiraid)", "Manage Channels (for lockdown rate limits)"],
  configKeysUsed: ["modLogChannelId"],
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

        // Resolve the host project's src/ directory relative to this plugin.
        const rootSrc = resolve(__dirname, "../../..", "src");
        const fromSrc = (rel) => pathToFileURL(resolve(rootSrc, rel)).href;
        const { CONFIG } = await import(fromSrc("config.js"));
        const { TOKENS } = await import(fromSrc("container.js"));

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

        container.set(PRIVATE_TOKENS.AntiRaidService, new AntiRaidService(getModLog, 10));
      }
    };
  }
};
