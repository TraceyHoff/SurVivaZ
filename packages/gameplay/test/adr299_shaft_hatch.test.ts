import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

function setup(hole = -8, extra?: (w: ReturnType<typeof makeWorld>) => void) {
  const w = makeWorld({ role: "server" }); const map = new TileMap();
  for (let y = -4; y < 5; y++) for (let x = -4; x < 5; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  if (hole) G.setTerrainDig(w, 1, 0, hole);
  extra?.(w);
  const p = G.spawnPlayer(w, { x: .9, y: .5, maxWeight: 0 });
  return { w, p };
}
function placeHatch(w: ReturnType<typeof makeWorld>, p: number, tier = 1, x = 1.5, y = .5) {
  const d = G.gameplayDefs(w);
  const sn = G.snapPlacement(w, { piece: d.pieceId("shaft_hatch"), x, y, rot: 0, level: 0, tier, variant: 0 });
  if (typeof sn === "number") return { ok: false as const, fail: sn, hatch: 0 as const };
  const fail = G.validatePlacement(w, p, sn, { ignoreCost: true });
  if (fail) return { ok: false as const, fail, hatch: 0 as const };
  return { ok: true as const, fail: 0 as const, hatch: G.placePiece(w, p, sn, { pay: false }) };
}
const towardHole = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
const towardSurface = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

describe("ADR-299 shaft hatch", () => {
  it("is a starter piece available in every material tier", () => {
    const { w, p } = setup();
    const d = G.gameplayDefs(w);
    const def = d.pieces.get(d.pieceId("shaft_hatch"))!;
    expect(def.starter).toBe(true);
    expect(def.tiered).toBe(true);
    expect(def.features.shaftHatch).toBe(true);
    expect(G.pieceUnlocked(w, p, def, 1)).toBe(true);
    expect(G.pieceGates(d, def, 4)).toEqual([]);
    for (const tier of [1, 2, 3, 4]) {
      const r = placeHatch(w, p, tier);
      expect(r.ok, `tier ${tier} fail=${r.fail}`).toBe(true);
      if (r.ok) G.destroyPiece(w, r.hatch, G.DestroyCause.Demolish);
    }
  });

  it("rejects flat ground or an uneven rim, and accepts a dug hole with level sides", () => {
    const flat = setup(0);
    expect(placeHatch(flat.w, flat.p).fail).toBe(G.BuildFail.NoShaft);
    const uneven = setup(-8, (world) => { world.resource(G.TerrainRes).setRawHeight!(2, 0, 3); });
    expect(placeHatch(uneven.w, uneven.p).fail).toBe(G.BuildFail.NoShaft);
    const hole = setup(-8);
    const r = placeHatch(hole.w, hole.p);
    expect(r.ok, `fail=${r.fail}`).toBe(true);
    expect(hole.w.getResource(G.StructureIndexRes)!.hatch(1, 0)).toBe(r.hatch);
  });

  it("lets you walk onto the lid without falling, then ride to the live bottom and back", () => {
    const { w, p } = setup(-8);
    const r = placeHatch(w, p);
    expect(r.ok, `fail=${r.fail}`).toBe(true);
    const hp = w.getField(p, G.Health, "hp")!;
    G.applyMovementInput(w, p, 0, .1, towardHole);
    expect(w.get(p, Transform)!.x).toBeGreaterThan(1);
    expect(G.isInShaft(w, p)).toBe(false);
    expect(w.getField(p, G.Health, "hp")).toBe(hp);
    expect(G.useShaftHatch(w, p, r.hatch)).toBe(true);
    expect(G.isInShaft(w, p)).toBe(true);
    expect(w.getField(p, G.Health, "hp")).toBe(hp);
    expect(w.get(p, Transform)!.x).toBeCloseTo(1.5, 5);

    const terrain = w.resource(G.TerrainRes);
    terrain.setRawHeight!(1, 0, -25);
    expect(G.shaftDrop(terrain, 1, 0)).toBe(25);
    expect(G.useShaftHatch(w, p, r.hatch)).toBe(true);
    expect(G.isInShaft(w, p)).toBe(false);
    expect(G.useShaftHatch(w, p, r.hatch)).toBe(true);
    expect(G.isInShaft(w, p)).toBe(true);
    expect(w.getField(p, G.Health, "hp")).toBe(hp);
  });

  it("blocks walking out of a deep shaft until you ride back up", () => {
    const { w, p } = setup(-12);
    const r = placeHatch(w, p);
    expect(r.ok, `fail=${r.fail}`).toBe(true);
    G.useShaftHatch(w, p, r.hatch);
    expect(G.isInShaft(w, p)).toBe(true);
    G.applyMovementInput(w, p, 0, .2, towardSurface);
    expect(w.get(p, Transform)!.x).toBeGreaterThan(1);
    G.useShaftHatch(w, p, r.hatch);
    expect(G.isInShaft(w, p)).toBe(false);
    G.applyMovementInput(w, p, 0, .2, towardSurface);
    expect(w.get(p, Transform)!.x).toBeLessThan(1);
  });

  it("entering the hatch tile from a connected pit stays at the bottom", () => {
    const { w, p } = setup(-8);
    const r = placeHatch(w, p);
    expect(r.ok, `fail=${r.fail}`).toBe(true);
    G.setTerrainDig(w, 2, 0, -8);
    w.set(p, Transform, { x: 2.4, y: .5 });
    G.applyMovementInput(w, p, 0, .2, towardSurface);
    expect(Math.floor(w.get(p, Transform)!.x)).toBe(1);
    expect(G.isInShaft(w, p)).toBe(true);
    expect(w.getField(p, G.Health, "hp")).toBeGreaterThan(0);
  });

  it("Interact/toggle-door on the hatch rides it", () => {
    const { w, p } = setup(-6);
    const r = placeHatch(w, p);
    expect(r.ok, `fail=${r.fail}`).toBe(true);
    w.set(p, Transform, { x: 1.5, y: .5 });
    w.set(p, G.PlayerIntent, { action: G.IntentAction.ToggleDoor, target: r.hatch });
    steps(w, 1);
    expect(G.isInShaft(w, p)).toBe(true);
    w.set(p, G.PlayerIntent, { action: G.IntentAction.ToggleDoor, target: r.hatch });
    steps(w, 1);
    expect(G.isInShaft(w, p)).toBe(false);
  });
});
