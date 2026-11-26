#!/usr/bin/env node
/**
 * fetch-sidecar.mjs — put the pinned `node.exe` where the bundle expects the sidecar.
 *
 * Tauri's `externalBin` is a real executable, not a reference: `tauri build` needs
 * `src-tauri/binaries/skyhook-sidecar-<triple>.exe` on disk before it runs, and what
 * that file must contain is the runtime `desktop/sidecar.json` pins (DC6 — a stock
 * `node.exe` 20.x, never the user's Node, never `ELECTRON_RUN_AS_NODE`).
 *
 * Four properties are deliberate:
 *
 * 1. The pin is the authority and nodejs.org's own `SHASUMS256.txt` is the second
 *    source. The download is hashed and compared against both, and a mismatch fails
 *    the build instead of shipping a runtime nobody verified.
 * 2. The archive is unpacked with `tar` — bsdtar, present since Windows 10 — rather
 *    than a zip package: no dependency is added for a build step (`10-node.md`).
 * 3. Extraction happens in `%TEMP%` and the result is renamed into place, so an
 *    interrupted run can never leave a truncated `node.exe` that a later run, which
 *    skips an existing file, would happily package.
 * 4. The pieces that decide whether a download is accepted are pure functions of
 *    their inputs, because `test/desktop-dist.test.mjs` proves the refusals with no
 *    network and no 30 MB download.
 *
 *   node scripts/fetch-sidecar.mjs [--force]
 */
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The pin this script reads; exported so a test builds a fixture tree from it. */
export const MANIFEST = join("desktop", "sidecar.json");

/** Hex SHA-256 of a buffer — the only hash nodejs.org publishes for a release. */
export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * The hash `SHASUMS256.txt` lists for `artifact`, or `null` when it does not list it.
 *
 * The file is one `<hash>  <name>` line per artifact, and the name carries a `*` when
 * the entry marks a binary-mode checksum — hence the optional asterisk.
 */
export function shasumFor(text, artifact) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name?.replace(/^\*/, "") === artifact && /^[0-9a-f]{64}$/i.test(hash ?? "")) {
      return hash.toLowerCase();
    }
  }
  return null;
}

/**
 * Where the bundle wants the runtime, derived from the pin rather than restated: the
 * `externalBin` entry plus the target triple is the file name Tauri documents.
 */
export function expectedSidecar(pin, root = ROOT) {
  const name = `${basename(pin.externalBin)}-${pin.targetTriple}.exe`;
  return { name, path: join(root, "src-tauri", dirname(pin.externalBin), name) };
}

/**
 * Every reason to refuse the download, or `[]` when it may be packaged.
 *
 * `published` is `null` when nodejs.org's list is reachable but silent about this
 * artifact, and `actual` is omitted when only the pin and the published list are being
 * compared — the one call the CLI makes before it extracts anything.
 */
export function pinProblems({ pin, published, actual }) {
  const problems = [];
  if (!/^[0-9a-f]{64}$/.test(String(pin?.sha256 ?? ""))) {
    problems.push(`${MANIFEST} has no usable sha256 for ${pin?.artifact}`);
  }
  if (published === null) {
    problems.push(`nodejs.org's SHASUMS256.txt does not list ${pin?.artifact}`);
  } else if (published !== undefined && published !== pin.sha256) {
    problems.push(`nodejs.org publishes ${published} for ${pin.artifact}, the pin says ${pin.sha256}`);
  }
  if (actual !== undefined && actual !== pin.sha256) {
    problems.push(`the download hashes to ${actual}, the pin says ${pin.sha256}`);
  }
  return problems;
}

/** `tar -xf`, with the bounded result and the error handler every spawn owes (`10-node.md`). */
function untar(archive, into) {
  const result = spawnSync("tar", ["-xf", archive, "-C", into], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot unpack ${basename(archive)}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`tar exited ${result.status}: ${String(result.stderr ?? "").trim()}`);
  }
}

/** The first `node.exe` under `dir` — the archive nests it in a versioned folder. */
function findNodeExe(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findNodeExe(full);
      if (found) return found;
    } else if (entry.name === "node.exe") {
      return full;
    }
  }
  return null;
}

/**
 * Fetch, verify and place the pinned runtime; return where it landed.
 *
 * `fetchImpl`, `unpack` and `log` are injected so the refusals are testable offline,
 * and an already-present binary short-circuits unless `force`: the build calls this on
 * every run, and a 30 MB download per build is not a step anyone keeps.
 */
export async function ensureSidecar({
  root = ROOT,
  force = false,
  fetchImpl = globalThis.fetch,
  unpack = untar,
  log = console.log,
} = {}) {
  const pin = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const target = expectedSidecar(pin, root);

  if (!force && existsSync(target.path)) {
    log(`sidecar: ${relative(root, target.path)} is already in place (Node ${pin.node}) — --force to refetch`);
    return { path: target.path, fetched: false };
  }

  const download = async (name) => {
    const url = `${pin.source}${name}`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  log(`sidecar: fetching ${pin.source}${pin.artifact} (Node ${pin.node}, ${pin.platform})`);
  const archive = await download(pin.artifact);
  const shasums = await download("SHASUMS256.txt");
  const actual = sha256(archive);
  const problems = pinProblems({
    pin,
    published: shasumFor(shasums.toString("utf8"), pin.artifact),
    actual,
  });
  if (problems.length) {
    throw new Error(`refusing to ship an unverified runtime:\n  ${problems.join("\n  ")}`);
  }

  const work = mkdtempSync(join(tmpdir(), "skyhook-sidecar-"));
  try {
    const file = join(work, pin.artifact);
    writeFileSync(file, archive);
    unpack(file, work);
    const extracted = findNodeExe(work);
    if (!extracted) throw new Error(`${pin.artifact} holds no node.exe`);

    mkdirSync(dirname(target.path), { recursive: true });
    const staged = `${target.path}.part`;
    copyFileSync(extracted, staged);
    renameSync(staged, target.path);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  log(`sidecar: ${relative(root, target.path)} (Node ${pin.node}, sha256 ${pin.sha256})`);
  return { path: target.path, fetched: true };
}

// An importer (desktop-dist.mjs, the test) gets the functions; only a direct run fetches.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureSidecar({ force: process.argv.includes("--force") }).catch((err) => {
    console.error(`sidecar: ${err.message}`);
    process.exit(1);
  });
}
