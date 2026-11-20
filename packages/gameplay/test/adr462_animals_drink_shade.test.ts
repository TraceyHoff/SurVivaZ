/**
 * ADR-462: wild animals drink and seek shade (cosmetic only — no thirst stat, no survival benefit).
 * On the think tick, only near a survivor: water beside the animal -> Drink in place; else walk to the
 * nearest shore within the nav radius and drink on arrival. In rain / a heat wave, an animal already
 * under cover lingers there (point query only — no directed shade search).
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Transform, Weather, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const makeWorld = (): World => { const w = baseWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem); return w; };
function withWater(w: World, x: number, y: number): TileMap {
  const map = new TileMap();
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  map.setTile(x, y, 1); // tile 1 = water (movement.swimTiles)
  return map;
}
function roof(w: World, x: number, y: number): void {
  const place = (key: string, px: number, py: number, o: { level?: number; tier?: number } = {}) => {
    const sn = G.snapPlacement(w, { piece: d.pieceId(key), x: px, y: py, level: o.level ?? 0, rot: 0, tier: o.tier ?? 1, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
    return G.placePiece(w, 0 as Entity, sn, { pay: false });
  };
  place("foundation", x, y);
  place("roof_flat", x, y, { level: 1 });
}
const rainy = (w: World) => { setTimeOfDay(w, 12, 1); Object.assign(w.env(Weather), { kind: G.WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 }); };
const stateOf = (w: World, e: Entity) => w.get(e, G.Animal)!.state;
const animOf = (w: World, e: Entity) => w.getField(e, G.AnimState, "anim");

describe("ADR-462 wild animals drink and seek shade", () => {
  it("findDrinkShore finds the land tile beside water, and nothing without water", () => {
    const w = makeWorld();
    const map = withWater(w, 12, 0);
    expect(G.findDrinkShore(w, 10, 0, 12)).toEqual({ x: 11.5, y: 0.5 });
    expect(G.findDrinkShore(w, 10, 0, 1)).toBeUndefined(); // too far: the shore is 2 tiles out
    void map;
    const dry = makeWorld();
    withWater(dry, 100, 100);
    expect(G.findDrinkShore(dry, 10, 0, 12)).toBeUndefined();
    const noTerrain = makeWorld();
    expect(G.findDrinkShore(noTerrain, 10, 0, 12)).toBeUndefined();
  });

  it("a rabbit near water and near a player drinks (Drink state + Drink anim, on land)", () => {
    const w = makeWorld();
    const map = withWater(w, 12, 0);
    G.spawnPlayer(w, { x: 0, y: 0 }); // 10 tiles out: outside flee range 7, inside near-player 40
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 10, 0);
    let drank = false; let drinkTile = -1;
    for (let i = 0; i < 6000 && !drank; i++) {
      steps(w, 1);
      if (stateOf(w, rabbit) === G.AnimalState.Drink) {
        drank = true;
        const t = w.get(rabbit, Transform)!;
        drinkTile = map.getTile(Math.floor(t.x), Math.floor(t.y));
        expect(animOf(w, rabbit)).toBe(G.Anim.Drink);
      }
    }
    expect(drank).toBe(true);
    expect(drinkTile).not.toBe(1); // drinking happens on land, never in the water
  });

  it("with no player nearby the rabbit never drinks", () => {
    const w = makeWorld();
    withWater(w, 12, 0);
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 10, 0);
    let drank = false;
    for (let i = 0; i < 6000 && !drank; i++) { steps(w, 1); if (stateOf(w, rabbit) === G.AnimalState.Drink) drank = true; }
    expect(drank).toBe(false);
  });

  it("with the player far away (>40 tiles) the rabbit never drinks", () => {
    const w = makeWorld();
    withWater(w, 12, 0);
    G.spawnPlayer(w, { x: 100, y: 0 });
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 10, 0);
    let drank = false;
    for (let i = 0; i < 6000 && !drank; i++) { steps(w, 1); if (stateOf(w, rabbit) === G.AnimalState.Drink) drank = true; }
    expect(drank).toBe(false);
  });

  it("shadeLingerAt: roof + rain lingers, open + rain does not, roof + clear does not", () => {
    const w = makeWorld();
    roof(w, 10.5, 10.5);
    expect(G.shadeLingerAt(w, 10.5, 10.5)).toBe(false); // clear weather: no reason to linger
    rainy(w);
    expect(G.shadeLingerAt(w, 10.5, 10.5)).toBe(true); // under the roof in rain
    expect(G.shadeLingerAt(w, 0, 0)).toBe(false); // out in the open in rain
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    expect(G.shadeLingerAt(w, 10.5, 10.5)).toBe(true); // under the roof in a heat wave
    expect(G.shadeLingerAt(w, 0, 0)).toBe(false);
  });

  it("a roofed rabbit lingers in the rain while an open rabbit wanders off", () => {
    const roofed = makeWorld();
    roof(roofed, 10.5, 10.5);
    G.spawnPlayer(roofed, { x: 0, y: 10.5 });
    const a = G.spawnAnimal(roofed, "animal_rabbit", 10.5, 10.5);
    rainy(roofed);
    let maxD = 0;
    for (let i = 0; i < 1200; i++) { steps(roofed, 1); const t = roofed.get(a, Transform)!; maxD = Math.max(maxD, Math.hypot(t.x - 10.5, t.y - 10.5)); }
    expect(maxD).toBeLessThan(1);

    const open = makeWorld();
    G.spawnPlayer(open, { x: 0, y: 10.5 });
    const b = G.spawnAnimal(open, "animal_rabbit", 10.5, 10.5);
    rainy(open);
    let maxD2 = 0;
    for (let i = 0; i < 1200; i++) { steps(open, 1); const t = open.get(b, Transform)!; maxD2 = Math.max(maxD2, Math.hypot(t.x - 10.5, t.y - 10.5)); }
    expect(maxD2).toBeGreaterThan(2);
  });

  it("drink tuning lives in ai.json", () => {
    const t = G.animalDrinkTuning();
    expect(t.chance).toBe(0.2);
    expect(t.radius).toBe(12);
    expect(t.nearPlayerTiles).toBe(40);
    expect(t.drinkSeconds).toEqual([3, 6]);
  });
});
