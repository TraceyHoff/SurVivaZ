import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

/** ADR-519: every vehicle carries a paint pick (Vehicle.paint 1..240): varied at spawn, persisted, legacy 0 gets one. */
describe("ADR-519 Vehicle.paint", () => {
  it("spawned vehicles get a varied paint pick in 1..VEHICLE_PAINT_PICKS", () => {
    const w = makeWorld(); const picks = new Set<number>();
    for (let i = 0; i < 24; i++) { const v = G.spawnVehicle(w, "car_sedan", 10 + i * 7, 10 + (i % 3) * 5, 0); const p = w.getField(v, G.Vehicle, "paint")!;
      expect(p).toBeGreaterThanOrEqual(1); expect(p).toBeLessThanOrEqual(G.VEHICLE_PAINT_PICKS); picks.add((p - 1) % 12); }
    expect(picks.size).toBeGreaterThanOrEqual(6);
    expect(G.VEHICLE_PAINT_PICKS % 12).toBe(0); expect(G.VEHICLE_PAINT_PICKS % 10).toBe(0);
  });
  it("a vehicle loaded without paint (legacy save: 0) is painted on the next vehicle tick", () => {
    const w = makeWorld(); const v = G.spawnVehicle(w, "car_sedan", 20, 20, 0); w.setField(v, G.Vehicle, "paint", 0);
    expect(w.has(v, Transform)).toBe(true); steps(w, 25);
    expect(w.getField(v, G.Vehicle, "paint")).toBeGreaterThan(0);
  });
});
