import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
function setup(): { w: World; p: Entity } {
  const w = makeWorld(); installPermissions(w);
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, maxWeight: 0, clientId: 1 }); w.add(p, PlayerId, { id: 7 }).add(p, Membership, { partyId: 0, clanId: 0 });
  return { w, p };
}
const give = (w: World, p: Entity, key: string, n: number) => G.addItem(w, p, d.itemId(key), n);

describe("roads (ADR-119)", () => {
  it("data: surfaces, recipes and items load", () => {
    expect(G.ROADS.surfaces.map((s) => s.key)).toEqual(["path", "gravel", "paved"]);
    for (const k of ["gravel", "cement", "asphalt", ...G.SIGNS.map((s) => s.item)]) expect(() => d.itemId(k)).not.toThrow();
    const speeds = G.ROADS.surfaces.map((s) => s.speedMul); expect(speeds[0]! < speeds[1]! && speeds[1]! < speeds[2]!).toBe(true);
  });
  it("path needs a tool, gravel costs gravel, paved accepts cement or asphalt+crude", () => {
    const { w, p } = setup();
    expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Path)).toBe(G.RoadFail.NoTool);
    give(w, p, "stone_shovel", 1);
    expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Path)).toBe(G.RoadFail.None);
    expect(G.roadSurfaceAt(w, 10, 10)).toBe(G.RoadSurface.Path);
    expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Path)).toBe(G.RoadFail.Occupied);
    expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Gravel)).toBe(G.RoadFail.CannotAfford);
    give(w, p, "gravel", 2); expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Gravel)).toBe(G.RoadFail.None);
    expect(G.countItem(w, p, d.itemId("gravel"))).toBe(0);
    give(w, p, "asphalt", 1); give(w, p, "crude_oil", 1);
    expect(G.placeRoad(w, p, 10, 10, G.RoadSurface.Paved)).toBe(G.RoadFail.None);
    expect(G.roadSpeedMul(w, 10.5, 10.5)).toBeCloseTo(G.ROADS.surfaces[2]!.speedMul);
    expect(G.roadVehicleMul(w, 10.5, 10.5)).toBeGreaterThan(1);
    expect(G.roadSpeedMul(w, 40, 40)).toBe(1);
  });
  it("drag tool lays a 4-connected line and auto-connects edges", () => {
    const { w, p } = setup(); give(w, p, "stone_shovel", 1);
    const r = G.placeRoadLine(w, p, 8, 10, 12, 12, G.RoadSurface.Path);
    expect(r.fail).toBe(G.RoadFail.None); expect(r.laid).toBe(G.roadLine(8, 10, 12, 12).length);
    const line = G.roadLine(8, 10, 12, 12);
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i]![0] - line[i - 1]![0]) + Math.abs(line[i]![1] - line[i - 1]![1])).toBe(1);
    const mid = G.roadAt(w, line[1]![0], line[1]![1])!; expect(w.get(mid, G.Road)!.mask).not.toBe(0);
    expect(G.roadMask(w, 30, 30)).toBe(0);
    expect(G.roadLine(0, 0, 100, 0)).toHaveLength(G.ROADS.maxDragTiles);
  });
  it("owner can remove; settlements classify house / village / clan city", () => {
    const { w, p } = setup(); give(w, p, "stone_shovel", 1); G.placeRoad(w, p, 5, 5, G.RoadSurface.Path);
    expect(G.removeRoad(w, p, 5, 5)).toBe(G.RoadFail.None); steps(w, 1); expect(G.roadAt(w, 5, 5)).toBeUndefined();
    const s = G.classifySettlements([
      { x: 0, y: 0, player: 1, clan: 0 }, { x: 10, y: 0, player: 2, clan: 0 }, // village
      { x: 500, y: 500, player: 3, clan: 0 }, // house
      { x: 1000, y: 0, player: 4, clan: 9 }, { x: 1005, y: 0, player: 5, clan: 9 }, // clan city
    ]);
    const kinds = s.map((x) => x.kind).sort();
    expect(kinds).toEqual([G.SettlementKind.House, G.SettlementKind.Village, G.SettlementKind.ClanCity].sort());
    expect(G.settlementNear(s, 501, 500)?.kind).toBe(G.SettlementKind.House);
  });
});

