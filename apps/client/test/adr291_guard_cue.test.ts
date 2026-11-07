import { describe, expect, it } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { guardCues } from "../src/guard-overlay.js";
const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: (x: number, y: number) => ({ x, y }) };
const input = (guard: boolean): G.StanceInput => ({ guard, crouch: false, carry: false, rest: false, interact: false, active: false });
function setup() {
  const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {});
  const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 }), foe = G.spawnPlayer(w, { x: 1, y: 0, clientId: 2 });
  return { w, p, foe };
}
describe("ADR-291 guard feedback on the default v1 doll (no block art)", () => {
  it("shows held guard immediately on authoritative input, including fists, and clears on release", () => {
    const { w, p } = setup(); expect(guardCues(w, cam)).toEqual([]);
    G.applyStanceInput(w, p, input(true)); expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Block);
    expect(guardCues(w, cam).map(q => q.e)).toEqual([p]);
    G.applyStanceInput(w, p, input(true)); expect(guardCues(w, cam)).toHaveLength(1);
    G.applyStanceInput(w, p, input(false)); expect(guardCues(w, cam)).toEqual([]);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Idle);
  });
  it("agrees with the damage pipeline and disappears on stamina guard break", () => {
    const { w, p, foe } = setup(); w.set(p, G.Health, { hp: 100, max: 100 }); w.setField(p, G.Survival, "stamina", 6);
    G.applyStanceInput(w, p, input(true)); expect(guardCues(w, cam)).toHaveLength(1);
    G.applyDamage(w, p, 10, foe); expect(w.getField(p, G.Health, "hp")).toBeCloseTo(97, 1);
    expect(guardCues(w, cam)).toEqual([]);
    w.setField(p, G.Survival, "stamina", 50); G.applyStanceInput(w, p, input(true)); expect(guardCues(w, cam)).toEqual([]);
    G.applyStanceInput(w, p, input(false)); G.applyStanceInput(w, p, input(true)); expect(guardCues(w, cam)).toHaveLength(1);
  });
  it("reflects other humans' shared stance without requiring local-player or appearance components", () => {
    const { w, foe } = setup(); G.applyStanceInput(w, foe, input(true)); expect(guardCues(w, cam).map(q => q.e)).toEqual([foe]);
    w.add(foe, G.Dead); expect(guardCues(w, cam)).toEqual([]);
  });
  it("never advertises ranged aim as protection", () => {
    const { w, p } = setup(); w.setField(p, G.Equipment, "mainHandItem", G.gameplayDefs(w).itemId("short_bow"));
    G.applyStanceInput(w, p, input(true)); expect(G.stanceMode(w, p)).toBe(G.StanceMode.Aim); expect(guardCues(w, cam)).toEqual([]);
  });
  it("projects the true facing arc and ground elevation at phone DPR/zoom, culling offscreen guards", () => {
    const { w, p } = setup(); G.applyStanceInput(w, p, input(true));
    const a = guardCues(w, cam)[0]!; w.setField(p, Transform, "facing", Math.PI); const b = guardCues(w, cam)[0]!;
    expect(a.arc[8]!.x).toBeGreaterThan(400); expect(b.arc[8]!.x).toBeLessThan(400);
    const phone = { ...cam, viewW: 750, viewH: 1334, dpr: 2, drawZoom: 1.5 };
    expect(guardCues(w, phone)[0]!.x).toBe(187.5);
    expect(guardCues(w, phone, 1, () => 2)[0]!.y).toBeLessThan(guardCues(w, phone)[0]!.y);
    expect(guardCues(w, { ...cam, x: 10000 })).toEqual([]);
  });
});
