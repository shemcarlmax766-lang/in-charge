#!/usr/bin/env node
/**
 * Generate the PWA icon set from the same design as the favicon (navy rounded square,
 * green ECG trace) — pixel math + a from-scratch PNG encoder, so the repo needs no image
 * toolchain to reproduce them:  node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'client', 'public', 'icons');

/* ---------- design (viewBox 32, mirrors index.html favicon) ---------- */
const PTS = [[4, 17], [9, 17], [11, 11], [14, 23], [17, 14], [19, 17], [28, 17]];
const BG = [0x0b, 0x24, 0x47, 255];          // --navy-800
const LINE = [0x4a, 0xde, 0x80, 255];        // ecag green
const RADIUS = 0.22;                          // rounded-square corner ratio

const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax; const vy = by - ay;
  const wx = px - ax; const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
  const dx = wx - vx * t; const dy = wy - vy * t;
  return Math.hypot(dx, dy);
};

// coverage of a rounded rect via signed distance, smoothed over ~1px
const rectCover = (x, y, half, r) => {
  const qx = Math.abs(x) - (half - r);
  const qy = Math.abs(y) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const d = outside + Math.min(Math.max(qx, qy), 0) - r; // sdf
  return Math.max(0, Math.min(1, 0.5 - d));               // 1px analytic AA
};

function render(size, { maskable = false } = {}) {
  const scale = size / 32;
  // maskable: full-bleed background, artwork pulled into the safe zone (~66 %)
  const art = maskable ? 0.66 : 1;
  const half = (size / 2);
  const r = maskable ? 0 : RADIUS * size;
  const lineHalfU = 1.2 * art;   // stroke half-width in DESIGN units (viewBox 32)
  const s = scale * art;             // px per design unit (the 0..32 grid)
  const ox = size * (1 - art) / 2;   // artwork origin offset for the inset
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5 - half; const cy = y + 0.5 - half;
      const bgA = rectCover(cx, cy, half, r);
      const gx = (x + 0.5 - ox) / s;               // design coords (0..32)
      const gy = (y + 0.5 - ox) / s;
      let line = 0;
      if (bgA > 0) {
        let dmin = Infinity;
        for (let i = 0; i < PTS.length - 1; i++) {
          dmin = Math.min(dmin, segDist(gx, gy, PTS[i][0], PTS[i][1], PTS[i + 1][0], PTS[i + 1][1]));
        }
        // coverage: signed distance to the stroke edge (in design units), AA'd over ~1 device px
        line = Math.max(0, Math.min(1, (lineHalfU - dmin) * s + 0.5));
      }
      const i4 = (y * size + x) * 4;
      px[i4] = Math.round(BG[0] + (LINE[0] - BG[0]) * line);
      px[i4 + 1] = Math.round(BG[1] + (LINE[1] - BG[1]) * line);
      px[i4 + 2] = Math.round(BG[2] + (LINE[2] - BG[2]) * line);
      px[i4 + 3] = Math.round(bgA * 255);
    }
  }
  return px;
}

/* ---------------- PNG encoder (8-bit RGBA, no interlace, filter 0) ---------------- */
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth, colour type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  ['icon-maskable-512.png', render(512, { maskable: true })],
  ['apple-touch-icon.png', render(180)],
];
for (const [name, rgba] of jobs) {
  const size = { 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512, 'apple-touch-icon.png': 180 }[name];
  const file = path.join(OUT, name);
  fs.writeFileSync(file, encodePng(size, rgba));
  console.log(`  ✓ ${path.relative(ROOT, file)} (${fs.statSync(file).size} B)`);
}
fs.writeFileSync(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0b2447"/>
<path d="M4 17h5l2-6 3 12 3-9 2 3h9" stroke="#4ade80" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`);
console.log('  ✓ client/public/icons/icon.svg');
