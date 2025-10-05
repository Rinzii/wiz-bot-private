import { PermissionsBitField } from "discord.js";
import { TOKENS } from "../container.js";

/** Extract the default member permissions bitfield from a command builder (if any). */
export function getDefaultPermBits(cmd) {
  try {
    const raw =
      cmd?.data?.default_member_permissions ??
      (typeof cmd?.data?.toJSON === "function"
        ? cmd.data.toJSON()?.default_member_permissions
        : undefined);
    if (raw === undefined || raw === null) return null; // no restriction
    const bits = typeof raw === "string" ? BigInt(raw) : BigInt(raw);
    return new PermissionsBitField(bits);
  } catch {
    return null;
  }
}

/** True if the member satisfies the command's default_member_permissions. */
export function hasDefaultPerms(member, cmd) {
  const required = getDefaultPermBits(cmd);
  if (!required) return true; // no default perms => available to everyone
  return member.permissions.has(required, true);
}

/**
 * Optional app-level checks controlled by command meta:
 * - meta.requireRoles: array of Discord role IDs (member must have at least one)
 * - meta.requireKeys:  array of StaffRole keys (e.g., ["admin","mod"]); member must have a role mapped to any key
 */
export async function hasAppLevelPerms(interaction, cmd) {
  const meta = cmd.meta || {};
  const member = interaction.member;

  // Explicit role IDs
  if (Array.isArray(meta.requireRoles) && meta.requireRoles.length) {
    const ok = meta.requireRoles.some((rid) => member.roles.cache.has(rid));
    if (!ok) return false;
  }

  // StaffRole keys via DB mapping
  if (Array.isArray(meta.requireKeys) && meta.requireKeys.length) {
    const srs = interaction.client.container.get(TOKENS.StaffRoleService);
    const roleIds = await srs.getAllRoleIdsForKeys(interaction.guildId, meta.requireKeys);
    const ok = roleIds.some((rid) => member.roles.cache.has(rid));
    if (!ok) return false;
  }

  return true;
}
