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

/** Settings view for the API/GUI (hides nothing sensitive but the token). */
export function settingsView() {
  const cfg = getConfig();
  return {
    node: {
      id: cfg.node?.id ?? "local",
      allowRemote: allowRemote(),
    },
    remote: {
      peers: (cfg.remote?.peers ?? []).map((p) => ({ id: p.id, url: p.url })),
      hasToken: !!(cfg.remote?.token || process.env.SKYHOOK_REMOTE_TOKEN),
    },
  };
}
