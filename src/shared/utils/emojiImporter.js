import dns from "node:dns/promises";
import net from "node:net";
import { PermissionFlagsBits } from "discord.js";

// Common constants
const MAX_EMOJI_BYTES = 256 * 1024; // Discord enforces a 256 KiB limit per emoji
const COMMON_ERROR_MESSAGES = Object.freeze({
  FILE_TOO_LARGE: "Emoji file exceeds 256 KiB.",
  EMPTY_DOWNLOAD: "Emoji download returned empty data."
});
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

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
  const safeUrl = await assertSafeEmojiUrl(url);

  const controller = new AbortController();
  let response;
  try {
    response = await fetch(safeUrl.toString(), {
      signal: controller.signal,
      redirect: "error"
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Emoji download was aborted.");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch emoji asset (${response.status})`);
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    throw new Error("Emoji URL did not return an image.");
  }

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_EMOJI_BYTES) {
    controller.abort();
    throw new Error(COMMON_ERROR_MESSAGES.FILE_TOO_LARGE);
  }

  const buffer = await readResponseBody(response, controller);
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

async function assertSafeEmojiUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Emoji URL must be a valid absolute URL.");
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Emoji URL must use http or https.");
  }

  if (!parsed.hostname) {
    throw new Error("Emoji URL must include a hostname.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Emoji URL must not include credentials.");
  }

  const hostname = parsed.hostname.trim();
  if (!hostname) {
    throw new Error("Emoji URL must include a valid hostname.");
  }

  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost === "127.0.0.1") {
    throw new Error("Emoji URL hostname is not allowed.");
  }

  await ensurePublicHostname(hostname);

  return parsed;
}

async function ensurePublicHostname(hostname) {
  const directIpFamily = net.isIP(hostname);
  if (directIpFamily) {
    if (isDisallowedAddress(hostname, directIpFamily)) {
      throw new Error("Emoji URL resolves to a disallowed address.");
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(`Failed to resolve emoji URL hostname: ${error?.message ?? error}`);
  }

  if (!records || records.length === 0) {
    throw new Error("Emoji URL hostname did not resolve to an address.");
  }

  for (const record of records) {
    if (isDisallowedAddress(record.address, record.family)) {
      throw new Error("Emoji URL resolves to a private or loopback address.");
    }
  }
}

function isDisallowedAddress(address, familyHint) {
  const family = familyHint || net.isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }

  if (family === 6) {
    const mapped = extractIpv4FromMapped(address);
    if (mapped) return isPrivateIpv4(mapped);
    return isPrivateIpv6(address);
  }

  return true;
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value))) return true;

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0 || a === 255) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;

  const firstHextet = normalized.split(":")[0] || "";
  const value = Number.parseInt(firstHextet, 16);
  if (Number.isNaN(value)) return true;

  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((value & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function extractIpv4FromMapped(address) {
  const match = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1] : null;
}

async function readResponseBody(response, controller) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error(COMMON_ERROR_MESSAGES.EMPTY_DOWNLOAD);
    }
    if (buffer.length > MAX_EMOJI_BYTES) {
      throw new Error(COMMON_ERROR_MESSAGES.FILE_TOO_LARGE);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.length;
      if (received > MAX_EMOJI_BYTES) {
        controller.abort();
        throw new Error(COMMON_ERROR_MESSAGES.FILE_TOO_LARGE);
      }
      chunks.push(Buffer.from(value));
    }
  }

  if (received === 0) {
    throw new Error(COMMON_ERROR_MESSAGES.EMPTY_DOWNLOAD);
  }

  return Buffer.concat(chunks);
}
