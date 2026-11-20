/**
 * ADR-473: sleep that restores — the night is scored at wake time (bed + >= 6 game-hours + warm + dark +
 * quiet room = rested: StaminaRegen x1.25 + HealthRegen +0.25 hp/s for 30 in-game minutes; any of no bed /
 * < 6 h / cold or hot at wake / lit / noisy room (openness > 0.25) = groggy: MoveSpeed x0.85 + StaminaRegen
 * x0.75 for 5 in-game minutes; in between (e.g. an open door at openness 0.25) is an ordinary night with no
 * buff or penalty). Duration is game hours from a sleep-start snapshot (not ticks: timeSkip advances game
 * hours without advancing ticks proportionally). Bots share the hook: the bot rest edge calls sleepIn and
 * every wake path calls wake(). Floor sleep never enters Sleep mode (the bot "sleep" action is stand-still;
 * only the "rest" edge with a bed calls sleepIn) — confirmed in build, not assumed. Beds placed in tests
 * need a NetId assigned by hand (ADR-244 pattern): placePiece does not assign one, the NetServer does in
 * live play, so a bare makeWorld bed has NetId 0.
 */
import { describe, expect, it } from "vitest";
import { evaluate, NetId, setTimeOfDay, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
let nid = 1000;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
function place(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number } = {}): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
}
function setOpen(w: World, piece: Entity, open: boolean): void {
  const a = G.resolveAttachment(w, piece, G.AttachKind.Door);
  if (a === undefined) throw new Error("no DoorState attachment");
  w.setField(a, G.DoorState, "open", open ? 1 : 0); G.structures(w).version++;
}
type East = "wall" | "window-open" | "door-open";
/** A 2-tile room x 10..12, y 10..11: foundations, walls, roof. The bed (anchor 10,10 rot 2) lies at (11,10.5). */
function room(w: World, east: East = "wall"): void {
  place(w, "foundation", 10.5, 10.5); place(w, "foundation", 11.5, 10.5);
  place(w, "wall", 10.5, 10); place(w, "wall", 11.5, 10);
  place(w, "wall", 10.5, 11); place(w, "wall", 11.5, 11);
  place(w, "wall", 10, 10.5);
  if (east === "wall") place(w, "wall", 12, 10.5);
  else if (east === "window-open") {
    place(w, "wall_window", 12, 10.5); const sh = place(w, "window_shutters", 12, 10.5); setOpen(w, sh, true);
  } else {
    place(w, "wall_doorway", 12, 10.5); const dr = place(w, "door_wood", 12, 10.5); setOpen(w, dr, true);
  }
  place(w, "roof_flat", 10.5, 10.5, { level: 1 }); place(w, "roof_flat", 11.5, 10.5, { level: 1 });
}
/** A bed whose centre is (11, 10.5) inside the room, with a NetId (see header). */
function bedInRoom(w: World): Entity { return net(w, place(w, "bed", 10, 10, { rot: 2 })); }
const fireOf = (w: World, piece: Entity) => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
function lightFire(w: World, piece: Entity, item = "coal", n = 50): Entity {
  const f = fireOf(w, piece); G.addItem(w, f, d.itemId(item), n); w.set(f, G.Fuel, { lit: 1, burnUntilTick: 0 }); G.setEmittersLit(w, f, 1); G.invalidateLightGrid(w); return f;
}

/** The sleeper falls asleep in the room bed at 20:00 day 1 with the given felt temperature. */
function asleep(w: World, p: Entity, felt: number): Entity {
  const bed = bedInRoom(w);
  const near = G.bedNear(w, p);
  if (!near) throw new Error("no bed in reach");
  expect(G.sleepIn(w, p, near.bed, near.spot)).toBe(true);
  expect(G.stanceMode(w, p)).toBe(G.StanceMode.Sleep);
  w.set(p, G.Exposure, { feltTemp: felt });
  return bed;
}
function wakeAt(w: World, hours: number, day: number): void {
  setTimeOfDay(w, hours, day);
  const p = [...w.query([G.Stance])].find((e) => G.stanceMode(w, e) === G.StanceMode.Sleep);
  if (p === undefined) throw new Error("nobody asleep");
  G.wake(w, p);
}
const staminaRegen = (w: World, p: Entity) => evaluate(w, p, G.Buffs, G.Stat.StaminaRegen, 1);
const healthRegen = (w: World, p: Entity) => evaluate(w, p, G.Buffs, G.Stat.HealthRegen, 0);
const moveSpeed = (w: World, p: Entity) => evaluate(w, p, G.Buffs, G.Stat.MoveSpeed, 1);

