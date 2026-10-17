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
  settingsFile: ".skyhook/settings.json",
  node: { id: "local", allowRemote: false },
  remote: { token: null, peers: [] },
  flaresolverr: {
    enabled: false,
    exePath: null,   // absolute path to the FlareSolverr executable (spawned on demand)
    url: null,       // optional override; default http://127.0.0.1:{port}
    port: 8191,
    maxTimeout: 60000,
  },
  storage: {
    provider: "stage",
    schemaFile: "config/schema.json",
    url: null,
    serviceRoleKey: null,
    dbFile: null,
    connectionString: null,
  },
  tagging: {
    enabled: false,
    providers: [],
    model: null,
    promptFile: "config/tagging-prompt.txt",
    vocabFile: "config/tags.json",
    temperature: 0,
    worker: {
      batchSize: 25,
      modelSource: "llm",
    },
  },
  pipeline: {
    status: null,   // optional script that prints the pipeline status JSON
    offlineDb: null, // local SQLite DB for the offline tagging pipeline
    knownUrlsDb: null, // local SQLite dedup index of production URLs
    jobs: {},       // { key: { label, command: [script, ...args], danger? } }
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
  "descriptionsFile", "stateDb", "logDir", "stagedDir", "settingsFile",
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
  if (merged.pipeline?.status && !isAbsolute(merged.pipeline.status)) {
    merged.pipeline.status = resolve(cwd, merged.pipeline.status);
  }
  if (merged.pipeline?.offlineDb && !isAbsolute(merged.pipeline.offlineDb)) {
    merged.pipeline.offlineDb = resolve(cwd, merged.pipeline.offlineDb);
  }
  if (merged.pipeline?.knownUrlsDb && !isAbsolute(merged.pipeline.knownUrlsDb)) {
    merged.pipeline.knownUrlsDb = resolve(cwd, merged.pipeline.knownUrlsDb);
  }

  // FlareSolverr Cloudflare-bypass (optional). Runtime settings override config.
  if (process.env.FLARESOLVERR_ENABLED === "1") merged.flaresolverr.enabled = true;
  if (process.env.FLARESOLVERR_EXE) merged.flaresolverr.exePath = process.env.FLARESOLVERR_EXE;
  if (process.env.FLARESOLVERR_URL) merged.flaresolverr.url = process.env.FLARESOLVERR_URL;
  if (process.env.FLARESOLVERR_PORT) merged.flaresolverr.port = parseInt(process.env.FLARESOLVERR_PORT, 10) || 8191;

  // Allow env-based credentials to override config (never committed).
  merged.storage.url = merged.storage.url || process.env.SUPABASE_URL || null;
  merged.storage.serviceRoleKey =
    merged.storage.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  merged.storage.connectionString =
    merged.storage.connectionString || process.env.POSTGRES_URL || process.env.DATABASE_URL || null;

  _config = merged;
  return _config;
}

export function getConfig() {
  return _config ?? loadConfig();
}

/** This machine's node id (used to route seeders between PC/Pi). */
export function nodeId() {
  return getConfig().node?.id ?? "local";
}
