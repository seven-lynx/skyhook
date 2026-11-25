/**
 * app-session.test.mjs — the desktop host's half of the server lifecycle.
 *
 * `src/interfaces/app-session.js` is the one entry point a shell (or
 * `skyhook app`) will use, and its two promises are the kind that only an
 * observer can settle: a second session is refused while the first holds the
 * lock, and `close()` leaves no bound port and no lock file. Both are checked
 * here against a real loopback socket and a `.tmp-app-session-*` data dir.
 *
 * The engine reads `getConfig()` per call but the server resolves paths on the
 * way in, so the config is repointed *before* `app-session.js` is imported —
 * a static import would point `openState()` at the repo's own `.skyhook/`,
 * which a test may never touch (`test/api.test.mjs:9-13`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, `.tmp-app-session-${process.pid}`);
const seedersDir = join(tmp, "seeders");
const dataDir = join(tmp, "state");
const lockPath = join(dataDir, ".app-session.lock");

mkdirSync(seedersDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// An empty `seeders/` is the honest fixture: `/api/health` reports zero
// seeders without depending on the user's own directory.
writeFileSync(join(tmp, "skyhook.config.json"), JSON.stringify({
  dataDir,
  seedersDir,
  manifestFile: join(dataDir, "seeders-manifest.json"),
  descriptionsFile: join(dataDir, "seeders-descriptions.json"),
  stateDb: join(dataDir, "seeder-state.db"),
  logDir: join(dataDir, "logs"),
  stagedDir: join(dataDir, "staged"),
  settingsFile: join(dataDir, "settings.json"),
}, null, 2) + "\n");

loadConfig({ file: join(tmp, "skyhook.config.json"), reload: true });

// The session's server banner is a `console.log` carrying an emoji, and Node 20's
// runner reads a test child's non-ASCII stdout sitting next to a report frame as a
// frame length: the file then fails with "Unable to deserialize cloned data" while
// every subtest passed (nodejs/node#64061, #65934). Node 24 carries the fix and CI
// runs Node 20, so the banner is kept off stdout here — the same silence
// `test/parity.test.mjs:16-22` applies, and per-file because `node --test` gives
// each file its own child process.
console.log = () => {};

after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

test("app session: picks a port, answers health, and closes with no socket and no lock", async () => {
  const { startAppSession } = await import("../src/interfaces/app-session.js");
  const session = await startAppSession({ dataDir });

  try {
    assert.equal(session.host, "127.0.0.1");
    assert.ok(session.port > 0, "a free port was picked, not the default 4173");
    assert.equal(session.baseUrl, `http://127.0.0.1:${session.port}`);
    assert.equal(existsSync(lockPath), true, "the lock exists while the session runs");

    const health = await fetch(`${session.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true, seeders: 0, scheduled: 0, due: 0, errors: 0,
    });
  } finally {
    await session.close();
  }

  assert.equal(existsSync(lockPath), false, "close() removes the lock");
  await assert.rejects(
    () => fetch(`${session.baseUrl}/api/health`),
    "the port is no longer bound after close()",
  );
  await session.close(); // idempotent: the second call resolves too
});

test("app session: a second instance is refused at the lock, then allowed after close", async () => {
  const { startAppSession } = await import("../src/interfaces/app-session.js");
  const first = await startAppSession({ dataDir });

  try {
    // The loser fails before `startServer(`, so it never binds a port of its own.
    await assert.rejects(() => startAppSession({ dataDir }), /already running/);
    assert.equal(existsSync(lockPath), true, "the winner still holds the lock");
  } finally {
    await first.close();
  }

  const second = await startAppSession({ dataDir });
  await second.close();
  assert.equal(existsSync(lockPath), false);
});

test("app session: a lock left by a dead session is reclaimed", async () => {
  const { startAppSession } = await import("../src/interfaces/app-session.js");

  // A crash can leave the file behind; a body that names no live pid is the
  // same branch as a truncated write, so it is the deterministic fixture.
  writeFileSync(lockPath, JSON.stringify({ pid: 0, startedAt: new Date().toISOString() }));

  const session = await startAppSession({ dataDir });
  await session.close();
  assert.equal(existsSync(lockPath), false);
});
