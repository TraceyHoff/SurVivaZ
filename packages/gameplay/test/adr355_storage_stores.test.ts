/**
 * ADR-355: Resource-specific storage — ore_store, log_store, stick_store, crop_store, stone_store.
 * Each holds only its own family (the def's `accepts` list, enforced server-side in containerSystem with
 * BuildFail.WrongStorage); pieces without accepts behave exactly as before, and AI humans deposit / fetch
 * through the matching store (falling back to a generic store when there is none).
 */
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import ids from "../data/ids.lock.json";
import * as G from "../src/index.js";
import { DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, DefsError, loadDefs, type RawDefs } from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { baseBehaviors } from "../src/ai/base_behaviors.js";
import { DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const item = (k: string) => d.itemId(k);
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;
const clone = (): RawDefs => JSON.parse(JSON.stringify(DEFAULT_RAW_DEFS)) as RawDefs;

const STORES = ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"] as const;
const ACCEPTS: Record<string, string[]> = {
  ore_store: ["copper_ore", "tin_ore", "iron_ore", "lead_ore", "chromite_ore"],
  log_store: ["wood", "hardwood"],
  stick_store: ["sticks"],
  crop_store: ["wheat", "lettuce", "pepper", "beetroot", "rice", "hay", "corn", "potato", "carrot", "tomato", "pumpkin", "squash", "beans", "cabbage", "onion", "cotton", "flax", "hemp"],
  stone_store: ["stone", "stone_brick", "clay", "clay_brick"],
};

// ---------- player container harness (ADR-250 pattern) ----------
function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
  ensureClaim(w, p, 3, 1); w.set(p, Transform, { x: 3.5, y: 1.5 }); return { w, p };
}
const give = (w: World, e: Entity, key: string, n = 1): void => { for (const c of G.pieceCost(d, piece(key), 1)) G.addItem(w, e, c.item, c.count * n); };
const place = (w: World, e: Entity, key: string, x: number, y: number): Entity => {
  give(w, e, key); const def = piece(key);
  const r = G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  expect(r.ok, `${key} places`).toBe(true); return (r as { piece: Entity }).piece;
};
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
const intent = (w: World, p: Entity, action: number, target: Entity, it = 0, count = 0): void => { w.set(p, G.PlayerIntent, { action, target, item: it, count }); steps(w, 1); };
/** Six stores in a cluster around (3.5, 1.5), all within container reach (2.5) of the player. */
function storesWorld(): { w: World; p: Entity; at: Record<string, Entity> } {
  const { w, p } = fresh();
  const at: Record<string, Entity> = {};
  const spots: [string, number, number][] = [["ore_store", 1.5, 0.5], ["log_store", 1.5, 2.5], ["stick_store", 3.5, 0.5], ["crop_store", 3.5, 2.5], ["stone_store", 5.5, 0.5], ["basic_storage_box", 5.5, 2.5]];
  for (const [k, x, y] of spots) at[k] = place(w, p, k, x, y);
  return { w, p, at };
}
const open = (w: World, p: Entity, t: Entity): void => intent(w, p, G.IntentAction.OpenContainer, t);
const deposit = (w: World, p: Entity, t: Entity, k: string, n: number): void => intent(w, p, G.IntentAction.Deposit, t, item(k), n);

