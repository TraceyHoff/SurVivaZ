/**
 * ADR-539: predator packs replace hordes. The pack director runs INSTEAD of the horde director
 * when hordes are off (zombies off or hordes off — the contradictory zombies-off + hordes-on
 * combination resolves to packs). A pack targets PREY in the open (a survivor outside structures,
 * or near a base), never a structure group: members hunt the prey, never damage walls or doors,
 * wait outside and watch the doors while the prey is indoors, and slip in through an OPEN door.
 * The warning reuses the HordeStatus channel with kind Pack = 3, so the client toast must say
 * "predator pack", never "zombie horde" (pinned in the client test, not here).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const WOLF = "animal_wolf";
const BEAR = "animal_bear";

type Rules = { zombies?: boolean; hordes?: boolean };
function rig(rules: Rules = {}, hour = 12, day = 0): World {
  const w = makeWorld({ worldRules: rules });
  setTimeOfDay(w, hour, day);
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  return w;
}
const playerAt = (w: World, x: number, y: number, id = 1): Entity => {
  if (!w.isRegistered(PlayerId)) installPermissions(w); // registers PlayerId (idempotent resource reset is fine in tests)
  const p = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id });
  w.add(p, PlayerId, { id });
  return p;
};
const stateOf = (w: World, e: Entity): number => w.get(e, G.Animal)!.state;
const posOf = (w: World, e: Entity): { x: number; y: number } => { const t = w.get(e, Transform)!; return { x: t.x, y: t.y }; };
const dist = (w: World, e: Entity, x: number, y: number): number => { const t = posOf(w, e); return Math.hypot(t.x - x, t.y - y); };
const packMembers = (w: World): Entity[] => [...w.query([G.PackMember])];
const preyOf = (w: World, p: Entity): G.PackPrey => G.packPreyTargets(w).find((t) => t.prey === p)!;
/** A forced pack after prey `p`, with its members teleported near (x, y). */
const packNear = (w: World, p: Entity, x: number, y: number, size = 4): Entity[] => {
  const id = G.forcePack(w, preyOf(w, p), size);
  expect(id).toBeGreaterThan(0);
  const members = packMembers(w);
  let i = 0;
  for (const m of members) { w.set(m, Transform, { x: x + (i % 2), y: y + Math.floor(i / 2) }); i++; }
  return members;
};

type Side = "N" | "S" | "W" | "E";
const EDGE: Record<Side, [number, number]> = { N: [10.5, 10], S: [10.5, 11], W: [10, 10.5], E: [11, 10.5] };
function place(w: World, key: string, x: number, y: number, o: { level?: number; tier?: number } = {}): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: 0, tier: o.tier ?? 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
}
function setOpen(w: World, piece: Entity, open: boolean): void {
  const a = G.resolveAttachment(w, piece, G.AttachKind.Door);
  if (a === undefined) throw new Error("no DoorState attachment");
  w.setField(a, G.DoorState, "open", open ? 1 : 0); G.structures(w).version++;
}
/** A 1-tile hut at (10,10): foundation + walls + roof; S wall is a doorway with a door (closed unless open). */
function hut(w: World, doorOpen = false): { pieces: Entity[]; door: Entity } {
  const pieces: Entity[] = [place(w, "foundation", 10.5, 10.5)];
  pieces.push(place(w, "wall", ...EDGE.N), place(w, "wall", ...EDGE.W), place(w, "wall", ...EDGE.E));
  pieces.push(place(w, "wall_doorway", ...EDGE.S));
  const door = place(w, "door_wood", ...EDGE.S);
  pieces.push(door);
  if (doorOpen) setOpen(w, door, true);
  pieces.push(place(w, "roof_flat", 10.5, 10.5, { level: 1 }));
  return { pieces, door };
}
const snapshotPieces = (w: World, pieces: Entity[]): string[] =>
  pieces.map((e) => JSON.stringify({ b: w.get(e, G.BuildPiece), t: w.get(e, Transform), alive: w.isAlive(e) }));

