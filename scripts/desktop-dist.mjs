#!/usr/bin/env node
/**
 * desktop-dist.mjs — `npm run desktop:dist`: fetch the pinned runtime, build the NSIS
 * bundle, and put the installer where the verify line looks for it.
 *
 * Three things this wrapper owns that a bare `tauri build` does not:
 *
 * 1. The runtime comes first. `tauri.conf.json`'s `beforeBuildCommand` also runs the
 *    fetch, but a `tauri build` started from a stale checkout is exactly the case D8
 *    exists to catch, and the fetch is a no-op when the pinned binary is present.
 * 2. Tauri writes the installer to `src-tauri/target/release/bundle/nsis/`, while
 *    `dist/desktop/` is the path `.gitignore` and the release steps name. The copy is
 *    the difference between a path the docs quote and a path a reader has to guess.
 * 3. Signing is not here. Authenticode is D8b's half and needs the certificate route
 *    in `PLAN.md` §6 item 11; this script says so instead of implying a signed build.
 *
 *   npm run desktop:dist
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { ensureSidecar } from "./fetch-sidecar.mjs";
import { stageDesktopApp } from "./stage-desktop-app.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
const OUT = join(ROOT, "dist", "desktop");

async function main() {
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

  if (!existsSync(BUNDLE)) throw new Error(`no bundle directory at ${relative(ROOT, BUNDLE)}`);
  const installers = readdirSync(BUNDLE).filter((file) => file.endsWith(".exe"));
  if (installers.length === 0) throw new Error(`no installer in ${relative(ROOT, BUNDLE)}`);

  mkdirSync(OUT, { recursive: true });
  for (const file of installers) {
    copyFileSync(join(BUNDLE, file), join(OUT, file));
    console.log(`✓ ${relative(ROOT, join(OUT, file))}`);
  }

  console.log("\nUnsigned: Authenticode is D8b's half (PLAN.md §6 item 11).");
}

main().catch((err) => {
  console.error(`desktop:dist: ${err.message}`);
  process.exit(1);
});
