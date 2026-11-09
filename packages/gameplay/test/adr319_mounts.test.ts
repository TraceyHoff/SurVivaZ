import { describe, expect, it } from "vitest";
import { NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

let nid = 900;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(learned = true): { w: World; p: Entity; id: (k: string) => number } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = learned ? spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }) : G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
  pid(w, p, 7); net(w, p);
  const d = G.gameplayDefs(w); return { w, p, id: (k) => d.itemId(k) };
}
const sp = (k: string): G.MountSpecies => G.mountSpecies(G.mountSpeciesOfKey(k))!;
const ONFOOT_SPRINT = 2.9 * 1.6;

describe("ADR-319 mount data: species, speeds and realistic scale (t363)", () => {
  it("horse, donkey, deer, elk, moose and buffalo exist; every walk already beats an on-foot sprint; gallop > walk", () => {
    expect(G.MOUNT_SPECIES.map((s) => s.key)).toEqual(["horse", "donkey", "deer", "elk", "moose", "buffalo"]);
    for (const s of G.MOUNT_SPECIES) { expect(s.walk).toBeGreaterThan(ONFOOT_SPRINT); expect(s.gallop).toBeGreaterThan(s.walk); }
    const gallops = G.MOUNT_SPECIES.map((s) => s.gallop); expect(new Set(gallops).size).toBe(gallops.length); // all different
    expect(Math.max(...gallops)).toBe(sp("horse").gallop);
  });
  it("withers / player-height ratios match the real-world references (player 1.75 m)", () => {
    const P = G.MOUNT_SCALE.playerHeightM; const r = (k: string): number => sp(k).size.withersM / P;
    const want: Record<string, [number, number]> = { horse: [0.86, 0.97], donkey: [0.6, 0.75], moose: [1.06, 1.22], deer: [0.72, 0.87], buffalo: [0.95, 1.1], elk: [0.74, 0.9] };
    for (const [k, [lo, hi]] of Object.entries(want)) { expect(r(k), k).toBeGreaterThanOrEqual(lo); expect(r(k), k).toBeLessThanOrEqual(hi); }
    expect(sp("horse").size.seatM / P).toBeGreaterThanOrEqual(0.7); expect(sp("horse").size.seatM / P).toBeLessThanOrEqual(0.9); // seat ~ rider chest
    expect(r("donkey")).toBeLessThan(r("deer")); expect(r("deer")).toBeLessThan(r("horse")); expect(r("horse")).toBeLessThan(r("buffalo")); expect(r("buffalo")).toBeLessThan(r("moose"));
    expect(sp("buffalo").size.widthM).toBe(Math.max(...G.MOUNT_SPECIES.map((s) => s.size.widthM))); // heavy + wide
    for (const s of G.MOUNT_SPECIES) { expect(s.size.seatM).toBeLessThan(s.size.withersM + 0.01); expect(s.size.headTopM).toBeGreaterThan(s.size.withersM); }
  });
  it("pixel targets and render scale: renderScale x artTop ~ headTop x px/m (1x art, 58 px player)", () => {
    expect(G.PX_PER_M).toBeCloseTo(58 / 1.75, 6);
    const px = (k: string): number => Math.round(sp(k).size.withersM * G.PX_PER_M);
    expect([px("horse"), px("donkey"), px("deer"), px("elk"), px("moose"), px("buffalo")]).toEqual([53, 40, 45, 48, 66, 60]);
    for (const s of G.MOUNT_SPECIES) for (const a of s.animals) {
      if (s.pendingArt) { expect(G.mountRenderScale(a.key)).toBe(1); continue; }
      expect(G.mountRenderScale(a.key) * a.artTopPx, a.key).toBeCloseTo(G.targetTopPx(s), 0);
    }
    expect(G.mountRenderScale("animal_wolf")).toBe(1); // non-mount animals untouched
  });
  it("rider seat lift, body radius (collision footprint) and doorway / ceiling clearance follow the size table", () => {
    const k = (s: string): number => G.mountSpeciesOfKey(s);
    expect(G.riderSeatLiftZ(k("horse"))).toBeCloseTo(((1.45 - 0.45) * G.PX_PER_M) / 16, 5);
    expect(G.riderSeatLiftZ(k("moose"))).toBeGreaterThan(G.riderSeatLiftZ(k("horse"))); expect(G.riderSeatLiftZ(k("donkey"))).toBeLessThan(G.riderSeatLiftZ(k("horse")));
    expect(G.mountBodyRadius(k("buffalo"))).toBeGreaterThan(G.mountBodyRadius(k("horse"))); expect(G.mountBodyRadius(k("donkey"))).toBeLessThan(G.mountBodyRadius(k("horse")));
    expect(G.MOUNT_SPECIES.filter((s) => G.fitsDoorway(k(s.key))).map((s) => s.key)).toEqual(["donkey"]);
    expect(G.MOUNT_SPECIES.filter((s) => !G.fitsUnderCeiling(k(s.key))).map((s) => s.key)).toEqual(["moose"]);
  });
});

