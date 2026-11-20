/**
 * ADR-453: smoke columns (map-marker variant) — a lit campfire / fireplace shows on the map from
 * anywhere as a private "Smoke" marker owned by the fire's owner. The marker appears on light and
 * disappears when the fire goes out or the piece is destroyed. Furnaces/stoves do not qualify.
 * The in-world tall column is NOT built (Tracey decision: map-marker variant only).
 */
import { describe, it, expect } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);

function named(w: World, x: number, y: number, pid: number): Entity {
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x, y });
  w.add(p, PlayerId, { id: pid });
  return p;
}
function place(w: World, b: Entity, key: string, x: number, y: number): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}
const fireOf = (w: World, piece: Entity) => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
function toggleFire(w: World, p: Entity, piece: Entity): void {
  G.setIntent(w, p, { action: G.IntentAction.ToggleFire, target: piece });
  steps(w, 2); // the toggle runs, then the deferred FireToggled delivers
}
function light(w: World, p: Entity, piece: Entity): void {
  const f = fireOf(w, piece);
  G.addItem(w, f, id("coal"), 50);
  toggleFire(w, p, piece);
  expect(w.getField(f, G.Fuel, "lit")).toBe(1);
}
const smokeMarkers = (w: World, p: Entity) => G.visibleMarkers(w, p).filter((m) => m.label === "Smoke");

describe("ADR-453 smoke columns (map-marker variant)", () => {
  it("lighting a campfire places a Smoke marker the owner sees on the map", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const fire = place(w, p, "campfire", 5, 0);
    expect(G.visibleMarkers(w, p)).toEqual([]);
    light(w, p, fire);
    const ms = smokeMarkers(w, p);
    expect(ms.length).toBe(1);
    expect(ms[0]!.visibility).toBe(0); // private: only the owner
    expect(ms[0]!.owner).toBe(7);
    const t = w.get(fire, Transform)!;
    expect(Math.hypot(ms[0]!.x - t.x, ms[0]!.y - t.y)).toBeLessThan(1.5);
  });

  it("snuffing the fire removes the Smoke marker", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const fire = place(w, p, "campfire", 5, 0);
    light(w, p, fire);
    expect(smokeMarkers(w, p).length).toBe(1);
    toggleFire(w, p, fire);
    expect(w.getField(fireOf(w, fire), G.Fuel, "lit")).toBe(0);
    expect(smokeMarkers(w, p)).toEqual([]);
  });

  it("re-lighting does not duplicate the marker", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const fire = place(w, p, "campfire", 5, 0);
    light(w, p, fire);
    toggleFire(w, p, fire);
    light(w, p, fire);
    expect(smokeMarkers(w, p).length).toBe(1);
  });

  it("a lit fireplace qualifies too", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const fire = place(w, p, "fireplace", 5, 0);
    light(w, p, fire);
    expect(smokeMarkers(w, p).length).toBe(1);
  });

  it("a lit furnace does not get a smoke marker", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const station = G.spawnStation(w, G.StationKind.Furnace, 5, 0, { burnSeconds: 600 });
    G.emit(w, G.FireToggled, { entity: station, lit: 1 });
    steps(w, 1);
    expect(smokeMarkers(w, p)).toEqual([]);
  });

  it("destroying the piece removes the Smoke marker", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const fire = place(w, p, "campfire", 5, 0);
    light(w, p, fire);
    expect(smokeMarkers(w, p).length).toBe(1);
    G.emit(w, G.PieceDestroyed, { piece: fire, type: d.pieceId("campfire"), cause: 1 });
    steps(w, 1);
    expect(smokeMarkers(w, p)).toEqual([]);
  });

  it("another player sees none of your smoke (private)", () => {
    const w = makeWorld();
    const p = named(w, 5, 0, 7);
    const other = named(w, 5, 0, 8);
    const fire = place(w, p, "campfire", 5, 0);
    light(w, p, fire);
    expect(smokeMarkers(w, p).length).toBe(1);
    expect(G.visibleMarkers(w, other)).toEqual([]);
  });
});
