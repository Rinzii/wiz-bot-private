import { TOKENS } from "../container.js";

export default {
  name: "guildMemberUpdate",
  async execute(oldMember, newMember) {
    try {
      const service = newMember?.client?.container?.get(TOKENS.DisplayNamePolicyService);
      await service?.handleMemberUpdate?.(newMember, oldMember);
    } catch (err) {
      newMember?.client?.container?.get(TOKENS.Logger)?.error?.("display_name_policy.member_update_failed", {
        guildId: newMember?.guild?.id,
        userId: newMember?.id,
        error: String(err?.message || err)
      });
    }
  }
};
