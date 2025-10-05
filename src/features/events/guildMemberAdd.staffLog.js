import { formatDuration } from "../../shared/utils/time.js";
import { getMemberLogColors } from "../../shared/utils/memberLog.js";
import { createMemberEmbedBase } from "../../shared/utils/memberLogEmbeds.js";
import { formatMemberLine, getLogger, getStaffMemberLogService } from "./memberLogShared.js";
import { safeTimestamp } from "../../shared/utils/discordUsers.js";

const COLORS = getMemberLogColors();

export default {
  name: "guildMemberAdd",
  once: false,
  async execute(member) {
    if (!member?.client?.container || !member.guild) return;

    const logService = getStaffMemberLogService(member.client.container);
    if (!logService) return;

    try {
      const { embed, user } = createMemberEmbedBase({
        member,
        title: "Member Joined",
        color: COLORS.join
      });

      const lines = [
        `Member: ${formatMemberLine(member, user)}`
      ];

      const created = safeTimestamp(user?.createdTimestamp ?? user?.createdAt);
      if (created !== null) {
        const ageMs = Math.max(0, Date.now() - created);
        lines.push(`Account Age: ${formatDuration(ageMs)}`);
      }

      embed.setDescription(lines.join("\n"));

      await logService.send(member.guild, { embeds: [embed] });
    } catch (err) {
      const logger = getLogger(member.client.container);
      if (logger?.error) {
        await logger.error("staffMemberLog.join.error", {
          guildId: member.guild.id,
          userId: member.id,
          error: err instanceof Error ? err.stack : String(err)
        }).catch(() => {});
      }
    }
  }
};
