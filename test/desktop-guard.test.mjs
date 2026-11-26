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
 * Every way a capability file could grant the renderer more than it needs, or
 * `[]` when it stays inside the shell's actual requirement.
 *
 * The renderer is a webview on the sidecar's own origin, so it talks HTTP and
 * asks for no IPC: `fs:` would let a page script write the user's disk,
 * `shell:allow-execute` would spawn whatever it named, and `remote.urls` would
 * open that IPC to an origin the shell did not ship.
 */
function capabilityViolations(capability) {
  const violations = [];
  for (const permission of capability.permissions ?? []) {
    const id = typeof permission === "string" ? permission : (permission?.identifier ?? "");
    if (id.startsWith("fs:")) violations.push(`grants ${id}`);
    if (id.startsWith("shell:allow-execute")) violations.push(`grants ${id}`);
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
 * `node-version:` takes one value or a matrix list, and the workflow is the only
 * place the tested runtime is recorded — so it is read, never restated here.
 */
function ciNodeMajors(yaml) {
  const majors = [];
  for (const match of yaml.matchAll(/node-version:\s*([^\n#]+)/g)) {
    for (const raw of match[1].replace(/[[\]"']/g, "").split(",")) {
      const major = majorOf(raw);
      if (major !== null) majors.push(major);
    }
  }
  return majors;
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

test("guard: every capability stays inside core and opener", () => {
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
  assert.deepEqual(capabilityViolations({ permissions: ["core:default", "opener:default"] }), []);
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

