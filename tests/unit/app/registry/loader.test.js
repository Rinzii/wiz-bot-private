import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  walkFiles,
  loadDirCommands,
  loadDirEvents,
  loadPlugins
} from "../../../../src/app/registry/loader.js";

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "loader-tests-"));
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const createModule = (relativePath, contents) => {
  const filePath = join(tempDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${contents}\n`);
  return filePath;
};

test("walkFiles recursively collects JavaScript files", async () => {
  writeFileSync(join(tempDir, "a.js"), "export default 1;\n");
  const subdir = join(tempDir, "nested");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "b.js"), "export default 2;\n");
  writeFileSync(join(subdir, "ignore.txt"), "noop\n");

  const files = await walkFiles(tempDir, [".js"]);
  assert.equal(files.length, 2);
  assert(files.some(f => f.endsWith("a.js")));
  assert(files.some(f => f.endsWith("b.js")));
});

test("loadDirCommands registers modules and warns on meta issues", async () => {
  createModule("one.js", "export default { data: { name: 'one' }, meta: { category: 'general', description: 'One', usage: '/one' } };");
  createModule("two.js", "export default { foo: 'bar' };");
  createModule("nested/three.js", "export default { data: { name: 'three' } };");
  createModule("badMeta.js", "export default { data: { name: 'bad' }, meta: { category: 1, description: 'bad', usage: '/bad' } };");

  const registry = new Map();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    await loadDirCommands(tempDir, registry);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(registry.size, 3);
  assert.ok(registry.has("one"));
  assert.ok(registry.has("three"));
  assert.ok(registry.has("bad"));
  assert.equal(warnings.length >= 2, true);
  assert.ok(warnings.some((msg) => msg.includes("missing meta")));
  assert.ok(warnings.some((msg) => msg.includes("meta.category")));
});

test("loadDirEvents binds handlers with on/once", async () => {
  createModule("ready.js", "export default { name: 'ready', once: true, execute: (...args) => globalThis.__readyCalls = args };");
  createModule("message.js", "export default { name: 'messageCreate', execute: (...args) => { globalThis.__messageCalls = (globalThis.__messageCalls || []).concat([args]); } };");

  const onceHandlers = new Map();
  const onHandlers = new Map();
  const client = {
    once(event, handler) { onceHandlers.set(event, handler); },
    on(event, handler) { onHandlers.set(event, handler); }
  };

  await loadDirEvents(tempDir, client);

  assert.equal(onceHandlers.has("ready"), true);
  assert.equal(onHandlers.has("messageCreate"), true);

  onceHandlers.get("ready")("foo");
  onHandlers.get("messageCreate")("bar");

  assert.deepEqual(globalThis.__readyCalls, ["foo"]);
  assert.deepEqual(globalThis.__messageCalls, [["bar"]]);

  delete globalThis.__readyCalls;
  delete globalThis.__messageCalls;
});

test("loadPlugins loads plugin setups and normalizes defaults", async () => {
  const pluginDirA = join(tempDir, "pluginA");
  const pluginDirB = join(tempDir, "pluginB");
  mkdirSync(pluginDirA, { recursive: true });
  mkdirSync(join(pluginDirB, "src"), { recursive: true });

  writeFileSync(join(pluginDirA, "index.js"), "export default { setup() { return { commandDirs: ['cmds'], intents: ['Guilds'] }; } };");
  writeFileSync(join(pluginDirB, "src/index.js"), "export default { setup() { return { eventDirs: ['events'], partials: ['Channel'], register() {} }; } };");
  writeFileSync(join(tempDir, "ignored.js"), "export default {};\n");

  const result = await loadPlugins([pluginDirA, pluginDirB, join(tempDir, "missing")]);
  assert.equal(result.length, 2);
  const [a, b] = result;
  assert.deepEqual(a.commandDirs, ["cmds"]);
  assert.deepEqual(a.eventDirs, []);
  assert.deepEqual(a.intents, ["Guilds"]);
  assert.deepEqual(a.partials, []);
  assert.equal(typeof b.register, "function");
  assert.deepEqual(b.commandDirs, []);
  assert.deepEqual(b.eventDirs, ["events"]);
  assert.deepEqual(b.partials, ["Channel"]);
});
