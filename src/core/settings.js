/**
 * settings.js — runtime-mutable settings (separate from the static config).
 *
 * `skyhook.config.json` is hand-edited, static config. A few things are meant to
 * be toggled at runtime from the GUI/TUI — chief among them the Pi's "allow
 * remote control" switch. These live in `settingsFile` (default
 * `.skyhook/settings.json`) and are merged over config where relevant.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getConfig } from "../config.js";

export function loadSettings() {
  const file = getConfig().settingsFile;
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch = {}) {
  const file = getConfig().settingsFile;
  const next = { ...loadSettings(), ...patch };
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  }
  return next;
}

/** The Pi "operate me remotely" toggle. Settings override static config. */
export function allowRemote() {
  const cfg = getConfig();
  const s = loadSettings();
  return !!(s.allowRemote ?? cfg.node?.allowRemote ?? false);
}

/** Effective FlareSolverr settings — runtime settings override static config. */
export function getFlareSolverrSettings() {
  const cfg = getConfig();
  const s = loadSettings();
  const c = cfg.flaresolverr ?? {};
  const f = s.flaresolverr ?? {};
  return {
    enabled: !!(f.enabled ?? c.enabled ?? false),
    exePath: f.exePath ?? c.exePath ?? null,
    url: f.url ?? c.url ?? null,
    port: f.port ?? c.port ?? 8191,
    maxTimeout: f.maxTimeout ?? c.maxTimeout ?? 60000,
  };
}


/** Settings view for the API/GUI (hides nothing sensitive but the token). */
export function settingsView() {
  const cfg = getConfig();
  const s = loadSettings();
  const providers = cfg.tagging?.providers || [];
  const defaultPlatform = s.taggingPlatform ?? providers[0]?.id ?? null;
  const fr = getFlareSolverrSettings();
  return {
    node: {
      id: cfg.node?.id ?? "local",
      allowRemote: allowRemote(),
    },
    remote: {
      peers: (cfg.remote?.peers ?? []).map((p) => ({ id: p.id, url: p.url })),
      hasToken: !!(cfg.remote?.token || process.env.SKYHOOK_REMOTE_TOKEN),
    },
    tagging: {
      platforms: providers.map((p) => ({ id: p.id, baseUrl: p.baseUrl })),
      activePlatform: defaultPlatform,
    },
    flaresolverr: {
      enabled: fr.enabled,
      exePath: fr.exePath,
      url: fr.url,
      port: fr.port,
      maxTimeout: fr.maxTimeout,
    },
  };
}

/** Returns the full provider object for the active tagging platform. */
export function getActiveTaggingProvider() {
  const cfg = getConfig();
  const s = loadSettings();
  const providers = cfg.tagging?.providers || [];
  const id = s.taggingPlatform ?? providers[0]?.id ?? null;
  return providers.find((p) => p.id === id) ?? null;
}
