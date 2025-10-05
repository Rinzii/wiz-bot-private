import test from "node:test";
import assert from "node:assert/strict";
import { decodeSnowflake, formatDiscordTimestamp, DISCORD_EPOCH_MS } from "../../../../src/shared/utils/snowflake.js";

test("decodeSnowflake converts ids into millisecond timestamps", () => {
  const ms = DISCORD_EPOCH_MS + 12345;
  const snowflake = ((BigInt(ms - DISCORD_EPOCH_MS)) << 22n).toString();
  assert.equal(decodeSnowflake(snowflake), ms);
  assert.equal(decodeSnowflake("not"), null);
  assert.equal(decodeSnowflake(-1), null);
});

test("formatDiscordTimestamp formats unix seconds with optional style", () => {
  const ms = 1_600_000_000_000;
  const seconds = Math.floor(ms / 1000);
  assert.equal(formatDiscordTimestamp(ms), `<t:${seconds}>`);
  assert.equal(formatDiscordTimestamp(ms, "F"), `<t:${seconds}:F>`);
  assert.equal(formatDiscordTimestamp(-1), null);
});
