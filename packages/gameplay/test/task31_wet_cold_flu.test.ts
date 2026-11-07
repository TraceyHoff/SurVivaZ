/**
 * Task 31: rain wetting, wetness chilling the body, wet clothing insulating less, drying (faster by a fire),
 * cold from sustained low core temperature, untreated cold developing into flu, the 4-minute care cure,
 * character-sheet dry / cure timers, and the flu defs. Bots are player entities on the same spawn path, so
 * the shared exposure / disease systems cover them with the same numbers (pinned in the last test).
 */
import { describe, expect, it } from "vitest";
import { PlayerId, setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { WeatherKind } from "../src/defs.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const SEC = 20;
const slotOf = (w: World, e: Entity, item: number) => G.listSlots(w, e).find((s) => s.item === item)!.slot;
const wear = (w: World, p: Entity, key: string) => { G.addItem(w, p, id(key), 1); G.wearSlot(w, p, slotOf(w, p, id(key))); G.refreshWorn(w, p); };
const wetOf = (w: World, e: Entity) => w.getField(e, G.Exposure, "wetness") ?? 0;
const feltOf = (w: World, e: Entity) => w.getField(e, G.Exposure, "feltTemp") ?? 20;
const bodyOf = (w: World, e: Entity) => w.get(e, G.Survival)!.bodyTemp;
const careOf = (w: World, e: Entity) => w.getField(e, G.Diseases, "careTicks") ?? 0;
const has = (w: World, p: Entity, key: string): boolean => G.hasDisease(w, p, key);
const named = (w: World, x = 0, y = 0) => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); const p = G.spawnPlayer(w, { x, y }); w.add(p, PlayerId, { id: 7 }); return p; };
const sheetFor = (w: World, p: Entity, names = new Map([[7, "Testy"]])) => G.characterSheetView({ world: w, player: p, names })!;
/** Test defs with a 5s cold threshold (like Task 13), so contraction is fast without changing production tuning. */
const testDefs = (): G.GameDefs => {
  const raw = JSON.parse(JSON.stringify(G.DEFAULT_RAW_DEFS)) as G.RawDefs;
  raw.diseases.exposure = { coldSeconds: 5, heatSeconds: 5, sprintSeconds: 3, restSeconds: 2 };
  return G.loadDefs(raw, { lock: G.DEFAULT_ID_LOCK });
};
const rainy = (w: World): void => { setTimeOfDay(w, 12, 1); /* ADR-270: rain starts after day zero */ Object.assign(w.env(Weather), { kind: WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff }); };
const clear = (w: World): void => { Object.assign(w.env(Weather), { kind: WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff }); };

