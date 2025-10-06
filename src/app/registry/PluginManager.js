import { resolve } from "node:path";
import { loadDirCommands, loadDirEvents, loadPlugins } from "./loader.js";

const toArray = (value) => (Array.isArray(value) ? value : []);

const normalizeDirectory = (value) => {
  if (!value) return null;
  try {
    return resolve(value);
  } catch {
    return null;
  }
};

export class PluginManager {
  #pluginDirs;
  #loadPlugins;
  #loadCommands;
  #loadEvents;
  #registrations;

  constructor({
    pluginDirs = [],
    loadPluginsFn = loadPlugins,
    loadCommandsFn = loadDirCommands,
    loadEventsFn = loadDirEvents
  } = {}) {
    this.#pluginDirs = [...pluginDirs];
    this.#loadPlugins = loadPluginsFn;
    this.#loadCommands = loadCommandsFn;
    this.#loadEvents = loadEventsFn;
    this.#registrations = [];
  }

  get registrations() {
    return [...this.#registrations];
  }

  async load() {
    this.#registrations = await this.#loadPlugins(this.#pluginDirs);
    return this.registrations;
  }

  async registerAll(container, context) {
    for (const registration of this.#registrations) {
      if (typeof registration?.register === "function") {
        await registration.register(container, context);
      }
    }
  }

  #collectSetFromRegistrations(key, base = []) {
    const values = new Set(base);
    for (const registration of this.#registrations) {
      for (const item of toArray(registration?.[key])) {
        values.add(item);
      }
    }
    return values;
  }

  #collectDirectoriesFromRegistrations(key, baseDirs = []) {
    const directories = new Set();
    for (const dir of baseDirs) {
      const normalized = normalizeDirectory(dir);
      if (normalized) directories.add(normalized);
    }
    for (const registration of this.#registrations) {
      for (const dir of toArray(registration?.[key])) {
        const normalized = normalizeDirectory(dir);
        if (normalized) directories.add(normalized);
      }
    }
    return directories;
  }

  collectIntents(base = []) {
    return this.#collectSetFromRegistrations("intents", base);
  }

  collectPartials(base = []) {
    return this.#collectSetFromRegistrations("partials", base);
  }

  collectCommandDirs(base = []) {
    return this.#collectDirectoriesFromRegistrations("commandDirs", base);
  }

  collectEventDirs(base = []) {
    return this.#collectDirectoriesFromRegistrations("eventDirs", base);
  }

  async loadCommands({ registry, coreDirs = [] }) {
    if (!registry) throw new Error("registry map is required to load commands");
    const directories = this.collectCommandDirs(coreDirs);
    for (const dir of directories) {
      await this.#loadCommands(dir, registry);
    }
  }

  async loadEvents({ client, coreDirs = [] }) {
    if (!client) throw new Error("client is required to load events");
    const directories = this.collectEventDirs(coreDirs);
    for (const dir of directories) {
      await this.#loadEvents(dir, client);
    }
  }
}
