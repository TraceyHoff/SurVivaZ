/**
 * ADR-312: graduated partial shelter from surrounding base pieces — roof overhead blocks rain / sun, walls / doors /
 * windows around block wind and cold, damaged pieces and open doors count less, and a fully enclosed roofed room keeps
 * the existing indoor behaviour exactly. Players and AI humans share the exposure system.
 */
import { describe, expect, it } from "vitest";
import { setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { WeatherKind } from "../src/defs.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
function place(w: World, key: string, x: number, y: number, o: { level?: number; tier?: number } = {}): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: 0, tier: o.tier ?? 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
}
type Side = "N" | "S" | "W" | "E";
const EDGE: Record<Side, [number, number]> = { N: [10.5, 10], S: [10.5, 11], W: [10, 10.5], E: [11, 10.5] };
/** A 1-tile hut at tile (10,10): a foundation, the listed walls, optionally a roof (and a doorway + door on the south). */
function hut(o: { walls?: Side[]; roof?: boolean; door?: "closed" | "open" } = {}): { w: World; walls: Partial<Record<Side, Entity>>; roof?: Entity; door?: Entity } {
  const w = makeWorld(); place(w, "foundation", 10.5, 10.5);
  const walls: Partial<Record<Side, Entity>> = {};
  for (const s of o.walls ?? []) walls[s] = place(w, "wall", ...EDGE[s]);
  let door: Entity | undefined;
  if (o.door) {
    walls.S = place(w, "wall_doorway", ...EDGE.S); door = place(w, "door_wood", ...EDGE.S);
    if (o.door === "open") { w.setField(G.resolveAttachment(w, door, G.AttachKind.Door)!, G.DoorState, "open", 1); G.structures(w).version++; }
  }
  const roof = o.roof ? place(w, "roof_flat", 10.5, 10.5, { level: 1 }) : undefined;
  return { w, walls, ...(roof !== undefined && { roof }), ...(door !== undefined && { door }) };
}
const at = (w: World) => G.shelterAt(w, 10.5, 10.5, 0);

