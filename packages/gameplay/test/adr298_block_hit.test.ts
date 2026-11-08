/** ADR-298: a blow that lands on a held guard plays block_hit, then returns to Block if still guarding. */
import { describe, expect, it } from "vitest";
import { NetId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

let nid = 2000;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const mk = (w: World, x = 0, y = 0, id = 1): Entity => net(w, G.spawnPlayer(w, { x, y, clientId: id }));
const IN: G.StanceInput = { guard: false, crouch: false, carry: false, rest: false, interact: false, active: false };
const inp = (w: World, e: Entity, o: Partial<G.StanceInput> = {}): void => G.applyStanceInput(w, e, { ...IN, ...o });

describe("ADR-298 block_hit react", () => {
  it("appends a wire-stable BlockHit state after Sleep", () => {
    expect(G.Anim.Block).toBe(20);
    expect(G.Anim.BlockHit).toBe(25);
    expect(G.ANIM_STATE_NAMES[25]).toBe("block_hit");
  });

  it("plays block_hit on a frontal blocked melee hit, then returns to Block if still guarding", () => {
    const w = makeWorld(); const p = mk(w, 0, 0, 1); const z = mk(w, 1, 0, 2);
    w.setField(p, Transform, "facing", 0);
    w.setField(p, G.Health, "hp", 100); w.setField(p, G.Health, "max", 100);
    inp(w, p, { guard: true });
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Block);
    G.applyDamage(w, p, 10, z);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(100 - 10 * (1 - G.STANCE.blockMeleeReduction), 1);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.BlockHit);
    // applyDamage ran outside step(), so the next step's animSettle still sees delta 0 (same as a mid-tick hit).
    steps(w, G.PLAYER_ONE_SHOT_TICKS);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.BlockHit);
    steps(w, 1);
    expect(G.stanceMode(w, p)).toBe(G.StanceMode.Block);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Block);
  });

  it("does not play block_hit for a hit from behind, and returns to Idle if the guard is released", () => {
    const w = makeWorld(); const p = mk(w, 0, 0, 1); const z = mk(w, 1, 0, 2);
    w.setField(p, Transform, "facing", Math.PI);
    w.setField(p, G.Health, "hp", 100); w.setField(p, G.Health, "max", 100);
    inp(w, p, { guard: true });
    G.applyDamage(w, p, 10, z);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Hurt);
    w.setField(p, Transform, "facing", 0); w.setField(p, G.Health, "hp", 100);
    inp(w, p, { guard: true });
    G.applyDamage(w, p, 10, z);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.BlockHit);
    inp(w, p); // release
    expect(G.stanceMode(w, p)).toBe(G.StanceMode.None);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Idle);
  });

  it("plays the same react for an AI human", () => {
    const w = makeWorld(); const p = mk(w, 0, 0, 1); const z = mk(w, 1, 0, 2);
    G.setAiHumanPredicate(w, (e) => e === p);
    w.setField(p, Transform, "facing", 0);
    w.setField(p, G.Health, "hp", 100); w.setField(p, G.Health, "max", 100);
    inp(w, p, { guard: true });
    G.applyDamage(w, p, 10, z);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.BlockHit);
    steps(w, G.PLAYER_ONE_SHOT_TICKS + 1);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Block);
  });
});
