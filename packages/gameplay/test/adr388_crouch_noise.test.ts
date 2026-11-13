/**
 * ADR-388: quieter crouching for players and AI humans. Action noise already went through makeNoise
 * (x crouchNoiseMul). Walking did not raise NoiseLevel, so sneak was almost silent-or-not at all.
 * Movement now emits walk / sprint / swim noise; crouch still multiplies every makeNoise source.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, DT } from "./helpers.js";

const { STANCE } = G;
const mk = (w: World, x = 0, y = 0, id = 1): Entity => G.spawnPlayer(w, { x, y, clientId: id });
const IN: G.StanceInput = { guard: false, crouch: false, carry: false, rest: false, interact: false, active: false };
const inp = (w: World, e: Entity, o: Partial<G.StanceInput> = {}): void => G.applyStanceInput(w, e, { ...IN, ...o });
const noiseOf = (w: World, e: Entity): number => w.getField(e, G.NoiseLevel, "value") ?? 0;
const walk = (w: World, e: Entity, n = 4, actions = G.GameplayActions.MoveRight): void => {
  for (let i = 0; i < n; i++) G.applyMovementInput(w, e, actions, DT);
};

describe("ADR-388 quieter crouch: every makeNoise source", () => {
  it("crouch multiplies gather, build, attack, structureHit and door the same as the stance table", () => {
    const n = G.defaultDefs().noise;
    expect(STANCE.crouchNoiseMul).toBe(0.4);
    for (const amount of [n.gather, n.build, n.attack, n.structureHit, n.door, n.walk, n.sprint, n.swim]) {
      const stand = makeWorld(); const a = mk(stand); G.makeNoise(stand, a, amount);
      const crouch = makeWorld(); const b = mk(crouch); inp(crouch, b, { crouch: true }); G.makeNoise(crouch, b, amount);
      expect(noiseOf(stand, a)).toBeCloseTo(amount, 5);
      expect(noiseOf(crouch, b)).toBeCloseTo(amount * STANCE.crouchNoiseMul, 5);
    }
  });

  it("walking raises walk noise; standing still does not; crouch walk is quieter", () => {
    const n = G.defaultDefs().noise;
    expect(n.walk).toBe(12); expect(n.sprint).toBe(18); expect(n.swim).toBe(7);
    const stand = makeWorld(); const a = mk(stand, 2, 2);
    G.applyMovementInput(stand, a, 0, DT);
    expect(noiseOf(stand, a)).toBe(0);
    walk(stand, a, 6);
    expect(noiseOf(stand, a)).toBeCloseTo(n.walk, 5);
    expect(stand.get(a, Transform)!.x).toBeGreaterThan(2);

    const crouch = makeWorld(); const b = mk(crouch, 2, 2);
    inp(crouch, b, { crouch: true });
    walk(crouch, b, 6);
    expect(G.isCrouched(crouch, b)).toBe(true);
    expect(noiseOf(crouch, b)).toBeCloseTo(n.walk * STANCE.crouchNoiseMul, 5);
    expect(noiseOf(crouch, b)).toBeLessThan(noiseOf(stand, a));
  });

  it("a crouched player cannot sprint, so movement noise stays walk x crouch", () => {
    const n = G.defaultDefs().noise;
    const c = makeWorld(); const q = mk(c, 2, 2);
    inp(c, q, { crouch: true });
    c.setField(q, G.Survival, "stamina", 100);
    for (let i = 0; i < 100; i++) G.applyMovementInput(c, q, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, DT);
    expect(c.getField(q, G.PlayerIntent, "sprint")).toBe(0);
    expect(noiseOf(c, q)).toBeCloseTo(n.walk * STANCE.crouchNoiseMul, 5);
  });

  it("swimming emits swim noise, quieter when crouched", () => {
    const n = G.defaultDefs().noise;
    const lake = (tx: number): number => (tx >= 0 && tx < 20 ? 1 : 3);
    const world = (): World => { const w = makeWorld(); w.setResource(G.TerrainRes, { tileAt: (tx: number) => lake(tx), heightAt: () => 0 }); return w; };
    const stand = world(); const a = mk(stand, 10.5, 5.5);
    walk(stand, a, 6);
    expect(noiseOf(stand, a)).toBeCloseTo(n.swim, 5);

    const crouch = world(); const b = mk(crouch, 10.5, 5.5);
    inp(crouch, b, { crouch: true });
    walk(crouch, b, 6);
    expect(noiseOf(crouch, b)).toBeCloseTo(n.swim * STANCE.crouchNoiseMul, 5);
  });

  it("the same walk is deterministic", () => {
    const run = (): number => {
      const w = makeWorld(); const p = mk(w, 3, 3);
      walk(w, p, 8);
      return noiseOf(w, p);
    };
    expect(run()).toBe(run());
  });
});

describe("ADR-388 AI humans sneak-crouch and are quieter", () => {
  it("a crouched AI human (same Survival + Stance + applyMovementInput funnel) walks quieter", () => {
    const n = G.defaultDefs().noise;
    const w = makeWorld();
    const bot = mk(w, 4, 4, 9); // AI humans are virtual players sharing this rig
    inp(w, bot, { crouch: true });
    expect(G.isCrouched(w, bot)).toBe(true);
    walk(w, bot, 6);
    expect(noiseOf(w, bot)).toBeCloseTo(n.walk * STANCE.crouchNoiseMul, 5);
  });

  it("players, AI humans and hired workers all get Anim.Crouch so the live doll can pick crouch frames", () => {
    const w = makeWorld();
    const player = mk(w, 1, 1, 1);
    const bot = mk(w, 2, 2, 2);
    const hired = mk(w, 3, 3, 3);
    w.add(hired, G.Worker, { owner: 1, wantedItem: 0, job: 0, homeX: 3, homeY: 3 });
    for (const e of [player, bot, hired]) {
      inp(w, e, { crouch: true });
      expect(G.isCrouched(w, e)).toBe(true);
      expect(w.getField(e, G.AnimState, "anim")).toBe(G.Anim.Crouch);
    }
  });
});
