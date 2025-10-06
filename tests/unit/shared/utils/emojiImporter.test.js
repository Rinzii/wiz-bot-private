import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCustomEmojis,
  getEmojiCdnUrl,
  sanitizeEmojiName,
  isValidEmojiName,
  ensureUniqueEmojiName,
  fetchExistingEmojiNames,
  ensureBotEmojiPermissions,
  fetchEmojiAttachment,
  createEmojiFromCdn,
  createEmojiFromUrl
} from "../../../../src/shared/utils/emojiImporter.js";
import dns from "node:dns/promises";
import { PermissionFlagsBits } from "discord.js";

function mockDnsLookup(t) {
  const originalLookup = dns.lookup;
  dns.lookup = async () => [
    { address: "203.0.113.1", family: 4 }
  ];
  t.after(() => {
    dns.lookup = originalLookup;
  });
}

test("extractCustomEmojis parses animated flag and identifiers", () => {
  const results = extractCustomEmojis("hello <a:test:123456789012345678> and <:static:876543210987654321>");
  assert.deepEqual(results, [
    { animated: true, originalName: "test", id: "123456789012345678" },
    { animated: false, originalName: "static", id: "876543210987654321" }
  ]);
  assert.equal(getEmojiCdnUrl(results[0]), "https://cdn.discordapp.com/emojis/123456789012345678.gif");
});

test("sanitize and ensureUniqueEmojiName enforce Discord constraints", () => {
  const used = new Set(["taken"]);
  assert.equal(sanitizeEmojiName("!"), "__");
  assert.equal(isValidEmojiName("valid_name"), true);
  const unique = ensureUniqueEmojiName("taken", used);
  assert.ok(unique.startsWith("taken"));
  assert.ok(used.has(unique));
});

test("fetchExistingEmojiNames collects names from guild cache", async () => {
  const guild = {
    emojis: {
      async fetch() {
        return new Map([
          ["1", { name: "one" }],
          ["2", { name: null }],
          ["3", { name: "two" }]
        ]);
      }
    }
  };
  const names = await fetchExistingEmojiNames(guild);
  assert.deepEqual([...names.values()].sort(), ["one", "two"]);
});

test("ensureBotEmojiPermissions throws when Manage Guild Expressions missing", async () => {
  const interaction = { guild: { members: { me: { permissions: { has: () => false } } } } };
  await assert.rejects(() => ensureBotEmojiPermissions(interaction));

  const okInteraction = { guild: { members: { me: { permissions: { has: (bit) => bit === PermissionFlagsBits.ManageGuildExpressions } } } } };
  await assert.doesNotReject(() => ensureBotEmojiPermissions(okInteraction));
});

test("fetchEmojiAttachment validates responses", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  mockDnsLookup(t);

  const data = Buffer.from([1, 2, 3]);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name === "content-type" ? "image/png" : null) },
    async arrayBuffer() { return data; }
  });

  const { buffer, extension } = await fetchEmojiAttachment("https://example.com/emoji.png");
  assert.equal(buffer.length, 3);
  assert.equal(extension, "png");

  global.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => fetchEmojiAttachment("https://bad"));

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/plain" },
    async arrayBuffer() { return new Uint8Array([1]).buffer; }
  });
  await assert.rejects(() => fetchEmojiAttachment("https://badtype"));
});

test("createEmojiFromCdn downloads emoji and creates guild emoji", async (t) => {
  const used = new Set();
  const guild = {
    emojis: {
      create: t.mock.fn(async ({ attachment, name }) => ({ attachment, name }))
    }
  };

  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  mockDnsLookup(t);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/gif" },
    async arrayBuffer() { return new Uint8Array([1]).buffer; }
  });

  const name = await createEmojiFromCdn(guild, { id: "1", animated: true, originalName: "emoji" }, used, "reason");
  assert.equal(name, "emoji");
  assert.equal(used.has("emoji"), true);
  assert.equal(guild.emojis.create.mock.calls.length, 1);
  const call = guild.emojis.create.mock.calls[0].arguments[0];
  assert.equal(call.name, "emoji");
  assert.equal(call.attachment.name, "emoji.gif");
});

test("createEmojiFromUrl uses provided name and extension", async (t) => {
  const used = new Set();
  const guild = {
    emojis: {
      create: t.mock.fn(async ({ name }) => ({ name }))
    }
  };

  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  mockDnsLookup(t);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    async arrayBuffer() { return new Uint8Array([2]).buffer; }
  });

  const name = await createEmojiFromUrl(guild, "custom", "https://example.com/image.png", used, "reason");
  assert.equal(name, "custom");
  assert.equal(guild.emojis.create.mock.calls.length, 1);
  const call = guild.emojis.create.mock.calls[0].arguments[0];
  assert.equal(call.name, "custom");
  assert.equal(call.attachment.name, "custom.png");
});
