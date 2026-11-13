import { describe, it, expect, afterEach, vi } from "vitest";
import { loadMergedPackManifest } from "@engine/assets/node";
import type { AssetRegistry, Atlas } from "@engine/assets";
import { buildSpriteTables, addDirFrameRects, dirFrameIndex, STATE_ANIMS, sliced, setResizeYield, setResizeSlicing, RESIZE_SLICE_MS, type AtlasRT } from "../src/assets/atlasManager.js";

/**
 * ADR-380 (boot): the sprite runtime tables were O(S×A) — list.find / list.findIndex / list.indexOf per sprite
 * (5,326 sprites × ~654 atlases). buildSpriteTables uses id->atlas/index Maps; the output must be byte-identical.
 * The old loop below is copied verbatim from the pre-ADR-380 rebuild() so the comparison pins the old semantics.
 */
function buildSpriteTablesOld(registry: AssetRegistry, list: AtlasRT[]): ReturnType<typeof buildSpriteTables> {
  const sprites: ReturnType<typeof buildSpriteTables> = [];
  for (const s of registry.allSprites()) {
    const id = s.id;
    const at = list.find((a) => a.id === s.atlas.id); if (!at) continue;
    const stateAnim = new Int16Array(STATE_ANIMS.length);
    STATE_ANIMS.forEach((names, st) => {
      let idx = 0; for (const n of names) { const i = s.animList.findIndex((a) => a.name === n); if (i >= 0) { idx = i; break; } }
      stateAnim[st] = idx;
    });
    const damage: number[] = [];
    const dmgAnim = s.animations.get("damaged");
    for (let st = 1; st <= 3; st++) {
      const named = s.animations.get(`damage${st}`);
      if (named) damage[st] = named.frames[0]!;
      else if (dmgAnim) damage[st] = dmgAnim.frames[Math.min(st - 1, dmgAnim.frames.length - 1)]!;
    }
    const b = s.building;
    const dirAt = s.animList.map((an) => an.dirFrames ? Int32Array.from(an.dirFrames, (d) => list.findIndex((x) => x.id === d.atlas.id)) : null);
    const dirF = s.animList.map((an, k) => an.dirFrames ? Int32Array.from(an.dirFrames, (d, j) => dirFrameIndex(list[dirAt[k]![j]!], d)) : null);
    sprites[id] = { atlasIdx: list.indexOf(at), anchorX: s.anchor.x, anchorY: s.anchor.y, anims: s.animList, dirAt, dirF, stateAnim, damage,
      ...(b ? { building: { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer, frames: b.frames } } : {}) };
  }
  return sprites;
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

describe("ADR-380 sprite runtime tables (real merged manifest)", () => {
  it("Map build is byte-identical to the old list.find loop, and faster, on the real registry", async () => {
    const mT0 = performance.now();
    const { result } = await loadMergedPackManifest();
    const manifestMs = performance.now() - mT0;
    const registry = result.registry;
    const atlases = [...registry.atlases.values()];
    const sprites = [...registry.allSprites()];
    console.log(`[adr380] manifest: ${atlases.length} atlases, ${sprites.length} sprites (loadMergedPackManifest ${manifestMs.toFixed(1)}ms, node — indicative only, not phone ms)`);
    // Same order as the phone's served set (654 atlases / 5,326 sprites in ?diag=1); the disk load reads the full
    // MANIFEST_INDEX, so the counts differ slightly from the served subset — the shape is what matters here.
    expect(atlases.length).toBeGreaterThan(600);
    expect(sprites.length).toBeGreaterThan(4000);
    // Fake AtlasRT rows: buildSpriteTables only reads id (via the Maps) and dirFrameIndex reads extra — run the
    // real addDirFrameRects first so the rect path is exercised exactly as rebuild does.
    const list = atlases.map((a: Atlas) => ({ id: a.id, key: a.key, count: a.columns * a.rows }) as unknown as AtlasRT);
    addDirFrameRects(registry, list);
    const oldTimes: number[] = [], newTimes: number[] = [];
    let oldTables: ReturnType<typeof buildSpriteTables> | undefined, newTables: ReturnType<typeof buildSpriteTables> | undefined;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now(); oldTables = buildSpriteTablesOld(registry, list); oldTimes.push(performance.now() - t0);
      const t1 = performance.now(); newTables = buildSpriteTables(registry, list); newTimes.push(performance.now() - t1);
    }
    expect(newTables).toEqual(oldTables);
    const oldMed = median(oldTimes), newMed = median(newTimes);
    console.log(`[adr380] sprite tables on real registry: old list.find loop median ${oldMed.toFixed(2)}ms, new Map loop median ${newMed.toFixed(2)}ms (7 runs each, this VM)`);
    expect(newMed).toBeLessThanOrEqual(oldMed);
  }, 60000);
});

describe("ADR-380 resize slicing off during boot", () => {
  afterEach(() => { setResizeYield(null); setResizeSlicing(true); vi.unstubAllGlobals(); });

  it("slicing off: a boot-sized resize burst runs with zero frame yields; re-enabling restores the 6ms slice", async () => {
    let clock = 0; const perFrame: number[] = [0];
    setResizeYield(async () => { perFrame.push(0); }, () => clock);
    setResizeSlicing(false);
    const jobs = Array.from({ length: 120 }, () => sliced(() => { clock += 3; perFrame[perFrame.length - 1]! += 3; }));
    await Promise.all(jobs);
    expect(perFrame.length).toBe(1); // no frame yield at all while slicing is off
    expect(perFrame.reduce((s, x) => s + x, 0)).toBe(360); // all work done, in order
    // Re-enabling restores the ADR-190 behaviour: no frame carries more than RESIZE_SLICE_MS (+1 job) of work.
    setResizeSlicing(true);
    const jobs2 = Array.from({ length: 120 }, () => sliced(() => { clock += 3; perFrame[perFrame.length - 1]! += 3; }));
    await Promise.all(jobs2);
    expect(perFrame.length).toBeGreaterThan(1);
    expect(Math.max(...perFrame.slice(1))).toBeLessThanOrEqual(RESIZE_SLICE_MS + 3);
    expect(perFrame.reduce((s, x) => s + x, 0)).toBe(720);
  });
});
