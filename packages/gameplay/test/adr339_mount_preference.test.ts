// ADR-339: an AI human tames a mount OF ITS CHOICE and keeps it until it dies (Task 37, user question 4).
// Pure preference / pick / keep-alive / feeding tests, plus a proof that the existing sensor pass already
// never re-tames while the bot's own mount is alive (and lets it seek again after the mount dies).
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { likedFoodKeys, pickTameTarget, preferredFeedFood, preferredMount, shouldSeekMount } from "../src/ai/mount_preference.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const B = G.MOUNT_BOTS;
const SPECIES = G.MOUNT_SPECIES;
const speciesKey = (i: number): string => SPECIES[i - 1]!.key;
const foodPref = (i: number, k: string): string | undefined => SPECIES[i - 1]!.foods[k];

describe("ADR-339 preference", () => {
  it("is deterministic: the same PlayerId gives the same species and food across fresh loads", () => {
    for (const pid of [1, 7, 42, 12345, 987654321]) {
      const a = preferredMount(pid);
      // a fresh copy of the species table, as a fresh load would read it
      const fresh = JSON.parse(JSON.stringify(SPECIES)) as typeof SPECIES;
      const b = preferredMount(pid, fresh);
      expect(b).toEqual(a);
      expect(a.species).toBeGreaterThanOrEqual(1); expect(a.species).toBeLessThanOrEqual(SPECIES.length);
      expect(a.key).toBe(speciesKey(a.species));
      expect(foodPref(a.species, a.food)).toBe("love"); // the food is a loved food of that species
      expect(likedFoodKeys(SPECIES[a.species - 1]!)[0]).toBe(a.food);
    }
  });
  it("spreads bots across species instead of giving everyone the same mount", () => {
    const seen = new Set<number>(); for (let pid = 1; pid <= 40; pid++) seen.add(preferredMount(pid).species);
    expect(seen.size).toBeGreaterThan(1);
  });
  it("orders liked foods love > like > ok", () => {
    expect(likedFoodKeys(SPECIES[0]!)).toEqual(["carrot", "apple", "hay", "wheat", "berries"]); // horse
    expect(likedFoodKeys(SPECIES[5]!)[0]).toBe("hay"); // buffalo loves hay, not carrots
  });
});

describe("ADR-339 tame choice", () => {
  it("prefers the liked species when one is in seekRadius, even when a better species is nearer", () => {
    // horse (id 10) 2 tiles away out-scores a donkey 20 tiles away on the plain ADR-321 score …
    const cands = [{ id: 10, x: 2, y: 0, species: 1 }, { id: 11, x: 20, y: 0, species: 2 }];
    expect(pickTameTarget(cands, 0, 0, 2, SPECIES, { preferredSpeciesBonus: 0 })).toBe(10);
    // … but with the liked-species bonus the bot goes for its donkey instead
    expect(pickTameTarget(cands, 0, 0, 2)).toBe(11);
    expect(pickTameTarget(cands, 0, 0, 2, SPECIES, { preferredSpeciesBonus: B.preferredSpeciesBonus })).toBe(11);
  });
  it("falls back to the existing utility pick (not just nearest) when the liked species is absent", () => {
    // liked yak is absent; buffalo 2 away out-scores a horse 8 away on gallop + hp/60 - distance * 0.15
    const cands = [{ id: 10, x: 8, y: 0, species: 1 }, { id: 12, x: 2, y: 0, species: 6 }];
    expect(pickTameTarget(cands, 0, 0, 7)).toBe(12);
    // and with no bonus at all the pick is identical: the fallback IS the ADR-321 score
    expect(pickTameTarget(cands, 0, 0, 7, SPECIES, { preferredSpeciesBonus: 0 })).toBe(12);
  });
  it("ignores a liked species outside seekRadius and skips unknown species; -1 when nothing is in range", () => {
    const cands = [{ id: 10, x: 5, y: 0, species: 1 }, { id: 11, x: 30, y: 0, species: 2 }, { id: 12, x: 1, y: 0, species: 99 }];
    expect(pickTameTarget(cands, 0, 0, 2)).toBe(10);
    expect(pickTameTarget([], 0, 0, 2)).toBe(-1);
    expect(pickTameTarget([{ id: 11, x: 30, y: 0, species: 2 }], 0, 0, 2)).toBe(-1);
  });
  it("breaks score ties by lowest entity id, like the existing scan", () => {
    const cands = [{ id: 21, x: 3, y: 4, species: 1 }, { id: 20, x: -3, y: -4, species: 1 }];
    expect(pickTameTarget(cands, 0, 0, 7)).toBe(20);
  });
});

