/**
 * desktop-schedule.test.mjs — the tick that makes the app its own scheduler, and
 * the one-shot client it asks through.
 *
 * The desktop app owns automatic runs on Windows (`PLAN.md` §6 item 9), so the
 * failures that matter are quiet ones: a tick that starts nothing because one bad
 * response killed the loop, a tick that overlaps the one before it, and a loop that
 * outlives the server it talks to. "A seeder still running is not due" used to be
 * enforced here against `/api/running`; it is the server's rule now — `/api/due`
 * excludes a run in flight and `/api/run` answers `skippedRunning` (#31) — so the
 * tick is one round trip and the duplicate cannot be created by any client.
 *
 * The tick's assertions run against an injected `request`, so they open no socket
 * and wait for nothing — the one exception is the test that the timer fires at
 * all, which polls with a bounded wait rather than sleeping blind. `createRequest`
 * is proved separately, against a real server on 127.0.0.1, because it is the half
 * a stub cannot speak for: `http.request` with `agent: false` is what keeps a
 * closing child from aborting (`test/desktop-sidecar.test.mjs`, `0xC0000409`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";

import { createRequest, startSchedule } from "../desktop/schedule.js";

const BASE = "http://127.0.0.1:4173";

/**
 * A `request` that answers from `routes` and records every call.
 *
 * A route is a payload, an `{ status, payload }` record, a function returning
 * either (called with the calls so far), or an `Error` to throw. A 4xx/5xx throws
 * here the way the real client does, so a caller never sees a failure as data.
 */
function recorder(routes) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (!(path in routes)) throw new Error(`no route for ${path}`);
    const route = routes[path];
    const answer = await (typeof route === "function" ? route(calls) : route);
    if (answer instanceof Error) throw answer;
    const status = answer?.status ?? 200;
    if (status >= 400) throw new Error(`${method} ${path} answered ${status}`);
    return answer && "payload" in answer ? answer.payload : answer;
  };
  return { calls, request };
}

/** Resolve once `ready()` is true, or throw after `ms` — a bounded poll. */
async function waitUntil(ready, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("schedule: one tick starts the due set, once", async () => {
  const { calls, request } = recorder({
    "/api/due": { payload: [{ source: "alpha" }, { source: "beta" }] },
    "/api/run": { payload: { ok: true, started: ["alpha", "beta"], skippedRunning: [] } },
  });
  const logged = [];
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 1e6, log: (l) => logged.push(l) });

  try {
    assert.deepEqual(await schedule.tick(), { started: ["alpha", "beta"] });
  } finally {
    schedule.stop();
  }

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /api/due", "POST /api/run"],
    "one decision per tick: what is due, start it",
  );
  assert.deepEqual(calls[1].body, { sources: ["alpha", "beta"] });
  assert.deepEqual(logged, ["schedule: started alpha, beta"]);
});

test("schedule: nothing due writes no run", async () => {
  const { calls, request } = recorder({
    "/api/due": { payload: [] },
  });
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 1e6, log: () => {} });

  try {
    assert.deepEqual(await schedule.tick(), { skipped: "idle" });
  } finally {
    schedule.stop();
  }

  assert.equal(calls.some((call) => call.path === "/api/run"), false);
});

test("schedule: a seeder the server refused as already running is reported, not retried", async () => {
  const { calls, request } = recorder({
    "/api/due": { payload: [{ source: "alpha" }] },
    "/api/run": { payload: { ok: true, started: [], skippedRunning: ["alpha"] } },
  });
  const logged = [];
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 1e6, log: (l) => logged.push(l) });

  try {
    // The server owns the rule now; the tick's job is to say so once instead of
    // reporting a start that did not happen.
    assert.deepEqual(await schedule.tick(), { skipped: "running", active: ["alpha"] });
  } finally {
    schedule.stop();
  }

  assert.equal(calls.some((call) => call.path === "/api/running"), false, "no second round trip");
  assert.deepEqual(logged, ["schedule: already running alpha"]);
});

test("schedule: a failed pass is logged and the next tick still runs", async () => {
  let attempt = 0;
  const { request } = recorder({
    "/api/due": () => (++attempt === 1 ? new Error("connect ECONNREFUSED") : { payload: [{ source: "alpha" }] }),
    "/api/run": { payload: { started: ["alpha"] } },
  });
  const logged = [];
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 1e6, log: (l) => logged.push(l) });

  try {
    const failed = await schedule.tick();
    assert.match(failed.error, /ECONNREFUSED/);
    assert.equal(logged.length, 1, "a bad pass is reported, not swallowed");
    assert.match(logged[0], /^schedule: connect ECONNREFUSED/);

    assert.deepEqual(await schedule.tick(), { started: ["alpha"] }, "the loop survives the failure");
  } finally {
    schedule.stop();
  }
});

test("schedule: the interval fires the tick, and stop() ends it", async () => {
  const { calls, request } = recorder({
    "/api/due": { payload: [] },
  });
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 10, log: () => {} });

  await waitUntil(() => calls.length > 0, 2000);
  schedule.stop();
  const afterStop = calls.length;

  // A 10 ms interval against a 100 ms observation window: a loop that ignored
  // stop() would add roughly ten requests, so one queued call cannot mask it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, afterStop, "no request after stop()");
  assert.deepEqual(await schedule.tick(), { skipped: "stopped" });
});

test("schedule: a tick overlapping the previous one is skipped", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, request } = recorder({
    "/api/due": () => gate.then(() => ({ payload: [] })),
  });
  const schedule = startSchedule({ baseUrl: BASE, request, intervalMs: 1e6, log: () => {} });

  try {
    const first = schedule.tick();
    assert.deepEqual(await schedule.tick(), { skipped: "busy" });
    release();
    assert.deepEqual(await first, { skipped: "idle" });
    assert.equal(calls.length, 1, "the overlapping tick issued nothing");
  } finally {
    schedule.stop();
  }
});

test("client: one request carries the token and the body, and parses the answer", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const request = createRequest({ baseUrl, token: "secret" });
    assert.deepEqual(await request("POST", "/api/run", { sources: ["alpha"] }), { ok: true });
    assert.deepEqual(seen, [
      {
        method: "POST",
        url: "/api/run",
        auth: "Bearer secret",
        body: JSON.stringify({ sources: ["alpha"] }),
      },
    ]);

    // A GET asks a question: no body, no content headers.
    await request("GET", "/api/due");
    assert.equal(seen[1].method, "GET");
    assert.equal(seen[1].body, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("client: a non-2xx answer is an error naming the request", async () => {
  const server = createServer((req, res) => { res.writeHead(500); res.end("nope"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await assert.rejects(
      () => createRequest({ baseUrl })("GET", "/api/due"),
      /GET \/api\/due answered 500/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("client: an answer that is not JSON is an error, not a value", async () => {
  const server = createServer((req, res) => { res.writeHead(200); res.end("not json"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await assert.rejects(
      () => createRequest({ baseUrl })("GET", "/api/due"),
      /GET \/api\/due did not answer JSON/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
