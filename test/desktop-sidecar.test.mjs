/**
 * desktop-sidecar.test.mjs — the sidecar's half of the shell contract.
 *
 * `desktop/server.js` is the only Node entry a desktop build runs, and the shell
 * believes exactly three things about it: a JSON line naming the URL, a server
 * that answers `/api/health` on that URL, and a stdin close that leaves no lock
 * and no bound port. Each is checked here against a real child process and a
 * `.tmp-desktop-*` root, because the failure modes (a banner parsed as the
 * handshake, state written beside the exe, an orphaned listener) are invisible
 * to any unit test of `startAppSession` alone.
 *
 * The child is spawned with `cwd` inside the temp root, so `--root` is what puts
 * the state DB there rather than the repo's own `.skyhook/` — a test may never
 * touch that (`test/api.test.mjs:9-13`). Its stdout is a pipe: the emoji banner
 * the server prints at startup stays in this pipe and never reaches the runner's
 * report channel (nodejs/node#64061, `test/app-session.test.mjs:46-53`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdirSync, rmSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, `.tmp-desktop-${process.pid}`);
const entry = join(root, "desktop", "server.js");

mkdirSync(tmp, { recursive: true });

after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** The lock a session takes under its data dir (`startAppSession`). */
const lockOf = (dataRoot) => join(dataRoot, ".skyhook", ".app-session.lock");

/**
 * Spawn the sidecar and resolve the first line that parses as JSON with `baseUrl`.
 *
 * The banner `startServer()` prints when it listens is why this scans instead of
 * reading line one — the handshake is a shape, not an ordinal.
 */
function startSidecar(dataRoot) {
  const child = spawn(
    process.execPath,
    [entry, "--root", dataRoot, "--watch-stdin"],
    { cwd: tmp, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout = [];
  const stderr = [];
  let buffered = "";

  // Subscribed before any await: a child that exits before the handshake must
  // still settle, and `events.once` attached afterwards would wait forever.
  const exited = new Promise((resolveCode) => child.on("exit", (code) => resolveCode(code)));
  child.stdin.on("error", () => {}); // EPIPE when the other side is already gone

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { buffered += chunk; stdout.push(chunk); });
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const info = new Promise((resolveInfo, rejectInfo) => {
    const timer = setTimeout(() => {
      rejectInfo(new Error(
        `no baseUrl line within 15 s\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
      ));
    }, 15000);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };

    child.stdout.on("data", () => {
      for (const line of buffered.split("\n").slice(0, -1)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.baseUrl) return settle(resolveInfo, parsed);
        } catch { /* the banner, or a line split across chunks */ }
      }
    });
    child.on("error", (err) => settle(rejectInfo, err));
    child.on("exit", (code) => settle(rejectInfo, new Error(
      `sidecar exited ${code} before announcing\nstderr:\n${stderr.join("")}`,
    )));
  });
  info.catch(() => child.kill());

  return { child, info, exited, stdout, stderr };
}

/** Close the child's stdin, the stop signal the shell sends, and read its exit code. */
async function stop(side) {
  side.child.stdin.end();
  return side.exited;
}

test("sidecar: announces a baseUrl, answers health, and stops clean on stdin EOF", async () => {
  const side = startSidecar(tmp);
  const info = await side.info;

  try {
    assert.match(info.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(info.port, Number(new URL(info.baseUrl).port));
    assert.equal(info.root, tmp, "--root is the working directory the child reports");
    assert.equal(existsSync(lockOf(tmp)), true, "the session lock lives under the root");

    const health = await fetch(`${info.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // The drift this segment pays: config resolves against cwd, so the state DB
    // follows `--root` and not the directory the shell happened to be in.
    assert.equal(
      existsSync(join(tmp, ".skyhook", "seeder-state.db")),
      true,
      "the state DB is written under the root",
    );
  } finally {
    assert.equal(await stop(side), 0, "a closed stdin is a clean exit");
  }

  assert.equal(existsSync(lockOf(tmp)), false, "close() removes the lock");
  await assert.rejects(
    () => fetch(`${info.baseUrl}/api/health`),
    "the port is no longer bound once the sidecar exits",
  );
});

test("sidecar: a second session on the same root is refused and says why", async () => {
  const first = startSidecar(tmp);
  const info = await first.info;

  try {
    const second = startSidecar(tmp);
    assert.equal(await stop(second), 1, "the loser exits non-zero");
    assert.match(second.stderr.join(""), /already running/);
    assert.equal((await fetch(`${info.baseUrl}/api/health`)).status, 200, "the winner still serves");
  } finally {
    await stop(first);
  }

  // The lock is gone with the winner, so the next launch is allowed.
  const third = startSidecar(tmp);
  assert.ok((await third.info).baseUrl);
  assert.equal(await stop(third), 0);
  assert.equal(existsSync(lockOf(tmp)), false);
});