describe("ADR-312 shelter factor from surrounding pieces", () => {
  it("open ground (a bare foundation) gives no shelter", () => {
    const s = at(hut().w);
    expect(s).toMatchObject({ covered: false, enclosed: false, exposure: 1, rain: 1, wind: 1, sun: 1, factor: 0 });
  });
  it("a lone roof keeps most rain and sun off but barely stops the wind", () => {
    const s = at(hut({ roof: true }).w);
    expect(s.covered).toBe(true);
    expect(s.rain).toBeCloseTo(0.2, 5); // roof blocks 80% of rain
    expect(s.sun).toBeCloseTo(0.25, 5); // shade
    expect(s.wind).toBeCloseTo(0.5, 5); // legacy roof halving (never worse than before); walls do the real wind work
    expect(s.exposure).toBeCloseTo(0.5, 5);
    expect(s.factor).toBeCloseTo(0.6, 5);
  });
  it("two walls without a roof block some wind but little rain", () => {
    const s = at(hut({ walls: ["N", "W"] }).w);
    expect(s.rain).toBeCloseTo(0.9, 5); expect(s.wind).toBeCloseTo(0.575, 5); expect(s.exposure).toBeCloseTo(0.7, 5);
    expect(s.factor).toBeGreaterThan(0.2); expect(s.factor).toBeLessThan(0.4);
  });
  it("three walls and a roof give most of the protection", () => {
    const s = at(hut({ walls: ["N", "W", "E"], roof: true }).w);
    expect(s.enclosed).toBe(false);
    expect(s.rain).toBeCloseTo(0.05, 5); expect(s.wind).toBeCloseTo(0.2125, 5); expect(s.exposure).toBeCloseTo(0.15, 5);
    expect(s.factor).toBeGreaterThan(0.8); expect(s.factor).toBeLessThan(1);
  });
  it("graduated: more pieces, more shelter", () => {
    const f = [hut().w, hut({ walls: ["N"] }).w, hut({ walls: ["N", "W"] }).w, hut({ roof: true }).w, hut({ walls: ["N", "W"], roof: true }).w, hut({ walls: ["N", "W", "E"], roof: true }).w].map((w) => at(w).factor);
    for (let i = 1; i < f.length; i++) expect(f[i], `step ${i}`).toBeGreaterThan(f[i - 1]!);
  });
  it("full enclosure keeps the existing indoor values (every exposure 0, factor 1)", () => {
    const s = at(hut({ walls: ["N", "S", "W", "E"], roof: true }).w);
    expect(s).toMatchObject({ covered: true, enclosed: true, exposure: 0, rain: 0, wind: 0, sun: 0, factor: 1 });
  });
  it("damaged pieces shelter less (wrecked walls 30%, wrecked roof 30%)", () => {
    const good = at(hut({ walls: ["N", "W", "E"], roof: true }).w).factor;
    const h = hut({ walls: ["N", "W", "E"], roof: true });
    h.w.setField(h.walls.N!, G.BuildPiece, "damageStage", 3); h.w.setField(h.walls.W!, G.BuildPiece, "damageStage", 2);
    const hurt = at(h.w).factor;
    expect(hurt).toBeLessThan(good);
    const r = hut({ roof: true }); r.w.setField(r.roof!, G.BuildPiece, "damageStage", 3);
    expect(at(r.w).rain).toBeGreaterThan(at(hut({ roof: true }).w).rain);
    expect(at(r.w).rain).toBeCloseTo(0.5, 5); // floored at the legacy roof halving (never worse than before ADR-312)
  });
  it("a closed door seals the room; an open door counts less but still more than a missing wall", () => {
    const closed = at(hut({ walls: ["N", "W", "E"], roof: true, door: "closed" }).w);
    const open = at(hut({ walls: ["N", "W", "E"], roof: true, door: "open" }).w);
    const three = at(hut({ walls: ["N", "W", "E"], roof: true }).w);
    expect(closed.enclosed).toBe(true); expect(closed.factor).toBe(1);
    expect(open.enclosed).toBe(false);
    expect(open.factor).toBeLessThan(closed.factor); expect(open.factor).toBeGreaterThan(three.factor);
    expect(G.SHELTER_EDGE.doorOpen).toBeLessThan(G.SHELTER_EDGE.doorClosed);
  });
  it("walls of a bigger room still count from its middle (ring search up to 4 tiles)", () => {
    const w = makeWorld();
    for (let x = 8; x <= 12; x++) for (let y = 8; y <= 12; y++) place(w, "foundation", x + 0.5, y + 0.5);
    for (let x = 8; x <= 12; x++) place(w, "wall", x + 0.5, 8); // north wall line, 2 tiles from the centre
    for (let y = 8; y <= 12; y++) place(w, "wall", 8, y + 0.5); // west wall line
    const s = at(w);
    expect(s.wind).toBeCloseTo(1 - 0.85 * 0.5, 5);
  });
  it("partialExposure matches the documented formulas", () => {
    expect(G.partialExposure(0, 0)).toEqual({ rain: 1, wind: 1, cold: 1, sun: 1 });
    const p = G.partialExposure(1, 1);
    for (const v of Object.values(p)) expect(v).toBeCloseTo(0, 9);
  });
});

const run = (w: World, secs: number) => { for (let i = 0; i < secs * 5; i++) { G.exposureSystem(w, 0.2); w.tick += 4; } };
const rainy = (w: World) => { setTimeOfDay(w, 12, 1); Object.assign(w.env(Weather), { kind: WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 }); };

