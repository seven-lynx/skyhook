/**
 * cloudflare.js — Cloudflare bypass tier for Skyhook.
 *
 * Optional, opt-in. When enabled (see `flaresolverr` in settings/config), seeders
 * can route bot-blocked fetches (403/503/challenge) through FlareSolverr — a
 * real browser that solves the Cloudflare challenge and returns the rendered
 * HTML (and, for redirects, the final URL).
 *
 * FlareSolverr is NOT assumed to be running. Skyhook launches the configured
 * executable on demand (`ensureFlareSolverr`), waits until it reports
 * "FlareSolverr is ready!", and tears it down again (`stopFlareSolverr`) when
 * the owning process exits or the run batch finishes.
 *
 * Process ownership:
 *   - A seeder run directly (`node seed-x.mjs`) spawns + kills its own copy.
 *   - A batch (`skyhook run …` / `run-due`) has the engine parent spawn one
 *     copy for the whole batch; children get SKYHOOK_FLARESOLVERR_MANAGED=1 so
 *     they reuse it without spawning/killing.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import fetch from "node-fetch";
import { getConfig } from "../config.js";
import { getFlareSolverrSettings } from "./settings.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ownedChild = null;   // the FlareSolverr process we spawned (if any)
let _starting = null;    // in-flight ensure promise (dedupe concurrent calls)
let _queue = Promise.resolve(); // serialises /v1 requests (FlareSolverr is single-threaded)

/** Base URL to talk to FlareSolverr, or null when disabled. */
export function flareSolverrBaseUrl() {
  const s = getFlareSolverrSettings();
  if (!s.enabled) return null;
  if (s.url) return s.url.replace(/\/+$/, "");
  return `http://127.0.0.1:${s.port}`;
}

async function healthReady(url) {
  try {
    const res = await fetch(`${url}/`, { headers: { "User-Agent": "skyhook/1.0" } });
    const text = await res.text();
    return /FlareSolverr is ready/i.test(text);
  } catch {
    return false;
  }
}

function killChild(child) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  } catch {}
}

/**
 * Ensure FlareSolverr is running and healthy. Returns its base URL, or null if
 * disabled / unavailable. Spawns the configured executable if needed — unless
 * this process is a managed seeder child (the engine parent owns the instance).
 */
export async function ensureFlareSolverr({ timeoutMs = 60000 } = {}) {
  if (_starting) return _starting;
  _starting = (async () => {
    const s = getFlareSolverrSettings();
    if (!s.enabled) return null;
    const url = flareSolverrBaseUrl();
    if (!url) return null;
    if (await healthReady(url)) return url;

    // Already-running isn't reachable; if the parent owns it, don't spawn here.
    if (process.env.SKYHOOK_FLARESOLVERR_MANAGED === "1") return null;
    if (!s.exePath || !existsSync(s.exePath)) return null;

    try {
      const child = spawn(s.exePath, [], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      });
      ownedChild = child;
      child.on("exit", () => { ownedChild = null; });
    } catch (err) {
      console.warn(`[cloudflare] failed to spawn FlareSolverr (${s.exePath}): ${err.message}`);
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await healthReady(url)) return url;
      await sleep(1000);
    }
    console.warn(`[cloudflare] FlareSolverr did not become ready within ${Math.round(timeoutMs / 1000)}s`);
    return null;
  })();
  try {
    return await _starting;
  } finally {
    _starting = null;
  }
}

/** Stop FlareSolverr, but only if this process spawned it. */
export function stopFlareSolverr() {
  if (!ownedChild) return false;
  killChild(ownedChild);
  ownedChild = null;
  return true;
}

// Kill the copy we spawned when this process exits — unless a parent engine is
// managing it (it stops it after the whole batch).
process.on("exit", () => {
  if (ownedChild && process.env.SKYHOOK_FLARESOLVERR_MANAGED !== "1") {
    killChild(ownedChild);
  }
});

async function requestViaFlareSolverr(url) {
  const run = async () => {
    const base = await ensureFlareSolverr();
    if (!base) throw new Error("FlareSolverr unavailable");
    const maxTimeout = getFlareSolverrSettings().maxTimeout ?? 60000;
    const res = await fetch(`${base}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "skyhook/1.0" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout }),
    });
    const json = await res.json();
    if (json.status !== "ok" || !json.solution) {
      throw new Error(json.message || "FlareSolverr request failed");
    }
    return json;
  };
  // Serialise all FlareSolverr calls: it solves one challenge at a time.
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

/** Resolve a URL through FlareSolverr and return the final URL (after redirects). */
export async function resolveRedirect(url) {
  if (!getFlareSolverrSettings().enabled) return null; // silent no-op when disabled
  try {
    const json = await requestViaFlareSolverr(url);
    return json.solution.url ?? null;
  } catch (err) {
    console.warn(`[cloudflare] resolveRedirect(${url}) failed: ${err.message}`);
    return null;
  }
}

/** Fetch a page through FlareSolverr and return a fetch()-compatible response. */
export async function fetchViaFlareSolverr(url) {
  const json = await requestViaFlareSolverr(url);
  const html = json.solution.response ?? "";
  const status = json.solution.status ?? 200;
  return {
    ok: status >= 200 && status < 400,
    status,
    url: json.solution.url ?? url,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html" : null),
    },
    text: async () => html,
  };
}
