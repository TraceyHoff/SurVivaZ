/**
 * ADR-466: snow that piles up — accumulation, slowing, melt.
 *
 * Snow depth is one u8 per chunk (0..255 = 0..~30 cm) on the existing ChunkSurface, written by the
 * existing chunkSurfaceSystem pass: +0.02 u8/s at intensity 1 while it snows (a 3-minute blizzard
 * lays ~7 units, ~1 cm), -0.01 u8/s when the seasonal base temperature is above freezing, and each
 * melted unit adds 0.5 units to chunk wetness (spring mud season). Deep snow slows walking
 * off-path — 0.8x at depth >= 64 (~7-8 cm), 0.7x at depth >= 160 (~19 cm); roads stay fast and
 * frozen water is exempt (already walk speed, no double slow).
 *
 * The rates are far below one u8 unit per pass, so the pass carries the fraction in a runtime-only
 * remainder — the tests below assert the exact accumulation (50 passes at intensity 1 = exactly
 * 1 unit), which only works because the fraction is not lost.
 */
import { describe, expect, it } from "vitest";
import { setSeason, Weather } from "@engine/core";
import { chunkKeyOf, TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const key00 = chunkKeyOf(0, 0);

const snowWorld = (snow: number, wetness = 0): { w: ReturnType<typeof makeWorld>; p: ReturnType<typeof G.spawnPlayer>; s: number } => {
  const w = makeWorld();
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  const s = G.ensureChunkSurface(w, key00);
  w.set(s, G.ChunkSurface, { cx: 0, cy: 0, wetness, snow });
  return { w, p, s };
};
const setWeather = (w: ReturnType<typeof makeWorld>, kind: number, intensity = 1): void => {
  Object.assign(w.env(Weather), { kind, intensity, endsAtTick: 0xffffffff });
};
const winter = (w: ReturnType<typeof makeWorld>): void => setSeason(w, 2, 1);
const spring = (w: ReturnType<typeof makeWorld>): void => setSeason(w, 3, 1);

describe("ADR-466 snow depth and slowdown", () => {
  it("chunkSnowAt reads the depth; 0 with no surface", () => {
    expect(G.chunkSnowAt(makeWorld(), 0, 0)).toBe(0);
    const { w } = snowWorld(100);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(100);
    expect(G.chunkSnowAt(w, 100, 100)).toBe(0); // another chunk, no surface
  });

  it("slowdown tiers: below 64 full speed, 64-159 is 0.8x, 160+ is 0.7x", () => {
    expect(G.speedMultiplier(snowWorld(0).w, snowWorld(0).p, false)).toBe(1);
    expect(G.speedMultiplier(snowWorld(63).w, snowWorld(63).p, false)).toBe(1);
    expect(G.speedMultiplier(snowWorld(64).w, snowWorld(64).p, false)).toBe(0.8);
    expect(G.speedMultiplier(snowWorld(159).w, snowWorld(159).p, false)).toBe(0.8);
    expect(G.speedMultiplier(snowWorld(160).w, snowWorld(160).p, false)).toBe(0.7);
    expect(G.speedMultiplier(snowWorld(255).w, snowWorld(255).p, false)).toBe(0.7);
  });

  it("mud and snow stack: wet + deep snow is 0.85 x 0.7", () => {
    const { w, p } = snowWorld(160, 255);
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(0.85 * 0.7, 10);
  });

  it("a dirt path in deep snow stays fast (road 1.1x, no snow slowdown)", () => {
    const { w, p } = snowWorld(255);
    G.spawnRoad(w, 0, 0, G.surfaceOf("path"));
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(1.1, 10);
  });

  it("frozen water is exempt: deep snow on a frozen lake walks at full speed", () => {
    const w = makeWorld();
    const map = new TileMap();
    for (let x = 0; x <= 4; x++) for (let y = 0; y <= 4; y++) map.setTile(x, y, G.GRASS_TILE);
    map.setTile(0, 0, 1); // water under the player
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    winter(w);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5 });
    const s = G.ensureChunkSurface(w, key00);
    w.set(s, G.ChunkSurface, { cx: 0, cy: 0, wetness: 0, snow: 255 });
    expect(G.isFrozenWaterAt(w, 0, 0)).toBe(true);
    expect(G.speedMultiplier(w, p, false)).toBe(1);
    // control: the same water tile in summer is liquid, so the snow does slow walking
    const w2 = makeWorld();
    w2.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    setSeason(w2, 0, 1);
    const p2 = G.spawnPlayer(w2, { x: 0.5, y: 0.5 });
    const s2 = G.ensureChunkSurface(w2, key00);
    w2.set(s2, G.ChunkSurface, { cx: 0, cy: 0, wetness: 0, snow: 255 });
    expect(G.isFrozenWaterAt(w2, 0, 0)).toBe(false);
    expect(G.speedMultiplier(w2, p2, false)).toBe(0.7);
  });
});

