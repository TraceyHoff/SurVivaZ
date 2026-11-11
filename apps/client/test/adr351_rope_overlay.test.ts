// ADR-351 rope leading (client): the visible rope line between holder and led animal — pure segment /
// projection math, tested numerically (the live build is the visual check).
import { describe, expect, it } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "@engine/gameplay";
import { ROPE_COLORS, ROPE_SAG_PX, holderEntityOf, ropePoints, ropeSegments } from "../src/rope-overlay.js";
import { makeWorld, spawnLearned, steps } from "../../../packages/gameplay/test/helpers.js";

const setPid = (w: World, e: Entity, id: number): void => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: (x: number, y: number) => ({ x, y }) };

function led(x = 0, y = 0): { w: World; p: Entity; c: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 1 }); setPid(w, p, 1); steps(w, 1);
  const d = G.defaultDefs(); const rope = d.itemId("rope");
  G.addItem(w, p, rope, 1);
  const v = G.readSlots(w, p); v.put(G.HOTBAR_OFFSET, rope, 1); G.writeSlots(w, p, v, d);
  w.set(p, G.Equipment, { mainHandSlot: G.HOTBAR_OFFSET, mainHandItem: rope });
  const c = G.spawnAnimal(w, "animal_cow", x + 2, y);
  expect(G.attachLead(w, p, c)).toBe(true);
  return { w, p, c };
}

describe("ADR-351 rope overlay", () => {
  it("one segment per led animal, holder resolved from the replicated RopeLead component", () => {
    const { w, p, c } = led(0, 0);
    const segs = ropeSegments(w);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.holder).toBe(p); expect(segs[0]!.animal).toBe(c);
    expect(segs[0]!.hx).toBeCloseTo(0); expect(segs[0]!.ax).toBeCloseTo(2); // holder hand -> animal neck
    expect(holderEntityOf(w, 1)).toBe(p);
  });
  it("no segment without a lead, and a lead whose holder is gone draws nothing (no dangling rope)", () => {
    const { w, p, c } = led(0, 0);
    expect(ropeSegments(w)).toHaveLength(1);
    G.releaseLead(w, c, G.RopeResult.Released, p);
    expect(ropeSegments(w)).toEqual([]);
    // a stale RopeLead naming a holder that no longer exists is skipped, not drawn to (0,0)
    expect(G.attachLead(w, p, c)).toBe(true);
    w.destroy(p);
    expect(ropeSegments(w)).toEqual([]);
  });
  it("the rope sags between the holder's hand and the animal's neck (quadratic midpoint below the chord)", () => {
    const { w } = led(0, 0);
    const seg = ropeSegments(w)[0]!;
    const pts = ropePoints(seg, cam);
    expect(pts.hx).toBeLessThan(pts.ax); // holder left of the animal on screen
    const midChordY = (pts.hy + pts.ay) / 2;
    expect(pts.cy).toBeGreaterThan(midChordY); // sag: the middle hangs below the straight line
    expect(pts.cy - midChordY).toBeCloseTo(ROPE_SAG_PX, 0);
    expect(pts.hy).toBeLessThan(pts.ay); // the hand is lifted above the neck
  });
  it("a second led animal (another holder) draws its own segment", () => {
    const { w, p, c } = led(0, 0);
    const other = spawnLearned(w, { x: 10, y: 0, maxWeight: 0, clientId: 2 }); setPid(w, other, 2);
    const d = G.defaultDefs(); G.addItem(w, other, d.itemId("rope"), 1);
    const v = G.readSlots(w, other); v.put(G.HOTBAR_OFFSET, d.itemId("rope"), 1); G.writeSlots(w, other, v, d);
    w.set(other, G.Equipment, { mainHandSlot: G.HOTBAR_OFFSET, mainHandItem: d.itemId("rope") });
    const c2 = G.spawnAnimal(w, "animal_cow", 12, 0);
    expect(G.attachLead(w, other, c2)).toBe(true);
    const segs = ropeSegments(w);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.animal).sort()).toEqual([c, c2].sort());
    expect(ROPE_COLORS.rope).not.toBe(ROPE_COLORS.knot);
  });
});
