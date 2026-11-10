// ADR-321: AI humans tame, ride, saddle and look after mounts on their own (ai/mount_behaviors.ts).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const B = G.MOUNT_BOTS;
let nid = 4000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(opts: { learned?: boolean; x?: number; y?: number; pid?: number; seed?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const p = opts.learned === false ? G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 7 }) : spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 });
  pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  return { w, p, a, id: (k) => d.itemId(k), home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
function ctxOf(r: Rig): Ctx {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits, bravery: 0.8, industriousness: 0.8 }, rng: r.a.rng, agent: r.a, world: v.world };
}
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const behavior = (name: string): G.GameBehavior => [...G.mountBehaviors(), ...G.referenceBehaviors()].find((b) => b.name === name)!;
const passes = (b: G.GameBehavior, c: Ctx): boolean => b.considerations.every((k) => (k.weight ?? 1) * (k.input(c) >= 0.5 ? 1 : 0) > 0 || (k.curve.type === "linear" && k.input(c) > 0));
/** Apply the bot's mount / equip / craft commands the way the server handlers do, plus its movement. */
function apply(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  const { w, p } = r; for (const a of o.actions) if (a.startsWith("equip:")) { const s = Number(a.slice(6)); w.set(p, G.Equipment, { mainHandSlot: s, mainHandItem: G.readSlots(w, p).item(s) }); log.push(a); }
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number; item: number; slot: number; recipe: number }; const t = v.target as Entity; log.push(c.type);
    if (c.type === G.MountFeedCmd.name) { if (!G.checkFeed(w, p, t, v.item)) G.feedMount(w, p, t, v.item); }
    else if (c.type === G.MountRideCmd.name) G.rideMount(w, p, t);
    else if (c.type === G.MountDismountCmd.name) G.dismount(w, p);
    else if (c.type === G.MountSaddleCmd.name) G.saddleMount(w, p, t, v.slot);
    else if (c.type === G.MountRepairCmd.name) G.repairSaddle(w, p, t);
    else if (c.type === G.QueueCraftCmd.name) G.enqueueCraft(w, p, v.recipe, 1);
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(w, p, bits, DT);
}
/** Run one behaviour (+ the ADR-321 mount policy, exactly as survivorRegistry wraps it) for up to n ticks. */
function drive(r: Rig, name: string, n: number, until: () => boolean, log: string[] = [], hook?: (o: AgentOutput) => void): number {
  const b = behavior(name);
  for (let i = 0; i < n; i++) {
    const c = ctxOf(r); const o = out(); b.run(c, o); G.mountPolicy(c, o, name); hook?.(o); apply(r, o, log); r.w.step(DT);
    if (until()) return i;
  }
  return -1;
}
const at = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;

describe("ADR-321 in the full survivor controller", () => {
  it("an idle AI human picks tame_mount on its own and ends up owning the horse", () => {
    const r = rig(); const horse = G.spawnAnimal(r.w, "animal_horse", 7, 3); G.addItem(r.w, r.p, r.id("carrot"), 40);
    const ctl = G.survivorController({ seed: 1 }); ctl.add(r.a); const seen = new Set<string>(); const log: string[] = [];
    for (let t = 0; t < 3000 && !r.w.has(horse, G.Mount); t++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)).get(r.a)!; if (r.a.current) seen.add(r.a.current);
      apply(r, o as never, log); r.w.step(DT);
    }
    expect(seen.has("tame_mount")).toBe(true); expect(r.w.getField(horse, G.Mount, "owner")).toBe(7);
  });
});

describe("ADR-321 action strings", () => {
  it("mfeed / mride / mdismount / msaddle / mrepair become the ADR-319 / ADR-320 net commands", () => {
    const o = out(); o.actions = ["mfeed:12:40", "mride:12", "mdismount", "msaddle:12:3", "mrepair:12", "mfeed:12:0", "mride:x"]; G.emitAgentCommands(o);
    expect(o.actions).toEqual([]);
    expect(o.commands!.map((c) => c.type)).toEqual([G.MountFeedCmd.name, G.MountRideCmd.name, G.MountDismountCmd.name, G.MountSaddleCmd.name, G.MountRepairCmd.name]);
    expect(o.commands![0]!.payload).toEqual({ target: 12, item: 40 }); expect(o.commands![3]!.payload).toEqual({ target: 12, slot: 3 });
  });
  it("the survivor registry carries tame_mount / saddle_up / tend_mount", () => {
    const names = G.survivorRegistry().list().map((b) => b.name); for (const n of ["tame_mount", "saddle_up", "tend_mount"]) expect(names).toContain(n);
  });
});