/** A 1-tile room at (10,10): walls on all 4 edges, roof at level 1 (same builder as Task 24). */
function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
}
function place(w: World, b: Entity, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  const sn = snap(w, key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}
function room(w: World, b: Entity, tier = 1) {
  place(w, b, "foundation", 10.5, 10.5);
  place(w, b, "wall", 10.5, 10, { tier }); place(w, b, "wall", 10.5, 11, { tier });
  place(w, b, "wall", 10, 10.5, { tier }); place(w, b, "wall", 11, 10.5, { tier });
  place(w, b, "roof_flat", 10.5, 10.5, { level: 1, tier });
}

describe("Task 31: rain wetting", () => {
  it("rain wets an exposed player but not one inside an enclosed room", () => {
    const w = makeWorld(); rainy(w);
    const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const inside = G.spawnPlayer(w, { x: 10.5, y: 10.5 });
    const outside = G.spawnPlayer(w, { x: 20, y: 10.5 });
    steps(w, 20 * SEC);
    expect(wetOf(w, outside)).toBeCloseTo(0.4, 1); // rain 0.02/s at intensity 1
    expect(wetOf(w, inside)).toBe(0); // roof + walls: exposure 0, no wetting at all
  });

  it("wetness chills felt temperature and drags core body temperature down", () => {
    const w = makeWorld(); clear(w); setSeason(w, 2); setTimeOfDay(w, 0); // winter night: well below comfort
    const wet = G.spawnPlayer(w, { x: 0, y: 0 }); const dry = G.spawnPlayer(w, { x: 20, y: 0 });
    w.setField(wet, G.Exposure, "wetness", 1); w.setField(dry, G.Exposure, "wetness", 0);
    steps(w, 10 * SEC);
    expect(feltOf(w, dry) - feltOf(w, wet)).toBeGreaterThan(3); // wetChill 6C at full wetness
    expect(bodyOf(w, wet)).toBeLessThan(bodyOf(w, dry) - 0.2); // felt gap pulls body temp down faster
    expect(bodyOf(w, dry)).toBeLessThan(37); // even dry, a winter night cools the body
  });

  it("wet clothing insulates less: a wet fur coat warms about half as much", () => {
    const w = makeWorld(); clear(w); setSeason(w, 2); setTimeOfDay(w, 0);
    const wet = G.spawnPlayer(w, { x: 0, y: 0 }); const dry = G.spawnPlayer(w, { x: 20, y: 0 });
    wear(w, wet, "fur_coat"); wear(w, dry, "fur_coat");
    w.setField(wet, G.Exposure, "wetness", 1); w.setField(dry, G.Exposure, "wetness", 0);
    steps(w, 4); // one exposure run recomputes felt
    // dry: ambient + 7C coat; wet: ambient + 3.5C coat - 6C wet chill = 9.5C colder
    expect(feltOf(w, dry) - feltOf(w, wet)).toBeGreaterThan(8);
  });

  it("drying is faster by a fire than in the open (and still happens in clear weather)", () => {
    const w = makeWorld(); clear(w);
    const near = G.spawnPlayer(w, { x: 0, y: 0 }); const far = G.spawnPlayer(w, { x: 30, y: 0 });
    w.setField(near, G.Exposure, "wetness", 0.5); w.setField(far, G.Exposure, "wetness", 0.5);
    G.spawnStation(w, G.StationKind.Campfire, 1, 0); // lit by default
    steps(w, 15 * SEC);
    expect(wetOf(w, near)).toBeLessThan(0.05); // Staged drying: 0.5 dries in ~12s at triple rate
    expect(wetOf(w, far)).toBeGreaterThan(0.25); expect(wetOf(w, far)).toBeLessThan(0.35); // 0.02/s in the open
  });
});

describe("Task 31: cold, flu and the care cure", () => {
  it("sustained low core temperature contracts a cold (the existing cold — wetness feeds it via body temp)", () => {
    const w = makeWorld({ defs: testDefs() });
    const p = G.spawnPlayer(w, { x: 0, y: 0 }); w.set(p, G.Survival, { bodyTemp: 30 });
    steps(w, 6 * SEC);
    expect(has(w, p, "common_cold")).toBe(true);
  });

  it("an untreated cold develops into flu after 300s (and the care clock restarts)", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    // rewind the cold's expiry so it was contracted 300s ago, without stepping 6000 ticks
    const slot = G.diseaseSlot(w, p, d.diseaseIndex("common_cold"));
    const until = w.getArray(p, G.Diseases, "untilTick")!;
    until[slot]! -= 300 * SEC + 1;
    steps(w, 1); // progression fires on the first tick; the flu's care clock restarts and starts ticking
    expect(has(w, p, "common_cold")).toBe(false);
    expect(has(w, p, "influenza")).toBe(true);
    expect(careOf(w, p)).toBe(1);
  });

  it("care cures a cold: 240s dry + fed + hydrated + warm", () => {
    const w = makeWorld(); clear(w); setTimeOfDay(w, 12); // summer noon: felt in the comfort band
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    steps(w, 5 * SEC); // care ticks accumulate naturally while the four conditions hold
    expect(careOf(w, p)).toBeGreaterThanOrEqual(90);
    w.setField(p, G.Diseases, "careTicks", 4700); // 235s banked
    steps(w, 6 * SEC); // +6s = 241s of care, still inside the 300s flu window
    expect(has(w, p, "common_cold")).toBe(false);
    expect(has(w, p, "influenza")).toBe(false);
    expect(careOf(w, p)).toBe(0);
  });

  it("breaking any care condition resets the clock", () => {
    const w = makeWorld(); clear(w); setTimeOfDay(w, 12);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    w.setField(p, G.Diseases, "careTicks", 2000); // 100s banked
    w.setField(p, G.Exposure, "wetness", 0.5); // no longer dry
    steps(w, 4);
    expect(careOf(w, p)).toBe(0);
    expect(has(w, p, "common_cold")).toBe(true); // still sick — the cure was lost, not the disease
  });

  it("the care cure also cures flu, and Honey Tea still cures both", () => {
    const w = makeWorld(); clear(w); setTimeOfDay(w, 12);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "influenza")).toBe(true);
    w.setField(p, G.Diseases, "careTicks", 4700);
    steps(w, 6 * SEC);
    expect(has(w, p, "influenza")).toBe(false);
    // item cure path, untouched: Honey Tea clears flu too
    const q = G.spawnPlayer(w, { x: 20, y: 0 });
    expect(G.contractDisease(w, q, "influenza")).toBe(true);
    G.addItem(w, q, id("honey_tea"), 1);
    expect(G.cureDiseasesForItem(w, q, id("honey_tea"))).toEqual(["influenza"]);
    expect(has(w, q, "influenza")).toBe(false);
  });

  it("defs: flu is the 7th disease, worse than a cold, contagious, cured by Honey Tea", () => {
    expect(d.diseases.map((x) => x.key)).toEqual(["food_poisoning", "dysentery", "common_cold", "heatstroke", "exhaustion", "wound_infection", "influenza", "broken_leg"]);
    const cold = d.diseases.find((x) => x.key === "common_cold")!;
    const flu = d.diseases.find((x) => x.key === "influenza")!;
    expect(flu.hpDps).toBeGreaterThan(cold.hpDps);
    expect(flu.moveMul).toBeLessThan(cold.moveMul);
    expect(flu.staminaDrainPerSec).toBeGreaterThan(cold.staminaDrainPerSec);
    expect(flu.durationSeconds).toBe(900); expect(flu.contagious).toBe(true); expect(flu.cure).toBe("honey_tea");
    expect(d.items.get(id("honey_tea"))!.cures).toEqual(["common_cold", "influenza"]);
  });

  it("bots share the systems: a second player entity wets in rain and catches a cold like the first", () => {
    const w = makeWorld({ defs: testDefs() }); rainy(w);
    const a = G.spawnPlayer(w, { x: 0, y: 0 }); const b = G.spawnPlayer(w, { x: 20, y: 0 });
    w.set(a, G.Survival, { bodyTemp: 30 }); w.set(b, G.Survival, { bodyTemp: 30 });
    steps(w, 20 * SEC);
    expect(wetOf(w, a)).toBeGreaterThan(0.3); expect(wetOf(w, b)).toBeGreaterThan(0.3);
    steps(w, 6 * SEC);
    expect(has(w, a, "common_cold")).toBe(true); expect(has(w, b, "common_cold")).toBe(true);
  });
});

