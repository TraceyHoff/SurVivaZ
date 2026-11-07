// ADR-263/297: shovel terrain editing (-60..75), flowing water, underground darkness / 60°F / growth.
import { describe, expect, it } from "vitest";
import { setSeason, Weather, type Entity, type World } from "@engine/core";
import { TileMap, isFlowWater, renderTileHeight, terrainLevel, WATER_TILE } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const F = (c: number): number => c * 9 / 5 + 32;
/** A flat grass field (tile 3, height `h`) over [x0..x1] x [y0..y1] wired in as the world's terrain. */
function field(w: World, h = 2, x0 = -16, x1 = 47, y0 = -16, y1 = 47): TileMap {
  const map = new TileMap();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, h); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); return map;
}
const hold = (w: World, p: Entity, key: string): void => {
  if (!G.countItem(w, p, id(key))) G.addItem(w, p, id(key), 1);
  let slot = 0; while (G.slotItem(w, p, slot).item !== id(key)) slot++;
  w.set(p, G.Equipment, { mainHandSlot: slot, mainHandItem: id(key) });
};
const hAt = (w: World, x: number, y: number): number => w.resource(G.TerrainRes).heightAt(x, y);

describe("ADR-263 shovel terrain editing", () => {
  it("needs a shovel in hand; raises and lowers one level per use and clamps at absolute -60..75", () => {
    const w = makeWorld(); field(w, 2); const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, clientId: 1 });
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.NoShovel);
    expect(hAt(w, 1, 0)).toBe(2);
    w.set(p, G.Inventory, { maxWeight: 0 }); hold(w, p, "stone_shovel"); expect(G.holdingShovel(w, p)).toBe(true);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.None);
    expect(hAt(w, 1, 0)).toBe(1); expect(G.terrainDigAt(w, 1, 0)).toBe(-1);
    expect(w.resource(G.TerrainRes).tileAt(1, 0)).toBe(G.TERRAIN.earthTile); // dug earth
    for (let i = 0; i < 70; i++) G.editTerrain(w, p, 1, 0, -1);
    expect(G.terrainDigAt(w, 1, 0)).toBe(-62); expect(hAt(w, 1, 0)).toBe(-60);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.Limit);
    G.addItem(w, p, id("soil"), 75); // the 62 dug units fill the pit; another 73 reach absolute +75
    for (let i = 0; i < 140; i++) G.editTerrain(w, p, 1, 0, 1);
    expect(G.terrainDigAt(w, 1, 0)).toBe(73); expect(hAt(w, 1, 0)).toBe(75);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.Limit);
    expect(G.editTerrain(w, p, 9, 9, -1)).toBe(G.TerrainFail.TooFar);
    // back to ground removes the edit record
    const q = G.spawnPlayer(w, { x: 5.5, y: 5.5, clientId: 2 }); hold(w, q, "iron_shovel");
    G.addItem(w, q, id("soil"), 1);
    G.editTerrain(w, q, 6, 5, 1); expect(G.terrainDigAt(w, 6, 5)).toBe(1); G.editTerrain(w, q, 6, 5, -1);
    steps(w, 1); expect(G.terrainDigAt(w, 6, 5)).toBe(0); expect([...w.query([G.TerrainEdit])].length).toBe(1);
  });

  it("a hired AI human digs with a shovel from its bag; the command validates reach + shovel", () => {
    const w = makeWorld(); field(w, 3); const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5 });
    w.add(bot, G.Worker, {} as never);
    expect(G.editTerrain(w, bot, 1, 0, -1)).toBe(G.TerrainFail.NoShovel);
    G.addItem(w, bot, id("stone_shovel"), 1);
    expect(G.editTerrain(w, bot, 1, 0, -1)).toBe(G.TerrainFail.None); expect(hAt(w, 1, 0)).toBe(2);
    expect(G.countItem(w, bot, id("soil"))).toBe(1);
    expect(G.editTerrain(w, bot, 1, 0, 1, true)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, bot, id("soil"))).toBe(1);
    expect(G.editTerrain(w, bot, 1, 0, 1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, bot, id("soil"))).toBe(0);
    expect(G.editTerrain(w, bot, 1, 0, 1)).toBe(G.TerrainFail.NoSoil);
    expect(G.TERRAIN_COMMANDS).toContain(G.TerrainCmd);
  });

  it("ADR-264: digs grant one soil, raises consume one, and previews are read-only", () => {
    const w = makeWorld(); field(w, 2); const p = G.spawnPlayer(w, { x: 0.5, y: 0.5 }); hold(w, p, "stone_shovel");
    expect(d.items.get(id("soil"))).toMatchObject({ name: "Soil", maxStack: 50, weight: 0.7 });
    expect(G.editTerrain(w, p, 1, 0, 1, true)).toBe(G.TerrainFail.NoSoil);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.NoSoil); expect(hAt(w, 1, 0)).toBe(2);
    expect(G.editTerrain(w, p, 1, 0, -1, true)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(0); expect(hAt(w, 1, 0)).toBe(2);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(1);
    expect(G.editTerrain(w, p, 1, 0, 1, true)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(1); expect(hAt(w, 1, 0)).toBe(1);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(0); expect(hAt(w, 1, 0)).toBe(2);
    // Digging a mound back down also yields soil; a rejected boundary edit does not.
    G.setTerrainDig(w, 1, 0, 1);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.None); expect(G.countItem(w, p, id("soil"))).toBe(1);
    G.setTerrainDig(w, 1, 0, -62);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.Limit); expect(G.countItem(w, p, id("soil"))).toBe(1);
  });

  it.each(["slots", "weight"])("ADR-264: refuses digging with full %s without losing soil or changing terrain", (limit) => {
    const w = makeWorld(); field(w, 2); const p = G.spawnPlayer(w, { x: 0.5, y: 0.5 }); hold(w, p, "stone_shovel");
    if (limit === "slots") {
      w.set(p, G.Inventory, { maxWeight: 0 });
      G.addItem(w, p, id("stone"), 99 * G.PACK_SLOTS);
    } else w.set(p, G.Inventory, { maxWeight: 0.1 });
    expect(G.canAddItem(w, p, id("soil"), 1)).toBe(0);
    const inv = w.get(p, G.Inventory);
    for (const dryRun of [true, false]) {
      expect(G.editTerrain(w, p, 1, 0, -1, dryRun)).toBe(G.TerrainFail.InventoryFull);
      expect(hAt(w, 1, 0)).toBe(2); expect(G.terrainDigAt(w, 1, 0)).toBe(0);
      expect(w.get(p, G.Inventory)).toEqual(inv); expect(G.countItem(w, p, id("soil"))).toBe(0);
    }
  });

  it.each([false, true])("ADR-297: player/worker extremes conserve soil with fixed column storage (worker=%s)", worker => {
    const w = makeWorld(); const map = field(w, 0); const p = G.spawnPlayer(w, { x: .5, y: .5, maxWeight: 0 });
    if (worker) { w.add(p, G.Worker, {} as never); G.addItem(w, p, id("stone_shovel"), 1); }
    else hold(w, p, "stone_shovel");
    const bytes = [...map.loadedChunks()].reduce((n,c) => n + c.height.byteLength + c.tiles.byteLength, 0);
    for (let i=0;i<60;i++) expect(G.editTerrain(w,p,1,0,-1)).toBe(G.TerrainFail.None);
    expect(hAt(w,1,0)).toBe(-60); expect(G.countItem(w,p,id("soil"))).toBe(60);
    expect(G.editTerrain(w,p,1,0,-1)).toBe(G.TerrainFail.Limit);
    G.addItem(w,p,id("soil"),75);
    for(let i=0;i<135;i++) expect(G.editTerrain(w,p,1,0,1)).toBe(G.TerrainFail.None);
    expect(hAt(w,1,0)).toBe(75); expect(G.countItem(w,p,id("soil"))).toBe(0);
    expect(G.editTerrain(w,p,1,0,1)).toBe(G.TerrainFail.Limit);
    expect([...w.query([G.TerrainEdit])]).toHaveLength(1);
    expect([...map.loadedChunks()].reduce((n,c)=>n+c.height.byteLength+c.tiles.byteLength,0)).toBe(bytes);
    G.setTerrainDig(w,1,0,-999); expect(hAt(w,1,0)).toBe(-60); expect(G.terrainDigAt(w,1,0)).toBe(-60);
  });

  it("negative heights round-trip through the chunk codec and net runs as signed bytes", async () => {
    const { Chunk, encodeChunk, decodeChunk } = await import("@engine/world");
    const c = new Chunk(0, 0); c.setHeight(3, 4, -25); c.setHeight(5, 5, 37);
    const back = decodeChunk(encodeChunk(c)).chunk; expect(back.getHeight(3, 4)).toBe(-25); expect(back.getHeight(5, 5)).toBe(37);
    expect(c.heightEdited).toBe(true);
  });
});

