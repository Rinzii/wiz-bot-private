import chalk from "chalk";

// Schema + helpers for command metadata used by /help and permission gating

/**
 * @typedef {Object} CommandMeta
 * @property {string} category   - e.g. "general","admin","moderation","security","debug"
 * @property {string} description
 * @property {string} usage
 * @property {string[]} [examples]
 * @property {string}  [permissions]  - human label for help (Discord perms text)
 * @property {string[]} [requireRoles] - explicit Discord role IDs (any of these)
 * @property {string[]} [requireKeys]  - StaffRole keys (e.g., ["admin","mod"]) (any of these)
 */

/** Basic validation so you get helpful loader warnings. */
export function validateMeta(meta, _filePath = "") {
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

/** Pretty loader warning. */
export function logMetaWarning(file, errs) {
  const head = chalk.yellow(`[meta] ${file} — ${errs.length} issue(s):`);
  const bullets = errs.map(e => chalk.dim(`  • ${e}`)).join("\n");
  console.warn(`${head}\n${bullets}`);
}

/** Optional list if you want to standardize categories. */
export const STANDARD_CATEGORIES = ["general", "admin", "moderation", "security", "debug"];
