import { CONFIG } from "../config.js";

const FALLBACKS = {
  join: 0x57F287,
  leave: 0xED4245,
  neutral: 0x5865F2
};

export function getMemberLogColors() {
  const cfg = CONFIG.colors || {};
  return {
    join: cfg.green ?? FALLBACKS.join,
    leave: cfg.red ?? FALLBACKS.leave,
    neutral: cfg.neutral ?? cfg.default ?? FALLBACKS.neutral
  };
}
