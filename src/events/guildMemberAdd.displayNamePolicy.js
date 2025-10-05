import { TOKENS } from "../container.js";

export default {
  name: "guildMemberAdd",
  async execute(member) {
    try {
      const service = member.client?.container?.get(TOKENS.DisplayNamePolicyService);
      await service?.handleMemberJoin?.(member);
    } catch (err) {
      member?.client?.container?.get(TOKENS.Logger)?.error?.("display_name_policy.member_add_failed", {
        guildId: member.guild?.id,
        userId: member.id,
        error: String(err?.message || err)
      });
    }
  }
};
