/**
 * desktop-guard.test.mjs — the five ways a desktop build could stop being the
 * build CI tested, checked instead of trusted.
 *
 * A desktop release is two processes written in two languages, and the failures
 * that matter are quiet: a `src/core` import in the sidecar drags a config- and
 * ABI-dependent tier into the child the shell spawned; one extra capability
 * hands the renderer an IPC surface nothing needs; a sidecar pinned to a Node
 * major CI never runs means `npm test` measured a different runtime than the one
 * that ships. Each family is asserted against the real tree, and each rule is
 * also fed the input it exists to reject, because a guard that only ever sees
 * healthy files is indistinguishable from no guard at all.
 *
 * The fourth family has no runtime to observe: the token handshake spans Rust that
 * is never compiled on this machine and a renderer that never runs in CI, so it is
 * read as wiring in the two files that carry it — and both files are also fed a
 * copy with one half removed. It is a wiring check, not a parser.
 *
 * The fifth family is that same shape one layer out: what the window is *allowed to
 * be*. A renderer still offering a browser's affordances, and a shell that lets a
 * link navigate the window off the sidecar's origin, are read as wiring in the two
 * files that carry them — `index.html` is read only to prove the manifest skip still
 * has something to skip.
 *
 * The import scan reads module *specifiers*, not raw text: `desktop/server.js`
 * names `better-sqlite3` in its docblock precisely to say it never imports it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "desktop");
const capabilitiesDir = join(root, "src-tauri", "capabilities");
const sidecarManifest = join(desktopDir, "sidecar.json");
const ciWorkflow = join(root, ".github", "workflows", "ci.yml");
const shellMain = join(root, "src-tauri", "src", "main.rs");
const sidecarSchedule = join(desktopDir, "schedule.js");
const tauriConfig = join(root, "src-tauri", "tauri.conf.json");
const packageManifest = join(root, "package.json");
const distWrapper = join(root, "scripts", "desktop-dist.mjs");
const stageScript = join(root, "scripts", "stage-desktop-app.mjs");
const latestJsonScript = join(root, "scripts", "latest-json.mjs");
const guiApp = join(root, "src", "gui", "app.js");
const guiHtml = join(root, "src", "gui", "index.html");

/** Every file under `dir` whose name ends with `ext`, as absolute paths. */
function filesWith(dir, ext) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesWith(full, ext));
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

/**
 * The module specifiers a source names: a static `from "…"`, a bare `import "…"`,
 * a dynamic `import("…")` and a CJS `require("…")`.
 *
 * Specifiers and not the whole text, because a docblock that explains why a tier
 * is *not* imported would otherwise read as an import.
 */
