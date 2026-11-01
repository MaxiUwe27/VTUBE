// Renders the app icon (build/icon.png, 512x512 RGBA) with Node built-ins only: a turquoise → blue
// sticker tile (navy outline, hard shadow) with a white pixel "V". Shapes are point-in-shape tests,
// anti-aliased by 4x4 supersampling.
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

// Brand colours (MaxiUwe27 style guide): turquoise → blue gradient, navy outlines and hard shadows.
const TQ = hex('#14ebdc'), BLUE = hex('#006eff'), NAVY = hex('#061838'), WHITE = hex('#ffffff');

// Sticker tile: navy outline + hard navy shadow below (no blur).
const T = { x0: 24, y0: 16, x1: 488, y1: 480, r: 104, line: 14, drop: 18 };

// Pixel "V" (8×6 cells), white with a navy outline and a hard navy shadow.
const V = ['XX....XX', 'XX....XX', '.XX..XX.', '.XX..XX.', '..XXXX..', '...XX...'];
const CELL = 34, VX = 256 - (V[0].length * CELL) / 2, VY = 158, V_LINE = 13, V_DROP = 15;
const inV = (x, y) => {
  const c = Math.floor((x - VX) / CELL), r = Math.floor((y - VY) / CELL);
  return r >= 0 && r < V.length && c >= 0 && c < V[0].length && V[r][c] === 'X';
};
/** Square (pixel-style) outline: any V cell within `d` px in x and y. */
const nearV = (x, y, d) => {
  for (const dx of [-d, 0, d]) for (const dy of [-d, 0, d]) if (inV(x + dx, y + dy)) return true;
  return false;
};

// Pixel corner (guide "Pixel-Ecke"), top-left inside the tile: '#' 100 %, '+' 60 %, '.' 30 % white.
const CORNER = ['####+#', '##+  .', '#+ #', '+ .', '#', '.'];
const PC = 14, PX = 64, PY = 58;
const cornerAlpha = (x, y) => {
  const c = Math.floor((x - PX) / PC), r = Math.floor((y - PY) / PC);
  const ch = CORNER[r]?.[c];
  return ch === '#' ? 1 : ch === '+' ? 0.6 : ch === '.' ? 0.3 : 0;
};

// Returns the colour layers (bottom to top) covering sample (x, y).
function layers(x, y) {
  const L = [];
  if (inRoundRect(x, y, T.x0, T.y0 + T.drop, T.x1, T.y1 + T.drop, T.r)) L.push(NAVY);         // hard shadow
  if (inRoundRect(x, y, T.x0, T.y0, T.x1, T.y1, T.r)) L.push(NAVY);                          // outline
  if (inRoundRect(x, y, T.x0 + T.line, T.y0 + T.line, T.x1 - T.line, T.y1 - T.line, T.r - T.line)) {
    // Gradient: blue bottom-left → turquoise top-right (125° like the guide's square profile picture).
    const t = ((x - T.x0) + (T.y1 - y)) / ((T.x1 - T.x0) + (T.y1 - T.y0));
    L.push(mix(BLUE, TQ, Math.max(0, Math.min(1, t))));
    const a = cornerAlpha(x, y);
    if (a) L.push([255, 255, 255, a]);
    if (nearV(x, y - V_DROP, V_LINE)) L.push(NAVY);                                           // V shadow
    if (nearV(x, y, V_LINE)) L.push(NAVY);                                                    // V outline
    if (inV(x, y)) L.push(WHITE);
  }
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
