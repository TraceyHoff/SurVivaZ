/**
 * ADR-394: minimal gunzip (RFC 1952 header + RFC 1951 inflate) for browsers without DecompressionStream
 * (Safari < 16.4). Puff-style canonical Huffman decode; single-member gzip as the build writes it.
 */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { count: Uint16Array; symbol: Uint16Array }
function huff(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!]!++;
  count[0] = 0;
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i]! + count[i]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]!]!++] = i;
  return { count, symbol };
}
let FIXED: [Huff, Huff] | undefined;
function fixed(): [Huff, Huff] {
  if (!FIXED) {
    const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = [huff(l, 288), huff(new Uint8Array(30).fill(5), 30)];
  }
  return FIXED;
}

/** Raw DEFLATE stream from `src[start..]` -> bytes (`hint`: expected output size). */
export function inflateRaw(src: Uint8Array, start = 0, hint = src.length * 4): Uint8Array {
  let pos = start, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, hint)), o = 0;
  const grow = (need: number): void => { if (o + need <= out.length) return; let n = out.length * 2; while (n < o + need) n *= 2; const b = new Uint8Array(n); b.set(out.subarray(0, o)); out = b; };
  const bits = (n: number): number => {
    while (bitCnt < n) { if (pos >= src.length) throw new Error("inflate: unexpected end of data"); bitBuf |= src[pos++]! << bitCnt; bitCnt += 8; }
    const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1); const c = h.count[len]!;
      if (code - c < first) return h.symbol[index + (code - first)]!;
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("inflate: bad code");
  };
  let last = 0;
  while (!last) {
    last = bits(1); const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0; // stored: byte-align
      if (pos + 4 > src.length) throw new Error("inflate: unexpected end of data");
      const len = src[pos]! | (src[pos + 1]! << 8), nlen = src[pos + 2]! | (src[pos + 3]! << 8); pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error("inflate: bad stored block");
      if (pos + len > src.length) throw new Error("inflate: unexpected end of data");
      grow(len); out.set(src.subarray(pos, pos + len), o); o += len; pos += len; continue;
    }
    let lit: Huff, dist: Huff;
    if (type === 1) [lit, dist] = fixed();
    else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i]!] = bits(3);
      const lencode = huff(lengths, 19); lengths.fill(0);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(lencode);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let len = 0, rep: number;
        if (sym === 16) { if (i === 0) throw new Error("inflate: repeat with no first length"); len = lengths[i - 1]!; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw new Error("inflate: too many lengths");
        while (rep--) lengths[i++] = len;
      }
      lit = huff(lengths.subarray(0, nlen), nlen); dist = huff(lengths.subarray(nlen, nlen + ndist), ndist);
    } else throw new Error("inflate: bad block type");
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) { grow(1); out[o++] = sym; continue; }
      if (sym === 256) break;
      sym -= 257; if (sym >= 29) throw new Error("inflate: bad length symbol");
      const len = LBASE[sym]! + bits(LEXT[sym]!);
      const ds = decode(dist); if (ds >= 30) throw new Error("inflate: bad distance symbol");
      const d = DBASE[ds]! + bits(DEXT[ds]!);
      if (d > o) throw new Error("inflate: distance too far back");
      grow(len); for (let k = 0; k < len; k++, o++) out[o] = out[o - d]!;
    }
  }
  return out.subarray(0, o);
}

/** gzip member (RFC 1952) -> bytes. */
export function gunzipSync(src: Uint8Array): Uint8Array {
  if (src.length < 18 || src[0] !== 0x1f || src[1] !== 0x8b || src[2] !== 8) throw new Error("gunzip: not gzip/deflate data");
  const flg = src[3]!; let p = 10;
  if (flg & 4) p += 2 + (src[p]! | (src[p + 1]! << 8)); // FEXTRA
  if (flg & 8) { while (src[p++] !== 0); } // FNAME
  if (flg & 16) { while (src[p++] !== 0); } // FCOMMENT
  if (flg & 2) p += 2; // FHCRC
  const n = src.length, isize = (src[n - 4]! | (src[n - 3]! << 8) | (src[n - 2]! << 16) | (src[n - 1]! << 24)) >>> 0;
  return inflateRaw(src, p, isize || n * 4);
}
