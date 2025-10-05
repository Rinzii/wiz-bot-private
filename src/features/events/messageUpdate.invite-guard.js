import { enforceInvitePolicy } from "./lib/inviteGuard.js";

export default {
  name: "messageUpdate",
  once: false,
  async execute(oldMessage, newMessage) {
    const target = newMessage ?? oldMessage;
    if (!target) return;
    await enforceInvitePolicy(target, "messageUpdate");
  }
};
