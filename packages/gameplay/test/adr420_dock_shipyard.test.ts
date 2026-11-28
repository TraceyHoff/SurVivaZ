/**
 * ADR-420: Dock (tier 1) + Shipyard (tier 2) — buildable structures placed in DEEP WATER.
 * Dock crafts raft/canoe/rowboat kits, Shipyard crafts Motorboat/pontoon/Speedboat kits (the boat
 * recipes bind to these stations in later slices; the station keys are reserved here). Placement is
 * the inverted water rule: deep water required under every footprint tile (new BuildFail
 * NeedsDeepWater = 35), land and shallow shore rejected; slot.z is pinned to the water surface (0);
 * water pieces are claim-exempt (water has no Claim Flag) and public. Tier 1/2 here is structure
 * progression, not tiers.json material tiers: the shipyard is standalone (no dock required) and is
 * gated by its material chain (iron/steel via furnace + anvil), with skill nodes dock_craft (requires workbench_craft) and shipyard_craft (requires anvil_craft) added in ADR-426 — ADR-221 requires every station piece to have exactly one unlock node.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { TileMap, WATER_TILE } from "@engine/world";
import ids from "../data/ids.lock.json";
import stations from "../data/stations.json";
import * as G from "../src/index.js";
import { DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, DefsError, loadDefs, type RawDefs } from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;
const clone = (): RawDefs => JSON.parse(JSON.stringify(DEFAULT_RAW_DEFS)) as RawDefs;

/** Land tile 3 everywhere, with a lake (deep interior, shallow rim) for the water tests. */
function lakeWorld(): { w: World; map: TileMap } {
  const w = makeWorld();
  const map = new TileMap();
  for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 0); }
  for (let y = 10; y <= 29; y++) for (let x = 10; x <= 29; x++) map.setTile(x, y, WATER_TILE);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  return { w, map };
}
const give = (w: World, e: Entity, key: string, n = 1): void => { for (const c of G.pieceCost(d, piece(key), piece(key).fixedTier)) G.addItem(w, e, c.item, c.count * n); };
const place = (w: World, e: Entity, key: string, x: number, y: number, level = 0): G.PlaceResult => {
  give(w, e, key); const def = piece(key);
  return G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level, rot: 0, tier: def.fixedTier, variant: 0 });
};
const fakeRecipe = (station: number): G.RecipeDef => ({ id: 0, key: "fake_boat_kit", station, seconds: 5, ingredients: [], output: { item: 0, count: 1 }, skill: null });