describe("ADR-321 seek and tame", () => {
  it("an AI human with Horsemanship and a liked food walks to a wild horse, holds the food, feeds it and tames it for itself", () => {
    const r = rig(); const horse = G.spawnAnimal(r.w, "animal_horse", 8, 0); G.addItem(r.w, r.p, r.id("carrot"), 40);
    const c0 = ctxOf(r); expect(c0.world.mountSkill).toBe(true); expect(c0.world.tameMount?.id).toBe(horse); expect(passes(behavior("tame_mount"), c0)).toBe(true);
    const log: string[] = []; const n = drive(r, "tame_mount", 2400, () => r.w.has(horse, G.Mount), log);
    expect(n).toBeGreaterThan(0); expect(r.w.getField(horse, G.Mount, "owner")).toBe(7);
    expect(log[0]!.startsWith("equip:")).toBe(true); expect(log).toContain(G.MountFeedCmd.name);
    expect(ctxOf(r).world.tameMount).toBeUndefined(); expect(ctxOf(r).world.mount?.id).toBe(horse); // now it is the bot's mount
  });
  it("is deterministic: the same world and seed tame on the same tick with the same command log", () => {
    const run = (): [number, string] => { const r = rig({ seed: 9 }); const h = G.spawnAnimal(r.w, "animal_horse", 6, 2); G.addItem(r.w, r.p, r.id("carrot"), 40); const log: string[] = []; const n = drive(r, "tame_mount", 2400, () => r.w.has(h, G.Mount), log); return [n, log.join(",")]; };
    expect(run()).toEqual(run());
  });
  it("prefers the faster / tougher species, skips kickers while hurt, foreign claims, and needs the skill and a liked food", () => {
    const r = rig(); const donkey = G.spawnAnimal(r.w, "animal_donkey", 5, 0); const horse = G.spawnAnimal(r.w, "animal_horse", 0, 6);
    expect(ctxOf(r).world.tameMount).toBeUndefined(); // no food yet
    G.addItem(r.w, r.p, r.id("carrot"), 10); r.a.bb.set("tameScanAt", -1e9);
    expect(ctxOf(r).world.tameMount?.id).toBe(horse); void donkey;
    // hurt: an elk (kicker) next door is skipped, the passive deer is taken
    const h = rig(); G.addItem(h.w, h.p, h.id("apple"), 10); const elk = G.spawnAnimal(h.w, "animal_elk", 2, 0); const deer = G.spawnAnimal(h.w, "animal_red_deer", 6, 0);
    h.w.set(h.p, G.Health, { hp: h.w.get(h.p, G.Health)!.max * 0.6 }); expect(ctxOf(h).world.tameMount?.id).toBe(deer);
    h.w.set(h.p, G.Health, { hp: h.w.get(h.p, G.Health)!.max }); h.a.bb.set("tameId", -1); h.a.bb.set("tameScanAt", -1e9); expect(ctxOf(h).world.tameMount?.id).toBe(elk);
    // another player's claim: animals standing in it are not ours to take
    const k = rig(); G.addItem(k.w, k.p, k.id("carrot"), 10); const other = net(k.w, pid(k.w, spawnLearned(k.w, { x: 30, y: 0, maxWeight: 0 }), 99)); ensureClaim(k.w, other, 30, 0);
    G.spawnAnimal(k.w, "animal_horse", 10, 0); expect(ctxOf(k).world.tameMount).toBeUndefined();
    // no Horsemanship: nothing
    const u = rig({ learned: false }); G.addItem(u.w, u.p, u.id("carrot"), 10); G.spawnAnimal(u.w, "animal_horse", 4, 0); const cu = ctxOf(u);
    expect(cu.world.mountSkill).toBe(false); expect(cu.world.tameMount).toBeUndefined();
  });
  it("backs off when a feed spooks the animal (progress dropped) and gives up after giveUpTicks, then ignores that animal", () => {
    const r = rig(); const horse = G.spawnAnimal(r.w, "animal_horse", 1.2, 0); G.addItem(r.w, r.p, r.id("carrot"), 40);
    const b = behavior("tame_mount"); let c = ctxOf(r); expect(c.world.tameMount?.id).toBe(horse);
    r.w.add(horse, G.MountTaming, { progress: 40, by: 7, lastTick: r.w.tick }); c = ctxOf(r); b.run(c, out());
    r.w.set(horse, G.MountTaming, { progress: 25 }); c = ctxOf(r); const o = out(); b.run(c, o); // a spook cost 15
    expect(r.a.bb.num("tameBackoffUntil", -1)).toBeGreaterThan(c.self.tick); expect(o.actions.some((x) => x.startsWith("mfeed"))).toBe(false);
    expect(o.moveX).toBeLessThan(0); // steps away from the horse at +x
    // give up: feeds never land (the horse refuses), so after giveUpTicks the bot drops it
    r.w.remove(horse, G.MountTaming); r.a.bb.set("tameBackoffUntil", -1e9);
    const n = drive(r, "tame_mount", B.giveUpTicks + 80, () => r.a.bb.num("tameId", 0) === -1, [], (oo) => { oo.actions = oo.actions.filter((x) => !x.startsWith("mfeed")); });
    expect(n).toBeGreaterThanOrEqual(B.giveUpTicks - 2);
    expect(r.a.bb.get<Record<number, number>>("mountBans")![horse]).toBeGreaterThan(r.w.tick);
    r.a.bb.set("tameScanAt", -1e9); expect(ctxOf(r).world.tameMount).toBeUndefined(); // banned for banTicks
  });
});

