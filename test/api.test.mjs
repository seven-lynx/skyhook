/**
 * api.test.mjs — route-level proof for the one HTTP listener.
 *
 * `src/interfaces/api-server.js` is the only surface the GUI and remote peers
 * speak to, and until now every route in it was a code read. This file starts
 * the real server on a loopback socket against a temp data dir, so the exposure
 * rules have an observer instead of an argument.
 *
 * The engine captures `getConfig()` at import time (`src/engine/seeder-engine.js:24-34`),
 * so the config is repointed at `.tmp-api-*` *before* the server is imported —
 * a static import here would make `openState()` open the repo's own
 * `.skyhook/seeder-state.db`, which a test may never touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, `.tmp-api-${process.pid}`);
const seedersDir = join(tmp, "seeders");
const stateDir = join(tmp, "state");

mkdirSync(seedersDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

// One fixture seeder, so `/api/seeders` has a known answer that does not depend
// on the user's own `seeders/` directory. The header follows the JSDoc grammar
// `parseHeader` reads (display name, category → subcategory, access).
writeFileSync(join(seedersDir, "seed-demo.js"), `/**
 * seed-demo.js \u2014 Demo seeder
 * Category: CATEGORY.SCIENCE \u2192 SUBCATEGORY.SPACE_ASTRONOMY
 * Access: RSS feed
 * Description: Fixture seeder for the API routes.
 */
`);

const configFile = join(tmp, "skyhook.config.json");
writeFileSync(configFile, JSON.stringify({
  dataDir: stateDir,
  seedersDir,
  manifestFile: join(stateDir, "seeders-manifest.json"),
  descriptionsFile: join(stateDir, "seeders-descriptions.json"),
  stateDb: join(stateDir, "seeder-state.db"),
  logDir: join(stateDir, "logs"),
  stagedDir: join(stateDir, "staged"),
  settingsFile: join(stateDir, "settings.json"),
  remote: { token: "test-token", peers: [] },
}, null, 2) + "\n");

loadConfig({ file: configFile, reload: true });

test("api: routes answer, unknown paths 404, a POST needs the shared token", async () => {
  const { startServer } = await import("../src/interfaces/api-server.js");
  const server = startServer(0);

  try {
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true, seeders: 1, scheduled: 0, due: 0, errors: 0,
    });

    const seeders = await fetch(`${base}/api/seeders`);
    assert.equal(seeders.status, 200);
    const rows = await seeders.json();
    assert.ok(Array.isArray(rows), "/api/seeders returns an array");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "demo");
    assert.equal(rows[0].subcategory, "SPACE_ASTRONOMY");

    const missing = await fetch(`${base}/api/seeders/nope`);
    assert.equal(missing.status, 404);

    const unknown = await fetch(`${base}/api/unknown`);
    assert.equal(unknown.status, 404);

    // The token gate: `remote.token` is set in the temp config, so a POST with
    // no `Authorization` header must be refused before any handler runs. This
    // assertion fails if the gate at `api-server.js:126-133` is removed.
    const denied = await fetch(`${base}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "nope" }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "invalid or missing token");

    // ...and the same call with the token reaches the handler, so the gate is a
    // gate and not a blanket rejection. `{ source }` of an unknown seeder stops
    // nothing and touches no state.
    const allowed = await fetch(`${base}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ source: "nope" }),
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true, stopped: [] });

    // The state DB opened on the temp path, not on the repo's `.skyhook/`.
    assert.equal(existsSync(join(stateDir, "seeder-state.db")), true);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
