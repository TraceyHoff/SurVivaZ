/**
 * ADR-590 electricity tier: power grid (sources, batteries, reach / pylons, brownout), consumer effects
 * (powered stations + speed, light emitters, switch), STRC v7 persistence and the data / unlock wiring.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);
function put(w: World, key: string, x: number, y: number): Entity {
  const def = d.pieces.get(pid(key))!;
  const sn = G.snapPlacement(w, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  if (typeof sn === "number") throw new Error(`${key} snap ${sn}`);
  return G.placePiece(w, 0, sn, { pay: false, tribe: 7 });
}
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
const pw = (w: World, e: Entity) => w.get(e, G.Power)!;
const lightOf = (w: World, p: Entity): number => {
  const a = G.attachmentsOf(w, p).find((x) => w.getField(x, G.PieceLink, "kind") === G.AttachKind.Light)!;
  return w.getField(a, G.Emitter, "strength")!;
};
const solve = (w: World): void => steps(w, G.POWER.everyTicks);

describe("ADR-590 power data", () => {
  it("every power.json piece exists, is crafted from a kit at the electrician's workstation (except the workstation)", () => {
    for (const key of Object.keys(G.POWER.pieces)) {
      const def = d.pieces.get(pid(key)); expect(def, key).toBeDefined();
      if (key === "electrician_workstation") { expect(def!.station).toBe(G.StationKind.Electrician); continue; }
      const kit = [...d.recipes.values()].find((r) => r.output.item === d.itemId(`kit_${key}`));
      expect(kit?.station, key).toBe(G.StationKind.Electrician);
    }
  });
  it("wind curve: nothing below cut-in or above cut-out, full from rated speed", () => {
    expect(G.windFraction(1)).toBe(0); expect(G.windFraction(12)).toBe(1); expect(G.windFraction(31)).toBe(0);
    expect(G.windFraction(6)).toBeGreaterThan(0); expect(G.windFraction(6)).toBeLessThan(1);
  });
});

describe("ADR-590 power grid", () => {
  it("a fuelled generator powers a lamp in reach; out of reach stays dark; fuel burns", () => {
    const w = makeWorld(); steps(w, 1);
    const gen = put(w, "generator_fuel", 10.5, 10.5); const lamp = put(w, "electric_floor_lamp", 13.5, 10.5); const far = put(w, "electric_floor_lamp", 40.5, 10.5);
    solve(w);
    expect(pw(w, lamp).powered).toBe(0); expect(lightOf(w, lamp)).toBe(0);
    G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 2);
    solve(w);
    expect(pw(w, lamp).powered).toBe(1); expect(pw(w, lamp).active).toBe(1); expect(lightOf(w, lamp)).toBe(1);
    expect(pw(w, far).powered).toBe(0);
    expect(pw(w, gen).active).toBe(1); expect(pw(w, lamp).demand).toBe(6); // 60 W in tens
    expect(G.countItem(w, storageOf(w, gen), d.itemId("lamp_oil"))).toBe(1); // one item pulled into the tank
  });
  it("a pylon extends reach; switching the lamp off darkens it", () => {
    const w = makeWorld(); steps(w, 1);
    const gen = put(w, "generator_fuel", 10.5, 10.5); G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 1);
    put(w, "power_pylon", 22.5, 10.5); const lamp = put(w, "electric_floor_lamp", 30.5, 10.5);
    solve(w); expect(pw(w, lamp).powered).toBe(1);
    w.setField(lamp, G.Power, "on", 0); solve(w);
    expect(pw(w, lamp).active).toBe(0); expect(lightOf(w, lamp)).toBe(0);
  });
  it("batteries store the generator's top-up and carry the load when the generator is off", () => {
    const w = makeWorld(); steps(w, 1);
    const gen = put(w, "generator_fuel", 10.5, 10.5); G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 5);
    const bat = put(w, "battery_small", 12.5, 10.5); const lamp = put(w, "electric_floor_lamp", 13.5, 11.5);
    for (let i = 0; i < 30; i++) solve(w);
    const stored = w.getField(bat, G.PowerStore, "stored")!; expect(stored).toBeGreaterThan(0);
    w.setField(gen, G.Power, "on", 0); solve(w);
    expect(pw(w, lamp).powered).toBe(1); expect(w.getField(bat, G.PowerStore, "stored")!).toBeLessThan(stored + 1e-9);
  });
  it("brownout: a short supply powers loads in entity order", () => {
    const w = makeWorld(); steps(w, 1);
    const gen = put(w, "generator_fuel", 10.5, 10.5); G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 3);
    const heaters = [put(w, "electric_heater", 12.5, 10.5), put(w, "electric_heater", 13.5, 10.5), put(w, "electric_heater", 14.5, 10.5)]; // 3 x 1500 W > 3000 W
    solve(w);
    expect(heaters.map((h) => pw(w, h).powered)).toEqual([1, 1, 0]);
  });
  it("an electric stove is a cooking station only while powered, and crafts 1.6x faster", () => {
    const w = makeWorld(); steps(w, 1);
    const p = spawnLearned(w, { x: 12, y: 12 }); w.set(p, Transform, { x: 12, y: 12 });
    const gen = put(w, "generator_fuel", 10.5, 10.5); put(w, "electric_stove", 12.5, 11.5);
    solve(w);
    expect(G.stationInRange(w, p, G.StationKind.Campfire)).toBe(false);
    expect(G.craftSpeedMul(w, p, G.StationKind.Campfire)).toBeCloseTo(G.skillMul(w, p, "speed"));
    G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 2); solve(w);
    expect(G.stationInRange(w, p, G.StationKind.Campfire)).toBe(true);
    expect(G.craftSpeedMul(w, p, G.StationKind.Campfire)).toBeCloseTo(1.6 * G.skillMul(w, p, "speed"));
  });
  it("STRC v7 round-trips the switch and the battery charge", () => {
    const w = makeWorld(); steps(w, 1);
    const bat = put(w, "battery_medium", 10.5, 10.5); const lamp = put(w, "electric_table_lamp", 11.5, 10.5);
    w.setField(bat, G.PowerStore, "stored", 123.5); w.setField(lamp, G.Power, "on", 0);
    const blob = G.encodeStructures(w, 0, 0);
    const w2 = makeWorld(); steps(w2, 1); const out = G.decodeStructures(w2, blob);
    const bat2 = out.pieces.find((e) => w2.getField(e, G.BuildPiece, "type") === pid("battery_medium"))!;
    const lamp2 = out.pieces.find((e) => w2.getField(e, G.BuildPiece, "type") === pid("electric_table_lamp"))!;
    expect(w2.getField(bat2, G.PowerStore, "stored")).toBeCloseTo(123.5); expect(w2.getField(lamp2, G.Power, "on")).toBe(0);
    expect(G.encodeStructures(w2, 0, 0)).toEqual(blob);
  });
  it("toggle command checks reach and privilege", () => {
    const w = makeWorld(); steps(w, 1);
    const p = spawnLearned(w, { x: 30, y: 30 }); const lamp = put(w, "electric_table_lamp", 10.5, 10.5);
    expect(G.checkPowerToggle(w, p, lamp)).toBe("too_far");
    expect(G.checkPowerToggle(w, p, p)).toBe("not_powered_piece");
  });
  it("Use on a lamp flips its switch (never a panel); a fridge still opens as storage; status text is short", () => {
    const w = makeWorld(); steps(w, 1);
    const p = spawnLearned(w, { x: 10, y: 10.5 }); w.set(p, Transform, { x: 10, y: 10.5, facing: 0 });
    const gen = put(w, "generator_fuel", 5.5, 10.5); G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 1);
    const lamp = put(w, "electric_floor_lamp", 11.5, 10.5); solve(w);
    const pick = G.interactPanel({ world: w, player: p } as G.MenuCtx);
    expect(pick).toEqual({ panel: "power", piece: lamp, on: true });
    expect(G.powerStatusText(w, lamp)).toBe("On · 60 W");
    const it = G.powerToggleIntent(lamp, false); expect(it.cmd).toBe(G.PowerToggleCmd); expect(it.args).toEqual({ target: lamp, on: 0 });
    w.setField(lamp, G.Power, "on", 0); expect(G.powerStatusText(w, lamp)).toBe("Off");
    const w2 = makeWorld(); steps(w2, 1); const p2 = spawnLearned(w2, { x: 10, y: 10.5 }); w2.set(p2, Transform, { x: 10, y: 10.5, facing: 0 });
    const f2 = put(w2, "fridge", 11.5, 10.5);
    expect(G.interactPanel({ world: w2, player: p2 } as G.MenuCtx)).toEqual({ panel: "storage", piece: f2 });
  });
  it("a powered fridge keeps food cold (slower spoilage); unpowered it is a plain box", () => {
    const w = makeWorld(); steps(w, 1);
    const fridge = put(w, "fridge", 11.5, 10.5); const box = storageOf(w, fridge);
    const food = [...d.items.values()].find((i) => i.spoilSeconds > 0)!; G.addItem(w, box, food.id, 1);
    solve(w); steps(w, 40);
    const warm = w.getField(box, G.Container, "spoilMul")!;
    const gen = put(w, "generator_fuel", 9.5, 10.5); G.addItem(w, storageOf(w, gen), d.itemId("lamp_oil"), 2);
    solve(w); expect(pw(w, fridge).powered).toBe(1); expect(pw(w, fridge).active).toBe(1); steps(w, 40);
    expect(w.getField(box, G.Container, "spoilMul")!).toBeLessThan(warm * 0.5);
  });
});
