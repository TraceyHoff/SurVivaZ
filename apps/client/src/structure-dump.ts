/**
 * ADR-566: ?diag=1 structure dump — pure serialization (no DOM, no gameplay path).
 *
 * Captures every build piece within `radius` tiles of a centre tile plus the raw terrain
 * heights (`chunk.height` values, exactly as the IsoView mirror consumes them) over the
 * same square, in a compact plain-text format a person can copy out of a phone browser.
 * The ADR-562 harness parses the text back (`parseStructureDump`) and rebuilds the
 * structure verbatim — pieces through raw BuildPiece placement, heights through the
 * ADR-523 chunk.height pattern — then re-measures its drawn roof coverage.
 *
 * Format (v1), one header field per line, heights as comma-separated rows (y ascending),
 * then one `P` line per piece:
 *
 *   SURVIVAZ_STRUCTURE_DUMP 1
 *   center <tileX> <tileY>
 *   radius 12
 *   view <0..3>
 *   bounds <x0> <y0> <w> <h>
 *   heights
 *   <h(x0,y0),h(x0+1,y0),...>
 *   ... (h rows, y0 first)
 *   pieces <count>
 *   P <key> <x> <y> <z> <rot> <tier> <variant>
 *   ...
 *   end
 *
 * Piece x/y are world tile units (fractions kept, e.g. 5.5 for a tile-centred wall,
 * integers for corner posts); z is the piece's Transform z (terrain levels, storey
 * bases are multiples of FLOOR_HEIGHT_LEVELS). Heights are the raw signed chunk.height
 * integers — NOT render heights — so the mirror re-derives exactly what it derived live.
 */

export const STRUCTURE_DUMP_VERSION = 1;
export const STRUCTURE_DUMP_RADIUS = 12;
export const STRUCTURE_DUMP_HEADER = "SURVIVAZ_STRUCTURE_DUMP";

export interface StructureDumpPiece {
  key: string; x: number; y: number; z: number; rot: number; tier: number; variant: number;
}

export interface StructureDumpData {
  version: number;
  /** Centre tile (integer tile coordinates the dump was taken around). */
  center: { x: number; y: number };
  radius: number;
  /** Camera view rotation (quarter turns 0..3) at dump time; the harness measures view 0 by default. */
  view: number;
  /** Height grid bounds: heights[y - y0][x - x0] covers tiles x0..x0+w-1, y0..y0+h-1. */
  x0: number; y0: number; w: number; h: number;
  heights: number[][];
  pieces: StructureDumpPiece[];
}

export interface StructureDumpInput {
  /** World position (tile units, fractional ok) the dump is centred on — floored to the centre tile. */
  center: { x: number; y: number };
  radius?: number;
  view?: number;
  pieces: Iterable<StructureDumpPiece>;
  /** Raw chunk.height for a world tile; undefined = chunk not resident (dumped as the centre tile's height, else 0). */
  heightAt: (tx: number, ty: number) => number | undefined;
}

const fmtNum = (n: number): string => {
  if (!Number.isFinite(n)) throw new Error(`structure dump: non-finite number ${n}`);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
};

/** Collect pieces + heights around `center` into dump data. Pure: inputs in, data out. */
export function collectStructureDump(input: StructureDumpInput): StructureDumpData {
  const radius = input.radius ?? STRUCTURE_DUMP_RADIUS;
  const cx = Math.floor(input.center.x), cy = Math.floor(input.center.y);
  const x0 = cx - radius, y0 = cy - radius, w = radius * 2 + 1, h = radius * 2 + 1;
  const fallback = input.heightAt(cx, cy) ?? 0;
  const heights: number[][] = [];
  for (let y = y0; y < y0 + h; y++) {
    const row: number[] = [];
    for (let x = x0; x < x0 + w; x++) row.push(Math.round(input.heightAt(x, y) ?? fallback));
    heights.push(row);
  }
  const pieces: StructureDumpPiece[] = [];
  for (const p of input.pieces) {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (tx < x0 || tx >= x0 + w || ty < y0 || ty >= y0 + h) continue;
    pieces.push({ key: p.key, x: p.x, y: p.y, z: p.z, rot: p.rot, tier: p.tier, variant: p.variant });
  }
  pieces.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.rot - b.rot);
  return { version: STRUCTURE_DUMP_VERSION, center: { x: cx, y: cy }, radius, view: (input.view ?? 0) & 3, x0, y0, w, h, heights, pieces };
}

