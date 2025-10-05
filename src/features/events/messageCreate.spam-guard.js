import { PermissionsBitField } from "discord.js";
import { TOKENS } from "../../app/container/index.js";
import { LinkAllowService } from "../../domain/services/LinkAllowService.js";

const STAFF_KEYS = ["admin", "mod", "special"];

function countLinks(message) {
  const textLinks = LinkAllowService.extractUrls(message.content || "").length;
  const embedLinks = (message.embeds || []).reduce((sum, embed) => {
    const urls = [embed?.url, embed?.thumbnail?.url, embed?.image?.url, embed?.video?.url];
    return sum + urls.filter(Boolean).length;
  }, 0);
  const attachmentLinks = message.attachments?.size || 0;
  return textLinks + embedLinks + attachmentLinks;
}

async function ensureGuildMember(message) {
  if (message.member) return message.member;
  if (!message.guild) return null;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

export default {
  name: "messageCreate",
  once: false,
  async execute(message) {
    if (!message.inGuild() || message.author?.bot) return;

    const container = message.client?.container;
    if (!container) return;

    const logger = container.get(TOKENS.Logger);
    const member = await ensureGuildMember(message);
    if (!member) return;

    // Skip staff/admin/special roles
    const staffRoleService = container.get(TOKENS.StaffRoleService);
    const staffRoleIds = await staffRoleService.getAllRoleIdsForKeys(message.guildId, STAFF_KEYS);
    const roleCache = member.roles?.cache;
    const isStaffMapped = staffRoleIds.some((rid) => roleCache?.has(rid));
    const hasNamedRole = roleCache?.some((role) => {
      const name = role?.name?.toLowerCase?.() || "";
      return STAFF_KEYS.some((key) => name.includes(key));
    });
    const hasAdminPerms = member.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (isStaffMapped || hasNamedRole || hasAdminPerms) return;

    const antiSpamService = container.get(TOKENS.AntiSpamService);
    const linkCount = countLinks(message);
    const { shouldBan, reason } = antiSpamService.record(message.guildId, message.author.id, linkCount);
    if (!shouldBan) return;

    const moderationService = container.get(TOKENS.ModerationService);
    const meta = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      tag: message.author.tag,
      reason
    };

    try {
      await moderationService.ban({
        guild: message.guild,
        target: member,
        moderator: message.client.user,
        reason: `[Auto-ban] ${reason}`,
        durationMs: null,
        metadata: { source: "antispam", messageId: message.id }
      });
      antiSpamService.clear(message.guildId, message.author.id);
      logger?.warn?.("antispam.autoban", meta);
    } catch (err) {
      logger?.error?.("antispam.autoban_failed", { ...meta, error: String(err?.message || err) });
    }
  }
};