describe("ADR-420 dock + shipyard: data", () => {
  it("adds two pieces (198 total) with the fixed ids, stations, footprints and deep-water rule", () => {
    expect(d.pieces.size).toBe(224); // ADR-590: +26 electricity pieces appended after the shipyard
    expect((ids.pieces as Record<string, number>).dock).toBe(197);
    expect((ids.pieces as Record<string, number>).shipyard).toBe(198);
    expect((stations as { stations: Record<string, number> }).stations).toMatchObject({ dock: 6, shipyard: 7 });
    expect(G.StationKind.Dock).toBe(6); expect(G.StationKind.Shipyard).toBe(7);
    const dock = piece("dock"), yard = piece("shipyard");
    for (const [def, station, hp, tier, w, h] of [[dock, G.StationKind.Dock, 400, 1, 3, 2], [yard, G.StationKind.Shipyard, 900, 2, 4, 3]] as const) {
      expect(def.placement).toBe(G.Placement.Free); expect(def.layer).toBe(2);
      expect(def.station).toBe(station); expect(def.hp).toBe(hp); expect(def.fixedTier).toBe(tier);
      expect(def.footprint).toEqual({ w, h }); expect(def.ground).toBe(true);
      expect(def.requiresWater).toBe("deep"); expect(def.category).toBe("crafting"); expect(def.paintable).toBe(true);
      expect(G.pieceGates(d, def, def.fixedTier)).toEqual([`piece:${def.key}`]); // own token, defined by the ADR-426 skill node: buildable once learned and the materials exist
      expect(G.UNLOCK_NODE.has(`piece:${def.key}`)).toBe(true); // ADR-426: every station piece needs exactly one unlock node (ADR-221)
      for (const c of G.pieceCost(d, def, def.fixedTier)) expect(d.items.has(c.item)).toBe(true);
    }
    expect(G.pieceCost(d, dock, 1).map((c) => d.items.get(c.item)!.key)).toEqual(["wood", "planks", "rope"]);
    expect(G.pieceCost(d, yard, 2).map((c) => d.items.get(c.item)!.key)).toEqual(["iron_ingot", "steel_plate", "hardwood_planks", "planks"]);
    expect(G.stationToken(G.StationKind.Dock)).toBe("piece:dock");
    expect(G.stationToken(G.StationKind.Shipyard)).toBe("piece:shipyard");
    expect(G.STATION_NAMES[G.StationKind.Dock]).toBe("Dock");
    expect(G.STATION_NAMES[G.StationKind.Shipyard]).toBe("Shipyard");
  });
  it("water pieces are claim-exempt (needsClaim false) while land stations still need a claim", () => {
    expect(G.needsClaim(piece("dock"))).toBe(false);
    expect(G.needsClaim(piece("shipyard"))).toBe(false);
    expect(G.needsClaim(piece("workbench"))).toBe(true);
  });
  it("loadDefs rejects requiresWater on a non-free piece, without ground, and with a bad value", () => {
    const badPlacement = clone(); badPlacement.pieces.pieces.find((p) => p.key === "dock")!.placement = "cell";
    expect(() => loadDefs(badPlacement, { lock: DEFAULT_ID_LOCK })).toThrowError(DefsError);
    try { loadDefs(badPlacement, { lock: DEFAULT_ID_LOCK }); expect.unreachable(); } catch (e) { expect((e as DefsError).issues.join("\n")).toMatch(/requiresWater needs placement "free"/); }
    const badGround = clone(); badGround.pieces.pieces.find((p) => p.key === "dock")!.ground = false;
    try { loadDefs(badGround, { lock: DEFAULT_ID_LOCK }); expect.unreachable(); } catch (e) { expect((e as DefsError).issues.join("\n")).toMatch(/requiresWater needs ground true/); }
    const badValue = clone(); (badValue.pieces.pieces.find((p) => p.key === "dock") as { requiresWater?: string }).requiresWater = "shallow";
    try { loadDefs(badValue, { lock: DEFAULT_ID_LOCK }); expect.unreachable(); } catch (e) { expect((e as DefsError).issues.join("\n")).toMatch(/requiresWater must be "deep" or "any"/); }
  });
});

describe("ADR-420 dock + shipyard: placement", () => {
  it("dock places on deep water with no claim, pinned to the water surface (z 0)", () => {
    const { w } = lakeWorld(); const p = spawnLearned(w, { x: 20.5, y: 20.5, maxWeight: 0, clientId: 1 });
    const r = place(w, p, "dock", 20.5, 20.5);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(w.get(r.piece, Transform)).toMatchObject({ x: 20.5, y: 20.5, z: 0 });
    expect(w.get(r.piece, G.CraftingStation)).toMatchObject({ kind: G.StationKind.Dock });
  });
  it("a level-2 request still pins the dock to the water surface", () => {
    const { w } = lakeWorld(); const p = spawnLearned(w, { x: 20.5, y: 20.5, maxWeight: 0, clientId: 1 });
    const r = place(w, p, "dock", 20.5, 20.5, 2);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(w.get(r.piece, Transform)?.z).toBe(0);
  });
  it("dock and shipyard are rejected on land and on shallow shore with NeedsDeepWater (35)", () => {
    const { w } = lakeWorld();
    const land = spawnLearned(w, { x: 5.5, y: 5.5, maxWeight: 0, clientId: 1 });
    for (const key of ["dock", "shipyard"]) {
      expect(place(w, land, key, 5.5, 5.5)).toEqual({ ok: false, reason: G.BuildFail.NeedsDeepWater });
    }
    expect(G.BuildFail.NeedsDeepWater).toBe(35);
    const shore = spawnLearned(w, { x: 11.5, y: 11.5, maxWeight: 0, clientId: 1 });
    expect(place(w, shore, "dock", 11.5, 11.5)).toEqual({ ok: false, reason: G.BuildFail.NeedsDeepWater });
  });
  it("shipyard places on deep water; a land station is still refused deep water with Terrain", () => {
    const { w } = lakeWorld(); const p = spawnLearned(w, { x: 24.5, y: 24.5, maxWeight: 0, clientId: 1 });
    expect(place(w, p, "shipyard", 24.5, 24.5).ok).toBe(true);
    const deep = spawnLearned(w, { x: 20.5, y: 20.5, maxWeight: 0, clientId: 1 });
    expect(place(w, deep, "workbench", 20.5, 20.5)).toEqual({ ok: false, reason: G.BuildFail.Terrain });
  });
});

