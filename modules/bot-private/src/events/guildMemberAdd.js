import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { TOKENS } from "../../../../src/container.js";
import { CONFIG } from "../../../../src/config.js";
import { ModerationActionType } from "../../../../src/services/moderationActions.js";
import { PRIVATE_TOKENS } from "../services/tokens.js";

const ACTION_TYPES = [
  ModerationActionType.Ban,
  ModerationActionType.Softban,
  ModerationActionType.Kick
];

const ACTION_DISPLAY = {
  [ModerationActionType.Ban]: { past: "banned", noun: "ban" },
  [ModerationActionType.Softban]: { past: "softbanned", noun: "softban" },
  [ModerationActionType.Kick]: { past: "kicked", noun: "kick" }
};

const CHANNEL_KEYS = ["staff_action_log", "action_log", "mod_log", "bot_log"]; // priority order
const DEFAULT_ALERT_COLOR = 0xF05A66;

export default {
  name: "guildMemberAdd",
  once: false,
  async execute(member) {
    try {
      const tracker = member.client.container.get(PRIVATE_TOKENS.MemberTracker);
      tracker.onJoin(member);
    } catch {}
    try {
      const svc = member.client.container.get(PRIVATE_TOKENS.AntiRaidService);
      await svc.recordJoin(member.guild);
    } catch {}

    await handleRejoinAlert(member);
  }
};

