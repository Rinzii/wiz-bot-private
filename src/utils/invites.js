const INVITE_PATTERN = "(?:https?:\\/\\/)?(?:www\\.)?(?:discord\\.gg|discord(?:app)?\\.com\\/invite|discord\\.me\\/invite|disboard\\.org\\/server\\/join|\\.gg)\\/([A-Za-z0-9-]+)";

function buildRegex(flags = "gi") {
  return new RegExp(`(?:^|[^A-Za-z0-9])(${INVITE_PATTERN})`, flags);
}

export function findInviteMatches(text) {
  if (!text) return [];
  const regex = buildRegex();
  const results = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1];
    const code = match[2] || match[1]?.split("/").pop();
    if (!code) continue;
    const lower = code.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    results.push({
      code,
      invite: raw,
      index: match.index + (match[0].length - raw.length)
    });
  }
  return results;
}

export function extractInviteCode(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (!text) return null;
  const cleaned = text.replace(/^<|>$/g, "");
  const directMatches = findInviteMatches(cleaned);
  if (directMatches.length) return directMatches[0].code;
  const fallback = cleaned.split(/[\s?#]/)[0];
  return fallback.replace(/^[^A-Za-z0-9-]+/, "").replace(/[^A-Za-z0-9-]+$/, "");
}

export const INVITE_REGEX = buildRegex();
