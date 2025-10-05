import { EmbedBuilder } from "discord.js";
import { TOKENS } from "../../app/container/index.js";
import { CONFIG } from "../../config/index.js";
import { formatDuration } from "../../shared/utils/time.js";
import { resolveStaffChannel } from "../../shared/utils/staffChannels.js";

const EXECUTABLE_SIGNATURES = [
  { label: "PE (Windows)", signature: [0x4d, 0x5a] },
  { label: "ELF", signature: [0x7f, 0x45, 0x4c, 0x46] },
  { label: "Mach-O", signature: [0xfe, 0xed, 0xfa, 0xce] },
  { label: "Mach-O", signature: [0xce, 0xfa, 0xed, 0xfe] },
  { label: "Mach-O (64-bit)", signature: [0xfe, 0xed, 0xfa, 0xcf] },
  { label: "Mach-O (64-bit)", signature: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: "Mach-O (Fat)", signature: [0xca, 0xfe, 0xba, 0xbe] },
  { label: "Mach-O (Fat)", signature: [0xbe, 0xba, 0xfe, 0xca] }
];

const ARCHIVE_SIGNATURES = [
  { label: "ZIP", signature: [0x50, 0x4b, 0x03, 0x04] },
  { label: "ZIP", signature: [0x50, 0x4b, 0x05, 0x06] },
  { label: "ZIP", signature: [0x50, 0x4b, 0x07, 0x08] },
  { label: "7z", signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { label: "RAR (v4)", signature: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] },
  { label: "RAR (v5)", signature: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] },
  { label: "GZIP", signature: [0x1f, 0x8b] },
  { label: "BZIP2", signature: [0x42, 0x5a, 0x68] },
  { label: "XZ", signature: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { label: "Zstandard", signature: [0x28, 0xb5, 0x2f, 0xfd] }
];

const ZLIB_SECOND_BYTES = new Set([0x01, 0x5e, 0x9c, 0xda]);

const MAX_EMBED_FIELD = 1024;

