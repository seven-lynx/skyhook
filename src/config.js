/**
 * config.js — single config loader for Skyhook.
 *
 * Reads a `skyhook.config.json` (from the working directory or an explicit
 * path) and merges it over built-in defaults. Relative paths are resolved
 * against the working directory. `.env` is loaded for storage credentials and
 * content API keys.
 */
import { readFileSync, existsSync } from "fs";
import { dirname, resolve, join, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { config as dotenvConfig } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenvConfig({ quiet: true }); // cwd/.env
dotenvConfig({ path: resolve(__dirname, "../.env"), quiet: true }); // package .env (fallback)

const DEFAULTS = {
  name: "skyhook",
  userAgent: "Skyhook/1.0 (+https://github.com/seven-lynx/skyhook)",
  dataDir: ".skyhook",
  seedersDir: "seeders",
  categoriesFile: "config/categories.json",
  manifestFile: ".skyhook/seeders-manifest.json",
  descriptionsFile: ".skyhook/seeders-descriptions.json",
  stateDb: ".skyhook/seeder-state.db",
  logDir: ".skyhook/logs",
  stagedDir: ".skyhook/staged",
  storage: {
    provider: "stage",
    schemaFile: "config/schema.json",
    url: null,
    serviceRoleKey: null,
    dbFile: null,
  },
  tagging: {
    enabled: false,
    providers: [],
    model: null,
    promptFile: "config/tagging-prompt.txt",
    vocabFile: "config/tags.json",
    temperature: 0,
  },
};

let _config = null;

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base?.[k], over[k]);
    return out;
  }
  return over;
}

const PATH_KEYS = [
  "dataDir", "seedersDir", "categoriesFile", "manifestFile",
  "descriptionsFile", "stateDb", "logDir", "stagedDir",
];

export function loadConfig(opts = {}) {
  if (_config && !opts.reload) return _config;
  const cwd = opts.cwd || process.cwd();
  const file = opts.file || join(cwd, "skyhook.config.json");
  let user = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Invalid config ${file}: ${e.message}`);
    }
  }

  const merged = deepMerge(DEFAULTS, user);

  for (const key of PATH_KEYS) {
    if (merged[key] && !isAbsolute(merged[key])) merged[key] = resolve(cwd, merged[key]);
  }
  if (merged.storage?.schemaFile && !isAbsolute(merged.storage.schemaFile)) {
    merged.storage.schemaFile = resolve(cwd, merged.storage.schemaFile);
  }
  if (merged.storage?.dbFile && !isAbsolute(merged.storage.dbFile)) {
    merged.storage.dbFile = resolve(cwd, merged.storage.dbFile);
  }
  if (merged.tagging?.promptFile && !isAbsolute(merged.tagging.promptFile)) {
    merged.tagging.promptFile = resolve(cwd, merged.tagging.promptFile);
  }
  if (merged.tagging?.vocabFile && !isAbsolute(merged.tagging.vocabFile)) {
    merged.tagging.vocabFile = resolve(cwd, merged.tagging.vocabFile);
  }

  // Allow env-based credentials to override config (never committed).
  merged.storage.url = merged.storage.url || process.env.SUPABASE_URL || null;
  merged.storage.serviceRoleKey =
    merged.storage.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

  _config = merged;
  return _config;
}

export function getConfig() {
  return _config ?? loadConfig();
}
