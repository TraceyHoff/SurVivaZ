/**
 * ADR-499: rare finds in ruins. The rare rate is unchanged (5% per pick from a container, 12% from
 * a wardrobe) — only WHAT is rare is per-kind now. A Smithy pays iron tools, a FisherHut pays
 * waterskins and canned fish, a Chapel pays coin; kinds without an entry use the default valuables
 * table (coin stash 5–20, iron tools, waterskin, canned fish). The old global rare pool (torch,
 * stone_knife, leg_splint, stone_axe) is retired — all four are early craftables. Rare counts are
 * ranges: a coin stash is several coins, not one.
 */
import { describe, it, expect } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const OLD_RARE = ["torch", "stone_knife", "leg_splint", "stone_axe"];

/** All loot slots across every storage container of one stamped site. */
function siteLoot(kind: G.AbandonedKindId, seed: number): { item: number; count: number }[] {
  const w = makeWorld({}, seed);
  const r = G.stampAbandonedSite(w, 8, 8, { kind, rot: 0, ruin: 0, tier: 1 });
  G.drainAbandonedStamps(w);
  const out: { item: number; count: number }[] = [];
  for (const e of r.placed) {
    const st = G.resolveAttachment(w, e, G.AttachKind.Storage);
    if (st) out.push(...G.listSlots(w, st));
  }
  return out;
}
const keyOf = (item: number): string => G.defaultDefs().items.get(item)?.key ?? "?";

describe("ADR-499 rare finds in ruins", () => {
  it("tables: Smithy pays iron tools, FisherHut pays waterskin/canned fish, Shed uses the default", () => {
    const d = G.defaultDefs();
    const keys = (kind: G.AbandonedKindId): string[] => G.rareFindsForKind(kind).map((f) => f.key);
    expect(keys(G.AbandonedKind.Smithy)).toEqual(expect.arrayContaining(["iron_axe", "iron_pickaxe"]));
    expect(keys(G.AbandonedKind.FisherHut)).toEqual(expect.arrayContaining(["waterskin", "canned_fish"]));
    expect(keys(G.AbandonedKind.Chapel)).toEqual(expect.arrayContaining(["coin"]));
    expect(keys(G.AbandonedKind.Shed)).toEqual(expect.arrayContaining(["coin", "iron_axe", "iron_pickaxe", "waterskin", "canned_fish"]));
    // Every find references a real item, and every coin stash is more than one coin.
    for (const kind of [G.AbandonedKind.Shed, G.AbandonedKind.Smithy, G.AbandonedKind.FisherHut, G.AbandonedKind.Chapel, G.AbandonedKind.Granary, G.AbandonedKind.Bakery, G.AbandonedKind.Apiary]) {
      for (const f of G.rareFindsForKind(kind)) {
        expect(d.itemId(f.key)).toBeGreaterThan(0);
        expect(f.min).toBeGreaterThanOrEqual(1);
        expect(f.max).toBeGreaterThanOrEqual(f.min);
        if (f.key === "coin") expect(f.min).toBeGreaterThan(1);
      }
    }
  });

  it("Smithy ruins pay iron tools and never the old rare pool", () => {
    let iron = 0;
    const oldSeen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      for (const s of siteLoot(G.AbandonedKind.Smithy, seed)) {
        const k = keyOf(s.item);
        if (k === "iron_axe" || k === "iron_pickaxe") iron += s.count;
        if (OLD_RARE.includes(k)) oldSeen.add(k);
      }
    }
    expect(iron).toBeGreaterThan(0);
    expect([...oldSeen]).toEqual([]);
  });

  it("Chapel ruins pay coin stashes of ten or more", () => {
    let best = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const s of siteLoot(G.AbandonedKind.Chapel, seed)) {
        if (keyOf(s.item) === "coin") best = Math.max(best, s.count);
      }
    }
    expect(best).toBeGreaterThanOrEqual(10);
  });

  it("the old rare pool is gone everywhere, not just in Smithies", () => {
    const oldSeen = new Set<string>();
    let picks = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const s of siteLoot(G.AbandonedKind.Cottage, seed)) {
        picks++;
        const k = keyOf(s.item);
        if (OLD_RARE.includes(k)) oldSeen.add(k);
      }
    }
    // 40 sites is ~140 picks: on pre-change code a rare pick (5%) is always an old-rare item,
    // so zero sightings here is decisive, not a small-sample fluke.
    expect(picks).toBeGreaterThan(100);
    expect([...oldSeen]).toEqual([]);
  });
});
