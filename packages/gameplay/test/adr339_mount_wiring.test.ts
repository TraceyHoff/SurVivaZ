// ADR-339 wiring: the mount-preference layer is actually used by fillMountSensors —
// a bot with two wild rideable animals in range is offered the one of its liked species,
// and falls back to the plain ADR-321 pick when the liked species is absent.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, makeWorld, spawnLearned, steps } from "./helpers.js";

let nid = 6000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(pidN = 7): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, pidN); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x: 0, y: 0 } };
}
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
/** Give the bot the first love food of every rideable species, so food never decides the pick. */
function stockAllLikedFoods(r: Rig): void {
  const d = G.gameplayDefs(r.w);
  for (const sp of G.MOUNT_SPECIES) for (const k of G.likedFoodKeys(sp).slice(0, 1)) G.addItem(r.w, r.p, d.itemId(k), 40);
}
/** First wild animal key of a 1-based species index. */
const firstAnimalOf = (species: number): string => G.MOUNT_SPECIES[species - 1]!.animals[0]!.key;
/** A different species index than `species` (wraps around the list). */
const otherSpecies = (species: number): number => (species % G.MOUNT_SPECIES.length) + 1;

describe("ADR-339 wiring: fillMountSensors prefers the bot's liked species", () => {
  it("offers the liked species when it is in range, at the same distance as another species", () => {
    const r = rig(7);
    const pref = G.preferredMount(7);
    stockAllLikedFoods(r);
    const liked = G.spawnAnimal(r.w, firstAnimalOf(pref.species), 6, 0);
    const other = G.spawnAnimal(r.w, firstAnimalOf(otherSpecies(pref.species)), -6, 0);
    const v = viewOf(r);
    expect(v.tameMount).toBeDefined();
    expect(v.tameMount!.id).toBe(liked);
    expect(v.tameMount!.id).not.toBe(other);
    expect(v.tameMount!.species).toBe(pref.species);
  });

  it("falls back to the plain ADR-321 pick when the liked species is absent", () => {
    const r = rig(7);
    const pref = G.preferredMount(7);
    stockAllLikedFoods(r);
    const other = G.spawnAnimal(r.w, firstAnimalOf(otherSpecies(pref.species)), 5, 0);
    const v = viewOf(r);
    expect(v.tameMount).toBeDefined();
    expect(v.tameMount!.id).toBe(other);
    expect(v.tameMount!.species).not.toBe(pref.species);
  });

  it("offers no tame target while the bot's own mount is alive, and offers one again after it dies", () => {
    const r = rig(7);
    stockAllLikedFoods(r);
    const pref = G.preferredMount(7);
    const horse = G.spawnAnimal(r.w, "animal_horse", 6, 0);
    // tame it through the real flow: drive the survivor controller until the mount is owned
    const ctl = G.survivorController({ seed: 1 }); ctl.add(r.a);
    for (let t = 0; t < 3000 && !r.w.has(horse, G.Mount); t++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)).get(r.a)!;
      G.emitAgentCommands(o as never);
      for (const c of (o as unknown as { commands?: G.AgentCommand[] }).commands ?? []) {
        const v = c.payload as { target: number; item: number; slot: number };
        if (c.type === G.MountFeedCmd.name) { if (!G.checkFeed(r.w, r.p, v.target as Entity, v.item)) G.feedMount(r.w, r.p, v.target as Entity, v.item); }
        else if (c.type === G.MountRideCmd.name) G.rideMount(r.w, r.p, v.target as Entity);
      }
      let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
      if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
      G.applyMovementInput(r.w, r.p, bits, DT); r.w.step(DT);
    }
    expect(r.w.has(horse, G.Mount)).toBe(true);
    expect(viewOf(r).tameMount).toBeUndefined();
    // the mount dies: the next sensor pass offers a tame target again, preferring the liked species
    r.w.add(horse, G.Dead, {} as never); steps(r.w, 1); r.a.bb.set("tameScanAt", -1e9);
    const liked2 = G.spawnAnimal(r.w, firstAnimalOf(pref.species), 6, 0);
    const v2 = viewOf(r);
    expect(v2.tameMount).toBeDefined();
    expect(v2.tameMount!.id).toBe(liked2);
  });
});
