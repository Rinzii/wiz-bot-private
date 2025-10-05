const UNIT_MS = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  mo: 2_592_000_000,
  mos: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
  y: 31_536_000_000,
  yr: 31_536_000_000,
  yrs: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000
};

const DURATION_PATTERN = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
const PERMANENT_KEYWORDS = new Set(["perma", "permanent", "perm", "forever", "infinite", "indefinite"]);
const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseDuration(input, { defaultUnit = "m" } = {}) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (PERMANENT_KEYWORDS.has(lower)) return { ms: null, human: "permanent", parts: [] };

  let match;
  let total = 0;
  const parts = [];
  DURATION_PATTERN.lastIndex = 0;
  while ((match = DURATION_PATTERN.exec(lower))) {
    const value = Number(match[1]);
    const unitRaw = match[2];
    const unit = UNIT_MS[unitRaw] ? unitRaw : normalizeUnit(unitRaw);
    const multiplier = UNIT_MS[unit];
    if (!Number.isFinite(value) || !multiplier) throw new Error(`Unknown duration unit: ${unitRaw}`);
    const ms = value * multiplier;
    total += ms;
    parts.push({ value, unit });
  }

  if (total === 0) {
    if (!/^[0-9]+$/.test(lower)) throw new Error("Invalid duration format");
    const value = Number(lower);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid duration value");
    const multiplier = UNIT_MS[defaultUnit] || UNIT_MS.m;
    total = value * multiplier;
    parts.push({ value, unit: defaultUnit });
  }

  if (total <= 0) throw new Error("Duration must be greater than zero");

  return { ms: Math.round(total), human: formatDuration(total), parts };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const units = [
    { label: "y", value: 31_536_000_000 },
    { label: "mo", value: 2_592_000_000 },
    { label: "w", value: 604_800_000 },
    { label: "d", value: 86_400_000 },
    { label: "h", value: 3_600_000 },
    { label: "m", value: 60_000 },
    { label: "s", value: 1_000 }
  ];
  const segments = [];
  let remaining = ms;
  for (const unit of units) {
    if (remaining < unit.value) continue;
    const qty = Math.floor(remaining / unit.value);
    remaining -= qty * unit.value;
    segments.push(`${qty}${unit.label}`);
  }
  if (!segments.length) return "<1s";
  return segments.join(" ");
}

export function scheduleWithMaxTimeout(callback, ms) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  let remaining = Math.max(0, ms);
  if (!Number.isFinite(remaining) || remaining === 0) {
    if (remaining === 0) callback();
    return { cancel: () => {} };
  }
  let cancelled = false;
  let handle = null;

  const schedule = () => {
    if (cancelled) return;
    const nextDelay = Math.min(remaining, MAX_TIMEOUT_MS);
    handle = setTimeout(() => {
      if (cancelled) return;
      if (remaining > MAX_TIMEOUT_MS) {
        remaining -= MAX_TIMEOUT_MS;
        schedule();
      } else {
        cancelled = true;
        callback();
      }
    }, nextDelay);
  };

  schedule();

  return {
    cancel() {
      cancelled = true;
      if (handle) {
        clearTimeout(handle);
        handle = null;
      }
    }
  };
}

function normalizeUnit(unitRaw) {
  const lower = unitRaw.toLowerCase();
  if (UNIT_MS[lower]) return lower;
  if (lower.endsWith("s") && UNIT_MS[lower.slice(0, -1)]) return lower.slice(0, -1);
  throw new Error(`Unknown duration unit: ${unitRaw}`);
}

export const MAX_TIMEOUT_DURATION = MAX_TIMEOUT_MS;
