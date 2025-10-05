import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStaffChannel } from "../src/utils/staffChannels.js";

function createGuild(channels) {
  const cache = new Map();
  for (const channel of channels) {
    cache.set(channel.id, channel);
  }

  return {
    id: "guild-id",
    channels: {
      cache,
      async fetch(id) {
        return cache.get(id) ?? null;
      }
    }
  };
}

function createChannel(id) {
  return {
    id,
    isTextBased() {
      return true;
    }
  };
}

test("uses fallback channel when channel map service is missing", async () => {
  const guild = createGuild([createChannel("123")]);
  const channel = await resolveStaffChannel(guild, null, "flag_log", "123");
  assert.ok(channel);
  assert.equal(channel.id, "123");
});

test("uses fallback resolver when channel map service is missing", async () => {
  const guild = createGuild([createChannel("456")]);
  const channel = await resolveStaffChannel(guild, undefined, "flag_log", () => "456");
  assert.ok(channel);
  assert.equal(channel.id, "456");
});

test("prefers mapped channels before falling back", async () => {
  const guild = createGuild([createChannel("789"), createChannel("000")]);
  const channelMapService = {
    async get(guildId, key) {
      assert.equal(guildId, "guild-id");
      if (key === "primary") {
        return { channelId: "789" };
      }
      return null;
    }
  };

  const channel = await resolveStaffChannel(guild, channelMapService, ["primary", "secondary"], "000");
  assert.ok(channel);
  assert.equal(channel.id, "789");
});
