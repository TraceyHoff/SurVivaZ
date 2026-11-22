/**
 * ADR-504: base building pieces scale with the player and the level grid.
 * building_scale.json is the contract (one floor metric shared by tiers.json, @engine/world, roofRfx.json), and
 * building_scale.measured.json holds the drawn heights tools/measure-building-scale.py reads from the shipped art.
 * Pieces still on the old 48 px floor are listed in `pendingArt` with their measured height pinned, so Art's 80 px
 * set (docs/art-requests/ADR504_BUILDING_SCALE.md) is noticed and flips the metric in one place.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ISO, FLOOR_HEIGHT_LEVELS } from "@engine/world";
import { RFX } from "@engine/assets";

const R = resolve(__dirname, "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(resolve(R, p), "utf8")) as T;
type Range = [number, number];
interface Contract { playerPx: number; zStepPx: number; floorLevels: number; floorPx: number; wallCapMaxPx: number; tierTolerancePx: number; familyTolerancePx: number;
  wallFamily: string[]; target: Record<string, number | Range> & { floorLevels: number; floorPx: number }; pendingArt: Record<string, number> }
interface Meas { sprite: string; atlas: string; topPx: number | null; openTopPx?: number; openSillPx?: number }
interface Measured { atlasSha1: Record<string, string>; pieces: Record<string, { placement: string; opening?: string; tiers: Record<string, Meas> }> }
const C = json<Contract>("packages/gameplay/data/building_scale.json");
const M = json<Measured>("packages/gameplay/data/building_scale.measured.json");
const PIECES = json<{ pieces: { key: string; family?: string; tiered?: boolean; minTier?: number; placement: string }[] }>("packages/gameplay/data/pieces.json").pieces;
const TIERS = json<{ building: { levelHeight: number } }>("packages/gameplay/data/tiers.json");
const tops = (k: string): number[] => Object.values(M.pieces[k]?.tiers ?? {}).map((m) => m.topPx ?? NaN);
const maxTop = (k: string): number => Math.max(...tops(k));
const inRange = (v: number, [lo, hi]: Range): boolean => v >= lo && v <= hi;
/** target range each piece is held to once its 80 px art lands (pendingArt pieces are pinned instead). */
const TARGET_OF: Record<string, string> = {
  wall: "wallTopPx", wall_window: "wallTopPx", wall_doorway: "wallTopPx", wall_arched: "wallTopPx", wall_corner_inner: "wallTopPx",
  wall_corner_outer: "wallTopPx", wall_corner_angled: "wallTopPx", wall_low: "wallLowTopPx", wall_fortified: "fortifiedTopPx", pillar: "pillarTopPx",
  stairs: "stairsTopPx", door_wood: "doorLeafTopPx", door_metal: "doorLeafTopPx", window_shutters: "windowOpenTopPx", window_glass: "windowOpenTopPx", window_bars: "windowOpenTopPx",
};

describe("ADR-504: one floor metric", () => {
  it("contract floor = tiers.json levelHeight = @engine/world FLOOR_HEIGHT_LEVELS; px = levels x zStep; roofs use the same px", () => {
    expect(TIERS.building.levelHeight).toBe(C.floorLevels);
    expect(FLOOR_HEIGHT_LEVELS).toBe(C.floorLevels);
    expect(DEFAULT_ISO.zStep).toBe(C.zStepPx);
    expect(C.floorPx).toBe(C.floorLevels * C.zStepPx);
    expect(C.target.floorPx).toBe(C.target.floorLevels * C.zStepPx);
    expect(RFX.levelPx).toBe(C.floorPx); // ADR-397/404 roof bands and seats are measured from this floor
  });
  it("targets are realistic against the player: door openings a bit taller than the player, walls ~1.5x", () => {
    const door = C.target.doorOpenTopPx as Range, wall = C.target.wallTopPx as Range;
    expect(door[0] / C.playerPx).toBeGreaterThan(1.05); expect(door[1] / C.playerPx).toBeLessThan(1.25);
    expect(wall[0]).toBe(C.target.floorPx); expect(wall[1] - wall[0]).toBeLessThanOrEqual(C.wallCapMaxPx);
    expect(C.target.floorPx / C.playerPx).toBeGreaterThan(1.4); expect(C.target.floorPx / C.playerPx).toBeLessThan(1.6);
    expect((C.target.stairsTopPx as Range)[0]).toBeLessThanOrEqual(C.target.floorPx + 16); expect((C.target.stairsTopPx as Range)[1]).toBeGreaterThanOrEqual(C.target.floorPx + 16);
  });
});