// ---- keep until it dies: the existing sensor pass, proved here ---------------------------------------------
let nid = 9000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(opts: { pid?: number } = {}): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
  pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  return { w, p, a, id: (k) => d.itemId(k), home: { x: 0, y: 0 } };
}
function ctxOf(r: Rig): AgentContext<G.AgentWorldView> {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits, bravery: 0.8, industriousness: 0.8 }, rng: r.a.rng, agent: r.a, world: v.world };
}

describe("ADR-339 keep until it dies", () => {
  it("shouldSeekMount is false while the own mount is alive, true once it is dead or absent", () => {
    expect(shouldSeekMount({ alive: true })).toBe(false);
    expect(shouldSeekMount({ alive: false })).toBe(true);
    expect(shouldSeekMount(undefined)).toBe(true);
  });
  it("the existing sensors never offer a tame target while the bot's own mount lives — and do again after it dies", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    G.addItem(r.w, r.p, r.id("carrot"), 40);
    const wild = G.spawnAnimal(r.w, "animal_horse", 6, 0);
    let c = ctxOf(r);
    expect(c.world.mount?.id).toBe(m); expect(c.world.tameMount).toBeUndefined(); // living mount: no tame offered
    expect(G.mountBehaviors().find((b) => b.name === "tame_mount")!.considerations.every((k) => (k.weight ?? 1) * (k.input(c) >= 0.5 ? 1 : 0) > 0)).toBe(false);
    // the mount dies (ADR-322): the bot may seek again, and the wild horse is the target
    r.w.add(m, G.Dead, {} as never); steps(r.w, 1); r.a.bb.set("tameScanAt", -1e9);
    c = ctxOf(r); expect(c.world.mount).toBeUndefined(); expect(c.world.tameMount?.id).toBe(wild);
  });
});

describe("ADR-339 feeding preference", () => {
  it("feeds the mount's best liked food the bot carries (love before like before ok)", () => {
    expect(preferredFeedFood(1, ["wheat", "apple", "hay"])).toBe("apple"); // horse: apple is love, hay/wheat only like
    expect(preferredFeedFood(1, ["wheat", "hay"])).toBe("hay"); // both like: file order wins
    expect(preferredFeedFood(1, ["berries"])).toBe("berries"); // ok is still food when nothing better is on hand
    expect(preferredFeedFood(1, ["rope", "leather"])).toBeUndefined();
    expect(preferredFeedFood(6, ["carrot", "hay"])).toBe("hay"); // buffalo loves hay, only likes carrot
    expect(preferredFeedFood(99, ["hay"])).toBeUndefined();
  });
  it("the live feed path already prefers the liked food: a hurt mount is offered its love food first", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 3, 0, r.p));
    G.addItem(r.w, r.p, r.id("hay"), 10); G.addItem(r.w, r.p, r.id("apple"), 10);
    r.w.set(m, G.Health, { hp: 40 });
    const c = ctxOf(r);
    expect(c.world.mount?.feedItem).toBe(r.id("apple")); // bestMountFood is love-first, matching preferredFeedFood
    expect(preferredFeedFood(1, ["hay", "apple"])).toBe("apple");
  });
});
