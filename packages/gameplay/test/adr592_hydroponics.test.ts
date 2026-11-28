/**
 * ADR-592 hydroponic tables: two soil spots, year-round growth while powered and warm (no water / light / season
 * rule), tray fertilizer auto-dose, bigger harvest; unpowered it is an ordinary planter.
 */
import { describe, expect, it } from "vitest";
import { setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
function put(w: World, key: string, x: number, y: number): Entity {
  const def = d.pieces.get(d.pieceId(key))!;
  const sn = G.snapPlacement(w, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  if (typeof sn === "number") throw new Error(`${key} snap ${sn}`);
  return G.placePiece(w, 0, sn, { pay: false, tribe: 3 });
}
const soilsNear = (w: World, x: number, y: number): Entity[] => [...w.query([G.Crop])].filter((e) => { const t = w.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y) < 1.2; });
const crop = G.FARMING.plantables.findIndex((p) => p.type === "crop") + 1;

function rig(powered: boolean): { w: World; table: Entity; soils: Entity[] } {
  const w = makeWorld(); steps(w, 1); setTimeOfDay(w, 1); // night: no sun
  const table = put(w, "hydroponic_table", 10.5, 10.5);
  if (powered) { const gen = put(w, "generator_fuel", 7.5, 10.5); G.addItem(w, G.resolveAttachment(w, gen, G.AttachKind.Storage)!, d.itemId("lamp_oil"), 5); }
  const soils = soilsNear(w, 10.5, 10.5);
  for (const s of soils) w.set(s, G.Crop, { kind: crop, stage: 0, growth: 0, waterUntilTick: 0 });
  return { w, table, soils };
}

describe("ADR-592 hydroponic tables", () => {
  it("a table carries two soil spots, both inside the planter", () => {
    const { w, soils } = rig(false); expect(soils.length).toBe(2);
    for (const s of soils) { const t = w.get(s, Transform)!; expect(G.inPlanter(w, t.x, t.y)).toBe(true); }
  });
  it("powered and warm: grows at night without watering, and pulls fertilizer from the tray", () => {
    const { w, table, soils } = rig(true);
    const tray = G.resolveAttachment(w, table, G.AttachKind.Storage)!; G.addItem(w, tray, d.itemId("fertilizer"), 1);
    const t = G.hydroTempC(w, 10.5, 10.5); expect(t).toBeGreaterThanOrEqual(G.HYDRO.tempMinC); expect(t).toBeLessThanOrEqual(G.HYDRO.tempMaxC);
    steps(w, 200);
    expect(w.getField(table, G.Power, "powered")).toBe(1);
    expect(soils.some((s) => !w.isAlive(s) || (w.getField(s, G.Crop, "growth") ?? 0) > 0)).toBe(true);
    expect(G.countItem(w, tray, d.itemId("fertilizer"))).toBe(0);
    expect(G.plantNeed(w, soils.find((s) => w.isAlive(s))!)).toBe("growing");
  });
  it("unpowered: an ordinary planter (no water at night -> no growth)", () => {
    const { w, soils } = rig(false); steps(w, 200);
    for (const s of soils) expect(w.getField(s, G.Crop, "growth") ?? 0).toBe(0);
  });
  it("the hydroponic yield multiplier and disease resistance come from power.json", () => {
    expect(G.HYDRO.yieldMul).toBeGreaterThan(1); expect(G.hydroDiseaseResist()).toBe(1);
    expect(G.hydroSpots(0)).toEqual([[-0.5, 0], [0.5, 0]]); expect(G.hydroSpots(1)).toEqual([[0, -0.5], [0, 0.5]]);
  });
});