describe("ADR-539 predator packs replace hordes", () => {
  it("tuning reads roads.json packs (solo 3–6, clan 6–12, ring 36–48, wolf 4 / bear 1, budgets)", () => {
    expect(G.PACKS.solo).toEqual({ base: 3, cap: 6 });
    expect(G.PACKS.clan).toEqual({ base: 6, perMember: 2, cap: 12 });
    expect(G.PACKS.spawnRingMin).toBe(36);
    expect(G.PACKS.spawnRingMax).toBe(48);
    expect(G.PACKS.composition).toEqual({ animal_wolf: 4, animal_bear: 1 });
    expect(G.PACKS.maxActivePacks).toBe(3);
    expect(G.PACKS.maxPackAnimals).toBe(36);
    expect(G.PACKS.noiseMin).toBe(8);
    expect(G.PACKS.siegeMinutes).toBe(30);
    expect(G.PACKS.warnSeconds).toBe(30);
    expect(G.PACKS.phases).toEqual(["dusk", "night"]);
    expect(G.HordeKind.Pack).toBe(3);
  });

  it("packSize mirrors hordeSize, smaller: solo 3, clan 6 + 2/member, capped at 6 / 12", () => {
    expect(G.packSize({ clan: false })).toBe(3);
    expect(G.packSize({ clan: true, members: 1 })).toBe(8);
    expect(G.packSize({ clan: true, members: 3 })).toBe(12);
    expect(G.packSize({ clan: true, members: 10 })).toBe(12);
    expect(G.packSize({ clan: false, level: 10, daysPastGrace: 30 })).toBe(6);
  });

  it("activation matrix: hordes run only when zombies AND hordes are on; packs run in every other combination", () => {
    expect(G.hordesActive(rig({ zombies: true, hordes: true }))).toBe(true);
    expect(G.packsActive(rig({ zombies: true, hordes: true }))).toBe(false);
    expect(G.hordesActive(rig({ zombies: true, hordes: false }))).toBe(false);
    expect(G.packsActive(rig({ zombies: true, hordes: false }))).toBe(true);
    expect(G.hordesActive(rig({ zombies: false, hordes: true }))).toBe(false);
    expect(G.packsActive(rig({ zombies: false, hordes: true }))).toBe(true);
    expect(G.hordesActive(rig({ zombies: false, hordes: false }))).toBe(false);
    expect(G.packsActive(rig({ zombies: false, hordes: false }))).toBe(true);
  });

  it("director: with hordes off, a pack warning fires at night after grace (kind Pack); with hordes on, no pack at all", () => {
    // Packs on (zombies on, hordes off): a base + an outside prey, night, day 7 past grace 6 for a level-1 target.
    const w = rig({ zombies: true, hordes: false }, 0, 7);
    installPermissions(w);
    const p = playerAt(w, 400, 0);
    w.set(p, G.Health, { hp: 1e6, max: 1e6 }); // the pack must not kill its prey before the spawn assert
    place(w, "foundation", 402, 2);
    G.packRuntime(w).nextTick = w.tick + 1; // +1: 0 is the uninitialised sentinel // skip the half-interval first-run delay
    steps(w, 40); // two director runs
    const st = w.get(w.environment, G.HordeStatus)!;
    expect(st.phase).toBe(G.HordePhase.Warning);
    expect(st.kind).toBe(G.HordeKind.Pack);
    expect(st.size).toBeGreaterThanOrEqual(3);
    expect(packMembers(w)).toHaveLength(0); // warning only — nothing spawned yet
    steps(w, 600); // warnSeconds 30 s elapse
    expect(w.get(w.environment, G.HordeStatus)!.phase).toBe(G.HordePhase.Active);
    expect(packMembers(w).length).toBeGreaterThanOrEqual(3);
    void p;
    // Hordes on: the same world shape produces a horde, never a pack.
    const hw = rig({ zombies: true, hordes: true }, 0, 7);
    installPermissions(hw);
    playerAt(hw, 400, 0);
    place(hw, "foundation", 402, 2);
    G.packRuntime(hw).nextTick = hw.tick + 1;
    G.hordeRuntime(hw).nextTick = hw.tick + 1;
    steps(hw, 700);
    expect(packMembers(hw)).toHaveLength(0);
    expect([...hw.query([G.PackMember])]).toHaveLength(0);
    expect(hw.get(hw.environment, G.HordeStatus)?.kind).not.toBe(G.HordeKind.Pack);
  });

  it("spawn: a forced pack has the right size and only wolves + bears, spawned in the 36–48 ring", () => {
    const w = rig({ zombies: false });
    const p = playerAt(w, 400, 0);
    const id = G.forcePack(w, preyOf(w, p), 30);
    expect(id).toBeGreaterThan(0);
    const members = packMembers(w);
    expect(members).toHaveLength(30);
    const kinds = new Set(members.map((m) => G.animalDefs()[w.get(m, G.Animal)!.kind]!.key));
    expect([...kinds].every((k) => k === WOLF || k === BEAR)).toBe(true);
    expect(kinds.has(WOLF)).toBe(true);
    expect(kinds.has(BEAR)).toBe(true); // 30 draws at 4:1 — a missing bear is a ~0.1% flake
    for (const m of members) expect(dist(w, m, 400, 0)).toBeGreaterThanOrEqual(G.PACKS.spawnRingMin - 4);
    expect(w.get(w.environment, G.HordeStatus)!.phase).toBe(G.HordePhase.Active);
    expect(w.get(w.environment, G.HordeStatus)!.kind).toBe(G.HordeKind.Pack);
  });

  it("prey picker: an outside survivor is preferred over one indoors; the base is the prey's base", () => {
    const w = rig({ zombies: false });
    const { pieces } = hut(w);
    void pieces;
    const inside = playerAt(w, 10.5, 10.5, 1);
    const outside = playerAt(w, 400, 0, 2);
    const targets = G.packPreyTargets(w);
    expect(targets[0]!.prey).toBe(outside);
    expect(targets[0]!.outside).toBe(true);
    const inner = targets.find((t) => t.prey === inside)!;
    expect(inner.outside).toBe(false);
    expect(inner.base).toBeDefined(); // the hut group is the watch point
    expect(inner.base!.pieces.length).toBeGreaterThanOrEqual(1);
  });

  it("a pack hunts a prey survivor in the open: closes in, attacks, and never flees when hurt", () => {
    const w = rig({ zombies: false });
    const p = playerAt(w, 400, 0);
    w.set(p, G.Health, { hp: 1000, max: 1000 });
    const [wolf] = packNear(w, p, 405, 0, 1);
    steps(w, 120);
    expect(stateOf(w, wolf!)).toBe(G.AnimalState.Attack);
    expect(dist(w, wolf!, 400, 0)).toBeLessThan(2);
    steps(w, 120);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(1000); // bitten
    // Hurt to 10% hp: a directed pack member does not break off (no flee).
    w.set(wolf!, G.Health, { hp: 7, max: 70 });
    steps(w, 60);
    expect(stateOf(w, wolf!)).toBe(G.AnimalState.Attack);
  });

  it("safe-radius exemption: a pack hunts a prey standing at their bed; a plain wolf does not", () => {
    const w = rig({ zombies: false });
    installPermissions(w);
    const p = playerAt(w, 401, 0.5, 1);
    const bed = [...G.gameplayDefs(w).pieces.values()].find((q) => q.key === "bed")!;
    const b = w.create();
    w.add(b, Transform, { x: 400, y: 0 }).add(b, G.BuildPiece, { type: bed.id } as never).add(b, G.PieceOwner, { player: 1 });
    G.installBedRespawn(w);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(true);
    w.set(p, G.Health, { hp: 1000, max: 1000 });
    const [wolf] = packNear(w, p, 406, 0.5, 1);
    steps(w, 240);
    expect(stateOf(w, wolf!)).toBe(G.AnimalState.Attack);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(1000);
    // Control (separate world, so the pack member's hunt can't be shared — ADR-494): a plain
    // wolf at the same spot will not engage the safe-radius prey.
    const w2 = rig({ zombies: false });
    installPermissions(w2);
    const p2 = playerAt(w2, 401, 0.5, 1);
    const bed2 = [...G.gameplayDefs(w2).pieces.values()].find((q) => q.key === "bed")!;
    const b2 = w2.create();
    w2.add(b2, Transform, { x: 400, y: 0 }).add(b2, G.BuildPiece, { type: bed2.id } as never).add(b2, G.PieceOwner, { player: 1 });
    G.installBedRespawn(w2);
    w2.set(p2, G.Health, { hp: 1000, max: 1000 });
    const plain = G.spawnAnimal(w2, WOLF, 406, 0.5);
    steps(w2, 120);
    expect(stateOf(w2, plain)).not.toBe(G.AnimalState.Attack);
    expect(w2.get(p2, G.Health)!.hp).toBe(1000);
  });

  it("a pack never damages walls or doors: with the prey indoors and doors closed it waits outside, watching", () => {
    const w = rig({ zombies: false });
    const { pieces } = hut(w, false);
    const p = playerAt(w, 10.5, 10.5);
    const before = snapshotPieces(w, pieces);
    const members = packNear(w, p, 16, 10.5, 2);
    steps(w, 600);
    // Nothing about any piece changed (no damage, no demolish, no toggle).
    expect(snapshotPieces(w, pieces)).toEqual(before);
    for (const m of members) {
      expect(stateOf(w, m)).toBe(G.AnimalState.Investigate); // watching, not attacking
      const pos = posOf(w, m);
      expect(pos.x < 10 || pos.x > 11 || pos.y < 10 || pos.y > 11).toBe(true); // still outside the hut
      expect(dist(w, m, 10.5, 11)).toBeLessThan(4); // holding at the (closed) S door
    }
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max); // never bitten
  });

  it("a pack enters through an OPEN door and reaches the prey inside", () => {
    const w = rig({ zombies: false });
    hut(w, true);
    const p = playerAt(w, 10.5, 10.5);
    w.set(p, G.Health, { hp: 1000, max: 1000 });
    const members = packNear(w, p, 16, 10.5, 2);
    steps(w, 600);
    const inside = members.filter((m) => { const pos = posOf(w, m); return pos.x >= 10 && pos.x <= 11 && pos.y >= 10 && pos.y <= 11; });
    expect(inside.length).toBeGreaterThan(0); // at least one member slipped through the open door
    steps(w, 120);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(1000); // and bit the prey once inside
  });

  it("an open doorway with no door hung is a way in, too", () => {
    const w = rig({ zombies: false });
    const pieces: Entity[] = [place(w, "foundation", 10.5, 10.5)];
    pieces.push(place(w, "wall", ...EDGE.N), place(w, "wall", ...EDGE.W), place(w, "wall", ...EDGE.E));
    pieces.push(place(w, "wall_doorway", ...EDGE.S)); // no door hung: open doorway
    pieces.push(place(w, "roof_flat", 10.5, 10.5, { level: 1 }));
    void pieces;
    const p = playerAt(w, 10.5, 10.5);
    w.set(p, G.Health, { hp: 1000, max: 1000 });
    const members = packNear(w, p, 16, 10.5, 1);
    steps(w, 600);
    const pos = posOf(w, members[0]!);
    expect(pos.x >= 10 && pos.x <= 11 && pos.y >= 10 && pos.y <= 11).toBe(true);
  });

  it("a pack disbands to plain animals when the target is gone", () => {
    const w = rig({ zombies: false });
    const p = playerAt(w, 400, 0);
    const members = packNear(w, p, 405, 0, 3);
    expect(packMembers(w)).toHaveLength(3);
    w.destroy(p); // the prey is gone
    steps(w, 60); // director runs + members re-think
    expect(packMembers(w)).toHaveLength(0);
    expect(G.packRuntime(w).packs.size).toBe(0);
    for (const m of members) {
      expect(w.isAlive(m)).toBe(true); // disbanded, not killed
      expect(stateOf(w, m)).not.toBe(G.AnimalState.Attack);
    }
  });

  it("noise siege: a loud noise re-targets a hearing pack onto the noise maker", () => {
    const w = rig({ zombies: false });
    const a = playerAt(w, 400, 0, 1);
    const b = playerAt(w, 420, 0, 2);
    const id = G.forcePack(w, preyOf(w, a), 3);
    const pk = G.packRuntime(w).packs.get(id)!;
    expect(pk.prey).toBe(a);
    let i = 0;
    for (const m of pk.members) { w.set(m, Transform, { x: 412 + (i % 2), y: i }); i++; } // ~8 tiles from B's noise
    G.makeNoise(w, b, 18); // a sprint at B
    steps(w, 20); // one director run
    const after = G.packRuntime(w).packs.get(id)!;
    expect(after.prey).toBe(b);
    expect(after.siegeUntil).toBeGreaterThan(w.tick);
    expect(after.siegeUntil - w.tick).toBeLessThanOrEqual(G.packSiegeTicks(w));
    for (const m of after.members) expect(w.get(m, G.PackMember)!.prey).toBe(b);
  });

  it("a quiet noise does not re-target a pack", () => {
    const w = rig({ zombies: false });
    const a = playerAt(w, 400, 0, 1);
    const b = playerAt(w, 420, 0, 2);
    const id = G.forcePack(w, preyOf(w, a), 3);
    let i = 0;
    for (const m of G.packRuntime(w).packs.get(id)!.members) { w.set(m, Transform, { x: 412 + (i % 2), y: i }); i++; }
    G.makeNoise(w, b, 5); // a door: below noiseMin 8
    steps(w, 20);
    expect(G.packRuntime(w).packs.get(id)!.prey).toBe(a);
    expect(G.packRuntime(w).packs.get(id)!.siegeUntil).toBe(0);
  });
});