describe("signs (ADR-120)", () => {
  it("sanitizes, length-limits and masks profanity", () => {
    expect(G.sanitizeSignText("  Hello\n\tworld  ")).toBe("Hello world");
    expect(G.sanitizeSignText("x".repeat(100)).length).toBeLessThanOrEqual(G.SIGN_TEXT_MAX);
    expect(G.sanitizeSignText("abcdefghijklmnopqrstuvwxyz", 20)).toHaveLength(20);
    expect(G.maskProfanity("what the fuck")).toBe("what the ****");
    expect(G.maskProfanity("sh1t road")).toBe("**** road");
    expect(G.maskProfanity("Scunthorpe classic grassland")).toBe("Scunthorpe classic grassland");
  });
  it("place consumes the item, owner / clan may edit, others may not; remove refunds", () => {
    const { w, p } = setup(); const kind = G.signKindOf("sign_wooden_post");
    expect(G.placeSign(w, p, kind, 11, 11, 0).fail).toBe(G.SignFail.NoItem);
    give(w, p, "sign_wooden_post", 1);
    const r = G.placeSign(w, p, kind, 11, 11, 0, "Welcome to Oak Town"); expect(r.fail).toBe(G.SignFail.None);
    expect(G.countItem(w, p, d.itemId("sign_wooden_post"))).toBe(0);
    expect(G.signText(w, r.sign!)).toBe("Welcome to Oak Town");
    expect(G.setSignText(w, p, r.sign!, "Oak Town  ->  north")).toBe(G.SignFail.None); expect(G.signText(w, r.sign!)).toBe("Oak Town -> north");
    const q = G.spawnPlayer(w, { x: 11, y: 11, maxWeight: 0, clientId: 2 }); w.add(q, PlayerId, { id: 8 }).add(q, Membership, { partyId: 0, clanId: 0 });
    expect(G.canEditSign(w, q, r.sign!)).toBe(false); expect(G.setSignText(w, q, r.sign!, "lol")).toBe(G.SignFail.NotOwner);
    w.set(r.sign!, G.Sign, { clan: 3 }); w.set(q, Membership, { clanId: 3 }); expect(G.canEditSign(w, q, r.sign!)).toBe(true);
    expect(G.removeSign(w, p, r.sign!)).toBe(G.SignFail.None); expect(G.countItem(w, p, d.itemId("sign_wooden_post"))).toBe(1);
  });
});

describe("hordes (ADR-121)", () => {
  it("size: solo always smaller than clan; clan grows with members; caps hold", () => {
    for (const level of [1, 5, 20, 60]) for (const days of [0, 5, 50]) {
      const solo = G.hordeSize({ clan: false, level, daysPastGrace: days });
      const c1 = G.hordeSize({ clan: true, members: 1, level, daysPastGrace: days });
      expect(solo).toBeLessThan(c1); expect(solo).toBeLessThanOrEqual(G.HORDES.solo.cap);
      let prev = c1; for (const m of [2, 4, 8]) { const c = G.hordeSize({ clan: true, members: m, level, daysPastGrace: days }); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
      expect(G.hordeSize({ clan: true, members: 100, level, daysPastGrace: days })).toBeLessThanOrEqual(G.HORDES.clan.cap);
    }
    expect(G.hordeSize({ clan: false, level: 1 })).toBe(4); expect(G.hordeSize({ clan: true, members: 3, level: 1 })).toBe(24);
  });
  it("world rules: default on with ~3 day grace; disable stops the director", () => {
    const w = makeWorld(); expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 3, aiHumans: true, zombies: true });
    const off = makeWorld({ worldRules: { hordes: false } }); expect(G.worldRules(off).hordes).toBe(false);
    G.setWorldRules(w, { hordeGraceDays: 5 }); expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 5, aiHumans: true, zombies: true });
    expect(G.graceFor(3, 1)).toBe(6); expect(G.graceFor(3, 5)).toBe(3);
  });
  it("targets group pieces by owner; a forced horde spawns members that hunt the base", () => {
    const { w, p } = setup();
    const sn = G.snapPlacement(w, { piece: d.pieceId("foundation")!, x: 12, y: 12, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn !== "object") throw new Error("snap");
    const piece = G.placePiece(w, p, sn, { pay: false });
    expect(w.get(piece, G.PieceOwner)?.player).toBe(7);
    const t = G.hordeTargets(w); expect(t).toHaveLength(1); expect(t[0]!.kind).toBe(G.HordeKind.Solo);
    const id = G.forceHorde(w, t[0]!, 6); expect(id).toBeGreaterThan(0);
    const members = [...w.query([G.HordeMember])]; expect(members.length).toBeGreaterThan(0); expect(members.length).toBeLessThanOrEqual(6);
    const d0 = Math.min(...members.map((z) => { const zt = w.get(z, Transform)!; return Math.hypot(zt.x - 12, zt.y - 12); }));
    expect(d0).toBeGreaterThanOrEqual(G.HORDES.spawnRingMin - 4);
    expect(w.get(w.environment, G.HordeStatus)!.phase).toBe(G.HordePhase.Active);
  });
});