function hasSignature(bytes, signature, offset = 0) {
  if (!bytes || bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function detectTar(bytes) {
  if (!bytes || bytes.length < 262) return false;
  const signature = [0x75, 0x73, 0x74, 0x61, 0x72]; // "ustar"
  return hasSignature(bytes, signature, 257);
}

function detectZlib(bytes) {
  if (!bytes || bytes.length < 2) return false;
  return bytes[0] === 0x78 && ZLIB_SECOND_BYTES.has(bytes[1]);
}

function classifyBytes(bytes) {
  for (const sig of EXECUTABLE_SIGNATURES) {
    if (hasSignature(bytes, sig.signature, sig.offset || 0)) {
      return { kind: "executable", label: sig.label };
    }
  }
  if (detectTar(bytes)) {
    return { kind: "archive", label: "TAR" };
  }
  for (const sig of ARCHIVE_SIGNATURES) {
    if (hasSignature(bytes, sig.signature, sig.offset || 0)) {
      return { kind: "archive", label: sig.label };
    }
  }
  if (detectZlib(bytes)) {
    return { kind: "archive", label: "Zlib" };
  }
  return { kind: "other", label: null };
}

async function fetchPrefix(url, maxBytes, logger, name) {
  if (!url || maxBytes <= 0) return null;
  const controller = new AbortController();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (!res.body) {
      const arrayBuffer = await res.arrayBuffer();
      return new Uint8Array(arrayBuffer.slice(0, maxBytes));
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const needed = Math.min(value.length, maxBytes - total);
      chunks.push(value.slice(0, needed));
      total += needed;
      if (needed < value.length) break;
    }
    controller.abort();
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch (error) {
    controller.abort();
    logger?.warn?.("file_scanner.prefix_failed", {
      url,
      name,
      error: String(error?.message || error)
    });
    return null;
  }
}

function quoteBlock(text) {
  if (!text) return "> (no text content)";
  const sanitized = text.replace(/\r/g, "\n");
  const lines = sanitized.split(/\n/).map(line => `> ${line}`);
  return lines.join("\n");
}

function truncate(text, limit) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildFlagEmbed({ message, author, channelId, attachments, classification, staffNote }) {
  const embed = new EmbedBuilder()
    .setColor(classification === "executable" ? 0xff4d4f : 0xffa94d)
    .setTitle(classification === "executable" ? "Executable upload blocked" : "Archive upload flagged")
    .addFields(
      { name: "User", value: `${author} (${author.tag})`, inline: false },
      { name: "Channel", value: `<#${channelId}>`, inline: false },
      { name: "Message ID", value: message.id, inline: false }
    );

  const attachmentLines = attachments.map(att => `• ${att.attachment.name || "(unnamed)"} — ${att.classification.label || att.classification.kind}`);
  const attachmentText = truncate(attachmentLines.join("\n") || "(none)", MAX_EMBED_FIELD);
  embed.addFields({ name: "Attachments", value: attachmentText, inline: false });

  const quoted = truncate(quoteBlock(message.content || ""), MAX_EMBED_FIELD);
  embed.addFields({ name: "Message", value: quoted || "> (no text content)", inline: false });

  if (staffNote) {
    embed.addFields({ name: "Notes", value: truncate(staffNote, MAX_EMBED_FIELD), inline: false });
  }

  return embed;
}

function summarizeVirusTotal(result) {
  if (!result) return null;
  if (result.error) {
    return { text: `• **${result.name}** — ${result.error}` };
  }
  const stats = result.stats || {};
  const parts = [
    `harmless: ${stats.harmless ?? 0}`,
    `undetected: ${stats.undetected ?? 0}`,
    `suspicious: ${stats.suspicious ?? 0}`,
    `malicious: ${stats.malicious ?? 0}`
  ];
  const base = `• **${result.name}** — ${parts.join(" | ")}`;
  const link = result.link ? ` — ${result.link}` : "";
  return { text: `${base}${link}`.trim(), score: (stats.suspicious ?? 0) + (stats.malicious ?? 0) };
}

export default {
  name: "messageCreate",
  once: false,
  async execute(message) {
    try {
      if (!message?.inGuild?.() || message.author?.bot) return;
      const fileScannerCfg = CONFIG.fileScanner || {};
      if (!fileScannerCfg.enabled) return;
      if (!message.attachments?.size) return;

      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          // ignore fetch errors; continue with partial data
        }
      }

      if (!message.attachments?.size) return;

      const container = message.client?.container;
      if (!container) return;

      const logger = container.get(TOKENS.Logger);
      const cms = container.get(TOKENS.ChannelMapService);
      const guildConfigService = container.get(TOKENS.GuildConfigService);
      const vtService = container.get(TOKENS.VirusTotalService);

      const attachments = Array.from(message.attachments.values());
      if (!attachments.length) return;

      const prefixBytes = Math.max(1, Number(fileScannerCfg.prefixBytes) || 512);
      const scanned = [];
      for (const attachment of attachments) {
        const prefix = await fetchPrefix(attachment.url, prefixBytes, logger, attachment.name);
        const classification = classifyBytes(prefix);
        scanned.push({ attachment, prefix, classification });
      }

      const executableHits = scanned.filter((entry) => entry.classification.kind === "executable");
      const archiveHits = scanned.filter((entry) => entry.classification.kind === "archive");
      if (!executableHits.length && !archiveHits.length) return;

      const fallbackResolver = async (guild) => {
        if (!guild?.id) return CONFIG.modLogChannelId || "";
        const dynamicId = await guildConfigService.getModLogChannelId(guild.id);
        return dynamicId || CONFIG.modLogChannelId || "";
      };

      const staffFlagChannel = await resolveStaffChannel(
        message.guild,
        cms,
        fileScannerCfg.staffFlagChannelKey,
        fallbackResolver
      );

      const staffActionChannel = await resolveStaffChannel(
        message.guild,
        cms,
        fileScannerCfg.staffActionChannelKey,
        fallbackResolver
      );

      const flaggedEntries = [...executableHits, ...archiveHits];
      if (!flaggedEntries.length) return;
      let messageDeleted = false;

      if (executableHits.length) {
        try {
          await message.delete();
          messageDeleted = true;
        } catch (error) {
          logger?.warn?.("file_scanner.delete_failed", {
            messageId: message.id,
            guildId: message.guildId,
            error: String(error?.message || error)
          });
        }

        if (message.channel?.isTextBased?.()) {
          try {
            await message.channel.send({
              content: `⚠️ <@${message.author.id}>, please do not upload executable files. The attachment has been removed.`
            });
          } catch (error) {
            logger?.warn?.("file_scanner.warn_failed", {
              messageId: message.id,
              guildId: message.guildId,
              error: String(error?.message || error)
            });
          }
        }
      }

      if (staffFlagChannel) {
        const staffNote = executableHits.length && archiveHits.length
          ? "Attachments matched executable and archive file signatures."
          : (executableHits.length
            ? "Attachments matched executable file signatures."
            : "Attachments matched archive file signatures.");
        const embed = buildFlagEmbed({
          message,
          author: message.author,
          channelId: message.channelId,
          attachments: flaggedEntries,
          classification: executableHits.length ? "executable" : "archive",
          staffNote
        });
        try {
          await staffFlagChannel.send({ embeds: [embed] });
        } catch (error) {
          logger?.warn?.("file_scanner.flag_failed", {
            messageId: message.id,
            guildId: message.guildId,
            error: String(error?.message || error)
          });
        }
      } else {
        logger?.warn?.("file_scanner.flag_channel_missing", {
          guildId: message.guildId,
          key: fileScannerCfg.staffFlagChannelKey
        });
      }

      const vtSummaries = [];
      const toScan = flaggedEntries.map((entry) => ({
        attachment: entry.attachment,
        name: entry.attachment.name || "attachment",
        url: entry.attachment.url,
        size: entry.attachment.size || 0
      }));

      let thresholdTriggered = false;
      let highestScore = 0;
      let thresholdLink = null;
      const vtThreshold = Number(fileScannerCfg.vtActionThreshold) || 0;

      if (toScan.length) {
        if (vtService?.enabled) {
          for (const item of toScan) {
            const vtResult = await vtService.submitFileFromUrl({
              url: item.url,
              filename: item.name,
              size: item.size
            });
            if (vtResult.submitted && vtResult.analysis) {
              const { stats, link } = vtResult.analysis;
              const summary = summarizeVirusTotal({
                name: item.name,
                stats,
                link
              });
              if (summary) {
                vtSummaries.push(summary.text);
                if (summary.score >= vtThreshold && vtThreshold > 0) {
                  thresholdTriggered = true;
                  if (summary.score > highestScore) {
                    highestScore = summary.score;
                    thresholdLink = link || null;
                  }
                }
              }
            } else {
              vtSummaries.push(`• **${item.name}** — ${vtResult.error || "VirusTotal submission failed"}`);
            }
          }
        } else {
          for (const item of toScan) {
            vtSummaries.push(`• **${item.name}** — VirusTotal not configured (no API key).`);
          }
        }
      }

      if (vtSummaries.length && staffFlagChannel) {
        const content = [`**VirusTotal summary:**`, ...vtSummaries].join("\n");
        try {
          await staffFlagChannel.send({ content });
        } catch (error) {
          logger?.warn?.("file_scanner.vt_summary_failed", {
            messageId: message.id,
            guildId: message.guildId,
            error: String(error?.message || error)
          });
        }
      }

      if (thresholdTriggered) {
        if (!messageDeleted) {
          try {
            await message.delete();
            messageDeleted = true;
          } catch (error) {
            logger?.warn?.("file_scanner.delete_failed_threshold", {
              messageId: message.id,
              guildId: message.guildId,
              error: String(error?.message || error)
            });
          }
        }

        const durationMs = Math.max(0, Number(fileScannerCfg.vtMuteDurationMs) || 0);
        let muteResult = "not_attempted";
        if (durationMs > 0) {
          const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
          if (member?.moderatable) {
            try {
              await member.timeout(durationMs, "Automatic action: VirusTotal flagged attachment as high risk");
              muteResult = "muted";
            } catch (error) {
              muteResult = `failed: ${String(error?.message || error)}`;
              logger?.error?.("file_scanner.auto_mute_failed", {
                guildId: message.guildId,
                userId: message.author.id,
                error: String(error?.message || error)
              });
            }
          } else {
            muteResult = "not_moderatable";
            logger?.warn?.("file_scanner.auto_mute_unavailable", {
              guildId: message.guildId,
              userId: message.author.id
            });
          }
        }

        if (staffActionChannel) {
          const durationText = durationMs > 0 ? formatDuration(durationMs) : "0s";
          const actionLines = [
            `⛔️ **Automatic high-risk upload action**`,
            `User: <@${message.author.id}> (${message.author.tag})`,
            `Score: ${highestScore} (suspicious + malicious)`,
            `Mute: ${muteResult === "muted" ? `applied for ${durationText}` : muteResult.replace(/_/g, " ")}`,
            thresholdLink ? `Report: ${thresholdLink}` : null
          ].filter(Boolean);
          try {
            await staffActionChannel.send({ content: actionLines.join("\n") });
          } catch (error) {
            logger?.warn?.("file_scanner.action_notify_failed", {
              guildId: message.guildId,
              error: String(error?.message || error)
            });
          }
        }
      }
    } catch (error) {
      try {
        const container = message?.client?.container;
        const logger = container?.get?.(TOKENS.Logger);
        logger?.error?.("file_scanner.unhandled_error", {
          messageId: message?.id,
          guildId: message?.guildId,
          error: String(error?.message || error)
        });
      } catch {
        // ignore logging errors
      }
    }
  }
};
