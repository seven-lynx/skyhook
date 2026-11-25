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
 * so the repo's own `.skyhook/` is never read or written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";
import { allowRemote, loadSettings } from "../src/core/settings.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, `.tmp-config-${process.pid}`);
const BOM = "\uFEFF";

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

  rmSync(dir, { recursive: true, force: true });
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

  rmSync(dir, { recursive: true, force: true });
});
