import { describe, expect, it } from "vitest";
import { Transform, setTimeOfDay, timeOfDay } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

describe("ADR-107 zombies kill players, respawn, punching", () => {
  it("a zombie next to an idle player kills them (hp reaches 0, Dead + Died)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = G.spawnPlayer(w, { x: 10, y: 10 }); G.spawnZombie(w, "zombie_walker", 10.5, 10);
    const died = collect(w, G.Died);
    for (let i = 0; i < 20 * 600 && !w.has(p, G.Dead); i++) steps(w, 1);
    expect(w.has(p, G.Dead)).toBe(true); expect(w.getField(p, G.Health, "hp")).toBe(0); expect(died.some((d) => d.entity === p)).toBe(true);
  });
  it("after respawn the player is alive, idle, unstuck and can move", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = G.spawnPlayer(w, { x: 10, y: 10 }); G.spawnZombie(w, "zombie_walker", 10.5, 10);
    for (let i = 0; i < 20 * 600 && !w.has(p, G.Dead); i++) steps(w, 1);
    steps(w, 20 * G.PVP.respawnSeconds + 1);
    expect(G.respawnPlayer(w, p)).toBeUndefined();
    expect(w.has(p, G.Dead)).toBe(false); expect(w.getField(p, G.Health, "hp")).toBeGreaterThan(0);
    expect(w.getField(p, G.PlayerIntent, "action")).toBe(G.IntentAction.None);
    const a = { ...w.get(p, Transform)! };
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight, 1 / 20); w.step(1 / 20); }
    const b = w.get(p, Transform)!; expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.5);
  });
  it("unarmed players punch zombies through the combat path (Punch anim, damage, cooldown)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = G.spawnPlayer(w, { x: 10, y: 10 }); const z = G.spawnZombie(w, "zombie_walker", 10.8, 10);
    expect(G.nearestMeleeTarget(w, p)).toBe(z);
    const hp0 = w.getField(z, G.Health, "hp")!;
    G.setIntent(w, p, { action: G.IntentAction.Attack, target: z }); steps(w, 1);
    expect(w.getField(z, G.Health, "hp")!).toBeCloseTo(hp0 - G.FISTS.damage, 3);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Punch);
    steps(w, 1); expect(w.getField(z, G.Health, "hp")!).toBeCloseTo(hp0 - G.FISTS.damage, 3); // cooldown
    steps(w, G.PLAYER_ONE_SHOT_TICKS); expect(w.getField(p, G.AnimState, "anim")).not.toBe(G.Anim.Punch); // one-shot settles (Idle, or Hurt if the zombie hit back)
    const far = G.spawnPlayer(w, { x: 40, y: 40 }); expect(G.nearestMeleeTarget(w, far)).toBeUndefined();
  });
});

describe("ADR-107 bare-hand gathering of tier-1 nodes", () => {
  const d = G.defaultDefs(); const WOOD = d.itemId("wood"); const STONE = d.itemId("stone");
  const hit = (w: import("@engine/core").World, p: number, n: number): void => { G.setIntent(w, p, { action: G.IntentAction.Gather, target: n }); w.step(1 / 20); steps(w, 60); };
  it("tree / boulder by hand: only the first yield, ~25% of the lowest tool, min 1", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const got = collect(w, G.ItemGathered);
    const tree = G.spawnResourceNode(w, "tree", 1, 0); for (let i = 0; i < 4; i++) hit(w, p, tree);
    const rock = G.spawnResourceNode(w, "boulder", 0, 1); for (let i = 0; i < 4; i++) hit(w, p, rock);
    expect(got.length).toBe(8);
    for (const g of got) { expect([WOOD, STONE]).toContain(g.item); expect(g.count).toBe(1); } // floor(2..4 * 0.25) -> min 1
  });
  it("bare-hand cooldown is cooldownMul x the node cooldown; tier-2 nodes still need the tool", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const tree = G.spawnResourceNode(w, "tree", 1, 0);
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: tree }); w.step(1 / 20);
    const until = w.getField(p, G.Gatherer, "cooldownUntilTick")! - (w.tick - 1);
    expect(until).toBe(Math.round(d.resources.get(d.resourceId("tree"))!.cooldownSeconds * d.bareHands.cooldownMul * 20));
    const failed = collect(w, G.GatherFailed);
    steps(w, 60); hit(w, p, G.spawnResourceNode(w, "iron_vein", 0, 1));
    expect(failed.at(-1)!.reason).toBe(G.GatherFail.WrongTool);
    expect(G.bareHandsCan(d, d.resources.get(d.resourceId("oak_tree"))!)).toBe(false);
    expect(d.bareHands.yieldMul).toBeGreaterThanOrEqual(0.2); expect(d.bareHands.yieldMul).toBeLessThanOrEqual(0.25);
  });
});

describe("ADR-107 swimming", () => {
  it("players enter water slowly and play Swim; zombies/animals get Swim in water", () => {
    const w = makeWorld();
    w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 5 ? 1 : 3), heightAt: () => 0 });
    expect(G.swimSpeedMulAt(w, 9, 0)).toBe(G.defaultDefs().movement.swimSpeedMul);
    const p = G.spawnPlayer(w, { x: 4.5, y: 0.5 });
    const right = G.GameplayActions.MoveDown | G.GameplayActions.MoveRight; // +x
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, right, 1 / 20); w.step(1 / 20); }
    const x = w.get(p, Transform)!.x; expect(x).toBeGreaterThan(5.5); expect(G.inWater(w, x, 0.5)).toBe(true);
    const x0 = x; G.applyMovementInput(w, p, right, 1); const land = 8; // dx per second on land
    expect(w.get(p, Transform)!.x - x0).toBeLessThan(land * 0.5);
    const z = G.spawnZombie(w, "zombie_walker", 8.5, 3.5); setTimeOfDay(w, 0, 0); steps(w, 2);
    expect(w.getField(z, G.AnimState, "anim")).toBe(G.Anim.Swim);
    w.set(p, Transform, { x: 10.5, y: 0.5 }); // ADR-181: Swim plays in deep water (shore band wades)
    w.add(p, G.AnimState, { anim: G.Anim.Walk, startTick: w.tick }); steps(w, 1); expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Swim);
    w.set(p, Transform, { x: 1.5, y: 0.5 }); steps(w, 1); expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Idle);
  });
});
describe("ADR-107 world start time", () => {
  it("new worlds start in early daylight just after dawn", () => {
    const w = makeWorld(); const tod = timeOfDay(w); const sr = tod.sun?.sunrise ?? 6; expect(tod.hours).toBeGreaterThan(sr); expect(tod.hours).toBeLessThan(sr + 2.5); // ADR-285: just after *that day's* dawn
  });
});
