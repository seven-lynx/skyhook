/**
 * icons.test.mjs — one palette across three files, and a script that reads it rather than repeating.
 *
 * #26: `build-icons.js` composited every icon on a literal navy while `styles.css`, the manifest and
 * `index.html` had moved to the console's `#090a0c`, so the header tile was navy on a near-black bar
 * — and `logo-96` carried no backdrop at all, so it showed the master's baked-in white. This test is
 * the tie the fix creates: the three declarations must name the same colour, and `backdropFrom()`
 * must return exactly that colour.
 *
 * It asserts the constant chain, not the bytes of a PNG. Reading a pixel needs `sharp`, which is a
 * devDependency: a test that fails on an `--omit=dev` install fails for a reason that has nothing to
 * do with the palette. The regenerated files are checked by eye, and their corner pixels were read
 * once when the fix landed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { backdropFrom } from "../scripts/build-icons.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guiDir = join(root, "src", "gui");
const css = readFileSync(join(guiDir, "styles.css"), "utf8");
const token = /--bg:\s*#([0-9a-fA-F]{6})\b/.exec(css);

test("the GUI's backdrop is one colour in three files", () => {
  assert.ok(token, "styles.css declares `--bg: #rrggbb`");
  const hex = token[1].toLowerCase();

  const manifest = JSON.parse(readFileSync(join(guiDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.background_color.toLowerCase(), `#${hex}`, "the splash background matches --bg");
  assert.equal(manifest.theme_color.toLowerCase(), `#${hex}`, "the manifest theme colour matches --bg");

  const html = readFileSync(join(guiDir, "index.html"), "utf8");
  assert.match(
    html,
    new RegExp(`<meta name="theme-color" content="#${hex}"`, "i"),
    "the document's theme colour matches --bg",
  );
});

test("build-icons reads --bg instead of carrying a second colour", () => {
  const expected = {
    r: parseInt(token[1].slice(0, 2), 16),
    g: parseInt(token[1].slice(2, 4), 16),
    b: parseInt(token[1].slice(4, 6), 16),
    alpha: 1,
  };
  assert.deepEqual(backdropFrom(css), expected, "backdropFrom returns the token as sharp wants it");

  // The literal is what drifted; a constant named NAVY coming back would restart the problem even
  // if its value happened to match today's token.
  const script = readFileSync(join(root, "scripts", "build-icons.js"), "utf8");
  assert.doesNotMatch(script, /const NAVY/, "the hardcoded palette is gone");
  assert.match(script, /readFileSync\(STYLE/, "the script reads the stylesheet");
});

test("backdropFrom refuses a stylesheet with no --bg token", () => {
  assert.throws(() => backdropFrom(":root { --bg-elevated: #101215; }"), /no `--bg: #rrggbb` token/);
});