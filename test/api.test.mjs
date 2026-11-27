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
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
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

// `startServer` announces itself with a `console.log` that carries an emoji, and
// Node 20's runner reads a test child's non-ASCII stdout sitting next to a report
// frame as a frame length: the file then fails with "Unable to deserialize cloned
// data" while every subtest passed (nodejs/node#64061, #65934). Node 24 carries
// the fix and CI runs Node 20, so the banner is kept off stdout here — the same
// silence `test/parity.test.mjs:16-22` applies, and per-file because `node --test`
// gives each file its own child process.
console.log = () => {};

test("api: routes answer, unknown paths 404, a POST needs the shared token", async () => {
  const { startServer } = await import("../src/interfaces/api-server.js");
  const server = startServer(0);

  try {
    await new Promise((r) => server.once("listening", r));
    // A2: the default bind is loopback, not every interface.
    assert.equal(server.address().address, "127.0.0.1");
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

    // D5: the desktop shell generates a token per launch and hands it to the
    // sidecar as `SKYHOOK_REMOTE_TOKEN` (`src-tauri/src/main.rs:157`), so the gate
    // has to accept it *alongside* the configured secret that is still set above —
    // an install that also sets `remote.token` for its peers would otherwise
    // answer its own window 403. This fails if the gate goes back to `remoteToken()`.
    process.env.SKYHOOK_REMOTE_TOKEN = "launch-token";
    const launched = await fetch(`${base}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer launch-token" },
      body: JSON.stringify({ source: "nope" }),
    });
    assert.equal(launched.status, 200);
    assert.deepEqual(await launched.json(), { ok: true, stopped: [] });

    // A second credential is not a wildcard: a wrong one is refused while both are set.
    const wrong = await fetch(`${base}/api/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-token" },
      body: JSON.stringify({ source: "nope" }),
    });
    assert.equal(wrong.status, 403);
    delete process.env.SKYHOOK_REMOTE_TOKEN;

    // A4: the FlareSolverr executable path is config-only. A body that carries
    // it is refused before `saveSettings` runs, so the settings file does not
    // exist afterwards. This assertion fails if the route accepts `exePath`.
    const settingsFile = join(stateDir, "settings.json");
    const before = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : null;
    const spawnAttempt = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ flaresolverr: { enabled: true, exePath: "C:\\Windows\\System32\\cmd.exe" } }),
    });
    assert.equal(spawnAttempt.status, 400);
    assert.match(
      (await spawnAttempt.json()).error,
      /flaresolverr\.exePath is set in skyhook\.config\.json, not over the API/,
    );
    const after = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : null;
    assert.equal(after, before);

    // ...and the same toggle without the path is still accepted, so the route
    // is narrowed rather than closed.
    const toggled = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ flaresolverr: { enabled: true, port: 8191 } }),
    });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json()).settings.flaresolverr.enabled, true);

    // A5: a body past 1 MB is answered with 413 instead of hanging the handler
    // (`readBody` used to destroy the socket, so `end` never fired), and
    // unparseable JSON answers 400 rather than being read as `{}`.
    const huge = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ sources: [], pad: "x".repeat(2_000_000) }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, "request body too large");

    const garbage = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "{oops",
    });
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).error, "request body is not valid JSON");

    // ...and the same listener still answers afterwards.
    const alive = await fetch(`${base}/api/health`);
    assert.equal(alive.status, 200);

    // #24: the preflight names every header the token gate reads. Without `Authorization`
    // here a browser page on another origin is refused by its own CORS check, so a GUI
    // pointed at a peer (`apiBase()`) could never POST even holding the right token.
    const preflight = await fetch(`${base}/api/run`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://other.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    const allowedHeaders = preflight.headers.get("access-control-allow-headers") || "";
    assert.match(allowedHeaders, /authorization/i);
    assert.match(allowedHeaders, /x-skyhook-token/i);

    // #38: a trailing slash is not a different route, and the trim is a loop rather than a
    // right-anchored regex. The loop's value is cost — a test cannot time that — so what is
    // asserted here is that both shapes still get an answer instead of stalling.
    assert.equal((await fetch(`${base}/api/health//`)).status, 200);
    assert.equal((await fetch(`${base}/api${"/".repeat(400)}`)).status, 404);

    // G3: the header references a 96 px derivative, and the static handler
    // serves it — the 3.2 MB master must not be on the first-paint path.
    const logo = await fetch(`${base}/icons/logo-96.png`);
    assert.equal(logo.status, 200);
    const logoBytes = Buffer.from(await logo.arrayBuffer());
    assert.ok(logoBytes.length < 15000, `logo-96.png is ${logoBytes.length} bytes`);

    // The state DB opened on the temp path, not on the repo's `.skyhook/`.
    assert.equal(existsSync(join(stateDir, "seeder-state.db")), true);
  } finally {
    delete process.env.SKYHOOK_REMOTE_TOKEN;
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// #17: the banner is printed from the `listen` callback, which is the first moment the bound
// port is known. `skyhook app` binds port 0 by default, so a banner naming the *requested*
// `:0` sends the reader to a dead URL. `console.log` is silenced at the top of this file, so
// the banner is captured through a temporary collector and restored in `finally`.
test("api: the banner names the bound port, not the requested one", async () => {
  const { startServer } = await import("../src/interfaces/api-server.js");
  mkdirSync(stateDir, { recursive: true }); // the first test removed the temp dir

  const lines = [];
  const silenced = console.log;
  let server;
  try {
    console.log = (...args) => lines.push(args.join(" "));
    server = startServer(0);
    await new Promise((r) => server.once("listening", r));
  } finally {
    console.log = silenced;
  }

  try {
    const bound = server.address().port;
    assert.notEqual(bound, 0, "the kernel picked a real port");
    const banner = lines.join("\n");
    assert.match(banner, new RegExp(`127\\.0\\.0\\.1:${bound}`), "the banner names the port it bound");
    assert.doesNotMatch(banner, /:0(?!\d)/, "no line points at :0");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("api: an open bind without a token is refused, and a loopback one is not", async () => {
  const { startServer, isLoopbackHost } = await import("../src/interfaces/api-server.js");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);

  // The same fixture with one field changed: no shared secret. `remoteToken()`
  // reads the config at call time (`src/core/remote.js:21-23`), so a reload is
  // enough to reach the refusal — no second server and no open socket. Both
  // configs are rewritten here because the first test deletes the temp dir.
  mkdirSync(stateDir, { recursive: true });
  const fixture = {
    dataDir: stateDir,
    seedersDir,
    manifestFile: join(stateDir, "seeders-manifest.json"),
    descriptionsFile: join(stateDir, "seeders-descriptions.json"),
    stateDb: join(stateDir, "seeder-state.db"),
    logDir: join(stateDir, "logs"),
    stagedDir: join(stateDir, "staged"),
    settingsFile: join(stateDir, "settings.json"),
  };
  const tokenFile = join(tmp, "skyhook.config.token.json");
  const tokenless = join(tmp, "skyhook.config.no-token.json");
  writeFileSync(tokenFile, JSON.stringify({ ...fixture, remote: { token: "test-token", peers: [] } }, null, 2) + "\n");
  writeFileSync(tokenless, JSON.stringify({ ...fixture, remote: { token: null, peers: [] } }, null, 2) + "\n");
  loadConfig({ file: tokenless, reload: true });

  try {
    assert.throws(
      () => startServer(0, { host: "0.0.0.0" }),
      /refusing to listen on 0\.0\.0\.0 with no API token/,
    );

    // With a token the open bind is allowed; start and close it on port 0 so
    // the assertion is about the decision, not about the network.
    loadConfig({ file: tokenFile, reload: true });
    const open = startServer(0, { host: "0.0.0.0" });
    try {
      await new Promise((r) => open.once("listening", r));
      assert.notEqual(open.address().address, "127.0.0.1");
    } finally {
      await new Promise((r) => open.close(r));
    }
  } finally {
    loadConfig({ file: tokenFile, reload: true });
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// #31: a seeder that is running is not also due. `isDue` reads `last_run_at`, which `recordRun`
// writes when a run *ends*, so a seeder in flight still answered "due" — and every client
// (the console, the desktop timer) subtracted `/api/running` itself to compensate. The fixture
// seeder sleeps, so the run is observably in flight while the three due answers are read.
test("api: a running seeder is not due, and a second run request reports it", async () => {
  // The first test removed the temp dir, so the whole fixture is rebuilt here rather than
  // shared — the same shape the two tests above use.
  mkdirSync(seedersDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(seedersDir, "seed-slow.js"), `/**
 * seed-slow.js \u2014 Slow seeder
 * Category: CATEGORY.SCIENCE \u2192 SUBCATEGORY.SPACE_ASTRONOMY
 * Access: RSS feed
 * Description: Holds the run registry for the duration of one test.
 */
setTimeout(() => {}, 6000);
`);
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

  // Imported after the config is repointed: the engine resolves paths per call, but the DB it
  // opens on first use must be the temp one, never the repo's `.skyhook/`.
  const { enableSeeder } = await import("../src/engine/seeder-engine.js");
  assert.equal(enableSeeder("slow", "daily")?.cadence, "daily", "a scheduled seeder has a cadence");

  const { startServer } = await import("../src/interfaces/api-server.js");
  const server = startServer(0);
  const auth = { "Content-Type": "application/json", Authorization: "Bearer test-token" };
  /** Resolve once `fn()` is truthy, or throw — a bounded poll, never a bare sleep. */
  const poll = async (fn, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  try {
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // A scheduled seeder with no history is due: the assertion below only means something
    // because this one started true.
    const before = await (await fetch(`${base}/api/due`)).json();
    assert.deepEqual(before.map((s) => s.source), ["slow"]);

    const asked = await fetch(`${base}/api/run`, {
      method: "POST", headers: auth, body: JSON.stringify({ sources: ["slow"] }),
    });
    assert.equal(asked.status, 200);
    assert.deepEqual((await asked.json()).started, ["slow"]);

    // `runPool` awaits FlareSolverr before it spawns, so the child registers a moment after
    // the response — bounded poll, not a guess.
    await poll(async () => {
      const body = await (await fetch(`${base}/api/running`)).json();
      return body.running.some((r) => r.source === "slow");
    });

    assert.deepEqual(await (await fetch(`${base}/api/due`)).json(), [], "/api/due: in flight is not due");
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(status.dueList.map((s) => s.source), [], "/api/status.dueList agrees");
    assert.deepEqual(status.running.map((r) => r.source), ["slow"], "…while still naming what runs");
    assert.equal((await (await fetch(`${base}/api/health`)).json()).due, 0);

    // A client that never asked `/api/due` — a curl, the console's Run button — is told, not
    // obeyed: the same source in the same second is one child, not two.
    const again = await fetch(`${base}/api/run`, {
      method: "POST", headers: auth, body: JSON.stringify({ sources: ["slow"] }),
    });
    const answer = await again.json();
    assert.deepEqual(answer.started, [], "no second child for a source in flight");
    assert.deepEqual(answer.skippedRunning, ["slow"]);

    // Stop it, so the child cannot outlive the test — and so the last poll proves the registry
    // empties (the `finally` below would otherwise leave a sleeping child behind).
    await fetch(`${base}/api/stop`, { method: "POST", headers: auth, body: JSON.stringify({ source: "slow" }) });
    await poll(async () => (await (await fetch(`${base}/api/running`)).json()).running.length === 0);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// #49: started from a directory with no `skyhook.config.json`, `loadConfig` merges the defaults
// and the server says nothing — `/api/pipeline` then answers with the two built-in cards, which
// is indistinguishable from a project that really defines two. The banner now names the
// directory and the file it looked for, on stderr, once.
test("api: a boot with no config file says which directory it used", async () => {
  mkdirSync(stateDir, { recursive: true });
  const absent = join(tmp, "skyhook.config.absent.json");
  loadConfig({ file: absent, reload: true });

  const warned = [];
  const silenced = console.warn;
  let server;
  try {
    console.warn = (...args) => warned.push(args.join(" "));
    const { startServer } = await import("../src/interfaces/api-server.js");
    server = startServer(0);
    await new Promise((r) => server.once("listening", r));
  } finally {
    console.warn = silenced;
  }

  try {
    const text = warned.join("\n");
    assert.match(text, /no config found/, "the run says it is on the defaults");
    assert.match(text, new RegExp(process.cwd().replace(/\\/g, "\\\\")), "…and names the directory");
    assert.match(text, /skyhook\.config\.absent\.json/, "…and the file it looked for");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