describe("ADR-312 shelter scales wetness and temperature", () => {
  it("rain wets under a lone roof at 20% of the open rate; inside a sealed room not at all", () => {
    const roofed = hut({ roof: true }).w; rainy(roofed);
    const a = G.spawnPlayer(roofed, { x: 10.5, y: 10.5 }); const b = G.spawnPlayer(roofed, { x: 30, y: 30 });
    run(roofed, 10);
    const wa = roofed.getField(a, G.Exposure, "wetness")!, wb = roofed.getField(b, G.Exposure, "wetness")!;
    expect(wb).toBeGreaterThan(0.1); expect(wa / wb).toBeCloseTo(0.2, 1);
    const sealed = hut({ walls: ["N", "S", "W", "E"], roof: true }).w; rainy(sealed);
    const c = G.spawnPlayer(sealed, { x: 10.5, y: 10.5 }); run(sealed, 10);
    expect(sealed.getField(c, G.Exposure, "wetness")).toBe(0);
  });
  it("walls cut wind chill in proportion; three walls + roof feel much warmer than open ground in winter wind", () => {
    const felt = (w: World): { open: number; inside: number } => {
      setSeason(w, 2, 1.5); setTimeOfDay(w, 0);
      Object.assign(w.env(Weather), { kind: WeatherKind.Windy, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 9 });
      const i = G.spawnPlayer(w, { x: 10.5, y: 10.5 }); const o = G.spawnPlayer(w, { x: 30, y: 30 }); run(w, 1);
      return { inside: w.getField(i, G.Exposure, "feltTemp")!, open: w.getField(o, G.Exposure, "feltTemp")! };
    };
    const none = felt(hut().w), two = felt(hut({ walls: ["N", "W"] }).w), three = felt(hut({ walls: ["N", "W", "E"], roof: true }).w);
    expect(none.inside).toBeCloseTo(none.open, 3);
    expect(two.inside).toBeGreaterThan(two.open + 0.5);
    expect(three.inside).toBeGreaterThan(two.inside);
    const sealed = felt(hut({ walls: ["N", "S", "W", "E"], roof: true }).w);
    const vt = d.vitals; // full enclosure: unchanged indoor clamp to the comfort band
    expect(sealed.inside).toBeGreaterThanOrEqual(vt.comfortMin - 1e-3); expect(sealed.inside).toBeLessThanOrEqual(vt.comfortMax + 1e-3);
  });
  it("Exposure.sheltered carries the shelter percent for the HUD (0 outside, 100 indoors)", () => {
    const h = hut({ walls: ["N", "W", "E"], roof: true }); rainy(h.w);
    const p = G.spawnPlayer(h.w, { x: 10.5, y: 10.5 }), q = G.spawnPlayer(h.w, { x: 30, y: 30 }); run(h.w, 1);
    expect(h.w.getField(p, G.Exposure, "sheltered")).toBe(Math.round(at(h.w).factor * 100));
    expect(h.w.getField(q, G.Exposure, "sheltered")).toBe(0);
    const s = hut({ walls: ["N", "S", "W", "E"], roof: true }); const r = G.spawnPlayer(s.w, { x: 10.5, y: 10.5 }); run(s.w, 1);
    expect(s.w.getField(r, G.Exposure, "sheltered")).toBe(100);
  });
  it("AI humans (virtual players, no client) get exactly the same shelter as a human player", () => {
    const h = hut({ walls: ["N", "W"], roof: true }); rainy(h.w);
    const human = G.spawnPlayer(h.w, { x: 10.5, y: 10.5, clientId: 3 }); const bot = G.spawnPlayer(h.w, { x: 10.5, y: 10.5 });
    run(h.w, 5);
    for (const f of ["sheltered", "wetness", "feltTemp"] as const) expect(h.w.getField(bot, G.Exposure, f), f).toBe(h.w.getField(human, G.Exposure, f));
    expect(h.w.getField(bot, G.Exposure, "sheltered")).toBeGreaterThan(50);
  });
  it("is cached per tile: repeated reads in the same tick reuse the ring scan, a structural change refreshes it", () => {
    const h = hut({ walls: ["N", "W"] }); const idx = G.structures(h.w);
    const a = G.shelterPartsAt(h.w, idx, 10, 10, 0); expect(G.shelterPartsAt(h.w, idx, 10, 10, 0)).toBe(a);
    place(h.w, "wall", ...EDGE.E);
    const b = G.shelterPartsAt(h.w, idx, 10, 10, 0); expect(b).not.toBe(a); expect(b.walls).toBeCloseTo(0.75, 5);
  });
});
