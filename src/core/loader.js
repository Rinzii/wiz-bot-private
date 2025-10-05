import { readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { validateMeta, logMetaWarning } from "./commandMeta.js";

/** Recursively list files by extension. */
export async function walkFiles(root, exts = [".js"]) {
  const out = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(p, exts));
    else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

/** Load command modules from a directory into a Map(name -> module). */
export async function loadDirCommands(root, registryMap) {
  try {
    const files = await walkFiles(root, [".js"]);
    for (const file of files) {
      const mod = await import(`file://${resolve(file)}`).catch(() => null);
      const def = mod?.default;
      if (!def?.data) continue;

      // Validate META (warn only). /help will ignore commands without meta.
      if (!def.meta) {
        console.warn(`[meta] ${file} — missing meta (command will be hidden from /help)`);
      } else {
        const errs = validateMeta(def.meta, file);
        if (errs.length) logMetaWarning(file, errs);
      }

      registryMap.set(def.data.name, def);
    }
  } catch (e) {
    console.error("Command load error:", e);
    throw e;
  }
}

/** Load event modules from a directory and bind them to the client. */
export async function loadDirEvents(root, client) {
  const files = await walkFiles(root, [".js"]);
  for (const file of files) {
    const mod = await import(`file://${resolve(file)}`).catch(() => null);
    const def = mod?.default;
    if (!def?.name || typeof def.execute !== "function") continue;
    if (def.once) client.once(def.name, (...args) => def.execute(...args));
    else client.on(def.name, (...args) => def.execute(...args));
  }
}

/**
 * Load plugins from directories.
 * Each plugin should export default { meta, setup() { return { commandDirs, eventDirs, intents, partials, register(container) } } }
 */
export async function loadPlugins(pluginDirs = []) {
  const regs = [];
  for (const dir of pluginDirs) {
    // Try <dir>/src/index.js then <dir>/index.js
    const tryFiles = [resolve(dir, "src/index.js"), resolve(dir, "index.js"), dir];
    let mod = null;
    for (const f of tryFiles) {
      try { mod = await import(`file://${f}`); } catch { mod = null; }
      if (mod) break;
    }
    const entry = mod?.default;
    if (!entry?.setup) continue;

    const reg = await entry.setup();
    // normalize
    reg.commandDirs = reg.commandDirs || [];
    reg.eventDirs = reg.eventDirs || [];
    reg.intents = reg.intents || [];
    reg.partials = reg.partials || [];
    regs.push(reg);
  }
  return regs;
}