describe("ADR-355 storage stores: data", () => {
  it("adds five pieces (193 total) with the fixed art-slice keys, 12 slots, tier 1, furniture, never skill-gated", () => {
    expect(d.pieces.size).toBe(196); // ADR-398: +3 continuous-roof pieces
    for (const k of STORES) {
      expect((ids.pieces as Record<string, number>)[k]).toBeGreaterThan(188); // appended after shaft_hatch 188
      const def = piece(k);
      expect(def.container).toBe(12); expect(def.fixedTier).toBe(1); expect(def.hp).toBe(120);
      expect(def.ground).toBe(true); expect(def.placement).toBe(G.Placement.Free);
      expect(def.category).toBe("furniture"); expect(def.paintable).toBe(true);
      expect(G.pieceGates(d, def, def.fixedTier)).toEqual([`piece:${k}`]); // ordinary furniture piece, like the Apiary: gated by its own token, which no skill node defines, so a fresh character can build it
      expect(G.UNLOCK_NODE.has(`piece:${k}`)).toBe(false);
      expect(G.isBaseStoragePiece(def)).toBe(true);
      for (const c of G.pieceCost(d, def, 1)) expect(d.items.has(c.item)).toBe(true);
    }
    expect((ids.pieces as Record<string, number>).ore_store).toBe(191);
  });
  it("each store's accepts list is exactly its family (ores / logs / sticks / crops / masonry)", () => {
    for (const [k, keys] of Object.entries(ACCEPTS)) {
      expect(piece(k).accepts.map((id) => d.items.get(id)!.key)).toEqual(keys);
    }
  });
  it("draws the family boundaries: no ingots in the ore store, no seeds in the crop store", () => {
    expect(piece("ore_store").accepts).not.toContain(item("copper_ingot"));
    expect(piece("ore_store").accepts).not.toContain(item("iron_ingot"));
    for (const k of ["wheat_seeds", "lettuce_seeds", "carrot_seeds"]) expect(piece("crop_store").accepts).not.toContain(item(k));
    expect(piece("crop_store").accepts).toContain(item("wheat"));
    expect(piece("stone_store").accepts).toContain(item("clay")); // masonry stock, kept with the stone
  });
  it("every other container stays unrestricted (empty accepts)", () => {
    for (const k of ["basic_storage_box", "storage_box", "large_chest", "salt_barrel", "apiary"]) expect(piece(k).accepts).toEqual([]);
  });
  it("loadDefs rejects an unknown accepts key and accepts on a non-container", () => {
    const badItem = clone(); badItem.pieces.pieces.find((p) => p.key === "ore_store")!.accepts = ["unobtainium"];
    try { loadDefs(badItem, { lock: DEFAULT_ID_LOCK }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(DefsError); expect((e as DefsError).issues.join("\n")).toMatch(/unknown item "unobtainium"/);
    }
    const badPiece = clone(); badPiece.pieces.pieces.find((p) => p.key === "wall")!.accepts = ["wood"];
    try { loadDefs(badPiece, { lock: DEFAULT_ID_LOCK }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(DefsError); expect((e as DefsError).issues.join("\n")).toMatch(/accepts needs a container/);
    }
  });
});

describe("ADR-355 storage stores: deposit enforcement (server-authoritative)", () => {
  it("each store takes its own family and refuses the others with WrongStorage (34)", () => {
    const { w, p, at } = storesWorld();
    const fails: number[] = []; w.events.on(G.BuildFailed, (e: { reason: number }) => fails.push(e.reason));
    const wrong = (store: string, k: string, n = 3): void => {
      const before = G.countItem(w, p, item(k)); G.addItem(w, p, item(k), n); open(w, p, at[store]!); deposit(w, p, at[store]!, k, n);
      expect(fails.at(-1), `${k} into ${store}`).toBe(G.BuildFail.WrongStorage);
      expect(G.countItem(w, p, item(k)), `${k} stays in the bag`).toBe(before + n);
      expect(G.countItem(w, storageOf(w, at[store]!), item(k))).toBe(0);
    };
    // right-family deposits succeed
    G.addItem(w, p, item("copper_ore"), 5); open(w, p, at.ore_store!); deposit(w, p, at.ore_store!, "copper_ore", 5);
    expect(G.countItem(w, storageOf(w, at.ore_store!), item("copper_ore"))).toBe(5);
    G.addItem(w, p, item("hardwood"), 2); open(w, p, at.log_store!); deposit(w, p, at.log_store!, "hardwood", 2);
    expect(G.countItem(w, storageOf(w, at.log_store!), item("hardwood"))).toBe(2);
    G.addItem(w, p, item("wheat"), 4); open(w, p, at.crop_store!); deposit(w, p, at.crop_store!, "wheat", 4);
    expect(G.countItem(w, storageOf(w, at.crop_store!), item("wheat"))).toBe(4);
    G.addItem(w, p, item("clay_brick"), 3); open(w, p, at.stone_store!); deposit(w, p, at.stone_store!, "clay_brick", 3);
    expect(G.countItem(w, storageOf(w, at.stone_store!), item("clay_brick"))).toBe(3);
    G.addItem(w, p, item("sticks"), 6); open(w, p, at.stick_store!); deposit(w, p, at.stick_store!, "sticks", 6);
    expect(G.countItem(w, storageOf(w, at.stick_store!), item("sticks"))).toBe(6);
    // wrong-family deposits fail with the new code
    wrong("ore_store", "wood"); wrong("ore_store", "copper_ingot"); wrong("ore_store", "stone");
    wrong("log_store", "sticks"); wrong("log_store", "copper_ore");
    wrong("stick_store", "wood");
    wrong("crop_store", "wheat_seeds"); wrong("crop_store", "stone");
    wrong("stone_store", "wood"); wrong("stone_store", "iron_ore");
    expect(fails.filter((f) => f === G.BuildFail.WrongStorage).length).toBe(10);
    expect(G.BuildFail.WrongStorage).toBe(34);
  });
  it("withdraw is unaffected, and a store with no accepts still takes everything", () => {
    const { w, p, at } = storesWorld();
    const fails: number[] = []; w.events.on(G.BuildFailed, (e: { reason: number }) => fails.push(e.reason));
    // withdraw from the ore store works even for its own family, and pre-existing contents come out
    G.addItem(w, storageOf(w, at.ore_store!), item("copper_ore"), 4);
    open(w, p, at.ore_store!); intent(w, p, G.IntentAction.Withdraw, at.ore_store!, item("copper_ore"), 3);
    expect([G.countItem(w, storageOf(w, at.ore_store!), item("copper_ore")), G.countItem(w, p, item("copper_ore"))]).toEqual([1, 3]);
    expect(fails).toEqual([]);
    // the generic box takes ore, ingots, wood, crops — everything
    for (const k of ["copper_ore", "copper_ingot", "wood", "wheat", "stone"]) {
      G.addItem(w, p, item(k), 2); open(w, p, at.basic_storage_box!); deposit(w, p, at.basic_storage_box!, k, 2);
      expect(G.countItem(w, storageOf(w, at.basic_storage_box!), item(k))).toBe(2);
    }
    expect(fails).toEqual([]);
  });
});

// ---------- AI harness (ADR-323 pattern) ----------
let nid = 9000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number }
function rig(opts: { pid?: number; seed?: number; base?: { x: number; y: number } } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  G.bindAgentWorld(a, w);
  if (opts.base) aiMemoryOf(a).base = opts.base;
  return { w, p, a, id: (k) => G.gameplayDefs(w).itemId(k) };
}
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, { x: 0, y: 0 })!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits }, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const placeFree = (r: Rig, key: string, x: number, y: number, by: Entity = r.p): Entity => {
  const dd = G.gameplayDefs(r.w); const sn = G.snapPlacement(r.w, { piece: dd.pieceId(key), x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`); const e = G.placePiece(r.w, by, sn, { pay: false }); steps(r.w, 1); return e;
};
const boxOf = (w: World, pieceE: Entity): Entity => G.resolveAttachment(w, pieceE, G.AttachKind.Storage)!;
/** Bot container actions through the real server path: PlayerIntent + containerSystem (WrongStorage enforced). */
function applyContainer(r: Rig, o: AgentOutput): void {
  for (const a of o.actions) {
    const [k, t, i, n] = a.split(":");
    if (k === "copen") intent(r.w, r.p, G.IntentAction.OpenContainer, Number(t) as Entity);
    else if (k === "cdeposit") intent(r.w, r.p, G.IntentAction.Deposit, Number(t) as Entity, Number(i), Number(n));
    else if (k === "cwithdraw") intent(r.w, r.p, G.IntentAction.Withdraw, Number(t) as Entity, Number(i), Number(n));
    else if (k === "cclose") intent(r.w, r.p, G.IntentAction.CloseContainer, Number(t) as Entity);
  }
}
const beh = (name: string): G.GameBehavior => [...baseBehaviors()].find((b) => b.name === name)!;

describe("ADR-355 storage stores: AI lookup", () => {
  it("nearbyStorageFor prefers the matching store and falls back to a generic store", () => {
    const r = rig({ base: { x: -1, y: -1 } });
    const ore = placeFree(r, "ore_store", 1.5, 0.5); const generic = placeFree(r, "basic_storage_box", 3.5, 0.5);
    expect(G.nearbyStorageFor(r.w, r.p, r.id("copper_ore"), 24)?.piece).toBe(ore);
    expect(G.nearbyStorageFor(r.w, r.p, r.id("wood"), 24)?.piece).toBe(generic); // no log store: generic fallback
    expect(G.nearbyStorageFor(r.w, r.p, r.id("copper_ingot"), 24)?.piece).toBe(generic); // ingots have no store
    const log = placeFree(r, "log_store", 1.5, 2.5);
    expect(G.nearbyStorageFor(r.w, r.p, r.id("wood"), 24)?.piece).toBe(log);
    expect(G.nearbyStorageFor(r.w, r.p, r.id("stone"), 24)?.piece).toBe(generic); // no stone store: generic fallback
  });
  it("nearbyStorageFor is undefined with no base storage at all; storageHolding prefers the matching store that holds it", () => {
    const r = rig({ base: { x: -1, y: -1 } });
    expect(G.nearbyStorageFor(r.w, r.p, r.id("copper_ore"), 24)).toBeUndefined();
    const ore = placeFree(r, "ore_store", 1.5, 0.5); const generic = placeFree(r, "basic_storage_box", 3.5, 0.5);
    G.addItem(r.w, boxOf(r.w, generic), r.id("copper_ore"), 4);
    expect(G.storageHolding(r.w, r.p, r.id("copper_ore"), 24)?.piece).toBe(generic); // only the generic box holds any
    G.addItem(r.w, boxOf(r.w, ore), r.id("copper_ore"), 2);
    expect(G.storageHolding(r.w, r.p, r.id("copper_ore"), 24)?.piece).toBe(ore); // matching store wins once it holds ore
    expect(G.storageHolding(r.w, r.p, r.id("wood"), 24)).toBeUndefined(); // nobody holds wood
  });
});

describe("ADR-355 storage stores: AI deposit + fetch", () => {
  it("a bot stashing surplus ore deposits it into the ore store, not the generic box", () => {
    const r = rig({ base: { x: -1, y: -1 } });
    const ore = placeFree(r, "ore_store", 1.5, 0.5); const generic = placeFree(r, "basic_storage_box", 3.5, 0.5);
    G.addItem(r.w, r.p, r.id("copper_ore"), 5);
    const b = beh("stash");
    for (let i = 0; i < 200 && G.countItem(r.w, boxOf(r.w, ore), r.id("copper_ore")) < 5; i++) {
      const c = ctxOf(r); c.world.surplus = [{ item: r.id("copper_ore"), count: 5 }]; // the plan does not need this ore
      const o = out(); b.run(c, o); applyContainer(r, o); r.w.step(DT);
    }
    expect(G.countItem(r.w, boxOf(r.w, ore), r.id("copper_ore"))).toBe(5);
    expect(G.countItem(r.w, boxOf(r.w, generic), r.id("copper_ore"))).toBe(0);
    expect(G.countItem(r.w, r.p, r.id("copper_ore"))).toBe(0);
  });
  it("a bot with no matching store falls back to the generic box", () => {
    const r = rig({ base: { x: -1, y: -1 } });
    const generic = placeFree(r, "basic_storage_box", 1.5, 0.5);
    G.addItem(r.w, r.p, r.id("copper_ore"), 5);
    const b = beh("stash");
    for (let i = 0; i < 200 && G.countItem(r.w, boxOf(r.w, generic), r.id("copper_ore")) < 5; i++) {
      const c = ctxOf(r); c.world.surplus = [{ item: r.id("copper_ore"), count: 5 }];
      const o = out(); b.run(c, o); applyContainer(r, o); r.w.step(DT);
    }
    expect(G.countItem(r.w, boxOf(r.w, generic), r.id("copper_ore"))).toBe(5);
    expect(G.countItem(r.w, r.p, r.id("copper_ore"))).toBe(0);
  });
  it("a hired worker withdraws ore from its employer's ore store, not the generic box", () => {
    const r = rig({ pid: 55 });
    const boss = net(r.w, pid(r.w, spawnLearned(r.w, { x: 4, y: 4, maxWeight: 0 }), 7)); ensureClaim(r.w, boss, 4, 4);
    r.w.add(r.p, G.Worker, { owner: 7, homeX: 4, homeY: 4 } as never);
    r.w.set(r.p, Transform, { x: 4.5, y: 1.0 });
    const ore = placeFree(r, "ore_store", 4.5, 2.5, boss); G.addItem(r.w, boxOf(r.w, ore), r.id("copper_ore"), 10);
    const generic = placeFree(r, "basic_storage_box", 6.5, 2.5, boss); G.addItem(r.w, boxOf(r.w, generic), r.id("copper_ore"), 10);
    const b = beh("base_work");
    const fakePlan = { goal: "test", step: { k: "withdraw", item: r.id("copper_ore"), count: 3 }, leaves: [], hunt: [], keep: new Set<number>(), blocked: [] };
    for (let i = 0; i < 300 && G.countItem(r.w, r.p, r.id("copper_ore")) < 3; i++) {
      const c = ctxOf(r); c.world.plan = fakePlan as G.Plan;
      const o = out(); b.run(c, o); applyContainer(r, o); r.w.step(DT);
    }
    expect(G.countItem(r.w, r.p, r.id("copper_ore"))).toBe(3);
    expect(G.countItem(r.w, boxOf(r.w, ore), r.id("copper_ore"))).toBe(7); // from the employer's ore store
    expect(G.countItem(r.w, boxOf(r.w, generic), r.id("copper_ore"))).toBe(10); // generic box untouched
  });
  it("a hired worker never fetches from another player's store, even when it is the nearest one holding the item", () => {
    const r = rig({ pid: 55 });
    const boss = net(r.w, pid(r.w, spawnLearned(r.w, { x: 4, y: 4, maxWeight: 0 }), 7)); ensureClaim(r.w, boss, 4, 4);
    r.w.add(r.p, G.Worker, { owner: 7, homeX: 4, homeY: 4 } as never);
    const ore = placeFree(r, "ore_store", 4.5, 2.5, boss); G.addItem(r.w, boxOf(r.w, ore), r.id("copper_ore"), 10);
    const generic = placeFree(r, "basic_storage_box", 6.5, 2.5, boss); G.addItem(r.w, boxOf(r.w, generic), r.id("copper_ore"), 10);
    // a stranger's claimed ore store, nearer to the worker than the employer's — and outside both claims
    // (claims are 32-tile disks, so the stranger's flag sits far enough away that neither claim overlaps the other base)
    const stranger = net(r.w, pid(r.w, spawnLearned(r.w, { x: 44, y: 0, maxWeight: 0 }), 99)); ensureClaim(r.w, stranger, 44, 0);
    const theirs = placeFree(r, "ore_store", 42, 1, stranger); G.addItem(r.w, boxOf(r.w, theirs), r.id("copper_ore"), 10);
    r.w.set(r.p, Transform, { x: 40, y: 1 });
    const c = ctxOf(r);
    expect(G.mayTakeFromStorageAt(r.w, r.p, { piece: theirs, x: 42, y: 1 }, { x: 4, y: 4 }, 5)).toBe(false);
    const target = G.storageTargetFor(c, r.id("copper_ore"), true);
    expect(target).toBeDefined(); expect(target!.id).not.toBe(theirs); // never the stranger's piece
    expect([ore, generic]).toContain(target!.id); // the employer's stores only (the scanned base box as fallback)
    expect(G.countItem(r.w, boxOf(r.w, theirs), r.id("copper_ore"))).toBe(10);
  });
});
