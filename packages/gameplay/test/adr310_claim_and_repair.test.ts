/**
 * ADR-310: players and AI humans must plant a Claim Flag before placing, repairing, or reclaiming
 * base structures, and may repair only pieces they have unlocked in the skill trees.
 */
import { describe, expect, it } from "vitest";
import { PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned, steps, collect } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);

function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return G.snapPlacement(w, { piece: pid(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 0, variant: 0 });
}

function ghost(w: World, p: Entity, key: string, x: number, y: number, o: { tier?: number } = {}): number {
  const sn = snap(w, key, x, y, o);
  return typeof sn === "number" ? sn : G.validatePlacement(w, p, sn, { ignoreCost: true });
}

function dropPiece(w: World, b: Entity, key: string, x: number, y: number, o: { tier?: number } = {}): Entity {
  const sn = snap(w, key, x, y, { tier: o.tier ?? 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}

function payRepair(w: World, p: Entity, piece: Entity): void {
  const bp = w.get(piece, G.BuildPiece)!;
  const def = d.pieces.get(bp.type)!;
  const max = G.maxHpOf(w, piece);
  const missing = 1 - bp.hp / Math.max(1, max);
  const mul = (d.tiers[bp.tier]?.repairMul ?? 0.3) * missing;
  for (const c of G.pieceCost(d, def, bp.tier, mul)) G.addItem(w, p, c.item, c.count + 8);
}

function setPid(w: World, e: Entity, id: number): void {
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id });
}

describe("ADR-310 claim flag before building", () => {
  it("refuses a foundation until a covering Claim Flag is planted", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 2, y: 2, maxWeight: 0, clientId: 1 });
    expect(ghost(w, p, "foundation", 2.5, 2.5)).toBe(G.BuildFail.NeedClaim);
    const flag = plantClaim(w, p, 2, 2);
    expect(w.getField(flag, G.PrivilegeZone, "radius")).toBe(32); // ADR-315 (was 12)
    expect(w.getField(p, G.Tribe, "id") ?? 0).toBeGreaterThan(0);
    expect(G.hasOwnClaim(w, p, 2.5, 2.5)).toBe(true);
    expect(ghost(w, p, "foundation", 2.5, 2.5)).toBe(0);
  });

  it("a flag beyond its radius (32 since ADR-315) does not authorize a build", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 34, y: 0, maxWeight: 0, clientId: 1 });
    plantClaim(w, p, 0, 0);
    expect(G.hasOwnClaim(w, p, 34.5, 0.5)).toBe(false);
    const sn = snap(w, "foundation", 34.5, 0.5);
    expect(typeof sn).toBe("object");
    if (typeof sn === "number") return;
    expect(G.validatePlacement(w, p, sn, { ignoreCost: true, ignoreRange: true })).toBe(G.BuildFail.NeedClaim);
  });

  it("a foreign flag is NoPrivilege, not NeedClaim", () => {
    const w = makeWorld();
    const a = spawnLearned(w, { x: 2, y: 2, maxWeight: 0, clientId: 1 });
    const b = spawnLearned(w, { x: 2.2, y: 2.2, maxWeight: 0, clientId: 2 });
    setPid(w, a, 1); setPid(w, b, 2);
    plantClaim(w, a, 2, 2);
    expect(ghost(w, b, "foundation", 2.5, 2.5)).toBe(G.BuildFail.NoPrivilege);
  });

  it("a tribe-less player can plant a Claim Flag and receives a personal tribe", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 1, y: 1, maxWeight: 0, clientId: 1 });
    expect(w.getField(p, G.Tribe, "id") ?? 0).toBe(0);
    const sn = snap(w, "claim_totem", 1, 1);
    expect(typeof sn).toBe("object");
    if (typeof sn === "number") return;
    expect(G.validatePlacement(w, p, sn, { ignoreCost: true })).toBe(0);
    const flag = G.placePiece(w, p, sn, { pay: false });
    const tribe = w.getField(p, G.Tribe, "id") ?? 0;
    expect(tribe).toBeGreaterThanOrEqual(0x8000);
    expect(w.getField(flag, G.PrivilegeZone, "tribe")).toBe(tribe);
  });
});

