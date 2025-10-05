import { MessageFlags } from "discord.js";

// Reusable flag
export const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// Convenience helpers (they all swallow errors so your bot doesn't crash on double replies)
export async function replyEph(interaction, options) {
  try {
    const payload = typeof options === "string" ? { content: options, ...EPHEMERAL } : { ...options, ...EPHEMERAL };
    return await interaction.reply(payload);
  } catch {}
}

export async function followUpEph(interaction, options) {
  try {
    const payload = typeof options === "string" ? { content: options, ...EPHEMERAL } : { ...options, ...EPHEMERAL };
    return await interaction.followUp(payload);
  } catch {}
}

export async function deferEph(interaction) {
  try {
    return await interaction.deferReply(EPHEMERAL);
  } catch {}
}
