/** ADR-244: block / crouch / carry / sleep / aim mechanics (server-authoritative Stance, replicated). */
import { describe, expect, it } from "vitest";
import { applySnapshot, decodeSnapshot, encodeSnapshot, NetId, setTimeOfDay, timeOfDay, Transform, wallHoursForSun, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const { StanceMode: M, Stance, STANCE } = G;
let nid = 1000;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const mk = (w: World, x = 0, y = 0, id = 1): Entity => { return net(w, G.spawnPlayer(w, { x, y, clientId: id })); };
const IN: G.StanceInput = { guard: false, crouch: false, carry: false, rest: false, interact: false, active: false };
const inp = (w: World, e: Entity, o: Partial<G.StanceInput> = {}): void => G.applyStanceInput(w, e, { ...IN, ...o });
const mode = (w: World, e: Entity): number => G.stanceMode(w, e);
const bag = (w: World, x: number, y: number): Entity => { const b = net(w, w.create()); w.add(b, Transform, { x, y }).add(b, G.Container, { slotCount: 4 }).add(b, G.ContainerViewers).add(b, G.LootBag, { owner: 0, despawnAtTick: 0xffffffff }); return b; };
const piece = (w: World, key: string, x: number, y: number, rot = 0): Entity => {
  const type = [...G.gameplayDefs(w).pieces.values()].find((p) => p.key === key)!.id;
  const b = net(w, w.create()); w.add(b, Transform, { x, y, z: 0, facing: (rot * Math.PI) / 2 }).add(b, G.BuildPiece, { type }); return b;
};
const itemId = (w: World, key: string): number => [...G.gameplayDefs(w).items.values()].find((i) => i.key === key)!.id;

describe("ADR-244 block (Secondary hold)", () => {
  it("is a hold: on while held, off on release; slows movement", () => {
    const w = makeWorld(); const p = mk(w);
    inp(w, p, { guard: true }); expect(mode(w, p)).toBe(M.Block);
    expect(G.stanceMoveMul(w, p)).toBe(STANCE.blockMoveMul); expect(G.stanceAllowsSprint(w, p)).toBe(false);
    inp(w, p, { guard: false }); expect(mode(w, p)).toBe(M.None); expect(G.stanceMoveMul(w, p)).toBe(1);
  });
  it("reduces frontal melee damage, spends stamina; hits from behind / ranged are not blocked", () => {
    const w = makeWorld(); const p = mk(w, 0, 0, 1); const z = mk(w, 1, 0, 2); w.setField(p, Transform, "facing", 0);
    w.setField(p, G.Health, "hp", 100); w.setField(p, G.Health, "max", 100);
    const st0 = w.getField(p, G.Survival, "stamina")!;
    inp(w, p, { guard: true }); G.applyDamage(w, p, 10, z);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(100 - 10 * (1 - STANCE.blockMeleeReduction), 1);
    expect(w.getField(p, G.Survival, "stamina")).toBeLessThan(st0);
    w.setField(p, Transform, "facing", Math.PI); const hp = w.getField(p, G.Health, "hp")!; G.applyDamage(w, p, 10, z); // from behind
    expect(hp - w.getField(p, G.Health, "hp")!).toBeGreaterThan(9);
    w.setField(p, Transform, "facing", 0); w.setField(z, Transform, "x", 8); const hp2 = w.getField(p, G.Health, "hp")!; G.applyDamage(w, p, 10, z); // out of melee range
    expect(hp2 - w.getField(p, G.Health, "hp")!).toBeGreaterThan(9);
  });
  it("breaks at 0 stamina and stays broken until the button is released", () => {
    const w = makeWorld(); const p = mk(w);
    inp(w, p, { guard: true }); w.setField(p, G.Survival, "stamina", 0); G.stanceSystem(w, 0.05);
    expect(mode(w, p)).toBe(M.None); w.setField(p, G.Survival, "stamina", 50);
    inp(w, p, { guard: true }); expect(mode(w, p)).toBe(M.None);
    inp(w, p); inp(w, p, { guard: true }); expect(mode(w, p)).toBe(M.Block);
  });
});

describe("ADR-244 firearm / ranged aim (Secondary hold)", () => {
  it("aims instead of blocking with a ranged weapon, releases on button up", () => {
    const w = makeWorld(); const p = mk(w); w.setField(p, G.Equipment, "mainHandItem", itemId(w, "short_bow"));
    inp(w, p, { guard: true }); expect(mode(w, p)).toBe(M.Aim); expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Aim);
    expect(G.stanceMoveMul(w, p)).toBe(STANCE.aimMoveMul);
    inp(w, p); expect(mode(w, p)).toBe(M.None);
  });
});