describe("ADR-310 repair and reclaim", () => {
  it("repair without a covering flag is NeedClaim", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 5, y: 5, maxWeight: 10_000, clientId: 1 });
    const wall = dropPiece(w, p, "wall", 6, 5.5, { tier: 1 });
    w.setField(wall, G.BuildPiece, "hp", 10);
    payRepair(w, p, wall);
    const fails = collect(w, G.BuildFailed);
    G.setIntent(w, p, { action: G.IntentAction.Repair, target: wall });
    steps(w, 2);
    expect(fails.some((f) => f.reason === G.BuildFail.NeedClaim)).toBe(true);
    expect(w.getField(wall, G.BuildPiece, "hp")).toBe(10);
  });

  it("repair inside a claim without the piece unlock is SkillLocked", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 5, y: 5, maxWeight: 10_000, clientId: 1 });
    plantClaim(w, p, 5, 5);
    const wall = dropPiece(w, p, "wall", 6, 5.5, { tier: 1 });
    w.setField(wall, G.BuildPiece, "hp", 10);
    payRepair(w, p, wall);
    expect(G.pieceUnlocked(w, p, d.pieces.get(pid("wall"))!, 1)).toBe(false);
    const fails = collect(w, G.BuildFailed);
    G.setIntent(w, p, { action: G.IntentAction.Repair, target: wall });
    steps(w, 2);
    expect(fails.some((f) => f.reason === G.BuildFail.SkillLocked)).toBe(true);
    expect(w.getField(wall, G.BuildPiece, "hp")).toBe(10);
  });

  it("repair inside a claim with the unlock restores the piece", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 5, y: 5, maxWeight: 10_000, clientId: 1 });
    plantClaim(w, p, 5, 5);
    const wall = dropPiece(w, p, "wall", 6, 5.5, { tier: 1 });
    w.setField(wall, G.BuildPiece, "hp", 10);
    payRepair(w, p, wall);
    G.setIntent(w, p, { action: G.IntentAction.Repair, target: wall });
    steps(w, 2);
    expect(w.getField(wall, G.BuildPiece, "hp")).toBe(G.maxHpOf(w, wall));
  });

  it("reclaim without a covering flag is NeedClaim, and succeeds after one is planted", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    const piece = r.placed[0]!;
    const p = spawnLearned(w, { x: 9.5, y: 9.5, maxWeight: 0, clientId: 1 });
    setPid(w, p, 1);
    expect(G.reclaimAbandonedSite(w, p, piece)).toBe(G.BuildFail.NeedClaim);
    plantClaim(w, p, 5, 5);
    expect(G.reclaimAbandonedSite(w, p, piece)).toBe(0);
    expect(w.getField(r.marker, G.AbandonedSite, "claimed")).toBe(1);
    expect(w.getField(r.marker, G.AbandonedSite, "claimedBy")).toBe(1);
  });

  it("itemRepairUnlocked passes for ungated items", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const wood = d.itemId("wood");
    expect(G.itemRepairUnlocked(w, p, wood)).toBe(true);
  });
});

describe("ADR-310 AI plants a Claim Flag first", () => {
  it("obtainPiece for a station yields a claim_totem build step when the base is unclaimed", () => {
    const w = makeWorld();
    const base = { x: 10, y: 10 };
    const p = spawnLearned(w, { x: base.x + 1, y: base.y + 3.3, maxWeight: 0, clientId: 1 });
    G.addItem(w, p, d.itemId("stone_axe"), 1);
    G.addItem(w, p, d.itemId("stone_pickaxe"), 1);
    const fire = d.pieces.get(pid("campfire"))!;
    for (const c of G.pieceCost(d, fire, fire.fixedTier)) G.addItem(w, p, c.item, c.count);
    const flag = d.pieces.get(pid("claim_totem"))!;
    for (const c of G.pieceCost(d, flag, flag.fixedTier)) G.addItem(w, p, c.item, c.count);
    G.addItem(w, p, d.itemId("wood"), G.WOOD_RESERVE + 8);
    const pl = G.makePlan({ world: w, self: p, defs: d, base, bs: G.scanBase(w, d, base), fails: {} });
    expect(pl.goal).toBe("campfire");
    expect(pl.step?.k).toBe("build");
    if (pl.step?.k !== "build") return;
    expect(d.pieces.get(pl.step.piece)?.key).toBe("claim_totem");
    expect(G.STATION_SLOTS.claim_totem?.length).toBeGreaterThan(0);
  });
});
