/**
 * Task 24: flame heat warms enclosed rooms slowly (RoomHeat), outdoor cold damage 0-10F unless the player wears
 * enough insulation, the campfire-heat exclusion for heat damage (Task 23 left it untested), and a sealed room
 * with a roaring fire that can overheat. The hair/face tint contract lives in render (faceVisibleDirs.test.ts).
 */
import { describe, expect, it } from "vitest";
import { PlayerId, setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps, DT } from "./helpers.js";
import { ambientTemperature, shelteredAirTemp } from "../src/systems/environment.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);
const SEC = 20;
const slotOf = (w: World, e: Entity, item: number) => G.listSlots(w, e).find((s) => s.item === item)!.slot;
const wear = (w: World, p: Entity, key: string) => { G.addItem(w, p, id(key), 1); G.wearSlot(w, p, slotOf(w, p, id(key))); G.refreshWorn(w, p); };

/** A 1-tile room at (10,10): walls on all 4 edges, roof at level 1 (same builder as Task 5 / Task 23). */
type Ent = ReturnType<typeof G.spawnPlayer>;
function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
}
function place(w: World, b: Ent, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  const sn = snap(w, key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}
function room(w: World, b: Ent, tier = 1) {
  place(w, b, "foundation", 10.5, 10.5);
  place(w, b, "wall", 10.5, 10, { tier }); place(w, b, "wall", 10.5, 11, { tier });
  place(w, b, "wall", 10, 10.5, { tier }); place(w, b, "wall", 11, 10.5, { tier });
  place(w, b, "roof_flat", 10.5, 10.5, { level: 1, tier });
}
const fireOf = (w: World, piece: Entity) => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
function light(w: World, piece: Entity, item = "coal", n = 50): Entity {
  const f = fireOf(w, piece); G.addItem(w, f, d.itemId(item), n); w.set(f, G.Fuel, { lit: 1, burnUntilTick: 0 }); G.setEmittersLit(w, f, 1); G.invalidateLightGrid(w); return f;
}
function snuff(w: World, f: Entity): void { w.set(f, G.Fuel, { lit: 0, burnUntilTick: 0 }); G.setEmittersLit(w, f, 0); G.invalidateLightGrid(w); }
const roomHeatOf = (w: World, e: Entity) => w.getField(e, G.RoomHeat, "heat") ?? 0;
const feltOf = (w: World, e: Entity) => w.getField(e, G.Exposure, "feltTemp") ?? 20;
const named = (w: World, x = 0, y = 0) => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); const p = G.spawnPlayer(w, { x, y }); w.add(p, PlayerId, { id: 7 }); return p; };
const sheetFor = (w: World, p: Entity, names = new Map([[7, "Testy"]])) => G.characterSheetView({ world: w, player: p, names })!;

describe("Task 24 room heat (approach)", () => {
  it("approachRoomHeat eases exponentially: 63% in one time constant, symmetric cooling", () => {
    expect(G.FIRE_HEAT_TAU_S).toBe(120); // 2 minutes to 63% — a slow rise/fall, not an instant jump
    expect(G.FIRE_HEAT_MAX_C).toBe(15);
    expect(G.approachRoomHeat(0, 15, 120)).toBeCloseTo(15 * (1 - Math.exp(-1)), 6);
    expect(G.approachRoomHeat(10, 0, 120)).toBeCloseTo(10 * Math.exp(-1), 6);
    expect(G.approachRoomHeat(5, 15, 0)).toBe(5);
    expect(G.approachRoomHeat(15, 15, 60)).toBe(15);
  });
});

describe("Task 24 a lit fire warms an enclosed room slowly", () => {
  const winterRoom = () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 2, 1.5); setTimeOfDay(w, 12); // winter noon: ambient ~-2.4C, indoor base clamps to 8C
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    return { w, p };
  };
  it("a lit campfire inside the room raises RoomHeat and the felt temperature over a minute", () => {
    const { w, p } = winterRoom();
    const camp = place(w, spawnLearned(w, { x: 10.5, y: 10.5 }), "campfire", 10.5, 10.5);
    light(w, camp);
    steps(w, SEC); // the emitter index picks the lit fire up on the first step
    expect(G.heatAt(w, 10.5, 10.5)).toBeGreaterThan(10); // the fire's heat reaches the player (no wall between)
    steps(w, 59 * SEC);
    const heat = roomHeatOf(w, p);
    expect(heat).toBeGreaterThan(3); expect(heat).toBeLessThan(8); // ~5.9C after 60s (tau 120s, cap 15C)
    expect(feltOf(w, p)).toBeGreaterThan(11); // clamped indoor base 8C + room heat
    // the gauge shows the warmed room (the sheet's indoor temperature is covered in its own test below)
    expect(shelteredAirTemp(w, 10.5, 10.5, 0, undefined, heat).temp).toBeGreaterThan(ambientTemperature(w, 10.5, 10.5) + 1);
  });
  it("the room cools back down when the fire goes out", () => {
    const { w, p } = winterRoom();
    const camp = place(w, spawnLearned(w, { x: 10.5, y: 10.5 }), "campfire", 10.5, 10.5);
    const f = light(w, camp);
    steps(w, 60 * SEC);
    const peak = roomHeatOf(w, p); expect(peak).toBeGreaterThan(3);
    snuff(w, f);
    steps(w, 120 * SEC); // two minutes out: ~37% of the peak remains (tau 120s)
    expect(roomHeatOf(w, p)).toBeLessThan(peak * 0.45);
    expect(roomHeatOf(w, p)).toBeGreaterThan(0); // still cooling, not instantly cold
  });
  it("a fire outside the room does not warm it (walls occlude heat)", () => {
    const { w, p } = winterRoom();
    const camp = place(w, spawnLearned(w, { x: 10.5, y: 10.5 }), "campfire", 14, 10.5);
    light(w, camp);
    expect(G.heatAt(w, 10.5, 10.5)).toBeLessThan(1); // the east wall blocks the fire's heat
    steps(w, 30 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
  it("outdoors a fire warms the player instantly but RoomHeat stays 0", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    setSeason(w, 2, 1.5); setTimeOfDay(w, 12);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    const camp = place(w, spawnLearned(w, { x: 0, y: 0 }), "campfire", 0.5, 0.5);
    light(w, camp);
    const ambient = ambientTemperature(w, 0, 0);
    steps(w, 5 * SEC);
    expect(roomHeatOf(w, p)).toBe(0);
    expect(feltOf(w, p)).toBeGreaterThan(ambient + 5); // instant fire heat, no smoothing outdoors
  });
  it("the character sheet's indoor temperature rises with the room heat", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = named(w, 10.5, 10.5);
    setSeason(w, 2, 1.5); setTimeOfDay(w, 12);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    const before = sheetFor(w, p);
    expect(before.enclosed).toBe(true);
    const camp = place(w, b, "campfire", 10.5, 10.5); light(w, camp);
    steps(w, 60 * SEC);
    const after = sheetFor(w, p);
    expect(after.indoorC).toBeGreaterThan(before.indoorC + 2);
    expect(after.indoorC).toBeGreaterThan(after.ambientC + 1);
  });
});

