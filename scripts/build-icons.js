#!/usr/bin/env node
/**
 * build-icons.js — generate PWA icons from the master skyhook logo.
 *
 * Inputs:  ./skyhook-logo.png  (any size, square preferred, white background is fine)
 * Outputs: src/gui/icons/icon-192.png
 *          src/gui/icons/icon-512.png
 *          src/gui/icons/maskable-512.png  (PWA splash — logo with safe-area padding)
 *          src/gui/icons/logo-96.png       (the header logo — a 32 px slot, no need for 3.2 MB)
 *          docs/skyhook-logo-512.png       (copy of the 512 variant for the README)
 *
 * The source PNG has a baked-in white background, so the composite is what supplies the dark
 * square. That backdrop is **not** a literal here: it is `--bg` read out of `src/gui/styles.css`,
 * which is also what `manifest.webmanifest` and `index.html` carry. The palette used to live in two
 * places — a navy `#0f1d3a` in this file against a near-black console — so the header logo was a
 * navy tile on a #090a0c bar, and `logo-96` was worse: it took no background at all and showed the
 * master's white (#26). `test/icons.test.mjs` fails if the three files disagree again.
 *
 * Uses sharp (no ffmpeg dependency, no C++ toolchain). Run with:
 *
 *   npx --no-install sharp || npm i -D sharp
 *   node scripts/build-icons.js
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "skyhook-logo.png");
const ICON_DIR = join(ROOT, "src", "gui", "icons");
const STYLE = join(ROOT, "src", "gui", "styles.css");

/**
 * The GUI's own backdrop, as sharp wants it, read out of the stylesheet that paints it.
 *
 * Pure and exported so a test can prove the tokens and the manifest agree without sharp, and without
 * writing an icon: the point is that there is one source, not that this script got it right once.
 */
export function backdropFrom(css) {
  const match = /--bg:\s*#([0-9a-fA-F]{6})\b/.exec(css);
  if (!match) throw new Error("styles.css has no `--bg: #rrggbb` token");
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    alpha: 1,
  };
}

async function build() {
  if (!existsSync(SRC)) {
    console.error(`✘ master logo not found: ${SRC}`);
    console.error("  Place skyhook-logo.png at the repo root before running this script.");
    process.exit(1);
  }
  mkdirSync(ICON_DIR, { recursive: true });

  // sharp is a devDependency for this script. The project README warns that the runtime must avoid
  // native modules that need a C++ toolchain — sharp is only used here, never at runtime.
  const sharp = (await import("sharp")).default;
  const BACKDROP = backdropFrom(readFileSync(STYLE, "utf8"));
  const label = "#" + [BACKDROP.r, BACKDROP.g, BACKDROP.b].map((n) => n.toString(16).padStart(2, "0")).join("");

  /**
   * Composite the source logo on a `--bg` canvas, centered, with a uniform border.
   * @param {number} canvas  - output size in px (e.g. 192, 512)
   * @param {number} pad     - px of surround around the logo
   */
  async function makeIcon(canvas, pad, outName) {
    const logoSize = canvas - pad * 2;
    const resized = await sharp(SRC)
      .resize(logoSize, logoSize, { fit: "contain", background: BACKDROP })
      .png()
      .toBuffer();
    await sharp({
      create: { width: canvas, height: canvas, channels: 4, background: BACKDROP },
    })
      .composite([{ input: resized, gravity: "center" }])
      .png({ compressionLevel: 9 })
      .toFile(join(ICON_DIR, outName));
    console.log(`✓ ${outName} (${canvas}×${canvas}, ${label} border=${pad}px)`);
  }

  // Regular PWA icons: 7% padding on each side — logo covers the canvas with a small frame, so a
  // splash screen never flashes white.
  await makeIcon(192, 14, "icon-192.png");
  await makeIcon(512, 36, "icon-512.png");

  // Maskable: 20% safe-area on each side so OS-driven circle/squircle crops never clip the
  // satellite. (Logo is centered in the inner 60% of the canvas.)
  await makeIcon(512, 102, "maskable-512.png");

  // Header derivative: `.brand-logo` is a 32 px box, so 96 px covers a 3× display at a fraction of
  // the master's weight. It goes through `makeIcon` like the rest — `resize({fit:"contain"})` alone
  // changes nothing on a square source whose background is baked in, so the header showed the
  // master's white as a tile on the dark bar (#26). Same 7% frame as `icon-192`, so the header and
  // the home-screen icon are the same mark at two sizes.
  await makeIcon(96, 7, "logo-96.png");

  // Also keep a copy at the repo root for the README / docs.
  copyFileSync(join(ICON_DIR, "icon-512.png"), join(ROOT, "docs", "skyhook-logo-512.png"));
  console.log("✓ docs/skyhook-logo-512.png");

  console.log("\nAll icons generated. Commit src/gui/icons/ and docs/skyhook-logo-512.png.");
}

// An importer (the test) gets `backdropFrom`; only a direct run writes files.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((err) => {
    console.error(`✘ ${err.message}`);
    process.exit(1);
  });
}

