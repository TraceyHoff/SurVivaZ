/**
 * ADR-481: place a liquid container on the ground — a permanent loot bag (no decay, no claim totem)
 * that rain-fills like a carried container, capped at 8 per player, with a hired-bot trigger that
 * places a spare full container at the home anchor. Anyone may pick a placed container back up
 * (only death bags are owner-locked); the bag vanishes the moment it is emptied.
 */
import { describe, it, expect } from "vitest";
import { CommandRegistry, installCommandHandlers, installPermissions, CommandRejected, Membership, PlayerId, Transform, setTimeOfDay, Weather, idleOutput, type AgentContext, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { fillHireSensors } from "../src/ai/hire_behaviors.js";
import type { AgentWorldView } from "../src/agents.js";
import { collect, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);
const FLASK = id("waterskin"); const WOOD = id("wood");
const T = (s: number) => Math.ceil(s * 20);
const mk = (w: World, pid: number, x = 0, y = 0) => { const p = G.spawnPlayer(w, { x, y }); w.add(p, PlayerId, { id: pid }); return p; };
/** Day 1 (past the first-day no-rain rule) + pinned Rain. */
const rainy = (w: World) => { setTimeOfDay(w, 12, 1); Object.assign(w.env(Weather), { kind: G.WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 }); };
/** Drive the 20-tick loot pass directly (1 s per pass). */
const pass = (w: World, n: number) => { for (let i = 0; i < n; i++) { G.lootBagDespawnSystem(w); w.tick += 20; } };
const durabilityOf = (w: World, e: Entity, key: string): number => G.listSlots(w, e).find((s) => s.item === id(key))?.durability ?? -1;
function drain(w: World, e: Entity, key: string): number { const s = G.listSlots(w, e).find((x) => x.item === id(key))!.slot; while (G.takeSip(w, e, s)); return s; }
/** Jump the clock (the system reads absolute ticks, so this is what a long wait / a restart looks like). */
const jump = (w: World, to: number) => { w.tick = to; steps(w, 20); };

/** A 1-tile roofed room at (10,10) (same builder as ADR-452). */
function room(w: World, b: Entity): void {
  const snap = (key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) =>
    G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
  const place = (key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) => {
    const sn = snap(key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
    return G.placePiece(w, b, sn, { pay: false });
  };
  place("foundation", 10.5, 10.5);
  place("wall", 10.5, 10, {}); place("wall", 10.5, 11, {});
  place("wall", 10, 10.5, {}); place("wall", 11, 10.5, {});
  place("roof_flat", 10.5, 10.5, { level: 1 });
}

/** Hired-worker setup (same shape as ADR-265): a bot with Worker owner 77, home (0,0). */
function botSetup() {
  const w = makeWorld(); installPermissions(w);
  const map = new TileMap();
  for (let y = -10; y < 20; y++) for (let x = -10; x < 20; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = G.spawnPlayer(w, { x: .5, y: 2.5, maxWeight: 0 }); w.add(p, G.Worker, {} as never);
  w.add(p, Membership, { partyId: 0, clanId: 0 }); // buildAgentView's social sensor reads Membership
  G.grantSkillUnlocks(w, p);
  w.set(p, G.Worker, { owner: 77, job: G.WorkerJob.Gather, homeX: 0, homeY: 0 });
  const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
  const view: AgentWorldView = { seen: [], home: { x: 0, y: 0 }, playerName: "owner" };
  const ctx = (): AgentContext<AgentWorldView> => ({ ...G.buildAgentView(w, p, a, { x: 0, y: 0 })!, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a });
  return { w, p, a, view, ctx };
}

describe("ADR-481 place liquid containers", () => {
  it("place creates a permanent one-container bag; the player loses the container; no claim needed", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 1);
    const bag = G.placeItem(w, p, FLASK)!;
    expect(w.isAlive(bag)).toBe(true);
    const lb = w.get(bag, G.LootBag)!;
    expect(lb.despawnAtTick).toBe(G.PERMANENT_DESPAWN);
    expect(lb.kind).toBe(G.LootSource.Placed);
    expect(lb.owner).toBe(7);
    expect(G.listSlots(w, bag).filter((s) => s.item)).toHaveLength(1);
    expect(G.listSlots(w, bag)[0]!.item).toBe(FLASK);
    expect(w.get(bag, G.Container)!.slotCount).toBe(1);
    expect(G.countItem(w, p, FLASK)).toBe(0);
    expect(G.lootLabelText({ item: FLASK, count: 1, stacks: 1, source: G.LootSource.Placed }, (n) => d.items.get(n)?.key)).toBe("waterskin");
  });

  it("a placed bag outlives a dropped bag: still there past droppedSeconds", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 1); const bag = G.placeItem(w, p, FLASK)!;
    G.addItem(w, p, WOOD, 5); const dropped = G.dropItem(w, p, WOOD, 5)!;
    jump(w, w.tick + T(180) + 100);
    expect(w.isAlive(dropped)).toBe(false);
    expect(w.isAlive(bag)).toBe(true);
  });

  it("a non-container cannot be placed", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, WOOD, 5);
    expect(G.placeItemValidate(w, p, WOOD)).toBe("not_container");
    expect(G.placeItem(w, p, WOOD)).toBeUndefined();
    expect([...w.query([G.LootBag])]).toHaveLength(0);
    expect(G.placeItemValidate(w, p, FLASK)).toBe("no_item");
  });

  it("per-player cap 8: the 9th place is refused", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 9);
    for (let i = 0; i < 8; i++) expect(G.placeItem(w, p, FLASK)).toBeDefined();
    expect(G.countPlacedBags(w, 7)).toBe(8);
    expect(G.placeItemValidate(w, p, FLASK)).toBe("cap_reached");
    expect(G.placeItem(w, p, FLASK)).toBeUndefined();
    expect(G.countPlacedBags(w, 7)).toBe(8);
    expect(G.countItem(w, p, FLASK)).toBe(1); // refused place keeps the container
  });

  it("picking the container back up empties the bag, so it vanishes immediately", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 1); const bag = G.placeItem(w, p, FLASK)!;
    const gone = collect(w, G.LootBagDespawned);
    expect(G.transferItem(w, bag, p, FLASK, 1)).toBe(1);
    expect(G.countItem(w, p, FLASK)).toBe(1);
    w.tick += 20; // the pass stamps emptiedTick = now, so the tick must be past 0 for now >= emptiedTick
    G.lootBagDespawnSystem(w);
    expect(w.isAlive(bag)).toBe(false);
    steps(w, 1); // pump the queued LootBagDespawned event
    expect(gone.map((g) => g.reason)).toEqual(["emptied"]);
  });

  it("rain fills a placed container (900 s -> full, 3 sips)", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 1); drain(w, p, "waterskin");
    const bag = G.placeItem(w, p, FLASK)!;
    expect(durabilityOf(w, bag, "waterskin")).toBe(0);
    rainy(w);
    pass(w, 900);
    expect(durabilityOf(w, bag, "waterskin")).toBe(3);
  });

  it("no rain, no fill (clear weather)", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, FLASK, 1); drain(w, p, "waterskin");
    const bag = G.placeItem(w, p, FLASK)!;
    pass(w, 900);
    expect(durabilityOf(w, bag, "waterskin")).toBe(0);
  });

  it("a roofed placed bag stays dry in the rain", () => {
    const w = makeWorld(); installPermissions(w);
    const b = G.spawnPlayer(w, { x: 10.5, y: 10.5 }); room(w, b);
    // stand just outside the west wall, facing in, so the bag lands on the room centre (10.5, 10.5)
    const p = mk(w, 7, 11.1, 10.5); w.set(p, Transform, { x: 11.1, y: 10.5, facing: Math.PI });
    G.addItem(w, p, FLASK, 1); drain(w, p, "waterskin");
    const bag = G.placeItem(w, p, FLASK)!;
    expect(w.get(bag, Transform)!.x).toBeCloseTo(10.5, 1);
    rainy(w);
    pass(w, 900);
    expect(durabilityOf(w, bag, "waterskin")).toBe(0);
  });

  it("a boiled container placed in the rain reverts to raw on refill", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    G.addItem(w, p, id("boiled_waterskin"), 1); drain(w, p, "boiled_waterskin");
    const bag = G.placeItem(w, p, id("boiled_waterskin"))!;
    rainy(w);
    pass(w, 900);
    expect(G.listSlots(w, bag).some((s) => s.item === FLASK && s.durability > 0)).toBe(true);
    expect(G.listSlots(w, bag).some((s) => s.item === id("boiled_waterskin"))).toBe(false);
  });

  it("PlaceItemCmd is registered and dispatches through the real handler (rejects a non-container)", () => {
    const w = makeWorld(); installPermissions(w); const p = mk(w, 7);
    expect(G.PET_COMMANDS).toContain(G.PlaceItemCmd);
    const reg = G.registerGameplayCommands(new CommandRegistry());
    const h = installCommandHandlers(w, reg); G.installPetCommands(w, h);
    const rej: string[] = []; w.events.on(CommandRejected, (e) => rej.push(e.reason));
    const run = (v: Record<string, number>) => { h.enqueue(p, 7, 1, reg.make(G.PlaceItemCmd as never, v as never)); w.step(1 / 20); };
    G.addItem(w, p, WOOD, 5);
    run({ item: WOOD }); expect(rej).toEqual(["not_container"]); expect([...w.query([G.LootBag])]).toHaveLength(0);
    G.addItem(w, p, FLASK, 1);
    run({ item: FLASK }); expect(rej).toEqual(["not_container"]);
    const bags = [...w.query([G.LootBag])]; expect(bags).toHaveLength(1);
    expect(w.get(bags[0]!, G.LootBag)!.kind).toBe(G.LootSource.Placed);
  });

  it("a hired bot's place counts against its employer's cap", () => {
    const { w, p } = botSetup();
    G.addItem(w, p, FLASK, 1);
    expect(G.placedBagOwnerId(w, p)).toBe(77);
    const bag = G.placeItem(w, p, FLASK)!;
    expect(w.get(bag, G.LootBag)!.owner).toBe(77);
    expect(G.countPlacedBags(w, 77)).toBe(1);
  });

  it("hire sensor: two full containers is a spare, one full is not, one full + one drained is not", () => {
    const { w, p, a, view } = botSetup();
    G.addItem(w, p, FLASK, 1);
    fillHireSensors(w, p, view, a);
    expect(view.hire?.spareContainer).toBeUndefined();
    G.addItem(w, p, FLASK, 1);
    fillHireSensors(w, p, view, a);
    expect(view.hire?.spareContainer).toBe(FLASK);
    // drain one of the two: only one full container left, no spare
    const slot = G.listSlots(w, p).find((s) => s.item === FLASK)!.slot;
    while (G.takeSip(w, p, slot)); // drains that slot's durability to 0
    fillHireSensors(w, p, view, a);
    expect(view.hire?.spareContainer).toBeUndefined();
  });

  it("place_container behaviour: spare at the anchor pushes a PlaceItemCmd; no spare, no command", () => {
    const { w, p, ctx } = botSetup();
    const b = G.hireBehaviors().find((x) => x.name === "place_container")!;
    expect(b).toBeDefined();
    G.addItem(w, p, FLASK, 2);
    let c = ctx();
    expect(c.world.hire?.spareContainer).toBe(FLASK);
    expect(b.considerations.find((x) => x.name === "spare")!.input(c)).toBe(1);
    expect(b.considerations.find((x) => x.name === "hired")!.input(c)).toBe(1);
    // stand on the anchor so the behaviour places instead of walking
    const h = c.world.hire!; w.set(p, Transform, { x: h.ax, y: h.ay });
    c = ctx();
    const o = idleOutput(); b.run(c, o);
    const cmds = (o as unknown as { commands?: { type: string; payload: unknown }[] }).commands ?? [];
    expect(cmds).toContainEqual({ type: G.PlaceItemCmd.name, payload: { item: FLASK } });
    // one full container only: the spare consideration is 0 and the run pushes nothing
    const { w: w2, p: p2, ctx: ctx2 } = botSetup();
    G.addItem(w2, p2, FLASK, 1);
    const c2 = ctx2();
    expect(b.considerations.find((x) => x.name === "spare")!.input(c2)).toBe(0);
    const o2 = idleOutput(); b.run(c2, o2);
    expect((o2 as unknown as { commands?: unknown[] }).commands ?? []).toHaveLength(0);
  });
});