describe("Task 24 heat damage vs fire heat", () => {
  it("a sealed room with a roaring fire can overheat in a heat wave", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    const camp = place(w, b, "campfire", 10.5, 10.5); light(w, camp);
    const hp0 = w.get(p, G.Health)!.hp;
    steps(w, 30 * SEC); // Room warms, but body is not yet at the damaging tier.
    expect(w.get(p, G.Health)!.hp).toBe(hp0);
    expect(feltOf(w, p)).toBeGreaterThan(32);
    w.setField(p, G.Survival, "bodyTemp", 39);
    steps(w, SEC);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(hp0);
  });
  it("standing by a campfire outdoors on a hot (not heat-wave) day does not hurt (Task 23 cut, now covered)", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 12); // clear summer noon ~85F: air itself is below 90F
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    expect(ambientTemperature(w, 0, 0)).toBeLessThan(G.HEAT_DAMAGE_ABOVE_C);
    const camp = place(w, spawnLearned(w, { x: 0, y: 0 }), "campfire", 0.5, 0.5); light(w, camp);
    steps(w, 5 * SEC);
    expect(feltOf(w, p)).toBeGreaterThan(40); // the fire's heat is really there on the felt temperature
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max); // ...but it is not punished as weather
  });
});

describe("Task 24 outdoor cold damage 0-10F", () => {
  /** Winter midnight, clear: ambient 9.1F — inside the 0-10F band. */
  const coldWorld = (kind = G.WeatherKind.Clear) => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    setSeason(w, 2, 1.5); setTimeOfDay(w, 0);
    Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff });
    const ambient = ambientTemperature(w, 0, 0);
    expect(ambient).toBeGreaterThanOrEqual(G.COLD_DAMAGE_LO_C);
    expect(ambient).toBeLessThanOrEqual(G.COLD_DAMAGE_HI_C);
    return { w, p, ambient };
  };
  it("the band and the insulation threshold are the exact Fahrenheit / sheet values", () => {
    expect(G.COLD_DAMAGE_LO_C).toBeCloseTo((0 - 32) * 5 / 9, 9);
    expect(G.COLD_DAMAGE_HI_C).toBeCloseTo((10 - 32) * 5 / 9, 9);
    expect(G.COLD_DAMAGE_INSULATION_C).toBe(10); // fur coat (7) + fur hat (3); a leather set is 8.5
  });
  it("ADR-277: 9F progresses body temperature without early direct damage", () => {
    const { w, p } = coldWorld();
    const hp0 = w.get(p, G.Health)!.hp;
    steps(w, 5 * SEC); // Warnings, not damage, before the final tier.
    expect(w.get(p, G.Health)!.hp).toBe(hp0);
    expect(w.get(p, G.Survival)!.bodyTemp).toBeGreaterThan(35); // not the slow hypothermia rule
  });
  it("ADR-277: blizzard midnight also has no early direct damage", () => {
    const { w, p } = coldWorld(G.WeatherKind.Blizzard);
    const hp0 = w.get(p, G.Health)!.hp;
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(hp0);
  });
  it("fur coat + fur hat (insulation exactly 10) blocks the damage", () => {
    const { w, p } = coldWorld();
    wear(w, p, "fur_coat"); wear(w, p, "fur_hat");
    expect(w.getField(p, G.Exposure, "insulation")).toBe(10);
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max);
  });
  it("ADR-277: leather reduces drift without a binary insulation damage cutoff", () => {
    const { w, p } = coldWorld();
    for (const k of ["leather_cap", "leather_jacket", "leather_trousers", "leather_boots", "leather_gloves"]) wear(w, p, k);
    expect(w.getField(p, G.Exposure, "insulation")).toBeCloseTo(8.5, 6);
    const hp0 = w.get(p, G.Health)!.hp;
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(hp0);
  });
  it("an enclosed room protects in the same weather", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 2, 1.5); setTimeOfDay(w, 0);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    expect(ambientTemperature(w, 10.5, 10.5)).toBeGreaterThanOrEqual(G.COLD_DAMAGE_LO_C);
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max);
    expect(feltOf(w, p)).toBeGreaterThanOrEqual(8); // felt clamped to the comfort band indoors
  });
});
