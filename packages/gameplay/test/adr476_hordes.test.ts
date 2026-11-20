/**
 * ADR-476: hordes hunt by sound and by lamplight (Tracey's decision: lamplight IN, siege-only).
 * A loud survivor noise re-targets the nearest horde that can hear it to the nearest base near
 * the noise; that horde then sieges for 30 in-game minutes (refreshed by further loud noise at
 * the same base). While sieging, the horde seeks the base's lights (nearest light within 20 tiles
 * of its target, if that light is on a piece) and its members are exempt from shyGoal light
 * avoidance. The siege draws no individual zombies — it re-targets an existing horde only.
 *
 * Scope corrections (the scope's "subscribe the director to noise events" does not exist as
 * written): there is NO noise event and NO noise kind in this tree — NoiseLevel is a decaying
 * per-entity level (systems/noise.ts), and makeNoise is the one place all noise flows through.
 * So the director cannot subscribe; instead makeNoise records the peak survivor noise in the
 * noise module (lastLoudNoise) and the director reads it on its own cadence. The "player-caused
 * only" gate is exactly "the actor is a living survivor": thunder never calls makeNoise, animals
 * never call it (footsteps are Survival-gated), zombie structure hits are not survivors. Vehicle
 * engine noise does not exist (no makeNoise call for driving), so a driving player draws a horde
 * only by what they do at the destination. The noise amounts make walk (12) louder than a gunshot
 * (9), so any amount gate that includes gunshots includes footsteps — the hearing-radius gate
 * (a horde hears what a walker would hear: 1 tile per noise level) is what keeps a far-away
 * walker from hijacking a horde. A loud noise in the open draws no horde (nothing to siege).
 */
