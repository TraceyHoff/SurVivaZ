/**
 * ADR-426: full-gate fix-ups for ADR-419–425. The slice gates ran only their own suites; the full
 * gate caught six regressions the slices missed, all fixed here (no slice behaviour changed):
 *  - adr125: boats tripped the "motor vehicles are 2.5-6x sprint" rule (a raft is 0.47x sprint).
 *    Boats are watercraft, tuned against swim speed, not sprint.
 *  - adr221: dock/shipyard are station pieces with no unlock node. ADR-221 requires exactly one
 *    unlock node per station piece; dock_craft (requires workbench_craft) and shipyard_craft
 *    (requires anvil_craft) were added to skills.json. Bots learn them via the planner's `locked`
 *    hold + skill_pick's x4 unlock boost — no planner change needed.
 *  - adr398: the "last 3 pieces are the roof trio" pin went stale when dock/shipyard appended.
 *  - station_crafting (ADR-136): the known-station list was a hardcoded [0..5]; dock 6 + shipyard 7
 *    were untagged. The list is now derived from STATION_NAMES.
 *  - adr229: dock/shipyard had no build-window icons (atlas + stylesheet). Static entries point at
 *    items_build frames 302/303 — the last two free cells — and the runtime painter
 *    (installTask420MenuIcons) already overrides them with painted data URLs, the store pattern.
 *  - adr387: the guide-icon pin (65) missed the two new dock/shipyard cost rows (67).
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { TileMap, WATER_TILE } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";
import { spawnPlayer } from "../src/index.js";

const d = G.defaultDefs();
const node = (k: string): number => G.skillNodeIndex(k);
/** Learn a node and its prerequisites first (unlockSkill rejects an unmet chain). */
const learn = (w: World, p: Entity, key: string): void => {
  const n = node(key);
  for (const r of G.SKILLS.nodes[n]!.requires) learn(w, p, r);
  G.grantTreePoints(w, p, G.TREE_KEYS[G.SKILL_NODE_TREE[n]!]!, G.skillNode(n)!.cost);
  expect(G.unlockSkill(w, p, n)).toBeUndefined();
};

/** Land tile 3 everywhere, with a lake (deep interior) — same shape as adr420. */
function lakeWorld(): { w: World; map: TileMap } {
  const w = makeWorld();
  const map = new TileMap();
  for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 0); }
  for (let y = 10; y <= 29; y++) for (let x = 10; x <= 29; x++) map.setTile(x, y, WATER_TILE);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  return { w, map };
}
const give = (w: World, e: Entity, key: string): void => { const def = d.pieces.get(d.pieceId(key))!; for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const place = (w: World, e: Entity, key: string, x: number, y: number): G.PlaceResult => {
  give(w, e, key); const def = d.pieces.get(d.pieceId(key))!;
  return G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
};

describe("ADR-426 full-gate fix-ups", () => {
  it("dock + shipyard have exactly one unlock node each, chained off the crafting column", () => {
    expect(G.UNLOCK_NODE.has("piece:dock")).toBe(true);
    expect(G.UNLOCK_NODE.has("piece:shipyard")).toBe(true);
    const unlockers = (tok: string): string[] => G.SKILLS.nodes.filter((n) => n.effects.unlock?.includes(tok)).map((n) => n.key);
    expect(unlockers("piece:dock")).toEqual(["dock_craft"]);
    expect(unlockers("piece:shipyard")).toEqual(["shipyard_craft"]);
    const dock = G.SKILLS.nodes[node("dock_craft")]!;
    expect(dock.branch).toBe("crafting"); expect(dock.effects.unlock).toEqual(["piece:dock"]);
    expect(dock.requires).toEqual(["workbench_craft"]);
    const yard = G.SKILLS.nodes[node("shipyard_craft")]!;
    expect(yard.branch).toBe("crafting"); expect(yard.effects.unlock).toEqual(["piece:shipyard"]);
    expect(yard.requires).toEqual(["anvil_craft"]);
  });
  it("a fresh player is SkillLocked out of deep-water placement; learning the node opens it", () => {
    for (const [key, nodeKey, x, y] of [["dock", "dock_craft", 20.5, 20.5], ["shipyard", "shipyard_craft", 24.5, 24.5]] as const) {
      // one world per case: two players standing on the same footprint would Block each other
      const { w } = lakeWorld();
      const fresh = spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 });
      expect(place(w, fresh, key, x, y)).toEqual({ ok: false, reason: G.BuildFail.SkillLocked });
      const { w: w2 } = lakeWorld();
      const learned = spawnLearned(w2, { x, y, maxWeight: 0, clientId: 2 });
      expect(place(w2, learned, key, x, y).ok).toBe(true);
      const { w: w3 } = lakeWorld();
      const p3 = spawnPlayer(w3, { x, y, maxWeight: 0, clientId: 3 });
      learn(w3, p3, nodeKey);
      expect(place(w3, p3, key, x, y).ok).toBe(true);
    }
  });
});
