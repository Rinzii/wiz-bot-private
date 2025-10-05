import { PRIVATE_TOKENS } from "../services/tokens.js";

export default {
  name: "guildMemberAdd",
  once: false,
  async execute(member) {
    try {
      const svc = member.client.container.get(PRIVATE_TOKENS.AntiRaidService);
      await svc.recordJoin(member.guild);
    } catch {}
  }
};
