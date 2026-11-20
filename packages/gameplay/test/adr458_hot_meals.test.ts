/**
 * ADR-458: hot meals warm you — a cooked meal eaten where a fire's heat reaches gives a short
 * Insulation buff (+5 for 120 s). Event-driven on eating; insulation only shifts felt temperature
 * toward the comfort band, so it warms in the cold and never overheats in summer. Cooked meat /
 * fish / poultry / stews / pies count; baked potato and bread do not.
 */
import { describe, it, expect } from "vitest";
import { evaluate, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);

function setup(opts: { lit: boolean; item: string; fireAt: { x: number; y: number }; playerAt: { x: number; y: number } }): { w: World; p: Entity } {
  const w = makeWorld();
  const p = G.spawnPlayer(w, { x: opts.playerAt.x, y: opts.playerAt.y });
  G.spawnStation(w, G.StationKind.Campfire, opts.fireAt.x, opts.fireAt.y, { burnSeconds: opts.lit ? 600 : 0 });
  steps(w, 5); // let the emitter index pick the fire up
  G.addItem(w, p, id(opts.item), 1);
  w.set(p, G.Equipment, { mainHandSlot: 0, mainHandItem: id(opts.item) });
  return { w, p };
}
function eat(w: World, p: Entity): void {
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 });
  w.step(1 / 20);
}
const insulation = (w: World, p: Entity): number => evaluate(w, p, G.Buffs, G.Stat.Insulation, 0);

describe("ADR-458 hot meals warm you", () => {
  it("cooked meat by a lit fire gives +5 Insulation", () => {
    const { w, p } = setup({ lit: true, item: "cooked_meat", fireAt: { x: 2, y: 0 }, playerAt: { x: 0, y: 0 } });
    expect(G.heatAt(w, 0, 0)).toBeGreaterThan(0);
    eat(w, p);
    expect(insulation(w, p)).toBe(5);
  });

  it("cooked meat by an unlit fire gives no buff", () => {
    const { w, p } = setup({ lit: false, item: "cooked_meat", fireAt: { x: 2, y: 0 }, playerAt: { x: 0, y: 0 } });
    expect(G.heatAt(w, 0, 0)).toBe(0);
    eat(w, p);
    expect(insulation(w, p)).toBe(0);
  });

  it("baked potato by a lit fire does not count as a hot meal", () => {
    const { w, p } = setup({ lit: true, item: "baked_potato", fireAt: { x: 2, y: 0 }, playerAt: { x: 0, y: 0 } });
    eat(w, p);
    expect(insulation(w, p)).toBe(0);
  });

  it("bread by a lit fire does not count either", () => {
    const { w, p } = setup({ lit: true, item: "bread", fireAt: { x: 2, y: 0 }, playerAt: { x: 0, y: 0 } });
    eat(w, p);
    expect(insulation(w, p)).toBe(0);
  });

  it("cooked meat far from the fire gives no buff", () => {
    const { w, p } = setup({ lit: true, item: "cooked_meat", fireAt: { x: 12, y: 0 }, playerAt: { x: 0, y: 0 } });
    expect(G.heatAt(w, 0, 0)).toBe(0);
    eat(w, p);
    expect(insulation(w, p)).toBe(0);
  });

  it("a stew by the fire counts; the buff expires after 120 s", () => {
    const { w, p } = setup({ lit: true, item: "fish_stew", fireAt: { x: 2, y: 0 }, playerAt: { x: 0, y: 0 } });
    eat(w, p);
    expect(insulation(w, p)).toBe(5);
    steps(w, 121 * 20);
    expect(insulation(w, p)).toBe(0);
  });

  it("hot-meal data: the list and tuning live in vitals.json", () => {
    expect(d.vitals.hotMeals.items).toContain("cooked_meat");
    expect(d.vitals.hotMeals.items).toContain("meat_pie");
    expect(d.vitals.hotMeals.items).not.toContain("baked_potato");
    expect(d.vitals.hotMeals.items).not.toContain("bread");
    expect(d.vitals.hotMeals.insulation).toBe(5);
    expect(d.vitals.hotMeals.seconds).toBe(120);
  });
});
