import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDuration,
  formatDuration,
  scheduleWithMaxTimeout,
  MAX_TIMEOUT_DURATION
} from "../../src/utils/time.js";

const waitForMicrotasks = () => new Promise(resolve => setImmediate(resolve));

test("parseDuration parses multi-unit inputs", () => {
  const result = parseDuration("1h 30m");
  assert.equal(result.ms, 5_400_000);
  assert.deepEqual(result.parts, [
    { value: 1, unit: "h" },
    { value: 30, unit: "m" }
  ]);
  assert.equal(result.human, "1h 30m");
});

test("parseDuration handles numeric strings with default unit", () => {
  const result = parseDuration("15", { defaultUnit: "m" });
  assert.equal(result.ms, 900_000);
  assert.deepEqual(result.parts, [{ value: 15, unit: "m" }]);
});

test("parseDuration returns permanent marker", () => {
  const result = parseDuration("permanent");
  assert.equal(result.ms, null);
  assert.equal(result.human, "permanent");
  assert.deepEqual(result.parts, []);
});

test("parseDuration rejects unknown units", () => {
  assert.throws(() => parseDuration("5 lightyears"), /Unknown duration unit/i);
});

test("formatDuration compresses durations", () => {
  assert.equal(formatDuration(3_660_000), "1h 1m");
  assert.equal(formatDuration(999), "<1s");
});

test("scheduleWithMaxTimeout executes callback for zero delay", async () => {
  let called = false;
  scheduleWithMaxTimeout(() => { called = true; }, 0);
  await waitForMicrotasks();
  assert.equal(called, true);
});

test("scheduleWithMaxTimeout respects cancellation", async () => {
  let called = false;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  try {
    const handles = new Map();
    let nextHandle = 1;
    globalThis.setTimeout = (fn, delay) => {
      const handle = nextHandle++;
      handles.set(handle, fn);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      handles.delete(handle);
    };

    const timer = scheduleWithMaxTimeout(() => { called = true; }, 10_000);
    timer.cancel();

    // simulate passage of time
    for (const fn of handles.values()) {
      fn();
    }
    await waitForMicrotasks();
    assert.equal(called, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("scheduleWithMaxTimeout splits long durations", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays = [];
  try {
    const handles = new Map();
    let nextHandle = 1;
    globalThis.setTimeout = (fn, delay) => {
      const handle = nextHandle++;
      delays.push(delay);
      handles.set(handle, fn);
      queueMicrotask(() => {
        if (handles.has(handle)) {
          handles.delete(handle);
          fn();
        }
      });
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      handles.delete(handle);
    };

    let callCount = 0;
    scheduleWithMaxTimeout(() => { callCount += 1; }, MAX_TIMEOUT_DURATION + 1234);
    await waitForMicrotasks();
    await waitForMicrotasks();
    assert.equal(callCount, 1);
    assert.ok(delays[0] <= MAX_TIMEOUT_DURATION);
    assert.ok(delays.length >= 2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