async function handleRejoinAlert(member) {
  const guild = member?.guild;
  const user = member?.user;
  if (!guild || !user || user.bot) return;

  const client = guild.client || member.client;
  const container = client?.container;
  if (!container) return;

  let logger = null;
  try { logger = container.get(TOKENS.Logger); } catch {}

  let logService = null;
  try { logService = container.get(TOKENS.ModerationLogService); } catch {}
  if (!logService) return;

  let channelMap = null;
  try { channelMap = container.get(TOKENS.ChannelMapService); } catch {}

  let entry;
  try {
    entry = await logService.findLatestByActions({
      guildId: guild.id,
      userId: member.id,
      actions: ACTION_TYPES
    });
  } catch (err) {
    if (logger?.error) {
      await logger.error("moderation.rejoin_alert.lookup_failed", {
        guildId: guild.id,
        userId: member.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }

  if (!entry) return;

  const action = normalizeAction(entry);
  const actionDisplay = ACTION_DISPLAY[action] ?? { past: "actioned", noun: "action" };

  const channel = await resolveStaffActionChannel(guild, channelMap, logger, container);
  if (!channel) return;

  if (!channel.isTextBased?.()) {
    if (logger?.error) {
      await logger.error("moderation.rejoin_alert.channel_not_text", {
        guildId: guild.id,
        channelId: channel.id
      });
    }
    return;
  }

  const me = guild.members.me
    ?? await guild.members.fetch(client.user.id).catch(() => null);
  if (!me) {
    if (logger?.error) {
      await logger.error("moderation.rejoin_alert.self_member_missing", {
        guildId: guild.id,
        channelId: channel.id,
        userId: member.id
      });
    }
    return;
  }

  const permissions = channel.permissionsFor?.(me) ?? null;
  const missingPerms = requiredPermissionGaps(permissions);
  if (missingPerms.length) {
    if (logger?.error) {
      await logger.error("moderation.rejoin_alert.send_no_permission", {
        guildId: guild.id,
        channelId: channel.id,
        userId: member.id,
        missing: missingPerms.join("|")
      });
    }
    return;
  }

  const timestampText = formatActionTimestamp(entry);
  const reason = normalizeReason(entry?.reason);
  const embed = buildAlertEmbed({ member, actionDisplay, timestampText, reason });

  try {
    await channel.send({ embeds: [embed] });
    if (logger?.info) {
      await logger.info("moderation.rejoin_alert.sent", {
        guildId: guild.id,
        channelId: channel.id,
        userId: member.id,
        action: action
      });
    }
  } catch (err) {
    if (logger?.error) {
      await logger.error("moderation.rejoin_alert.send_failed", {
        guildId: guild.id,
        channelId: channel.id,
        userId: member.id,
        action: action,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

function normalizeAction(entry) {
  const value = entry?.action ?? entry?.type;
  return typeof value === "string" ? value.toLowerCase() : null;
}

async function resolveStaffActionChannel(guild, channelMap, logger, container) {
  const seen = new Set();
  const tryFetch = async (id) => {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    return ch ?? null;
  };

  if (channelMap) {
    for (const key of CHANNEL_KEYS) {
      try {
        const mapping = await channelMap.get(guild.id, key);
        if (!mapping?.channelId) continue;
        const mapped = await tryFetch(mapping.channelId);
        if (mapped?.isTextBased?.()) return mapped;
      } catch (err) {
        if (logger?.warn) {
          await logger.warn("moderation.rejoin_alert.channel_lookup_failed", {
            guildId: guild.id,
            key,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  }

  const candidates = [];
  if (container) {
    try {
      const gcs = container.get(TOKENS.GuildConfigService);
      const dynamic = await gcs.getModLogChannelId(guild.id);
      if (dynamic) candidates.push(dynamic);
    } catch (err) {
      if (logger?.warn) {
        await logger.warn("moderation.rejoin_alert.config_lookup_failed", {
          guildId: guild.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  candidates.push(CONFIG?.channels?.staffActionLogId, CONFIG?.modLogChannelId);
  for (const id of candidates) {
    const ch = await tryFetch(id);
    if (ch?.isTextBased?.()) return ch;
  }

  if (logger?.warn) {
    await logger.warn("moderation.rejoin_alert.channel_missing", { guildId: guild.id });
  }
  return null;
}

function requiredPermissionGaps(permissions) {
  if (!permissions) {
    return ["ViewChannel", "SendMessages", "EmbedLinks"];
  }
  const needed = [
    [PermissionFlagsBits.ViewChannel, "ViewChannel"],
    [PermissionFlagsBits.SendMessages, "SendMessages"],
    [PermissionFlagsBits.EmbedLinks, "EmbedLinks"]
  ];
  const missing = [];
  for (const [flag, label] of needed) {
    if (!permissions.has(flag)) missing.push(label);
  }
  return missing;
}

function formatActionTimestamp(entry) {
  const candidates = [entry?.issuedAt, entry?.issued_at, entry?.createdAt, entry?.created_at];
  for (const candidate of candidates) {
    const ts = toDate(candidate);
    if (!ts) continue;
    const seconds = Math.floor(ts.getTime() / 1000);
    if (Number.isFinite(seconds) && seconds > 0) {
      return `<t:${seconds}:F> (<t:${seconds}:R>)`;
    }
  }
  return null;
}

function normalizeReason(reason) {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length ? trimmed : null;
}

function buildAlertEmbed({ member, actionDisplay, timestampText, reason }) {
  const lines = [`<@${member.id}>`];
  if (timestampText) {
    lines.push(`Previously ${actionDisplay.past} on ${timestampText}`);
  } else {
    lines.push(`Previously ${actionDisplay.past}`);
  }
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }

  const user = member.user;
  const avatarUrl = typeof user.displayAvatarURL === "function"
    ? user.displayAvatarURL({ size: 256 })
    : null;

  return new EmbedBuilder()
    .setColor(resolveAlertColor())
    .setAuthor({
      name: `Previously ${actionDisplay.past} user re-joined: ${formatUserLabel(user)}`,
      iconURL: avatarUrl ?? undefined
    })
    .setDescription(lines.join("\n"))
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp(new Date());
}

function formatUserLabel(user) {
  if (!user) return "Unknown";
  const discrim = typeof user.discriminator === "string" && user.discriminator !== "0"
    ? `#${user.discriminator}`
    : "";
  const base = user.username ?? user.tag ?? "unknown";
  return `${base}${discrim}`;
}

function resolveAlertColor() {
  const configured = CONFIG?.colors?.alert;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_ALERT_COLOR;
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}
