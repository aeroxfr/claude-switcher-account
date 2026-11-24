'use strict';
/**
 * Génère les icônes PNG (application + barre de menus / zone de notification)
 * sans dépendance : dessin vectoriel simple, anticrénelage par suréchantillonnage.
 *   node scripts/make-icons.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');

/* ----------------------------- PNG ----------------------------- */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------- formes ---------------------------- */
// Coordonnées dans un carré de 1024.

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Silhouette « personne » : tête + épaules. grow = marge (pour détourer). */
function inPerson(x, y, cx, cy, s, grow = 0) {
  const hr = 92 * s + grow;
  if ((x - cx) ** 2 + (y - (cy - 118 * s)) ** 2 <= hr * hr) return true;
  const rx = 178 * s + grow;
  const ry = 150 * s + grow;
  const by = cy + 178 * s;
  const bottom = cy + 205 * s + grow;
  return y <= bottom && ((x - cx) / rx) ** 2 + ((y - by) / ry) ** 2 <= 1;
}

const BACK = { cx: 405, cy: 440, s: 0.84 };
const FRONT = { cx: 600, cy: 530, s: 1 };

function appSample(x, y) {
  // Fond : carré arrondi, dégradé indigo → violet.
  if (!inRoundRect(x, y, 100, 100, 924, 924, 186)) return [0, 0, 0, 0];
  const t = (y - 100) / 824;
  let col = [Math.round(99 + (124 - 99) * t), Math.round(102 + (58 - 102) * t), Math.round(241 + (237 - 241) * t), 255];
  const front = inPerson(x, y, FRONT.cx, FRONT.cy, FRONT.s);
  const backCut = inPerson(x, y, FRONT.cx, FRONT.cy, FRONT.s, 26);
  const back = inPerson(x, y, BACK.cx, BACK.cy, BACK.s) && !backCut;
  if (front) col = [255, 255, 255, 255];
  else if (back) col = [col[0] + (255 - col[0]) * 0.55, col[1] + (255 - col[1]) * 0.55, col[2] + (255 - col[2]) * 0.55, 255];
  return col;
}

function traySample(x, y) {
  // Glyphe monochrome (modèle macOS) : noir + transparence, sans fond.
  // Le glyphe (≈ 523 × 471 unités) remplit ~90 % de l'icône.
  const k = 0.58;
  const X = (x - 512) * k + 516;
  const Y = (y - 512) * k + 500;
  if (inPerson(X, Y, FRONT.cx, FRONT.cy, FRONT.s)) return [0, 0, 0, 255];
  if (inPerson(X, Y, BACK.cx, BACK.cy, BACK.s) && !inPerson(X, Y, FRONT.cx, FRONT.cy, FRONT.s, 48)) return [0, 0, 0, 255];
  return [0, 0, 0, 0];
}

function render(size, sample, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 1024 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale);
          const al = c[3] / 255;
          r += c[0] * al;
          g += c[1] * al;
          b += c[2] * al;
          a += al;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  'icon.png': render(1024, appSample, 3),
  'trayTemplate.png': render(16, traySample, 8),
  'trayTemplate@2x.png': render(32, traySample, 8),
  'tray.png': render(16, appSample, 8),
  'tray@2x.png': render(32, appSample, 8),
};
for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`assets/${name}  ${data.length} octets`);
}
