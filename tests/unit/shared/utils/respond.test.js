import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EPHEMERAL,
  replyEph,
  followUpEph,
  deferEph
} from "../../../../src/shared/utils/respond.js";

const createInteraction = () => {
  const calls = { reply: [], followUp: [], defer: [] };
  return {
    calls,
    async reply(payload) {
      calls.reply.push(payload);
      return payload;
    },
    async followUp(payload) {
      calls.followUp.push(payload);
      return payload;
    },
    async deferReply(payload) {
      calls.defer.push(payload);
      return payload;
    }
  };
};

test("replyEph wraps strings and objects with ephemeral flag", async () => {
  const interaction = createInteraction();
  await replyEph(interaction, "hello");
  await replyEph(interaction, { content: "world", embeds: [] });

  assert.equal(interaction.calls.reply.length, 2);
  assert.deepEqual(interaction.calls.reply[0], { content: "hello", flags: EPHEMERAL.flags });
  assert.equal(interaction.calls.reply[1].content, "world");
  assert.equal(interaction.calls.reply[1].flags, EPHEMERAL.flags);
  assert.deepEqual(interaction.calls.reply[1].embeds, []);
});

test("followUpEph and deferEph forward ephemeral payloads", async () => {
  const interaction = createInteraction();
  await followUpEph(interaction, "later");
  await deferEph(interaction);

  assert.equal(interaction.calls.followUp.length, 1);
  assert.deepEqual(interaction.calls.followUp[0], { content: "later", flags: EPHEMERAL.flags });
  assert.equal(interaction.calls.defer.length, 1);
  assert.deepEqual(interaction.calls.defer[0], EPHEMERAL);
});

test("ephemeral helpers swallow interaction errors", async () => {
  const interaction = {
    async reply() { throw new Error("fail reply"); },
    async followUp() { throw new Error("fail follow"); },
    async deferReply() { throw new Error("fail defer"); }
  };

  await replyEph(interaction, "oops");
  await followUpEph(interaction, "oops");
  await deferEph(interaction);
});
