import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../../src/utils/logger.js";

test("logger buffers entries, mirrors, and rate limits", async (t) => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });

  const lines = [];
  t.mock.method(console, "log", (line) => { lines.push({ level: "log", line }); });
  t.mock.method(console, "warn", (line) => { lines.push({ level: "warn", line }); });
  t.mock.method(console, "error", (line) => { lines.push({ level: "error", line }); });

  const mirrorCalls = [];
  const logger = new Logger({
    level: "info",
    rateLimit: { intervalMs: 1000, burst: 1 },
    mirrorFn: async (payload) => { mirrorCalls.push(payload); }
  });

  await logger.info("first", { value: 1 });
  assert.equal(logger.tail(1)[0].msg, "first");
  assert.equal(mirrorCalls.length, 1);

  now += 10;
  await logger.info("suppressed");
  const afterSuppressed = logger.tail(2);
  assert.equal(afterSuppressed.length, 2);
  assert.equal(afterSuppressed[afterSuppressed.length - 1].msg, "logger.rate_limit.hit");
  assert.equal(mirrorCalls.length, 1, "suppressed logs do not mirror");

  now += 2000;
  await logger.info("second");
  const tail = logger.tail(4);
  assert.equal(tail[tail.length - 2].msg, "logger.rate_limit.flush");
  assert.equal(tail[tail.length - 1].msg, "second");
  assert.equal(mirrorCalls.length, 2, "second allowed log mirrors");

  const flushWarning = lines.find((entry) => entry.level === "warn" && entry.line.includes("logger.rate_limit.flush"));
  assert.ok(flushWarning, "rate limit flush warning emitted");
});

test("logger setLevel ignores unknown levels", () => {
  const logger = new Logger({ rateLimit: null });
  logger.setLevel("debug");
  assert.equal(logger.level, "debug");
  logger.setLevel("nope");
  assert.equal(logger.level, "debug");
});
