/**
 * schedule.js — the app-resident timer: while the window is open, due seeders run.
 *
 * The owner ruled that the desktop app is the scheduler on Windows — no systemd
 * unit, no registered OS task — so the tick belongs to the process that only
 * exists while the app does. It sits here rather than in `src-tauri/src/main.rs`
 * for two reasons: the cadence rule is already the server's (`/api/due` applies
 * `CADENCE_MS`, so the shell keeps no second copy of it), and this is the half a
 * test can drive without a Rust toolchain.
 *
 * The poll is a fixed interval, not one tick per cadence, because what *decides*
 * "due" changes while the app runs: a run finishes, a cadence is edited, a laptop
 * wakes up. One loopback round trip a minute answers all three with no bookkeeping
 * kept on this side.
 *
 * The gate on `/api/running` used to live here: `runPool()` records `last_run_at`
 * only when a seeder *finishes*, so a seeder still running stayed in `/api/due`, and
 * posting it again every minute would start a second child. That rule belongs to the
 * selector, not to each client (#31): `/api/due` now excludes a run in flight and
 * `/api/run` answers `skippedRunning`, so the tick makes one round trip and no client
 * can fork a duplicate.
 */
import { request as httpRequest } from "http";

/** How often the app asks its own server what is due. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * A one-shot HTTP client for the session's own server.
 *
 * `http.request` with `agent: false` rather than the global `fetch`, and the reason
 * is measured rather than stylistic: undici keeps its sockets alive, and a
 * `process.exit(0)` while one is open aborts the child on Windows (status
 * `0xC0000409` — `test/desktop-sidecar.test.mjs` caught it). The target is loopback
 * and the other end is this process's own server, so the shorter client is also the
 * honest one: no TLS, no redirects, no connection pool.
 *
 * A non-2xx is an error here, not data — the callers all treat it that way.
 */
export function createRequest({ baseUrl, token = null } = {}) {
  return function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const { hostname, port } = new URL(baseUrl);
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (payload !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      if (token) headers.Authorization = `Bearer ${token}`;

      const req = httpRequest({ hostname, port, path, method, headers, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`${method} ${path} answered ${res.statusCode}`));
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (err) {
            reject(new Error(`${method} ${path} did not answer JSON: ${err.message}`));
          }
        });
      });
      req.on("error", (err) => reject(new Error(`${method} ${path} failed: ${err.message}`)));
      req.end(payload ?? undefined);
    });
  };
}

/**
 * Start the loop, or return the pieces a caller and a test drive directly.
 *
 * `request` and `log` are injected so `test/desktop-schedule.test.mjs` opens no
 * socket and waits for nothing: every decision is visible in the calls it makes.
 * `tick()` is returned rather than hidden behind the interval because the caller
 * fires the first one — an app opened after a weekend catches up at launch instead
 * of at the first full interval.
 */
export function startSchedule({
  baseUrl,
  token = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  request = createRequest({ baseUrl, token }),
  log = (line) => console.error(line),
} = {}) {
  let busy = false;
  let stopped = false;

  /**
   * One pass: never overlap a run, otherwise start everything the server calls due.
   *
   * A failed pass is reported and returned, never thrown — a schedule that dies on
   * one bad response stops for the rest of the session, which is the one outcome
   * this file exists to prevent.
   */
  async function tick() {
    if (stopped) return { skipped: "stopped" };
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      const due = await request("GET", "/api/due");
      const sources = (Array.isArray(due) ? due : []).map((row) => row.source).filter(Boolean);
      if (!sources.length) return { skipped: "idle" };
      // A shutdown between the two requests must not start a run in a closing server.
      if (stopped) return { skipped: "stopped" };

      const answer = await request("POST", "/api/run", { sources });
      const skipped = Array.isArray(answer?.skippedRunning) ? answer.skippedRunning : [];
      if (skipped.length) log(`schedule: already running ${skipped.join(", ")}`);
      const names = Array.isArray(answer?.started) ? answer.started : sources;
      if (!names.length) return { skipped: "running", active: skipped };
      log(`schedule: started ${names.join(", ")}`);
      return { started: names };
    } catch (err) {
      log(`schedule: ${err.message}`);
      return { error: err.message };
    } finally {
      busy = false;
    }
  }

  // `unref` so a pending tick can never be the reason the child will not exit; the
  // stop path is `stop()`, not a timer that outlives the server it talks to.
  const timer = setInterval(() => { tick(); }, intervalMs);
  timer.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
