/**
 * ADR-452: rain fills open water — a carried liquid container gains +1 sip per ~45 s of
 * unsheltered rain (exposureSystem hook, first container with room). Rain water is untreated,
 * so a boiled container reverts to its raw variant on refill. Ground / storage containers are
 * out of scope; a roofed player stays dry and unfilled.
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);

/** ADR-312 pattern: drive exposureSystem directly (dt = 0.2 s per 4-tick pass), advancing the tick. */
const run = (w: World, secs: number) => { for (let i = 0; i < secs * 5; i++) { G.exposureSystem(w, 0.2); w.tick += 4; } };
/** Day 1 (past the first-day no-rain rule) + pinned Rain. */
const rainy = (w: World) => { setTimeOfDay(w, 12, 1); Object.assign(w.env(Weather), { kind: G.WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 }); };
function slotOf(w: World, p: Entity, key: string): number { return G.listSlots(w, p).find((s) => s.item === id(key))!.slot; }
function drain(w: World, p: Entity, key: string): number { const s = slotOf(w, p, key); while (G.takeSip(w, p, s)); return s; }
function durabilityOf(w: World, p: Entity, key: string): number { return G.listSlots(w, p).find((s) => s.item === id(key))?.durability ?? -1; }

/** A 1-tile roofed room at (10,10) (same builder as Task 24). */
function room(w: World, b: Entity): void {
  const snap = (key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) =>
    G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
  const place = (key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) => {
    const sn = snap(key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
    return G.placePiece(w, b, sn, { pay: false });
  };
  place("foundation", 10.5, 10.5);
  place("wall", 10.5, 10, {}); place("wall", 10.5, 11, {});
  place("wall", 10, 10.5, {}); place("wall", 11, 10.5, {});
  place("roof_flat", 10.5, 10.5, { level: 1 });
}

describe("ADR-452 rain fills open water", () => {
  it("an empty carried waterskin fills in the rain (300 s -> full, 3 sips)", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.addItem(w, p, id("waterskin"), 1); drain(w, p, "waterskin");
    expect(durabilityOf(w, p, "waterskin")).toBe(0);
    rainy(w);
    run(w, 300);
    expect(durabilityOf(w, p, "waterskin")).toBe(3);
  });

  it("no rain, no fill (clear weather)", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.addItem(w, p, id("waterskin"), 1); drain(w, p, "waterskin");
    run(w, 300);
    expect(durabilityOf(w, p, "waterskin")).toBe(0);
  });

  it("a roofed player stays unfilled in the rain", () => {
    const w = makeWorld();
    const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = G.spawnPlayer(w, { x: 10.5, y: 10.5 });
    G.addItem(w, p, id("waterskin"), 1); drain(w, p, "waterskin");
    rainy(w);
    run(w, 300);
    expect(durabilityOf(w, p, "waterskin")).toBe(0);
  });

  it("a boiled waterskin reverts to raw on rain refill", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.addItem(w, p, id("boiled_waterskin"), 1); drain(w, p, "boiled_waterskin");
    rainy(w);
    run(w, 300);
    expect(G.listSlots(w, p).some((s) => s.item === id("waterskin") && s.durability > 0)).toBe(true);
    expect(G.listSlots(w, p).some((s) => s.item === id("boiled_waterskin"))).toBe(false);
  });

  it("a full container does not overfill", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.addItem(w, p, id("waterskin"), 1);
    expect(durabilityOf(w, p, "waterskin")).toBe(3);
    rainy(w);
    run(w, 300);
    expect(durabilityOf(w, p, "waterskin")).toBe(3);
  });

  it("rain-fill tuning lives in environment.json", () => {
    expect(d.environment.rainFillSecondsPerSip).toBe(45);
  });
});
