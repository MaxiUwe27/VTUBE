// Renders the app icon (build/icon.png, 512x512 RGBA) with Node built-ins only.
// Shapes are point-in-shape tests, anti-aliased by 4x4 supersampling.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 512, SS = 4;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../build/icon.png');

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const HAIR = hex('#2a1f45'), SKIN = hex('#fff1e6'), EYE = hex('#2a1f45'), WHITE = hex('#ffffff');
const EAR_IN = hex('#ff8fbf'), BLUSH = hex('#ff7aa8', 0.45), MOUTH = hex('#c2416f');
const TOP = hex('#7c5cff'), BOTTOM = hex('#ff5f9e');

// Returns the colour layers (bottom to top) covering sample (x, y).
function layers(x, y) {
  const L = [];
  if (!inRoundRect(x, y, 16, 16, 496, 496, 112)) return L;
  L.push(mix(TOP, BOTTOM, (y - 16) / 480));
  for (const s of [-1, 1]) {           // cat ears
    const m = (px) => 256 + s * (px - 256);
    if (inTri(x, y, [m(132), 220], [m(150), 78], [m(250), 150])) L.push(HAIR);
    if (inTri(x, y, [m(152), 196], [m(163), 112], [m(224), 156])) L.push(EAR_IN);
  }
  if (inEllipse(x, y, 256, 292, 170, 172) && y < 420) L.push(HAIR); // back hair
  const face = inEllipse(x, y, 256, 300, 146, 140);
  if (face) L.push(SKIN);
  // scalloped bangs
  const fringe = 238 + 26 * Math.abs(Math.sin(((x - 110) / 292) * Math.PI * 2.5));
  if (face && y < fringe) L.push(HAIR);
  for (const ex of [198, 314]) {       // eyes with highlights
    if (inEllipse(x, y, ex, 312, 21, 32)) L.push(EYE);
    if (inEllipse(x, y, ex + 7, 299, 8, 9)) L.push(WHITE);
    if (inEllipse(x, y, ex - 7, 326, 4, 4)) L.push(WHITE);
  }
  for (const bx of [166, 346]) if (inEllipse(x, y, bx, 356, 26, 14)) L.push(BLUSH);
  const r = Math.hypot(x - 256, y - 340);   // smile: lower half ring
  if (y > 344 && r > 20 && r < 28) L.push(MOUTH);
  return L;
}

const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    let c = [0, 0, 0, 0];
    for (const l of layers(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) {
      const la = l[3], oa = la + c[3] * (1 - la);      // "over" compositing
      c = oa ? [0, 1, 2].map((i) => (l[i] * la + c[i] * c[3] * (1 - la)) / oa).concat(oa) : c;
    }
    r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
  }
  const i = (y * S + x) * 4;
  px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = (a / (SS * SS)) * 255;
}

// --- PNG encoding ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); // filter byte 0
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('Wrote', out, png.length, 'bytes');
