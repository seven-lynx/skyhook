#!/usr/bin/env node
/**
 * build-desktop-icons.js — derive the Tauri icon set from the committed PWA icons.
 *
 * `src-tauri/tauri.conf.json` needs an `.ico` for the Windows bundle and a few
 * PNG sizes for the window and the installer. The source of truth is already in
 * the repo (`src/gui/icons/icon-512.png`, made by `build-icons.js`), so this
 * script only resizes and re-containers: the master logo is not required, and
 * the only dependency is the `sharp` devDependency the other icon script
 * already uses — never a runtime one.
 *
 * The ICO is written by hand rather than converted: the format allows a
 * PNG-compressed entry, so the encoder below is a 22-byte header plus the PNG
 * bytes. That is why `tauri icon` (a CLI that needs the Rust toolchain) is not
 * on this path.
 *
 *   node scripts/build-desktop-icons.js
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "gui", "icons", "icon-512.png");
const OUT = join(ROOT, "src-tauri", "icons");

const sharp = (await import("sharp")).default;
mkdirSync(OUT, { recursive: true });

/** One square PNG of `size`, keeping the source's alpha and framing. */
async function png(size) {
  return sharp(SRC).resize(size, size, { fit: "contain" }).png({ compressionLevel: 9 }).toBuffer();
}

for (const [size, name] of [[32, "32x32.png"], [128, "128x128.png"], [256, "128x128@2x.png"]]) {
  writeFileSync(join(OUT, name), await png(size));
  console.log(`✓ ${name} (${size}×${size})`);
}

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes), then the PNG payload.
// A 0 dimension means 256, which is why the entry is 256 and not 512.
const payload = await png(256);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // resource type: icon
header.writeUInt16LE(1, 4); // one image
header.writeUInt8(0, 6); // width: 256
header.writeUInt8(0, 7); // height: 256
header.writeUInt8(0, 8); // palette colours: none
header.writeUInt8(0, 9); // reserved
header.writeUInt16LE(1, 10); // colour planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(payload.length, 14); // payload size
header.writeUInt32LE(22, 18); // payload offset
writeFileSync(join(OUT, "icon.ico"), Buffer.concat([header, payload]));
console.log(`✓ icon.ico (256×256 PNG entry, ${header.length + payload.length} bytes)`);

console.log("\nCommit src-tauri/icons/. Re-run after src/gui/icons/icon-512.png changes.");
