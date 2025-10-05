export const ModerationActionType = Object.freeze({
  Ban: "ban",
  Softban: "softban",
  Kick: "kick",
  Mute: "mute",
  Warn: "warn"
});

export const DEFAULT_MOD_REASON = "No reason provided.";

export function normalizeReason(reason) {
  const text = reason?.trim?.();
  return text?.length ? text : DEFAULT_MOD_REASON;
}
