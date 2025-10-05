import { PermissionsBitField } from "discord.js";

export class ModerationService {
  canBan(member) {
    return member.permissions.has(PermissionsBitField.Flags.BanMembers);
  }
  async ban(target, reason) {
    if (!target?.bannable) throw new Error("Target not bannable (role/perms).");
    await target.ban({ reason: reason || "No reason provided." });
  }
  async bulkDelete(textChannel, amount) {
    const clamped = Math.min(Math.max(amount, 1), 100);
    const deleted = await textChannel.bulkDelete(clamped, true);
    return deleted.size;
  }
}
