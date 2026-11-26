#!/usr/bin/env node
/**
 * stage-desktop-app.mjs — assemble the Node application an installed build runs.
 *
 * `desktop/server.js` is a twenty-line wrapper, but it imports `src/interfaces/app-session.js`
 * and that pulls in the whole server: `src/`, the shipped `config/` taxonomy and prompts,
 * and the runtime dependencies. The installer therefore ships the application, not two
 * scripts — a distinction D3's "~20 lines on top of app-session" hid, and the first
 * installed build proved by dying on `ERR_MODULE_NOT_FOUND`.
 *
 * Three properties are deliberate:
 *
 * 1. Dependencies are installed by **the pinned runtime**, not by whatever `node` runs this
 *    script. `better-sqlite3` is a native module whose prebuild is chosen from the ABI of
 *    the process that installs it, and CI tests under Node 24 while the app ships Node 20
 *    — so staging through `src-tauri/binaries/*.exe` is what makes the shipped ABI the one
 *    the app runs. The preflight at the end loads it, so a mismatch fails the build here
 *    rather than on a user's first launch.
 * 2. `--omit=dev` keeps `sharp` (an icon-build devDependency) out; optional providers stay
 *    in, so `pg` and `@supabase/supabase-js` still work, and only Playwright's browser
 *    download is skipped — the headless tier already degrades with a one-line hint.
 * 3. The layout is the repository's own (`app/desktop/server.js`, `app/src/…`), so module
 *    resolution inside the installed tree is the same graph `npm test` measured.
 *
 *   node scripts/stage-desktop-app.mjs
 */
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = join(ROOT, "dist", "desktop", "app");
const SIDECAR_PIN = join(ROOT, "desktop", "sidecar.json");

/** The pinned runtime, or a refusal that names what to run first. */
function pinnedNode() {
  const pin = JSON.parse(readFileSync(SIDECAR_PIN, "utf8"));
  const exe = join(ROOT, "src-tauri", "binaries", `${pin.externalBin.split("/").pop()}-${pin.targetTriple}.exe`);
  if (!existsSync(exe)) {
    throw new Error(`${relative(ROOT, exe)} is missing — run \`npm run sidecar:fetch\` first`);
  }
  return exe;
}

/** npm's own CLI, resolved from the shim on PATH so it is the npm the developer uses. */
function npmCli() {
  const shim = spawnSync("where.exe", ["npm.cmd"], { encoding: "utf8", windowsHide: true });
  const first = String(shim.stdout ?? "").split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) throw new Error("no npm.cmd on PATH");
  const cli = join(dirname(first.trim()), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli)) throw new Error(`cannot find ${cli} — the npm shim and its package disagree`);
  return cli;
}

/** Every regular file under `dir`, so the summary can state what the installer carries. */
function bytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += bytes(full);
    else if (statSync(full).isFile()) total += statSync(full).size;
  }
  return total;
}

/** Debug/link by-products `node-gyp` leaves behind; nothing loads them at runtime. */
const BUILD_ARTIFACTS = /\.(pdb|iobj|ipdb|obj|ilk|lib|exp)$/i;

/** Strip `node-gyp`'s intermediates, which would otherwise ride inside the installer. */
function pruneBuildArtifacts(dir, log) {
  let removed = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "obj") {
          rmSync(full, { recursive: true, force: true });
          removed += 1;
        } else {
          walk(full);
        }
      } else if (BUILD_ARTIFACTS.test(entry.name)) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
  };
  walk(dir);
  log(`stage: pruned ${removed} build intermediate(s)`);
}

/**
 * Build `dist/desktop/app` and return its path.
 *
 * Rebuilt from scratch every time: a stale `node_modules` from a different Node major is
 * exactly the failure this function exists to prevent, and it is invisible once copied.
 */
export function stageDesktopApp({ log = console.log } = {}) {
  const node = pinnedNode();

  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });

  // The runtime tree, exactly as the repository lays it out.
  for (const name of ["desktop", "src", "config"]) {
    cpSync(join(ROOT, name), join(APP_DIR, name), { recursive: true });
  }
  for (const name of ["package.json", "package-lock.json"]) {
    cpSync(join(ROOT, name), join(APP_DIR, name));
  }

  // A marker the preflight can read back: which runtime staged this tree.
  writeFileSync(
    join(APP_DIR, "SIDECAR-RUNTIME.json"),
    `${JSON.stringify({ stagedBy: node, node: process.versions.node }, null, 2)}\n`,
  );

  // npm runs `prebuild-install` through a `.bin` shim, and a shim with no `node.exe`
  // beside it falls back to the `node` on PATH — the machine's Node 24, whose ABI-137
  // prebuild the installed Node 20 cannot load. Putting the pinned runtime first is what
  // makes the staged ABI the shipped ABI, and it is the difference between a build that
  // fails here and an app that dies on a user's first database call.
  const runtimeDir = join(ROOT, "dist", "desktop", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const nodeOnPath = join(runtimeDir, "node.exe");
  cpSync(node, nodeOnPath);

  log("stage: npm ci --omit=dev under the pinned runtime");
  const install = spawnSync(nodeOnPath, [npmCli(), "ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: APP_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${runtimeDir};${process.env.PATH ?? ""}`,
      Path: `${runtimeDir};${process.env.Path ?? process.env.PATH ?? ""}`,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  });
  if (install.error) throw new Error(`cannot run npm under the pinned runtime: ${install.error.message}`);
  if (install.status !== 0) throw new Error(`npm ci exited ${install.status} in ${relative(ROOT, APP_DIR)}`);

  // Load the native module that decides the ABI, in the tree that was just staged.
  const preflight = spawnSync(
    nodeOnPath,
    ["-e", "const D=require('better-sqlite3'); new D(':memory:').close(); process.stdout.write(process.versions.modules);"],
    { cwd: APP_DIR, encoding: "utf8", windowsHide: true },
  );
  if (preflight.error || preflight.status !== 0) {
    throw new Error(
      `better-sqlite3 does not load under the pinned runtime (ABI ${process.versions.modules} here): ${String(
        preflight.stderr ?? preflight.error?.message ?? "",
      ).trim()}`,
    );
  }

  // `node-gyp` leaves ~40 MB of debug and link by-products behind; nothing loads them.
  pruneBuildArtifacts(APP_DIR, log);

  const sizeMb = (bytes(APP_DIR) / 1024 / 1024).toFixed(1);
  log(`stage: ${relative(ROOT, APP_DIR)} (${sizeMb} MB, ABI ${String(preflight.stdout).trim()})`);
  return APP_DIR;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    stageDesktopApp();
  } catch (err) {
    console.error(`stage: ${err.message}`);
    process.exit(1);
  }
}
