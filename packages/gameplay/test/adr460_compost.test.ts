/**
 * ADR-460: compost — rotten food tossed on tilled soil fertilises it, like dung. Reuses the
 * dung-fertiliser path: Use raw `rot` on a planted crop, same fertilize() call, 600 s dose
 * (same as bone fertilizer; dung is 900 s). Planted crops only — bare tilled soil (kind 0)
 * cannot be fertilised, exactly as for dung fertilizer. No crafted compost item, no new piece.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TICK_HZ, setSeason, setTimeOfDay, Transform, Weather, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);

/** Farm setup: tilled-soil wheat crop at (11.5, 10.5), player in front of it facing east. */
function farmSetup(): { w: World; p: Entity; c: Entity } {
  const w = makeWorld({ dayLengthTicks: 240_000 });
  const map = new TileMap();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { map.setTile(x, y, 3); map.ensureChunk(0, 0).setHeight(x, y, 2); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  setSeason(w, 0, 7); setTimeOfDay(w, 12);
  w.env(Weather).kind = G.WeatherKind.Clear;
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, clientId: 1 });
  w.set(p, Transform, { facing: 0 });
  const c = G.spawnCrop(w, 11.5, 10.5, G.plantableBySeed("wheat_seeds"));
  return { w, p, c };
}
/** Player holding `item` in main-hand slot 0 (the Use path farmUseSystem reads). */
function holderWith(w: World, p: Entity, item: string, n = 1): void {
  G.addItem(w, p, id(item), n);
  w.set(p, G.Equipment, { mainHandSlot: 0, mainHandItem: id(item) });
}
const useHeld = (w: World, p: Entity): void => { G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); G.farmUseSystem(w); };

describe("ADR-460 compost", () => {
  it("Use rot on a planted crop fertilises it for 600 s and consumes the rot", () => {
    const { w, p, c } = farmSetup();
    G.water(w, 11.5, 10.5);
    holderWith(w, p, "rot", 2);
    useHeld(w, p);
    const crop = w.get(c, G.Crop)!;
    expect(crop.fertilized).toBe(1);
    expect(crop.fertilizerUntilTick).toBe(w.tick + 600 * DEFAULT_TICK_HZ);
    expect(G.countItem(w, p, id("rot"))).toBe(1); // one dose used
    expect(G.growthMul(w, crop)).toBeCloseTo(1.5); // wateredMul 1.0 x fertilizerMul 1.5
  });

  it("bare tilled soil cannot be composted (planted crops only) and the rot stays", () => {
    const { w, p, c } = farmSetup();
    w.set(c, G.Crop, { kind: 0, stage: 0, growth: 0 }); // back to bare soil
    holderWith(w, p, "rot", 1);
    useHeld(w, p);
    expect(w.get(c, G.Crop)!.fertilized).toBe(0);
    expect(G.countItem(w, p, id("rot"))).toBe(1); // not consumed
  });

  it("compost lasts 600 s, dung fertilizer lasts 900 s (same strength)", () => {
    expect(G.FARMING.compostFertilizerSeconds).toBe(600);
    expect(G.FARMING.dungFertilizerSeconds).toBe(900);
    const { w, p, c } = farmSetup();
    holderWith(w, p, "dung_fertilizer", 1);
    useHeld(w, p);
    expect(w.get(c, G.Crop)!.fertilizerUntilTick).toBe(w.tick + 900 * DEFAULT_TICK_HZ);
  });
});
