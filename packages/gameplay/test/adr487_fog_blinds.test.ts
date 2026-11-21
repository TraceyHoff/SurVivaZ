/**
 * ADR-487: fog that blinds — fog weather cuts sight. One multiplier in the existing sight checks:
 * zombie sight x 0.5 in Fog, x 0.35 in Blizzard; the same factor on animal aggro/flee ranges.
 * Hearing is untouched, so fog is stealth-vs-sight only. provoker() retaliation range is NOT
 * fogged (acquire() only, v1). Blizzard is weight 0 outside winter, so the 0.35 factor is
 * effectively a winter-only feature.
 *
 * Walker sight is 10: a player 6 tiles away is in sight in clear weather, out of sight in fog
 * (10 x 0.5 = 5), and in sight again at 4 tiles. In a blizzard (10 x 0.35 = 3.5) the same
 * player is out of sight at 4 tiles and in sight at 3.
 * Wolf aggro range is 2.5: a wolf 2 tiles from a player engages in clear weather and does not
 * engage in fog (2.5 x 0.5 = 1.25). Deer flee range is 12: a deer 8 tiles from a player flees
 * in clear weather and does not flee in fog (12 x 0.5 = 6).
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Weather, type Entity } from "@engine/core";
import { spawnPlayer, spawnZombie, ZombieBrain, ZState } from "../src/index.js";
import * as G from "../src/index.js";
import { WeatherKind } from "../src/defs.js";
import { makeWorld, steps } from "./helpers.js";

const hunting = (w: ReturnType<typeof makeWorld>, z: Entity, p: Entity) => {
  const s = w.getField(z, ZombieBrain, "state");
  return (s === ZState.Chase || s === ZState.AttackPlayer) && w.getField(z, ZombieBrain, "target") === p;
};

const setWeather = (w: ReturnType<typeof makeWorld>, kind: WeatherKind) => {
  Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff });
};

describe("ADR-487 fog that blinds", () => {
  it("fogSightFactor is 1 in clear/rain, 0.5 in fog, 0.35 in blizzard", () => {
    const w = makeWorld();
    setWeather(w, WeatherKind.Clear);
    expect(G.fogSightFactor(w)).toBe(1);
    setWeather(w, WeatherKind.Rain);
    expect(G.fogSightFactor(w)).toBe(1);
    setWeather(w, WeatherKind.Fog);
    expect(G.fogSightFactor(w)).toBeCloseTo(0.5, 6);
    setWeather(w, WeatherKind.Blizzard);
    expect(G.fogSightFactor(w)).toBeCloseTo(0.35, 6);
  });

  it("clear night: walker sees a player 6 tiles away (sight 10)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); setWeather(w, WeatherKind.Clear);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 16, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(true);
  });

  it("fog night: the same walker does not see the player 6 tiles away (sight 5)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); setWeather(w, WeatherKind.Fog);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 16, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(false);
  });

  it("fog night: the walker still sees a player 4 tiles away (sight 5)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); setWeather(w, WeatherKind.Fog);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 14, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(true);
  });

  it("blizzard night: the walker does not see a player 4 tiles away (sight 3.5)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); setWeather(w, WeatherKind.Blizzard);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 14, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(false);
  });

  it("blizzard night: the walker still sees a player 3 tiles away (sight 3.5)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); setWeather(w, WeatherKind.Blizzard);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 13, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(true);
  });

  it("clear weather: a wolf 2 tiles from a player engages (aggro 2.5)", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    setTimeOfDay(w, 0, 0); // night: wolves are fully active (ADR-495 activity 1), so this isolates fog
    setWeather(w, WeatherKind.Clear);
    const p = spawnPlayer(w, { x: 400, y: 0 });
    const wolf = G.spawnAnimal(w, "animal_wolf", 402, 0);
    steps(w, 5);
    expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
    void p;
  });

  it("fog: the same wolf does not engage at 2 tiles (aggro 1.25)", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    setTimeOfDay(w, 0, 0); // night: wolves are fully active (ADR-495 activity 1), so this isolates fog
    setWeather(w, WeatherKind.Fog);
    const p = spawnPlayer(w, { x: 400, y: 0 });
    const wolf = G.spawnAnimal(w, "animal_wolf", 402, 0);
    steps(w, 5);
    expect(w.get(wolf, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
    void p;
  });

  it("clear weather: a deer 8 tiles from a player flees (flee 12)", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    setWeather(w, WeatherKind.Clear);
    const p = spawnPlayer(w, { x: 400, y: 0 });
    const deer = G.spawnAnimal(w, "animal_deer", 408, 0);
    steps(w, 5);
    expect(w.get(deer, G.Animal)!.state).toBe(G.AnimalState.Flee);
    void p;
  });

  it("fog: the same deer does not flee at 8 tiles (flee 6)", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    setWeather(w, WeatherKind.Fog);
    const p = spawnPlayer(w, { x: 400, y: 0 });
    const deer = G.spawnAnimal(w, "animal_deer", 408, 0);
    steps(w, 5);
    expect(w.get(deer, G.Animal)!.state).not.toBe(G.AnimalState.Flee);
    void p;
  });
});
