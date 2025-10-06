import chalk from "chalk";

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

export function logMetaWarning(file, errs) {
  const head = chalk.yellow(`[meta] ${file} — ${errs.length} issue(s):`);
  const bullets = errs.map(e => chalk.dim(`  • ${e}`)).join("\n");
  console.warn(`${head}\n${bullets}`);
}

export const STANDARD_CATEGORIES = ["general", "admin", "moderation", "security", "debug"];
