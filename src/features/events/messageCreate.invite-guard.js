import { enforceInvitePolicy } from "./lib/inviteGuard.js";

export default {
  name: "messageCreate",
  once: false,
  async execute(message) {
    await enforceInvitePolicy(message, "messageCreate");
  }
};
