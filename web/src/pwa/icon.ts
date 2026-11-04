// The app icon, drawn in code (no image files). A xiangqi piece: a cream disc with a ring and the
// palace diagonals on a dark red field. Rasterised with 4x4 supersampling into an RGBA PNG.
import { deflateSync } from "node:zlib";

type Rgba = [number, number, number, number];
const RED: Rgba = [0x8b, 0x1a, 0x1a, 255];
const CREAM: Rgba = [0xf3, 0xdf, 0xb5, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

const CORNER_RADIUS = 0.18; // of the icon size, for the non-maskable variant
const DISC_RADIUS = 0.34; // inside the 0.4 maskable safe circle
const RING_RADIUS = 0.285;
const LINE_HALF_WIDTH = 0.011;
const PALACE = 0.13; // half side of the palace square the diagonals span

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

function inRoundedSquare(u: number, v: number): boolean {
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return Math.sqrt((u - cx) * (u - cx) + (v - cy) * (v - cy)) <= r;
}

function sample(u: number, v: number, maskable: boolean): Rgba {
  if (!maskable && !inRoundedSquare(u, v)) return CLEAR;
  const x = u - 0.5;
  const y = v - 0.5;
  const d = Math.sqrt((x) * (x) + (y) * (y));
  if (d > DISC_RADIUS) return RED;
  if (Math.abs(d - RING_RADIUS) <= LINE_HALF_WIDTH) return RED;
  if (d < RING_RADIUS) {
    if (distToSegment(x, y, -PALACE, -PALACE, PALACE, PALACE) <= LINE_HALF_WIDTH) return RED;
    if (distToSegment(x, y, -PALACE, PALACE, PALACE, -PALACE) <= LINE_HALF_WIDTH) return RED;
    if (Math.max(Math.abs(x), Math.abs(y)) > PALACE - LINE_HALF_WIDTH && Math.max(Math.abs(x), Math.abs(y)) < PALACE + LINE_HALF_WIDTH) return RED;
  }
  return CREAM;
}

const SS = 4;

function rasterise(size: number, maskable: boolean): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function renderIconPng(size: number, options: { maskable?: boolean } = {}): Uint8Array {
  const pixels = rasterise(size, options.maskable === true);
  const stride = size * 4;
  const raw = new Uint8Array(size * (stride + 1)); // filter byte 0 per row
  for (let y = 0; y < size; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts);
}

export function renderIconSvg(): string {
  const s = 512;
  const c = s / 2;
  const hex = (rgba: Rgba) => `#${rgba.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const p = PALACE * s;
  const w = LINE_HALF_WIDTH * 2 * s;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">`,
    `<rect width="${s}" height="${s}" rx="${CORNER_RADIUS * s}" fill="${hex(RED)}"/>`,
    `<circle cx="${c}" cy="${c}" r="${DISC_RADIUS * s}" fill="${hex(CREAM)}"/>`,
    `<g fill="none" stroke="${hex(RED)}" stroke-width="${w}">`,
    `<circle cx="${c}" cy="${c}" r="${RING_RADIUS * s}"/>`,
    `<path d="M${c - p} ${c - p}L${c + p} ${c + p}M${c - p} ${c + p}L${c + p} ${c - p}"/>`,
    `<rect x="${c - p}" y="${c - p}" width="${2 * p}" height="${2 * p}"/>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
