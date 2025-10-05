// Minimal, framework-agnostic plugin contract

/**
 * @typedef {Object} PluginRegistration
 * @property {string[]} [commandDirs]  absolute or relative directories with command .js files (default export)
 * @property {string[]} [eventDirs]    directories with event .js files (default export {name, once, execute})
 * @property {number[]} [intents]      extra Discord intents needed by this plugin
 * @property {number[]} [partials]     extra Discord partials needed by this plugin
 * @property {(container:{set:(k:string,v:any)=>void, get:(k:string)=>any})=>Promise<void>|void} [register]
 */

/**
 * @typedef {Object} ModbotPlugin
 * @property {{name: string, version?: string}} meta
 * @property {() => PluginRegistration} setup
 */

export {}; // types only (ESM noop)
