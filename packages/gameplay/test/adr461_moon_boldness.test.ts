/**
 * ADR-461: moon phases — full-moon nights make zombies bolder. Brightness already ships in both
 * renderers, so this ADR is the boldness half only: sight range x(1 + 0.25 * illumination), i.e. +25%
 * at full moon, x1 at new moon. Light avoidance is NOT weakened.
 *
 * Walker sight is 10: a player 11 tiles away is out of sight on a new-moon night and in sight on a
 * full-moon night. Day 0 is a new moon (illumination 0); day 15 is ~full (illumination ~0.999).
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, type Entity } from "@engine/core";
import { Health, spawnPlayer, spawnZombie, ZombieBrain, ZState } from "../src/index.js";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const hunting = (w: ReturnType<typeof makeWorld>, z: Entity, p: Entity) => {
  const s = w.getField(z, ZombieBrain, "state");
  return (s === ZState.Chase || s === ZState.AttackPlayer) && w.getField(z, ZombieBrain, "target") === p;
};

describe("ADR-461 moon phases", () => {
  it("moonIllumination is 0 at new moon and ~1 at full moon", () => {
    expect(G.moonIllumination(0)).toBeCloseTo(0, 6);
    expect(G.moonIllumination(15)).toBeGreaterThan(0.99);
    expect(G.moonIllumination(29.53)).toBeCloseTo(0, 6);
  });

  it("new-moon night: walker does not see a player 11 tiles away (sight 10)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 21, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(false);
  });

  it("full-moon night: the same walker sees the player 11 tiles away (sight 12.5)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 15);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 21, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(true);
  });

  it("full moon does not extend sight past 12.5 for a walker (player at 14 stays unseen)", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 15);
    const p = spawnPlayer(w, { x: 10, y: 10 });
    const z = spawnZombie(w, "zombie_walker", 24, 10);
    steps(w, 20);
    expect(hunting(w, z, p)).toBe(false);
  });

  it("moonSightFactor is 1 at new moon and 1.25 at full moon", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    expect(G.moonSightFactor(w)).toBeCloseTo(1, 6);
    setTimeOfDay(w, 0, 15);
    expect(G.moonSightFactor(w)).toBeCloseTo(1.25, 2);
  });
});