describe("ADR-321 auto mount / dismount", () => {
  it("mounts its own horse for a long trip (> longTripTiles), rides faster than walking and gets off on arrival", () => {
    const r = rig(); r.home = { x: 70, y: 0 }; const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    const log: string[] = []; let rodeAt = -1; const n = drive(r, "return_home", 1200, () => { if (rodeAt < 0 && G.isRiding(r.w, r.p)) rodeAt = r.w.tick; return rodeAt >= 0 && !G.isRiding(r.w, r.p); }, log);
    expect(log[0]).toBe(G.MountRideCmd.name); expect(n).toBeGreaterThan(0); expect(log).toContain(G.MountDismountCmd.name);
    expect(70 - at(r.w, r.p).x).toBeLessThan(B.arriveTiles + 1.5); expect(r.a.bb.get("dismountWhy")).toBe("arrived");
    expect(n).toBeLessThan(70 / 2.9 / DT); // faster than walking the whole way
    void m;
  });
  it("short trips stay on foot; a far-away mount is not fetched; fleeing mounts a mount within reach", () => {
    const r = rig(); r.home = { x: 15, y: 0 }; net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    const log: string[] = []; drive(r, "return_home", 5, () => false, log); expect(log).not.toContain(G.MountRideCmd.name);
    const f = rig(); f.home = { x: 80, y: 0 }; net(f.w, G.makeMount(f.w, "animal_horse", -20, 0, f.p));
    const fl: string[] = []; drive(f, "return_home", 5, () => false, fl); expect(fl).not.toContain(G.MountRideCmd.name);
    const z = rig(); const zm = net(z.w, G.makeMount(z.w, "animal_horse", 1.5, 0, z.p)); const c = ctxOf(z); const o = out(); o.moveX = -1;
    G.mountPolicy(c, o, "flee"); expect(o.actions).toEqual([`mride:${zm}`]);
  });
  it("dismounts at a doorway a horse rider cannot pass (clearance) and before entering a building; a donkey rider rides through", () => {
    const r = rig({ x: 2.5, y: 1.3 }); const d = G.gameplayDefs(r.w); ensureClaim(r.w, r.p, 2, 2);
    const sn = G.snapPlacement(r.w, { piece: d.pieceId("wall_doorway"), x: 2.5, y: 2, level: 0, rot: 0, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${sn}`);
    G.placePiece(r.w, r.p, sn, { pay: false }); steps(r.w, 1);
    const m = net(r.w, G.makeMount(r.w, "animal_horse", 2.5, 1.3, r.p)); expect(G.rideMount(r.w, r.p, m)).toBe(true);
    r.home = { x: 2.5, y: 40 }; const log: string[] = [];
    drive(r, "return_home", 40, () => !G.isRiding(r.w, r.p), log);
    expect(G.isRiding(r.w, r.p)).toBe(false); expect(r.a.bb.get("dismountWhy")).toBe("clearance");
    // the remount cooldown keeps it on foot through the doorway
    const c = ctxOf(r); const o = out(); o.moveY = 1; r.a.bb.set("navGoalX", 2.5); r.a.bb.set("navGoalY", 40); r.a.bb.set("navGoalAt", c.self.tick); G.mountPolicy(c, o, "return_home"); expect(o.actions).toEqual([]);
    // donkey: fits the doorway, no clearance dismount
    const k = rig({ x: 2.5, y: 1.3 }); ensureClaim(k.w, k.p, 2, 2); const sk = G.snapPlacement(k.w, { piece: d.pieceId("wall_doorway"), x: 2.5, y: 2, level: 0, rot: 0, tier: 1, variant: 0 }); if (typeof sk === "number") throw new Error("snap");
    G.placePiece(k.w, k.p, sk, { pay: false }); steps(k.w, 1); const dk = net(k.w, G.makeMount(k.w, "animal_donkey", 2.5, 1.3, k.p)); G.rideMount(k.w, k.p, dk);
    const ck = ctxOf(k); const ok = out(); ok.moveY = 1; k.a.bb.set("navGoalX", 2.5); k.a.bb.set("navGoalY", 40); k.a.bb.set("navGoalAt", ck.self.tick);
    expect(G.dismountReason(ck, ok, "return_home", k.w)).toBeUndefined();
    // a goal inside the bot's base: off before the building
    ck.world.base = { x: 2, y: 30 }; k.a.bb.set("navGoalY", 31); k.w.set(k.p, Transform, { x: 3, y: 28.5 }); const cb = ctxOf(k); cb.world.base = { x: 2, y: 30 };
    expect(G.dismountReason(cb, ok, "return_home", k.w)).toBe("building");
  });
  it("gets off for gathering, combat, crafting and sleep, but not while fleeing", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 0, 0, r.p)); G.rideMount(r.w, r.p, m); const c = ctxOf(r);
    for (const [beh, act] of [["gather", "gather"], ["hunt", "attack:5"], ["craft", "craft:3"], ["sleep", ""]] as const) {
      const o = out(); if (act) o.actions.push(act); expect(G.dismountReason(c, o, beh, r.w), beh).toBe("task");
    }
    const o = out(); o.moveX = 1; o.actions.push("attack:5"); expect(G.dismountReason(c, o, "flee", r.w)).toBeUndefined();
  });
});

describe("ADR-321 saddles", () => {
  it("equips the best saddle in the bag, never downgrades, crafts an unlocked affordable one at the station, repairs a worn one", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    G.addItem(r.w, r.p, r.id("saddle_leather"), 1); G.addItem(r.w, r.p, r.id("saddle_reinforced"), 1);
    let c = ctxOf(r); expect(c.world.saddleUp?.kind).toBe("equip"); expect(passes(behavior("saddle_up"), c)).toBe(true);
    const log: string[] = []; drive(r, "saddle_up", 40, () => (r.w.getField(m, G.Mount, "saddle") ?? 0) > 0, log);
    expect(r.w.getField(m, G.Mount, "saddle")).toBe(2); expect(log).toContain(G.MountSaddleCmd.name);
    r.a.bb.set("saddleScanAt", -1e9); c = ctxOf(r); expect(c.world.saddleUp).toBeUndefined(); // leather is worse: kept in the bag
    // craft: a fresh bot with leather-saddle materials and a workbench next to it
    const k = rig(); const km = net(k.w, G.makeMount(k.w, "animal_horse", 1, 0, k.p)); ensureClaim(k.w, k.p, 0, 0);
    const d = G.gameplayDefs(k.w); const sn = G.snapPlacement(k.w, { piece: d.pieceId("workbench"), x: -1.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${sn}`);
    G.placePiece(k.w, k.p, sn, { pay: false }); steps(k.w, 1);
    for (const [it, n] of [["leather", 4], ["rope", 2], ["thread", 2]] as const) G.addItem(k.w, k.p, k.id(it), n);
    const kc = ctxOf(k); expect(kc.world.saddleUp).toMatchObject({ kind: "craft", here: true });
    const kl: string[] = []; drive(k, "saddle_up", 2, () => false, kl); expect(kl).toContain(G.QueueCraftCmd.name);
    steps(k.w, 20 * 10); expect(G.countItem(k.w, k.p, k.id("saddle_leather"))).toBe(1);
    k.a.bb.set("saddleScanAt", -1e9); k.a.bb.set("saddleAt", -1e9); drive(k, "saddle_up", 40, () => (k.w.getField(km, G.Mount, "saddle") ?? 0) > 0);
    expect(k.w.getField(km, G.Mount, "saddle")).toBe(1);
    // repair below repairBelow with the materials in the bag
    k.w.set(km, G.Mount, { saddleDur: 5 }); for (const g of G.saddleRepairCost(k.w, k.id("saddle_leather"))) G.addItem(k.w, k.p, g.item, g.count);
    k.a.bb.set("saddleScanAt", -1e9); k.a.bb.set("saddleAt", -1e9); expect(ctxOf(k).world.saddleUp?.kind).toBe("repair");
    const rl: string[] = []; drive(k, "saddle_up", 40, () => (k.w.getField(km, G.Mount, "saddleDur") ?? 0) > 5, rl); expect(rl).toContain(G.MountRepairCmd.name);
  });
  it("uses the saddlebag as overflow storage when the bag is almost full", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p)); G.addItem(r.w, r.p, r.id("saddle_leather"), 1);
    G.saddleMount(r.w, r.p, m, G.readSlots(r.w, r.p).items.findIndex((x) => x === r.id("saddle_leather")));
    const c = ctxOf(r); c.world.invFree = 1; c.world.surplus = [{ item: r.id("carrot"), count: 3 }];
    const o = out(); behavior("tend_mount").run(c, o); expect(o.actions).toEqual([`copen:${m}`]);
  });
});

