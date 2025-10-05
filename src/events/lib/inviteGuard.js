import { EmbedBuilder, PermissionsBitField } from "discord.js";
import { TOKENS } from "../../container.js";
import { CONFIG } from "../../config.js";
import { findInviteMatches } from "../../utils/invites.js";

const STAFF_KEYS = ["admin", "mod", "special"];
const MOD_PERM = PermissionsBitField.Flags.ModerateMembers;

const SKILL_ROLE_THRESHOLD = (CONFIG.roles?.skillRoleThreshold || "Proficient").toLowerCase();
const ORDERED_SKILL_ROLES = Array.isArray(CONFIG.roles?.skillRoles)
  ? CONFIG.roles.skillRoles
      .map((entry) => ({ name: String(entry?.name || "").trim(), roleId: String(entry?.roleId || entry?.id || "").trim() }))
      .filter((entry) => entry.name && entry.roleId)
  : [];

const TRUSTED_SKILL_ROLE_IDS = (() => {
  if (!ORDERED_SKILL_ROLES.length) return new Set();
  const thresholdIndex = ORDERED_SKILL_ROLES.findIndex((entry) => entry.name.toLowerCase() === SKILL_ROLE_THRESHOLD);
  if (thresholdIndex === -1) return new Set();
  return new Set(ORDERED_SKILL_ROLES.slice(thresholdIndex).map((entry) => entry.roleId));
})();

async function resolveMember(message) {
  if (message.member) return message.member;
  if (!message.guild) return null;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

function memberHasTrustedSkillRole(member) {
  if (!member || !TRUSTED_SKILL_ROLE_IDS.size) return false;
  const cache = member.roles?.cache;
  if (!cache?.size) return false;
  for (const roleId of TRUSTED_SKILL_ROLE_IDS) {
    if (cache.has(roleId)) return true;
  }
  return false;
}

async function resolveFlagLogChannel(message, container) {
  const cms = container.get(TOKENS.ChannelMapService);
  let channelId = null;
  try {
    const mapping = await cms.get(message.guildId, "flag_log");
    if (mapping?.channelId) channelId = mapping.channelId;
  } catch {
    // ignore lookup errors
  }
  if (!channelId && CONFIG.modLogChannelId) channelId = CONFIG.modLogChannelId;
  if (!channelId) return null;
  const channel =
    message.guild.channels.cache.get(channelId) ?? (await message.guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return null;
  return channel;
}

function buildLogEmbed(message, match, reason) {
  const embed = new EmbedBuilder()
    .setTitle("Invite link deleted")
    .setColor(0xed4245)
    .setTimestamp(new Date())
    .addFields(
      { name: "Author", value: `${message.author.tag} (${message.author.id})`, inline: false },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Invite", value: match.invite || match.code, inline: true }
    );

  if (message.content) {
    const snippet = message.content.length > 1000 ? `${message.content.slice(0, 1000)}…` : message.content;
    embed.setDescription(`>>> ${snippet}`);
  } else {
    embed.setDescription("(No message content)");
  }

  if (message.url) embed.setURL(message.url);
  if (message.attachments?.size) {
    const attachments = [...message.attachments.values()].slice(0, 4).map((att) => att.url || att.name);
    embed.addFields({ name: "Attachments", value: attachments.join("\n") });
  }

  if (reason) embed.setFooter({ text: reason });
  return embed;
}

export async function enforceInvitePolicy(message, source = "unknown") {
  if (!message?.inGuild?.() || message.author?.bot) return;

  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }

  const container = message.client?.container;
  if (!container) return;

  const logger = container.get(TOKENS.Logger);

  const matches = findInviteMatches(message.content || "");
  if (!matches.length) return;

  const member = await resolveMember(message);
  if (!member) {
    logger?.warn?.("invite_guard.no_member", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id,
      source
    });
  }

  const hasModPerms = member?.permissions?.has(MOD_PERM, true);
  if (hasModPerms) return;

  const staffRoleService = container.get(TOKENS.StaffRoleService);
  const staffRoleIds = await staffRoleService.getAllRoleIdsForKeys(message.guildId, STAFF_KEYS);
  const roleCache = member?.roles?.cache;
  const hasStaffRole = staffRoleIds.some((id) => roleCache?.has(id));
  if (hasStaffRole) return;

  if (memberHasTrustedSkillRole(member)) return;

  const allowedInviteService = container.get(TOKENS.AllowedInviteService);
  const violating = matches.find((match) => !allowedInviteService.isAllowed(match.code));
  if (!violating) return;

  const snapshot = {
    content: message.content,
    attachments: [...(message.attachments?.values?.() || [])]
  };

  try {
    await message.delete();
  } catch (err) {
    logger?.error?.("invite_guard.delete_failed", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id,
      error: String(err?.message || err),
      source
    });
    return;
  }

  try {
    await message.channel.send({ content: `<@${message.author.id}> Please do not send invite links.` });
  } catch (err) {
    logger?.warn?.("invite_guard.notice_failed", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id,
      error: String(err?.message || err),
      source
    });
  }

  try {
    const flagChannel = await resolveFlagLogChannel(message, container);
    if (flagChannel) {
      const attachmentsMap = new Map();
      for (const att of snapshot.attachments) {
        const key = att?.id || att?.url || att?.name;
        if (key) attachmentsMap.set(key, att);
      }
      const embed = buildLogEmbed(
        {
          author: message.author,
          channelId: message.channelId,
          content: snapshot.content,
          attachments: attachmentsMap,
          url: message.url
        },
        violating,
        `Source: ${source}`
      );
      await flagChannel.send({ content: "🚫 Invite link deleted", embeds: [embed] });
    } else {
      logger?.warn?.("invite_guard.flag_channel_missing", {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author?.id,
        source
      });
    }
  } catch (err) {
    logger?.error?.("invite_guard.log_failed", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author?.id,
      error: String(err?.message || err),
      source
    });
  }
}
