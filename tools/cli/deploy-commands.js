import asyncLib from "async";
import chalk from "chalk";
import { REST, Routes } from "discord.js";
import { join, resolve } from "node:path";
import { CONFIG } from "../../src/config/index.js";
import { loadPlugins, walkFiles } from "../../src/app/registry/loader.js";

async function collectAllCommands() {
  const roots = [join(process.cwd(), "src", "features", "commands")];
  const regs = await loadPlugins((CONFIG.privateModuleDirs || []).map(p => resolve(process.cwd(), p)));
  for (const r of regs) for (const d of (r.commandDirs || [])) roots.push(resolve(d));

  const commands = [];
  const filesTried = [];
  const concurrency = (() => {
    const parsed = Number.parseInt(process.env.COMMAND_DEPLOY_CONCURRENCY ?? "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
  })();

  for (const root of roots) {
    const files = await walkFiles(root, [".js"]);
    await asyncLib.eachLimit(files, concurrency, async (file) => {
      filesTried.push(file);
      try {
        const mod = await import(`file://${resolve(file)}`);
        if (mod?.default?.data) {
          // Print name+path before toJSON so we see which one blows up
          const name = mod.default.data.name ?? "(no-name)";
          console.log(chalk.cyan(`• Loading command: ${chalk.bold(name)}  ← ${file}`));
          const json = mod.default.data.toJSON(); // validation happens here
          commands.push(json);
        }
      } catch (err) {
        console.error(chalk.red(`FAILED loading ${file}\n${err?.stack || err}`));
        throw err; // stop early so you see the culprit
      }
    });
  }
  console.log(chalk.blue(`Total commands collected: ${commands.length} from ${filesTried.length} files`));
  return commands;
}

async function register() {
  const rest = new REST({ version: "10" }).setToken(CONFIG.token);
  const body = await collectAllCommands();

  if (CONFIG.devGuildIds.length) {
    for (const gid of CONFIG.devGuildIds) {
      console.log(chalk.magenta(`Registering ${body.length} commands to guild ${gid}...`));
      await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, gid), { body });
    }
    console.log(chalk.green("Done (guild)."));
  } else {
    console.log(chalk.magenta(`Registering ${body.length} global commands...`));
    await rest.put(Routes.applicationCommands(CONFIG.clientId), { body });
    console.log(chalk.green("Done (global)."));
  }
}

register().catch(err => { console.error(chalk.red(err)); process.exit(1); });
