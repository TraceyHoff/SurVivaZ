/**
 * ADR-372 stairs and second-floor access.
 *
 * A stairs piece was already stamped into every two-story abandoned house (plus a `floor_stairwell`
 * hole above it), but nothing ever moved an entity between levels on it. These tests pin the fix:
 * the stair tile is a ramp in `standHeightAt`, so walking across it (players, AI humans, anything that
 * settles) climbs / descends; `findPath` and the creature-nav `route` understand stair tiles as level
 * links; a missing stair blocks access until it is built back; and the claim-build flow rebuilds a
 * missing stair for AI humans.
 *
 * The two-story cottage stamped at (8, 8) rot 0 is the fixture throughout: interior stair tile (9, 11),
 * centre (9.5, 11.5), up = north; exterior stair tile A (9, 14), balcony B (9, 13), L1 door above the
 * ground door's neighbour. Ruin 0 never drops stairs (ADR-372 roll is ruin-scaled).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { planClaimRuin } from "../src/ai/claim_build.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";
import { room, setDoor, world215 } from "./nav215_fixture.js";

const DT = 1 / 20;
const LH = 3; // building.levelHeight
const OX = 8, OY = 8;

/** World (screen) direction -> analog stick axes (the inverse of movement.moveVector). */
function toAnalog(dx: number, dy: number): { x: number; y: number } {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  return { x: (ux - uy) * Math.SQRT1_2, y: (ux + uy) * Math.SQRT1_2 };
}
/** Walk entity `e` toward (tx, ty) one tick at a time (applyMovementInput + world step, the adr107 idiom). */
function walkTick(w: World, e: Entity, tx: number, ty: number): void {
  const t = w.get(e, Transform)!;
  const a = toAnalog(tx - t.x, ty - t.y);
  G.applyMovementInput(w, e, 0, DT, a);
  w.step(DT);
}
/** Walk toward (tx, ty) until within 0.15 or `maxTicks`; returns whether it arrived. */
function walkTo(w: World, e: Entity, tx: number, ty: number, maxTicks = 600): boolean {
  for (let i = 0; i < maxTicks; i++) {
    const t = w.get(e, Transform)!;
    if (Math.hypot(tx - t.x, ty - t.y) < 0.15) return true;
    walkTick(w, e, tx, ty);
  }
  const t = w.get(e, Transform)!;
  return Math.hypot(tx - t.x, ty - t.y) < 0.15;
}
/** Stand still for `n` ticks so z eases onto its stand height. */
function settle(w: World, e: Entity, n = 20): void {
  for (let i = 0; i < n; i++) { G.applyMovementInput(w, e, 0, DT); w.step(DT); }
}
const zOf = (w: World, e: Entity): number => w.get(e, Transform)?.z ?? 0;
const levelOf = (w: World, e: Entity): number => Math.max(0, Math.round(zOf(w, e) / LH));
const keys = (w: World, ents: readonly Entity[]): string[] => {
  const d = G.gameplayDefs(w);
  return ents.map((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?");
};
const lvlOf = (w: World, e: Entity): number => w.getField(e, G.PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / LH);
function stampCottage(w: World, ruin = 0): { marker: Entity; placed: Entity[] } {
  const r = G.stampAbandonedSite(w, OX, OY, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin, tier: 1 });
  expect(r.skipped).toBe(false);
  steps(w, 2);
  return { marker: r.marker as Entity, placed: r.placed };
}
function pieceAt(w: World, placed: readonly Entity[], key: string, x: number, y: number, level: number): Entity | undefined {
  return placed.find((e) => {
    const t = w.get(e, Transform)!;
    return keys(w, [e])[0] === key && Math.abs(t.x - x) < 0.6 && Math.abs(t.y - y) < 0.6 && lvlOf(w, e) === level;
  });
}
function stock(w: World, p: Entity): void {
  // ADR-337 idiom: 20 of each keeps the 24-slot pack inside its slot cap (250 of each overflows
  // it and later items — rope — never land, which made the claim plan gather forever).
  const d = G.gameplayDefs(w);
  for (const k of ["wood", "stone", "sticks", "planks", "rope", "nails", "fiber", "clay", "dye", "berries"]) {
    try { G.addItem(w, p, d.itemId(k), 20); } catch { /* renamed */ }
  }
}

describe("ADR-372 stair ramp", () => {
  it("standHeightAt ramps 0 -> levelHeight across the stair tile, and back down at level 1", () => {
    const w = makeWorld();
    stampCottage(w);
    // Interior stair tile (9, 11): south edge is the bottom (z ~ 0), north edge the top (z ~ 3).
    expect(G.standHeightAt(w, 9.5, 11.9, 0)).toBeCloseTo(0.3, 1);
    expect(G.standHeightAt(w, 9.5, 11.5, 0)).toBeCloseTo(1.5, 1);
    expect(G.standHeightAt(w, 9.5, 11.1, 0)).toBeCloseTo(2.7, 1);
    // Same tile from level 1 (the stairwell hole): walking back south descends the same ramp.
    expect(G.standHeightAt(w, 9.5, 11.1, 1)).toBeCloseTo(2.7, 1);
    expect(G.standHeightAt(w, 9.5, 11.9, 1)).toBeCloseTo(0.3, 1);
    // Off the stair tile the old heights are untouched (foundation deck 0.75, upper floor 3.3125).
    expect(G.standHeightAt(w, 10.5, 11.5, 0)).toBeCloseTo(0.75, 2);
    expect(G.standHeightAt(w, 10.5, 10.5, 1)).toBeCloseTo(3.3125, 2);
  });

  it("a stair tile does not block movement at either level", () => {
    const w = makeWorld();
    stampCottage(w);
    expect(G.movementBlocked(w, 9.5, 10.5, 9.5, 11.5, 0)).toBe(false);
    expect(G.movementBlocked(w, 9.5, 11.5, 9.5, 10.5, 1)).toBe(false);
    expect(G.solidCell(G.structures(w), 9, 11, 0)).toBe(false);
    expect(G.solidCell(G.structures(w), 9, 11, 1)).toBe(false);
  });

  it("a player walks up the interior stairs to level 1 and back down", () => {
    const w = makeWorld();
    stampCottage(w);
    const p = spawnLearned(w, { x: 8.5, y: 12.5, maxWeight: 10_000 });
    settle(w, p);
    expect(zOf(w, p)).toBeCloseTo(0.75, 1);
    expect(walkTo(w, p, 8.5, 10.5)).toBe(true);
    expect(walkTo(w, p, 9.5, 10.5)).toBe(true);
    expect(walkTo(w, p, 9.5, 11.5)).toBe(true); // onto the stair tile
    expect(walkTo(w, p, 9.5, 10.5)).toBe(true); // north across it: the climb
    settle(w, p);
    expect(levelOf(w, p)).toBe(1);
    expect(zOf(w, p)).toBeCloseTo(3.3125, 1);
    // Back down the same flight.
    expect(walkTo(w, p, 9.5, 12.5)).toBe(true);
    settle(w, p);
    expect(levelOf(w, p)).toBe(0);
    expect(zOf(w, p)).toBeCloseTo(0.75, 1);
  });

  it("standing still on the stair tile settles mid-ramp, never a full climb", () => {
    const w = makeWorld();
    stampCottage(w);
    const p = spawnLearned(w, { x: 9.5, y: 11.5, maxWeight: 10_000 });
    settle(w, p, 40);
    expect(zOf(w, p)).toBeCloseTo(1.5, 1);
    expect(levelOf(w, p)).toBe(1); // round(1.5 / 3) = 1: mid-ramp reads as level 1, but z stays put
    const p2 = spawnLearned(w, { x: 10.5, y: 11.5, maxWeight: 10_000 });
    settle(w, p2, 40);
    expect(zOf(w, p2)).toBeCloseTo(0.75, 1);
  });

  it("outside stairs carry a player up to the balcony", () => {
    const w = makeWorld();
    const { placed } = stampCottage(w);
    // Balcony B (9, 13) on a pillar, stair tile A (9, 14) south of it, L1 door in the south wall.
    expect(pieceAt(w, placed, "stairs", 9.5, 14.5, 0)).toBeDefined();
    expect(pieceAt(w, placed, "pillar", 9.5, 13.5, 0)).toBeDefined();
    expect(pieceAt(w, placed, "floor", 9.5, 13.5, 1)).toBeDefined();
    expect(pieceAt(w, placed, "door_wood", 9.5, 13, 1)).toBeDefined();
    const p = spawnLearned(w, { x: 9.5, y: 16.5, maxWeight: 10_000 });
    expect(walkTo(w, p, 9.5, 13.5)).toBe(true);
    settle(w, p);
    expect(levelOf(w, p)).toBe(1);
    expect(zOf(w, p)).toBeCloseTo(3.3125, 1);
    const t = w.get(p, Transform)!;
    expect(Math.floor(t.x)).toBe(9);
    expect(Math.floor(t.y)).toBe(13);
  });
});

describe("ADR-372 abandoned two-story kinds", () => {
  it("every two-story kind plans a usable interior flight; exterior kinds also plan an outside run", () => {
    const two = [
      G.AbandonedKind.TwoStoryCottage, G.AbandonedKind.TwoStoryFarmhouse,
      G.AbandonedKind.TwoStoryHomestead, G.AbandonedKind.Townhouse, G.AbandonedKind.Manor,
    ] as const;
    for (const kind of two) {
      const plan = G.planAbandonedSite(42, 10, 20, { kind, rot: 0, ruin: 0 });
      expect(plan.stories).toBeGreaterThanOrEqual(2);
      const interior = plan.pieces.filter((p) => p.role === "stair" && p.level === 0 && !p.exterior && !p.omit);
      expect(interior.length).toBeGreaterThanOrEqual(1);
      // The interior flight tile carries no furniture (a wardrobe used to sit on it).
      const s = interior[0]!;
      expect(plan.pieces.some((p) => (p.role === "furniture" || p.role === "loot") && p.level === 0
        && Math.floor(p.x) === Math.floor(s.x) && Math.floor(p.y) === Math.floor(s.y))).toBe(false);
    }
    for (const kind of [G.AbandonedKind.TwoStoryCottage, G.AbandonedKind.TwoStoryFarmhouse, G.AbandonedKind.Townhouse] as const) {
      const plan = G.planAbandonedSite(42, 10, 20, { kind, rot: 0, ruin: 0 });
      expect(plan.pieces.some((p) => p.role === "stair" && p.level === 0 && p.exterior && !p.omit)).toBe(true);
      expect(plan.pieces.some((p) => p.key === "pillar" && p.level === 0)).toBe(true);
      expect(plan.pieces.some((p) => p.key === "floor" && p.level === 1)).toBe(true);
    }
    for (const kind of [G.AbandonedKind.TwoStoryHomestead, G.AbandonedKind.Manor] as const) {
      const plan = G.planAbandonedSite(42, 10, 20, { kind, rot: 0, ruin: 0 });
      expect(plan.pieces.some((p) => p.role === "stair" && p.exterior)).toBe(false);
    }
  });

  it("the townhouse second flight sits on its own tile, so the way back down stays open", () => {
    const plan = G.planAbandonedSite(42, 10, 20, { kind: G.AbandonedKind.Townhouse, rot: 0, ruin: 0 });
    const l0 = plan.pieces.filter((p) => p.role === "stair" && p.level === 0 && !p.exterior);
    const l1 = plan.pieces.filter((p) => p.role === "stair" && p.level === 1);
    expect(l0.length).toBe(1);
    expect(l1.length).toBe(1);
    expect(Math.floor(l1[0]!.x)).not.toBe(Math.floor(l0[0]!.x));
    expect(plan.pieces.some((p) => p.key === "floor_stairwell" && p.level === 2
      && Math.floor(p.x) === Math.floor(l1[0]!.x) && Math.floor(p.y) === Math.floor(l1[0]!.y))).toBe(true);
  });

  it("a ruined site can spawn with its ground flight missing (ruin-scaled, never at ruin 0)", () => {
    const w = makeWorld();
    let found: { ox: number; oy: number } | undefined;
    for (let oy = 8; oy <= 48 && !found; oy += 4) for (let ox = 8; ox <= 48 && !found; ox += 4) {
      const plan = G.planAbandonedSite(w.seed, ox, oy, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0.8 });
      if (plan.pieces.some((p) => p.role === "stair" && p.level === 0 && !p.exterior && p.omit)) found = { ox, oy };
    }
    expect(found).toBeDefined();
    const clean = G.planAbandonedSite(w.seed, found!.ox, found!.oy, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0 });
    expect(clean.pieces.some((p) => p.role === "stair" && p.omit)).toBe(false);
  });
});

