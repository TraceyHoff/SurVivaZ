/**
 * ADR-250: Basic Storage Box — starter storage that is never skill-gated, hand-built from gatherable sticks/fiber/wood,
 * a 12-slot placeable container (existing container UI / intents), solid, persistent, never despawned by the ADR-238
 * loot timers, picked up for a full refund with its contents dropped as a loot bag (destroyed: contents drop too), and a
 * storage API + cwithdraw action for AI humans.
 */
import { describe, expect, it } from "vitest";
import { CommandRegistry, Transform, type Entity, type InputFrame, type World } from "@engine/core";
import ids from "../data/ids.lock.json";
import * as G from "../src/index.js";
import { makeWorld, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const KEY = "basic_storage_box";
const def = d.pieces.get(d.pieceId(KEY))!;
const item = (k: string) => d.itemId(k);
function fresh(): { w: World; p: Entity } { const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1); ensureClaim(w, p, -2, 2); return { w, p }; }
const give = (w: World, e: Entity, key = KEY, n = 1): void => { for (const c of G.pieceCost(d, d.pieces.get(d.pieceId(key))!, 1)) G.addItem(w, e, c.item, c.count * n); };
const place = (w: World, e: Entity, x = 1.5, y = 0.5, key = KEY) => G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
const storageOf = (w: World, piece: Entity): Entity => G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
const intent = (w: World, p: Entity, action: number, target: Entity, it = 0, count = 0): void => { w.set(p, G.PlayerIntent, { action, target, item: it, count }); steps(w, 1); };
const bagsNear = (w: World, x: number, y: number): Entity[] => [...w.query([G.LootBag, Transform])].filter((b) => { const t = w.get(b, Transform)!; return Math.hypot(t.x - x, t.y - y) < 0.6; });

describe("ADR-250 basic storage box: data + recipe", () => {
  it("is a 12-slot starter container: hand-built (no station), never gated, smaller than the large chest", () => {
    expect((ids.pieces as Record<string, number>)[KEY]).toBe(182);
    expect(def.starter).toBe(true); expect(def.pickup).toBe(true);
    expect(def.container).toBe(12); expect(def.container).toBeLessThan(d.pieces.get(d.pieceId("large_chest"))!.container);
    expect(def.station).toBe(0); expect(def.fired).toBe(false); expect(def.stall).toBeNull(); expect(def.solid).toBe(true);
    expect(G.pieceGates(d, def, def.fixedTier)).toEqual([]);
    expect(G.UNLOCK_NODE.has(`piece:${KEY}`)).toBe(false);
    expect(G.pieceCost(d, def, def.fixedTier).map((c) => [d.items.get(c.item)!.key, c.count])).toEqual([["sticks", 10], ["fiber", 6], ["wood", 2]]);
  });
  it("every ingredient is gathered with bare hands (no tool, no station, no skill)", () => {
    for (const c of G.pieceCost(d, def, def.fixedTier)) {
      const src = [...d.resources.values()].filter((r) => r.requiredTool === 0 && r.minTier === 0 && r.yields.some((y) => y.item === c.item));
      expect(src.length, d.items.get(c.item)!.key).toBeGreaterThan(0);
    }
  });
});

describe("ADR-250 basic storage box: placement", () => {
  it("a fresh character (nothing learned) places it, while the workbench is still skill-locked", () => {
    const { w, p } = fresh(); give(w, p); give(w, p, "workbench");
    const wb = place(w, p, 3.5, 0.5, "workbench"); expect(wb).toEqual({ ok: false, reason: G.BuildFail.SkillLocked });
    const had = G.pieceCost(d, def, 1).map((c) => G.countItem(w, p, c.item));
    const r = place(w, p); expect(r.ok).toBe(true);
    expect(G.pieceCost(d, def, 1).map((c, i) => had[i]! - G.countItem(w, p, c.item))).toEqual([10, 6, 2]); // paid
    const box = (r as { piece: Entity }).piece; expect(w.getField(box, G.BuildPiece, "type")).toBe(def.id);
    expect(w.get(storageOf(w, box), G.Container)!.slotCount).toBe(12);
  });
  it("shows unlocked with its cost in the build window for a fresh character", () => {
    const { w, p } = fresh(); give(w, p);
    const v = G.buildView({ world: w, player: p } as G.MenuCtx).find((x) => x.key === KEY)!;
    expect(v).toBeDefined(); expect(v.tiers.every((t) => !t.locked && !t.requirement)).toBe(true);
    expect(v.tiers[0]!.cost.map((c) => c.count)).toEqual([10, 6, 2]);
  });
  it("blocks movement like the other stations (solid cell)", () => {
    const { w, p } = fresh(); give(w, p); expect(place(w, p, 1.5, 0.5).ok).toBe(true);
    expect(G.solidCell(G.structures(w), 1, 0, 0)).toBe(true);
  });
});

