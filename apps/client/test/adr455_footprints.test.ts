/**
 * ADR-455: footprints in snow and mud — CLIENT-SIDE ONLY transient decals (the net client never steps
 * the sim, so a sim-side store would be invisible; each client stamps its own footprints from the
 * replicated state it already has). A mover near the local player stamps its tile only when it entered
 * a new tile and the surface qualifies (ground snow cover >= 0.5, or the chunk wetness >= 0.5). Prints
 * fade linearly over 60 s and are pruned; the store is capped at 512 (oldest evicted first). The
 * overlay is one-frame VFX spawns (flat ground decals, alpha from remaining life).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setSeason, Transform, type Entity, type World } from "@engine/core";
import * as G from "@engine/gameplay";
import { makeWorld, spawnLearned } from "../../../packages/gameplay/test/helpers.js";
import {
  FootprintStore, sampleFootprints, collectFootprintOverlays, footprintTuning, snowCoverOf, quantizeDir8,
  DEFAULT_FOOTPRINTS_TUNING,
} from "../src/footprints.js";
import { paintFootprintPixels, footprintAtlasSources, FOOTPRINT_ATLAS_KEY, FOOTPRINT_SPRITE_KEY } from "../src/footprints-art.js";

const tuning = footprintTuning(G.defaultDefs().environment);
const move = (w: World, e: Entity, x: number, y: number) => { w.set(e, Transform, { x, y, z: 0, facing: 0 }); };
/** Advance the tick past one sample interval and sample (the sampler is 5-tick gated). */
const step = (store: FootprintStore, w: World, px: number, py: number, snow: number) => {
  w.tick += 5; sampleFootprints(store, w, px, py, w.tick, tuning, snow);
};
const winter = (w: World) => { setSeason(w, 2, 1.5); return snowCoverOf(w); };
/** Soak chunk (0,0) (tile 5,5 lives there) and return the wetness the sampler reads. */
const soak = (w: World) => {
  const s = G.ensureChunkSurface(w, "0,0");
  w.setField(s, G.ChunkSurface, "wetness", 255);
  return G.chunkWetnessAt(w, 5, 5);
};

