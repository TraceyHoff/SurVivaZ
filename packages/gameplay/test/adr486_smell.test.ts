/**
 * ADR-486: smell is a sense — blood / rot / smoke draw zombies. A zombie that acquires no player
 * investigates the strongest nearby smell (a carcass, a rot carrier, a kill's loot bag, a lit fire)
 * the way noise sends it to Investigate. Smell is one sampleField-style query per zombie think tick
 * (every ai.thinkTicks, staggered) — no new scan; emitters attach at events (death, spoilage, ignition),
 * never by a scan. Walls halve a smell instead of blocking it (scent seeps).
 *
 * Tuning (ai.smell): threshold 0.25; carcass radius 8 strength 1 (strongest, shortest); rot radius 6
 * strength 1; kill (loot bag) radius 6 strength 0.8; fire radius 12 strength 1 (widest).
 */
import { describe, expect, it } from "vitest";
import { setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import { EmitterIndexRes } from "@engine/world";
import * as G from "../src/index.js";
import { spawnPlayer, spawnZombie, ZombieBrain, ZState } from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const SEC = 20;

/** Sampled Smell field at (x, y) (0 when the EmitterIndex is absent). */
const smellAt = (w: World, x: number, y: number): number =>
  w.getResource(EmitterIndexRes)?.sampleField(G.EmitterKind.Smell, x, y) ?? 0;
/** The Smell emitter on an entity, if it carries one. */
const smellOf = (w: World, e: Entity): { radius: number; strength: number } | undefined => {
  const em = w.get(e, G.Emitter);
  return em && em.kind === G.EmitterKind.Smell ? { radius: em.radius, strength: em.strength } : undefined;
};
/** Assert an entity's smell (strength is f32, so it reads back with float error — compare loosely). */
const expectSmell = (w: World, e: Entity, radius: number, strength: number): void => {
  const s = smellOf(w, e); expect(s).toBeDefined();
  expect(s!.radius).toBe(radius); expect(s!.strength).toBeCloseTo(strength, 5);
};
/** A bare smell source at (x, y) — a stand-in for a carcass / fire / rot carrier in the unit tests. */
const smellSource = (w: World, x: number, y: number, radius: number, strength: number): Entity => {
  const e = w.create();
  w.add(e, Transform, { x, y }).add(e, G.Emitter, { kind: G.EmitterKind.Smell, radius, strength, falloff: 1 });
  return e;
};
/** Night, an aggressive zombie at (10,10), and an anchor player 30 tiles south — close enough to
 * stop the zombie despawning (despawnDistance 60), far enough to be neither seen (sight 10) nor heard. */
const rig = (w: World): { z: Entity; p: Entity } => {
  setTimeOfDay(w, 0, 0);
  const p = spawnPlayer(w, { x: 10, y: 40 });
  const z = spawnZombie(w, "zombie_walker", 10, 10);
  return { z, p };
};
const investigating = (w: World, z: Entity): boolean => w.getField(z, ZombieBrain, "state") === ZState.Investigate;

/** A 1-tile hut at (10,10): foundation + the listed walls + roof (copied from adr456). */
type Side = "N" | "S" | "W" | "E";
const EDGE: Record<Side, [number, number]> = { N: [10.5, 10], S: [10.5, 11], W: [10, 10.5], E: [11, 10.5] };
function place(w: World, key: string, x: number, y: number): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
}
function hut(walls: Partial<Record<Side, "wall" | "doorway">>): World {
  const w = makeWorld(); place(w, "foundation", 10.5, 10.5);
  for (const s of ["N", "S", "W", "E"] as Side[]) {
    if (walls[s] === "wall") place(w, "wall", ...EDGE[s]);
    else if (walls[s] === "doorway") place(w, "wall_doorway", ...EDGE[s]); // open doorway: no door hung
  }
  const sn = G.snapPlacement(w, { piece: d.pieceId("roof_flat"), x: 10.5, y: 10.5, level: 1, rot: 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap roof_flat ${sn}`);
  G.placePiece(w, 0 as Entity, sn, { pay: false });
  return w;
}
const fireOf = (w: World, piece: Entity): Entity => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
const smellSiblingOf = (w: World, piece: Entity): Entity | undefined =>
  G.attachmentsOf(w, piece).find((a) => w.getField(a, G.PieceLink, "kind") === G.AttachKind.Smell);
function light(w: World, piece: Entity): Entity {
  const f = fireOf(w, piece); G.addItem(w, f, d.itemId("coal"), 50);
  w.set(f, G.Fuel, { lit: 1, burnUntilTick: 0 }); G.setEmittersLit(w, f, 1); return f;
}

describe("ADR-486 smell is a sense", () => {
  it("tuning: Smell is kind 3; threshold 0.25; carcass strongest/shortest, fire widest", () => {
    expect(G.EmitterKind.Smell).toBe(3);
    const s = G.defaultDefs().ai.smell;
    expect(s.threshold).toBe(0.25);
    expect(s.carcass).toEqual({ radius: 8, strength: 1 });
    expect(s.rot).toEqual({ radius: 6, strength: 1 });
    expect(s.kill).toEqual({ radius: 6, strength: 0.8 });
    expect(s.fire).toEqual({ radius: 12, strength: 1 });
  });

  it("strongestSmell: the stronger smell wins over the nearer one; below threshold is nothing", () => {
    const w = makeWorld();
    // Near but faint: rot 5 tiles away contributes 1 x (1 - 5/6) = 0.167, below threshold.
    smellSource(w, 15, 10, 6, 1);
    // Far but strong: fire 8 tiles away contributes 1 x (1 - 8/12) = 0.333, above threshold.
    smellSource(w, 18, 10, 12, 1);
    steps(w, 2);
    const s = G.strongestSmell(w, 10, 10);
    expect(s).toBeDefined();
    expect(s!.x).toBe(18); expect(s!.y).toBe(10); expect(s!.strength).toBeCloseTo(1 / 3, 6);
    // On its own the faint rot is nothing to a zombie.
    const w2 = makeWorld(); smellSource(w2, 15, 10, 6, 1); steps(w2, 2);
    expect(G.strongestSmell(w2, 10, 10)).toBeUndefined();
  });

  it("a zombie investigates a carcass smell it cannot see a player from", () => {
    const w = makeWorld(); const { z } = rig(w);
    smellSource(w, 14, 10, 8, 1); // 4 tiles: 1 x (1 - 4/8) = 0.5, above threshold
    steps(w, SEC);
    expect(investigating(w, z)).toBe(true);
    expect(w.getField(z, ZombieBrain, "goalX")).toBe(14);
    expect(w.getField(z, ZombieBrain, "goalY")).toBe(10);
  });

  it("a zombie ignores a smell below threshold and keeps wandering", () => {
    const w = makeWorld(); const { z } = rig(w);
    smellSource(w, 17, 10, 8, 1); // 7 tiles: 1 x (1 - 7/8) = 0.125, below threshold
    steps(w, SEC);
    expect(investigating(w, z)).toBe(false);
    expect(w.getField(z, ZombieBrain, "state")).toBe(ZState.Wander);
  });

  it("a zombie follows a player it sees instead of a smell", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = spawnPlayer(w, { x: 13, y: 10 }); // 3 tiles: in sight (sight 10)
    const z = spawnZombie(w, "zombie_walker", 10, 10);
    smellSource(w, 14, 10, 8, 1);
    steps(w, SEC);
    const s = w.getField(z, ZombieBrain, "state");
    expect(s === ZState.Chase || s === ZState.AttackPlayer).toBe(true);
    expect(w.getField(z, ZombieBrain, "target")).toBe(p);
  });

  it("a calm daytime zombie ignores smell", () => {
    const w = makeWorld();
    setTimeOfDay(w, 12, 0); // noon: calm, not aggressive
    spawnPlayer(w, { x: 10, y: 40 }); // anchor against despawn
    const z = spawnZombie(w, "zombie_walker", 10, 10);
    smellSource(w, 14, 10, 8, 1);
    steps(w, SEC);
    expect(investigating(w, z)).toBe(false);
    expect(w.getField(z, ZombieBrain, "state")).toBe(ZState.Wander);
  });

  it("carried rot smells; losing the rot stops the smell (stored rot does not smell)", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 10, y: 10 });
    const rot = d.itemId("rot");
    G.addItem(w, p, rot, 3);
    steps(w, SEC * 3); // spoilage passes (every 20 ticks) attach the rot smell
    expectSmell(w, p, 6, 1);
    expect(G.removeItem(w, p, rot, 3)).toBe(true);
    steps(w, SEC * 3);
    expect(smellOf(w, p)).toBeUndefined();
    // A storage box full of rot is out of v1: it never smells.
    const box = w.create();
    w.add(box, Transform, { x: 20, y: 10 }).add(box, G.Container, { slotCount: 4 });
    G.addItem(w, box, rot, 3);
    steps(w, SEC * 3);
    expect(smellOf(w, box)).toBeUndefined();
  });

  it("a kill's loot bag smells while it holds meat; an emptied bag stops", () => {
    const w = makeWorld();
    const wolf = G.spawnAnimal(w, "animal_wolf", 10, 10);
    const bag = G.dropAnimalLoot(w, wolf)!; // wolf loot always has raw_meat (chance 1)
    expectSmell(w, bag, 6, 0.8);
    for (const s of G.listSlots(w, bag)) G.removeItem(w, bag, s.item, s.count);
    steps(w, SEC * 3); // the spoilage pass clears the smell once the meat is gone
    expect(smellOf(w, bag)).toBeUndefined();
  });

  it("a carcass node smells", () => {
    const w = makeWorld();
    const node = G.spawnResourceNode(w, "animal_carcass", 10, 10);
    expectSmell(w, node, 8, 1);
    // An ordinary node does not.
    expect(smellOf(w, G.spawnResourceNode(w, "tree", 12, 10))).toBeUndefined();
  });

  it("burning vegetation smokes; extinguishing clears it; a burning player does not smell", () => {
    const w = makeWorld();
    const tree = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.ignite(w, tree)).toBe(true);
    expectSmell(w, tree, 12, 1);
    G.extinguish(w, tree);
    expect(smellOf(w, tree)).toBeUndefined();
    const p = spawnPlayer(w, { x: 5, y: 5 });
    expect(G.ignite(w, p)).toBe(true); // a player can catch fire — but gets no smell emitter
    expect(smellOf(w, p)).toBeUndefined();
  });

  it("a lit campfire smokes (sibling, strength 1); an unlit one does not", () => {
    const w = makeWorld();
    const camp = place(w, "campfire", 10.5, 10.5);
    const sib = smellSiblingOf(w, camp);
    expect(sib).toBeDefined(); // placed with the piece, unlit
    expectSmell(w, sib!, 12, 0);
    steps(w, 2);
    expect(smellAt(w, 10.5, 10.5)).toBe(0);
    const f = light(w, camp);
    steps(w, SEC);
    expectSmell(w, sib!, 12, 1);
    expect(smellAt(w, 10.5, 10.5)).toBeCloseTo(1, 6);
    G.setEmittersLit(w, f, 0);
    steps(w, SEC);
    expectSmell(w, sib!, 12, 0);
    expect(smellAt(w, 10.5, 10.5)).toBe(0);
  });

  it("smell seeps through a wall at half strength — sealed, not blocked", () => {
    const sealed = hut({ N: "wall", S: "wall", W: "wall", E: "wall" });
    const campS = place(sealed, "campfire", 10.5, 10.5); light(sealed, campS); steps(sealed, SEC);
    const open = hut({ N: "wall", S: "wall", W: "wall", E: "doorway" });
    const campO = place(open, "campfire", 10.5, 10.5); light(open, campO); steps(open, SEC);
    // 3 tiles east of the fire: 1 x (1 - 3/12) = 0.75 with no wall in the way.
    const outside = smellAt(open, 13.5, 10.5);
    expect(outside).toBeCloseTo(0.75, 2);
    const throughWall = smellAt(sealed, 13.5, 10.5);
    expect(throughWall).toBeGreaterThan(0); // seeps — a sealed room still smells faintly
    expect(throughWall / outside).toBeCloseTo(0.5, 1); // one wall halves it
  });
});
