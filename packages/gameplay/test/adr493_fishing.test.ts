/**
 * ADR-493: fishing from shore and boat. One Fish command (rod in hand, water in front) casts the
 * line; the cast holds while the fisher stands still facing the same water tile — a wait (4–8 s,
 * shorter at dawn/dusk), then a bite roll (dawn/dusk + rain + deep water raise the chance) lands
 * raw fish in the inventory, and a miss re-casts on its own. Moving, turning or switching the
 * held item reels the line in. The cast is tap-to-cast (the Fish intent is the trigger, not the
 * sustain — PlayerIntent.action is wiped every tick by clearIntentsSystem). A boat driver fishes
 * exactly like a shore fisher (no Driver gate anywhere in the path).
 */
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

// lake (ADR-181/489): water for 0 <= x < 20, grass elsewhere. Shallow x 0..1 and 18..19; deep x 2..17.
const lake = (tx: number): number => (tx >= 0 && tx < 20 ? 1 : 3);
function world() {
  const w = makeWorld();
  w.setResource(G.TerrainRes, { tileAt: (tx: number) => lake(tx), heightAt: () => 0 });
  return w;
}
const d = G.defaultDefs();
const fishOf = (w: ReturnType<typeof makeWorld>, p: number): number => {
  const slots = G.readSlots(w, p);
  let n = 0;
  for (let i = 0; i < slots.slotCount; i++) if (slots.item(i) === d.itemId("fish")) n += slots.count(i);
  return n;
};
/** Give the rod and put it in the main hand (slot 0); step once so equipmentSync derives mainHandItem. */
function rodInHand(w: ReturnType<typeof makeWorld>, p: number): void {
  G.addItem(w, p, d.itemId("fishing_rod"), 1);
  w.set(p, G.Equipment, { mainHandSlot: 0 });
  steps(w, 2);
  expect(w.getField(p, G.Equipment, "mainHandItem")).toBe(d.itemId("fishing_rod"));
}
const face = (w: ReturnType<typeof makeWorld>, p: number, facing: number): void => { w.setField(p, Transform, "facing", facing); };
const cast = (w: ReturnType<typeof makeWorld>, p: number): void => G.setIntent(w, p, { action: G.IntentAction.Fish });

describe("ADR-493 fishing from shore and boat", () => {
  it("data: fishing tuning, the rod item + recipe (2 wood + 1 rope), the Fish command", () => {
    const tun = d.fishing;
    expect(tun.biteDelaySeconds).toEqual([4, 8]);
    expect(tun.biteChance).toBe(0.7);
    expect(tun.staminaCost).toBe(2);
    expect(tun.fishMin).toBe(1); expect(tun.fishMax).toBe(2);
    expect(tun.deepWaterExtraFish).toBe(1);
    expect(d.itemId("fishing_rod")).toBeGreaterThan(0);
    expect(d.recipeId("fishing_rod")).toBeGreaterThan(0);
    const recipe = d.recipes.get(d.recipeId("fishing_rod"))!;
    expect(recipe.ingredients.map((i) => [d.items.get(i.item)?.key, i.count])).toEqual([["wood", 2], ["rope", 1]]);
    expect(G.GAMEPLAY_COMMANDS.find(([c]) => c === G.FishCmd)?.[1]).toBe(G.IntentAction.Fish);
    expect(G.defaultDefs().lock.items["fishing_rod"]).toBe(527);
    expect(G.defaultDefs().lock.recipes["fishing_rod"]).toBe(409);
  });

  it("the prompt offers Fish with a rod in hand facing water — and not without the rod or facing land", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    face(w, p, 0); // facing +x: the tile in front (0, 5) is shallow water
    expect(G.farmPrompt(w, p)?.action).not.toBe("Fish"); // no rod yet
    rodInHand(w, p);
    expect(G.farmPrompt(w, p)?.action).toBe("Fish");
    face(w, p, Math.PI); // facing -x: the tile in front is land
    expect(G.farmPrompt(w, p)?.action).not.toBe("Fish");
  });

  it("one Fish command casts the line; the cast holds without further intents and lands fish", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    rodInHand(w, p);
    face(w, p, 0);
    cast(w, p);
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(true); // the line is in the water
    // No further intent is sent — the cast holds on its own (tap-to-cast).
    steps(w, 800); // 40 s: ~6 waits (4–8 s each) and bites at 0.7 (the fixed seed's first draws miss)
    expect(fishOf(w, p)).toBeGreaterThan(0);
    expect(w.has(p, G.Fishing)).toBe(true); // still fishing
  });

  it("no rod, or no water in front: no cast", () => {
    const w = world();
    const noRod = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    face(w, noRod, 0);
    cast(w, noRod);
    steps(w, 2);
    expect(w.has(noRod, G.Fishing)).toBe(false);
    const land = G.spawnPlayer(w, { x: -5.5, y: 5.5 });
    rodInHand(w, land);
    face(w, land, Math.PI); // facing -x: land in front
    cast(w, land);
    steps(w, 2);
    expect(w.has(land, G.Fishing)).toBe(false);
  });

  it("moving away or turning away reels the line in; switching the held item does too", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    rodInHand(w, p);
    face(w, p, 0);
    cast(w, p);
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(true);
    face(w, p, Math.PI); // turn away from the water
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(false);
    // Cast again, then walk away.
    face(w, p, 0); cast(w, p); steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(true);
    w.set(p, Transform, { x: -5.5, y: 5.5 });
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(false);
    // Cast again, then switch the held item (empty the main hand).
    w.set(p, Transform, { x: -0.5, y: 5.5 });
    face(w, p, 0); cast(w, p); steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(true);
    w.set(p, G.Equipment, { mainHandSlot: 255 });
    steps(w, 2);
    expect(w.has(p, G.Fishing)).toBe(false);
  });

  it("an exhausted fisher cannot cast (the stamina cost is paid up front)", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    rodInHand(w, p);
    face(w, p, 0);
    w.setField(p, G.Survival, "stamina", 0);
    cast(w, p);
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(false);
  });

  it("deep water yields more fish than shallow water over the same time", () => {
    const w = world();
    // Shallow: standing on the shore at x -0.5, casting into tile (0, 5) — shallow.
    const shallow = G.spawnPlayer(w, { x: -0.5, y: 5.5 });
    rodInHand(w, shallow);
    face(w, shallow, 0);
    // Deep: wading at x 1.5, casting into tile (2, 5) — deep.
    const deep = G.spawnPlayer(w, { x: 1.5, y: 5.5 });
    rodInHand(w, deep);
    face(w, deep, 0);
    cast(w, shallow); cast(w, deep);
    steps(w, 1200); // 60 s: ~10 waits each, ~7 bites each
    const s = fishOf(w, shallow), df = fishOf(w, deep);
    expect(s).toBeGreaterThan(0);
    expect(df).toBeGreaterThan(s + 3); // deep gets +1 per bite and a higher bite chance
  });

  it("a boat driver casts exactly like a shore fisher (no Driver gate in the path)", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: 10.5, y: 5.5 }); // on the lake, like a driver
    rodInHand(w, p);
    face(w, p, 0);
    w.add(p, G.Driver, { vehicleNetId: 0, seat: 0 }); // a driver (no vehicle needed: the system never reads it)
    cast(w, p);
    steps(w, 1);
    expect(w.has(p, G.Fishing)).toBe(true);
    steps(w, 400);
    expect(fishOf(w, p)).toBeGreaterThan(0);
  });
});
