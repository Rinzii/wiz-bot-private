import asyncLib from "async";
import chalk from "chalk";
import { readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { validateMeta, logMetaWarning } from "./commandMeta.js";

function parseConcurrency(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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

export async function loadDirCommands(root, registryMap) {
  try {
    const files = await walkFiles(root, [".js"]);
    const concurrency = parseConcurrency(process.env.COMMAND_IMPORT_CONCURRENCY, 4);
    await asyncLib.eachLimit(files, concurrency, async (file) => {
      const mod = await import(`file://${resolve(file)}`).catch(() => null);
      const def = mod?.default;
      if (!def?.data) return;

      if (!def.meta) {
        console.warn(chalk.yellow(`[meta] ${file} — missing meta (command will be hidden from /help)`));
      } else {
        const errs = validateMeta(def.meta, file);
        if (errs.length) logMetaWarning(file, errs);
      }

      registryMap.set(def.data.name, def);
    });
  } catch (e) {
    console.error(chalk.red("Command load error:"), e);
    throw e;
  }
}

export async function loadDirEvents(root, client) {
  const files = await walkFiles(root, [".js"]);
  const concurrency = parseConcurrency(process.env.EVENT_IMPORT_CONCURRENCY, 4);
  await asyncLib.eachLimit(files, concurrency, async (file) => {
    const mod = await import(`file://${resolve(file)}`).catch(() => null);
    const def = mod?.default;
    if (!def?.name || typeof def.execute !== "function") return;
    if (def.once) client.once(def.name, (...args) => def.execute(...args));
    else client.on(def.name, (...args) => def.execute(...args));
  });
}

export async function loadPlugins(pluginDirs = []) {
  const concurrency = parseConcurrency(process.env.PLUGIN_IMPORT_CONCURRENCY, 2);
  const loader = async (dir) => {
    // Try <dir>/src/index.js then <dir>/index.js
    const tryFiles = [resolve(dir, "src/index.js"), resolve(dir, "index.js"), dir];
    let mod = null;
    for (const f of tryFiles) {
      try {
        mod = await import(`file://${f}`);
      } catch (err) {
        mod = null;
        if (err?.code && ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(err.code)) continue;
        console.warn(chalk.gray(`Skipping candidate ${f}: ${err?.message || err}`));
      }
      if (mod) break;
    }
    const entry = mod?.default;
    if (!entry?.setup) return null;

    const reg = await entry.setup();
    if (!reg) return null;

    // normalize
    reg.commandDirs = reg.commandDirs || [];
    reg.eventDirs = reg.eventDirs || [];
    reg.intents = reg.intents || [];
    reg.partials = reg.partials || [];
    if (typeof reg.register === "function") {
      const originalRegister = reg.register;
      reg.register = async (container, context) => {
        if (originalRegister.length >= 2) {
          return originalRegister(container, context);
        }
        return originalRegister(container);
      };
    }
    return reg;
  };

  const results = await asyncLib.mapLimit(pluginDirs, concurrency, loader);
  return results.filter(Boolean);
}