describe("ADR-250 basic storage box: storing", () => {
  it("open / deposit / withdraw through the container intents", () => {
    const { w, p } = fresh(); give(w, p); const box = (place(w, p) as { piece: Entity }).piece; const st = storageOf(w, box);
    G.addItem(w, p, item("stone"), 7); G.addItem(w, p, item("wood"), 5);
    intent(w, p, G.IntentAction.OpenContainer, box); expect(w.getField(p, G.Viewing, "container")).toBe(st);
    intent(w, p, G.IntentAction.Deposit, box, item("stone"), 7); intent(w, p, G.IntentAction.Deposit, box, item("wood"), 5);
    expect([G.countItem(w, st, item("stone")), G.countItem(w, st, item("wood"))]).toEqual([7, 5]);
    intent(w, p, G.IntentAction.Withdraw, box, item("stone"), 3);
    expect([G.countItem(w, st, item("stone")), G.countItem(w, p, item("stone"))]).toEqual([4, 3]);
    intent(w, p, G.IntentAction.Withdraw, box, 0, 0); // take all
    expect(G.listSlots(w, st)).toEqual([]); expect(G.countItem(w, p, item("wood"))).toBe(5);
    intent(w, p, G.IntentAction.CloseContainer, box); expect(w.has(p, G.Viewing)).toBe(false);
  });
  it("is not a loot bag: the ADR-238 timers never touch it (or its contents)", () => {
    const { w, p } = fresh(); give(w, p); const box = (place(w, p) as { piece: Entity }).piece; const st = storageOf(w, box);
    G.addItem(w, st, item("stone"), 9);
    expect(w.has(box, G.LootBag) || w.has(st, G.LootBag)).toBe(false);
    const bag = G.dropItem(w, p, item("wood"), 1) ?? (() => { G.addItem(w, p, item("wood"), 1); return G.dropItem(w, p, item("wood"), 1)!; })();
    steps(w, 20 * (Math.max(G.DESPAWN.droppedSeconds, G.DESPAWN.stallBagSeconds) + G.DESPAWN.fadeSeconds + 5));
    expect(w.isAlive(bag)).toBe(false); // a dropped bag went...
    expect(w.isAlive(box) && w.isAlive(st)).toBe(true); expect(G.countItem(w, st, item("stone"))).toBe(9); // ...the box stayed, full
  }, 60_000);
});

describe("ADR-250 basic storage box: pick up / destroy", () => {
  it("Demolish = Pick up: full refund and the contents drop as a loot bag", () => {
    const { w, p } = fresh(); give(w, p); const box = (place(w, p) as { piece: Entity }).piece; const st = storageOf(w, box);
    G.addItem(w, st, item("stone"), 6); G.addItem(w, st, item("fiber"), 2);
    intent(w, p, G.IntentAction.OpenContainer, box); // a viewer is closed out cleanly
    intent(w, p, G.IntentAction.Demolish, box);
    expect(w.isAlive(box)).toBe(false); expect(w.has(p, G.Viewing)).toBe(false);
    expect([G.countItem(w, p, item("sticks")), G.countItem(w, p, item("fiber")), G.countItem(w, p, item("wood"))]).toEqual([10, 6, 2]);
    const [bag] = bagsNear(w, 1.5, 0.5); expect(bag).toBeDefined();
    expect([G.countItem(w, bag!, item("stone")), G.countItem(w, bag!, item("fiber"))]).toEqual([6, 2]);
    expect(w.getField(bag!, G.LootBag, "kind")).toBe(G.LootSource.Dropped);
  });
  it("ADR-317: your own damaged box still refunds in full (own builds are never scaled by damage)", () => {
    const { w, p } = fresh(); give(w, p); const box = (place(w, p) as { piece: Entity }).piece;
    w.setField(box, G.BuildPiece, "hp", Math.floor(G.maxHpOf(w, box) / 2)); intent(w, p, G.IntentAction.Demolish, box);
    expect(G.countItem(w, p, item("sticks"))).toBe(10);
    expect(d.pieces.get(d.pieceId("storage_box"))!.pickup).toBe(false);
  });
  it("destroyed (raid / decay) boxes spill their contents too; empty boxes leave nothing", () => {
    const { w, p } = fresh(); give(w, p, KEY, 2);
    const a = (place(w, p, 1.5, 0.5) as { piece: Entity }).piece; const b = (place(w, p, 1.5, 2.5) as { piece: Entity }).piece;
    G.addItem(w, storageOf(w, a), item("stone"), 4);
    G.destroyPiece(w, a, G.DestroyCause.Damage); G.destroyPiece(w, b, G.DestroyCause.Damage); steps(w, 1);
    const [bag] = bagsNear(w, 1.5, 0.5); expect(G.countItem(w, bag!, item("stone"))).toBe(4);
    expect(bagsNear(w, 1.5, 2.5)).toEqual([]);
  });
});

