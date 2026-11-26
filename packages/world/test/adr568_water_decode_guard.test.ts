// ADR-568: permanent worldgen water-decode guard survey — the test ADR-530 needed. ADR-567 fixed the
// flow-codec collision decode-side (only ADR-411 v2 raws, >= 900, are flow water); this survey productises
// the waterfall-prep §1 scan over the real ProceduralGenerator so the collision class can never return
// silently — including when the queued ±250 height raise widens generated beds again.
//
// Invariants (about the DECODE, not about small drops — after the fix, genuine faces up to the bound
// remain: surface-0 natural water beside dry land at HEIGHT_MIN in deep basins / canyon floors):
//   1. No natural water tile decodes as flow water (isFlowWater false for every non-v2 water tile).
//   2. Every natural water tile renders at exactly WATER_SURFACE_HEIGHT and terrainLevel == stored bed.
//   3. No face out of a NATURAL water tile drops more than the legal terrain range permits from a true
//      surface: bound = WATER_SURFACE_HEIGHT - 0.25 (render inset) - HEIGHT_MIN, derived from the height
//      constants, never hard-coded — at ±100 it is 99.75; a phantom surface (bed -71 -> +75 pre-fix)
//      produces drops ~146, far above it. Faces out of v2-coded flow water (spillway / network channels /
//      elevated lakes — the designed falls) are exempt by construction: they are identified by their v2
//      encoding (stored raw >= FLOW_WATER_MIN_RAW_V2) and are not part of the natural-water face check.
//   4. Non-vacuity: the surveyed tiles must include substantial counts of natural water in the exact bed
//      ranges the retired ADR-297 legacy branches misread (<= -71 and >= +50), or the survey fails.
//
// Scope: seeds 42 and 9001 x regions (0,1) and (1,0) — full 1536x1536 regions plus a 1-tile ring for the
// face check (prep §1 method: sampleAt per tile, drop = water surface - 0.25 - neighbour surface, directed
// water->neighbour faces over the 4-neighbourhood). This supersedes the compact sweep in
// adr567_flow_codec.test.ts (seed 42, 512x512 of region (0,1) — that region is surveyed in full here);
// ADR-567's unit pins are untouched. Measured runtime: ~45 s for the file (see DECISIONS ADR-568).
import { describe, expect, it } from "vitest";
import {
  ProceduralGenerator, REGION_SIZE, HEIGHT_MIN, HEIGHT_MAX, WATER_SURFACE_HEIGHT,
  FLOW_WATER_MIN_RAW_V2, FLOW_WATER_OFFSET_V2,
  isFlowWater, isWaterId, renderTileHeight, terrainLevel,
} from "../src/index.js";

// Classification is by the STORED ENCODING, never by the decode under test: a water tile whose raw is a
// v2 flow code (raw >= FLOW_WATER_MIN_RAW_V2) is designed-fall / flowed water; every other water tile is
// natural water, whatever isFlowWater currently says about it. (Classifying via isFlowWater would let a
// broken decode exempt its own victims — the pre-fix legacy decode does exactly that.)

/** The largest drop a true natural-water surface can make to any legal neighbour (see invariant 3). */
const MAX_NATURAL_FACE_DROP = WATER_SURFACE_HEIGHT - 0.25 - HEIGHT_MIN;

interface RegionSurvey {
  tiles: number;
  naturalWater: number;
  flowWater: number;
  deepBeds: number; // natural beds <= -71 — the legacy branch's floating-water band (bed -71 -> +75)
  highBeds: number; // natural beds >= +50 — the legacy branch's sunken-water band (raw - 80)
  faces: number;
  facesGe15: number;
  maxDrop: number;
  violations: string[];
}

const totals: RegionSurvey = {
  tiles: 0, naturalWater: 0, flowWater: 0, deepBeds: 0, highBeds: 0,
  faces: 0, facesGe15: 0, maxDrop: 0, violations: [],
};