describe("ADR-263 flowing water", () => {
  it("water flows tile by tile from a lake down a dug channel, never onto undug or raised ground", () => {
    const w = makeWorld(); const map = field(w, 0);
    // a natural lake column at x = 0 (flat ADR-182 surface 0)
    for (let y = -4; y <= 4; y++) map.setTile(0, y, WATER_TILE);
    const t = w.resource(G.TerrainRes);
    // dig a channel 1..6 along y = 0, one level below ground; a raised berm at (3,1)
    for (let x = 1; x <= 6; x++) G.setTerrainDig(w, x, 0, -1);
    G.setTerrainDig(w, 3, 1, 2);
    expect(t.tileAt(1, 0)).toBe(3);
    let flooded = 0; const order: number[] = [];
    for (let s = 0; s < 10; s++) { const n = G.terrainFlowStep(w); flooded += n; for (let x = 1; x <= 6; x++) if (G.waterSurfaceAt(t, x, 0) !== undefined && !order.includes(x)) order.push(x); }
    expect(flooded).toBe(6);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]); // advances one tile per step from the source
    for (let x = 1; x <= 6; x++) { const raw = t.rawHeightAt!(x, 0); expect(t.tileAt(x, 0)).toBe(WATER_TILE); expect(isFlowWater(WATER_TILE, raw)).toBe(true); expect(terrainLevel(WATER_TILE, raw)).toBe(-1); expect(renderTileHeight(WATER_TILE, raw)).toBe(-1); }
    expect(t.tileAt(1, 1)).toBe(3); expect(t.tileAt(3, 1)).toBe(3); // undug bank + raised berm stay dry
    expect(t.heightAt(1, 0)).toBe(-1); // gameplay level decodes the flowing-water height
    // the lake itself still draws flat (natural water untouched)
    expect(renderTileHeight(WATER_TILE, t.rawHeightAt!(0, 0))).toBe(0);
    // swimming / wading rules see the new water
    expect(G.inWater(w, 4.5, 0.5)).toBe(true);
  });

  it("ADR-297: deep flooded pits retain -60 and fill with exactly one Soil", () => {
    const w=makeWorld(); const map=field(w,0); map.setTile(0,0,WATER_TILE);
    G.setTerrainDig(w,1,0,-60); expect(G.isUnderground(w,1,0)).toBe(true);
    expect(G.terrainFlowStep(w)).toBe(1); expect(hAt(w,1,0)).toBe(-60);
    G.setTerrainDig(w,1,0,999);expect(hAt(w,1,0)).toBe(75);expect(G.terrainDigAt(w,1,0)).toBe(75);
    G.setTerrainDig(w,1,0,-999);expect(hAt(w,1,0)).toBe(-60);expect(G.terrainDigAt(w,1,0)).toBe(-60);
    const p=G.spawnPlayer(w,{x:2.5,y:.5});hold(w,p,"stone_shovel");G.addItem(w,p,id("soil"),1);
    expect(G.editTerrain(w,p,1,0,1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w,p,id("soil"))).toBe(0);expect(hAt(w,1,0)).toBe(-60);
    expect(w.resource(G.TerrainRes).tileAt(1,0)).toBe(G.TERRAIN.earthTile);
    expect(G.editTerrain(w,p,1,0,-1)).toBe(G.TerrainFail.Limit);
  });

  it("an isolated pit stays dry; a channel dug uphill of the water does not fill; raising water fills it in", () => {
    const w = makeWorld(); const map = field(w, 0); map.setTile(0, 0, WATER_TILE);
    const t = w.resource(G.TerrainRes);
    G.setTerrainDig(w, 10, 10, -3); // pit away from water
    G.setTerrainDig(w, 0, 1, 0); map.ensureChunk(0, 0).setHeight(0, 1, 2); // high bank next to the lake…
    G.setTerrainDig(w, 0, 1, -1); // …dug 1 down is still above the lake surface (0)
    for (let s = 0; s < 5; s++) G.terrainFlowStep(w);
    expect(t.tileAt(10, 10)).toBe(3); expect(t.tileAt(0, 1)).toBe(3);
    G.setTerrainDig(w, 1, 0, -1); for (let s = 0; s < 3; s++) G.terrainFlowStep(w); expect(t.tileAt(1, 0)).toBe(WATER_TILE);
    const p = G.spawnPlayer(w, { x: 2.5, y: 0.5, clientId: 1 }); hold(w, p, "stone_shovel");
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.BadTile);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.NoSoil);
    expect(t.tileAt(1, 0)).toBe(WATER_TILE);
    G.addItem(w, p, id("soil"), 1);
    expect(G.editTerrain(w, p, 1, 0, 1, true)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(1); expect(t.tileAt(1, 0)).toBe(WATER_TILE);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, p, id("soil"))).toBe(0);
    expect(t.tileAt(1, 0)).toBe(G.TERRAIN.earthTile); expect(t.heightAt(1, 0)).toBe(-1);
  });
});

