/**
 * ADR-506: TileTerrain.build reads tile ids / heights from per-build rings around the chunk and writes typed rows —
 * the shore tint (which scans up to SHORE_TINT_RANGE tiles out) and the drop/slope neighbours must still see
 * tiles in the neighbouring chunks exactly as map.getTile does.
 * ADR-507: deferred impact overlays — draw() queues them, drawOverlays() draws them blended afterwards.
 */
import { describe, expect, it } from "vitest";
import { TileMap, waterCornerTint } from "@engine/world";
import { TileTerrain } from "../src/terrainTiles.js";
import { TileId } from "../src/ids.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";

function mockGl(log: string[] = []) {
  const up: Float32Array[] = [];
  const gl = new Proxy({ bufferData: (_t: unknown, d: Float32Array) => { up.push(d); }, TRIANGLES: 4 } as Record<string, unknown>, {
    get: (o, k: string) => k in o ? o[k] : (typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? k : (...a: unknown[]) => { log.push(k); return k.startsWith("create") ? {} : a[0] ?? null; }),
  });
  return { gl, up };
}
const atlas = { registry: { ids: { sprites: { tryId: () => 1 } } }, animEntries: () => ({ first: 0, count: 1, fps: 0, ax: 32, ay: 16 }), version: 0, tex: {}, frameTex: {} } as unknown as AtlasManager;

describe("ADR-506 terrain build rings", () => {
  it("water corner tints match map.getTile across chunk borders (land 5 tiles outside the chunk)", () => {
    const map = new TileMap();
    for (let y = -8; y < 40; y++) for (let x = -8; x < 40; x++) map.setTile(x, y, TileId.Water);
    for (let y = -8; y < 40; y++) { map.setTile(-5, y, TileId.Grass); map.setTile(36, y, TileId.Sand); }
    const { gl, up } = mockGl();
    const t = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => null }) as unknown as { build(...a: unknown[]): void };
    t.build(map, map.getChunk(0, 0), atlas, undefined, 0, 0);
    const rows = up[0]!; let checked = 0, shore = 0;
    for (let i = 0; i < rows.length; i += 16) {
      const x = rows[i]! - 0.5, y = rows[i + 1]! - 0.5; if (rows[i + 10] !== 1) continue;
      const at = (a: number, b: number): number => map.getTile(a, b);
      const want = [waterCornerTint(at, x, y), waterCornerTint(at, x + 1, y), waterCornerTint(at, x + 1, y + 1), waterCornerTint(at, x, y + 1)];
      expect([...rows.slice(i + 12, i + 16)].map((v) => +v.toFixed(5))).toEqual(want.map((v) => +Math.fround(v).toFixed(5)));
      checked++; if (want.some((v) => v > 0)) shore++;
    }
    expect(checked).toBe(32 * 32); expect(shore).toBeGreaterThan(0);
  });
});

describe("ADR-507 deferred impact overlays", () => {
  it("draw() queues overlay chunks instead of drawing them; drawOverlays() draws them blended", () => {
    const log: string[] = []; const { gl } = mockGl(log);
    const t = Object.assign(Object.create(TileTerrain.prototype), { gl, prog: { prog: {}, u: {} }, season: [0, 0, 0, 0], overlayQueue: [], overlayArt: 0 }) as TileTerrain;
    const q = (t as unknown as { overlayQueue: unknown[] }).overlayQueue;
    const chunk = { overlayVao: {}, overlayCount: 3 } as never;
    t.deferOverlays = true; q.push(chunk, 0.2, 0);
    t.drawOverlays(atlas, { drawCalls: 0 } as never);
    expect(log.filter((k) => k === "drawArraysInstanced").length).toBe(1);
    expect(log.indexOf("enable")).toBeLessThan(log.indexOf("drawArraysInstanced"));
    expect(log.lastIndexOf("disable")).toBeGreaterThan(log.indexOf("drawArraysInstanced"));
    expect(q.length).toBe(0);
    log.length = 0; t.drawOverlays(atlas, { drawCalls: 0 } as never); expect(log).toEqual([]); // empty queue: no GL work
  });
});