function surveyRegion(seed: number, rx: number, ry: number): RegionSurvey {
  const g = new ProceduralGenerator({ seed });
  const S = REGION_SIZE, W = S + 2; // region plus a 1-tile ring so edge tiles have all 4 neighbours
  const x0 = rx * S - 1, y0 = ry * S - 1;
  const tile = new Uint8Array(W * W), raw = new Int16Array(W * W), surf = new Int16Array(W * W);
  const out: RegionSurvey = {
    tiles: 0, naturalWater: 0, flowWater: 0, deepBeds: 0, highBeds: 0,
    faces: 0, facesGe15: 0, maxDrop: -Infinity, violations: [],
  };
  const bad = (msg: string) => { if (out.violations.length < 8) out.violations.push(msg); };

  for (let ly = 0; ly < W; ly++) for (let lx = 0; lx < W; lx++) {
    const s = g.sampleAt(x0 + lx, y0 + ly);
    const i = ly * W + lx;
    tile[i] = s.tile; raw[i] = s.height; surf[i] = renderTileHeight(s.tile, s.height);
    if (lx === 0 || ly === 0 || lx === W - 1 || ly === W - 1) continue; // ring: neighbours only
    out.tiles++;
    if (!isWaterId(s.tile)) continue;
    if (s.height >= FLOW_WATER_MIN_RAW_V2) {
      // v2-coded designed-fall / flowed water: exempt from the natural-water invariants, but its own
      // decode is pinned — it must still read as flow at exactly raw - FLOW_WATER_OFFSET_V2.
      out.flowWater++;
      if (!isFlowWater(s.tile, s.height)) bad(`v2 flow water not decoded as flow at (${x0 + lx},${y0 + ly}) raw=${s.height}`);
      if (terrainLevel(s.tile, s.height) !== s.height - FLOW_WATER_OFFSET_V2)
        bad(`v2 flow water terrainLevel ${terrainLevel(s.tile, s.height)} != ${s.height - FLOW_WATER_OFFSET_V2} at (${x0 + lx},${y0 + ly})`);
      continue;
    }
    out.naturalWater++;
    if (s.height <= -71) out.deepBeds++;
    if (s.height >= 50) out.highBeds++;
    // Invariants 1+2, asserted against the decode functions tile by tile.
    if (isFlowWater(s.tile, s.height)) bad(`natural water decoded as flow at (${x0 + lx},${y0 + ly}) raw=${s.height}`);
    if (renderTileHeight(s.tile, s.height) !== WATER_SURFACE_HEIGHT)
      bad(`natural water surface ${renderTileHeight(s.tile, s.height)} != ${WATER_SURFACE_HEIGHT} at (${x0 + lx},${y0 + ly}) raw=${s.height}`);
    if (terrainLevel(s.tile, s.height) !== s.height)
      bad(`natural water terrainLevel ${terrainLevel(s.tile, s.height)} != bed ${s.height} at (${x0 + lx},${y0 + ly})`);
    if (s.height < HEIGHT_MIN || s.height > HEIGHT_MAX)
      bad(`natural water bed ${s.height} outside [HEIGHT_MIN, HEIGHT_MAX] at (${x0 + lx},${y0 + ly})`);
  }

  // Invariant 3: directed faces out of natural water tiles (interior only; neighbours from the ring).
  for (let ly = 1; ly <= S; ly++) for (let lx = 1; lx <= S; lx++) {
    const i = ly * W + lx;
    const t = tile[i]!, r = raw[i]!, sf = surf[i]!;
    if (!isWaterId(t) || r >= FLOW_WATER_MIN_RAW_V2) continue; // natural-water faces only
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const drop = sf - 0.25 - surf[i + dy * W + dx]!;
      out.faces++;
      if (drop >= 15) out.facesGe15++;
      if (drop > out.maxDrop) out.maxDrop = drop;
      if (drop > MAX_NATURAL_FACE_DROP)
        bad(`natural water face drop ${drop} > bound ${MAX_NATURAL_FACE_DROP} at (${x0 + lx},${y0 + ly}) raw=${r}`);
    }
  }
  return out;
}

const REGIONS: Array<[seed: number, rx: number, ry: number]> = [
  [42, 0, 1], [42, 1, 0], [9001, 1, 0], [9001, 0, 1],
];

describe("ADR-568 worldgen water-decode guard survey (2 seeds x 2 regions, full regions)", () => {
  for (const [seed, rx, ry] of REGIONS) {
    it(`seed ${seed} region (${rx},${ry}): no natural water decodes as flow, all surfaces true, faces within the derived bound`, () => {
      const r = surveyRegion(seed, rx, ry);
      for (const k of ["tiles", "naturalWater", "flowWater", "deepBeds", "highBeds", "faces", "facesGe15"] as const)
        totals[k] += r[k];
      totals.maxDrop = Math.max(totals.maxDrop, r.maxDrop);
      totals.violations.push(...r.violations.map((v) => `seed ${seed} (${rx},${ry}): ${v}`));
      console.log(
        `ADR-568 seed ${seed} region (${rx},${ry}): tiles=${r.tiles} naturalWater=${r.naturalWater} ` +
        `flowWater=${r.flowWater} deepBeds=${r.deepBeds} highBeds=${r.highBeds} faces=${r.faces} ` +
        `faces>=15=${r.facesGe15} maxDrop=${r.maxDrop} bound=${MAX_NATURAL_FACE_DROP}`,
      );
      expect(r.tiles).toBe(REGION_SIZE * REGION_SIZE);
      expect(r.naturalWater).toBeGreaterThan(0);
      expect(r.violations, r.violations.join("; ")).toEqual([]);
      expect(r.maxDrop).toBeLessThanOrEqual(MAX_NATURAL_FACE_DROP);
    }, 300_000);
  }

  it("non-vacuity: the survey exercised the legacy danger bands in bulk, plus genuine v2 flow water", () => {
    console.log(
      `ADR-568 totals: tiles=${totals.tiles} naturalWater=${totals.naturalWater} flowWater=${totals.flowWater} ` +
      `deepBeds=${totals.deepBeds} highBeds=${totals.highBeds} faces=${totals.faces} faces>=15=${totals.facesGe15} maxDrop=${totals.maxDrop}`,
    );
    expect(totals.violations, totals.violations.join("; ")).toEqual([]);
    // The bands the retired legacy branches misread — without bulk coverage here the invariants are vacuous.
    expect(totals.deepBeds).toBeGreaterThan(10_000); // beds <= -71 decoded to phantom +48..+75 pre-fix
    expect(totals.highBeds).toBeGreaterThan(10_000); // beds >= +50 decoded sunken (raw - 80) pre-fix
    expect(totals.naturalWater).toBeGreaterThan(500_000);
    expect(totals.flowWater).toBeGreaterThan(100); // designed falls (spillway / channels) really were present and exempted
    expect(totals.faces).toBeGreaterThan(1_000_000);
  }, 30_000);
});
