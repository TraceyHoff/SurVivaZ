/** ADR-319/320 client render helpers: seat height from the realism table (or a dedicated art "rider" anchor), saddle overlay keys, bar lift. */
import { describe, expect, it } from "vitest";
import { MOUNT_SCALE, MOUNT_SPECIES, mountSpeciesOfKey, PX_PER_M, riderSeatLiftZ } from "@engine/gameplay";
import { BAR_PX_PER_ART_PX, riderSeatZ, saddleOverlayKey } from "../src/mount-render.js";

describe("ADR-319 mount rendering", () => {
  it("rider seat lift = (seat height - seated hip) in z steps; a dedicated art anchor overrides it", () => {
    const horse = mountSpeciesOfKey("horse");
    expect(riderSeatZ(horse)).toBe(riderSeatLiftZ(horse));
    expect(riderSeatZ(horse) * MOUNT_SCALE.zStepPx).toBeCloseTo((1.45 - MOUNT_SCALE.riderSitHipM) * PX_PER_M, 4); // ~33 px: seat at rider chest height
    const anchored = riderSeatZ(horse, -48, 1); expect(anchored).toBeCloseTo((48 - MOUNT_SCALE.riderSitHipM * PX_PER_M) / 16, 5);
    expect(riderSeatZ(horse, Number.NaN)).toBe(riderSeatLiftZ(horse));
    const lifts = ["donkey", "deer", "horse", "moose"].map((k) => riderSeatZ(mountSpeciesOfKey(k))); expect([...lifts].sort((a, b) => a - b)).toEqual(lifts);
  });
  it("saddle overlays: one dedicated key per tier per species, none bareback", () => {
    const keys = MOUNT_SPECIES.flatMap((s, i) => [1, 2, 3, 4].map((t) => saddleOverlayKey(t, i + 1)));
    expect(keys).toHaveLength(24); expect(new Set(keys).size).toBe(24); expect(keys).toContain("saddle_1_horse"); expect(keys).toContain("saddle_4_buffalo");
    expect(saddleOverlayKey(0, 1)).toBe("");
    expect(BAR_PX_PER_ART_PX).toBeCloseTo(74 / 58, 6);
  });
});