describe("Task 31: character sheet timers", () => {
  it("dry and healthy shows no timers; wet shows dry time; sick shows cure time", () => {
    const w = makeWorld(); clear(w); setTimeOfDay(w, 12);
    const p = named(w);
    let s = sheetFor(w, p);
    expect(s.wetness).toBe(0); expect(s.drySeconds).toBeUndefined(); expect(s.careSecondsLeft).toBeUndefined();
    expect(s.careMissing).toEqual([]); expect(s.diseases).toEqual([]);
    // wet in clear weather: 0.6 crosses Wet and Damp: ~45s to dry
    w.setField(p, G.Exposure, "wetness", 0.6);
    s = sheetFor(w, p);
    expect(s.wetness).toBeCloseTo(0.6, 2);
    expect(s.drySeconds).toBeGreaterThanOrEqual(45); expect(s.drySeconds).toBeLessThanOrEqual(46);
    expect(s.dryByFire).toBe(false);
    // next to a lit campfire the same wetness dries ~3x faster
    G.spawnStation(w, G.StationKind.Campfire, 1, 0);
    steps(w, 8); // emitter index picks the lit fire up
    s = sheetFor(w, p);
    expect(s.dryByFire).toBe(true);
    expect(s.drySeconds).toBeGreaterThanOrEqual(15); expect(s.drySeconds).toBeLessThanOrEqual(16);
    // sick with 120s of care banked: 120s left, nothing missing (dry again after the fire dried us)
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    w.setField(p, G.Exposure, "wetness", 0);
    w.setField(p, G.Diseases, "careTicks", 2400);
    s = sheetFor(w, p);
    expect(s.diseases[0]!.key).toBe("common_cold"); expect(s.diseases[0]!.icon).toBe("ic_snowflake.png");
    expect(s.careSecondsLeft).toBeGreaterThanOrEqual(119); expect(s.careSecondsLeft).toBeLessThanOrEqual(121);
    expect(s.careMissing).toEqual([]);
    // wet while sick: "dry" is missing, and the flu icon is the thermometer
    w.setField(p, G.Exposure, "wetness", 0.5);
    expect(G.contractDisease(w, p, "influenza")).toBe(true);
    s = sheetFor(w, p);
    expect(s.careMissing).toContain("dry");
    expect(s.diseases.find((x) => x.key === "influenza")!.icon).toBe("ic_temp.png");
  });

  it("the sheet shows effective insulation while wet (fur coat: 7C dry, 3.5C soaked)", () => {
    const w = makeWorld(); clear(w);
    const p = named(w);
    wear(w, p, "fur_coat");
    let s = sheetFor(w, p);
    expect(s.insulationClothing).toBeCloseTo(7, 2); expect(s.insulationWet).toBeCloseTo(7, 2);
    w.setField(p, G.Exposure, "wetness", 1);
    s = sheetFor(w, p);
    expect(s.insulationClothing).toBeCloseTo(7, 2); // dry total, unchanged
    expect(s.insulationWet).toBeCloseTo(3.5, 2); // wet clothing insulates half as well
  });
});
