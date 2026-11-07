/**
 * Task 34: buildable Apiary + bees deposit honey in it.
 * Pinned numbers: Apiary tier 1, 12 slots, cost planks 6 + rope 2, category furniture (ADR-288); bees deposit into the nearest
 * Apiary within 10 tiles (H.troughRange) INSTEAD of the trough; no Apiary -> trough as before; Apiary-only (no
 * trough) still produces; a full Apiary falls back to the trough; full Apiary + full trough keeps the honey
 * (produceAt stays past-due, retried next tick) — never silently lost. Bee honey rate stays 360s; non-bee
 * animals are unaffected (milk still lands in the trough).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
const pid = (k: string) => d.pieceId(k);
const BASE = { x: 10, y: 10 };
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); steps(w, 1); return { w, p };
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 });
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
/** A tamed animal; fedUntil/produceAt default far in the future (fed, not producing) unless overridden. */
const tamed = (w: World, owner: Entity, kindKey: string, x: number, y: number, over: Partial<{ fedUntil: number; produceAt: number }> = {}): Entity => {
  const a = G.spawnAnimal(w, kindKey, x, y); const kind = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind, owner, fedUntil: over.fedUntil ?? w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};
/** Grant the player Husbandry 2 ("pens") so trough production is not gated by canUsePens (ADR-234 pattern). */
const pens = (w: World, p: Entity): void => {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  const unlock = (i: number): void => { for (const r of G.SKILL_REQS[i]!) unlock(r); const why = G.unlockSkill(w, p, i); if (why) throw new Error(`unlock ${G.SKILLS.nodes[i]!.key}: ${why}`); };
  unlock(G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_pens"));
};
const storageOf = (w: World, r: { ok: boolean; piece?: Entity }): Entity => {
  expect(r.ok).toBe(true);
  return G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
};

describe("Task 34: pet favourite treats", () => {
  it("owl's favourite treat is Meaty Chew; a pet with several loves lists them all", () => {
    const { w, p } = fresh();
    const owl = tamed(w, p, "animal_owl", BASE.x + 3, BASE.y + 0.5);
    expect(G.petView(w, p, owl)!.favorites).toEqual([{ key: "meaty_chew", name: "Meaty Chew" }]);
    const fox = tamed(w, p, "animal_fox", BASE.x + 3, BASE.y + 1.5);
    expect(G.petView(w, p, fox)!.favorites.map((f) => f.key)).toEqual(["meaty_chew", "fish_treat"]);
  });

  it("no favourites when none defined: farm animals (bee, cow) show nothing", () => {
    const { w, p } = fresh();
    const bee = tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5);
    expect(G.petView(w, p, bee)!.favorites).toEqual([]);
    const cow = tamed(w, p, "animal_cow", BASE.x + 3, BASE.y + 1.5);
    expect(G.petView(w, p, cow)!.favorites).toEqual([]);
    expect(G.favoriteTreats(w, undefined)).toEqual([]);
  });
});

