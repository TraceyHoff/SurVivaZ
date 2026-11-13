import type { FieldReader, FieldType, FieldWriter } from "@engine/core";

const f32 = new Float32Array(1);
const f32u = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const f64u = new Uint32Array(f64.buffer); // platform endianness is irrelevant: same view on both ends

/** Bit-granular writer (LSB-first). Implements core's FieldWriter so core field codecs can target it. */
export class BitWriter implements FieldWriter {
  private buf = new Uint8Array(64);
  private pos = 0;
  get bitLength(): number { return this.pos; }
  get byteLength(): number { return (this.pos + 7) >>> 3; }
  private ensure(bits: number): void {
    const need = (this.pos + bits + 7) >>> 3;
    if (need <= this.buf.length) return;
    let c = this.buf.length * 2; while (c < need) c *= 2;
    const n = new Uint8Array(c); n.set(this.buf); this.buf = n;
  }
  /** Writes the low `bits` bits of `value` (0..32). */
  writeBits(value: number, bits: number): void {
    if (bits < 0 || bits > 32) throw new RangeError(`writeBits: bad width ${bits}`);
    this.ensure(bits);
    let v = value >>> 0; let n = bits; let p = this.pos; const buf = this.buf;
    while (n > 0) {
      const off = p & 7; const take = Math.min(8 - off, n);
      buf[p >>> 3] = buf[p >>> 3]! | ((v & ((1 << take) - 1)) << off);
      v = take >= 32 ? 0 : v >>> take; n -= take; p += take;
    }
    this.pos = p;
  }
  /** Append `bitLen` bits from another writer's output (LSB-first, same layout). */
  appendBits(src: Uint8Array, bitLen: number): void {
    this.ensure(bitLen);
    if ((this.pos & 7) === 0) { this.buf.set(src.subarray(0, (bitLen + 7) >>> 3), this.pos >>> 3); this.pos += bitLen;
      if (bitLen & 7) { const last = (this.pos - 1) >>> 3; this.buf[last] = this.buf[last]! & ((1 << (bitLen & 7)) - 1); }
      return; }
    let i = 0; for (; i + 8 <= bitLen; i += 8) this.writeBits(src[i >>> 3]!, 8);
    if (i < bitLen) this.writeBits(src[i >>> 3]! & ((1 << (bitLen - i)) - 1), bitLen - i);
  }
  /** Copy of the raw bytes written so far (with bitLength, for appendBits). */
  snapshotBits(): { bytes: Uint8Array; bits: number } { return { bytes: this.buf.slice(0, this.byteLength), bits: this.pos }; }
  /**
   * ADR-375: append another writer's bits without copying its bytes — reads its internal buffer directly.
   * Bit-identical to appendBits(src.snapshotBits().bytes, src.bitLength). The source must not be written to
   * afterwards while the appended bits matter (callers keep the source immutable once cached).
   */
  appendWriter(src: BitWriter): void { this.appendBits(src.buf, src.pos); }
  /**
   * ADR-375: reuse this writer for a fresh record. writeBits ORs into the buffer, so the previously used
   * bytes must be zeroed first — otherwise stale 1-bits would leak into the new content.
   */
  reset(): void { this.buf.fill(0, 0, this.byteLength); this.pos = 0; }
  /** Roll back to an earlier bit position (used to drop a record that blew the budget). */
  truncate(bitPos: number): void {
    if (bitPos > this.pos) return;
    for (let p = bitPos; p < this.pos; p++) this.buf[p >>> 3] = this.buf[p >>> 3]! & ~(1 << (p & 7));
    this.pos = bitPos;
  }
  writeString(s: string): void { if (s.length > 255) throw new RangeError("string too long"); this.writeBits(s.length, 8); for (let i = 0; i < s.length; i++) this.writeBits(s.charCodeAt(i) & 0xff, 8); }
  writeBool(b: boolean): void { this.writeBits(b ? 1 : 0, 1); }
  /** LEB128-style varint in 7-bit groups; values 0..2^32-1. */
  writeVarUint(value: number): void {
    let v = value >>> 0;
    while (v >= 0x80) { this.writeBits((v & 0x7f) | 0x80, 8); v >>>= 7; }
    this.writeBits(v, 8);
  }
  writeF32(v: number): void { f32[0] = v; this.writeBits(f32u[0]!, 32); }
  writeF64(v: number): void { f64[0] = v; this.writeBits(f64u[0]!, 32); this.writeBits(f64u[1]!, 32); }
  /** ADR-369: byte-aligned bulk copy (tile deltas, blobs); bit-identical to one writeBits(x, 8) per byte. */
  writeBytes(b: Uint8Array): void {
    if ((this.pos & 7) === 0) { this.ensure(b.length * 8); this.buf.set(b, this.pos >>> 3); this.pos += b.length * 8; return; }
    for (const x of b) this.writeBits(x, 8);
  }
  write(t: FieldType, v: number): void {
    switch (t) {
      case "f32": this.writeF32(v); break;
      case "f64": this.writeF64(v); break;
      case "i8": case "u8": this.writeBits(v & 0xff, 8); break;
      case "i16": case "u16": this.writeBits(v & 0xffff, 16); break;
      case "i32": case "u32": this.writeBits(v, 32); break;
    }
  }
  finish(): Uint8Array { return this.buf.slice(0, this.byteLength); }
}

