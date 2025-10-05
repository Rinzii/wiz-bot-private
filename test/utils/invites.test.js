import test from "node:test";
import assert from "node:assert/strict";
import { findInviteMatches, extractInviteCode, INVITE_REGEX } from "../../src/utils/invites.js";

test("findInviteMatches extracts unique invite codes and positions", () => {
  const text = "Join https://discord.gg/Example and discord.com/invite/example";
  const matches = findInviteMatches(text);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].code.toLowerCase(), "example");
  assert.ok(matches[0].index >= 0);
});

test("extractInviteCode handles direct codes and URLs", () => {
  assert.equal(extractInviteCode("example"), "example");
  assert.equal(extractInviteCode("https://discord.gg/Example"), "Example");
  assert.equal(extractInviteCode("<discord.gg/test>").toLowerCase(), "test");
  assert.equal(extractInviteCode(null), null);
});

test("INVITE_REGEX matches various domains", () => {
  const text = "discordapp.com/invite/Code";
  const match = INVITE_REGEX.exec(text);
  assert.ok(match);
  assert.equal(match[1], text);
});