function specifiersOf(source) {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(?\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/**
 * Why a specifier is refused in the sidecar, or `null` when it is allowed.
 *
 * `../src/interfaces/` is the whole permitted surface — the child starts an app
 * session and announces its URL. `src/core`, `src/engine` and `src/adapters` are
 * the tiers that read the config, open the state DB and hold the vendor clients;
 * the sidecar reaches them through the server, never by name.
 */
const NODE_TIERS = /(^|\/)src\/(core|engine|adapters)(\/|$)/;

function forbiddenSpecifier(spec) {
  if (spec === "better-sqlite3" || spec.startsWith("better-sqlite3/")) {
    return `imports ${spec} directly`;
  }
  if (NODE_TIERS.test(spec)) return `reaches into ${spec}`;
  return null;
}

/**
 * The plugin prefixes the shell may ask for at all.
 *
 * `core` is the window itself, `opener` is the one verb the window needs — hand an
 * `http(s)` link to the system browser — and `autostart` is the *Start with
 * Windows* toggle, a per-user Run entry the app writes (`PLAN.md` §6 item 9).
 */
const ALLOWED_PERMISSIONS = ["core:", "opener:", "autostart:"];

/**
 * Every way a capability file could grant the renderer more than it needs, or
 * `[]` when it stays inside the shell's actual requirement.
 *
 * The renderer is a webview on the sidecar's own origin, so it talks HTTP and
 * asks for no IPC: `fs:` would let a page script write the user's disk,
 * `shell:allow-execute` would spawn whatever it named, and `remote.urls` would
 * open that IPC to an origin the shell did not ship. Beyond those three named
 * holes the set is an allow-list — `core`, `opener` and `autostart` — so a fourth
 * plugin's permission has to be argued for here rather than slipping in.
 */
function capabilityViolations(capability) {
  const violations = [];
  for (const permission of capability.permissions ?? []) {
    const id = typeof permission === "string" ? permission : (permission?.identifier ?? "");
    if (id.startsWith("fs:")) violations.push(`grants ${id}`);
    if (id.startsWith("shell:allow-execute")) violations.push(`grants ${id}`);
    if (id && !ALLOWED_PERMISSIONS.some((prefix) => id.startsWith(prefix))) {
      violations.push(`grants ${id}, which is not core, opener or autostart`);
    }
  }
  if (capability.remote?.urls?.length) {
    violations.push(`allow-lists ${capability.remote.urls.join(", ")}`);
  }
  return violations;
}

/** The major of a `20`, `20.x` or `20.20.2` pin, or `null` when it has no number. */
function majorOf(version) {
  const match = /^v?(\d+)/.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * Every Node major `ci.yml` tests on.
 *
 * `node-version:` takes one value, and a matrix leg is written as
 * `matrix: node: [22, 24]` with `node-version: ${{ matrix.node }}` — which has
 * no number in it at all, so the matrix list is read separately. The workflow is
 * the only place the tested runtime is recorded, so it is read, never restated.
 */
function ciNodeMajors(yaml) {
  const majors = [];
  for (const match of yaml.matchAll(/node-version:\s*([^\n#]+)/g)) {
    for (const raw of match[1].replace(/[[\]"']/g, "").split(",")) {
      const major = majorOf(raw);
      if (major !== null) majors.push(major);
    }
  }
  for (const match of yaml.matchAll(/^\s*node:\s*\[([^\]]+)\]/gm)) {
    for (const raw of match[1].split(",")) {
      const major = majorOf(raw.replace(/["'\s]/g, ""));
      if (major !== null) majors.push(major);
    }
  }
  return [...new Set(majors)];
}

/**
 * The halves of the desktop token handshake, read from the two files that carry
 * them: the shell hands its launch token to the sidecar (`.env`), injects the same
 * value into the window (`initialization_script`), and the renderer sends it back
 * as a bearer header.
 *
 * The shapes are matched rather than the names: the injected script's exact
 * literal, and `headers.Authorization` in the one function that builds them, so a
 * docblock that merely mentions a flag does not read as wiring.
 */
function tokenWiring(mainRs, appJs) {
  return {
    toSidecar: /\.env\(\s*"SKYHOOK_REMOTE_TOKEN"/.test(mainRs),
    toWindow:
      mainRs.includes(".initialization_script(")
      && mainRs.includes("\"window.__SKYHOOK_DESKTOP__ = {};\""),
    fromWindow: /headers\.Authorization/.test(appJs) && appJs.includes("__SKYHOOK_DESKTOP__"),
  };
}

/**
 * The halves of "this window is the app, not a browser tab", read from the two files
 * that carry them. A shell window has one server — the one it spawned — cannot
 * install a PWA, and must not be navigated off the sidecar's origin: so the API-base
 * affordances go, the manifest link goes, and an `http(s)` link out belongs to the
 * system browser.
 *
 * `handsLinksOut` is Rust nothing on this machine compiles and the renderer flags are
 * matched as strings, which makes this a stand-in for `npm run desktop` — the one
 * verification D6 cannot get from a toolchain it does not have. The second test
 * removes each limb to prove the wiring check can fail.
 */
function desktopChrome(mainRs, appJs) {
  return {
    handsLinksOut: mainRs.includes(".on_navigation(") && mainRs.includes("open_url("),
    hidesApiButton: appJs.includes('$("#apiBaseBtn")?.remove()'),
    ignoresStoredBase: appJs.includes("if (isDesktop()) return window.location.origin;"),
    hidesSettingsField: appJs.includes("const apiEndpoint = isDesktop()"),
    skipsManifest: appJs.includes("document.querySelector('link[rel=\"manifest\"]')?.remove()"),
  };
}

/**
 * The halves of "the app is the scheduler on Windows", read from the four files
 * that carry them.
 *
 * The tick lives in `desktop/schedule.js` because a Node module is the half a test
 * can drive; the shell's half is a per-user Run entry behind the *Start with
 * Windows* check item, and no toolchain here compiles it. So both are matched as
 * wired shapes and every limb is also fed a copy with it removed — the same
 * stand-in `npm run desktop` gets, for the same reason.
 */
function scheduleWiring({ serverJs, scheduleJs, mainRs, capability }) {
  const permissions = (capability.permissions ?? []).map((permission) =>
    typeof permission === "string" ? permission : (permission?.identifier ?? ""),
  );
  return {
    startsInSidecar: serverJs.includes("startSchedule({") && /schedule\??\.tick\(\)/.test(serverJs),
    stopsWithServer: /schedule\??\.stop\(\)/.test(serverJs),
    pollsDueSet:
      scheduleJs.includes('"/api/running"')
      && scheduleJs.includes('"/api/due"')
      && scheduleJs.includes('"/api/run"'),
    neverOverlapsRun: scheduleJs.includes('skipped: "running"'),
    autostartToggle:
      mainRs.includes('"Start with Windows"')
      && mainRs.includes("CheckMenuItem::with_id")
      && mainRs.includes(".autolaunch()"),
    autostartAllowed: permissions.includes("autostart:default"),
  };
}

/**
 * Whether a workflow is *started* by a version-tag push — its `on:` header, read
 * before the first `jobs:` line.
 *
 * A different question from the `if:` guard: `desktop` is guarded to `refs/tags/v`,
 * but a push carries its tags only when `on.push` names them, so a header with
 * `branches` alone leaves that job unreachable while the guard still reads correct
 * (#35). Only the header counts — a `tags:` inside a step's `with:` starts nothing.
 */
function tagTriggered(yaml) {
  const header = String(yaml).split(/^jobs:\s*$/m)[0] ?? "";
  return (
    /^\s*push:\s*$/m.test(header)
    && (/^\s*tags:\s*\[[^\]]*\bv/m.test(header) || /^\s*tags:\s*\n\s*-\s*["']?v/m.test(header))
  );
}

/**
 * The halves of "a fresh checkout produces an installer", read from the five files that
 * carry them: the pin, the bundle config, the npm script that wraps the build, the
 * wrapper itself, and the workflow that builds it on CI.
 *
 * This family has the least to observe on a machine without Rust — no installer is built
 * here — so what is asserted is that each piece is wired to the next: the runtime present
 * under the name `externalBin` requires, the sidecar script shipped as a resource (an
 * installed window has no checkout to fall back to), the fetch running before `tauri
 * build`, the release build refusing the machine's own Node, the CI job guarded to a
 * tag so the installer never becomes a pull-request gate, and that tag push actually
 * starting the workflow.
 */
function distWiring({ pin, tauriConf, packageJson, distScript, stageScript, ciYaml, mainRs }) {
  const bundle = tauriConf.bundle ?? {};
  const externalBin = Array.isArray(bundle.externalBin) ? bundle.externalBin : [];
  const resources = Object.keys(bundle.resources ?? {}).map((key) => key.replace(/\\/g, "/"));
  return {
    sidecarBundled: externalBin.includes(pin.externalBin),
    appShippedAsResource: resources.some((key) => key.endsWith("dist/desktop/app")),
    fetchesBeforeBuild: String(tauriConf.build?.beforeBuildCommand ?? "").includes("fetch-sidecar"),
    distScriptBuilds:
      String(packageJson.scripts?.["desktop:dist"] ?? "").includes("desktop-dist.mjs")
      && distScript.includes('spawnSync("cargo", ["tauri", "build"]'),
    appStaged:
      distScript.includes("import { stageDesktopApp }")
      && distScript.includes("stageDesktopApp();")
      && stageScript.includes('"ci"')
      && stageScript.includes("--omit=dev"),
    bundledRuntime: mainRs.includes("let runtime = bundled_runtime();") && mainRs.includes("cfg!(debug_assertions)"),
    plainPaths: mainRs.includes("fn plain_path(") && mainRs.includes("plain_path(&packaged)"),
    tagOnlyJob:
      ciYaml.includes("windows-latest")
      && /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(ciYaml),
    tagTrigger: tagTriggered(ciYaml),
  };
}

test("guard: no desktop module reaches a core, engine or adapter tier", () => {
  const files = filesWith(desktopDir, ".js");
  assert.ok(
    files.some((file) => file.endsWith("server.js")),
    "the walk found the sidecar entry — an empty walk would pass vacuously",
  );

  const offenders = [];
  for (const file of files) {
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const why = forbiddenSpecifier(spec);
      if (why) offenders.push(`${relative(root, file)} ${why}`);
    }
  }
  assert.deepEqual(offenders, [], "the sidecar imports interfaces, never a tier");
});

test("guard: the tier rule refuses the import that would break the shell", () => {
  assert.match(forbiddenSpecifier("../src/core/db.js"), /src\/core/);
  assert.match(forbiddenSpecifier("../src/engine/seeder-engine.js"), /src\/engine/);
  assert.match(forbiddenSpecifier("../src/adapters/storage/index.js"), /src\/adapters/);
  assert.match(forbiddenSpecifier("better-sqlite3"), /better-sqlite3/);

  assert.equal(forbiddenSpecifier("../src/interfaces/app-session.js"), null);
  assert.equal(forbiddenSpecifier("path"), null);

  // The shapes matter as much as the names: a dynamic import and a docblock.
  assert.deepEqual(specifiersOf('const m = await import("../src/engine/due.js");'), [
    "../src/engine/due.js",
  ]);
  assert.deepEqual(specifiersOf('import { resolve } from "path";'), ["path"]);
  assert.deepEqual(specifiersOf("// named only to say it is never imported: src/core/seed.js"), []);
});

test("guard: every capability stays inside core, opener and autostart", () => {
  const files = filesWith(capabilitiesDir, ".json");
  assert.ok(files.length > 0, "src-tauri/capabilities/ has a capability to check");

  const offenders = [];
  for (const file of files) {
    const capability = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(capability.identifier, "default", `${relative(root, file)} is the shell's only set`);
    for (const violation of capabilityViolations(capability)) {
      offenders.push(`${relative(root, file)} ${violation}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("guard: the capability rule refuses fs, shell-execute and remote origins", () => {
  assert.deepEqual(
    capabilityViolations({ permissions: ["core:default", "opener:default", "autostart:default"] }),
    [],
    "the three the shell actually uses",
  );
  assert.match(
    capabilityViolations({ permissions: ["core:default", "fs:allow-read"] }).join(" "),
    /fs:allow-read/,
  );
  assert.match(
    capabilityViolations({ permissions: ["shell:allow-execute"] }).join(" "),
    /shell:allow-execute/,
  );
  assert.match(
    capabilityViolations({ permissions: ["core:default"], remote: { urls: ["https://example.com"] } }).join(" "),
    /example\.com/,
  );

  // A fourth plugin's permission is argued for in this file, or not granted at all.
  assert.match(
    capabilityViolations({ permissions: ["core:default", "clipboard:allow-read"] }).join(" "),
    /clipboard:allow-read/,
  );
});

test("guard: the sidecar's Node major is the major CI runs", () => {
  assert.ok(existsSync(sidecarManifest), "desktop/sidecar.json pins the runtime the installer ships");
  const pin = JSON.parse(readFileSync(sidecarManifest, "utf8"));
  const majors = ciNodeMajors(readFileSync(ciWorkflow, "utf8"));

  assert.ok(majors.length > 0, "ci.yml names the Node it tests on");
  assert.equal(pin.platform, "win-x64", "the installer is a Windows x64 bundle");
  assert.match(pin.sha256, /^[0-9a-f]{64}$/, "D8 verifies the download against this");
  assert.ok(
    pin.artifact.includes(`v${pin.node}`),
    `${pin.artifact} is the artifact of the pinned ${pin.node}`,
  );
  assert.ok(
    majors.includes(majorOf(pin.node)),
    `the sidecar is pinned to Node ${pin.node}, which CI never runs (${majors.join(", ")})`,
  );
});

test("guard: the pin rule reads a version and spots the drift", () => {
  assert.deepEqual(ciNodeMajors("node-version: 20"), [20]);
  assert.deepEqual(ciNodeMajors('node-version: ["20", "22"]'), [20, 22]);
  assert.equal(majorOf("22.0.0"), 22);
  assert.equal(majorOf("20.x"), 20);
  assert.equal(majorOf("latest"), null);

  // The "Done means" case: a sidecar pinned to 22 while CI stays on 20.
  assert.equal([20].includes(majorOf("22.0.0")), false);
});

test("guard: the trigger rule reads the on: header, not the job body", () => {
  assert.equal(tagTriggered("on:\n  push:\n    branches: [main]\n    tags: [\"v*\"]\njobs:\n"), true);
  assert.equal(tagTriggered("on:\n  push:\n    tags:\n      - \"v*\"\njobs:\n"), true);

  // The defect #35 was: branches named, tags not — so a guarded job never started.
  assert.equal(tagTriggered("on:\n  push:\n    branches: [main]\njobs:\n"), false);
  // A `tags:` inside a step's `with:` starts nothing, so only the header is read.
  assert.equal(
    tagTriggered(
      "on:\n  push:\n    branches: [main]\njobs:\n  x:\n    steps:\n      - with:\n          tags: [\"v*\"]\n",
    ),
    false,
  );

  // The workflow itself, which the installer family above depends on.
  assert.equal(tagTriggered(readFileSync(ciWorkflow, "utf8")), true, "ci.yml starts on a version tag");
});

test("guard: the shell's token reaches the sidecar and the window", () => {
  const wiring = tokenWiring(readFileSync(shellMain, "utf8"), readFileSync(guiApp, "utf8"));
  assert.deepEqual(
    wiring,
    { toSidecar: true, toWindow: true, fromWindow: true },
    "the shell must set SKYHOOK_REMOTE_TOKEN on the child, inject it into the window, and the GUI send it back",
  );
});

test("guard: the token rule refuses a handshake with a half removed", () => {
  const mainRs = readFileSync(shellMain, "utf8");
  const appJs = readFileSync(guiApp, "utf8");

  // Drop each half from a copy and the wiring must go false — a rule that passes
  // on the real files but cannot fail is not a rule.

  // 1. The child never learns the token, so every POST its schedules make is 403.
  const noEnv = mainRs.replace('.env("SKYHOOK_REMOTE_TOKEN", token)', "");
  assert.notEqual(noEnv, mainRs, "main.rs still sets the env var");
  assert.equal(tokenWiring(noEnv, appJs).toSidecar, false);

  // 2. The window is never told, so its own POSTs carry no credential.
  const noScript = mainRs.replace(".initialization_script(script.as_str())", "");
  assert.notEqual(noScript, mainRs, "main.rs still injects the flag");
  assert.equal(tokenWiring(noScript, appJs).toWindow, false);

  // 3. The flag reaches the page but `api()` ignores it.
  const header = 'if (token && method === "POST") headers.Authorization = `Bearer ${token}`;';
  const noHeader = appJs.replace(header, "");
  assert.notEqual(noHeader, appJs, "app.js still sets the bearer header");
  assert.equal(tokenWiring(mainRs, noHeader).fromWindow, false);
});

test("guard: the window drops what a webview cannot honour", () => {
  const mainRs = readFileSync(shellMain, "utf8");
  const appJs = readFileSync(guiApp, "utf8");

  // The skip is only worth asserting while the shared markup still offers the PWA.
  assert.match(
    readFileSync(guiHtml, "utf8"),
    /rel="manifest"/,
    "src/gui/index.html still links the manifest — the shell has to be the one that skips it",
  );

  assert.deepEqual(
    desktopChrome(mainRs, appJs),
    {
      handsLinksOut: true,
      hidesApiButton: true,
      ignoresStoredBase: true,
      hidesSettingsField: true,
      skipsManifest: true,
    },
    "the shell hands http(s) links to the browser, and the renderer hides the API-base prompt and the manifest",
  );
});

test("guard: the chrome rule refuses a window that still thinks it is a browser", () => {
  const mainRs = readFileSync(shellMain, "utf8");
  const appJs = readFileSync(guiApp, "utf8");

  // 1. Nothing holds the window at the sidecar's origin any more.
  const noGuard = mainRs.replace(".on_navigation(move |target| {", "");
  assert.notEqual(noGuard, mainRs, "main.rs still guards the navigation");
  assert.equal(desktopChrome(noGuard, appJs).handsLinksOut, false);

  // 2. The top-bar button survives into a window where it can do nothing.
  const keepButton = appJs.replace('$("#apiBaseBtn")?.remove();', "");
  assert.notEqual(keepButton, appJs, "applyDesktopChrome still drops the button");
  assert.equal(desktopChrome(mainRs, keepButton).hidesApiButton, false);

  // 3. A base URL a browser session stored redirects the window.
  const keepBase = appJs.replace("if (isDesktop()) return window.location.origin;", "");
  assert.notEqual(keepBase, appJs, "apiBase() still short-circuits in a window");
  assert.equal(desktopChrome(mainRs, keepBase).ignoresStoredBase, false);

  // 4. Settings offers a field the window will ignore.
  const keepField = appJs.replace("const apiEndpoint = isDesktop()", "const apiEndpoint = false");
  assert.notEqual(keepField, appJs, "renderSettings still branches on the flag");
  assert.equal(desktopChrome(mainRs, keepField).hidesSettingsField, false);

  // 5. The webview is offered an install it cannot complete.
  const manifestSkip = "document.querySelector('link[rel=\"manifest\"]')?.remove();";
  const keepManifest = appJs.replace(manifestSkip, "");
  assert.notEqual(keepManifest, appJs, "applyDesktopChrome still drops the manifest link");
  assert.equal(desktopChrome(mainRs, keepManifest).skipsManifest, false);

  // The browser path is not collateral: with no flag none of the five fires.
  assert.deepEqual(desktopChrome("", 'document.querySelector("#refreshBtn")'), {
    handsLinksOut: false,
    hidesApiButton: false,
    ignoresStoredBase: false,
    hidesSettingsField: false,
    skipsManifest: false,
  });
});

test("guard: the app is the scheduler, and Start with Windows is a Run entry", () => {
  const wiring = scheduleWiring({
    serverJs: readFileSync(join(desktopDir, "server.js"), "utf8"),
    scheduleJs: readFileSync(sidecarSchedule, "utf8"),
    mainRs: readFileSync(shellMain, "utf8"),
    capability: JSON.parse(readFileSync(join(capabilitiesDir, "default.json"), "utf8")),
  });

  assert.deepEqual(
    wiring,
    {
      startsInSidecar: true,
      stopsWithServer: true,
      pollsDueSet: true,
      neverOverlapsRun: true,
      autostartToggle: true,
      autostartAllowed: true,
    },
    "the child ticks the due set while the app runs, and the shell's schedule affordance is the Run entry",
  );
});

test("guard: the schedule rule refuses a shell that stopped owning the schedule", () => {
  const serverJs = readFileSync(join(desktopDir, "server.js"), "utf8");
  const scheduleJs = readFileSync(sidecarSchedule, "utf8");
  const mainRs = readFileSync(shellMain, "utf8");
  const capability = JSON.parse(readFileSync(join(capabilitiesDir, "default.json"), "utf8"));
  const wiring = (changes) => scheduleWiring({ serverJs, scheduleJs, mainRs, capability, ...changes });

  // 1. Nothing starts the loop, so the app runs only when a person presses Run.
  const noStart = serverJs.replace("startSchedule({", "");
  assert.notEqual(noStart, serverJs, "server.js still starts the schedule");
  assert.equal(wiring({ serverJs: noStart }).startsInSidecar, false);

  // 2. The loop outlives the server it posts to.
  const noStop = serverJs.replace("schedule?.stop();", "");
  assert.notEqual(noStop, serverJs, "the stop path still stops the schedule");
  assert.equal(wiring({ serverJs: noStop }).stopsWithServer, false);

  // 3. The tick stops gating on the run in flight: `/api/due` still lists it, so
  // the next tick starts a second child for one source.
  const noGate = scheduleJs.replace('return { skipped: "running", active };', "");
  assert.notEqual(noGate, scheduleJs, "the tick still refuses a running seeder");
  assert.equal(wiring({ scheduleJs: noGate }).neverOverlapsRun, false);

  // 4. The tick never asks what is running at all.
  const noRunning = scheduleJs.replace('request("GET", "/api/running")', "");
  assert.notEqual(noRunning, scheduleJs, "the tick still asks what is running");
  assert.equal(wiring({ scheduleJs: noRunning }).pollsDueSet, false);

  // 5. The check item is gone, so the Run entry is unreachable from the app.
  const noToggle = mainRs.replace('"Start with Windows"', "");
  assert.notEqual(noToggle, mainRs, "the menu still offers the toggle");
  assert.equal(wiring({ mainRs: noToggle }).autostartToggle, false);

  // 6. The toggle is there but the capability never grants the plugin, so it fails
  // the first time a person clicks it.
  const noPermission = {
    ...capability,
    permissions: (capability.permissions ?? []).filter(
      (permission) =>
        (typeof permission === "string" ? permission : permission?.identifier) !== "autostart:default",
    ),
  };
  assert.equal(wiring({ capability: noPermission }).autostartAllowed, false);
});

test("guard: a fresh checkout carries every piece the installer build needs", () => {
  const wiring = distWiring({
    pin: JSON.parse(readFileSync(sidecarManifest, "utf8")),
    tauriConf: JSON.parse(readFileSync(tauriConfig, "utf8")),
    packageJson: JSON.parse(readFileSync(packageManifest, "utf8")),
    distScript: readFileSync(distWrapper, "utf8"),
    stageScript: readFileSync(stageScript, "utf8"),
    ciYaml: readFileSync(ciWorkflow, "utf8"),
    mainRs: readFileSync(shellMain, "utf8"),
  });

  assert.deepEqual(
    wiring,
    {
      sidecarBundled: true,
      appShippedAsResource: true,
      fetchesBeforeBuild: true,
      distScriptBuilds: true,
      appStaged: true,
      bundledRuntime: true,
      plainPaths: true,
      tagOnlyJob: true,
      tagTrigger: true,
    },
    "the bundle carries its runtime and the app that runtime runs, and the CI job is a tag job a tag push starts",
  );
});

test("guard: the dist rule refuses a build that would ship a runtime it cannot run", () => {
  const base = {
    pin: JSON.parse(readFileSync(sidecarManifest, "utf8")),
    tauriConf: JSON.parse(readFileSync(tauriConfig, "utf8")),
    packageJson: JSON.parse(readFileSync(packageManifest, "utf8")),
    distScript: readFileSync(distWrapper, "utf8"),
    stageScript: readFileSync(stageScript, "utf8"),
    ciYaml: readFileSync(ciWorkflow, "utf8"),
    mainRs: readFileSync(shellMain, "utf8"),
  };
  const wiring = (changes) => distWiring({ ...base, ...changes });

  // 1. The runtime is fetched but never bundled, so the installer has none.
  assert.equal(
    wiring({ tauriConf: { ...base.tauriConf, bundle: { ...base.tauriConf.bundle, externalBin: [] } } })
      .sidecarBundled,
    false,
  );

  // 2. The application the child runs is not shipped, so an installed copy dies on its
  // first import — the failure the first installed build actually produced.
  const { resources, ...withoutResources } = base.tauriConf.bundle;
  assert.ok(Object.keys(resources ?? {}).length > 0, "tauri.conf.json still ships the app");
  assert.equal(
    wiring({ tauriConf: { ...base.tauriConf, bundle: withoutResources } }).appShippedAsResource,
    false,
  );

  // 3. The app is staged by whatever Node ran the wrapper, so `better-sqlite3` carries the
  // wrong ABI and the installed app dies on its first database call.
  const noStage = base.distScript.replace("stageDesktopApp();", "");
  assert.notEqual(noStage, base.distScript, "the wrapper still stages the app");
  assert.equal(wiring({ distScript: noStage }).appStaged, false);

  // 4. Nothing fetches the pinned archive before the build.
  assert.equal(
    wiring({
      tauriConf: { ...base.tauriConf, build: { ...base.tauriConf.build, beforeBuildCommand: "" } },
    }).fetchesBeforeBuild,
    false,
  );

  // 5. `desktop:dist` calls `tauri build` itself, skipping the fetch, the staging and the copy.
  assert.equal(
    wiring({
      packageJson: { ...base.packageJson, scripts: { ...base.packageJson.scripts, "desktop:dist": "tauri build" } },
    }).distScriptBuilds,
    false,
  );

  // 6. The shell drops the bundled-runtime branch, so a release build would run the
  // user's own Node and the ABI the suite tested would prove nothing (DC6).
  const noRuntime = base.mainRs.replace("let runtime = bundled_runtime();", "");
  assert.notEqual(noRuntime, base.mainRs, "main.rs still prefers the bundled runtime");
  assert.equal(wiring({ mainRs: noRuntime }).bundledRuntime, false);

  // 7. The child is handed the verbatim path `resource_dir()` returns, and Node refuses to
  // start the entry script at all (`EISDIR: lstat 'C:'`) — the first installed build's bug.
  const noPlain = base.mainRs.replace("plain_path(&packaged)", "packaged");
  assert.notEqual(noPlain, base.mainRs, "sidecar_script still normalizes the resource path");
  assert.equal(wiring({ mainRs: noPlain }).plainPaths, false);

  // 8. The CI job loses its tag guard and becomes a pull-request gate.
  const noGuard = base.ciYaml.replace(
    "if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    "",
  );
  assert.notEqual(noGuard, base.ciYaml, "ci.yml still guards the desktop job");
  assert.equal(wiring({ ciYaml: noGuard }).tagOnlyJob, false);

  // 9. The guard stays but the workflow never starts on a tag, so the job above is
  // unreachable and a release builds nothing — the state ci.yml was in until #35.
  const noTrigger = base.ciYaml.replace(/^\s*tags: \[.*\]\s*$/m, "");
  assert.notEqual(noTrigger, base.ciYaml, "ci.yml still triggers on a version tag");
  assert.equal(wiring({ ciYaml: noTrigger }).tagTrigger, false);
  assert.equal(wiring({ ciYaml: noTrigger }).tagOnlyJob, true, "the guard alone would still pass");
});

/**
 * The updater, as the pieces have to line up for an installed copy to update itself.
 *
 * Nothing here can be observed without two installed builds and a published release, so
 * what is asserted is the wiring that decides whether such a release *could* work: the
 * plugin registered, artifacts signed at build time, the endpoint on the Release, passive
 * install, a public key, the signed-version check, the launch check behind a stored flag,
 * the sidecar stopped before the installer runs, and the manifest + secrets in CI. The
 * renderer is deliberately absent — the updater is Rust-side, so the capability allow-list
 * gains nothing for it.
 */
function updaterWiring({ tauriConf, mainRs, distScript, latestScript, ciYaml }) {
  const updater = tauriConf.plugins?.updater ?? {};
  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  return {
    pluginRegistered: mainRs.includes(".plugin(tauri_plugin_updater::Builder::new().build())"),
    artifactsBuilt: tauriConf.bundle?.createUpdaterArtifacts === true,
    releaseEndpoint:
      endpoints.length === 1
      && /^https:\/\/github\.com\/seven-lynx\/skyhook\/releases\/latest\/download\/latest\.json$/.test(endpoints[0]),
    passiveInstall: updater.windows?.installMode === "passive",
    pubkeyPinned: typeof updater.pubkey === "string" && updater.pubkey.length > 40,
    versionSigned: updater.requireSignedVersion === true,
    launchCheckBehindFlag:
      mainRs.includes("fn check_on_launch_enabled(")
      && mainRs.includes("if check_on_launch_enabled(&handle) {")
      && mainRs.includes("check_updates(&handle, false)")
      && mainRs.includes("set_check_on_launch(app, wanted)"),
    childStoppedFirst:
      mainRs.includes(".on_before_exit(before_exit)") && mainRs.includes("move || kill_sidecar(&app)"),
    manifestWritten:
      distScript.includes("writeLatestJson(version, updaterZips[0]);") && distScript.includes("latestManifest({"),
    manifestShape:
      latestScript.includes("pub_date:") && latestScript.includes("platforms:") && latestScript.includes("signature:"),
    secretsInCi:
      ciYaml.includes("TAURI_SIGNING_PRIVATE_KEY")
      && ciYaml.includes("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
    releaseUpload: /gh release upload/.test(ciYaml) && /refs\/tags\/v/.test(ciYaml),
  };
}

function updaterInputs() {
  return {
    tauriConf: JSON.parse(readFileSync(tauriConfig, "utf8")),
    mainRs: readFileSync(shellMain, "utf8"),
    distScript: readFileSync(distWrapper, "utf8"),
    latestScript: readFileSync(latestJsonScript, "utf8"),
    ciYaml: readFileSync(ciWorkflow, "utf8"),
  };
}

test("guard: an installed copy finds, verifies and applies a published update", () => {
  assert.deepEqual(
    updaterWiring(updaterInputs()),
    {
      pluginRegistered: true,
      artifactsBuilt: true,
      releaseEndpoint: true,
      passiveInstall: true,
      pubkeyPinned: true,
      versionSigned: true,
      launchCheckBehindFlag: true,
      childStoppedFirst: true,
      manifestWritten: true,
      manifestShape: true,
      secretsInCi: true,
      releaseUpload: true,
    },
    "the updater is wired end to end, and the window is granted nothing new for it",
  );
});

test("guard: the updater rule refuses each way an installed copy would stop updating", () => {
  const base = updaterInputs();
  const wiring = (changes) => updaterWiring({ ...base, ...changes });
  const withUpdater = (updater) => ({
    ...base.tauriConf,
    plugins: { ...base.tauriConf.plugins, updater: { ...base.tauriConf.plugins?.updater, ...updater } },
  });

  // 1. The plugin is never registered, so nothing reads the config at all.
  const noPlugin = base.mainRs.replace(".plugin(tauri_plugin_updater::Builder::new().build())", "");
  assert.notEqual(noPlugin, base.mainRs, "main.rs still registers the updater");
  assert.equal(wiring({ mainRs: noPlugin }).pluginRegistered, false);

  // 2. The build stops creating the archive the updater downloads.
  assert.equal(
    wiring({
      tauriConf: { ...base.tauriConf, bundle: { ...base.tauriConf.bundle, createUpdaterArtifacts: false } },
    }).artifactsBuilt,
    false,
  );

  // 3. An endpoint that is not the Release's latest manifest — a dead channel, or a plain
  // `http` URL a release build refuses to fetch (`InsecureTransportProtocol`).
  assert.equal(
    wiring({ tauriConf: withUpdater({ endpoints: ["http://example.test/latest.json"] }) }).releaseEndpoint,
    false,
  );
  assert.equal(
    wiring({ tauriConf: withUpdater({ endpoints: ["https://example.test/latest.json"] }) }).releaseEndpoint,
    false,
  );

  // 4. `basicUi` leaves the installer waiting on a click nobody is there to make.
  assert.equal(wiring({ tauriConf: withUpdater({ windows: { installMode: "basicUi" } }) }).passiveInstall, false);

  // 5. An empty public key: every download is refused as unverifiable.
  assert.equal(wiring({ tauriConf: withUpdater({ pubkey: "" }) }).pubkeyPinned, false);

  // 6. The signature stops carrying the version it was signed for, so a crafted manifest
  // can pair a newer number with an older signed artifact.
  assert.equal(wiring({ tauriConf: withUpdater({ requireSignedVersion: false }) }).versionSigned, false);

  // 7. The launch check runs regardless of the flag — the air-gapped box has no way out.
  const noFlag = base.mainRs.replace("if check_on_launch_enabled(&handle) {", "{");
  assert.notEqual(noFlag, base.mainRs, "main.rs still gates the launch check");
  assert.equal(wiring({ mainRs: noFlag }).launchCheckBehindFlag, false);

  // 8. The installer runs without the sidecar being stopped first, so the orphaned child
  // holds `.app-session.lock` and the next launch is refused at it.
  const noHook = base.mainRs.replace(".on_before_exit(before_exit)", "");
  assert.notEqual(noHook, base.mainRs, "main.rs still hooks the pre-install exit");
  assert.equal(wiring({ mainRs: noHook }).childStoppedFirst, false);

  // 9. The wrapper ships the installer and forgets the manifest, so every installed copy
  // polls a URL that does not exist.
  const noManifest = base.distScript.replace("writeLatestJson(version, updaterZips[0]);", "");
  assert.notEqual(noManifest, base.distScript, "the wrapper still writes latest.json");
  assert.equal(wiring({ distScript: noManifest }).manifestWritten, false);

  // 10. A manifest without `platforms` — an updater reads it as "no update for you".
  const badManifest = base.latestScript.replace("platforms: {", "platformKeys: {");
  assert.notEqual(badManifest, base.latestScript, "latest-json.mjs still emits platforms");
  assert.equal(wiring({ latestScript: badManifest }).manifestShape, false);

  // 11. CI builds on a tag with no signing key, so `tauri build` fails and the release
  // has no artifacts at all.
  const noSecrets = base.ciYaml.replace(/TAURI_SIGNING_PRIVATE_KEY/g, "SOME_SECRET");
  assert.notEqual(noSecrets, base.ciYaml, "ci.yml still passes the signing key");
  assert.equal(wiring({ ciYaml: noSecrets }).secretsInCi, false);

  // 12. The artifacts are uploaded as workflow artifacts and never attached to the
  // Release, so the endpoint has nothing to answer with.
  const noUpload = base.ciYaml.replace("gh release upload", "echo would upload");
  assert.notEqual(noUpload, base.ciYaml, "ci.yml still attaches the artifacts");
  assert.equal(wiring({ ciYaml: noUpload }).releaseUpload, false);
});

