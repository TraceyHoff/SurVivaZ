/** ADR-319/320 client render helpers: rider pose on the mount seat anchor, screen-neutral layer order, sheet / saddle keys, gait. */
import { describe, expect, it } from "vitest";
import { MOUNT_SCALE, MOUNT_SPECIES, mountSpeciesOfKey, riderSeatLiftZ } from "@engine/gameplay";
import { BAR_PX_PER_ART_PX, LAYER_KEY, mountForeKey, mountGait, mountSpriteKeyOf, riderPose, riderSeatZ, saddleOverlayKey, screenNeutralShift } from "../src/mount-render.js";
import { animChainFor } from "@engine/render";
import { AnimState } from "@engine/core";
import manifest from "../../../packages/assets/pack/nature/manifest.nature.json";

const screen = (x: number, y: number, z: number) => ({ sx: (x - y) * 32, sy: (x + y) * 16 - z * 16, key: x + y + z / 3 });
const keys = new Set((manifest as unknown as { sprites: { key: string }[] }).sprites.map((s) => s.key));

describe("ADR-319 mount rendering", () => {
  it("sheet, fore and saddle overlay keys exist in the art pack for every species and tier", () => {
    for (let i = 1; i <= MOUNT_SPECIES.length; i++) {
      expect(keys.has(mountSpriteKeyOf(i)), mountSpriteKeyOf(i)).toBe(true); expect(keys.has(mountForeKey(i)), mountForeKey(i)).toBe(true);
      for (const t of [1, 2, 3, 4]) expect(keys.has(saddleOverlayKey(t, i)), saddleOverlayKey(t, i)).toBe(true);
    }
    expect(saddleOverlayKey(0, 1)).toBe(""); expect(saddleOverlayKey(4, mountSpeciesOfKey("buffalo"))).toBe("mount_saddle_bison_steel");
  });
  it("screen-neutral shifts keep the screen spot and only raise the depth key, in every view rotation", () => {
    for (const q of [0, 1, 2, 3]) {
      const s = screenNeutralShift(0.03, q); const a = screen(0, 0, 0); const rot = (x: number, y: number) => { const c = [1, 0, -1, 0][q]!, n = [0, 1, 0, -1][q]!; return { u: c * x - n * y, v: n * x + c * y }; };
      const r = rot(s.dx, s.dy); const b = screen(r.u, r.v, s.dz);
      expect(b.sx).toBeCloseTo(a.sx, 6); expect(b.sy).toBeCloseTo(a.sy, 6); expect(b.key - a.key).toBeCloseTo(0.03, 6);
    }
    expect(LAYER_KEY.saddle).toBeLessThan(LAYER_KEY.rider); expect(LAYER_KEY.rider).toBeLessThan(LAYER_KEY.fore);
  });
  it("the rider lands on the mount's seat anchor (screen px) and sorts just above the mount, under the fore layer", () => {
    const horse = mountSpeciesOfKey("horse"); const seat = { x: 2.14, y: -41.53 };
    const p = riderPose(horse, seat, 0); const s = screen(p.dx, p.dy, p.dz);
    expect(s.sx).toBeCloseTo(2.14, 4); expect(s.sy).toBeCloseTo(-41.53, 4); expect(s.key).toBeCloseTo(LAYER_KEY.rider, 6);
    const f = riderPose(horse, undefined, 0); expect(screen(f.dx, f.dy, f.dz).sy).toBeCloseTo(-riderSeatLiftZ(horse) * MOUNT_SCALE.zStepPx, 4);
    expect(riderSeatZ(horse)).toBe(riderSeatLiftZ(horse)); expect(riderSeatZ(horse, -48)).toBeCloseTo(3, 6);
  });
  it("gait: idle / walk / gallop from the ridden speed; bar scale follows the 52 px doll", () => {
    const deer = mountSpeciesOfKey("deer"); expect(mountGait(0, deer)).toBe(0); expect(mountGait(3, deer)).toBe(1); expect(mountGait(9, deer)).toBe(2);
    expect(BAR_PX_PER_ART_PX).toBeCloseTo(74 / 52, 6);
  });
  it("a seated rider plays ride_<gait> (frame-locked to the mount), falling back to the ride_* chain then idle (ADR-322: no vehicle / sit)", () => {
    expect(animChainFor(AnimState.Sit, { ride: 2 })?.[0]).toBe("ride_gallop"); expect(animChainFor(AnimState.Sit, { ride: 0 })).not.toContain("vehicle");
    expect(animChainFor(AnimState.Sit, { driver: true })?.[0]).toBe("vehicle");
  });
});
