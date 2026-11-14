// Test helper: minimal PNG encode (RGBA8, stored zlib) and decode (8-bit and palette/gray low bit depths, all
// filters, no interlace) to compare decoded pixels before and after a lossless re-encode (ADR-391).
import { deflateSync, inflateSync } from "node:zlib";

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b: Uint8Array): number => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b;
}
/** RGBA8 PNG, filter 0, zlib level 0 (deliberately unoptimized). */
export function encodeRgba(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(h * (w * 4 + 1)); for (let y = 0; y < h; y++) Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", new Uint8Array())]);
}
/** Decoded RGBA8 pixels plus the ancillary chunk types in file order. */
export function decodeRgba(png: Uint8Array): { w: number; h: number; rgba: Uint8Array; chunks: string[] } {
  const b = Buffer.from(png); let o = 8; let w = 0, h = 0, depth = 8, ct = 6, interlace = 0; const idat: Buffer[] = []; let plte = Buffer.alloc(0), trns = Buffer.alloc(0); const chunks: string[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len); o += 12 + len;
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]!; ct = d[9]!; interlace = d[12]!; }
    else if (type === "IDAT") idat.push(d); else if (type === "PLTE") plte = d; else if (type === "tRNS") trns = d; else if (type !== "IEND") chunks.push(type);
  }
  if (interlace) throw new Error("interlaced PNG not supported by the test decoder");
  if (depth === 16) throw new Error("16-bit PNG not supported by the test decoder");
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ct]!; const bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3;
  const raw = inflateSync(Buffer.concat(idat)); const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride); const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!; raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0, up = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      cur[i] = (cur[i]! + (f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) : 0)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = (k: number): number => { if (depth === 8) return cur[x * ch + k]!; const bit = (x * ch + k) * depth; return (cur[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); };
      const q = (y * w + x) * 4; const sc = (v: number): number => (depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
      if (ct === 3) { const i = s(0); rgba[q] = plte[i * 3]!; rgba[q + 1] = plte[i * 3 + 1]!; rgba[q + 2] = plte[i * 3 + 2]!; rgba[q + 3] = i < trns.length ? trns[i]! : 255; }
      else if (ct === 0 || ct === 4) { const g = sc(s(0)); rgba[q] = rgba[q + 1] = rgba[q + 2] = g; rgba[q + 3] = ct === 4 ? s(1) : trns.length === 2 && s(0) === trns.readUInt16BE(0) ? 0 : 255; }
      else { rgba[q] = s(0); rgba[q + 1] = s(1); rgba[q + 2] = s(2); rgba[q + 3] = ct === 6 ? s(3) : trns.length === 6 && s(0) === trns.readUInt16BE(0) && s(1) === trns.readUInt16BE(2) && s(2) === trns.readUInt16BE(4) ? 0 : 255; }
    }
    cur.copy(prev);
  }
  return { w, h, rgba, chunks };
}
