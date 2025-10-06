import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PluginManager } from "../PluginManager.js";

test("PluginManager loads plugins, registers them, and aggregates resources", async () => {
  const pluginRegistration = {
    intents: ["extra-intent"],
    partials: ["extra-partial"],
    commandDirs: ["./custom/commands"],
    eventDirs: ["./custom/events"],
    async register(container, context) {
      container.calls.push({ context });
    }
  };

  const receivedPluginDirs = [];
  const loadedCommandDirs = [];
  const loadedEventDirs = [];

  const manager = new PluginManager({
    pluginDirs: ["./plugins/a", "./plugins/b"],
    loadPluginsFn: async (dirs) => {
      receivedPluginDirs.push([...dirs]);
      return [pluginRegistration];
    },
    loadCommandsFn: async (dir, registry) => {
      registry.loaded.push(dir);
      loadedCommandDirs.push(dir);
    },
    loadEventsFn: async (dir, client) => {
      client.loaded.push(dir);
      loadedEventDirs.push(dir);
    }
  });

  const registryMap = { loaded: [] };
  const fakeClient = { loaded: [] };
  const container = { calls: [] };
  const context = { value: 42 };

  await manager.load();
  assert.deepEqual(receivedPluginDirs, [["./plugins/a", "./plugins/b"]]);

  await manager.registerAll(container, context);
  assert.equal(container.calls.length, 1);
  assert.equal(container.calls[0].context, context);

  const intents = manager.collectIntents(["base-intent"]);
  assert.equal(intents.has("base-intent"), true);
  assert.equal(intents.has("extra-intent"), true);

  const partials = manager.collectPartials(["base-partial"]);
  assert.equal(partials.has("base-partial"), true);
  assert.equal(partials.has("extra-partial"), true);

  const commandDirs = manager.collectCommandDirs(["/core/commands", "/core/commands"]);
  assert.deepEqual(
    commandDirs,
    new Set(["/core/commands", resolve("./custom/commands")])
  );

  const eventDirs = manager.collectEventDirs(["/core/events"]);
  assert.deepEqual(eventDirs, new Set(["/core/events", resolve("./custom/events")]));

  await manager.loadCommands({
    registry: registryMap,
    coreDirs: ["/core/commands", "/core/commands"]
  });
  await manager.loadEvents({
    client: fakeClient,
    coreDirs: ["/core/events"]
  });

  assert.deepEqual(
    new Set(loadedCommandDirs),
    new Set(["/core/commands", resolve("./custom/commands")])
  );
  assert.deepEqual(
    new Set(loadedEventDirs),
    new Set(["/core/events", resolve("./custom/events")])
  );
});

test("PluginManager throws when registry or client dependencies are missing", async () => {
  const manager = new PluginManager({ loadPluginsFn: async () => [] });
  await manager.load();

  await assert.rejects(async () => {
    await manager.loadCommands({ registry: null });
  }, /registry map is required/);

  await assert.rejects(async () => {
    await manager.loadEvents({ client: null });
  }, /client is required/);
});