describe("Task 34: Apiary piece", () => {
  it("Apiary data: tier 1, 12-slot container, planks 6 + rope 2, furniture, placeable, openable as storage", () => {
    const { w, p } = fresh(); pens(w, p);
    const def = d.pieces.get(pid("apiary"))!;
    expect(def.fixedTier).toBe(1); expect(def.container).toBe(12); expect(def.category).toBe("furniture");
    expect(def.placement).toBe(G.Placement.Free); expect(def.ground).toBe(true);
    expect(G.pieceCost(d, def, def.fixedTier).map((c) => [d.items.get(c.item)!.key, c.count])).toEqual([["planks", 6], ["rope", 2]]);
    const r = put(w, p, "apiary", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    const att = storageOf(w, r);
    // Openable as storage (Task 4 reach/container rules): honey can be put in and taken out.
    G.addItem(w, att, iid("honey"), 3);
    expect(G.countItem(w, att, iid("honey"))).toBe(3);
    expect(G.removeItem(w, att, iid("honey"), 2)).toBe(true);
    expect(G.countItem(w, att, iid("honey"))).toBe(1);
  });

  it("Apiary world piece still falls back to salt_barrel art; build menu uses dedicated build_apiary (d163528)", () => {
    // World sprite fallback until dedicated piece art ships. Build menu icon is build_apiary @ items_build frame 286
    // (CSS --cz-ipos 93.33% 100%) and auto-binds via buildIconKey — verified in apps/client adr229 / CSS.
    expect((G.SPRITE_FALLBACKS.sprites as Record<string, { to: string[] }>)["apiary"]).toEqual({ to: ["salt_barrel"] });
  });

  it("bee honey rate is unchanged (360s)", () => {
    expect(G.SKILLS.husbandry.animals["animal_bee"]).toMatchObject({ produce: "honey", seconds: 360 });
  });
});

describe("Task 34: bees deposit honey in the Apiary", () => {
  it("Apiary in range: honey lands in the Apiary, not the trough", () => {
    const { w, p } = fresh(); pens(w, p);
    const trough = storageOf(w, put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 4.5, BASE.y + 0.5, 0, 0, undefined, { x: BASE.x + 4.5, y: BASE.y + 1.7 }));
    const bee = tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(1);
    expect(G.countItem(w, trough, iid("honey"))).toBe(0);
    expect(w.get(bee, G.Tamed)!.produceAt).toBeGreaterThan(w.tick);
  });

  it("no Apiary: honey goes to the trough as before", () => {
    const { w, p } = fresh(); pens(w, p);
    const trough = storageOf(w, put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("honey"))).toBe(1);
  });

  it("Apiary only (no trough): the bee still produces, into the Apiary", () => {
    const { w, p } = fresh(); pens(w, p);
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    const bee = tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(1);
    expect(w.get(bee, G.Tamed)!.produceAt).toBeGreaterThan(w.tick);
  });

  it("full Apiary: the bee falls back to the trough", () => {
    const { w, p } = fresh(); pens(w, p);
    const trough = storageOf(w, put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 4.5, BASE.y + 0.5, 0, 0, undefined, { x: BASE.x + 4.5, y: BASE.y + 1.7 }));
    G.addItem(w, apiary, iid("honey"), 240); // 12 slots x 20 (honey maxStack)
    expect(G.countItem(w, apiary, iid("honey"))).toBe(240);
    const bee = tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(240);
    expect(G.countItem(w, trough, iid("honey"))).toBe(1);
    expect(w.get(bee, G.Tamed)!.produceAt).toBeGreaterThan(w.tick);
  });

  it("full Apiary + full trough: the bee keeps its honey and retries later", () => {
    const { w, p } = fresh(); pens(w, p);
    const trough = storageOf(w, put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 4.5, BASE.y + 0.5, 0, 0, undefined, { x: BASE.x + 4.5, y: BASE.y + 1.7 }));
    G.addItem(w, apiary, iid("honey"), 240);
    G.addItem(w, trough, iid("honey"), 120); // 6 trough slots x 20
    const bee = tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(240);
    expect(G.countItem(w, trough, iid("honey"))).toBe(120);
    expect(w.get(bee, G.Tamed)!.produceAt).toBe(0); // not advanced: the honey is kept, retried next tick
    expect(G.removeItem(w, apiary, iid("honey"), 1)).toBe(true); // free one stack space
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(240);
    expect(w.get(bee, G.Tamed)!.produceAt).toBeGreaterThan(w.tick);
  });

  it("non-bee animals are unaffected: a cow's milk still lands in the trough, not the Apiary", () => {
    const { w, p } = fresh(); pens(w, p);
    const trough = storageOf(w, put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 4.5, BASE.y + 0.5, 0, 0, undefined, { x: BASE.x + 4.5, y: BASE.y + 1.7 }));
    tamed(w, p, "animal_cow", BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("milk"))).toBeGreaterThanOrEqual(1);
    expect(G.countItem(w, apiary, iid("milk"))).toBe(0);
  });

  it("a hungry bee does not produce (fed gate unchanged)", () => {
    const { w, p } = fresh(); pens(w, p);
    const apiary = storageOf(w, put(w, p, "apiary", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND));
    tamed(w, p, "animal_bee", BASE.x + 3, BASE.y + 0.5, { fedUntil: 0, produceAt: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, apiary, iid("honey"))).toBe(0);
  });
});
