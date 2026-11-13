/**
 * ADR-390: every open storage container has a display name used as the window title / section heading.
 */
import { describe, expect, it } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;
const title = (w: World, e: Entity, p?: Entity): string => G.containerDisplayName(w, e, p);

function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
  steps(w, 1); ensureClaim(w, p, 3, 1); w.set(p, Transform, { x: 3.5, y: 1.5 }); return { w, p };
}
const give = (w: World, e: Entity, key: string, n = 1): void => { for (const c of G.pieceCost(d, piece(key), 1)) G.addItem(w, e, c.item, c.count * n); };
const place = (w: World, e: Entity, key: string, x: number, y: number): Entity => {
  give(w, e, key); const def = piece(key);
  const r = G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  expect(r.ok, `${key} places: ${JSON.stringify(r)}`).toBe(true); return (r as { piece: Entity }).piece;
};
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;

const bag = (w: World, x: number, y: number, source: G.LootSourceId, owner = 0): Entity => {
  const b = w.create();
  w.add(b, Transform, { x, y }).add(b, G.Container, { slotCount: 4 }).add(b, G.ContainerViewers).add(b, G.LootBag, { owner, despawnAtTick: 0xffffffff, kind: source });
  G.tagLootSource(w, b, source);
  return b;
};

describe("ADR-390 container display names", () => {
  it("title-cases every storage piece key, including a placed store's attachment container", () => {
    const { w, p } = fresh();
    for (const def of d.pieces.values()) {
      if (!def.container) continue;
      const e = w.create();
      w.add(e, Transform, { x: 4, y: 1.5 }).add(e, G.BuildPiece, { type: def.id }).add(e, G.Container, { slotCount: def.container });
      expect(title(w, e, p), def.key).toBe(G.titleCaseKey(def.key));
    }
    const pc = place(w, p, "log_store", 3.5, 2.5);
    const box = storageOf(w, pc);
    expect(title(w, box, p)).toBe("Log Store");
    expect(G.containerView({ world: w, player: p }, box)!.name).toBe("Log Store");
  });

  it("covers every piece that is a container: title-case of its key, no unnamed piece", () => {
    const missing: string[] = [];
    for (const def of d.pieces.values()) {
      if (!def.container) continue;
      const n = G.titleCaseKey(def.key);
      if (!n || n === "Storage") missing.push(def.key);
    }
    expect(missing).toEqual([]);
    expect([...d.pieces.values()].filter((p) => p.container).length).toBeGreaterThan(20);
  });

  it("names loot bags, death bags, supply crates, wagons and saddlebags", () => {
    const { w, p } = fresh();
    expect(title(w, bag(w, 4, 1.5, G.LootSource.Dropped), p)).toBe("Loot Bag");
    expect(title(w, bag(w, 4, 1.5, G.LootSource.Death, 99), p)).toBe("Death Bag");
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    if (!w.has(p, PlayerId)) w.add(p, PlayerId, { id: 1 }); else w.set(p, PlayerId, { id: 1 });
    const mine = bag(w, 4, 1.5, G.LootSource.Death, 1);
    expect(title(w, mine, p)).toBe("Your Bag");
    expect(title(w, bag(w, 4, 1.5, G.LootSource.Zombie), p)).toBe("Zombie Loot");
    expect(title(w, bag(w, 4, 1.5, G.LootSource.Crate), p)).toBe("Supply Crate");
    expect(title(w, bag(w, 4, 1.5, G.LootSource.Animal), p)).toBe("Loot Bag");

    const v = G.spawnVehicle(w, "wagon_medium", 5, 1.5, 0);
    expect(title(w, v, p)).toBe("Wagon Medium");
    const cv = G.containerView({ world: w, player: p }, v);
    if (cv) expect(cv.name).toBe("Wagon Medium");

    const m = w.create();
    w.add(m, Transform, { x: 4.5, y: 1.5 }).add(m, G.Mount, { species: 1, owner: 1 }).add(m, G.Container, { slotCount: 4 });
    expect(title(w, m, p)).toBe("Saddlebag");
  });

  it("inventoryPanelTitle is the open container's name, or Inventory when none is in reach", () => {
    const { w, p } = fresh();
    expect(G.inventoryPanelTitle(w, p)).toBe("Inventory");
    const pc = place(w, p, "log_store", 3.5, 2.5);
    const box = storageOf(w, pc);
    // Player stands next to it; openContainer picks the nearest container in reach.
    expect(G.openContainer({ world: w, player: p })).toBe(box);
    expect(G.inventoryPanelTitle(w, p)).toBe("Log Store");
  });

  it("falls back to Storage for a nameless box", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    const box = w.create(); w.add(box, Transform, { x: 0.5, y: 0 }).add(box, G.Container, { slotCount: 4 });
    expect(title(w, box, p)).toBe("Storage");
  });
});

