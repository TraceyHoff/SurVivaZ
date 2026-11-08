import { describe, it, expect } from "vitest";
import { type Entity, type World } from "@engine/core";
import { FLOOR_HEIGHT_LEVELS } from "@engine/world";
import {
  addItem, BUILD_CRACK_OVERLAY, BuildFail, crackOverlayAnim, BuildPiece, buildPreviewFor, DamageCause, damagePiece, decodeStructures, defaultDefs, encodeStructures, maxHpOf,
  modularArtKeys, pieceCost, pieceVariantKey, pieceVariantKeyChain, PlayerIntent, placePiece, raidMul, RaidDamage, RaidRuleRes, rotationSteps,
  snapPlacement, spawnPlayer, structures, TRI_INRADIUS, triEdges, validatePlacement, variantKeyFor,
} from "../src/index.js";
import { makeWorld, plantClaim, steps, spawnLearned } from "./helpers.js";

const d = defaultDefs();
const id = (k: string) => d.pieceId(k);
function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return snapPlacement(w, { piece: id(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
}
function place(w: World, b: Entity, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}): Entity {
  const sn = snap(w, key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return placePiece(w, b, sn, { pay: false });
}
const intent = (w: World, p: Entity, action: number, target: Entity, tier = 0) => { w.set(p, PlayerIntent, { action, target, tier }); steps(w, 1); };

describe("modular building set (ADR-104)", () => {
  it("loads every new piece in four material tiers with art keys", () => {
    const keys = ["foundation_triangle", "foundation_stilt", "foundation_ramp", "foundation_steps", "wall_arched", "wall_fortified", "floor_stairwell",
      "floor_skylight", "floor_triangle", "wall_corner_inner", "wall_corner_outer", "wall_corner_angled", "roof_gable", "roof_corner", "roof_hip", "roof_chimney"];
    for (const k of keys) { const p = d.pieces.get(id(k))!; expect(p.tiered).toBe(true); expect(p.minTier).toBe(k.startsWith("wall_corner") ? 0 : 1); expect(p.family).not.toBe(""); }
    const art = modularArtKeys(d);
    expect(new Set(art).size).toBe(art.length);
    expect(art).toContain("wall_window@tier2"); expect(art).toContain("roof_hip@tier4"); expect(art).not.toContain("wall@tier0"); expect(art.some((k) => k.includes(".d"))).toBe(false);
  });
  it("pieceVariantKey: piece@tierN with damage suffix, and a fallback chain", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
    const f = place(w, b, "foundation", 5.5, 5.5, { tier: 2 });
    expect(pieceVariantKey(d, w.get(f, BuildPiece)!)).toBe("foundation@tier2");
    w.setField(f, BuildPiece, "damageStage", 2); expect(pieceVariantKey(d, w.get(f, BuildPiece)!)).toBe("foundation@tier2");
    expect(crackOverlayAnim(w.getField(f, BuildPiece, "damageStage")!)).toBe("stage2"); expect(crackOverlayAnim(0)).toBe(""); expect(BUILD_CRACK_OVERLAY).toBe("bld_crack");
    expect(pieceVariantKeyChain(d, w.get(f, BuildPiece)!)).toEqual(["foundation@tier2", "foundation"]);
    expect(pieceVariantKey(d, { type: id("foundation"), tier: 0 })).toBe("foundation");
    expect(variantKeyFor(d.pieces.get(id("wall_window"))!, 2)).toBe("wall_window@tier2");
  });
  it("triangle edges sit at 60/120 degrees with 12 rotation steps", () => {
    const e = triEdges(0, 0, 0); expect(e.length).toBe(3);
    for (const x of e) expect(Math.hypot(x.mx, x.my)).toBeCloseTo(TRI_INRADIUS);
    const ang = e.map((x) => Math.atan2(x.ny, x.nx));
    const diff = (a: number, b: number) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(diff(ang[0]!, ang[1]!)).toBeCloseTo((2 * Math.PI) / 3);
    const w = makeWorld(); expect(rotationSteps(w, id("foundation_triangle"))).toBe(12); expect(rotationSteps(w, id("wall_corner_angled"))).toBe(8);
  });
  it("triangle foundations snap edge-to-edge onto square foundations and onto each other", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
    place(w, b, "foundation", 5.5, 5.5);
    const s1 = snap(w, "foundation_triangle", 6.4, 5.5); if (typeof s1 === "number") throw new Error(String(s1));
    expect(s1.pos.x).toBeCloseTo(6 + TRI_INRADIUS); expect(s1.pos.y).toBeCloseTo(5.5);
    const t1 = placePiece(w, b, s1, { pay: false });
    const s2 = snap(w, "foundation_triangle", 6.6, 5.2); if (typeof s2 === "number") throw new Error(String(s2));
    expect(Math.hypot(s2.pos.x - s1.pos.x, s2.pos.y - s1.pos.y)).toBeCloseTo(2 * TRI_INRADIUS);
    const t2 = placePiece(w, b, s2, { pay: false });
    const idx = structures(w); expect(idx.triAt(s1.pos.x, s1.pos.y, 0)).toBe(t1); expect(idx.triAt(s2.pos.x, s2.pos.y, 0)).toBe(t2);
    // occupied
    const s3 = snap(w, "foundation_triangle", s1.pos.x, s1.pos.y); expect(typeof s3 === "number" || Math.hypot(s3.pos.x - s1.pos.x, s3.pos.y - s1.pos.y) > 0.1).toBe(true);
  });
  it("triangle floors need support; they collapse deterministically when it goes", () => {
    const run = () => {
      const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
      place(w, b, "foundation", 5.5, 5.5); place(w, b, "foundation", 6.5, 5.5);
      const wall = place(w, b, "wall", 7, 5.5);
      place(w, b, "floor", 6.5, 5.5, { level: 1 });
      const q = spawnLearned(w, { x: 20, y: 20 }); const lone = snap(w, "floor_triangle", 20.5, 20.5, { level: 1 }); expect(typeof lone === "number" ? lone : validatePlacement(w, q, lone)).toBe(BuildFail.NoSupport);
      const tri = place(w, b, "floor_triangle", 7.3, 5.5, { level: 1 }); steps(w, 2);
      const floor = structures(w).deck(6, 5, 1) as Entity;
      damagePiece(w, floor, 1e6); damagePiece(w, wall, 1e6); steps(w, 3);
      return [w.isAlive(tri), w.isAlive(floor)];
    };
    const a = run(); expect(a).toEqual([false, false]); expect(run()).toEqual(a);
  });
  it("corners vertex-snap and need an adjacent deck", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
    const q = spawnLearned(w, { x: 30, y: 30 }); const lone = snap(w, "wall_corner_outer", 30.2, 30.1); expect(typeof lone === "number" ? lone : validatePlacement(w, q, lone)).toBe(BuildFail.NoSupport);
    place(w, b, "foundation", 5.5, 5.5);
    const s = snap(w, "wall_corner_outer", 6.1, 5.9, { rot: 2 }); // ADR-211: the L wraps the deck (rot 2 = -x/-y)
    if (typeof s === "number") throw new Error(String(s));
    expect([s.pos.x, s.pos.y]).toEqual([6, 6]); const c = spawnLearned(w, { x: 7.5, y: 7.5 }); // ADR-211: off the L arms
    for (const k of d.tiers[1]!.cost) addItem(w, c, k.item, 100); plantClaim(w, c, 8, 8); expect(validatePlacement(w, c, s)).toBe(0);
  });
  it("new pieces reject twig and add extra recipe items per tier", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
    const s = snap(w, "foundation_triangle", 9.5, 9.5, { tier: 0 }); expect(s).toBe(BuildFail.BadTier);
    const glass = d.itemId("glass"), clay = d.itemId("clay_brick");
    expect(pieceCost(d, d.pieces.get(id("floor_skylight"))!, 1).find((c) => c.item === glass)?.count).toBe(3);
    expect(pieceCost(d, d.pieces.get(id("roof_chimney"))!, 2).find((c) => c.item === clay)?.count).toBe(4);
    const fort = d.pieces.get(id("wall_fortified"))!; const steel = d.itemId("steel_plate");
    expect(pieceCost(d, fort, 3).some((c) => c.item === steel)).toBe(false); expect(pieceCost(d, fort, 4).some((c) => c.item === steel)).toBe(true);
    const items = new Set([...d.pieces.values()].filter((p) => p.family).flatMap((p) => [1, 2, 3, 4].flatMap((t) => pieceCost(d, p, t).map((c) => c.item))));
    expect(items.size).toBeGreaterThanOrEqual(10);
  });
  it("upgrade wood -> stone -> metal -> reinforced scales hp; repair restores it", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 5, y: 5 }); plantClaim(w, p, 5, 5);
    place(w, p, "foundation", 5.5, 5.5); const wall = place(w, p, "wall_fortified", 6, 5.5);
    const fort = d.pieces.get(id("wall_fortified"))!;
    const hps = [maxHpOf(w, wall)];
    for (const t of [2, 3, 4]) { for (const c of pieceCost(d, fort, t)) addItem(w, p, c.item, c.count); intent(w, p, 11 /* IntentAction.Upgrade */, wall, t); expect(w.getField(wall, BuildPiece, "tier")).toBe(t); hps.push(maxHpOf(w, wall)); }
    expect(hps).toEqual([...hps].sort((a, b) => a - b)); expect(new Set(hps).size).toBe(4);
    w.setField(wall, BuildPiece, "hp", 10); w.setField(wall, BuildPiece, "damageStage", 3);
    for (const c of pieceCost(d, fort, 4)) addItem(w, p, c.item, c.count);
    intent(w, p, 12 /* IntentAction.Repair */, wall); expect(w.getField(wall, BuildPiece, "hp")).toBe(maxHpOf(w, wall));
  });
  it("raid multipliers scale player melee/explosive/fire damage by tier; zombies are unscaled; rule denies immune tiers", () => {
    expect(raidMul(d, 1, RaidDamage.Melee)).toBe(1); expect(raidMul(d, 4, RaidDamage.Melee)).toBeLessThan(raidMul(d, 2, RaidDamage.Melee));
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0 });
    const a = place(w, p, "foundation", 3.5, 3.5, { tier: 1 }), c = place(w, p, "foundation", 8.5, 3.5, { tier: 4 });
    const h = (e: Entity) => w.getField(e, BuildPiece, "hp")!; const a0 = h(a), c0 = h(c);
    damagePiece(w, a, 50, p, DamageCause.Combat); damagePiece(w, c, 50, p, DamageCause.Combat); steps(w, 1);
    expect(a0 - h(a)).toBe(50); expect(c0 - h(c)).toBe(Math.round(50 * raidMul(d, 4, RaidDamage.Melee)));
    const c1 = h(c); damagePiece(w, c, 50); steps(w, 1); expect(c1 - h(c)).toBe(50);
    const rule = w.getResource(RaidRuleRes)!.fn!; expect(rule(p, a)).toBe(true);
  });
  it("gameplay levelHeight matches @engine/world FLOOR_HEIGHT_LEVELS (Art: 1 floor = 48 px)", () => {
    expect(d.building.levelHeight).toBe(FLOOR_HEIGHT_LEVELS);
  });
  it("every modular key Art shipped matches assets/building/KEYS.md names", () => {
    const art = new Set(modularArtKeys(d));
    for (const k of ["foundation_triangle", "foundation_steps", "foundation_stilt", "floor_stairwell", "floor_skylight", "wall_arched", "wall_fortified",
      "wall_corner_outer", "wall_corner_inner", "wall_corner_angled", "roof_gable", "roof_chimney", "pillar", "roof_flat", "roof_slope", "wall_low"])
      for (const t of [1, 2, 3, 4]) expect(art.has(`${k}@tier${t}`)).toBe(true);
  });
  it("persists triangle positions exactly (STRC v4) and new fields round-trip", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 0, y: 0 });
    place(w, b, "foundation", 5.5, 5.5, { tier: 3 }); const t = place(w, b, "foundation_triangle", 6.4, 5.5, { tier: 2 });
    const cs = place(w, b, "wall_corner_angled", 5.1, 5.9, { rot: 3, tier: 4 }); void cs;
    const tp = structures(w).slotOf(t)!;
    const blob = encodeStructures(w, 0, 0);
    const w2 = makeWorld(); const r = decodeStructures(w2, blob);
    expect(r.pieces.length).toBe(3);
    const t2 = structures(w2).triAt(tp.fx!, tp.fy!, 0) as Entity; expect(t2).toBeTruthy();
    expect(w2.get(t2, BuildPiece)).toMatchObject({ tier: 2, rot: tp.rot });
    expect(encodeStructures(w2, 0, 0)).toEqual(blob);
  });
  it("touch snap assist moves an invalid aim to a nearby valid snap", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 5.5, y: 5.5 }); plantClaim(w, p, 5, 8);
    for (const x of [6.5, 7.5, 8.5]) place(w, p, "foundation", x, 5.5); for (const k of d.tiers[1]!.cost) addItem(w, p, k.item, 100);
    const sel = { piece: id("wall"), tier: 1, variant: 0, paint: 0 };
    const off = buildPreviewFor(w, p, sel, 0, { mode: 1, x: 7.5, y: 4.4 }, 0, false)!;
    const on = buildPreviewFor(w, p, sel, 0, { mode: 1, x: 7.5, y: 4.4 }, 0, true)!;
    if (!off.valid) { expect(on.valid).toBe(true); expect(on.assisted).toBe(true); } else expect(on.assisted).toBeUndefined();
  });
});
