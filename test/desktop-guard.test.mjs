/**
 * desktop-guard.test.mjs — the three ways a desktop build could stop being the
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

