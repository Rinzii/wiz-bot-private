import test from "node:test";
import assert from "node:assert/strict";

import { createMemberEmbedBase } from "../../src/utils/memberLogEmbeds.js";

test("createMemberEmbedBase populates author, footer, and thumbnail", () => {
  const member = {
    id: "123",
    user: {
      id: "123",
      tag: "Member#123",
      displayAvatarURL: () => "https://cdn.example/avatar.png"
    }
  };

  const { embed, user } = createMemberEmbedBase({
    member,
    title: "Joined",
    color: 0xabcdef
  });

  const data = embed.data;
  assert.equal(data.title, "Joined");
  assert.equal(data.color, 0xabcdef);
  assert.ok(data.timestamp);
  assert.equal(data.footer.text, "ID: 123");
  assert.equal(data.author.name, "Member#123");
  assert.equal(data.author.icon_url, "https://cdn.example/avatar.png");
  assert.equal(data.thumbnail.url, "https://cdn.example/avatar.png");
  assert.equal(user, member.user);
});
