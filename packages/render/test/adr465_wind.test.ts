/**
 * ADR-465: wind that does things (render side) — hearth and burning smoke drifts with the wind
 * (wind vector * 0.6 tiles/s); embers keep their radial spread. Canvas2D keeps radial smoke
 * (its hearthParticles path is separate) — WebGL2 only in v1.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, defineComponent } from "@engine/core";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { BurningFx, FireState, HearthFx, VfxLayer, type BurningDefT } from "../src/index.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";

const ROOT = join(__dirname, "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as T;
const bld = json<ManifestJson>("packages/assets/pack/building/manifest.building.json");
const base = json<ManifestJson>("packages/assets/pack/manifest.json");
const { registry: reg } = loadManifest(mergeManifests([{ name: "base", manifest: base }, { name: "building", manifest: bld }]).manifest);
const atlas = { registry: reg, pieceInfo: () => ({ fw: 1, fh: 1 }) } as unknown as AtlasManager;
const smokeSprite = reg.effect("campfire_smoke").sprite;
const emberSprite = reg.effect("campfire_sparks").sprite;

/** Deterministic rnd: same draws in the same order for the wind and no-wind runs, so each particle
 * matches pairwise and only the wind bias differs. First draw 0.01 passes both spawn break-checks
 * (smoke expect ≈ 0.025/update, embers ≈ 0.07/update at dt 1/60). */
const seq = () => { let i = 0; const vals = [0.01, 0.6, 0.3, 0.8, 0.2, 0.9, 0.4, 0.7]; return () => vals[i++ % vals.length]!; };

describe("ADR-465 smoke drifts with the wind", () => {
  it("hearth smoke gains wind.x * 0.6 / wind.y * 0.6; embers are unchanged", () => {
    const run = (wind?: { x: number; y: number }) => {
      const Lit = defineComponent("Adr465Lit", { lit: "u8" });
      const w = new World(); w.register(Transform); w.register(Lit);
      const a = w.create(); w.add(a, Transform, { x: 1, y: 1, z: 0 });
      const h = new HearthFx(); h.rnd = seq();
      const v = new VfxLayer();
      for (let k = 0; k < 240; k++) h.update(w, new Map([[a, FireState.Hearth]]), Lit, undefined, atlas, v, 1 / 60, undefined, wind);
      return v.active;
    };
    const calm = run();
    const windy = run({ x: 2, y: -1 });
    const smokeCalm = calm.filter((p) => p.spriteId === smokeSprite);
    const smokeWindy = windy.filter((p) => p.spriteId === smokeSprite);
    expect(smokeCalm.length).toBeGreaterThan(0);
    expect(smokeWindy.length).toBe(smokeCalm.length);
    for (let i = 0; i < smokeCalm.length; i++) {
      expect(smokeWindy[i]!.vx - smokeCalm[i]!.vx).toBeCloseTo(2 * 0.6, 10);
      expect(smokeWindy[i]!.vy - smokeCalm[i]!.vy).toBeCloseTo(-1 * 0.6, 10);
    }
    const emberCalm = calm.filter((p) => p.spriteId === emberSprite);
    const emberWindy = windy.filter((p) => p.spriteId === emberSprite);
    expect(emberWindy.length).toBe(emberCalm.length);
    for (let i = 0; i < emberCalm.length; i++) {
      expect(emberWindy[i]!.vx).toBeCloseTo(emberCalm[i]!.vx, 10);
      expect(emberWindy[i]!.vy).toBeCloseTo(emberCalm[i]!.vy, 10);
    }
  });

  it("burning-piece smoke drifts with the wind too", () => {
    const Burning = defineComponent("Adr465Burning", { lit: "u8", intensity: "u8", startTick: "u32" }) as unknown as BurningDefT;
    const run = (wind?: { x: number; y: number }) => {
      const w = new World(); w.register(Transform); w.register(Burning);
      const e = w.create(); w.add(e, Transform, { x: 2, y: 3, z: 0 }); w.add(e, Burning, { lit: 1, intensity: 200, startTick: 0 });
      const fx = new BurningFx(); fx.rnd = seq();
      const v = new VfxLayer();
      for (let k = 0; k < 60; k++) fx.update(w, Burning, undefined, atlas, v, k / 60, 1 / 60, wind);
      return v.active;
    };
    const calm = run();
    const windy = run({ x: 1.5, y: 0.5 });
    const smokeCalm = calm.filter((p) => p.spriteId === smokeSprite);
    const smokeWindy = windy.filter((p) => p.spriteId === smokeSprite);
    expect(smokeCalm.length).toBeGreaterThan(0);
    expect(smokeWindy.length).toBe(smokeCalm.length);
    for (let i = 0; i < smokeCalm.length; i++) {
      expect(smokeWindy[i]!.vx - smokeCalm[i]!.vx).toBeCloseTo(1.5 * 0.6, 10);
      expect(smokeWindy[i]!.vy - smokeCalm[i]!.vy).toBeCloseTo(0.5 * 0.6, 10);
    }
  });
});