describe("ADR-250 AI storage interface", () => {
  it("cwithdraw / cdeposit / copen / cclose become net commands", () => {
    expect(G.actionCommand("cwithdraw:9:4:3")).toEqual({ type: G.WithdrawCmd.name, payload: { target: 9, item: 4, count: 3 } });
    expect(G.actionCommand("cwithdraw:9:0:0")).toEqual({ type: G.WithdrawCmd.name, payload: { target: 9, item: 0, count: 0 } });
    expect(G.actionCommand("cwithdraw:9:4")).toBeUndefined();
    const out = G.emitAgentCommands({ actions: G.storageWithdrawActions(9 as Entity, 4, 3) } as never) as G.AgentOutputWithCommands;
    expect(out.actions).toEqual([]); expect(out.commands!.map((c) => c.type)).toEqual([G.OpenContainerCmd.name, G.WithdrawCmd.name, G.CloseContainerCmd.name]);
  });
  it("nearbyStorage lists base storage (not fires, stalls, turrets) closest first with free slots and contents", () => {
    const { w, p } = fresh(); give(w, p, KEY, 2); give(w, p, "campfire");
    const near = (place(w, p, 1.5, 0.5) as { piece: Entity }).piece; const fr = place(w, p, 3.5, 0.5); expect(fr.ok).toBe(true); const far = (fr as { piece: Entity }).piece;
    G.placePiece(w, p, G.snapPlacement(w, { piece: d.pieceId("campfire"), x: 0.5, y: 2.5, level: 0, rot: 0, tier: 1, variant: 0 }) as G.Snapped, { pay: false });
    G.addItem(w, storageOf(w, far), item("stone"), 5); G.addItem(w, storageOf(w, far), item("stone"), 5);
    const s = G.nearbyStorage(w, p, 8);
    expect(s.map((x) => x.piece)).toEqual([near, far]);
    expect(s[0]).toMatchObject({ key: KEY, slots: 12, free: 12, contents: [] });
    expect(s[1]!.contents).toEqual([{ item: item("stone"), count: 10 }]); expect(G.storedCount(s[1]!, item("stone"))).toBe(10);
    expect(G.nearbyStorage(w, p, 2.5).map((x) => x.piece)).toEqual([near]);
    for (const k of ["campfire", "stall_blanket", "arrow_turret", "feeding_trough", "workbench"]) expect(G.isBaseStoragePiece(d.pieces.get(d.pieceId(k))), k).toBe(false);
    for (const k of [KEY, "storage_box", "large_chest", "barrel_storage"]) expect(G.isBaseStoragePiece(d.pieces.get(d.pieceId(k))), k).toBe(true);
  });
  it("an AI human banks and retrieves through its action strings end to end (server rules apply)", () => {
    const { w, p } = fresh(); give(w, p); const box = (place(w, p) as { piece: Entity }).piece; const st = storageOf(w, box);
    const reg = G.registerGameplayCommands(new CommandRegistry());
    const byName = new Map(G.GAMEPLAY_COMMANDS.map(([c]) => [c.name, c]));
    const run = (actions: string[]): void => { // one action per think tick
      for (const a of actions) { const c = G.actionCommand(a)!; G.applyGameplayInput(w, p, { actions: 0, commands: [reg.make(byName.get(c.type)! as never, c.payload as never)] } as unknown as InputFrame, reg); steps(w, 1); }
    };
    G.addItem(w, p, item("stone"), 8);
    const target = G.nearbyStorage(w, p, 6)[0]!; expect(target.piece).toBe(box);
    run(G.storageDepositActions(target.piece, item("stone"), 8));
    expect([G.countItem(w, st, item("stone")), G.countItem(w, p, item("stone"))]).toEqual([8, 0]); expect(w.has(p, G.Viewing)).toBe(false);
    run(G.storageWithdrawActions(target.piece, item("stone"), 5));
    expect([G.countItem(w, st, item("stone")), G.countItem(w, p, item("stone"))]).toEqual([3, 5]);
    // out of reach: the server refuses exactly as for a player
    w.set(p, Transform, { x: 30, y: 30, z: 0 }); steps(w, 1); run(G.storageWithdrawActions(box, 0, 0));
    expect(G.countItem(w, st, item("stone"))).toBe(3);
  });
  it("the survivor base plan builds the starter box (no skill to learn first)", () => {
    expect(G.BUILD_PLAN_PIECES).toContain(KEY); expect(G.BUILD_PLAN_PIECES).not.toContain("storage_box");
  });
});
