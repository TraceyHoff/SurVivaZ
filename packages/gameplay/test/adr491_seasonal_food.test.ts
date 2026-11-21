/**
 * ADR-491: wild food follows the seasons. Seasonal yields (wild fruit, mushrooms, herbs) give
 * nothing while crops are dormant (last day of Fall + all of Winter, the isCropDormant rule).
 * The plain `berries` yield is exempt (dye -> Claim Flag chain); wild food-crop nodes carry no
 * seasonal flag (seed source). Mushrooms flush while it rains: +1 on a successful mushroom roll.
 *
 * Frost note: the frost pass (farming.ts, every 20 ticks) already kills frost-susceptible wild
 * nodes below 40°F, and winter never rises above 35°F — so in Winter the gate's distinct effect
 * is on frost-PROOF berry bushes. The last day of Fall is where the gate bites frost-susceptible
 * nodes on a mild day, so those tests run on Fall day 14 with a surface-temperature guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Weather, setSeason, setTimeOfDay } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

type W = ReturnType<typeof makeWorld>;

/** Pin the weather: day 1 noon first (past the first-day no-rain rule — rain on day 0 re-rolls at once), then the kind. */
function setWeather(w: W, kind: number): void {
  setTimeOfDay(w, 12, 1);
  Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 });
}

function gatherAll(w: W, p: number, nodes: number[]): void {
  for (const node of nodes) {
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: node });
    steps(w, 30);
  }
}

function spawnMany(w: W, kind: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(G.spawnResourceNode(w, kind, 1, 0));
  return out;
}

function count(w: W, p: number, item: string): number {
  return G.countItem(w, p, G.defaultDefs().itemId(item));
}

const seasonalOf = (w: W, nodeKey: string, item: string): boolean | undefined =>
  G.gameplayDefs(w).resources.get(G.defaultDefs().resourceId(nodeKey))?.yields
    .find((y) => y.item === G.defaultDefs().itemId(item))?.seasonal;