describe("ADR-420 dock + shipyard: stations", () => {
  it("recipes resolve only at the right water station, in range; out of range they fail", () => {
    const { w } = lakeWorld(); const p = spawnLearned(w, { x: 20.5, y: 20.5, maxWeight: 0, clientId: 1 });
    expect(G.stationInRange(w, p, G.StationKind.Dock)).toBe(false);
    expect(G.recipeStationOk(w, p, fakeRecipe(G.StationKind.Dock))).toBe(false);
    expect(place(w, p, "dock", 20.5, 20.5).ok).toBe(true);
    expect(G.stationInRange(w, p, G.StationKind.Dock)).toBe(true);
    expect(G.recipeStationOk(w, p, fakeRecipe(G.StationKind.Dock))).toBe(true);
    expect(G.recipeStationOk(w, p, fakeRecipe(G.StationKind.Shipyard))).toBe(false); // a dock is not a shipyard
    expect(G.stationUnlocked(w, p, G.StationKind.Dock)).toBe(true);
    // Standing on the shipyard (4+ tiles away) is out of the dock's 2.5-tile station range.
    w.set(p, Transform, { x: 24.5, y: 24.5 });
    expect(place(w, p, "shipyard", 24.5, 24.5).ok).toBe(true);
    expect(G.stationInRange(w, p, G.StationKind.Shipyard)).toBe(true);
    expect(G.stationInRange(w, p, G.StationKind.Dock)).toBe(false);
    expect(G.recipeStationOk(w, p, fakeRecipe(G.StationKind.Shipyard))).toBe(true);
  });
});

