import { getMemberLogColors } from "../../shared/utils/memberLog.js";
import { createMemberEmbedBase } from "../../shared/utils/memberLogEmbeds.js";
import { formatMemberLine, getLogger, getStaffMemberLogService } from "./memberLogShared.js";

const COLORS = getMemberLogColors();
const MAX_ROLE_LINES = 10;

function normalizeDisplayName(member) {
  return member?.displayName ?? member?.nickname ?? member?.user?.globalName ?? member?.user?.username ?? null;
}

function computeRoleDiff(oldMember, newMember) {
  const everyoneId = newMember?.guild?.id ?? oldMember?.guild?.id ?? null;
  const oldIds = new Set();
  const newIds = new Set();

  if (oldMember?.roles?.cache) {
    for (const [id] of oldMember.roles.cache) {
      if (id && id !== everyoneId) oldIds.add(id);
    }
  }
  if (newMember?.roles?.cache) {
    for (const [id] of newMember.roles.cache) {
      if (id && id !== everyoneId) newIds.add(id);
    }
  }

  const lines = [];
  for (const id of newIds) {
    if (!oldIds.has(id)) lines.push(`Added <@&${id}>`);
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) lines.push(`Removed <@&${id}>`);
  }

  const total = lines.length;
  if (!total) return { lines: [], total: 0 };

  if (total > MAX_ROLE_LINES) {
    const shown = lines.slice(0, MAX_ROLE_LINES);
    shown.push(`…and ${total - MAX_ROLE_LINES} more change(s)`);
    return { lines: shown, total };
  }

  return { lines, total };
}

export default {
  name: "guildMemberUpdate",
  once: false,
  async execute(oldMember, newMember) {
    const container = newMember?.client?.container;
    const guild = newMember?.guild ?? oldMember?.guild ?? null;
    if (!container || !guild) return;

    const logService = getStaffMemberLogService(container);
    if (!logService) return;

    let currentMember = newMember;
    if (currentMember?.partial && currentMember.fetch) {
      try {
        currentMember = await currentMember.fetch();
      } catch {/* ignore fetch errors */}
    }

    const displayNameBefore = normalizeDisplayName(oldMember);
    const displayNameAfter = normalizeDisplayName(currentMember);
    const nameChanged = displayNameBefore !== displayNameAfter;
    const roleDiff = computeRoleDiff(oldMember, currentMember);

    if (!nameChanged && roleDiff.total === 0) return;

    try {
      const { embed, user } = createMemberEmbedBase({
        member: currentMember,
        title: "Member Updated",
        color: COLORS.neutral
      });

      const description = [];
      description.push(`Member: ${formatMemberLine(currentMember, user)}`);

      if (nameChanged) {
        description.push("", `Old display name: ${displayNameBefore ?? "—"}`, `New display name: ${displayNameAfter ?? "—"}`);
      }

      if (roleDiff.total > 0) {
        description.push("", ...roleDiff.lines);
      }

      embed.setDescription(description.join("\n"));

      await logService.send(guild, { embeds: [embed] });
    } catch (err) {
      const logger = getLogger(container);
      if (logger?.error) {
        await logger.error("staffMemberLog.update.error", {
          guildId: guild.id,
          userId: currentMember?.id ?? null,
          error: err instanceof Error ? err.stack : String(err)
        }).catch(() => {});
      }
    }
  }
};
