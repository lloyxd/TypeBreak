/**
 * Generate the PWA icons.
 *
 * Writes real PNGs with zlib only, so the project keeps zero dependencies. The
 * mark is a rounded square in the app's accent colour with a "T" glyph drawn
 * from rectangles — crisp at every size and no font needed.
 *
 *   node tools/build-icons.js
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'web', 'icons');

const BG = [0x0e, 0x11, 0x16];
const ACCENT = [0x4a, 0x9e, 0xff];
const INK = [0x07, 0x10, 0x1c];

/* ---------------- PNG encoding ---------------- */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode RGBA pixel data as a PNG buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- Drawing ---------------- */

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function setPixel(canvas, x, y, [r, g, b], alpha = 255) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  canvas.data[i] = r;
  canvas.data[i + 1] = g;
  canvas.data[i + 2] = b;
  canvas.data[i + 3] = alpha;
}

/** Fill a rounded rectangle, antialiased by sampling coverage at 2x2. */
function fillRoundedRect(canvas, x0, y0, w, h, radius, colour, alpha = 255) {
  const samples = 3;
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (insideRoundedRect(px, py, x0, y0, w, h, radius)) hits += 1;
        }
      }
      if (!hits) continue;
      const coverage = hits / (samples * samples);
      // Blend over whatever is already there.
      const i = (y * canvas.size + x) * 4;
      const existing = canvas.data[i + 3] / 255;
      const outAlpha = coverage * (alpha / 255) + existing * (1 - coverage * (alpha / 255));
      if (outAlpha <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const src = colour[c];
        const dst = canvas.data[i + c];
        canvas.data[i + c] = Math.round((src * coverage * (alpha / 255) + dst * existing * (1 - coverage * (alpha / 255))) / outAlpha);
      }
      canvas.data[i + 3] = Math.round(outAlpha * 255);
    }
  }
}

function insideRoundedRect(px, py, x0, y0, w, h, radius) {
  if (px < x0 || py < y0 || px > x0 + w || py > y0 + h) return false;
  const r = Math.min(radius, w / 2, h / 2);
  const cx = Math.min(Math.max(px, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(py, y0 + r), y0 + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r + 1e-9;
}

/**
 * Draw the TypeBreak mark: accent rounded square with a white "T" and a small
 * caret block, which reads as "typing" at 192px and stays legible at 48px.
 */
function drawIcon(size, { maskable = false } = {}) {
  const canvas = createCanvas(size);

  // Maskable icons need a safe zone: the mask can crop up to 20% off each edge,
  // so the background fills the whole canvas and the glyph stays central.
  const pad = maskable ? 0 : Math.round(size * 0.04);
  const body = size - pad * 2;
  const radius = maskable ? 0 : Math.round(body * 0.22);

  if (maskable) {
    // Full-bleed background so any mask shape looks deliberate.
    fillRoundedRect(canvas, 0, 0, size, size, 0, ACCENT);
  } else {
    fillRoundedRect(canvas, pad, pad, body, body, radius, ACCENT);
  }

  // Glyph geometry, expressed as fractions of the icon so it scales cleanly.
  const scale = maskable ? 0.62 : 1;
  const cx = size / 2;
  const glyphTop = size * 0.30;
  const barHeight = size * 0.11;
  const barWidth = size * 0.42 * scale + size * 0.06;
  const stemWidth = size * 0.10;
  const stemHeight = size * 0.30;

  // The horizontal bar of the T.
  fillRoundedRect(canvas, cx - barWidth / 2, glyphTop, barWidth, barHeight, size * 0.02, INK);
  // The stem.
  fillRoundedRect(canvas, cx - stemWidth / 2, glyphTop, stemWidth, barHeight + stemHeight, size * 0.02, INK);
  // A caret block under the stem, hinting at an active cursor.
  const caretW = size * 0.055;
  const caretH = size * 0.16;
  fillRoundedRect(canvas, cx + size * 0.10, glyphTop + barHeight + stemHeight * 0.55, caretW, caretH, size * 0.012, INK, 200);

  return encodePng(size, size, canvas.data);
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  ['icon-maskable-512.png', drawIcon(512, { maskable: true })],
  ['apple-touch-icon.png', drawIcon(180)],
  ['favicon-32.png', drawIcon(32)],
];

for (const [name, buffer] of outputs) {
  writeFileSync(join(OUT_DIR, name), buffer);
  console.log(`${name}  ${buffer.length} bytes`);
}

console.log(`\nWrote ${outputs.length} icons to ${OUT_DIR}`);
