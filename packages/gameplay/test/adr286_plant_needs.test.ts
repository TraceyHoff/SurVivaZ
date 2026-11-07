// ADR-286: plants need soil + water + light; night pause unless artificially lit; rain waters only open-sky plants;
// liquid containers water plants by hand; prolonged (two-day) drought kills.
import { describe, expect, it } from "vitest";
import { setSeason, setTimeOfDay, Transform, Weather, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
const DAY = 24_000;
function field(w: World): void {
  const map = new TileMap();
  for (let y = -16; y <= 63; y++) for (let x = -16; x <= 63; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 2); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
}
const kind = G.FARMING.plantables.findIndex((p) => p.type === "crop") + 1;
function setup(hour = 12): World {
  const w = makeWorld({ dayLengthTicks: DAY }); field(w); setSeason(w, 0, 7); setTimeOfDay(w, hour);
  w.env(Weather).kind = G.WeatherKind.Clear; return w;
}
const growth = (w: World, e: Entity): number => w.get(e, G.Crop)?.growth ?? -1;
const run = (w: World, n: number): void => { for (let i = 0; i < n; i++) { w.tick += G.CROP_EVERY; G.invalidateLightGrid(w); G.cropGrowthSystem(w); } };
const wet = (w: World, e: Entity): void => { w.set(e, G.Crop, { waterUntilTick: w.tick + 10 * DAY }); };

describe("ADR-286 plant needs", () => {
  it("soil is required to plant; once planted, growth needs only water + light (dry plant in sun does not grow)", () => {
    const w = setup(); const watered = G.spawnCrop(w, 10.5, 10.5, kind), dry = G.spawnCrop(w, 20.5, 10.5, kind); wet(w, watered);
    run(w, 3);
    expect(growth(w, watered)).toBeGreaterThan(0); expect(growth(w, dry)).toBe(0);
    expect(G.plantNeed(w, dry)).toBe("water"); expect(G.plantNeed(w, watered)).toBe("growing");
    // soil is a planting requirement only: a crop seed cannot be planted without tilled soil
    const p = G.spawnPlayer(w, { x: 40.5, y: 40.5, clientId: 1 });
    expect(G.plant(w, p, G.FARMING.plantables[kind - 1]!.seed, 41.5, 40.5, true)).not.toBe(G.FarmFail.None);
  });
  it("pauses at night without artificial light; keeps growing at night beside a lit campfire", () => {
    const w = setup(23); expect(G.isSunUp(w)).toBe(false);
    const dark = G.spawnCrop(w, 10.5, 10.5, kind), lit = G.spawnCrop(w, 30.5, 30.5, kind); wet(w, dark); wet(w, lit);
    G.spawnStation(w, G.StationKind.Campfire, 31.5, 30.5, { burnSeconds: 100_000 }); G.invalidateLightGrid(w);
    run(w, 3);
    expect(growth(w, dark)).toBe(0); expect(G.plantNeed(w, dark)).toBe("dark");
    expect(growth(w, lit)).toBeGreaterThan(0);
    setTimeOfDay(w, 12); run(w, 2); expect(growth(w, dark)).toBeGreaterThan(0); // resumes at sunrise
  });
  it("underground: grows only lit by a light structure, day or night", () => {
    const w = setup(12); G.setTerrainDig(w, 30, 30, -4); G.setTerrainDig(w, 50, 50, -4);
    const lit = G.spawnCrop(w, 30.5, 30.5, kind), dark = G.spawnCrop(w, 50.5, 50.5, kind); wet(w, lit); wet(w, dark);
    G.spawnStation(w, G.StationKind.Campfire, 31.5, 30.5, { burnSeconds: 100_000 });
    run(w, 3); expect(growth(w, dark)).toBe(0); expect(growth(w, lit)).toBeGreaterThan(0);
    setTimeOfDay(w, 23); const g = growth(w, lit); run(w, 2); expect(growth(w, lit)).toBeGreaterThan(g);
  });
  it("rain waters open-sky plants but never underground ones", () => {
    const w = setup(12); G.setTerrainDig(w, 30, 30, -4);
    const surf = G.spawnCrop(w, 10.5, 10.5, kind), under = G.spawnCrop(w, 30.5, 30.5, kind);
    G.spawnStation(w, G.StationKind.Campfire, 31.5, 30.5, { burnSeconds: 100_000 });
    w.env(Weather).kind = G.WeatherKind.Rain; run(w, 3);
    expect(w.get(surf, G.Crop)!.waterUntilTick).toBeGreaterThan(w.tick); expect(growth(w, surf)).toBeGreaterThan(0);
    expect(w.get(under, G.Crop)!.waterUntilTick).toBeLessThanOrEqual(w.tick); expect(growth(w, under)).toBe(0);
    expect(G.plantNeed(w, under)).toBe("water");
  });
  it("a waterskin waters an underground plant (one sip) and resets the drought clock", () => {
    const w = setup(12); G.setTerrainDig(w, 30, 30, -4);
    const under = G.spawnCrop(w, 30.5, 30.5, kind); // unlit: never matures, so only the drought clock matters
    run(w, Math.ceil(1.5 * DAY / G.CROP_EVERY)); expect(w.get(under, G.Crop)!.kind).toBe(kind); // 1.5 dry days: alive
    const p = G.spawnPlayer(w, { x: 29.5, y: 30.5, clientId: 1 }); w.set(p, Transform, { facing: 0 });
    const skin = d.itemId("waterskin"); G.addItem(w, p, skin, 1); let slot = 0; while (G.slotItem(w, p, slot).item !== skin) slot++;
    G.readSlots(w, p); const before = G.readSlots(w, p).durability(slot); expect(before).toBeGreaterThan(0);
    w.set(p, G.Equipment, { mainHandSlot: slot, mainHandItem: skin });
    expect(G.farmPrompt(w, p)?.label).toMatch(/^Water plant/);
    expect(G.waterFromContainer(w, p, slot)).toBe(1);
    expect(G.readSlots(w, p).durability(slot)).toBe(before - 1);
    expect(w.get(under, G.Crop)!.waterUntilTick).toBeGreaterThan(w.tick);
    run(w, Math.ceil(1.2 * DAY / G.CROP_EVERY)); expect(w.get(under, G.Crop)!.kind).toBe(kind); // clock was reset
    expect(G.plantNeed(w, under)).toBe("water"); // the sip wore off, but the plant is alive
  });
  it("dies only after about two full dry days (a dry night / rainless day is fine)", () => {
    const w = setup(12); const c = G.spawnCrop(w, 10.5, 10.5, kind);
    const sap = G.FARMING.plantables.findIndex((p) => p.type !== "crop") + 1; const tree = G.spawnCrop(w, 20.5, 20.5, sap);
    run(w, Math.ceil(1.9 * DAY / G.CROP_EVERY));
    expect(w.get(c, G.Crop)!.kind).toBe(kind); expect(w.isAlive(tree)).toBe(true);
    run(w, Math.ceil(0.2 * DAY / G.CROP_EVERY));
    expect(w.get(c, G.Crop)!.kind).toBe(0); // dead: back to bare tilled soil
    expect(w.isAlive(tree)).toBe(false);
  });
});