describe("ADR-372 blocked / rebuilt stairs", () => {
  it("a missing stair blocks access until the player builds it back", () => {
    const w = makeWorld();
    let site: { ox: number; oy: number } | undefined;
    for (let oy = 8; oy <= 48 && !site; oy += 4) for (let ox = 8; ox <= 48 && !site; ox += 4) {
      const plan = G.planAbandonedSite(w.seed, ox, oy, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0.8 });
      if (plan.pieces.some((p) => p.role === "stair" && p.level === 0 && !p.exterior && p.omit)
        && G.siteTerrainOk(w, ox, oy, plan.width, plan.height)) site = { ox, oy };
    }
    expect(site).toBeDefined();
    const { ox, oy } = site!;
    const r = G.stampAbandonedSite(w, ox, oy, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0.8, tier: 1 });
    expect(r.skipped).toBe(false);
    steps(w, 2);
    // The interior flight tile (local 1, 3) has a stairwell above it but no stairs below it.
    const sx = ox + 1, sy = oy + 3;
    expect(G.stairPieceAt(G.structures(w), sx, sy, 0)).toBe(0);
    expect(G.standHeightAt(w, sx + 0.5, sy + 0.5, 0)).toBeCloseTo(0.75, 2);
    const p = spawnLearned(w, { x: ox + 0.5, y: oy + 4.5, maxWeight: 10_000 });
    stock(w, p);
    plantClaim(w, p, ox + 2, oy + 2);
    // Walk the climb line: onto the tile, north across it, settle. No stairs -> no lift.
    expect(walkTo(w, p, sx + 0.5, sy + 0.5)).toBe(true);
    expect(walkTo(w, p, sx + 0.5, sy - 0.5)).toBe(true);
    settle(w, p);
    expect(levelOf(w, p)).toBe(0);
    expect(zOf(w, p)).toBeCloseTo(0.75, 1);
    // Build the stairs back through the existing build system, then climb.
    const defs = G.gameplayDefs(w);
    const sn = G.snapPlacement(w, { piece: defs.pieceId("stairs"), x: sx + 0.5, y: sy + 0.5, level: 0, rot: 0, tier: 1, variant: 0 });
    expect(typeof sn).not.toBe("number");
    if (typeof sn !== "number") G.placePiece(w, p, sn, {});
    expect(G.stairPieceAt(G.structures(w), sx, sy, 0)).not.toBe(0);
    expect(walkTo(w, p, sx + 0.5, sy + 0.5)).toBe(true);
    expect(walkTo(w, p, sx + 0.5, sy - 0.5)).toBe(true);
    settle(w, p);
    expect(levelOf(w, p)).toBe(1);
    expect(zOf(w, p)).toBeCloseTo(3.3125, 1);
  });

  it("a player can build stairs and an upper floor through the existing build system", () => {
    // A 3x3 walled room (nav215 fixture idiom: snap + validate + place, cost waived as in other
    // build tests). The upper floor is wall-supported — validatePlacement rejects pillar-only and
    // floating decks — and the stairs sit on the middle tile's foundation with the L1 floor above.
    const { w, me, put } = world215();
    const { door } = room(w, put, 20, 20, 3, { door: true });
    if (door) setDoor(w, door, true);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) put("floor", 20 + x + 0.5, 20 + y + 0.5, 1);
    put("stairs", 21.5, 21.5, 0);
    put("stairs", 21.5, 21.5, 1); // a second flight on the same footprint, level 1
    steps(w, 2);
    const p = me;
    w.set(p, Transform, { x: 21.5, y: 18.5, z: 0, facing: 0 });
    settle(w, p);
    expect(walkTo(w, p, 21.5, 21.5)).toBe(true); // in through the north door, onto the stair tile
    expect(walkTo(w, p, 21.5, 20.5)).toBe(true); // north across it, onto the L1 floor
    settle(w, p);
    expect(levelOf(w, p)).toBe(1);
    expect(zOf(w, p)).toBeCloseTo(3.3125, 1);
  });
});

