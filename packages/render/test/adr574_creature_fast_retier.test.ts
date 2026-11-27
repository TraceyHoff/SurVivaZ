import { describe, expect, it } from "vitest";
import { AtlasManager, RETIER_CONFIRM, RETIER_MIN_GAP_FRAMES } from "../src/assets/atlasManager.js";

/**
 * ADR-574: drawn-creature fast re-tier. The ADR-190 hysteresis (RETIER_CONFIRM = 3 consecutive checks,
 * RETIER_MIN_GAP_FRAMES = 1800 ≈ 30 s between re-tiers) meant a dog or pig that walked on screen below
 * full res stayed visibly soft for tens of seconds — and if another atlas had re-tiered earlier in the
 * session, the creature's first rebuild waited out the whole gap. Fix: when the re-tier need is driven
 * by a creature sheet (animals / pets / nature_critters, resident, in recentlyUsed, retierOpen, scale
 * < 1), retier() rebuilds on the first check, skipping both the confirms and the gap. Every other atlas
 * keeps the hysteresis exactly, and retierOpen / retierScale semantics are unchanged — a rebuild that
 * leaves the creature at x0.5 records that scale and closes the door, so there is no rebuild thrash.
 */
function am(): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 256 }) as any;
  a.atlases = []; a.coldDownscale = 0.5; a.downscale = 0.5; a.registry = {};
  return a;
}
const rt = (key: string, w = 512): any => ({ key, img: { width: w, height: w }, emis: null, masks: {}, scale: 1, cold: false });
/** A manager whose only drawn, below-1x resident atlas is `key`; rebuild is a counting stub that leaves scales as they are. */
function drawnBelow1x(key: string): { a: any; rebuilds: () => number } {
  const a = am(); const at = rt(key); a.atlases = [at];
  a.recentlyUsed = new Set([key]);
  let n = 0; a.rebuild = async () => { n++; };
  return { a, rebuilds: () => n };
}

describe("ADR-574: drawn creatures re-tier on the first check", () => {
  it("(a) a drawn pet below 1.0 rebuilds on the first retier() call — no confirms, no min-gap", async () => {
    const { a, rebuilds } = drawnBelow1x("pets_dog_lab");
    a.retierAt = 0; // a re-tier fired at frame 0: the 1800-frame gap has barely started
    expect(a.needsRetier).toBe(true);
    expect(await a.retier(30)).toBe(true);
    expect(rebuilds()).toBe(1);
  });
  it("(a) the pig's critter sheet gets the same fast path", async () => {
    const { a, rebuilds } = drawnBelow1x("nature_critters_c_40x32");
    a.retierAt = 0;
    expect(await a.retier(30)).toBe(true);
    expect(rebuilds()).toBe(1);
  });
  it("(b) a non-creature fidelity atlas still needs RETIER_CONFIRM consecutive checks", async () => {
    const { a, rebuilds } = drawnBelow1x("characters");
    for (let i = 0; i < RETIER_CONFIRM - 1; i++) expect(await a.retier(30 * (i + 1))).toBe(false);
    expect(rebuilds()).toBe(0);
    expect(await a.retier(30 * RETIER_CONFIRM)).toBe(true);
    expect(rebuilds()).toBe(1);
  });
  it("(b) a non-creature fidelity atlas still waits out the min-gap even after confirming", async () => {
    const { a, rebuilds } = drawnBelow1x("characters");
    a.retierAt = 1000; // previous re-tier at frame 1000
    for (let i = 0; i < RETIER_CONFIRM + 2; i++) expect(await a.retier(1030 + 30 * i)).toBe(false);
    expect(rebuilds()).toBe(0);
    expect(await a.retier(1000 + RETIER_MIN_GAP_FRAMES)).toBe(true);
    expect(rebuilds()).toBe(1);
  });
  it("(c) a rebuild that leaves the creature at 0.5 closes the door: no repeat rebuilds, even past the gap", async () => {
    const { a, rebuilds } = drawnBelow1x("pets_dog_lab");
    expect(await a.retier(30)).toBe(true); // fast path fires once
    expect(rebuilds()).toBe(1);
    expect(a.retierScale.get("pets_dog_lab")).toBe(0.5); // the rebuild recorded the scale it left
    expect(a.needsRetier).toBe(false); // retierOpen closed at the recorded scale
    for (let f = 60; f <= 60 + 3 * RETIER_MIN_GAP_FRAMES; f += 30) expect(await a.retier(f)).toBe(false);
    expect(rebuilds()).toBe(1);
  });
});
