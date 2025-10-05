const DISCORD_EPOCH = 1420070400000n;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const TIMESTAMP_SHIFT = 22n;

/**
 * Decode a Discord snowflake ID into a Unix timestamp in milliseconds.
 * Returns null when the value cannot be interpreted as a snowflake.
 */
export function decodeSnowflake(id) {
  if (id === null || id === undefined) return null;
  let snowflake;
  try {
    snowflake = BigInt(id);
  } catch {
    return null;
  }

  if (snowflake < 0n || snowflake > MAX_UINT64) return null;

  const timestamp = (snowflake >> TIMESTAMP_SHIFT) + DISCORD_EPOCH;
  const numberTs = Number(timestamp);

  if (!Number.isSafeInteger(numberTs) || numberTs <= 0) return null;
  return numberTs;
}

/**
 * Format a Unix millisecond timestamp into a Discord timestamp token.
 * @param {number} ms - Milliseconds since Unix epoch.
 * @param {string} [style] - Optional Discord timestamp style (e.g. 'F', 'R').
 */
export function formatDiscordTimestamp(ms, style) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = Math.floor(ms / 1000);
  const suffix = style ? `:${style}` : "";
  return `<t:${seconds}${suffix}>`;
}

export const DISCORD_EPOCH_MS = Number(DISCORD_EPOCH);
