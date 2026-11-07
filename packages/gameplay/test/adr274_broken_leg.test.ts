import { describe, expect, it } from "vitest";
import { entityIndex, idleOutput, Transform } from "@engine/core";
import type { Entity, World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld } from "./helpers.js";

const east = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
function setup(drop = 5, role: "server" | "client" = "server") {
  const w = makeWorld({ role });
  w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: x => x >= 1 ? -drop : 0 });
  const p = G.spawnPlayer(w, { x: .9, y: .5, maxWeight: 0 });
  return { w, p };
}
const fall = (w: World, p: Entity, dt = .05): void => G.applyMovementInput(w, p, 0, dt, east);
function expiry(w: World, p: Entity): number {
  const st = w.store(G.Diseases), s = st.slot(entityIndex(p));
  const slot = G.diseaseSlot(w, p, G.gameplayDefs(w).diseaseIndex("broken_leg"));
  return slot < 0 ? 0 : st.data.untilTick[s * G.MAX_DISEASES + slot]!;
}
function useSplint(w: World, p: Entity): void {
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); G.consumeSystem(w);
  G.setIntent(w, p, { action: G.IntentAction.None });
}
describe("ADR-274 faster humans, broken legs and splints", () => {
  it("raises walk and sprint equally by a modest 11.54%, retaining normalized diagonals", () => {
    const mv = G.defaultDefs().movement;
    expect(mv.walkSpeed).toBe(2.9); expect(mv.sprintMul).toBe(1.6);
    expect(mv.walkSpeed * mv.sprintMul).toBeCloseTo(4.64);
    expect(mv.walkSpeed / 2.6).toBeCloseTo(4.64 / 4.16);
    for (const actions of [G.GameplayActions.MoveUp, G.GameplayActions.MoveUp | G.GameplayActions.MoveRight]) {
      const { w, p } = setup(0); const t = w.get(p, Transform)!;
      fall(w, p); // start away from the edge, same clear ground
      w.set(p, Transform, { x: t.x, y: t.y });
      G.applyMovementInput(w, p, actions, .1);
      const n = w.get(p, Transform)!; expect(Math.hypot(n.x-t.x, n.y-t.y)).toBeCloseTo(.29);
    }
  });
  it.each([0, 3, 4, 5, 10, 15])("a %i-tile drop preserves the HP formula and injures only survivors of >=5", drop => {
    const { w, p } = setup(drop); fall(w, p);
    expect(w.getField(p, G.Health, "hp")).toBe(Math.max(0, 100 - G.terrainFallDamage(drop)));
    expect(G.hasDisease(w, p, "broken_leg")).toBe(drop >= 5 && drop < 15);
    if (drop >= 5 && drop < 15) expect(expiry(w, p)).toBe(w.tick + 180 * 20);
  });
  it("does not apply to an already dead character or a lethal five-tile fall", () => {
    const { w, p } = setup(); w.setField(p, G.Health, "hp", 9); fall(w, p);
    expect(w.getField(p, G.Health, "hp")).toBe(0); expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
    w.add(p, G.Dead); w.setField(p, G.Health, "hp", 100);
    G.applyTerrainFall(w, p, .9, .5, 1.1, .5); expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
  });
  it("a full-height ladder prevents damage and Broken Leg", () => {
    const { w, p } = setup(25); const d = G.gameplayDefs(w); G.grantSkillUnlocks(w, p);
    const sn = G.snapPlacement(w, { piece: d.pieceId("ladder"), x: 1, y: .5, rot: 1, level: 0, tier: 0, variant: 0 });
    expect(typeof sn).toBe("object"); if (typeof sn === "number") return;
    G.placePiece(w, p, sn, { pay: false }); fall(w, p);
    expect(w.getField(p, G.Health, "hp")).toBe(100); expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
  });
  it("refreshes a single 180s instance without stacking, then expires", () => {
    const { w, p } = setup(); fall(w, p); const first = expiry(w, p);
    w.tick += 60; w.set(p, Transform, { x: .99 }); fall(w, p);
    expect(expiry(w, p)).toBe(first + 60);
    expect(G.activeDiseases(w, p).filter(d => d.key === "broken_leg")).toHaveLength(1);
    expect(G.speedMultiplier(w, p, false)).toBe(.5);
    const until = expiry(w, p); w.tick = until - 1; G.diseaseSystem(w, .05);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(true);
    w.tick = until; G.diseaseSystem(w, .05); expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
  });
  it("uses the simulation tick rate for 180 seconds", () => {
    const { w, p } = setup(); fall(w, p, .1); expect(expiry(w, p)).toBe(w.tick + 1800);
  });
  it.each([false, true])("halves actual ground walk/sprint movement (sprint=%s)", sprint => {
    const { w, p } = setup(0); const actions = G.GameplayActions.MoveUp;
    if (sprint) for (let i = 0; i < 20; i++) G.applyMovementInput(w, p, actions, .05);
    const start = w.get(p, Transform)!;
    G.applyMovementInput(w, p, actions, .1); const healthy = w.get(p, Transform)!;
    w.set(p, Transform, start); G.contractDisease(w, p, "broken_leg"); G.applyMovementInput(w, p, actions, .1);
    const broken = w.get(p, Transform)!;
    expect(Math.hypot(broken.x-start.x, broken.y-start.y)).toBeCloseTo(Math.hypot(healthy.x-start.x, healthy.y-start.y) / 2);
  });
  it("also halves crouched movement", () => {
    const { w, p } = setup(0); w.add(p, G.Stance, { mode: G.StanceMode.Crouch, crouch: 1 });
    const before = G.speedMultiplier(w, p, false); G.contractDisease(w, p, "broken_leg");
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(before * .5);
  });
  it("AI-human input frames share the speed bump, falling and limp", () => {
    const { w, p } = setup(); const out = idleOutput();
    // AI output is screen-space digital input, exactly the same applyMovementInput path as players.
    out.moveX = 1; out.moveY = 1;
    const f = G.agentOutputFrame(out, w.tick, G.registerGameplayCommands());
    G.applyMovementInput(w, p, f.actions, .1);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(true); expect(G.speedMultiplier(w, p, false)).toBe(.5);
  });
  it("authority prediction/replay cannot apply the injury or damage", () => {
    for (const role of ["client", "server"] as const) {
      const { w, p } = setup(5, role); if (role === "server") w.isReplaying = true;
      fall(w, p); expect(w.getField(p, G.Health, "hp")).toBe(100); expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
    }
  });
  it("splints clear Broken Leg, consume exactly one and keep other conditions", () => {
    const { w, p } = setup(); fall(w, p); G.contractDisease(w, p, "common_cold");
    const item = G.gameplayDefs(w).itemId("leg_splint"); G.addItem(w, p, item, 2);
    expect(G.consumeKind(w, item)).toBe("apply"); useSplint(w, p);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(false); expect(G.hasDisease(w, p, "common_cold")).toBe(true);
    expect(G.countItem(w, p, item)).toBe(1); expect(w.getField(p, G.Health, "hp")).toBe(91);
  });
  it("an unneeded splint is refused, retained and does not start the use cooldown", () => {
    const { w, p } = setup(0); const item = G.gameplayDefs(w).itemId("leg_splint"); G.addItem(w, p, item, 1);
    const fails = collect(w, G.ConsumeFailed); useSplint(w, p); w.events.flush();
    expect(G.countItem(w, p, item)).toBe(1); expect(G.consumeReadyTick(w, p)).toBe(0);
    expect(fails[0]?.reason).toBe(G.ConsumeFail.NotNeeded);
  });
  it("the personal recipe needs two sticks and two cloth, no station", () => {
    const d = G.defaultDefs(); const r = [...d.recipes.values()].find(r => r.key === "leg_splint")!;
    expect(r.station).toBe(G.StationKind.None); 
    expect(r.ingredients.map(i => [d.items.get(i.item)!.key, i.count])).toEqual([["sticks",2],["cloth",2]]);
    expect(r.output).toEqual({ item: d.itemId("leg_splint"), count: 1 }); expect(G.diseaseIcon("broken_leg")).toBe("broken_leg");
  });
});