describe("ADR-372 AI pathfinding across levels", () => {
  it("findPath routes across levels via stairs when allowed, and stays on level 0 otherwise", () => {
    const w = makeWorld();
    stampCottage(w);
    const noStairs = G.findPath(w, 10, 12, 10, 10, () => 1000);
    expect(noStairs).toBeDefined();
    expect(noStairs!.levels.every((l) => l === 0)).toBe(true);
    const up = G.findPath(w, 10, 12, 10, 10, () => 1000, { allowStairs: true, goalLevel: 1 });
    expect(up).toBeDefined();
    expect(up!.levels).toContain(1);
    expect(up!.tiles).toContainEqual([9, 11]); // through the interior stair tile
    expect(up!.tiles).not.toContainEqual([9, 14]); // not the outside run
    const last = up!.tiles.length - 1;
    expect(up!.tiles[last]).toEqual([10, 10]);
    expect(up!.levels[last]).toBe(1);
    // The vertical step sits on the stair tile: same tile, level 0 then 1.
    const si = up!.tiles.findIndex((t) => t[0] === 9 && t[1] === 11);
    expect(si).toBeGreaterThanOrEqual(0);
    expect(up!.levels[si]).toBe(0);
    expect(up!.tiles[si + 1]).toEqual([9, 11]);
    expect(up!.levels[si + 1]).toBe(1);
    // Down again.
    const down = G.findPath(w, 10, 10, 10, 12, () => 1000, { allowStairs: true, startLevel: 1, goalLevel: 0 });
    expect(down).toBeDefined();
    expect(down!.levels).toContain(0);
    expect(down!.tiles).toContainEqual([9, 11]);
  });

  it("an AI human walks across levels via stairs (walkerWaypoint + movement input)", () => {
    const w = makeWorld();
    stampCottage(w);
    const e = spawnLearned(w, { x: 8.5, y: 12.5, maxWeight: 10_000 });
    let reached = false;
    for (let i = 0; i < 900 && !reached; i++) {
      const t = w.get(e, Transform)!;
      if (levelOf(w, e) === 1 && Math.hypot(9.5 - t.x, 10.5 - t.y) < 0.6) { reached = true; break; }
      const wp = G.walkerWaypoint(w, e, t.x, t.y, 9.5, 10.5, 1);
      expect(wp, `waypoint at tick ${i}`).toBeDefined();
      walkTick(w, e, wp!.x, wp!.y);
    }
    settle(w, e);
    expect(reached).toBe(true);
    expect(levelOf(w, e)).toBe(1);
  });

  it("an AI human cannot route upstairs when the stairs are missing", () => {
    const w = makeWorld();
    const { placed } = stampCottage(w);
    const stair = pieceAt(w, placed, "stairs", 9.5, 11.5, 0);
    expect(stair).toBeDefined();
    w.destroy(stair!);
    steps(w, 2);
    expect(G.stairPieceAt(G.structures(w), 9, 11, 0)).toBe(0);
    const e = spawnLearned(w, { x: 8.5, y: 12.5, maxWeight: 10_000 });
    let maxZ = 0;
    for (let i = 0; i < 600; i++) {
      const t = w.get(e, Transform)!;
      maxZ = Math.max(maxZ, t.z ?? 0);
      const wp = G.walkerWaypoint(w, e, t.x, t.y, 9.5, 10.5, 1);
      if (!wp) break; // no route: closest reachable tile walked, then undefined
      walkTick(w, e, wp.x, wp.y);
    }
    expect(maxZ).toBeLessThan(1.5);
    expect(levelOf(w, e)).toBe(0);
  });

  it("a claiming AI human rebuilds a missing stair (claim-build plan)", () => {
    const w = makeWorld();
    installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 10, y: 10, maxWeight: 0, clientId: 7 });
    if (w.has(p, PlayerId)) w.set(p, PlayerId, { id: 7 }); else w.add(p, PlayerId, { id: 7 });
    const { marker, placed } = stampCottage(w);
    const stair = pieceAt(w, placed, "stairs", 9.5, 11.5, 0);
    expect(stair).toBeDefined();
    w.destroy(stair!);
    steps(w, 2); // structureIndexSystem drops the removed piece from the grid on a world step;
    // without this the cell still reads Occupied and the rebuild plan skips the stair
    stock(w, p);
    plantClaim(w, p, 14, 10); // outside the house, covering the site centre (radius 32)
    const piece = placed.find((e) => e !== stair);
    expect(G.reclaimAbandonedSite(w, p, piece!)).toBe(0);
    w.tick += 25; // ruin layout cache (20 ticks) must see the destroyed stair
    const plan = planClaimRuin(w, p, marker);
    expect(plan.target.stage).toBe("rebuild");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k === "build") {
      expect(G.gameplayDefs(w).pieces.get(plan.step.piece)?.key).toBe("stairs");
    }
  });
});

describe("ADR-372 ground-level movement is unchanged", () => {
  it("walking on open ground stays at z 0 and covers ground at walk speed", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 30.5, y: 30.5, maxWeight: 10_000 });
    const before = { ...w.get(p, Transform)! };
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight, DT); w.step(DT); }
    const after = w.get(p, Transform)!;
    expect(after.z ?? 0).toBe(0);
    expect(after.x).toBeGreaterThan(before.x + 1);
    // MoveRight is screen-right = world-diagonal (+x,-y): the walker covers ground along the
    // diagonal, so assert the diagonal, not a near-zero y drift.
    expect(Math.abs((after.y - before.y) + (after.x - before.x))).toBeLessThan(0.5);
  });
});