export class BitReader implements FieldReader {
  private pos = 0;
  private readonly totalBits: number;
  constructor(private readonly buf: Uint8Array, startByte = 0) { this.pos = startByte * 8; this.totalBits = buf.length * 8; }
  get remainingBits(): number { return this.totalBits - this.pos; }
  readBits(bits: number): number {
    if (bits < 0 || bits > 32) throw new RangeError(`readBits: bad width ${bits}`);
    if (this.pos + bits > this.totalBits) throw new RangeError("BitReader: out of data");
    let v = 0; let got = 0; let p = this.pos; const buf = this.buf;
    while (got < bits) {
      const off = p & 7; const take = Math.min(8 - off, bits - got);
      v += ((buf[p >>> 3]! >>> off) & ((1 << take) - 1)) * 2 ** got;
      got += take; p += take;
    }
    this.pos = p;
    return v >>> 0;
  }
  readString(): string { const n = this.readBits(8); let o = ""; for (let i = 0; i < n; i++) o += String.fromCharCode(this.readBits(8)); return o; }
  readBool(): boolean { return this.readBits(1) === 1; }
  readVarUint(): number {
    let v = 0, shift = 0;
    for (;;) {
      const b = this.readBits(8);
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7; if (shift > 28) throw new RangeError("varuint too long");
    }
    return v >>> 0;
  }
  readF32(): number { f32u[0] = this.readBits(32); return f32[0]!; }
  readF64(): number { f64u[0] = this.readBits(32); f64u[1] = this.readBits(32); return f64[0]!; }
  /** ADR-369: byte-aligned bulk copy; same bytes (and the same overrun RangeError) as one readBits(8) per byte. */
  readBytes(n: number): Uint8Array {
    if ((this.pos & 7) === 0) {
      if (this.pos + n * 8 > this.totalBits) throw new RangeError("BitReader: out of data");
      const o = this.buf.slice(this.pos >>> 3, (this.pos >>> 3) + n); this.pos += n * 8; return o;
    }
    const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = this.readBits(8); return o;
  }
  read(t: FieldType): number {
    switch (t) {
      case "f32": return this.readF32();
      case "f64": return this.readF64();
      case "u8": return this.readBits(8);
      case "i8": return (this.readBits(8) << 24) >> 24;
      case "u16": return this.readBits(16);
      case "i16": return (this.readBits(16) << 16) >> 16;
      case "u32": return this.readBits(32);
      case "i32": return this.readBits(32) | 0;
    }
  }
}