describe("ADR-319 taming", () => {
  it("needs the Horsemanship unlock; a liked food builds progress, refused food is rejected", () => {
    const raw = setup(false); const a = G.spawnAnimal(raw.w, "animal_elk", 1, 0); G.addItem(raw.w, raw.p, raw.id("apple"), 5);
    expect(G.checkFeed(raw.w, raw.p, a, raw.id("apple"))).toBe("needs_skill");
    const { w, p, id } = setup(); const e = G.spawnAnimal(w, "animal_elk", 1, 0); G.addItem(w, p, id("apple"), 60); G.addItem(w, p, id("carrot"), 1);
    expect(G.checkFeed(w, p, e, id("carrot"))).toBe("not_food");
    expect(G.checkFeed(w, p, G.spawnAnimal(w, "animal_wolf", 0, 1), id("apple"))).toBe("not_tameable");
    const ev = collect(w, G.MountEvent);
    for (let i = 0; i < 60 && !w.has(e, G.Mount); i++) { w.set(p, Transform, { x: 0, y: 0 }); w.set(e, Transform, { x: 1, y: 0 }); if (w.has(p, G.Dead)) break; G.feedMount(w, p, e, id("apple")); w.step(DT); }
    expect(w.has(e, G.Mount)).toBe(true); expect(w.getField(e, G.Mount, "owner")).toBe(7);
    expect(ev.some((x) => x.result === G.MountResult.Tamed)).toBe(true);
    expect(w.get(e, G.Container)!.slotCount).toBe(0); // bareback: no slots
    expect(w.getField(e, G.Mount, "kind")).toBe(w.getField(e, G.Animal, "kind"));
  });
  it("a hired worker tames for their employer; an unaffiliated AI human tames for itself", () => {
    const { w, id } = setup();
    const worker = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }); pid(w, worker, 55); w.add(worker, G.Worker, { owner: 7 });
    const m = G.spawnAnimal(w, "animal_elk", 1, 0); G.tameMount(w, worker, m); expect(w.getField(m, G.Mount, "owner")).toBe(7);
    const ai = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }); pid(w, ai, 88);
    const m2 = G.spawnAnimal(w, "animal_moose", 1, 0); G.tameMount(w, ai, m2); expect(w.getField(m2, G.Mount, "owner")).toBe(88);
    void id;
  });
});

