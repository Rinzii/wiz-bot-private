import test from "node:test";
import assert from "node:assert/strict";
import {
  DisplayNamePolicyService,
  isValidName,
  normalizeName,
  hasShouting
} from "../DisplayNamePolicyService.js";

const createLogger = () => {
  const entries = { info: [], error: [] };
  return {
    info(event, payload) { entries.info.push({ event, payload }); },
    error(event, payload) { entries.error.push({ event, payload }); },
    entries
  };
};

const createMember = ({
  id = "1",
  displayName = "",
  nickname = null,
  manageable = true,
  user = { username: "User", globalName: null },
  guildId = "guild1"
} = {}) => {
  const member = {
    id,
    nickname,
    displayName,
    manageable,
    guild: { id: guildId },
    user,
    setNickname: (newNick) => {
      member.nickname = newNick;
      member.displayName = newNick;
      return Promise.resolve(member);
    }
  };
  return member;
};

test("emoji-only names are normalized via transliteration", async () => {
  assert.equal(isValidName("😀😀"), false);
  const transliteration = normalizeName("😀😀", "😀😀");
  assert.equal(transliteration, ":grinning::grinning:");
  assert.ok(transliteration.length <= 32);

  const logger = createLogger();
  const service = new DisplayNamePolicyService({ logger });
  const member = createMember({ displayName: "😀😀", nickname: "😀😀", user: { username: "Readable" } });

  await service.handleMemberJoin(member);
  assert.equal(member.nickname, ":grinning::grinning:");
  assert.equal(member.displayName, ":grinning::grinning:");
});

test("names starting with ASCII are allowed", () => {
  assert.equal(isValidName("A🌀"), true);
});

test("names with three consecutive printable ASCII are allowed", () => {
  assert.equal(isValidName("😀abc😀"), true);
});

test("normalizeName falls back to User when transliteration is empty", () => {
  assert.equal(normalizeName("   ", "   "), "User");
});

test("invalid names without printable ASCII are replaced", async () => {
  const logger = createLogger();
  const service = new DisplayNamePolicyService({ logger });
  const member = createMember({ displayName: "ååå", nickname: "ååå", user: { username: "Valid" } });

  await service.handleMemberJoin(member);
  assert.equal(member.nickname, "aaa");
});

test("shouting names are lowercased", async () => {
  assert.equal(hasShouting("AAAA"), true);
  const logger = createLogger();
  const service = new DisplayNamePolicyService({ logger });
  const member = createMember({ displayName: "AAAAA", nickname: "AAAAA", user: { username: "aaaaa" } });

  await service.handleMemberJoin(member);
  assert.equal(member.nickname, "aaaaa");
});

test("hourly sweep applies policies to all members", async () => {
  const logger = createLogger();
  const service = new DisplayNamePolicyService({ logger });

  const members = [
    createMember({ id: "1", displayName: "😀😀", nickname: "😀😀", user: { username: "User1" } }),
    createMember({ id: "2", displayName: "BBBB", nickname: "BBBB", user: { username: "BBBB" } })
  ];

  const guild = {
    id: "guild1",
    members: {
      fetch: async () => new Map(members.map((m) => [m.id, m]))
    }
  };

  const client = {
    guilds: {
      cache: new Map([[guild.id, guild]])
    }
  };

  await service.runFullSweep(client);

  assert.equal(members[0].nickname, ":grinning::grinning:");
  assert.equal(members[1].nickname, "bbbb");
  assert.equal(logger.entries.error.length, 0);
});
