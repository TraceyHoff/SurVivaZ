import { describe, it, expect } from "vitest";
import { BuildingGrid, BuildingChangeKind, loadBuildPieces, encodeChunk, decodeChunk, Chunk, FLOOR_HEIGHT_LEVELS, floorToTerrainZ, terrainZToFloor, worldToScreen, DEFAULT_ISO } from "../src/index.js";

describe("piece state", () => {
  it("setState records changes and round-trips through the chunk codec (v1-compatible)", () => {
    const { registry } = loadBuildPieces([{ key: "door", layer: 1, hp: 50 }]); const g = new BuildingGrid(registry);
    const id = g.place(registry.byKey("door").id, 3, 4, 1, 3); g.buildingChanges();
    expect(g.get(id)!.state).toBe(0); g.setState(id, 1); g.setState(id, 1);
    expect(g.buildingChanges().map((c) => [c.kind, c.state])).toEqual([[BuildingChangeKind.State, 1]]);
    expect(() => g.setState(id, 64)).toThrow(); expect(g.setState(999, 1)).toBe(false);
    const g2 = new BuildingGrid(registry); const d = decodeChunk(encodeChunk(new Chunk(0, 0), { buildings: g }), { buildings: g2 });
    expect(d.buildings[0]).toMatchObject({ rot: 3, state: 1 }); expect([...g2.anchoredIn("0,0")][0]).toMatchObject({ rot: 3, state: 1, z: 1 });
  });
});
describe("height convention", () => {
  it("1 floor = 5 terrain levels = 80 px (ADR-511; 3 levels / 48 px before Art's 80 px set)", () => {
    expect(FLOOR_HEIGHT_LEVELS).toBe(5); expect(floorToTerrainZ(2, 1)).toBe(11); expect(terrainZToFloor(11, 1)).toBe(2); expect(terrainZToFloor(4.99)).toBe(0); expect(terrainZToFloor(5)).toBe(1);
    expect(worldToScreen(0, 0, 0).sy - worldToScreen(0, 0, floorToTerrainZ(1)).sy).toBe(80); expect(DEFAULT_ISO.zStep * FLOOR_HEIGHT_LEVELS).toBe(80);
  });
});
