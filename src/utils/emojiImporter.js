import { PermissionFlagsBits } from "discord.js";

const CUSTOM_EMOJI_REGEX = /<(?<animated>a?):(?<name>[a-zA-Z0-9_]{2,32}):(?<id>\d{17,20})>/g;

export function extractCustomEmojis(text) {
  if (!text) return [];
  const results = [];
  const regex = new RegExp(CUSTOM_EMOJI_REGEX.source, "g");
  let match;
  while ((match = regex.exec(text)) !== null) {
    const groups = match.groups ?? {};
    results.push({
      animated: groups.animated === "a",
      originalName: groups.name,
      id: groups.id
    });
  }
  return results;
}

export function getEmojiCdnUrl({ id, animated }) {
  const extension = animated ? "gif" : "png";
  return `https://cdn.discordapp.com/emojis/${id}.${extension}`;
}

export function sanitizeEmojiName(name) {
  if (!name) return "emoji";
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized.length < 2) sanitized = sanitized.padEnd(2, "_");
  if (sanitized.length > 32) sanitized = sanitized.slice(0, 32);
  return sanitized;
}

export function isValidEmojiName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9_]{2,32}$/.test(name);
}

export function ensureUniqueEmojiName(baseName, usedNames) {
  let base = sanitizeEmojiName(baseName);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }

  let counter = 0;
  while (counter < 1000) {
    const suffix = `_${counter}`;
    const trimmedBase = base.slice(0, Math.max(2, 32 - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }

  throw new Error("Unable to generate unique emoji name");
}

export async function fetchExistingEmojiNames(guild) {
  const collection = await guild.emojis.fetch();
  const names = new Set();
  for (const emoji of collection.values()) {
    if (emoji.name) names.add(emoji.name);
  }
  return names;
}

export async function ensureBotEmojiPermissions(interaction) {
  const me = interaction.guild?.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageGuildExpressions)) {
    throw new Error("Bot requires the Manage Emojis and Stickers permission.");
  }
}

function resolveExtensionFromContentType(contentType) {
  const match = /image\/([a-zA-Z0-9.+-]+)/.exec(contentType ?? "");
  if (!match) return null;
  const subtype = match[1].toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype.includes("gif")) return "gif";
  if (subtype.includes("png")) return "png";
  if (subtype.includes("webp")) return "webp";
  return subtype;
}

export async function fetchEmojiAttachment(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch emoji asset (${response.status})`);
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    throw new Error("Emoji URL did not return an image.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error("Emoji download returned empty data.");
  }
  const extension = resolveExtensionFromContentType(contentType);
  return { buffer, contentType, extension };
}

export async function createEmojiFromCdn(guild, emoji, usedNames, reason) {
  const url = getEmojiCdnUrl(emoji);
  const { buffer, extension } = await fetchEmojiAttachment(url);
  const name = ensureUniqueEmojiName(emoji.originalName, usedNames);
  const ext = extension ?? (emoji.animated ? "gif" : "png");
  const filename = `${name}.${ext}`;
  await guild.emojis.create({ attachment: { attachment: buffer, name: filename }, name, reason });
  return name;
}

export async function createEmojiFromUrl(guild, name, url, usedNames, reason) {
  const { buffer, extension } = await fetchEmojiAttachment(url);
  const uniqueName = ensureUniqueEmojiName(name, usedNames);
  const filename = extension ? `${uniqueName}.${extension}` : uniqueName;
  await guild.emojis.create({ attachment: { attachment: buffer, name: filename }, name: uniqueName, reason });
  return uniqueName;
}