describe("ADR-244 crouch (toggle)", () => {
  it("toggles on the rising edge only (holding does not flicker), slower, quieter, harder to see", () => {
    const w = makeWorld(); const p = mk(w);
    inp(w, p, { crouch: true }); expect(mode(w, p)).toBe(M.Crouch);
    inp(w, p, { crouch: true }); inp(w, p, { crouch: true }); expect(mode(w, p)).toBe(M.Crouch); // held: still on
    inp(w, p); expect(mode(w, p)).toBe(M.Crouch); // released: still on (toggle)
    expect(G.isCrouched(w, p)).toBe(true); expect(G.stanceMoveMul(w, p)).toBe(STANCE.crouchMoveMul); expect(G.stanceAllowsSprint(w, p)).toBe(false);
    G.makeNoise(w, p, 10); expect(w.getField(p, G.NoiseLevel, "value")).toBeCloseTo(10 * STANCE.crouchNoiseMul, 3);
    expect(STANCE.crouchSightMul).toBeLessThan(1);
    inp(w, p, { crouch: true }); expect(mode(w, p)).toBe(M.None); expect(G.isCrouched(w, p)).toBe(false);
  });
  it("block held while crouched returns to crouch on release", () => {
    const w = makeWorld(); const p = mk(w);
    inp(w, p, { crouch: true }); inp(w, p, { crouch: false, guard: true }); expect(mode(w, p)).toBe(M.Block);
    inp(w, p); expect(mode(w, p)).toBe(M.Crouch);
  });
});

describe("ADR-244 carry (LootBag)", () => {
  it("picks up the nearest bag, follows the carrier, blocks attacks / sprint, drops on Carry or Interact", () => {
    const w = makeWorld(); const p = mk(w, 5, 5); const b = bag(w, 5.5, 5); steps(w, 1); // spatial index
    expect(G.liftableNear(w, p)).toBe(b);
    inp(w, p, { carry: true }); expect(mode(w, p)).toBe(M.Carry); expect(w.getField(p, Stance, "carriedNetId")).toBe(w.getField(b, NetId, "id"));
    expect(G.stanceBlocksActions(w, p)).toBe(true); expect(G.stanceAllowsSprint(w, p)).toBe(false); expect(G.stanceMoveMul(w, p)).toBe(STANCE.carryMoveMul);
    w.set(p, Transform, { x: 9, y: 7 }); G.stanceSystem(w, 0.05); expect(w.get(b, Transform)).toMatchObject({ x: 9, y: 7 });
    inp(w, p, { carry: true }); expect(mode(w, p)).toBe(M.None); expect(G.stanceBlocksActions(w, p)).toBe(false);
    expect(Math.hypot(w.getField(b, Transform, "x")! - 9, w.getField(b, Transform, "y")! - 7)).toBeCloseTo(0.6, 3);
    inp(w, p, { carry: true }); expect(mode(w, p)).toBe(M.Carry);
    inp(w, p, { interact: true }); expect(mode(w, p)).toBe(M.None); // Interact (E / X / tap) also drops
  });
  it("a carried bag is not a loot / open target (no [E] Open prompt over the carrier)", () => {
    const w = makeWorld(); const p = mk(w, 5, 5); const b = bag(w, 5.5, 5); steps(w, 1); const ctx = { world: w, player: p } as never;
    expect(G.nearestLootBag(ctx)?.entity).toBe(b);
    inp(w, p, { carry: true }); expect(G.nearestLootBag(ctx)).toBeUndefined();
    inp(w, p, { carry: true }); expect(G.nearestLootBag(ctx)?.entity).toBe(b);
  });
  it("a bag carried by one player cannot be taken by another; nothing in reach = no-op", () => {
    const w = makeWorld(); const a = mk(w, 0, 0, 1); const c = mk(w, 0.5, 0, 2); bag(w, 0.2, 0); steps(w, 1);
    inp(w, a, { carry: true }); inp(w, c, { carry: true }); expect(mode(w, a)).toBe(M.Carry); expect(mode(w, c)).toBe(M.None);
    const w2 = makeWorld(); const q = mk(w2); inp(w2, q, { carry: true }); expect(mode(w2, q)).toBe(M.None);
  });
});

