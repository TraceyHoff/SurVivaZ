import { describe, expect, it } from "vitest";
import { PlayerId, Transform } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";

function keys(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  const d = G.gameplayDefs(w);
  return ents.map((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?");
}
function zOf(w: ReturnType<typeof makeWorld>, e: number) {
  return w.getField(e, G.PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / G.gameplayDefs(w).building.levelHeight);
}
function stock(w: ReturnType<typeof makeWorld>, p: number) {
  const d = G.gameplayDefs(w);
  for (const key of ["wood", "stone", "nails", "planks", "rope", "cloth", "scrap_metal"]) {
    try { G.addItem(w, p, d.itemId(key), 250); } catch { /* renamed */ }
  }
}

describe("ADR-300 abandoned structures", () => {
  it("keeps a catalog of lived-in types including gardens, pens, and two- and three-story homes", () => {
    const shed = G.catalogHas(G.AbandonedKind.Shed);
    expect(shed.stories).toBe(1);
    expect(shed.w).toBeGreaterThanOrEqual(3);
    const home = G.catalogHas(G.AbandonedKind.Homestead);
    expect(home.garden).toBe(true);
    expect(home.pen).toBe(true);
    const two = G.catalogHas(G.AbandonedKind.TwoStoryCottage);
    expect(two.stories).toBe(2);
    const farm = G.catalogHas(G.AbandonedKind.TwoStoryFarmhouse);
    expect(farm.stories).toBe(2);
    expect(farm.w).toBeGreaterThan(two.w);
    const town = G.catalogHas(G.AbandonedKind.Townhouse);
    expect(town.stories).toBe(3);
    const manor = G.catalogHas(G.AbandonedKind.Manor);
    expect(manor.stories).toBe(2);
    expect(manor.garden).toBe(true);
    expect(manor.pen).toBe(true);
    expect(manor.w * manor.h).toBeGreaterThan(home.w * home.h);
  });

  it("plans the same site from the same seed and a different site from another seed", () => {
    const a = G.planAbandonedSite(42, 10, 20);
    const b = G.planAbandonedSite(42, 10, 20);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = G.planAbandonedSite(99, 10, 20);
    expect(JSON.stringify(a) === JSON.stringify(c)).toBe(false);
  });

  it("stamps an enclosed furnished shed from real pieces", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    expect(r.skipped).toBe(false);
    expect(r.marker).toBeGreaterThan(0);
    const ks = keys(w, r.placed);
    expect(ks.filter((k) => k === "foundation").length).toBe(9);
    expect(ks.filter((k) => k === "wall" || k === "wall_doorway" || k === "wall_window" || k === "wall_corner_outer").length).toBeGreaterThanOrEqual(8);
    expect(ks).toContain("wall_corner_outer");
    expect(ks).toContain("door_wood");
    expect(ks.some((k) => k.includes("storage") || k === "barrel_storage")).toBe(true);
    expect(ks).toContain("roof_flat");
  });

  it("stamps a homestead with a fenced garden and animal pen", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Homestead, rot: 0, ruin: 0, tier: 1 });
    expect(r.skipped).toBe(false);
    expect(r.garden).toBe(true);
    expect(r.pen).toBe(true);
    const ks = keys(w, r.placed);
    expect(ks.some((k) => k === "fence_picket" || k === "garden_gate" || k === "garden_bed" || k === "flower_bed")).toBe(true);
    expect(ks.some((k) => k === "fence_rail" || k === "feeding_trough" || k === "garden_gate")).toBe(true);
  });

  it("stamps two- and three-story buildings with stairs, upper floors, and a roof at the top story", () => {
    const w = makeWorld();
    const two = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0, tier: 1 });
    expect(two.skipped).toBe(false);
    expect(two.stories).toBe(2);
    const twoKeys = keys(w, two.placed);
    expect(twoKeys).toContain("stairs");
    expect(two.placed.some((e) => twoKeys[two.placed.indexOf(e)] === "floor" && zOf(w, e) >= 1)).toBe(true);
    expect(two.placed.some((e) => twoKeys[two.placed.indexOf(e)] === "roof_flat" && zOf(w, e) === 2)).toBe(true);

    const w3 = makeWorld();
    const three = G.stampAbandonedSite(w3, 8, 8, { kind: G.AbandonedKind.Townhouse, rot: 0, ruin: 0, tier: 1 });
    expect(three.skipped).toBe(false);
    expect(three.stories).toBe(3);
    const threeKeys = keys(w3, three.placed);
    expect(threeKeys).toContain("stairs");
    expect(three.placed.some((e) => threeKeys[three.placed.indexOf(e)] === "floor" && zOf(w3, e) >= 2)).toBe(true);
    expect(three.placed.some((e) => threeKeys[three.placed.indexOf(e)] === "roof_flat" && zOf(w3, e) === 3)).toBe(true);
  });

  it("applies disrepair without dropping load-bearing decks, walls, or stairs", () => {
    const w = makeWorld();
    const intact = G.planAbandonedSite(w.seed, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0 });
    expect(intact.pieces.every((p) => !p.omit)).toBe(true);
    const ruined = G.planAbandonedSite(w.seed, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.9 });
    expect(ruined.pieces.some((p) => p.omit && (p.role === "opening" || p.role === "furniture" || p.role === "loot" || p.role === "roof"))).toBe(true);
    expect(ruined.pieces.filter((p) => p.role === "deck" || p.role === "wall" || p.role === "stair").every((p) => !p.omit)).toBe(true);
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.9, tier: 1 });
    expect(r.skipped).toBe(false);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.placed.some((e) => w.getField(e, G.BuildPiece, "hp")! < G.maxHpOf(w, e))).toBe(true);
  });

  it("does not stamp the same origin twice", () => {
    const w = makeWorld();
    const first = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    const n = first.placed.length;
    const second = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    expect(second.skipped).toBe(true);
    expect([...w.query([G.BuildPiece])].length).toBe(n);
  });

  it("lets a player repair a damaged site piece", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0, tier: 1 });
    const damaged = r.placed.find((e) => {
      const key = keys(w, [e])[0];
      return key === "wall" || key === "foundation" || key === "wall_corner_outer";
    });
    expect(damaged).toBeDefined();
    const max = G.maxHpOf(w, damaged!);
    w.set(damaged!, G.BuildPiece, { ...w.get(damaged!, G.BuildPiece)!, hp: Math.max(1, Math.floor(max * 0.4)), damageStage: 2 });
    const t = w.get(damaged!, Transform)!;
    const p = spawnLearned(w, { x: t.x, y: t.y, maxWeight: 10_000 });
    const d = G.gameplayDefs(w);
    const bp = w.get(damaged!, G.BuildPiece)!;
    const def = d.pieces.get(bp.type)!;
    const missing = 1 - bp.hp / max;
    const mul = (d.tiers[bp.tier]?.repairMul ?? 0.3) * missing;
    for (const c of G.pieceCost(d, def, bp.tier, mul)) G.addItem(w, p, c.item, c.count + 8);
    const before = w.getField(damaged!, G.BuildPiece, "hp")!;
    G.setIntent(w, p, { action: G.IntentAction.Repair, target: damaged! });
    steps(w, 2);
    expect(w.getField(damaged!, G.BuildPiece, "hp")!).toBeGreaterThan(before);
    expect(w.getField(damaged!, G.BuildPiece, "hp")!).toBe(G.maxHpOf(w, damaged!));
  });

  it("lets a player reclaim a site and blocks a second actor", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    const piece = r.placed[0]!;
    const a = spawnLearned(w, { x: 9.5, y: 9.5 });
    const b = spawnLearned(w, { x: 9.2, y: 8.8 });
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    if (w.has(a, PlayerId)) w.set(a, PlayerId, { id: 1 }); else w.add(a, PlayerId, { id: 1 });
    if (w.has(b, PlayerId)) w.set(b, PlayerId, { id: 2 }); else w.add(b, PlayerId, { id: 2 });
    const pid = 1;
    expect(G.reclaimAbandonedSite(w, a, piece)).toBe(0);
    expect(w.getField(r.marker, G.AbandonedSite, "claimed")).toBe(1);
    expect(w.getField(r.marker, G.AbandonedSite, "claimedBy")).toBe(pid);
    expect(w.getField(piece, G.PieceOwner, "player")).toBe(pid);
    expect(G.reclaimAbandonedSite(w, b, piece)).toBe(G.BuildFail.NoPrivilege);
    const fails = collect(w, G.BuildFailed);
    G.setIntent(w, b, { action: G.IntentAction.Reclaim, target: piece });
    steps(w, 2);
    expect(fails.some((f) => f.reason === G.BuildFail.NoPrivilege)).toBe(true);
  });

  it("exposes nearby unowned sites to AI and maps reclaim actions", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.8, tier: 1 });
    const work = G.nearbyAbandonedWork(w, 10, 10, 24);
    expect(work).toBeDefined();
    expect(work!.marker).toBe(r.marker);
    expect(work!.reclaim).toBe(true);
    const cmd = G.actionCommand(`reclaim:${r.marker}`);
    expect(cmd).toEqual({ type: G.ReclaimCmd.name, payload: { target: r.marker } });
  });

  it("picks chunk sites from the world seed without leaving the chunk", () => {
    let found: { cx: number; cy: number; originX: number; originY: number } | undefined;
    for (let cy = 0; cy < 16 && !found; cy++) {
      for (let cx = 0; cx < 16 && !found; cx++) {
        const plan = G.planAbandonedChunk(7, cx, cy);
        if (plan) found = { cx, cy, originX: plan.originX, originY: plan.originY };
      }
    }
    expect(found).toBeDefined();
    const again = G.planAbandonedChunk(7, found!.cx, found!.cy)!;
    expect(again.originX).toBe(found!.originX);
    expect(again.originY).toBe(found!.originY);
    expect(again.originX).toBeGreaterThanOrEqual(found!.cx * 32);
    expect(again.originY).toBeGreaterThanOrEqual(found!.cy * 32);
    expect(again.originX).toBeLessThan((found!.cx + 1) * 32);
    expect(again.originY).toBeLessThan((found!.cy + 1) * 32);
  });
});
