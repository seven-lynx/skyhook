/**
 * app-session.js — the server lifecycle a desktop host (or `skyhook app`) needs.
 *
 * `startServer()` gives back an `http.Server` and nothing else: it does not pick
 * a port, does not say when the routes are answerable, and has no way to stop
 * besides closing the listener by hand. A window that owns the server needs all
 * three, so this module composes them in one place instead of teaching every
 * shell to re-implement the sequence.
 *
 * Two things it owns that `startServer` cannot: a lock under `dataDir`, so a
 * second session is refused instead of sharing a state DB, and `close()`, which
 * is idempotent and leaves neither a bound port nor a lock file behind — the
 * failure a "start it twice from the tray" bug would otherwise produce.
 *
 * No window and no Electron here, which is what keeps it unit-testable
 * (`test/app-session.test.mjs`).
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { once } from "events";
import { getConfig } from "../config.js";
import { startServer } from "./api-server.js";

export const LOCK_NAME = ".app-session.lock";

/** A pid is alive if it can be signalled — `EPERM` means someone else's process. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** The pid a lock file names, or `null` when it is unreadable or malformed. */
function lockPid(lockPath) {
  try {
    const pid = JSON.parse(readFileSync(lockPath, "utf8")).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null; // a crash mid-write, or a hand-made file: treat it as stale
  }
}

/**
 * Take the single-instance lock, reclaiming one whose process is gone.
 *
 * `wx` is the whole race: the filesystem decides which session wins, so two
 * launches in the same second cannot both proceed. A lock left by a crash names
 * a dead pid (or nothing at all), which is why staleness is a liveness check
 * and not an age: a session that has been up for a week is still the session.
 */
function acquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = lockPid(lockPath);
      if (holder !== null && isAlive(holder)) {
        throw new Error(
          `app session already running (pid ${holder}) — remove ${lockPath} if that process is gone`,
        );
      }
      try { unlinkSync(lockPath); } catch {} // stale: the recorded session is gone
    }
  }
  throw new Error(`could not acquire the app session lock at ${lockPath}`);
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {} // already released — close() is idempotent
}

/**
 * Stop the listener and wait for it to be stopped.
 *
 * Idle keep-alive sockets (the pooled kind `fetch` leaves behind) would hold
 * the port open past `close()`, so they are dropped explicitly.
 */
function stopListening(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

/** A dialable address for `host` — `0.0.0.0` and `::` are binds, not targets. */
function dialHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

/** Poll `/api/health` until it answers `{ ok: true }`, or fail with why not. */
async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok && (await res.json())?.ok) return;
      last = `health answered ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`app session did not become healthy at ${baseUrl} within ${timeoutMs} ms (${last})`);
}

/**
 * Start one app session and hand back the URL it answers on.
 *
 * `port: 0` (the default) binds a free port and reports it, so two projects on
 * one machine never fight over 4173. A caller that wants a known port passes it
 * and gets a clear `EADDRINUSE` refusal instead of a second silent listener.
 */
export async function startAppSession({
  port = 0,
  host = "127.0.0.1",
  dataDir,
  healthTimeoutMs = 5000,
} = {}) {
  const dir = dataDir || getConfig().dataDir;
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, LOCK_NAME);
  acquireLock(lockPath);

  let server = null;
  let closing = null;

  // One shutdown path, shared by the caller and the failure below: stop the
  // socket that may exist, then drop the lock — in that order, always.
  const close = () => {
    if (!closing) {
      closing = (async () => {
        try { await stopListening(server); } finally { releaseLock(lockPath); }
      })();
    }
    return closing;
  };

  try {
    server = startServer(port, { host });
    await once(server, "listening"); // rejects on bind failure, e.g. EADDRINUSE
    const boundPort = server.address().port;
    const baseUrl = `http://${dialHost(host)}:${boundPort}`;
    await waitForHealth(baseUrl, healthTimeoutMs);
    return { baseUrl, port: boundPort, host, dataDir: dir, lockPath, close };
  } catch (err) {
    await close();
    throw err;
  }
}
