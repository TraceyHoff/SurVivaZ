// ADR-530 fix-up: flat benches restore single-level ruin footprints on the smooth relief.
// Pins the generator property directly, apart from the ruin test: benches exist in the
// wilderness, their cores are exactly flat, the ramp starts gently (no cliff at the core
// edge), and no bench ever reaches the byte-identical inner zone (<= 160).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, massifBumpAt } from "../src/index.js";

function findBenches(g: ProceduralGenerator, lo: number, hi: number, step: number) {
  const found: { cx: number; cy: number; r0: number; level: number }[] = [];
  const seen = new Set<string>();
  for (let y = lo; y <= hi; y += step) for (let x = lo; x <= hi; x += step) {
    const b = g.benchAt(x, y);
    if (!b) continue;
    const key = `${Math.round(b.cx)},${Math.round(b.cy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(b);
  }
  return found;
}

function massifBump(g: ProceduralGenerator, x: number, y: number): number {
  let best = 0;
  for (const m of g.massifsInRegion(Math.floor(x / REGION_SIZE), Math.floor(y / REGION_SIZE))) {
    best = Math.max(best, massifBumpAt(m, x, y));
  }
  return best;
}

describe("ADR-530 flat benches", () => {
  it.each([1, 42])("seed %i: benches exist in the wilderness and are exactly flat inside", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const benches = findBenches(g, 200, 400, 8);
    expect(benches.length).toBeGreaterThanOrEqual(3);
    for (const b of benches) {
      // Core exactly flat: every sampled tile inside the square reads the bench level (plus any
      // massif bump — benches only apply where the bump is 0, so a core tile under a massif
      // reads level + bump). Sampled to r0 - 1: the bench centre is a float, so a tile at the
      // square edge from the rounded centre can sit outside the true core.
      for (let dy = -(b.r0 - 1); dy <= b.r0 - 1; dy += 4) for (let dx = -(b.r0 - 1); dx <= b.r0 - 1; dx += 4) {
        const tx = Math.round(b.cx + dx), ty = Math.round(b.cy + dy);
        expect(g.heightAt(tx, ty)).toBe(b.level + massifBump(g, tx, ty));
      }
      // No cliff at the core edge: consecutive steps outward along a ray stay small (the
      // grade gate bounds the first step; measured max 4 over these seeds).
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        let prev = b.level;
        for (const dr of [1, 2, 3]) {
          const h = g.heightAt(Math.round(b.cx + (b.r0 + dr) * Math.cos(a)), Math.round(b.cy + (b.r0 + dr) * Math.sin(a)));
          expect(Math.abs(h - prev)).toBeLessThanOrEqual(6);
          prev = h;
        }
      }
    }
  });

  it("no bench reaches the inner zone (<= 160 stays byte-identical)", () => {
    for (const seed of [1, 42, 1234]) {
      const g = new ProceduralGenerator({ seed });
      for (let y = -160; y <= 160; y += 7) for (let x = -160; x <= 160; x += 7) {
        expect(g.benchAt(x, y)).toBeUndefined();
      }
    }
  });

  it("benches:false disables benches entirely", () => {
    const g = new ProceduralGenerator({ seed: 1, benches: false });
    for (let y = 200; y <= 400; y += 8) for (let x = 200; x <= 400; x += 8) {
      expect(g.benchAt(x, y)).toBeUndefined();
    }
  });

  it("a flat disc of radius >= 20 exists in the wilderness by height alone", () => {
    // No benchAt involved: the smooth field itself must contain exactly-flat discs, which is
    // the property the ruin footprints (and player building) need. On pre-fix code the smooth
    // field has no such disc, so this fails there.
    const g = new ProceduralGenerator({ seed: 1 });
    let found = false;
    outer: for (let cy = 200; cy <= 400; cy += 8) for (let cx = 200; cx <= 400; cx += 8) {
      const level = g.heightAt(cx, cy);
      let flat = true;
      for (let dy = -20; dy <= 20 && flat; dy += 4) for (let dx = -20; dx <= 20; dx += 4) {
        if (dx * dx + dy * dy > 20 * 20) continue;
        if (g.heightAt(cx + dx, cy + dy) !== level) { flat = false; break; }
      }
      if (flat) { found = true; break outer; }
    }
    expect(found).toBe(true);
  });
});