/** Dump data -> the copyable text block. */
export function serializeStructureDump(data: StructureDumpData): string {
  const L: string[] = [
    `${STRUCTURE_DUMP_HEADER} ${data.version}`,
    `center ${data.center.x} ${data.center.y}`,
    `radius ${data.radius}`,
    `view ${data.view & 3}`,
    `bounds ${data.x0} ${data.y0} ${data.w} ${data.h}`,
    "heights",
    ...data.heights.map((row) => row.map((v) => String(Math.round(v))).join(",")),
    `pieces ${data.pieces.length}`,
    ...data.pieces.map((p) => `P ${p.key} ${fmtNum(p.x)} ${fmtNum(p.y)} ${fmtNum(p.z)} ${p.rot} ${p.tier} ${p.variant}`),
    "end",
  ];
  return L.join("\n");
}

/** Convenience: collect + serialize in one call (what the diag wiring uses). */
export function structureDumpText(input: StructureDumpInput): string {
  return serializeStructureDump(collectStructureDump(input));
}

/** Parse a dump text block back into data. Throws on anything malformed (including an empty/stub text). */
export function parseStructureDump(text: string): StructureDumpData {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let i = 0;
  const next = (what: string): string => {
    const l = lines[i++];
    if (l === undefined) throw new Error(`structure dump: unexpected end of text, expected ${what}`);
    return l;
  };
  const head = next("header").split(/\s+/);
  if (head[0] !== STRUCTURE_DUMP_HEADER) throw new Error(`structure dump: bad header "${head.join(" ")}"`);
  const version = Number(head[1]);
  if (version !== STRUCTURE_DUMP_VERSION) throw new Error(`structure dump: unsupported version ${head[1]}`);
  const kv = (name: string): number[] => {
    const parts = next(name).split(/\s+/);
    if (parts[0] !== name) throw new Error(`structure dump: expected "${name}" line, got "${parts.join(" ")}"`);
    return parts.slice(1).map(Number);
  };
  const [cx, cy] = kv("center") as [number, number];
  const [radius] = kv("radius") as [number];
  const [view] = kv("view") as [number];
  const [x0, y0, w, h] = kv("bounds") as [number, number, number, number];
  if (![cx, cy, radius, view, x0, y0, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    throw new Error("structure dump: bad header numbers");
  }
  if (next("heights") !== "heights") throw new Error('structure dump: expected "heights"');
  const heights: number[][] = [];
  for (let r = 0; r < h; r++) {
    const row = next(`height row ${r}`).split(",").map(Number);
    if (row.length !== w || !row.every(Number.isFinite)) throw new Error(`structure dump: height row ${r} has ${row.length} values, expected ${w}`);
    heights.push(row);
  }
  const [count] = kv("pieces") as [number];
  const pieces: StructureDumpPiece[] = [];
  for (let n = 0; n < count; n++) {
    const parts = next(`piece ${n}`).split(/\s+/);
    if (parts[0] !== "P" || parts.length !== 8) throw new Error(`structure dump: bad piece line "${parts.join(" ")}"`);
    const [x, y, z, rot, tier, variant] = parts.slice(2).map(Number);
    if (![x, y, z, rot, tier, variant].every(Number.isFinite)) throw new Error(`structure dump: non-numeric piece line "${parts.join(" ")}"`);
    pieces.push({ key: parts[1]!, x: x!, y: y!, z: z!, rot: rot!, tier: tier!, variant: variant! });
  }
  if (next("end") !== "end") throw new Error('structure dump: expected "end"');
  return { version, center: { x: cx, y: cy }, radius, view: view & 3, x0, y0, w, h, heights, pieces };
}

/** Raw terrain height for a world tile from parsed dump data; undefined outside the dumped square. */
export function dumpHeightAt(data: StructureDumpData, tx: number, ty: number): number | undefined {
  const lx = tx - data.x0, ly = ty - data.y0;
  if (lx < 0 || ly < 0 || lx >= data.w || ly >= data.h) return undefined;
  return data.heights[ly]![lx];
}
