import { getMemberLogColors } from "../../shared/utils/memberLog.js";
import { createMemberEmbedBase } from "../../shared/utils/memberLogEmbeds.js";
import { formatMemberLine, getLogger, getStaffMemberLogService } from "./memberLogShared.js";

const COLORS = getMemberLogColors();

async function resolveUser(member) {
  if (member?.user) return member.user;
  if (member?.id && member?.client?.users?.fetch) {
    try {
      return await member.client.users.fetch(member.id);
    } catch {/* ignore fetch errors */}
  }
  return null;
}

export default {
  name: "guildMemberRemove",
  once: false,
  async execute(member) {
    if (!member?.client?.container || !member.guild) return;

    const logService = getStaffMemberLogService(member.client.container);
    if (!logService) return;

    try {
      const fallbackUser = await resolveUser(member);
      const { embed, user } = createMemberEmbedBase({
        member,
        user: fallbackUser,
        title: "Member Left",
        color: COLORS.leave
      });

      embed.setDescription(`Member: ${formatMemberLine(member, user)}`);

      await logService.send(member.guild, { embeds: [embed] });
    } catch (err) {
      const logger = getLogger(member.client.container);
      if (logger?.error) {
        await logger.error("staffMemberLog.leave.error", {
          guildId: member.guild.id,
          userId: member.id ?? null,
          error: err instanceof Error ? err.stack : String(err)
        }).catch(() => {});
      }
    }
  }
};