import { describe, it, expect } from "vitest";
import { installPermissions, Membership, PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
function setup(opts: Parameters<typeof makeWorld>[0] = {}): { w: World; p: Entity } {
  const w = makeWorld(opts); installPermissions(w);
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 7 }).add(p, Membership, { partyId: 0, clanId: 0 });
  return { w, p };
}
/** An ownerless base (builder 0 -> the 32-tile-cell bucket): two bases in different cells are two targets. */
const baseAt = (w: World, x: number, y: number, key = "foundation"): Entity => {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key)!, x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn !== "object") throw new Error(`snap ${key} at ${x},${y}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
};
const lightFire = (w: World, piece: Entity): void => {
  const f = G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
  G.addItem(w, f, d.itemId("coal"), 50); w.set(f, G.Fuel, { lit: 1, burnUntilTick: 0 });
  G.setEmittersLit(w, f, 1); G.invalidateLightGrid(w);
};
/** A horde forced onto `t`, with its members teleported to (x, y) (the spawn ring is 36-48 tiles out,
 * so the teleport is what puts the horde within hearing of the test noise). */
const hordeNear = (w: World, t: G.HordeTarget, x: number, y: number, size = 6): number => {
  const id = G.forceHorde(w, t, size);
  const h = G.hordeRuntime(w).hordes.get(id)!;
  let i = 0;
  for (const z of h.members) { w.set(z, Transform, { x: x + (i % 3), y: y + Math.floor(i / 3) }); i++; }
  return id;
};
const targetsOf = (w: World): G.HordeTarget[] => G.hordeTargets(w);
const holding = (w: World, item: string): Entity => {
  const p = G.spawnPlayer(w, { x: 20.5, y: 20.5 }); w.set(p, G.Health, { hp: 1e6, max: 1e6 });
  G.addItem(w, p, d.itemId(item), 1); w.set(p, G.Equipment, { mainHandSlot: 0 });
  steps(w, 1); G.invalidateLightGrid(w); return p;
};

describe("ADR-476 hordes hunt by sound and lamplight", () => {
  it("tuning reads roads.json (noiseMin 8, siege 30 min, light seek 20, target radius 32)", () => {
    expect(G.HORDES.noiseMin).toBe(8);
    expect(G.HORDES.siegeMinutes).toBe(30);
    expect(G.HORDES.lightSeekTiles).toBe(20);
    expect(G.HORDES.noiseTargetRadius).toBe(32);
    expect(G.siegeTicks(makeWorld())).toBeGreaterThan(0);
  });

  it("makeNoise records the last loud survivor noise; zombie noise and quieter noise do not overwrite it", () => {
    const { w, p } = setup();
    expect(G.lastLoudNoise(w)).toBeUndefined();
    G.makeNoise(w, p, 9); // gunshot
    expect(G.lastLoudNoise(w)).toMatchObject({ x: 10.5, y: 10.5, level: 9, tick: w.tick });
    const z = G.spawnZombie(w, "zombie_walker", 30, 30);
    G.makeNoise(w, z, 12); // zombie structure hit: not a survivor, not recorded
    expect(G.lastLoudNoise(w)!.level).toBe(9);
    G.makeNoise(w, p, 5); // a door: quieter, never overwrites a louder event still in its TTL
    expect(G.lastLoudNoise(w)!.level).toBe(9);
    G.makeNoise(w, p, 18); // a sprint: louder, overwrites
    expect(G.lastLoudNoise(w)!.level).toBe(18);
    steps(w, G.LOUD_EVENT_TTL_TICKS + 1);
    expect(G.lastLoudNoise(w)).toBeUndefined(); // the record expires after its TTL
  });

  it("a loud noise at a base re-targets the nearest hearing horde and starts a siege", () => {
    const { w, p } = setup();
    const baseA = baseAt(w, 12, 12); const baseB = baseAt(w, 100, 12);
    const tA = targetsOf(w).find((t) => t.pieces.includes(baseA))!;
    const tB = targetsOf(w).find((t) => t.pieces.includes(baseB))!;
    expect(tA.key).not.toBe(tB.key);
    const id = hordeNear(w, tB, 17, 12);
    expect(G.hordeRuntime(w).hordes.get(id)!.key).toBe(tB.key);
    w.set(p, Transform, { x: 12.5, y: 12.5 });
    G.makeNoise(w, p, 9); // gunshot at base A; the horde is ~5 tiles away, inside the 9-tile hearing radius
    steps(w, 20); // one director run
    const h = G.hordeRuntime(w).hordes.get(id)!;
    expect(h.key).toBe(tA.key);
    expect(h.target).toBe(baseA);
    expect(h.siegeUntil).toBeGreaterThan(w.tick);
    expect(h.siegeUntil - w.tick).toBeLessThanOrEqual(G.siegeTicks(w));
    for (const z of h.members) {
      expect(w.get(z, G.HordeMember)!.target).toBe(baseA);
      expect(w.get(z, G.HordeMember)!.siegeUntil).toBe(h.siegeUntil);
    }
  });

  it("a quiet noise (door) does not re-target, and a loud noise in the open draws no horde", () => {
    const { w, p } = setup();
    const baseA = baseAt(w, 12, 12); const baseB = baseAt(w, 100, 12);
    const tA = targetsOf(w).find((t) => t.pieces.includes(baseA))!;
    const tB = targetsOf(w).find((t) => t.pieces.includes(baseB))!;
    const id = hordeNear(w, tB, 17, 12);
    w.set(p, Transform, { x: 12.5, y: 12.5 });
    G.makeNoise(w, p, 5); // a door: below noiseMin 8
    steps(w, 20);
    expect(G.hordeRuntime(w).hordes.get(id)!.key).toBe(tB.key);
    // Loud, and the horde can hear it — but there is no base within 32 tiles of the noise.
    const h = G.hordeRuntime(w).hordes.get(id)!;
    let i = 0; for (const z of h.members) { w.set(z, Transform, { x: 50 + (i % 3), y: 50 + Math.floor(i / 3) }); i++; }
    w.set(p, Transform, { x: 50.5, y: 50.5 });
    G.makeNoise(w, p, 9);
    steps(w, 20);
    expect(G.hordeRuntime(w).hordes.get(id)!.key).toBe(tB.key);
    expect(tA.key).not.toBe(tB.key);
  });

  it("a siege refreshes on further loud noise at the same base, then expires and can start again", () => {
    const { w, p } = setup();
    const baseA = baseAt(w, 12, 12); const baseB = baseAt(w, 100, 12);
    const tA = targetsOf(w).find((t) => t.pieces.includes(baseA))!;
    const tB = targetsOf(w).find((t) => t.pieces.includes(baseB))!;
    const id = hordeNear(w, tB, 17, 12);
    w.set(p, Transform, { x: 12.5, y: 12.5 });
    G.makeNoise(w, p, 9);
    steps(w, 20);
    const first = G.hordeRuntime(w).hordes.get(id)!.siegeUntil;
    expect(first).toBeGreaterThan(w.tick);
    // More noise at the same base refreshes the siege clock (the horde stays).
    G.makeNoise(w, p, 9);
    steps(w, 20);
    const refreshed = G.hordeRuntime(w).hordes.get(id)!.siegeUntil;
    expect(refreshed).toBeGreaterThan(first);
    // Jump past the siege (and the noise record's TTL) with no further noise: the siege lapses.
    // (w.tick = N is the established adr238 pattern; stepping the whole siege would let the
    // members reach the base and destroy the foundation first.)
    w.tick = w.tick + G.siegeTicks(w) + G.LOUD_EVENT_TTL_TICKS + 1;
    steps(w, 20);
    expect(G.hordeRuntime(w).hordes.get(id)!.siegeUntil).toBeLessThanOrEqual(w.tick);
    // And a fresh loud noise at the same base starts a new siege (the horde is re-targetable).
    G.makeNoise(w, p, 9);
    steps(w, 20);
    expect(G.hordeRuntime(w).hordes.get(id)!.siegeUntil).toBeGreaterThan(w.tick);
    expect(G.hordeRuntime(w).hordes.get(id)!.key).toBe(tA.key);
  });

  it("a sieging horde seeks the base's lights (re-targets to the lit torch stand)", () => {
    const { w, p } = setup();
    const baseA = baseAt(w, 12, 12); const lamp = baseAt(w, 14, 12, "torch_stand"); lightFire(w, lamp);
    const baseB = baseAt(w, 100, 12);
    const tA = targetsOf(w).find((t) => t.pieces.includes(baseA))!;
    const tB = targetsOf(w).find((t) => t.pieces.includes(baseB))!;
    expect(tA.pieces).toContain(lamp); // the lamp is part of base A's group
    const id = hordeNear(w, tB, 17, 12);
    w.set(p, Transform, { x: 12.5, y: 12.5 });
    G.makeNoise(w, p, 9);
    steps(w, 20); // one director run: noise re-target (to the foundation) then light-seek (to the lamp)
    const h = G.hordeRuntime(w).hordes.get(id)!;
    expect(h.key).toBe(tA.key);
    expect(h.target).toBe(lamp);
    expect(h.siegeUntil).toBeGreaterThan(w.tick);
    for (const z of h.members) expect(w.get(z, G.HordeMember)!.target).toBe(lamp);
  });

  it("a sieging horde member walks into the light; a non-sieging member stays out (shyGoal exemption)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); // night: light avoidance is active
    holding(w, "torch"); // a torch-holding player at (20.5, 20.5), light radius 5.5
    const sn = G.snapPlacement(w, { piece: d.pieceId("foundation")!, x: 8, y: 20, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn !== "object") throw new Error("snap");
    const base = G.placePiece(w, 0 as Entity, sn, { pay: false }); const bt = w.get(base, Transform)!;
    const sieging = G.spawnZombie(w, "zombie_walker", 30.5, 20.5);
    w.add(sieging, G.HordeMember, { horde: 1, target: base, tx: bt.x, ty: bt.y, siegeUntil: w.tick + 36000 });
    let minD = Infinity;
    for (let i = 0; i < 20 * 15; i++) { steps(w, 1); if (!w.isAlive(sieging)) break; const t = w.get(sieging, Transform)!; minD = Math.min(minD, Math.hypot(t.x - 20.5, t.y - 20.5)); }
    expect(minD).toBeLessThan(2); // exempt from shyGoal: walks straight into the torch light
    const calm = G.spawnZombie(w, "zombie_walker", 30.5, 20.5);
    w.add(calm, G.HordeMember, { horde: 2, target: base, tx: bt.x, ty: bt.y, siegeUntil: 0 });
    let minD2 = Infinity;
    for (let i = 0; i < 20 * 15; i++) { steps(w, 1); if (!w.isAlive(calm)) break; const t = w.get(calm, Transform)!; minD2 = Math.min(minD2, Math.hypot(t.x - 20.5, t.y - 20.5)); }
    expect(minD2).toBeGreaterThan(5); // not sieging: light avoidance applies exactly as before
  });

  it("a siege re-targets an existing horde only — it never turns an individual zombie into a horde member", () => {
    const { w, p } = setup();
    const baseA = baseAt(w, 12, 12); const baseB = baseAt(w, 100, 12);
    const tA = targetsOf(w).find((t) => t.pieces.includes(baseA))!;
    const tB = targetsOf(w).find((t) => t.pieces.includes(baseB))!;
    const id = hordeNear(w, tB, 17, 12);
    const before = [...w.query([G.HordeMember])].length;
    const lone = G.spawnZombie(w, "zombie_walker", 50, 50); // far from the noise, outside hearing
    w.set(p, Transform, { x: 12.5, y: 12.5 });
    G.makeNoise(w, p, 9);
    steps(w, 20);
    expect(G.hordeRuntime(w).hordes.get(id)!.key).toBe(tA.key);
    expect([...w.query([G.HordeMember])].length).toBe(before); // no individual was drafted
    expect(w.has(lone, G.HordeMember)).toBe(false);
  });
});
