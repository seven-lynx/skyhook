#!/usr/bin/env node
/**
 * server.js — the desktop sidecar: one app session, one line on stdout, one shutdown path.
 *
 * The Tauri shell cannot import JS and must not load `better-sqlite3`, so the
 * server stays a real Node child process. This file is the whole of that child:
 * it starts `startAppSession()`, announces the URL it got, and stops when the
 * shell says so. Everything else — the port, the lock, the health poll, the
 * idempotent close — belongs to `src/interfaces/app-session.js`.
 *
 * Two shapes here are deliberate:
 *
 * 1. `--root` chdirs *before* the import. `loadConfig()` resolves `dataDir`,
 *    `stateDb`, `seedersDir` and friends against `process.cwd()`
 *    (`src/config.js:134,149-151`), and the engine freezes `ROOT` at import
 *    (`src/engine/seeder-engine.js:24`). A shell-spawned child inherits the
 *    install directory, so without this an installed app would read and write
 *    `.skyhook/` beside its own exe. The import is dynamic for the same reason:
 *    a static one would be evaluated before any chdir could happen.
 * 2. The announced line is JSON on its own line, not the first line of stdout.
 *    `startServer()` prints a human banner when it listens
 *    (`src/interfaces/api-server.js:537-539`), so the protocol the shell reads
 *    is "the first line that parses as JSON carrying `baseUrl`" — see
 *    `test/desktop-sidecar.test.mjs`.
 *
 * Stopping is `--watch-stdin`: the shell closes the child's stdin when the
 * window goes away, and a closed pipe is the only cross-platform stop signal
 * (on Windows `SIGTERM` is a `TerminateProcess`, not a signal a handler sees).
 * The flag is opt-in because a child spawned with `stdio: "ignore"` reads stdin
 * as `/dev/null` and would stop the instant it started.
 *
 * This process is also the scheduler on Windows: `./schedule.js` asks the server
 * what is due and starts it, so the app owns automatic runs without systemd or an
 * OS task (`PLAN.md` §6 item 9). It starts here, next to the listener it talks to,
 * and stops before that listener does — the one ordering that cannot leave a tick
 * posting to a closing server. `--tick-ms` exists for the live proof and for
 * nothing else; the default is a minute.
 */
import { resolve } from "path";

import { startSchedule } from "./schedule.js";

const argv = process.argv.slice(2);

/** The value after `flag`, or `null` when it is absent or last. */
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** One line of machine output — the shell parses lines, so never interleave. */
function announce(info) {
  process.stdout.write(`${JSON.stringify(info)}\n`);
}

async function main() {
  const root = argValue("--root");
  if (root) process.chdir(resolve(root));

  const { startAppSession } = await import("../src/interfaces/app-session.js");

  let session = null;
  let schedule = null;
  let stopping = null;

  // One shutdown path: stop the timer, stop the listener, drop the lock, then
  // exit. A second call (SIGTERM racing a closed stdin) reuses the same promise.
  const stop = (code) => {
    if (!stopping) {
      stopping = (async () => {
        schedule?.stop();
        try {
          await session?.close();
        } catch (err) {
          console.error(`sidecar: close failed: ${err.message}`);
        }
        process.exit(code);
      })();
    }
    return stopping;
  };

  try {
    session = await startAppSession({ port: 0 });
  } catch (err) {
    // The shell shows this instead of a blank window; a stack would say less.
    console.error(`sidecar: ${err.message}`);
    process.exit(1);
  }

  announce({ baseUrl: session.baseUrl, port: session.port, root: process.cwd() });

  // The first tick runs at launch rather than at the first interval, so an app
  // opened after a weekend catches up at once; `tick()` logs its own failures.
  // The token is the one the shell handed this process — the same credential the
  // window carries — because a desktop install's own POSTs are gated like any other.
  const tickMs = Math.max(250, Number(argValue("--tick-ms")) || 60_000);
  schedule = startSchedule({
    baseUrl: session.baseUrl,
    token: process.env.SKYHOOK_REMOTE_TOKEN ?? null,
    intervalMs: tickMs,
  });
  schedule.tick();

  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
  if (argv.includes("--watch-stdin")) {
    process.stdin.on("end", () => stop(0));
    process.stdin.on("close", () => stop(0));
    process.stdin.resume();
  }
}

main().catch((err) => {
  console.error(`sidecar: ${err.stack || err.message}`);
  process.exit(1);
});