describe("ADR-420 dock + shipyard: AI planner", () => {
  /** Lake beside the base so the STATION_SLOTS water probes land on deep water. */
  function botWorld(): { w: World; p: Entity; base: { x: number; y: number } } {
    const w = makeWorld();
    const map = new TileMap();
    for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 0); }
    for (let y = 7; y <= 17; y++) for (let x = 12; x <= 22; x++) map.setTile(x, y, WATER_TILE);
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    const base = { x: 10, y: 10 };
    const p = spawnLearned(w, { x: base.x + 1, y: base.y + 3.3, maxWeight: 0, clientId: 1 });
    plantClaim(w, p, base.x - 2, base.y - 2);
    return { w, p, base };
  }
  /** Snooze every ladder goal before `key` so makePlan reaches the water goal directly. */
  const snoozeBefore = (key: string): Record<string, number> => {
    const out: Record<string, number> = {}; const name = (g: (typeof G.GOAL_LADDER)[number]): string =>
      g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k;
    for (const g of G.GOAL_LADDER) { if (g.k === "piece" && g.key === key) break; out[name(g)] = 1e9; }
    return out;
  };
  it("the ladder lists dock then shipyard after the anvil, with water-probe slots and station wiring", () => {
    const ix = G.plannerIndex(d);
    expect(ix.station.get(G.StationKind.Dock)?.key).toBe("dock");
    expect(ix.station.get(G.StationKind.Shipyard)?.key).toBe("shipyard");
    const dockAt = G.GOAL_LADDER.findIndex((g) => g.k === "piece" && g.key === "dock");
    const yardAt = G.GOAL_LADDER.findIndex((g) => g.k === "piece" && g.key === "shipyard");
    const anvilAt = G.GOAL_LADDER.findIndex((g) => g.k === "piece" && g.key === "anvil");
    expect(dockAt).toBeGreaterThan(anvilAt); expect(yardAt).toBe(dockAt + 1);
    expect(G.STATION_SLOTS.dock?.length).toBeGreaterThan(0);
    expect(G.STATION_SLOTS.shipyard?.length).toBeGreaterThan(0);
  });
  it("a bot with dock materials plans a dock build on the deep-water probe — and can place it there", () => {
    const { w, p, base } = botWorld(); give(w, p, "dock"); G.addItem(w, p, d.itemId("wood"), G.WOOD_RESERVE + 8); // the planner reserves WOOD_RESERVE wood for the fire
    const pl = G.makePlan({ world: w, self: p, defs: d, base, bs: G.scanBase(w, d, base), fails: {}, snooze: snoozeBefore("dock") });
    expect(pl.goal).toBe("dock"); expect(pl.step?.k).toBe("build");
    if (pl.step?.k !== "build") return;
    expect(pl.step.piece).toBe(d.pieceId("dock"));
    w.set(p, Transform, { x: pl.step.stand.x, y: pl.step.stand.y });
    expect(G.tryPlace(w, p, { piece: pl.step.piece, x: pl.step.x, y: pl.step.y, level: pl.step.level, rot: 0, tier: 0, variant: 0 }).ok).toBe(true);
  });
  it("a bot with shipyard materials plans a shipyard build on its deep-water probe", () => {
    const { w, p, base } = botWorld(); give(w, p, "shipyard");
    const pl = G.makePlan({ world: w, self: p, defs: d, base, bs: G.scanBase(w, d, base), fails: {}, snooze: snoozeBefore("shipyard") });
    expect(pl.goal).toBe("shipyard"); expect(pl.step?.k).toBe("build");
    if (pl.step?.k !== "build") return;
    expect(pl.step.piece).toBe(d.pieceId("shipyard"));
    w.set(p, Transform, { x: pl.step.stand.x, y: pl.step.stand.y });
    expect(G.tryPlace(w, p, { piece: pl.step.piece, x: pl.step.x, y: pl.step.y, level: pl.step.level, rot: 0, tier: 0, variant: 0 }).ok).toBe(true);
  });
  it("with no deep water near the base the water goals block without holding the ladder", () => {
    const w = makeWorld(); const base = { x: 10, y: 10 };
    // All-land terrain (no lake): the probes ghost-fail with NeedsDeepWater.
    const map = new TileMap();
    for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 0); }
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    const p = spawnLearned(w, { x: base.x + 1, y: base.y + 3.3, maxWeight: 0, clientId: 1 });
    plantClaim(w, p, base.x - 2, base.y - 2);
    give(w, p, "dock"); G.addItem(w, p, d.itemId("wood"), G.WOOD_RESERVE + 8); give(w, p, "shipyard");
    const pl = G.makePlan({ world: w, self: p, defs: d, base, bs: G.scanBase(w, d, base), fails: {}, snooze: snoozeBefore("dock") });
    expect(pl.goal).not.toBe("dock"); // no water in the probes: stuck, not held — the ladder moves on
    expect(pl.blocked).toContain("dock");
  });
  it("without any terrain installed the dock fails closed with NeedsDeepWater", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 20.5, y: 20.5, maxWeight: 0, clientId: 1 });
    expect(G.tryPlace(w, p, { piece: d.pieceId("dock"), x: 20.5, y: 20.5, level: 0, rot: 0, tier: 1, variant: 0 })).toEqual({ ok: false, reason: G.BuildFail.NeedsDeepWater });
  });
});