describe("ADR-473 sleep that restores", () => {
  it("a full good night in a sealed dark room leaves the sleeper rested for 30 in-game minutes", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    expect(G.sleepQualityAtWake(w, p)).toEqual({ kind: "groggy", hours: 0, inBed: true, warm: true, dark: true, quiet: true });
    setTimeOfDay(w, 2, 2);
    expect(G.sleepQualityAtWake(w, p).kind).toBe("rested");
    expect(G.sleepQualityAtWake(w, p).hours).toBe(6);
    G.wake(w, p);
    expect(G.stanceMode(w, p)).toBe(G.StanceMode.None);
    expect(staminaRegen(w, p)).toBeCloseTo(1.25, 5);
    expect(healthRegen(w, p)).toBeCloseTo(0.25, 5);
    // expiry is exactly 1800 s = 36000 ticks after the wake tick.
    const wakeTick = w.tick;
    w.tick = wakeTick + 36000 - 1; expect(staminaRegen(w, p)).toBeCloseTo(1.25, 5);
    w.tick = wakeTick + 36000; expect(staminaRegen(w, p)).toBe(1); expect(healthRegen(w, p)).toBe(0);
  });

  it("a short night (2 h) leaves the sleeper groggy for 5 in-game minutes", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    wakeAt(w, 22, 1);
    expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
    expect(staminaRegen(w, p)).toBeCloseTo(0.75, 5);
    const wakeTick = w.tick;
    w.tick = wakeTick + 6000 - 1; expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
    w.tick = wakeTick + 6000; expect(moveSpeed(w, p)).toBe(1); expect(staminaRegen(w, p)).toBe(1);
  });

  it("a cold wake (felt 5 C) leaves the sleeper groggy after a full 6 h in bed", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 5);
    expect(G.sleepQualityAtWake(w, p).warm).toBe(false);
    wakeAt(w, 2, 2);
    expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
    expect(staminaRegen(w, p)).toBeCloseTo(0.75, 5);
  });

  it("a lit wake (campfire burning nearby) leaves the sleeper groggy after a full 6 h in a sealed room", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    const camp = place(w, "campfire", 15, 10.5); lightFire(w, camp);
    expect(G.lightAt(w, 11, 10.5)).toBeDefined();
    expect(G.sleepQualityAtWake(w, p).dark).toBe(false);
    wakeAt(w, 2, 2);
    expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
  });

  it("a bed outdoors (openness 1, noisy) leaves the sleeper groggy after a full 6 h", () => {
    const w = makeWorld(); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 21, y: 20.5 });
    const bed = net(w, place(w, "bed", 20, 20, { rot: 2 }));
    const near = G.bedNear(w, p);
    expect(near?.bed).toBe(bed);
    expect(G.sleepIn(w, p, bed, near!.spot)).toBe(true);
    w.set(p, G.Exposure, { feltTemp: 20 });
    expect(G.roomOpennessAt(w, 21, 20.5, 0)).toBe(1);
    expect(G.sleepQualityAtWake(w, p).quiet).toBe(false);
    wakeAt(w, 2, 2);
    expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
  });

  it("a night with the door open (openness 0.25) is ordinary: no buff, no penalty", () => {
    const w = makeWorld(); room(w, "door-open"); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    expect(G.roomOpennessAt(w, 11, 10.5, 0)).toBe(0.25);
    setTimeOfDay(w, 2, 2);
    expect(G.sleepQualityAtWake(w, p).kind).toBe("ordinary");
    G.wake(w, p);
    expect(moveSpeed(w, p)).toBe(1);
    expect(staminaRegen(w, p)).toBe(1);
    expect(healthRegen(w, p)).toBe(0);
  });

  it("one open shutter in this 2-tile room (openness ~0.1) still counts as quiet: rested", () => {
    const w = makeWorld(); room(w, "window-open"); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    expect(G.roomOpennessAt(w, 11, 10.5, 0)).toBeCloseTo(0.1, 5);
    expect(G.sleepQualityAtWake(w, p).quiet).toBe(true);
    wakeAt(w, 2, 2);
    expect(staminaRegen(w, p)).toBeCloseTo(1.25, 5);
  });

  it("a sleeper whose bed is gone wakes groggy (no-bed guard)", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    asleep(w, p, 20);
    w.set(p, G.Stance, { bedNetId: 0 });
    expect(G.sleepQualityAtWake(w, p).inBed).toBe(false);
    wakeAt(w, 2, 2);
    expect(moveSpeed(w, p)).toBeCloseTo(0.85, 5);
  });

  it("waking without a recorded sleep start is ordinary (no buff, no penalty)", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    const p = spawnLearned(w, { x: 11, y: 10.5 });
    const bed = bedInRoom(w);
    // enter Sleep mode directly, bypassing sleepIn/setMode, so no sleep-start snapshot exists
    w.add(p, G.Stance, {});
    w.set(p, G.Stance, { mode: G.StanceMode.Sleep, bedNetId: G.netIdOf(w, bed), spot: 0 });
    w.set(p, G.Exposure, { feltTemp: 20 });
    setTimeOfDay(w, 2, 2);
    expect(G.sleepQualityAtWake(w, p).kind).toBe("ordinary");
    expect(G.sleepQualityAtWake(w, p).hours).toBe(-1);
    G.wake(w, p);
    expect(moveSpeed(w, p)).toBe(1);
    expect(staminaRegen(w, p)).toBe(1);
    expect(healthRegen(w, p)).toBe(0);
  });

  it("a bot-shaped sleeper (another learned player, clientId 2) wakes rested the same way", () => {
    const w = makeWorld(); room(w); setTimeOfDay(w, 20, 1);
    // the "bot" is the only sleeper: it takes the room bed through the same sleepIn/wake path
    const q = spawnLearned(w, { x: 11, y: 10.5, clientId: 2 });
    asleep(w, q, 20);
    setTimeOfDay(w, 2, 2);
    expect(G.sleepQualityAtWake(w, q).kind).toBe("rested");
    G.wake(w, q);
    expect(staminaRegen(w, q)).toBeCloseTo(1.25, 5);
    expect(healthRegen(w, q)).toBeCloseTo(0.25, 5);
  });
});
