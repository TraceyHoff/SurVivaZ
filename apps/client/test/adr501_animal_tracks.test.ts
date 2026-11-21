/**
 * ADR-501: animal tracks in snow and mud. Animals already left footprints (ADR-455) — boot prints,
 * the same as players. Now animals leave their own track: two small iso-aligned ovals painted with
 * the same Px grammar as the boot print, in the same colours, one generic track in v1. Players,
 * bots and zombies keep the boot print. The stamp records which sprite (track flag); the overlay
 * picks per stamp, falling back to the boot print when the track sprite is unavailable (the status
 * quo, not a wrong-looking track). Client-only, WebGL2-only like the footprint system.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setSeason, Transform, type Entity, type World } from "@engine/core";
import * as G from "@engine/gameplay";
import { makeWorld, spawnLearned } from "../../../packages/gameplay/test/helpers.js";
import {
  FootprintStore, sampleFootprints, collectFootprintOverlays, footprintTuning, snowCoverOf,
} from "../src/footprints.js";
import { paintFootprintPixels, paintTrackPixels, trackAtlasSources, TRACK_ATLAS_KEY, TRACK_SPRITE_KEY } from "../src/footprints-art.js";

const tuning = footprintTuning(G.defaultDefs().environment);
const move = (w: World, e: Entity, x: number, y: number) => { w.set(e, Transform, { x, y, z: 0, facing: 0 }); };
/** Advance the tick past one sample interval and sample (the sampler is 5-tick gated). */
const step = (store: FootprintStore, w: World, px: number, py: number, snow: number) => {
  w.tick += 5; sampleFootprints(store, w, px, py, w.tick, tuning, snow);
};
const winter = (w: World) => { setSeason(w, 2, 1.5); return snowCoverOf(w); };

describe("ADR-501 animal tracks in snow and mud", () => {
  it("animals stamp the track, players and zombies stamp the boot print", () => {
    const w = makeWorld();
    const snow = winter(w);
    expect(snow).toBeGreaterThan(0.5);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 5.5, 7.5);
    const z = G.spawnZombie(w, "zombie_walker", 5.5, 9.5);
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow); // first sample records positions, stamps nothing
    expect(store.stamps.size).toBe(0);
    move(w, p, 6.5, 5.5); move(w, rabbit, 6.5, 7.5); move(w, z, 6.5, 9.5);
    step(store, w, 6.5, 5.5, snow);
    expect(store.stamps.size).toBe(3);
    expect(store.stamps.get("6,5")!.track).toBe(false); // player: boot print
    expect(store.stamps.get("6,7")!.track).toBe(true); // animal: track
    expect(store.stamps.get("6,9")!.track).toBe(false); // zombie: boot print, as today
  });

  it("the overlay picks the track sprite for track stamps and the boot for boot stamps", () => {
    const w = makeWorld();
    const snow = winter(w);
    const p = spawnLearned(w, { x: 5.5, y: 5.5 });
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 5.5, 7.5);
    const store = new FootprintStore();
    step(store, w, 5.5, 5.5, snow);
    move(w, p, 6.5, 5.5); move(w, rabbit, 6.5, 7.5);
    step(store, w, 6.5, 5.5, snow);
    const out: import("@engine/render").VfxSpawn[] = [];
    collectFootprintOverlays(store, { boot: 42, track: 77 }, w.tick, 60 * 20, out);
    expect(out.length).toBe(2);
    const byTile = new Map(out.map((o) => [`${Math.floor(o.x)},${Math.floor(o.y)}`, o.spriteId]));
    expect(byTile.get("6,5")).toBe(42); // player print: boot
    expect(byTile.get("6,7")).toBe(77); // animal print: track
    // Without a track sprite the animal print falls back to the boot print (status quo).
    collectFootprintOverlays(store, { boot: 42 }, w.tick, 60 * 20, out);
    expect(out.map((o) => o.spriteId)).toEqual([42, 42]);
  });

  it("the painted track is two small ovals: 8 distinct frames, smaller than the boot print", () => {
    const a = paintTrackPixels();
    expect(a.width).toBe(512); expect(a.height).toBe(64);
    const painted = (px: { pixels: Uint8ClampedArray }, f: number): number => {
      let n = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (px.pixels[(y * 512 + f * 64 + x) * 4 + 3]! > 0) n++;
      return n;
    };
    let trackTotal = 0, bootTotal = 0;
    const boot = paintFootprintPixels();
    for (let f = 0; f < 8; f++) {
      expect(painted(a, f), `track frame ${f}`).toBeGreaterThan(20);
      trackTotal += painted(a, f);
      bootTotal += painted(boot, f);
    }
    // Smaller than the boot print (a paw, not a boot), and a different picture.
    expect(trackTotal).toBeLessThan(bootTotal);
    const frame0 = a.pixels.slice(0, 64 * 64 * 4);
    const frame4 = a.pixels.slice(4 * 64 * 64 * 4, 5 * 64 * 64 * 4);
    expect(Buffer.from(frame0).equals(Buffer.from(frame4))).toBe(false);
    expect(Buffer.from(a.pixels).equals(Buffer.from(boot.pixels))).toBe(false);
  });

  it("the fragment declares the animal-track atlas + sprite (layout only, dirStride 1)", () => {
    const frag = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task501/manifest.task501.json"), "utf8"));
    expect(frag.atlases).toHaveLength(1);
    expect(frag.atlases[0].key).toBe(TRACK_ATLAS_KEY);
    expect(frag.atlases[0].columns).toBe(8); expect(frag.atlases[0].rows).toBe(1);
    expect(frag.sprites).toHaveLength(1);
    expect(frag.sprites[0].key).toBe(TRACK_SPRITE_KEY);
    expect(frag.sprites[0].animations.idle.directions).toBe(8);
    expect(frag.sprites[0].animations.idle.dirStride).toBe(1);
  });

  it("trackAtlasSources is a no-op map in a canvas-less environment (no crash)", async () => {
    const m = await trackAtlasSources();
    expect(m instanceof Map).toBe(true);
  });
});
