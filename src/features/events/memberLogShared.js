import { TOKENS } from "../../app/container/index.js";
import { formatUserTag } from "../../shared/utils/discordUsers.js";

export function formatMemberLine(member, user) {
  const resolvedUser = user ?? member?.user ?? null;
  const id = member?.id ?? resolvedUser?.id ?? null;
  const mention = id ? `<@${id}>` : "Unknown member";
  const username = formatUserTag(resolvedUser);
  return `${mention} (\`${username}\`)`;
}

export function getLogger(container) {
  if (!container) return null;
  return container.getOptional?.(TOKENS.Logger) ?? null;
}

export function getStaffMemberLogService(container) {
  if (!container) return null;
  return container.getOptional?.(TOKENS.StaffMemberLogService) ?? null;
}
