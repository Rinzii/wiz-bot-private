const DEFAULT_CHANNEL_CANDIDATES = new Map(
  Object.entries({
    flag_log: ["flag-log"],
    experimental_log: ["experimental-log"],
    action_log: ["action-log", "staff-action-log"],
    staff_action_log: ["action-log", "staff-action-log"],
    join_boost_log: ["join-boost-log"],
    brand_new_alert: ["brand-new-alert", "join-boost-log"],
    member_log: ["member-log", "staff-member-log"],
    staff_member_log: ["member-log", "staff-member-log"],
    message_log: ["message-log"],
    bot_log: ["bot-log"],
    mod_log: ["mod-log", "moderator-log"]
  }).map(([key, names]) => [
    key,
    new Set(names.map((name) => normalizeChannelName(name)).filter(Boolean))
  ])
);

function normalizeChannelName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .trim();
}

function toKeyArray(preferredKeys) {
  if (Array.isArray(preferredKeys)) {
    return preferredKeys.filter(Boolean);
  }
  return preferredKeys ? [preferredKeys] : [];
}

function defaultChannelPredicate(channel) {
  if (!channel?.isTextBased?.()) return false;
  if (typeof channel.isThread === "function" && channel.isThread()) return false;
  return true;
}

export function findDefaultStaffChannel(guild, preferredKeys, predicate = defaultChannelPredicate) {
  if (!guild?.channels?.cache?.values) return null;
  const keys = toKeyArray(preferredKeys);
  if (!keys.length) return null;

  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const candidates = DEFAULT_CHANNEL_CANDIDATES.get(key);
    if (!candidates?.size) continue;

    for (const channel of guild.channels.cache.values()) {
      if (!predicate(channel)) continue;
      const normalized = normalizeChannelName(channel.name);
      if (!normalized) continue;
      if (candidates.has(normalized)) {
        return channel;
      }
    }
  }

  return null;
}

export async function resolveStaffChannel(guild, channelMapService, preferredKeys, fallback) {
  if (!guild) return null;

  const seen = new Set();
  const tryFetch = async (id) => {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const cached = guild.channels.cache.get(id);
    if (cached?.isTextBased?.()) return cached;
    try {
      const fetched = await guild.channels.fetch(id).catch(() => null);
      return fetched?.isTextBased?.() ? fetched : null;
    } catch {
      return null;
    }
  };

  const keys = toKeyArray(preferredKeys);
  if (channelMapService) {
    for (const key of keys) {
      try {
        const mapping = await channelMapService.get(guild.id, key);
        if (!mapping?.channelId) continue;
        const channel = await tryFetch(mapping.channelId);
        if (channel) return channel;
      } catch {
        // ignore lookup errors
      }
    }
  }

  const defaultChannel = findDefaultStaffChannel(guild, keys);
  if (defaultChannel) return defaultChannel;

  const fallbackId = await (async () => {
    if (typeof fallback === "function") {
      try {
        const resolved = await fallback(guild);
        return typeof resolved === "string" ? resolved : null;
      } catch {
        return null;
      }
    }
    if (typeof fallback === "string") return fallback;
    return null;
  })();

  if (fallbackId) {
    const fallbackChannel = await tryFetch(fallbackId);
    if (fallbackChannel) return fallbackChannel;
  }

  return null;
}
