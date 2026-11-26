/**
 * desktop-dist.test.mjs — what `npm run desktop:dist` decides before it ships a runtime.
 *
 * The installer build itself needs a Rust toolchain, a linker and 30 MB of download, so
 * the half CI and a laptop can prove is the half that decides whether a download is
 * acceptable at all: the pin's hash against nodejs.org's own `SHASUMS256.txt`, and the
 * file name Tauri's `externalBin` requires. Both are pure functions in
 * `scripts/fetch-sidecar.mjs`, and the fixture below drives `ensureSidecar()` end to end
 * with an injected `fetch` and an injected unpack — no network, no archive, no zip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  MANIFEST,
  ensureSidecar,
  expectedSidecar,
  pinProblems,
  sha256,
  shasumFor,
} from "../scripts/fetch-sidecar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));

/** The `fetch` the fixture hands `ensureSidecar`: a zip of two bytes and a hash list. */
function stubFetch({ archive, shasums }) {
  return async (url) => {
    const body = url.endsWith(".zip") ? archive : Buffer.from(shasums, "utf8");
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
}

/** An unpack that writes the one file the archive is supposed to hold. */
function stubUnpack(into) {
  return (_archive, dir) => writeFileSync(join(dir, "node.exe"), "runtime");
}

function fixture(pinOverride) {
  const dir = join(root, `.tmp-desktop-dist-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "desktop"), { recursive: true });
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ ...pin, ...pinOverride }));
  return dir;
}

test("dist: the pin names the file the bundle's externalBin expects", () => {
  const target = expectedSidecar(pin, root);
  assert.equal(target.name, "skyhook-sidecar-x86_64-pc-windows-msvc.exe");
  assert.equal(resolve(target.path), join(root, "src-tauri", "binaries", target.name));
  assert.ok(pin.artifact.includes(`v${pin.node}`), `${pin.artifact} is the artifact of ${pin.node}`);
});

test("dist: nodejs.org's checksum list is read, and only for our artifact", () => {
  const text = [
    "abc123  node-v20.20.1-win-x64.zip",
    `${pin.sha256.toUpperCase()} *${pin.artifact}`,
    "",
  ].join("\n");
  assert.equal(shasumFor(text, pin.artifact), pin.sha256, "upper case and the binary-mode star still match");
  assert.equal(shasumFor(text, "node-v20.20.2-win-arm64.zip"), null);
  assert.equal(shasumFor("not a checksum line", pin.artifact), null);
});

test("dist: the pin refuses a runtime the registry or the download disagrees with", () => {
  const clean = pinProblems({ pin, published: pin.sha256, actual: pin.sha256 });
  assert.deepEqual(clean, []);

  const published = pinProblems({ pin, published: "f".repeat(64) }).join(" ");
  assert.match(published, /nodejs\.org publishes f{64}/);
  assert.match(published, new RegExp(pin.sha256), "the refusal quotes the pin, not just the registry");

  const actual = pinProblems({ pin, published: pin.sha256, actual: "0".repeat(64) }).join(" ");
  assert.match(actual, /the download hashes to 0{64}/);

  assert.match(pinProblems({ pin, published: null }).join(" "), /does not list/);
  assert.match(pinProblems({ pin: { ...pin, sha256: "" }, published: null }).join(" "), /no usable sha256/);
});

test("dist: an unverified archive fails the build and writes nothing", async () => {
  const dir = fixture({ sha256: sha256(Buffer.from("stub archive")) });
  try {
    const target = expectedSidecar({ ...pin }, dir);
    await assert.rejects(
      ensureSidecar({
        root: dir,
        log: () => {},
        fetchImpl: stubFetch({
          archive: Buffer.from("stub archive"),
          shasums: `${"f".repeat(64)}  ${pin.artifact}\n`,
        }),
        unpack: stubUnpack(),
      }),
      /refusing to ship an unverified runtime/,
    );
    assert.equal(existsSync(target.path), false, "a refused download leaves no runtime behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist: a verified archive lands as the externalBin name", async () => {
  const archive = Buffer.from("stub archive");
  const dir = fixture({ sha256: sha256(archive) });
  try {
    const target = expectedSidecar({ ...pin }, dir);
    const result = await ensureSidecar({
      root: dir,
      log: () => {},
      fetchImpl: stubFetch({ archive, shasums: `${sha256(archive)}  ${pin.artifact}\n` }),
      unpack: stubUnpack(),
    });

    assert.equal(result.fetched, true);
    assert.deepEqual(readdirSync(dirname(target.path)), [target.name], "one file, and no .part left over");
    assert.equal(readFileSync(target.path, "utf8"), "runtime");

    // Second run: the file is in place, so the fetch is never called — this is the
    // branch every build after the first takes.
    const again = await ensureSidecar({
      root: dir,
      log: () => {},
      fetchImpl: () => {
        throw new Error("the fetch must not run when the runtime is already there");
      },
      unpack: stubUnpack(),
    });
    assert.equal(again.fetched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