describe("ADR-319 riding", () => {
  it("owner, tribe-mate and owner's worker may ride; strangers may not", () => {
    const { w, p } = setup(); const m = net(w, G.makeMount(w, "animal_elk", 1, 0, p));
    const stranger = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }), 99));
    const worker = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }), 98)); w.add(worker, G.Worker, { owner: 7 });
    expect(G.checkRide(w, stranger, m)).toBe("not_owner"); expect(G.checkRide(w, worker, m)).toBeUndefined(); expect(G.checkRide(w, p, m)).toBeUndefined();
    w.add(p, G.Tribe, { id: 3 }); const tm = net(w, G.makeMount(w, "animal_moose", 1, 0, p)); const mate = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }), 97)); w.add(mate, G.Tribe, { id: 3 });
    expect(G.checkRide(w, mate, tm)).toBeUndefined();
  });
  it("mount / dismount links both ways; the mount follows; mounted riders move faster than an on-foot sprint and gallop faster still", () => {
    const { w, p } = setup(); const m = net(w, G.makeMount(w, "animal_red_deer", 1, 0, p));
    expect(G.rideMount(w, p, m)).toBe(true); expect(G.isRiding(w, p)).toBe(true); expect(G.mountOfRider(w, p)).toBe(m); expect(G.liveRider(w, m)).toBe(p);
    expect(G.checkRide(w, p, m)).toBe("already_riding");
    const x0 = w.get(p, Transform)!.x;
    for (let i = 0; i < 40; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight, DT); w.step(DT); }
    const v1 = (w.get(p, Transform)!.x - x0) / (40 * DT);
    expect(w.getField(p, G.Riding, "speed")).toBeGreaterThan(ONFOOT_SPRINT); expect(v1).toBeGreaterThan(2.9);
    for (let i = 0; i < 60; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, DT); w.step(DT); }
    expect(w.getField(p, G.Riding, "speed")).toBeGreaterThan(sp("deer").walk);
    expect(w.get(m, Transform)!.x).toBeCloseTo(w.get(p, Transform)!.x, 3); // mount carried along
    expect(G.dismount(w, p)).toBe(true); expect(G.isRiding(w, p)).toBe(false); expect(w.getField(m, G.Mount, "riderNetId")).toBe(0);
    expect(Math.hypot(w.get(p, Transform)!.x - w.get(m, Transform)!.x, w.get(p, Transform)!.y - w.get(m, Transform)!.y)).toBeGreaterThan(0.5);
  });
  it("doorway clearance: a horse rider cannot pass a doorway (head 2.3 m > 2.0 m); a donkey rider can; open ground is free", () => {
    const { w, p } = setup(); const d = G.gameplayDefs(w); ensureClaim(w, p, 2, 2);
    const put = (key: string, x: number, y: number, level = 0, rot = 0): void => {
      const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level, rot, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
      G.placePiece(w, p, sn, { pay: false });
    };
    put("wall_doorway", 2.5, 2); steps(w, 1);
    const k = G.mountSpeciesOfKey;
    expect(G.rideClearanceBlocked(w, k("horse"), 2.5, 1.6, 2.5, 2.4, 0)).toBe(true);
    expect(G.rideClearanceBlocked(w, k("moose"), 2.5, 2.4, 2.5, 1.6, 0)).toBe(true);
    expect(G.rideClearanceBlocked(w, k("donkey"), 2.5, 1.6, 2.5, 2.4, 0)).toBe(false);
    expect(G.rideClearanceBlocked(w, k("horse"), 5.5, 1.6, 5.5, 2.4, 0)).toBe(false);
  });
  it("building / attack intents are cleared while mounted; a second rider is refused (mount_busy)", () => {
    const { w, p } = setup(); const m = net(w, G.makeMount(w, "animal_elk", 1, 0)); G.rideMount(w, p, m);
    expect(G.blockedWhileRiding(G.IntentAction.Place)).toBe(true); expect(G.blockedWhileRiding(G.IntentAction.Attack)).toBe(true); expect(G.blockedWhileRiding(G.IntentAction.None)).toBe(false);
    w.set(p, G.PlayerIntent, { action: G.IntentAction.Attack }); G.mountGateSystem(w); expect(w.getField(p, G.PlayerIntent, "action")).toBe(G.IntentAction.None);
    const q = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }), 8)); expect(G.checkRide(w, q, m)).toBe("mount_busy");
  });
  it("disconnect and rider death get the rider off; stale links heal", () => {
    const { w, p } = setup(); const m = net(w, G.makeMount(w, "animal_elk", 1, 0, p)); G.rideMount(w, p, m);
    G.dismountOnLeave(w, p); expect(G.isRiding(w, p)).toBe(false); expect(w.getField(m, G.Mount, "riderNetId")).toBe(0);
    G.rideMount(w, p, m); w.set(m, G.Mount, { riderNetId: 123456 }); steps(w, 2); expect(G.isRiding(w, p)).toBe(false);
    steps(w, 1); expect(w.getField(m, G.Mount, "riderNetId")).toBe(0);
  });
  it("a dead mount drops its saddle and saddlebag in a loot bag and dismounts the rider", () => {
    const { w, p, id } = setup(); const m = net(w, G.makeMount(w, "animal_moose", 1, 0, p)); G.addItem(w, p, id("saddle_leather"), 1);
    const slot = G.listSlots(w, p).find((s) => s.item === id("saddle_leather"))!.slot; expect(G.saddleMount(w, p, m, slot)).toBe(true);
    G.addItem(w, m, id("apple"), 3); G.rideMount(w, p, m);
    w.add(m, G.Dead, {} as never); steps(w, 1);
    expect(G.isRiding(w, p)).toBe(false); expect(w.has(m, G.Mount)).toBe(false);
    const bag = [...w.query([G.LootBag, G.Container])].find((b) => G.listSlots(w, b).some((s) => s.item === id("saddle_leather")));
    expect(bag).toBeDefined(); expect(G.countItem(w, bag!, id("apple"))).toBe(3);
  });
  it("Mount, Riding and MountTaming replicate to everyone (riders are drawn on mounts for all clients)", () => {
    for (const c of [G.Mount, G.Riding, G.MountTaming]) expect(G.replicationOf(c)?.scope).toBe("all");
    expect(G.GAMEPLAY_COMPONENTS).toContain(G.Mount); expect(G.GAMEPLAY_COMPONENTS).toContain(G.Riding); expect(G.GAMEPLAY_COMPONENTS).toContain(G.MountTaming);
    expect(G.Mount.persistent).toBe(true); expect(G.Riding.persistent).toBeFalsy();
  });
  it("a saved mount (chunk codec) reloads with species, owner, saddle and bag, and its Animal / Health are rebuilt", async () => {
    const { Chunk, encodeChunk, decodeChunk } = await import("@engine/world");
    const { w, p, id } = setup(); const m = net(w, G.makeMount(w, "animal_elk", 1, 1, p)); G.addItem(w, p, id("saddle_reinforced"), 1);
    expect(G.saddleMount(w, p, m, G.listSlots(w, p).find((s) => s.item === id("saddle_reinforced"))!.slot)).toBe(true); G.addItem(w, m, id("hay"), 4); G.renameMount(w, p, m, "Dusty");
    const bytes = encodeChunk(new Chunk(0, 0), { world: w, entities: [m] });
    const w2 = makeWorld(); const [e] = decodeChunk(bytes, { world: w2 }).entities; expect(e).toBeDefined();
    steps(w2, 1);
    expect(w2.getField(e!, G.Mount, "owner")).toBe(7); expect(w2.getField(e!, G.Mount, "saddle")).toBe(2); expect(G.countItem(w2, e!, id("hay"))).toBe(4);
    expect(w2.has(e!, G.Animal)).toBe(true); expect(w2.getField(e!, G.Animal, "kind")).toBe(w.getField(m, G.Animal, "kind")); expect(w2.has(e!, G.Health)).toBe(true);
    expect(G.mountName(w2, e!)).toBe("Dusty"); expect(w2.get(e!, G.Container)!.slotCount).toBe(5);
  });
});