describe("ADR-244 sleep (bed)", () => {
  it("sleeps in a bed in reach (bed / double / bunk spots), heals HP and regens stamina faster", () => {
    const w = makeWorld(); const p = mk(w, 3, 3); const bed = piece(w, "bed", 4, 3, 1);
    w.setField(p, G.Health, "max", 100); w.setField(p, G.Health, "hp", 50);
    inp(w, p, { rest: true }); expect(mode(w, p)).toBe(M.Sleep);
    expect(w.getField(p, Stance, "bedNetId")).toBe(w.getField(bed, NetId, "id")); expect(w.getField(p, Stance, "lie")).toBe(1);
    // ADR-246 add-on: sleeper sits at the bed footprint centre (BuildPiece.rot 0 here -> 1x2 => +0.5,+1), facing from the bed.
    expect(w.get(p, Transform)).toMatchObject({ x: 4.5, y: 4 }); expect(G.bedCentre(w, bed, { x: 4, y: 3 })).toEqual({ x: 4.5, y: 4 }); expect(w.getField(p, Transform, "facing")).toBeCloseTo(Math.PI / 2);
    expect(G.stanceMoveMul(w, p)).toBe(0); expect(G.stanceBlocksActions(w, p)).toBe(true);
    steps(w, 40); expect(w.getField(p, G.Health, "hp")!).toBeGreaterThan(50);
    expect(G.bedSpots("bed_double_rustic")).toEqual(["left", "right"]); expect(G.spotLie("lower")).toBe(2); expect(G.spotLie("upper")).toBe(1);
  });
  it("two players share a double bed; a full bed is skipped; a bunk lower spot lies under", () => {
    const w = makeWorld(); const a = mk(w, 0, 0, 1), b = mk(w, 0, 0, 2), c = mk(w, 0, 0, 3); piece(w, "bed_double_rustic", 1, 0);
    inp(w, a, { rest: true }); inp(w, b, { rest: true }); inp(w, c, { rest: true });
    expect([mode(w, a), mode(w, b), mode(w, c)]).toEqual([M.Sleep, M.Sleep, M.None]);
    expect([w.getField(a, Stance, "spot"), w.getField(b, Stance, "spot")]).toEqual([0, 1]);
    const w2 = makeWorld(); const q = mk(w2); piece(w2, "bunk_bed", 1, 0); inp(w2, q, { rest: true }); expect(w2.getField(q, Stance, "lie")).toBe(2);
  });
  it("wakes on any input after the grace ticks, and on damage", () => {
    const w = makeWorld(); const p = mk(w, 0, 0, 1); const z = mk(w, 1, 0, 2); piece(w, "bed", 1, 0);
    inp(w, p, { rest: true }); inp(w, p, { active: true }); expect(mode(w, p)).toBe(M.Sleep); // grace: the same press does not wake
    steps(w, STANCE.sleepWakeGraceTicks); inp(w, p, { active: true }); expect(mode(w, p)).toBe(M.None);
    inp(w, p, { rest: true }); expect(mode(w, p)).toBe(M.Sleep); G.applyDamage(w, p, 1, z); expect(mode(w, p)).toBe(M.None);
  });
  it("time skips only while ALL players sleep at night (multiplayer-safe)", () => {
    const w = makeWorld(); const a = mk(w, 0, 0, 1), b = mk(w, 0, 0, 2); piece(w, "bed_double_rustic", 1, 0);
    setTimeOfDay(w, 22); inp(w, a, { rest: true });
    const h0 = timeOfDay(w).hours; expect(G.timeSkip(w)).toBe(false); expect(timeOfDay(w).hours).toBeCloseTo(h0, 5);
    inp(w, b, { rest: true }); expect(G.allAsleep(w)).toBe(true); expect(G.timeSkip(w)).toBe(true); expect(timeOfDay(w).hours).toBeGreaterThan(h0);
    for (let i = 0; i < 100000 && G.timeSkip(w); i++);
    const tod = timeOfDay(w); expect(tod.hours).toBeCloseTo(wallHoursForSun(STANCE.timeSkipWakeHour, tod.daylightHours ?? 12), 1); // ADR-283: wakes at that day's sunrise
    setTimeOfDay(w, 12); expect(G.timeSkip(w)).toBe(false); // no daytime skip
  });
});

describe("ADR-244 Stance replication", () => {
  it("Stance is networked and round-trips through a snapshot", () => {
    expect(Stance.networked).toBe(true);
    const w = makeWorld(); const p = mk(w); inp(w, p, { crouch: true });
    const w2 = makeWorld(); G.spawnPlayer(w2, { x: 0, y: 0 }); applySnapshot(w2, decodeSnapshot(w2, encodeSnapshot(w))); // networked stores only
    expect(w2.get(p, Stance)).toEqual(w.get(p, Stance)); expect(w2.getField(p, Stance, "mode")).toBe(M.Crouch); expect(w2.getField(p, G.AnimState, "anim")).toBe(G.Anim.Crouch);
  });
  it("only the authority mutates stance (client input is ignored until the server echoes it)", () => {
    const w = makeWorld({ role: "client" }); const p = mk(w); expect(G.isAuthority(w)).toBe(false);
    inp(w, p, { crouch: true }); expect(mode(w, p)).toBe(M.None);
  });
});