describe("ADR-504: measurements are fresh and cover every base piece", () => {
  it("every measured atlas still hashes to the measured bytes (re-run tools/measure-building-scale.py after an art change)", () => {
    const stale = Object.entries(M.atlasSha1).filter(([rel, sha]) => createHash("sha1").update(readFileSync(resolve(R, rel))).digest("hex") !== sha).map(([rel]) => rel);
    expect(stale).toEqual([]);
  });
  it("every structural piece and buildable tier has a measurement", () => {
    const rfxOnly = new Set(["roof_cottage", "roof_gambrel", "roof_shed"]); // ADR-397 continuous roofs: no per-piece sprite
    const missing: string[] = [];
    for (const p of PIECES) {
      if (!["wall", "floor", "foundation", "roof", "corner"].includes(p.family ?? "") && !["stairs", "door_wood", "door_metal", "window_glass", "window_shutters", "window_bars", "ladder"].includes(p.key)) continue;
      if (rfxOnly.has(p.key)) continue;
      const m = M.pieces[p.key]; if (!m) { missing.push(p.key); continue; }
      if (p.tiered) for (let t = p.minTier ?? 0; t <= 4; t++) if (!m.tiers[`t${t}`]) missing.push(`${p.key} t${t}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("ADR-504: pieces agree with each other and with the floor", () => {
  it("every tier of a piece draws the same height (within tierTolerancePx)", () => {
    const bad = Object.keys(M.pieces).filter((k) => { const t = tops(k); return Math.max(...t) - Math.min(...t) > C.tierTolerancePx; });
    expect(bad).toEqual([]);
  });
  it("wall kinds, corner posts and pillars share the plain wall's height, so one roof seat fits them all", () => {
    for (const t of ["t1", "t2", "t3", "t4"]) {
      const ref = M.pieces.wall!.tiers[t]!.topPx!;
      for (const k of C.wallFamily) { const m = M.pieces[k]?.tiers[t] ?? M.pieces[k]?.tiers.t1; expect(Math.abs((m?.topPx ?? NaN) - ref), `${k} ${t}`).toBeLessThanOrEqual(C.familyTolerancePx); }
    }
  });
  it("walls reach the floor above (face = floorPx, plus a cap no taller than wallCapMaxPx): roofs and upper decks sit on them", () => {
    for (const k of ["wall", "wall_window", "wall_doorway", "wall_arched"]) for (const v of tops(k)) { expect(v - C.floorPx, k).toBeGreaterThanOrEqual(0); expect(v - C.floorPx, k).toBeLessThanOrEqual(C.wallCapMaxPx); }
  });
  it("stairs climb exactly one floor (top step at the tile's back corner = floorPx + one tile row)", () => {
    for (const v of tops("stairs")) expect(Math.abs(v - (C.floorPx + DEFAULT_ISO.tileH / 2))).toBeLessThanOrEqual(C.tierTolerancePx);
  });
  it("doorway openings start at the floor (walk-through) and windows sit above it", () => {
    for (const m of Object.values(M.pieces.wall_doorway!.tiers)) expect(m.openSillPx!).toBeLessThanOrEqual(10); // stone footing strip only
    for (const m of Object.values(M.pieces.wall_window!.tiers)) expect(m.openSillPx!).toBeGreaterThan(15);
  });
});

describe("ADR-504 / ADR-511: scale against the player (80 px set landed)", () => {
  it("ADR-511: walls are ~1.5-1.7x the player and every doorway opens a bit taller than the player (was 1.05x / 0.59x)", () => {
    for (const v of tops("wall")) { expect(v / C.playerPx).toBeGreaterThan(1.5); expect(v / C.playerPx).toBeLessThan(1.75); }
    for (const m of Object.values(M.pieces.wall_doorway!.tiers)) { expect(m.openTopPx! / C.playerPx).toBeGreaterThan(1.05); expect(m.openTopPx! / C.playerPx).toBeLessThan(1.25); }
    for (const k of ["door_wood", "door_metal"]) expect(maxTop(k) / C.playerPx).toBeGreaterThan(1.1);
    expect(Object.keys(C.pendingArt)).toEqual([]);
  });
  it("pending pieces are pinned to their measured height; every other scaled piece meets its target", () => {
    for (const [k, key] of Object.entries(TARGET_OF)) {
      const v = maxTop(k), pend = C.pendingArt[k];
      if (pend !== undefined) { expect(v, `${k} re-painted: update building_scale.json (pendingArt / target)`).toBe(pend); expect(inRange(v, C.target[key] as Range), `${k} meets the target: drop it from pendingArt`).toBe(false); }
      else expect(inRange(v, C.target[key] as Range), `${k} ${v} vs ${key}`).toBe(true);
    }
    for (const k of Object.keys(C.pendingArt)) expect(TARGET_OF[k], k).toBeDefined();
  });
  it("the floor flips with the art: while any wall is pending the floor stays at the old 48 px, and once none are it is the target", () => {
    const walls = ["wall", "wall_window", "wall_doorway", "wall_arched"];
    if (walls.some((k) => C.pendingArt[k] !== undefined)) expect(C.floorLevels).toBe(3);
    else expect(C.floorLevels).toBe(C.target.floorLevels);
  });
});
