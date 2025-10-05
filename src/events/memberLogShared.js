import { TOKENS } from "../container.js";
import { formatUserTag } from "../utils/discordUsers.js";

export function formatMemberLine(member, user) {
  const resolvedUser = user ?? member?.user ?? null;
  const id = member?.id ?? resolvedUser?.id ?? null;
  const mention = id ? `<@${id}>` : "Unknown member";
  const username = formatUserTag(resolvedUser);
  return `${mention} (\`${username}\`)`;
}

export function getLogger(container) {
  if (!container) return null;
  try { return container.get(TOKENS.Logger); } catch { return null; }
}

export function getStaffMemberLogService(container) {
  if (!container) return null;
  try { return container.get(TOKENS.StaffMemberLogService); } catch { return null; }
}