describe("ADR-455 footprints in snow and mud", () => {
  it("tuning: fade 60 s, snow 0.5, wetness 0.5, near 40, sample 5 ticks, cap 512", () => {
    expect(tuning).toEqual({ fadeSeconds: 60, snowCover: 0.5, wetness: 0.5, nearPlayerTiles: 40, sampleTicks: 5, maxFootprints: 512 });
    expect(DEFAULT_FOOTPRINTS_TUNING).toEqual(tuning);
  });

  it("walking in snow stamps a footprint per tile (facing east, variant alternates)", () => {
    const w = makeWorld();
    const snow = winter(w);
    expect(snow).toBeGreaterThan(0.5);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow); // first sample records the position, stamps nothing
    expect(store.stamps.size).toBe(0);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, snow); // east, one tile
    expect(store.stamps.size).toBe(1);
    const s = store.stamps.get("6,5")!;
    expect(s).toBeDefined();
    expect(s.facing).toBe(0); // east: heading atan2(0,1) = 0 -> quantizeDir8 0
    expect(s.variant).toBe(0);
    expect(s.untilTick).toBe(w.tick + 60 * 20);
    move(w, p, 7.5, 5.5); step(store, w, 7.5, 5.5, snow);
    expect(store.stamps.size).toBe(2);
    expect(store.stamps.get("7,5")!.variant).toBe(1); // left/right foot alternates
  });

  it("no snow, no mud, no footprints (dry summer grass)", () => {
    const w = makeWorld(); // summer by default: snow cover 0, chunk dry
    expect(snowCoverOf(w)).toBe(0);
    expect(G.chunkWetnessAt(w, 5, 5)).toBe(0);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, 0);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, 0);
    move(w, p, 7.5, 5.5); step(store, w, 7.5, 5.5, 0);
    expect(store.stamps.size).toBe(0);
  });

  it("walking in mud stamps (soaked chunk, summer, no snow)", () => {
    const w = makeWorld();
    expect(snowCoverOf(w)).toBe(0);
    expect(soak(w)).toBe(1);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, 0);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, 0);
    expect(store.stamps.size).toBe(1);
    expect(store.stamps.has("6,5")).toBe(true);
  });

  it("standing still stamps nothing (no tile entry, no refresh)", () => {
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, snow);
    expect(store.stamps.size).toBe(1);
    const until = store.stamps.get("6,5")!.untilTick;
    for (let i = 0; i < 10; i++) step(store, w, 6.5, 5.5, snow); // 50 ticks standing still
    expect(store.stamps.size).toBe(1);
    expect(store.stamps.get("6,5")!.untilTick).toBe(until); // never refreshed while standing
  });

  it("a mover far from the player stamps nothing (near-player gate)", () => {
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 100.5, 5.5);
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow);
    move(w, rabbit, 101.5, 5.5); step(store, w, 5.5, 5.5, snow);
    expect(store.stamps.size).toBe(0);
    // ...but the same rabbit near the player does stamp (animals leave prints too)
    move(w, rabbit, 6.5, 6.5); step(store, w, 5.5, 5.5, snow);
    expect(store.stamps.has("6,6")).toBe(true);
    expect(p).toBeDefined();
  });

  it("footprints fade after 60 s (pruned on the next sample)", () => {
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, snow);
    expect(store.stamps.size).toBe(1);
    w.tick += 60 * 20; // past the 60 s fade
    sampleFootprints(store, w, 6.5, 5.5, w.tick, tuning, snow);
    expect(store.stamps.size).toBe(0);
  });

  it("the store caps at 512 (oldest evicted first)", () => {
    // A long fade so expiry cannot interfere: the cap is the only limiter here (a 600-tile walk at
    // 5 ticks/sample takes 150 s, past the 60 s fade — with the real fade the store holds 240).
    const longFade = { ...tuning, fadeSeconds: 600 };
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    w.tick += 5; sampleFootprints(store, w, 5.5, 5.5, w.tick, longFade, snow);
    for (let i = 1; i <= 600; i++) {
      move(w, p, 5.5 + i, 5.5); w.tick += 5;
      sampleFootprints(store, w, 5.5 + i, 5.5, w.tick, longFade, snow);
    }
    expect(store.stamps.size).toBe(512);
    expect(store.stamps.has("6,5")).toBe(false); // the oldest print was evicted
    expect(store.stamps.has("605,5")).toBe(true); // the newest is kept
  });

  it("the overlay is flat VFX spawns with alpha from remaining life", () => {
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow);
    move(w, p, 6.5, 5.5); step(store, w, 6.5, 5.5, snow);
    const out: import("@engine/render").VfxSpawn[] = [];
    collectFootprintOverlays(store, { boot: 42 }, w.tick, 60 * 20, out);
    expect(out.length).toBe(1);
    const o = out[0]!;
    expect(o.spriteId).toBe(42);
    expect(o.flat).toBe(true);
    expect(o.alpha).toBeCloseTo(1, 2); // fresh print: full strength
    expect(o.facing).toBe(0);
    // Halfway through the fade the alpha is ~0.5.
    w.tick += 30 * 20;
    collectFootprintOverlays(store, { boot: 42 }, w.tick, 60 * 20, out);
    expect(out[0]!.alpha).toBeCloseTo(0.5, 2);
    // Past expiry the overlay is empty (even before the sampler prunes).
    w.tick += 31 * 20;
    collectFootprintOverlays(store, { boot: 42 }, w.tick, 60 * 20, out);
    expect(out.length).toBe(0);
  });

  it("quantizeDir8: east 0, south 2, west 4, north 6 (world atan2, clockwise)", () => {
    expect(quantizeDir8(0)).toBe(0); // (1,0)
    expect(quantizeDir8(Math.PI / 2)).toBe(2); // (0,1)
    expect(quantizeDir8(Math.PI)).toBe(4); // (-1,0)
    expect(quantizeDir8(-Math.PI / 2)).toBe(6); // (0,-1)
  });

  it("the painted atlas has 8 distinct facing frames (512x64, non-empty)", () => {
    const a = paintFootprintPixels();
    expect(a.width).toBe(512); expect(a.height).toBe(64);
    const nonEmpty = (f: number): number => {
      let n = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (a.pixels[(y * 512 + f * 64 + x) * 4 + 3]! > 0) n++;
      return n;
    };
    for (let f = 0; f < 8; f++) expect(nonEmpty(f), `frame ${f}`).toBeGreaterThan(100);
    // Opposite facings paint differently (the print is directional, not a blob).
    const frame0 = a.pixels.slice(0, 64 * 64 * 4);
    const frame4 = a.pixels.slice(4 * 64 * 64 * 4, 5 * 64 * 64 * 4);
    expect(Buffer.from(frame0).equals(Buffer.from(frame4))).toBe(false);
  });

  it("the fragment declares the footprint atlas + sprite (layout only, dirStride 1)", () => {
    const frag = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task455/manifest.task455.json"), "utf8"));
    expect(frag.atlases).toHaveLength(1);
    expect(frag.atlases[0].key).toBe(FOOTPRINT_ATLAS_KEY);
    expect(frag.atlases[0].columns).toBe(8); expect(frag.atlases[0].rows).toBe(1);
    expect(frag.sprites).toHaveLength(1);
    expect(frag.sprites[0].key).toBe(FOOTPRINT_SPRITE_KEY);
    expect(frag.sprites[0].animations.idle.directions).toBe(8);
    expect(frag.sprites[0].animations.idle.dirStride).toBe(1);
  });

  it("footprintAtlasSources is a no-op map in a canvas-less environment (no crash)", async () => {
    const m = await footprintAtlasSources();
    expect(m instanceof Map).toBe(true);
  });
});