describe("ADR-321 ownership and upkeep", () => {
  it("never treats someone else's mount (stranger or tribe-mate) as its own; a hired worker uses and tames for its employer", () => {
    const r = rig(); const other = net(r.w, pid(r.w, spawnLearned(r.w, { x: 5, y: 5, maxWeight: 0 }), 99));
    const theirs = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, other)); r.home = { x: 80, y: 0 };
    let c = ctxOf(r); expect(c.world.mount).toBeUndefined(); expect(c.world.tameMount?.id).not.toBe(theirs);
    const log: string[] = []; drive(r, "return_home", 30, () => false, log); expect(log).not.toContain(G.MountRideCmd.name);
    r.w.add(r.p, G.Tribe, { id: 4 }); r.w.add(other, G.Tribe, { id: 4 }); const shared = net(r.w, G.makeMount(r.w, "animal_horse", 1, 1, other));
    r.a.bb.set("mountScanAt", -1e9); c = ctxOf(r); expect(c.world.mount).toBeUndefined(); void shared;
    // hired worker (Worker.owner 7): the employer's mount is its mount; what it tames is recorded under 7
    const k = rig({ pid: 55 }); k.w.add(k.p, G.Worker, { owner: 7 }); const boss = net(k.w, pid(k.w, spawnLearned(k.w, { x: 9, y: 9, maxWeight: 0 }), 7));
    const bm = net(k.w, G.makeMount(k.w, "animal_horse", 1, 0, boss)); expect(ctxOf(k).world.mount?.id).toBe(bm);
    const w2 = rig({ pid: 56 }); w2.w.add(w2.p, G.Worker, { owner: 7 }); const h = G.spawnAnimal(w2.w, "animal_horse", 4, 0); G.addItem(w2.w, w2.p, w2.id("carrot"), 40);
    drive(w2, "tame_mount", 2400, () => w2.w.has(h, G.Mount)); expect(w2.w.getField(h, G.Mount, "owner")).toBe(7);
  });
  it("feeds a hurt mount, fetches a mount that strayed from home, and picks a replacement after its mount dies", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 3, 0, r.p)); G.addItem(r.w, r.p, r.id("carrot"), 10);
    r.w.set(m, G.Health, { hp: 40 }); let c = ctxOf(r); expect(c.world.mount?.feedItem).toBe(r.id("carrot")); expect(passes(behavior("tend_mount"), c)).toBe(true);
    const log: string[] = []; drive(r, "tend_mount", 80, () => log.includes(G.MountFeedCmd.name), log); expect(r.w.get(m, G.Health)!.hp).toBeGreaterThan(40);
    // strayed: 30 tiles from home -> walk to it, ride it back, get off at home
    const s = rig(); const sm = net(s.w, G.makeMount(s.w, "animal_horse", 4, 0, s.p)); s.w.set(sm, Transform, { x: 30, y: 0 }); s.home = { x: 0, y: 0 };
    s.w.set(s.p, Transform, { x: 5, y: 0 }); // the bot is home, its mount is not
    c = ctxOf(s); expect(passes(behavior("tend_mount"), c)).toBe(true);
    let rode = false; drive(s, "tend_mount", 1600, () => { rode ||= G.isRiding(s.w, s.p); return rode && !G.isRiding(s.w, s.p); });
    expect(rode).toBe(true); expect(Math.hypot(at(s.w, sm).x, at(s.w, sm).y)).toBeLessThan(B.homeRadius);
    // death -> replacement
    r.w.add(m, G.Dead, {} as never); steps(r.w, 1); G.spawnAnimal(r.w, "animal_horse", 6, 0); r.a.bb.set("tameScanAt", -1e9);
    c = ctxOf(r); expect(c.world.mount).toBeUndefined(); expect(c.world.tameMount).toBeDefined();
  });
});
