import { describe, expect, it } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const setup = (): { w: World; p: Entity; id: (k: string) => number } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7);
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
};
const vitals = (w: World, p: Entity): { hunger: number; thirst: number; body: number; stamina: number } => {
  const s = w.get(p, G.Survival)!; return { hunger: s.hunger, thirst: s.thirst, body: s.bodyTemp, stamina: s.stamina };
};
const tame = (w: World, p: Entity, a: Entity, item: number): void => {
  G.addItem(w, p, item, 50);
  for (let i = 0; i < 40 && !w.has(a, G.Pet); i++) { G.offerTreat(w, p, a, item); w.step(1 / 20); }
};

describe("loading gate (Task 14)", () => {
  it("pendingReady / markReady: only joined players carrying an unflipped PlayerReady are gated", () => {
    const { w, p } = setup();
    expect(G.pendingReady(w, p)).toBe(false); // no component: test worlds and respawns run ungated
    w.add(p, G.PlayerReady, { ready: 0 });
    expect(G.pendingReady(w, p)).toBe(true);
    G.markReady(w, p);
    expect(G.pendingReady(w, p)).toBe(false);
    expect(G.READY_COMMANDS.map((d) => d.name)).toContain("gameplay.ready");
  });

  it("vitals frozen pre-ready (hunger, thirst, temperature, stamina) and live post-ready", () => {
    const { w, p } = setup();
    w.add(p, G.PlayerReady, { ready: 0 });
    w.set(p, G.Survival, { bodyTemp: 30 }); // cold body recovers toward normal once ungated (felt temp is ambient)
    const before = vitals(w, p);
    steps(w, 200);
    expect(vitals(w, p)).toEqual(before);
    G.markReady(w, p);
    steps(w, 200);
    const after = vitals(w, p);
    expect(after.hunger).toBeLessThan(before.hunger);
    expect(after.thirst).toBeLessThan(before.thirst);
    expect(after.body).toBeGreaterThan(before.body);
  });

  it("without PlayerReady nothing changes: vitals decay as before (control)", () => {
    const { w, p } = setup();
    const before = vitals(w, p);
    steps(w, 200);
    expect(vitals(w, p).hunger).toBeLessThan(before.hunger);
  });

  it("disease symptoms frozen pre-ready and live post-ready", () => {
    const { w, p } = setup();
    w.add(p, G.PlayerReady, { ready: 0 });
    w.set(p, G.Survival, { hunger: 50 }); // below the well-fed regen threshold, so the drain is visible
    expect(G.contractDisease(w, p, "influenza")).toBe(true);
    const hp0 = w.getField(p, G.Health, "hp")!;
    steps(w, 200);
    expect(w.getField(p, G.Health, "hp")).toBe(hp0);
    G.markReady(w, p);
    steps(w, 200);
    expect(w.getField(p, G.Health, "hp")!).toBeLessThan(hp0);
  });

  it("a pending owner's pet does not go hungry until the owner is ready", () => {
    const { w, p, id } = setup();
    w.add(p, G.PlayerReady, { ready: 0 });
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 1, 0); tame(w, p, a, id("dog_biscuit"));
    expect(w.has(a, G.Pet)).toBe(true);
    steps(w, 200);
    expect(w.getField(a, G.Pet, "fullness")).toBe(80);
    G.markReady(w, p);
    steps(w, 200);
    expect(w.getField(a, G.Pet, "fullness")!).toBeLessThan(80);
  });
});
