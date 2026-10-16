#!/usr/bin/env node
/**
 * build-icons.js — generate PWA icons from the master skyhook logo.
 *
 * Inputs:  ./skyhook-logo.png  (any size, square preferred, white background is fine)
 * Outputs: src/gui/icons/icon-192.png
 *          src/gui/icons/icon-512.png
 *          src/gui/icons/maskable-512.png  (PWA splash — logo with safe-area padding)
 *          docs/skyhook-logo-512.png       (copy of the 512 variant for the README)
 *
 * The source PNG has a baked-in white background. We composite each icon onto
 * a navy backdrop (matching the GUI), so the PWA splash doesn't flash white
 * and home-screen icons stay on-brand.
 *
 * Uses sharp (no ffmpeg dependency, no C++ toolchain). Run with:
 *
 *   npx --no-install sharp || npm i -D sharp
 *   node scripts/build-icons.js
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "skyhook-logo.png");
const ICON_DIR = join(ROOT, "src", "gui", "icons");

if (!existsSync(SRC)) {
  console.error(`✘ master logo not found: ${SRC}`);
  console.error("  Place skyhook-logo.png at the repo root before running this script.");
  process.exit(1);
}
mkdirSync(ICON_DIR, { recursive: true });

// sharp is a devDependency for this script. The project README warns that the
// runtime must avoid native modules that need a C++ toolchain — sharp is only
// used here, never at runtime, so it can be installed with `npm i -D sharp`.
const sharp = (await import("sharp")).default;

const NAVY = { r: 0x0f, g: 0x1d, b: 0x3a, alpha: 1 };

/**
 * Composite the source logo on a navy canvas, centered, with a uniform border.
 * @param {number} canvas  - output size in px (e.g. 192, 512)
 * @param {number} pad     - px of navy border around the logo
 */
async function makeIcon(canvas, pad, outName) {
  const logoSize = canvas - pad * 2;
  const resized = await sharp(SRC)
    .resize(logoSize, logoSize, { fit: "contain", background: NAVY })
    .png()
    .toBuffer();
  await sharp({
    create: { width: canvas, height: canvas, channels: 4, background: NAVY },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toFile(join(ICON_DIR, outName));
  console.log(`✓ ${outName} (${canvas}×${canvas}, navy border=${pad}px)`);
}

// Regular PWA icons: 7% padding on each side — logo covers the canvas with a
// small navy frame. Splash won't flash white.
await makeIcon(192, 14, "icon-192.png");
await makeIcon(512, 36, "icon-512.png");

// Maskable: 20% safe-area on each side so OS-driven circle/squircle crops
// never clip the satellite. (Logo is centered in the inner 60% of the canvas.)
await makeIcon(512, 102, "maskable-512.png");

// Also keep a copy at the repo root for the README / docs.
copyFileSync(join(ICON_DIR, "icon-512.png"), join(ROOT, "docs", "skyhook-logo-512.png"));
console.log("✓ docs/skyhook-logo-512.png");

console.log("\nAll icons generated. Commit src/gui/icons/ and docs/skyhook-logo-512.png.");

