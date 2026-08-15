// Generate all project icon formats from a single source PNG.
// Usage: node scripts/gen-icons.mjs <source.png>
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/gen-icons.mjs <source.png>");
  process.exit(1);
}

// Run from the project root; fall back to the script's directory parent.
const projectRoot = process.cwd();

const OUT = {
  "public/icons/icon-512.png": 512,
  "public/icons/icon-192.png": 192,
  "public/icons/apple-touch-icon.png": 180,
};

const FAVICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ELECTRON_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function pngBuffer(size) {
  return sharp(src).resize(size, size, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
}

// Minimal ICO encoder using PNG-compressed entries (Vista+).
function buildIco(entries) {
  // entries: [{ size, data }] (data = PNG buffer)
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const dir = Buffer.alloc(dirSize);
  const images = [];

  entries.forEach((entry, i) => {
    const { size, data } = entry;
    const b = dir.subarray(i * 16, i * 16 + 16);
    b.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    b.writeUInt8(size >= 256 ? 0 : size, 1); // height
    b.writeUInt8(0, 2); // color count
    b.writeUInt8(0, 3); // reserved
    b.writeUInt16LE(1, 4); // planes
    b.writeUInt16LE(32, 6); // bit count
    b.writeUInt32LE(data.length, 8); // bytes in resource
    b.writeUInt32LE(offset, 12); // image offset
    offset += data.length;
    images.push(data);
  });

  return Buffer.concat([header, dir, ...images]);
}

async function main() {
  // PNG outputs
  for (const [rel, size] of Object.entries(OUT)) {
    const buf = await pngBuffer(size);
    const abs = resolve(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    console.log(`wrote ${rel} (${size}x${size}, ${buf.length} bytes)`);
  }

  // favicon.ico
  const favEntries = [];
  for (const size of FAVICON_SIZES) {
    favEntries.push({ size, data: await pngBuffer(size) });
  }
  const favico = buildIco(favEntries);
  writeFileSync(resolve(projectRoot, "app/favicon.ico"), favico);
  console.log(`wrote app/favicon.ico (${favico.length} bytes)`);

  // build/icon.ico (Electron)
  const elEntries = [];
  for (const size of ELECTRON_SIZES) {
    elEntries.push({ size, data: await pngBuffer(size) });
  }
  const elico = buildIco(elEntries);
  writeFileSync(resolve(projectRoot, "build/icon.ico"), elico);
  console.log(`wrote build/icon.ico (${elico.length} bytes)`);

  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
