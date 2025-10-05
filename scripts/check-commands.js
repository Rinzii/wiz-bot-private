import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Lightweight, local walk (no bot/plugins). */
function walkFiles(root, exts = [".js"]) {
  const out = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      const p = join(root, e.name);
      if (e.isDirectory()) out.push(...walkFiles(p, exts));
      else if (exts.some(ext => p.endsWith(ext))) out.push(p);
    }
  } catch { /* ignore missing roots */ }
  return out;
}

/** Find all command roots without importing any plugin entrypoints. */
function discoverCommandRoots() {
  const roots = [];
  const main = resolve(process.cwd(), "src", "commands");
  roots.push(main);

  // Scan modules/*/src/commands — no plugin imports
  const modulesDir = resolve(process.cwd(), "modules");
  try {
    const mods = readdirSync(modulesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => resolve(modulesDir, d.name, "src", "commands"));
    roots.push(...mods);
  } catch { /* no modules dir — fine */ }

  return roots;
}

/** Minimal meta validation (same rules used by /help). */
function validateMeta(meta) {
  const errs = [];
  if (!meta || typeof meta !== "object") { errs.push("meta is missing"); return errs; }
  if (!meta.category || typeof meta.category !== "string") errs.push("meta.category must be a string");
  if (!meta.description || typeof meta.description !== "string") errs.push("meta.description must be a string");
  if (!meta.usage || typeof meta.usage !== "string") errs.push("meta.usage must be a string");
  if (meta.examples && !Array.isArray(meta.examples)) errs.push("meta.examples must be an array of strings");
  if (meta.requireRoles && !Array.isArray(meta.requireRoles)) errs.push("meta.requireRoles must be an array of role IDs");
  if (meta.requireKeys && !Array.isArray(meta.requireKeys)) errs.push("meta.requireKeys must be an array of keys");
  return errs;
}

function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const roots = discoverCommandRoots();

  const problems = [];
  for (const root of roots) {
    const files = walkFiles(root, [".js"]);
    for (const file of files) {
      // Import the command module only (NOT any plugin index / bot entrypoints)
      let mod;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch (e) {
        problems.push({ name: "(unknown)", file, issue: `failed to import: ${e?.message || e}` });
        continue;
      }
      const def = mod?.default;
      if (!def?.data) continue; // not a slash-command module

      const name = def.data?.name || "(unknown)";

      if (!def.meta) {
        problems.push({ name, file, issue: "MISSING meta" });
        continue;
      }
      const errs = validateMeta(def.meta);
      if (errs.length) problems.push({ name, file, issue: `INVALID: ${errs.join("; ")}` });
    }
  }

  if (problems.length === 0) {
    console.log("✅ All commands with builders have valid meta (nothing missing).");
    return;
  }

  const w1 = Math.max(...problems.map(r => r.name.length), 8);
  console.log(`${pad("Command", w1)}  Issue  File`);
  console.log("-".repeat(100));
  for (const r of problems) {
    console.log(`${pad(r.name, w1)}  ${r.issue}  ${r.file}`);
  }
  process.exitCode = 1; // fail CI if any problems
}

main().catch(e => { console.error(e); process.exit(1); });
