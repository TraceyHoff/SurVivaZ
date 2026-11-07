import { describe, expect, it } from "vitest";
import { DEFAULT_TICK_HZ, NetId, setSeason, setTimeOfDay, Transform, Weather, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import { BitReader, BitWriter, NetSchema, captureState, decodeDelta, encodeDelta } from "../../net/src/index.js";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

function setup(): { w: World; p: number; c: number } {
  const w = makeWorld({ dayLengthTicks: 240_000 }); const map = new TileMap();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { map.setTile(x, y, 3); map.ensureChunk(0, 0).setHeight(x, y, 2); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); setSeason(w, 0, 7); setTimeOfDay(w, 12);
  w.env(Weather).kind = G.WeatherKind.Clear;
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, clientId: 1 }); w.set(p, Transform, { facing: 0 });
  const c = G.spawnCrop(w, 11.5, 10.5, G.plantableBySeed("wheat_seeds")); return { w, p, c };
}
const inspect = (w: World, p: number) => G.cropInspection(w, p)!;
describe("ADR-287 crop inspection bars", () => {
  it("reports actual growth 0 to done, preserves planted provenance at maturity and hides depleted harvests", () => {
    const { w, p, c } = setup(); expect(inspect(w, p).growth).toBe(0);
    G.water(w, 11.5, 10.5); w.set(c, G.Crop, { growth: 0.4 }); expect(inspect(w, p).growth).toBeCloseTo(0.4);
    w.set(c, G.Crop, { growth: 0.99999 }); G.cropGrowthSystem(w);
    expect(w.isAlive(c)).toBe(false); const done = inspect(w, p); expect(done.growth).toBe(1);
    expect(w.has(done.target, G.GrownPlant)).toBe(true); w.set(done.target, G.ResourceNode, { amount: 0 });
    expect(G.cropInspection(w, p)).toBeUndefined();
  });
  it("replicates crop growth and both tending timers through full snapshots and maturity deltas", () => {
    const { w, c } = setup(); w.add(c, NetId, { id: 500 }); G.water(w, 11.5, 10.5); G.fertilize(w, 11.5, 10.5);
    const schema = new NetSchema(w); const before = captureState(w, schema, undefined);
    const full = new BitWriter(); encodeDelta(full, schema, before, undefined);
    const decoded = decodeDelta(new BitReader(full.finish()), schema, undefined).state;
    expect(decoded).toEqual(before); expect(decoded.get(500)!.has(schema.indexOf(G.Crop, w)!)).toBe(true);
    w.clearChanges(); w.set(c, G.Crop, { growth: 1 }); G.cropGrowthSystem(w);
    const grown = [...w.query([G.GrownPlant])][0]!; w.add(grown, NetId, { id: 501 });
    const after = captureState(w, schema, before); const delta = new BitWriter(); encodeDelta(delta, schema, after, before);
    const result = decodeDelta(new BitReader(delta.finish()), schema, decoded).state;
    expect(result).toEqual(after); expect(result.get(500)).toBeUndefined();
    expect(result.get(501)!.has(schema.indexOf(G.GrownPlant, w)!)).toBe(true);
  });
  it("only shows while close: walking away hides the same plant and returning reveals it", () => {
    const { w, p, c } = setup(); expect(inspect(w, p).target).toBe(c);
    w.set(p, Transform, { x: 8.5 }); expect(G.cropInspection(w, p)).toBeUndefined();
    w.set(p, Transform, { x: 10.5 }); expect(inspect(w, p).target).toBe(c);
    // Still facing the crop and within the facing-spot radius, but outside the explicit short proximity gate.
    w.set(p, Transform, { x: 9.7 }); expect(G.cropInspection(w, p)).toBeUndefined();
  });
  it("shows remaining water time, not two-day drought survival, and empties at dry", () => {
    const { w, p } = setup(); expect(inspect(w, p).hydration).toBe(0); G.water(w, 11.5, 10.5);
    expect(inspect(w, p).hydration).toBe(1); w.tick += G.FARMING.wateredSeconds * DEFAULT_TICK_HZ / 2;
    expect(inspect(w, p).hydration).toBeCloseTo(0.5); w.tick += G.FARMING.wateredSeconds * DEFAULT_TICK_HZ / 2;
    expect(inspect(w, p).hydration).toBe(0); expect(inspect(w, p).growth).toBe(0);
  });
  it("existing fertilizer starts a finite dose, drains, expires its growth boost, and can be reapplied", () => {
    const { w, p, c } = setup(); expect(inspect(w, p).fertilizer).toBe(0);
    expect(G.fertilize(w, 11.5, 10.5)).toBe(true); expect(inspect(w, p).fertilizer).toBe(1);
    expect(G.fertilize(w, 11.5, 10.5)).toBe(false);
    w.tick += G.FARMING.fertilizerSeconds * DEFAULT_TICK_HZ / 2; expect(inspect(w, p).fertilizer).toBeCloseTo(0.5);
    w.tick += G.FARMING.fertilizerSeconds * DEFAULT_TICK_HZ / 2; G.cropGrowthSystem(w);
    expect(inspect(w, p).fertilizer).toBe(0); expect(w.get(c, G.Crop)!.fertilized).toBe(0);
    expect(G.fertilize(w, 11.5, 10.5)).toBe(true);
  });
  it("migrates a legacy fertilized flag to one finite dose", () => {
    const { w, c } = setup(); w.set(c, G.Crop, { fertilized: 1, fertilizerUntilTick: 0 }); G.cropGrowthSystem(w);
    expect(w.get(c, G.Crop)!.fertilizerUntilTick).toBe(w.tick + G.FARMING.fertilizerSeconds * DEFAULT_TICK_HZ);
  });
  it("does not extrapolate growth in darkness or winter dormancy", () => {
    const { w, p, c } = setup(); G.water(w, 11.5, 10.5); w.set(c, G.Crop, { growth: 0.3 }); setTimeOfDay(w, 23);
    w.tick += G.CROP_EVERY; G.cropGrowthSystem(w); expect(inspect(w, p).growth).toBeCloseTo(0.3);
    w.set(c, G.Crop, { kind: G.FARMING.plantables.findIndex((v) => v.type === "tree") + 1 });
    setSeason(w, 2, 0); w.tick += G.CROP_EVERY; G.cropGrowthSystem(w); expect(inspect(w, p).growth).toBeCloseTo(0.3);
  });
  it("inspects planted saplings and bushes, but never wild flora, bare soil, or distant crops", () => {
    const { w, p, c } = setup(); w.destroy(c);
    G.spawnResourceNode(w, "wild_wheat", 11.5, 10.5); expect(G.cropInspection(w, p)).toBeUndefined();
    const soil = G.spawnCrop(w, 11.5, 10.5); expect(G.cropInspection(w, p)).toBeUndefined(); w.destroy(soil);
    for (const type of ["tree", "bush"]) {
      const kind = G.FARMING.plantables.findIndex((v) => v.type === type) + 1;
      const sap = G.spawnCrop(w, 11.5, 10.5, kind); expect(inspect(w, p).target).toBe(sap); w.destroy(sap);
    }
    G.spawnCrop(w, 25.5, 25.5, G.plantableBySeed("wheat_seeds")); expect(G.cropInspection(w, p)).toBeUndefined();
  });
});
