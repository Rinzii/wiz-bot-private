export function formatUserTag(user) {
  if (!user) return "Unknown";
  if (typeof user.tag === "string" && user.tag) return user.tag;
  const username = user.username ?? user.globalName ?? null;
  const discriminator = user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : "";
  if (username) return `${username}${discriminator}`;
  return String(user.id ?? "Unknown");
}

export function getAvatarUrl(user, { size = 256 } = {}) {
  if (!user?.displayAvatarURL) return null;
  try {
    return user.displayAvatarURL({ size });
  } catch {
    return null;
  }
}

export function safeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return null;
}
