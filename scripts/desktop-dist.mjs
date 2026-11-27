#!/usr/bin/env node
/**
 * desktop-dist.mjs — `npm run desktop:dist`: fetch the pinned runtime, build the NSIS
 * bundle, and put the release artifacts where the release steps name them.
 *
 * Four things this wrapper owns that a bare `tauri build` does not:
 *
 * 1. The runtime comes first. `tauri.conf.json`'s `beforeBuildCommand` also runs the
 *    fetch, but a `tauri build` started from a stale checkout is exactly the case D8
 *    exists to catch, and the fetch is a no-op when the pinned binary is present.
 * 2. Tauri writes the bundle to `src-tauri/target/release/bundle/nsis/`, while
 *    `dist/desktop/` is the path `.gitignore` and the release steps name. The copy is
 *    the difference between a path the docs quote and a path a reader has to guess.
 * 3. Signing of the *updater* artifact happens inside `tauri build` and needs
 *    `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`). Without it the build fails with a
 *    Tauri error; this names the key instead, and refuses before the long build rather
 *    than after it.
 * 4. `latest.json` is written from the artifacts on disk — the version from
 *    `tauri.conf.json`, the signature from the `.sig` the build produced, the URL from
 *    the tag it will be published under. An installed copy updates from that file, so a
 *    Release without it strands everyone who installed the previous version.
 *
 * Authenticode is still not here: that is D8b's half and needs the certificate route
 * in `PLAN.md` §6 item 11. This script says so instead of implying a signed installer.
 *
 *   npm run desktop:dist
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { ensureSidecar } from "./fetch-sidecar.mjs";
import { latestManifest } from "./latest-json.mjs";
import { stageDesktopApp } from "./stage-desktop-app.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
const OUT = join(ROOT, "dist", "desktop");
const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");
const RELEASES = "https://github.com/seven-lynx/skyhook/releases/download";

/** Refuse before the build, not after it, when the updater key is missing. */
function requireSigningKey() {
  if (!String(process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim()) {
    throw new Error(
      "no updater signing key: set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD " +
        "(the minisign key, never committed; `cargo tauri signer generate -w <path>` makes one and " +
        "its public half is `plugins.updater.pubkey` in src-tauri/tauri.conf.json)",
    );
  }
}

/**
 * The two artifact families the build produces: the installer a person runs, and the
 * `.nsis.zip` the updater downloads. Both are globbed because Tauri names them from
 * `productName` and `version`, and a hard-coded name is wrong on the next bump.
 */
function bundleArtifacts() {
  const files = readdirSync(BUNDLE);
  return {
    installers: files.filter((file) => file.endsWith(".exe")),
    updaterZips: files.filter((file) => file.endsWith(".nsis.zip")),
  };
}

/** `latest.json`, from the signature the build wrote and the tag the release will use. */
function writeLatestJson(version, zipName) {
  const signatureFile = join(BUNDLE, `${zipName}.sig`);
  if (!existsSync(signatureFile)) {
    throw new Error(`no signature beside ${zipName}: the build did not sign the updater artifact`);
  }
  const manifest = latestManifest({
    version,
    signature: readFileSync(signatureFile, "utf8"),
    url: `${RELEASES}/v${version}/${zipName}`,
    pubDate: new Date(),
  });
  const file = join(OUT, "latest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`✓ ${relative(ROOT, file)} -> ${manifest.platforms["windows-x86_64"].url}`);
}

async function main() {
  requireSigningKey();
  const runtime = await ensureSidecar();
  console.log(`desktop:dist: sidecar ${runtime.fetched ? "fetched" : "cached"}`);

  // The app the sidecar runs, staged under the pinned runtime so `better-sqlite3`'s
  // prebuild matches the Node the installer ships (see stage-desktop-app.mjs).
  stageDesktopApp();

  // `cargo install tauri-cli` installs `cargo-tauri.exe`, so the command is `cargo tauri`,
  // not `tauri` — the spelling Q5's default produces. Both are real executables on PATH, so
  // no command interpreter is involved and nothing from the environment is re-parsed.
  const build = spawnSync("cargo", ["tauri", "build"], { stdio: "inherit", windowsHide: true });
  if (build.error) {
    throw new Error(`cannot run cargo (${build.error.message}) — the Rust toolchain is not on PATH`);
  }
  if (build.status !== 0) {
    throw new Error(
      `cargo tauri build exited ${build.status} — cargo install tauri-cli --version "^2" --locked if the subcommand is missing`,
    );
  }

  const { installers, updaterZips } = bundleArtifacts();
  if (installers.length === 0) throw new Error(`no installer in ${relative(ROOT, BUNDLE)}`);
  if (updaterZips.length === 0) {
    throw new Error(
      `no .nsis.zip in ${relative(ROOT, BUNDLE)} — bundle.createUpdaterArtifacts is what produces the updater archive`,
    );
  }

  mkdirSync(OUT, { recursive: true });
  for (const file of [...installers, ...updaterZips]) {
    copyFileSync(join(BUNDLE, file), join(OUT, file));
    console.log(`✓ ${relative(ROOT, join(OUT, file))}`);
  }

  const { version } = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  writeLatestJson(version, updaterZips[0]);

  console.log("\nUnsigned installer: Authenticode is D8b's half (PLAN.md §6 item 11).");
}

main().catch((err) => {
  console.error(`desktop:dist: ${err.message}`);
  process.exit(1);
});