describe("ADR-263 underground", () => {
  it("dark underground without a light; lit by a held torch or a campfire; surface is never 'dark underground'", () => {
    const w = makeWorld(); field(w, 2);
    G.setTerrainDig(w, 20, 20, -3); G.setTerrainDig(w, 22, 20, -2);
    expect(G.isUnderground(w, 20.5, 20.5)).toBe(true); expect(G.isUnderground(w, 22.5, 20.5)).toBe(false);
    G.invalidateLightGrid(w);
    expect(G.isDarkUnderground(w, 20.5, 20.5)).toBe(true); expect(G.undergroundLightAt(w, 20.5, 20.5)).toBe(0);
    expect(G.isDarkUnderground(w, 22.5, 20.5)).toBe(false); expect(G.isDarkUnderground(w, 5.5, 5.5)).toBe(false);
    const p = G.spawnPlayer(w, { x: 20.5, y: 21.5, clientId: 1 }); hold(w, p, "torch"); G.invalidateLightGrid(w);
    expect(G.isDarkUnderground(w, 20.5, 20.5)).toBe(false);
    w.set(p, G.Equipment, { mainHandSlot: 255, mainHandItem: 0 }); G.invalidateLightGrid(w);
    expect(G.isDarkUnderground(w, 20.5, 20.5)).toBe(true);
    G.spawnStation(w, G.StationKind.Campfire, 21.5, 20.5, { burnSeconds: 600 }); G.invalidateLightGrid(w);
    expect(G.isDarkUnderground(w, 20.5, 20.5)).toBe(false);
  });

  it("60°F at depth >= 3 in every season and weather, while the surface follows the season", () => {
    const w = makeWorld({ dayLengthTicks: 24_000 }); field(w, 2); G.setTerrainDig(w, 4, 4, -3); G.setTerrainDig(w, 6, 4, -25); G.setTerrainDig(w, 8, 4, -2);
    const surface: number[] = [];
    for (const season of [0, 1, 2, 3]) for (const kind of [G.WeatherKind.Clear, G.WeatherKind.Blizzard, G.WeatherKind.Heat]) {
      setSeason(w, season, 2); w.env(Weather).kind = kind; w.env(Weather).intensity = 1;
      expect(F(G.ambientTemperature(w, 4.5, 4.5))).toBeCloseTo(60, 6);
      expect(F(G.ambientTemperature(w, 6.5, 4.5))).toBeCloseTo(60, 6);
      surface.push(G.ambientTemperature(w, 8.5, 4.5));
    }
    expect(Math.max(...surface) - Math.min(...surface)).toBeGreaterThan(10); // depth 2 is still surface weather
  });

  it("underground crops grow only with continuous light AND water; winter / frost do not touch them", () => {
    const w = makeWorld({ dayLengthTicks: 24_000 }); field(w, 2, -16, 63, -16, 63);
    for (const [x, y] of [[30, 30], [55, 30], [40, 40]] as const) G.setTerrainDig(w, x, y, -4);
    const kind = G.FARMING.plantables.findIndex((p) => p.type === "crop") + 1;
    const lit = G.spawnCrop(w, 30.5, 30.5, kind), dark = G.spawnCrop(w, 55.5, 30.5, kind), dry = G.spawnCrop(w, 40.5, 40.5, kind), surf = G.spawnCrop(w, 10.5, 10.5, kind);
    G.spawnStation(w, G.StationKind.Campfire, 31.5, 31.5, { burnSeconds: 100_000 });
    G.spawnStation(w, G.StationKind.Campfire, 41.5, 41.5, { burnSeconds: 100_000 });
    setSeason(w, 2, 2); // winter: surface crops dormant / frost-killed
    const until = w.tick + 1_000_000;
    for (const e of [lit, dark]) w.set(e, G.Crop, { waterUntilTick: until });
    G.invalidateLightGrid(w);
    const growth = (e: Entity): number => (w.isAlive(e) && w.has(e, G.Crop) ? w.get(e, G.Crop)!.growth : -1);
    expect(G.lightAt(w, 55.5, 30.5, 0)).toBeUndefined(); expect(G.lightAt(w, 40.5, 40.5, 0)).toBeDefined();
    for (let i = 0; i < 5; i++) { w.tick += G.CROP_EVERY; G.invalidateLightGrid(w); G.cropGrowthSystem(w); }
    expect(growth(lit)).toBeGreaterThan(0); // light + water
    expect(growth(dark)).toBe(0); // water, no light
    expect(growth(dry)).toBe(0); // light, no water (rain never reaches underground)
    expect(w.get(surf, G.Crop)!.growth).toBe(0); // surface crop in winter: dormant
  });

  it("raising / lowering keeps Task 35 ledges: a dug tile is a height drop the cliff pass sees", () => {
    const w = makeWorld(); const map = field(w, 5); G.setTerrainDig(w, 2, 2, -3);
    expect(map.getChunk(0, 0)!.getHeight(2, 2)).toBe(2); expect(map.getChunk(0, 0)!.getHeight(3, 2)).toBe(5);
    const sets = map.tileChanges(); expect(sets.some((s) => s.heights)).toBe(true); // TileSync resends the chunk in full
  });
});
