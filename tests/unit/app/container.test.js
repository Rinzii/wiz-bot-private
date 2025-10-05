import { test } from "node:test";
import assert from "node:assert/strict";
import { Container } from "../../../src/app/container/index.js";

test("set stores values retrievable with get", () => {
  const container = new Container();
  const instance = { id: 123 };
  container.set("example", instance);
  assert.equal(container.get("example"), instance);
});

test("get throws for unknown tokens", () => {
  const container = new Container();
  assert.throws(() => container.get("missing"), /Container missing: missing/);
});

test("getOptional returns null when binding is missing", () => {
  const container = new Container();
  assert.equal(container.getOptional("missing"), null);
});

test("getOptional returns stored value", () => {
  const container = new Container();
  const instance = { id: 456 };
  container.set("another", instance);
  assert.equal(container.getOptional("another"), instance);
});