describe("ADR-491 wild food follows the seasons", () => {
  it("data: the seasonal flag sits on wild fruit/mushroom/herb yields only", () => {
    const w = makeWorld();
    // berry_bush: plain berries exempt (dye chain), mushroom + seeds seasonal.
    expect(seasonalOf(w, "berry_bush", "berries")).toBe(false);
    expect(seasonalOf(w, "berry_bush", "mushroom")).toBe(true);
    expect(seasonalOf(w, "berry_bush", "berry_seeds")).toBe(true);
    // Fruit trees: fruit seasonal, sticks and saplings (planting stock) not.
    expect(seasonalOf(w, "apple_tree", "apple")).toBe(true);
    expect(seasonalOf(w, "apple_tree", "sticks")).toBe(false);
    expect(seasonalOf(w, "apple_tree", "apple_sapling")).toBe(false);
    // Ordinary tree: wood not seasonal, the apple secondary is.
    expect(seasonalOf(w, "tree", "wood")).toBe(false);
    expect(seasonalOf(w, "tree", "apple")).toBe(true);
    // Wild food-crop nodes are exempt (seed source); planted crops too.
    expect(seasonalOf(w, "wild_potato", "potato")).toBe(false);
    expect(seasonalOf(w, "wild_potato", "seed_potato")).toBe(false);
    expect(seasonalOf(w, "wild_garden", "potato")).toBe(false);
    expect(seasonalOf(w, "crop_mushroom", "mushroom")).toBe(false);
    // Wild mushrooms and herbs are seasonal.
    expect(seasonalOf(w, "wild_mushroom", "mushroom")).toBe(true);
    expect(seasonalOf(w, "herb_patch", "herbs")).toBe(true);
    expect(seasonalOf(w, "herb_patch", "wild_onion")).toBe(true);
  });

  it("winter (frost-proof berry bush): berries still come, no mushroom or seeds", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Clear);
    setSeason(w, 2, 1); // Winter, day 1 (setSeason after the clock: it compensates for the day)
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    gatherAll(w, p, spawnMany(w, "berry_bush", 20));
    expect(count(w, p, "berries")).toBeGreaterThan(0);
    expect(count(w, p, "mushroom")).toBe(0);
    expect(count(w, p, "berry_seeds")).toBe(0);
  });

  it("summer control: the same bushes give mushrooms", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Clear);
    setSeason(w, 0, 1); // Summer, day 1
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    gatherAll(w, p, spawnMany(w, "berry_bush", 20));
    expect(count(w, p, "berries")).toBeGreaterThan(0);
    expect(count(w, p, "mushroom")).toBeGreaterThan(0);
  });

  it("last day of Fall: dormant — berries come, mushrooms do not; day 13 is not dormant", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Clear);
    setSeason(w, 1, 14); // Fall, last day
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    gatherAll(w, p, spawnMany(w, "berry_bush", 20));
    expect(count(w, p, "berries")).toBeGreaterThan(0);
    expect(count(w, p, "mushroom")).toBe(0);

    const w2 = makeWorld();
    setWeather(w2, G.WeatherKind.Clear);
    setSeason(w2, 1, 13); // Fall, day 13 — not dormant
    const p2 = G.spawnPlayer(w2, { x: 0, y: 0 });
    gatherAll(w2, p2, spawnMany(w2, "berry_bush", 20));
    expect(count(w2, p2, "mushroom")).toBeGreaterThan(0);
  });

  it("last day of Fall, mild: wild mushrooms and fruit trees yield nothing (frost did not kill them)", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Clear);
    setSeason(w, 1, 14);
    // surfaceTemperature is °C; the frost kill line is FROST_KILL_C (40°F). A mild noon proves
    // the zero yield is the season gate, not frost.
    expect(G.surfaceTemperature(w)).toBeGreaterThan(G.FROST_KILL_C); // mild day: frost cannot be the cause
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const shrooms = spawnMany(w, "wild_mushroom", 10);
    gatherAll(w, p, shrooms);
    expect(count(w, p, "mushroom")).toBe(0);
    // Nodes survived (frost did not deplete them); the gate zeroed the yield.
    for (const n of shrooms) expect(w.has(n, G.ResourceNode)).toBe(true);
    const trees = spawnMany(w, "apple_tree", 5);
    gatherAll(w, p, trees);
    expect(count(w, p, "apple")).toBe(0);
  });

  it("last day of Fall, mild: wild food crops are exempt and still yield", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Clear);
    setSeason(w, 1, 14);
    expect(G.surfaceTemperature(w)).toBeGreaterThan(G.FROST_KILL_C);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    gatherAll(w, p, spawnMany(w, "wild_potato", 5));
    expect(count(w, p, "potato")).toBeGreaterThan(0);
  });

  it("mushrooms flush while it rains: +1 per successful mushroom roll", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Rain);
    setSeason(w, 0, 1);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    gatherAll(w, p, spawnMany(w, "wild_mushroom", 10));
    // 10 swings x (1-2 base + 1 rain) = 20..30; without the bonus the ceiling is 20 and reaching
    // it needs all ten rolls at max (p ~ 0.001).
    expect(count(w, p, "mushroom")).toBeGreaterThanOrEqual(20);

    const dry = makeWorld();
    setWeather(dry, G.WeatherKind.Clear);
    setSeason(dry, 0, 1);
    const pd = G.spawnPlayer(dry, { x: 0, y: 0 });
    gatherAll(dry, pd, spawnMany(dry, "wild_mushroom", 10));
    expect(count(dry, pd, "mushroom")).toBeLessThanOrEqual(20);
    expect(count(dry, pd, "mushroom")).toBeGreaterThanOrEqual(10);
  });

  it("Guide notes the winter rule in the seasons section", () => {
    const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../data/guide.json"), "utf8"));
    const sec = raw.sections.find((s: { id: string }) => s.id === "seasons-weather");
    expect(sec.items.some((i: { text?: string }) => (i.text ?? "").includes("yield nothing on the last day of fall and all winter"))).toBe(true);
    expect(sec.items.some((i: { text?: string }) => (i.text ?? "").includes("Mushrooms flush while it rains"))).toBe(true);
  });
});
