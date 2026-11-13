import { AnimState } from "@engine/core";
import { describe, it, expect } from "vitest";
import { World, Weather, setDayLength, setTimeOfDay } from "@engine/core";
import { loadManifest } from "@engine/assets";
import { BuildingGrid, loadBuildPieces } from "@engine/world";
import {
  importTexturePacker, mergeTexturePacker, parseFrameName, STATE_ANIMS, weatherTargets, setWeatherTable, DEFAULT_WEATHER_TABLE,
  readDayFraction, readWeather, readWind, loadRenderTuning, DEFAULT_STYLE, parseGradingKeyframes, sampleKeyframes, lutSizeFromImage, identityLut,
  visibleChunkKeys, cutawayRegion, tileKey, swayFromManifest, type TPJsonHash,
} from "../src/index.js";

const frame = (x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({ frame: { x, y, w, h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w, h }, sourceSize: { w, h }, pivot: { x: 0.5, y: 0.9 }, ...extra });
const tp = (frames: Record<string, unknown>): TPJsonHash => ({ frames, meta: { image: "hero.png", size: { w: 256, h: 512 } } }) as unknown as TPJsonHash;

describe("TexturePacker importer", () => {
  it("parses frame names", () => {
    expect(parseFrameName("hero/walk/SE/3.png")).toEqual({ sprite: "hero", anim: "walk", dir: "SE", index: 3 });
    expect(parseFrameName("rock")).toMatchObject({ sprite: "rock", dir: null });
  });
  it("builds 8-direction animations in E,SE,S,...,NE order with rects and pivots", () => {
    const frames: Record<string, unknown> = {};
    ["E", "SE", "S", "SW", "W", "NW", "N", "NE"].forEach((d, r) => { for (let i = 0; i < 2; i++) frames[`hero/walk/${d}/${i}.png`] = frame(i * 32, r * 48, 32, 48, { duration: 100 }); });
    const r = importTexturePacker(tp(frames), { category: "character" });
    expect(r.issues).toEqual([]);
    expect(r.atlas.key).toBe("hero");
    const walk = r.sprites.find((s) => s.key === "hero")!.animations.walk!;
    expect(walk.directions).toBe(8);
    expect(walk.fps).toBeCloseTo(10);
    const idx = walk.frames[0]! + 3 * (walk.dirStride ?? 0); // SW row
    expect(r.rects[idx]).toMatchObject({ x: 0, y: 3 * 48, w: 32, h: 48 });
    expect(r.rects[idx]!.ay).toBeCloseTo(48 * 0.9);
  });
  it("rejects rotated frames and bad names", () => {
    const r = importTexturePacker(tp({ "Bad Name!": frame(0, 0, 8, 8), "ok/0": frame(0, 0, 8, 8, { rotated: true }) }), { category: "item" });
    expect(r.issues.some((i) => i.includes("rotated"))).toBe(true);
    expect(r.issues.some((i) => i.includes("Bad Name"))).toBe(true);
    expect(importTexturePacker({} as TPJsonHash, { category: "item" }).issues.length).toBe(1);
  });
  it("feeds @engine/assets loadManifest; locked ids stay stable when TP sprites are added", () => {
    const base = { version: 1, atlases: [{ key: "items", image: "items.png", frameW: 32, frameH: 32, columns: 2, rows: 1 }], sprites: [
      { key: "wood", category: "item", atlas: "items", anchor: { x: 0.5, y: 0.5 }, animations: { idle: { frames: [0], fps: 1 } } },
      { key: "stone", category: "item", atlas: "items", anchor: { x: 0.5, y: 0.5 }, animations: { idle: { frames: [1], fps: 1 } } }] };
    const first = loadManifest(base);
    const imp = importTexturePacker(tp({ "axe/0.png": frame(0, 0, 32, 32), "apple/0.png": frame(32, 0, 32, 32) }), { key: "tp_items", category: "item" });
    const merged = mergeTexturePacker(base as never, [imp]);
    const second = loadManifest(merged.manifest, { lock: first.lock });
    expect(second.registry.id("wood")).toBe(first.registry.id("wood"));
    expect(second.registry.id("stone")).toBe(first.registry.id("stone"));
    expect(second.registry.id("axe")).toBeGreaterThan(0);
    expect(merged.rects.tp_items!.length).toBe(2);
  });
  it("reads optional sway blocks", () => {
    const r = swayFromManifest({ sprites: [{ key: "tree", sway: { amp: 2, freq: 0.3, stiffness: 0.6 } }, { key: "bad", sway: { amp: -1, freq: 1 } }] });
    expect(r.table.tree).toEqual({ amp: 2, freq: 0.3, stiffness: 0.6 }); expect(r.issues.length).toBe(1);
  });
});

describe("animation + weather mapping", () => {
  it("AnimState fallbacks", () => {
    expect(STATE_ANIMS[AnimState.Run]).toEqual(["run", "gallop", "walk"]); // ADR-319 mount sheets
    expect(STATE_ANIMS[AnimState.Hurt]).toContain("hurt");
    expect(STATE_ANIMS[AnimState.Shamble]).toEqual(["shamble", "walk"]);
  });
  it("unknown weather kinds fall back to clear; table is replaceable", () => {
    expect(weatherTargets(99, 1)).toEqual(weatherTargets(0, 1));
    expect(weatherTargets(1, 0.5).rain).toBeCloseTo(0.5);
    setWeatherTable({ ...DEFAULT_WEATHER_TABLE, 7: { rain: 0, snow: 0, fog: 0.5, wind: 1, storm: 0 } });
    expect(weatherTargets(7, 1).wind).toBe(1);
    setWeatherTable(DEFAULT_WEATHER_TABLE);
  });
});

describe("env accessor", () => {
  it("reads tick-derived time, weather and wind", () => {
    const w = new World();
    expect(readDayFraction(w)).toBe(0.5);
    setDayLength(w, 2400); setTimeOfDay(w, 18);
    expect(readDayFraction(w)).toBeCloseTo(0.75, 3);
    const we = w.env(Weather); we.kind = 1; we.intensity = 0.5; we.windSpeed = 5; we.windDir = 1;
    expect(readWeather(w).kind).toBe(1); expect(readWeather(w).intensity).toBeCloseTo(0.5);
    expect(readWind(w).speed).toBeCloseTo(5);
  });
});

describe("look config", () => {
  it("render_tuning merges over neutral defaults and warns on unknown keys / bad types", () => {
    const r = loadRenderTuning({ $comment: "x", bloom: { strength: 0.8, glow: 1 }, outline: { enabled: true, color: [1, 0, 0, 1] }, fogColor: [1, 2], nope: 1, shadowMode: "projected", gradingLut: { url: "lut/day.png" } });
    expect(r.style.bloom.strength).toBe(0.8); expect(r.style.bloom.radiusPx).toBe(DEFAULT_STYLE.bloom.radiusPx);
    expect(r.style.outline.enabled).toBe(true); expect(r.style.shadowMode).toBe("projected"); expect(r.style.gradingLut.url).toBe("lut/day.png");
    expect(r.style.fogColor).toEqual(DEFAULT_STYLE.fogColor);
    expect(r.warnings).toEqual(expect.arrayContaining(["unknown key bloom.glow", "unknown key nope", "fogColor: expected number[3]"]));
  });
  it("grading keyframes blend across midnight", () => {
    const k = parseGradingKeyframes({ keyframes: [
      { hour: 6, sun: [1, 0.8, 0.6], ambient: [0.3, 0.3, 0.4], fog: "#808080", shadowTint: [0.1, 0, 0.2], lut: "dawn.png" },
      { hour: 22, sun: [0, 0, 0], ambient: [0.1, 0.1, 0.3], fog: [0, 0, 0], shadowTint: [0, 0, 0] }] });
    expect(k.issues).toEqual([]);
    const s = sampleKeyframes(k.keyframes, 2)!;
    expect(s.a).toBe(1); expect(s.b).toBe(0); expect(s.t).toBeCloseTo(0.5);
    expect(s.ambient[2]).toBeCloseTo(0.35);
  });
  it("LUT size auto-detect (16^3 / 32^3 strips)", () => {
    expect(lutSizeFromImage(256, 16)).toBe(16); expect(lutSizeFromImage(1024, 32)).toBe(32); expect(lutSizeFromImage(512, 16)).toBeNull();
    const px = identityLut(16); expect(px.length).toBe(256 * 16 * 4); expect(px[(15 * 256 + 255) * 4]).toBe(255);
  });
});

describe("culling + cutaway", () => {
  it("visibleChunkKeys covers the view rect", () => {
    const keys = visibleChunkKeys({ x0: -100, y0: -100, x1: 100, y1: 100 }, 32, 16, 16, 4);
    expect(keys).toContain("0,0"); expect(keys).toContain("-1,-1");
  });
  it("cutawayRegion flood-fills the roofed building the focus stands in", () => {
    const { registry } = loadBuildPieces([{ key: "floor", footprint: { w: 2, h: 2 }, layer: 0, hp: 1 }, { key: "roof", footprint: { w: 2, h: 2 }, layer: 3, hp: 1 }]);
    const g = new BuildingGrid(registry); const f = registry.byKey("floor").id, r = registry.byKey("roof").id;
    for (let y = 0; y < 4; y += 2) for (let x = 0; x < 4; x += 2) { g.place(f, 10 + x, 10 + y, 0); g.place(r, 10 + x, 10 + y, 1); }
    const reg = cutawayRegion(g, 11, 11, 0)!;
    // ADR-381: cutaway regions are Set<number> of packed tileKey values, not "x,y" strings.
    expect(reg.has(tileKey(10, 10))).toBe(true); expect(reg.has(tileKey(13, 13))).toBe(true); expect(reg.has(tileKey(20, 20))).toBe(false);
    expect(cutawayRegion(g, 30, 30, 0)).toBeNull();
  });
  it("ADR-309: a floor under a missing roof stays in the cutaway when neighbors are roofed", () => {
    const { registry } = loadBuildPieces([{ key: "floor", footprint: { w: 1, h: 1 }, layer: 0, hp: 1 }, { key: "roof", footprint: { w: 1, h: 1 }, layer: 3, hp: 1 }]);
    const g = new BuildingGrid(registry); const f = registry.byKey("floor").id, r = registry.byKey("roof").id;
    for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) {
      g.place(f, x, y, 0);
      if (!(x === 11 && y === 11)) g.place(r, x, y, 1);
    }
    const hole = cutawayRegion(g, 11, 11, 0)!;
    expect(hole.has(tileKey(11, 11))).toBe(true);
    expect(hole.has(tileKey(10, 10))).toBe(true);
    expect(cutawayRegion(g, 30, 30, 0)).toBeNull();
  });
});
