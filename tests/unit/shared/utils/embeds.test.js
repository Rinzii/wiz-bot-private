import test from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder } from "discord.js";
import {
  baseEmbed,
  infoEmbed,
  successEmbed,
  errorEmbed,
  listEmbed
} from "../../../../src/shared/utils/embeds.js";

const getData = (embed) => embed.data;

test("baseEmbed returns a new EmbedBuilder", () => {
  const embed = baseEmbed();
  assert.ok(embed instanceof EmbedBuilder);
  assert.notStrictEqual(baseEmbed(), embed);
});

test("info, success, and error embeds set title and description", () => {
  const info = getData(infoEmbed("Info", "Details"));
  const success = getData(successEmbed("Success", "Done"));
  const error = getData(errorEmbed("Error", "Failure"));

  assert.equal(info.title, "Info");
  assert.equal(info.description, "Details");

  assert.equal(success.title, "Success");
  assert.equal(success.description, "Done");

  assert.equal(error.title, "Error");
  assert.equal(error.description, "Failure");
});

test("listEmbed joins items and uses fallback when empty", () => {
  const joined = getData(listEmbed("List", ["a", "b"]));
  const fallback = getData(listEmbed("Empty", [], "None"));

  assert.equal(joined.description, "a\nb");
  assert.equal(fallback.description, "None");
});
