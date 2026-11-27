/**
 * config.test.mjs — a BOM in a hand-written JSON file is tolerated, not fatal.
 *
 * `skyhook.config.json` is the owner's to hand-edit and `.skyhook/settings.json`
 * is written by the GUI, so a leading U+FEFF — PowerShell 5.1's
 * `Set-Content -Encoding utf8`, VS Code's "UTF-8 with BOM" — is an artefact of
 * the editor, not a mistake in the file. `JSON.parse` refuses it, so before this
 * file existed a BOM aborted every command that read the config, and a BOM'd
 * settings file discarded every runtime toggle behind a silent `{}` (#21).
 *
 * The fixtures live under `.tmp-config-*` and the config is repointed at them,
 * so the repo's own `.skyhook/` is never read or written. The **root** is removed by
 * one `after()` hook, not by each test's own `rmSync`: a test that fails before its
 * cleanup line leaves the directory behind, which is how 76 `.tmp-config-*` roots
 * accumulated in this checkout (#22).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";
import { allowRemote, loadSettings } from "../src/core/settings.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, `.tmp-config-${process.pid}`);
const BOM = "\uFEFF";

// Recommended shape from `test/desktop-sidecar.test.mjs:31`: the root outlives every test and one
// hook removes it, so a red test cannot leak a fixture either.
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

test("loadConfig parses a skyhook.config.json that starts with a BOM", () => {
  const dir = join(tmp, "config");
  mkdirSync(dir, { recursive: true });
  const dataDir = join(dir, "data");
  const file = join(dir, "skyhook.config.json");
  writeFileSync(file, BOM + JSON.stringify({ dataDir, userAgent: "BOM/1.0" }) + "\n");

  const cfg = loadConfig({ file, reload: true });
  assert.equal(cfg.dataDir, dataDir, "the file's value survives the BOM");
  assert.equal(cfg.userAgent, "BOM/1.0", "the file is read, not discarded");
  assert.equal(cfg.storage.provider, "stage", "keys the file omits still come from the defaults");
});

test("loadSettings keeps a BOM'd settings.json instead of degrading to {}", () => {
  const dir = join(tmp, "settings");
  mkdirSync(dir, { recursive: true });
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, BOM + JSON.stringify({ allowRemote: true }) + "\n");
  const file = join(dir, "skyhook.config.json");
  writeFileSync(file, JSON.stringify({ dataDir: dir, settingsFile }) + "\n");
  loadConfig({ file, reload: true });

  assert.deepEqual(loadSettings(), { allowRemote: true });
  assert.equal(allowRemote(), true, "a runtime toggle in a BOM'd file still wins");
});

test(".env.example lists the keys and carries no value", () => {
  const file = join(process.cwd(), ".env.example");
  assert.ok(existsSync(file), ".env.example is the tracked list of the keys .env may set");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const keys = [];
  for (const [i, line] of lines.entries()) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(text);
    assert.ok(match, `.env.example:${i + 1} is neither a comment nor KEY=value: ${text}`);
    assert.equal(match[2], "", `.env.example:${i + 1} must carry no value — ${match[1]} would ship a secret`);
    keys.push(match[1]);
  }
  // The four surfaces the config rules name, plus the two credentials a
  // database provider needs. A key that is read by src/ but missing here is a
  // reader who cannot find it.
  for (const key of [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "POSTGRES_URL", "DATABASE_URL",
    "SKYHOOK_REMOTE_TOKEN", "FLARESOLVERR_ENABLED", "FLARESOLVERR_URL",
    "FLARESOLVERR_EXE", "FLARESOLVERR_PORT",
  ]) {
    assert.ok(keys.includes(key), `.env.example documents ${key}`);
  }
});

// #23: an invalid `skyhook.config.json` used to reach the top of `bin/skyhook.js` as an unhandled
// rejection — a stack, a `UnhandledPromiseRejection` banner and exit 1 — so the one line that says
// what is wrong was buried in nine. The child is spawned with `SKYHOOK_DEBUG` cleared, because a
// developer's own environment must not decide what this test sees.
test("the CLI answers a broken config with one line and exit 1", () => {
  const dir = join(tmp, "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skyhook.config.json"), "{ this is not json\n");

  const res = spawnSync(process.execPath, [join(root, "bin", "skyhook.js"), "list"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SKYHOOK_DEBUG: "" },
  });

  assert.equal(res.status, 1, `a failed command exits 1 (stderr: ${res.stderr})`);
  const lines = res.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `one line, not a stack — got:\n${res.stderr}`);
  assert.match(lines[0], /^Invalid config .*skyhook\.config\.json/);
  assert.equal(res.stdout, "", "nothing is written to stdout");
});
