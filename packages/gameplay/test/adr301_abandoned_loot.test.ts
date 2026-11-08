import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

function keys(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  const d = G.gameplayDefs(w);
  return ents.map((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?");
}
function isStation(w: ReturnType<typeof makeWorld>, e: number): boolean {
  if (w.has(e, G.CraftingStation)) return true;
  return G.attachmentsOf(w, e).some((a) => w.has(a, G.CraftingStation));
}

describe("ADR-301 abandoned loot and usable furniture", () => {
  it("fills searchable storage so a player can withdraw the loot", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    const ks = keys(w, r.placed);
    const chest = r.placed.find((_, i) => ks[i] === "basic_storage_box" || ks[i] === "barrel_storage" || ks[i]?.includes("storage"));
    expect(chest).toBeDefined();
    const st = G.resolveAttachment(w, chest!, G.AttachKind.Storage);
    expect(st).toBeDefined();
    const slots = G.listSlots(w, st!);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.count > 0)).toBe(true);
    const take = slots[0]!;
    const t = w.get(chest!, Transform)!;
    const p = spawnLearned(w, { x: t.x, y: t.y, maxWeight: 10_000 });
    G.setIntent(w, p, { action: G.IntentAction.OpenContainer, target: chest! });
    steps(w, 1);
    expect(w.getField(p, G.Viewing, "container")).toBe(st);
    G.setIntent(w, p, { action: G.IntentAction.Withdraw, target: chest!, item: take.item, count: take.count });
    steps(w, 1);
    expect(G.countItem(w, p, take.item)).toBe(take.count);
    expect(G.countItem(w, st!, take.item)).toBe(0);
  });

  it("fills the same containers from the same seed", () => {
    const lootOf = (seed: number) => {
      const w = makeWorld({}, seed);
      const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0, tier: 1 });
      const ks = keys(w, r.placed);
      return r.placed.flatMap((e, i) => {
        if (!(ks[i]!.includes("storage") || ks[i]!.includes("chest") || ks[i] === "barrel_storage" || ks[i]!.includes("wardrobe"))) return [];
        const st = G.resolveAttachment(w, e, G.AttachKind.Storage);
        return st ? G.listSlots(w, st).map((s) => `${ks[i]}:${s.item}:${s.count}`) : [];
      }).sort();
    };
    expect(lootOf(42)).toEqual(lootOf(42));
    expect(lootOf(42).length).toBeGreaterThan(0);
    expect(lootOf(42).join("|") === lootOf(99).join("|")).toBe(false);
  });

  it("always keeps the workshop workbench as a usable crafting station", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Workshop, rot: 0, ruin: 0, tier: 1 });
    const ks = keys(w, r.placed);
    const bench = r.placed.find((_, i) => ks[i] === "workbench");
    expect(bench).toBeDefined();
    expect(isStation(w, bench!)).toBe(true);
  });

  it("gives some buildings a seed-based chance of extra stations and usable furniture", () => {
    let extraStation = false;
    let well = false;
    let stove = false;
    for (let ox = 8; ox < 200 && !(extraStation && well && stove); ox += 5) {
      const shop = G.planAbandonedSite(7, ox, 8, { kind: G.AbandonedKind.Workshop, rot: 0, ruin: 0 });
      if (shop.pieces.some((p) => (p.key === "anvil" || p.key === "furnace") && !p.omit)) extraStation = true;
      const home = G.planAbandonedSite(7, ox, 20, { kind: G.AbandonedKind.Homestead, rot: 0, ruin: 0 });
      if (home.pieces.some((p) => p.key === "well" && !p.omit)) well = true;
      const cot = G.planAbandonedSite(7, ox, 32, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0 });
      if (cot.pieces.some((p) => (p.key === "wood_stove" || p.key === "workbench") && !p.omit)) stove = true;
    }
    expect(extraStation).toBe(true);
    expect(well).toBe(true);
    expect(stove).toBe(true);
  });

  it("stamps chance stations as real usable CraftingStation pieces", () => {
    let found = false;
    for (let ox = 8; ox < 240 && !found; ox += 7) {
      const w = makeWorld();
      const r = G.stampAbandonedSite(w, ox, 8, { kind: G.AbandonedKind.Workshop, rot: 0, ruin: 0, tier: 1 });
      const ks = keys(w, r.placed);
      const extra = r.placed.find((_, i) => ks[i] === "anvil" || ks[i] === "furnace");
      if (extra && isStation(w, extra)) found = true;
    }
    expect(found).toBe(true);
  });
});
