export async function resolveStaffChannel(guild, channelMapService, preferredKeys, fallbackId) {
  if (!guild || !channelMapService) return null;

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

  const keys = Array.isArray(preferredKeys) ? preferredKeys : [preferredKeys].filter(Boolean);
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

  if (fallbackId) {
    const fallbackChannel = await tryFetch(fallbackId);
    if (fallbackChannel) return fallbackChannel;
  }

  return null;
}