describe("ADR-466 accumulation and melt", () => {
  it("snow accumulates at 0.02 u8/s at intensity 1 (50 passes = exactly 1 unit, fraction carried)", () => {
    const w = makeWorld();
    winter(w); // melt off: the seasonal base temperature is below freezing
    G.ensureChunkSurface(w, key00);
    setWeather(w, G.WeatherKind.Snow, 1);
    for (let i = 0; i < 50; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(1);
    for (let i = 0; i < 50; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(2);
    for (let i = 0; i < 50; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(3);
  });

  it("accumulation scales with intensity, and blizzards lay snow at the same intensity rate as snow", () => {
    const w = makeWorld();
    winter(w);
    G.ensureChunkSurface(w, key00);
    setWeather(w, G.WeatherKind.Snow, 0.5);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(1); // 0.01/s x 100 s
    const w2 = makeWorld();
    winter(w2);
    G.ensureChunkSurface(w2, key00);
    setWeather(w2, G.WeatherKind.Blizzard, 0.5);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w2, 1);
    expect(G.chunkSnowAt(w2, 0, 0)).toBe(1); // no separate blizzard multiplier — intensity does the work
  });

  it("snow does not accumulate on a chunk whose centre is water", () => {
    const w = makeWorld();
    winter(w);
    const map = new TileMap();
    for (let x = 0; x <= 32; x++) for (let y = 0; y <= 32; y++) map.setTile(x, y, G.GRASS_TILE);
    map.setTile(16, 16, 1); // the centre tile of chunk (0, 0): CHUNK_SIZE 32
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    G.ensureChunkSurface(w, key00);
    setWeather(w, G.WeatherKind.Snow, 1);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(0);
    // control: land at the centre accumulates
    const w2 = makeWorld();
    winter(w2);
    const map2 = new TileMap();
    for (let x = 0; x <= 32; x++) for (let y = 0; y <= 32; y++) map2.setTile(x, y, G.GRASS_TILE);
    w2.setResource(G.TerrainRes, G.terrainFromTileMap(map2));
    G.ensureChunkSurface(w2, key00);
    setWeather(w2, G.WeatherKind.Snow, 1);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w2, 1);
    expect(G.chunkSnowAt(w2, 0, 0)).toBe(2);
  });

  it("depth caps at 255", () => {
    const { w } = snowWorld(250);
    winter(w);
    setWeather(w, G.WeatherKind.Snow, 1);
    for (let i = 0; i < 1000; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(255);
  });

  it("snow melts at 0.01 u8/s when warm, and meltwater wets the ground (2 melted = 1 wetness)", () => {
    const { w } = snowWorld(100, 0);
    spring(w); // seasonal base temperature above freezing; the waters are not frozen
    setWeather(w, G.WeatherKind.Clear, 1);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(99);
    expect(G.chunkWetnessAt(w, 0, 0)).toBe(0); // only 1 unit melted = 0.5 wetness, still carried
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(98);
    expect(G.chunkWetnessAt(w, 0, 0)).toBeCloseTo(1 / 255, 10); // 2 melted = 1 wetness unit
  });

  it("no melt while the seasonal temperature is below freezing (frozen ground holds its snow)", () => {
    const { w } = snowWorld(100, 0);
    winter(w);
    setWeather(w, G.WeatherKind.Clear, 1);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(100);
    expect(G.chunkWetnessAt(w, 0, 0)).toBe(0);
  });

  it("clear weather in winter neither accumulates nor melts", () => {
    const { w } = snowWorld(50, 0);
    winter(w);
    setWeather(w, G.WeatherKind.Clear, 1);
    for (let i = 0; i < 100; i++) G.chunkSurfaceSystem(w, 1);
    expect(G.chunkSnowAt(w, 0, 0)).toBe(50);
  });
});
