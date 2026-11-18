// ADR-136: personal crafting shows only hand recipes; station recipes appear only at that station; server enforces range.
import { describe, expect, it } from "vitest";
import { CommandRegistry, CommandRejected, installCommandHandlers, Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps, spawnLearned } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string) => d.itemId(k);
const KINDS = Object.keys(G.STATION_NAMES).map(Number); // ADR-420: dock 6 + shipyard 7 — derived, so a new station cannot go untagged
function setup() { const w = makeWorld(); G.installCraftQueue(w); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }); return { w, p, c: { world: w, player: p } }; }

describe("ADR-136 station crafting split", () => {
  it("every recipe carries a known station tag", () => {
    for (const r of d.recipes.values()) expect(KINDS, r.key).toContain(r.station);
    const by = (k: string) => d.recipes.get(d.recipeId(k))!.station;
    expect(by("stone_axe")).toBe(0); expect(by("rope")).toBe(0); expect(by("trail_mix")).toBe(0);
    expect(by("planks")).toBe(2); expect(by("thread_from_wool")).toBe(2); expect(by("flour_from_wheat")).toBe(2);
    expect(by("cooked_meat")).toBe(1); expect(by("iron_ingot")).toBe(3); expect(by("iron_sword")).toBe(4);
  });
  it("personal menu lists ONLY hand recipes and counts the rest per station", () => {
    const { c } = setup(); const v = G.craftingView(c);
    expect(v.station).toBe(0); expect(v.recipes.length).toBeGreaterThan(0);
    expect(v.recipes.every((r) => r.station === 0)).toBe(true);
    const hidden = v.elsewhere.reduce((a, e) => a + e.count, 0);
    expect(v.recipes.length + hidden).toBe(d.recipes.size);
    expect(v.elsewhere.map((e) => e.station)).not.toContain(0);
  });
  it("a station panel lists ONLY that station's recipes", () => {
    const { c } = setup();
    for (const k of [1, 2, 3, 4]) { const v = G.craftingView(c, k); expect(v.recipes.length, `kind ${k}`).toBeGreaterThan(0); expect(v.recipes.every((r) => r.station === k)).toBe(true); expect(v.stationName).toBe(G.STATION_NAMES[k]); }
    expect(G.craftingView(c, -1).recipes.length).toBe(d.recipes.size); // camper station filters the full list itself
  });
  it("Interact near a station opens its panel; far away it does not", () => {
    const { w, p, c } = setup(); const wb = G.spawnStation(w, 2, 1, 0);
    expect(G.interactPanel(c)).toEqual({ panel: "station", station: wb, kind: 2 });
    w.set(p, Transform, { x: 20, y: 0 }); expect(G.interactPanel(c)).toBeUndefined();
  });
  it("server enforces station proximity at queue time and pauses when the crafter walks away", () => {
    const { w, p } = setup(); const planks = d.recipeId("planks"); G.addItem(w, p, id("wood"), 20);
    expect(G.craftQueueReason(w, p, planks, 1)).toBe("no_station");
    expect(G.enqueueCraft(w, p, planks, 1)).toBe("no_station"); expect(G.countItem(w, p, id("wood"))).toBe(20);
    G.spawnStation(w, 2, 1, 0);
    expect(G.craftQueueReason(w, p, planks, 1)).toBeUndefined();
    expect(G.enqueueCraft(w, p, planks, 2)).toBe(0);
    w.set(p, Transform, { x: 30, y: 0 }); steps(w, 400);
    expect(G.countItem(w, p, id("planks"))).toBe(0); // paused out of range
    w.set(p, Transform, { x: 0, y: 0 }); steps(w, 400);
    expect(G.countItem(w, p, id("planks"))).toBeGreaterThan(0);
  });
  it("unlit fired stations do not count; hand recipes need no station", () => {
    const { w, p } = setup(); G.spawnStation(w, 1, 1, 0, { burnSeconds: 0 }); G.addItem(w, p, id("raw_meat"), 2);
    expect(G.craftQueueReason(w, p, d.recipeId("cooked_meat"), 1)).toBe("no_station");
    G.addItem(w, p, id("fiber"), 4); expect(G.craftQueueReason(w, p, d.recipeId("rope"), 1)).toBeUndefined();
  });
  it("QueueCraftCmd through command handlers rejects a station recipe without a station", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }); G.addItem(w, p, id("wood"), 4);
    const reg = G.registerGameplayCommands(new CommandRegistry()); const h = installCommandHandlers(w, reg); G.installCraftQueue(w, h);
    const rej: string[] = []; w.events.on(CommandRejected, (e) => rej.push(e.reason));
    h.enqueue(p, 1, 1, reg.make(G.QueueCraftCmd, { recipe: d.recipeId("planks"), count: 1 })); w.step(1 / 20);
    expect(rej).toEqual(["no_station"]); expect(G.countItem(w, p, id("wood"))).toBe(4);
  });
});
