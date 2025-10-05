import test from "node:test";
import assert from "node:assert/strict";
import { formatUserTag, getAvatarUrl, safeTimestamp } from "../../../../src/shared/utils/discordUsers.js";

test("formatUserTag prefers tag then username/discriminator", () => {
  assert.equal(formatUserTag({ tag: "User#1234" }), "User#1234");
  assert.equal(formatUserTag({ username: "User", discriminator: "42" }), "User#42");
  assert.equal(formatUserTag({ username: "User", discriminator: "0" }), "User");
  assert.equal(formatUserTag({ globalName: "Global" }), "Global");
  assert.equal(formatUserTag({ id: "1" }), "1");
  assert.equal(formatUserTag(null), "Unknown");
});

test("getAvatarUrl returns null when missing or throws", () => {
  const withAvatar = {
    displayAvatarURL: ({ size }) => `url-${size}`
  };
  assert.equal(getAvatarUrl(withAvatar, { size: 128 }), "url-128");

  const throwing = {
    displayAvatarURL() {
      throw new Error("fail");
    }
  };
  assert.equal(getAvatarUrl(throwing), null);
  assert.equal(getAvatarUrl(null), null);
});

test("safeTimestamp normalizes numeric and Date values", () => {
  const now = Date.now();
  assert.equal(safeTimestamp(now), now);
  const date = new Date(now + 1000);
  assert.equal(safeTimestamp(date), date.getTime());
  assert.equal(safeTimestamp("not"), null);
  assert.equal(safeTimestamp(new Date("invalid")), null);
});
