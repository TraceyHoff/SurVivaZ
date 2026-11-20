/**
 * ADR-449: mud after rain — wet ground slows walking off-path (chunk wetness >= 0.5 -> 0.85x),
 * worn dirt paths stay fast (road tiles exempt). The ChunkSurface producer spawns one surface
 * per loaded chunk on chunk load; chunkSurfaceSystem wets it in rain and dries it after.
 */
import { describe, it, expect } from "vitest";
import { Weather } from "@engine/core";
import { chunkKeyOf } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
const key00 = chunkKeyOf(0, 0);

function wetWorld(wetness: number): { w: ReturnType<typeof makeWorld>; p: ReturnType<typeof G.spawnPlayer> } {
  const w = makeWorld();
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  const s = G.ensureChunkSurface(w, key00);
  w.set(s, G.ChunkSurface, { cx: 0, cy: 0, wetness });
  return { w, p };
}

describe("ADR-449 mud after rain", () => {
  it("dry ground walks at full speed", () => {
    const { w, p } = wetWorld(0);
    expect(G.chunkWetnessAt(w, 0, 0)).toBe(0);
    expect(G.speedMultiplier(w, p, false)).toBe(1);
  });

  it("wet ground (wetness 1.0) slows walking to 0.85x", () => {
    const { w, p } = wetWorld(255);
    expect(G.chunkWetnessAt(w, 0, 0)).toBe(1);
    expect(G.speedMultiplier(w, p, false)).toBe(0.85);
  });

  it("the threshold is 0.5: 127/255 walks free, 128/255 is mud", () => {
    const a = wetWorld(127);
    expect(G.speedMultiplier(a.w, a.p, false)).toBe(1);
    const b = wetWorld(128);
    expect(G.speedMultiplier(b.w, b.p, false)).toBeCloseTo(0.85, 10);
  });

  it("a dirt path on wet ground stays fast (road 1.1x, no mud)", () => {
    const { w, p } = wetWorld(255);
    G.spawnRoad(w, 0, 0, G.surfaceOf("path"));
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(1.1, 10);
  });

  it("rain wets the surface through chunkSurfaceSystem until mud slows walking", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.ensureChunkSurface(w, key00);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff });
    expect(G.speedMultiplier(w, p, false)).toBe(1);
    for (let i = 0; i < 60; i++) G.chunkSurfaceSystem(w, 1); // 60 s of rain at 0.01/s -> wetness 0.6
    expect(G.chunkWetnessAt(w, 0, 0)).toBeGreaterThanOrEqual(0.5);
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(0.85, 10);
  });

  it("ensureChunkSurface is idempotent: one surface per chunk", () => {
    const w = makeWorld();
    const a = G.ensureChunkSurface(w, key00);
    const b = G.ensureChunkSurface(w, key00);
    expect(b).toBe(a);
    expect([...w.query([G.ChunkSurface])].length).toBe(1);
  });

  it("despawnChunkSurface removes the surface; wetness reads 0 afterwards", () => {
    const w = makeWorld();
    G.ensureChunkSurface(w, key00);
    expect(G.despawnChunkSurface(w, key00)).toBe(true);
    expect(G.chunkWetnessAt(w, 0, 0)).toBe(0);
    expect([...w.query([G.ChunkSurface])].length).toBe(0);
  });

  it("a chunk with no surface reads 0 (unloaded / no streaming)", () => {
    const w = makeWorld();
    expect(G.chunkWetnessAt(w, 500, 500)).toBe(0);
  });

  it("mud tuning lives in movement.json", () => {
    expect(d.movement.mudSlowMul).toBe(0.85);
    expect(d.movement.mudWetnessThreshold).toBe(0.5);
  });
});
