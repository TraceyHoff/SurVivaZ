/**
 * ADR-440: room heat — ventilation and realistic distribution.
 * Pins the Task 24 behaviour first (sealed room + fire warms; an open room does not hold heat; a sealed room
 * with a roaring fire still overheats in a heat wave), then the new rules:
 *  - openness (open windows / doors) lowers the room's heat target and shortens its time constant, both by the
 *    same ventilation factor, so a leaky room never warms faster than a sealed one at first;
 *  - a warm room sheds its stored heat faster when ventilated (open door / open shutters after the fire goes out);
 *  - heat flows between rooms through open doorways and open shutters, but not through closed doors, glass or bars.
 * Opening / closing doors and window shutters goes through the same Interact → ToggleDoor path (see the last block).
 */
import { describe, expect, it } from "vitest";
import { setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";
import { ambientTemperature, shelteredAirTemp } from "../src/systems/environment.js";

const d = G.defaultDefs();
const SEC = 20;
type Side = "N" | "S" | "W" | "E";
const EDGE: Record<Side, [number, number]> = { N: [10.5, 10], S: [10.5, 11], W: [10, 10.5], E: [11, 10.5] };
type WallSpec = "wall" | "window" | "door" | "doorway" | "low";
interface HutOpts {
  walls?: Partial<Record<Side, WallSpec>>; roof?: boolean;
  shutters?: Partial<Record<Side, "closed" | "open">>; doors?: Partial<Record<Side, "closed" | "open">>;
}
function place(w: World, key: string, x: number, y: number, o: { level?: number; tier?: number } = {}): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: 0, tier: o.tier ?? 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0 as Entity, sn, { pay: false });
}
/** Set a door / shutter insert open or closed (the same write doorSystem makes), invalidating enclosure caches. */
function setOpen(w: World, piece: Entity, open: boolean): void {
  const a = G.resolveAttachment(w, piece, G.AttachKind.Door);
  if (a === undefined) throw new Error("no DoorState attachment");
  w.setField(a, G.DoorState, "open", open ? 1 : 0); G.structures(w).version++;
}
/** A 1-tile hut at (10,10): foundation + the listed walls + roof (unless roof: false). */
function hut(o: HutOpts = {}): { w: World; walls: Partial<Record<Side, Entity>>; inserts: Partial<Record<Side, Entity>> } {
  const w = makeWorld(); place(w, "foundation", 10.5, 10.5);
  const walls: Partial<Record<Side, Entity>> = {}; const inserts: Partial<Record<Side, Entity>> = {};
  const spec = o.walls ?? { N: "wall", S: "wall", W: "wall", E: "wall" };
  for (const s of ["N", "S", "W", "E"] as Side[]) {
    const kind = spec[s]; if (!kind) continue;
    if (kind === "wall") walls[s] = place(w, "wall", ...EDGE[s]);
    else if (kind === "low") walls[s] = place(w, "wall_low", ...EDGE[s]);
    else if (kind === "window") {
      walls[s] = place(w, "wall_window", ...EDGE[s]); const sh = place(w, "window_shutters", ...EDGE[s]); inserts[s] = sh;
      if (o.shutters?.[s] === "open") setOpen(w, sh, true);
    } else if (kind === "door") {
      walls[s] = place(w, "wall_doorway", ...EDGE[s]); const dr = place(w, "door_wood", ...EDGE[s]); inserts[s] = dr;
      if (o.doors?.[s] === "open") setOpen(w, dr, true);
    } else if (kind === "doorway") {
      walls[s] = place(w, "wall_doorway", ...EDGE[s]); // no door hung: an open doorway
    }
  }
  if (o.roof !== false) place(w, "roof_flat", 10.5, 10.5, { level: 1 });
  return { w, walls, inserts };
}
const fireOf = (w: World, piece: Entity) => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Fuel))!;
function light(w: World, piece: Entity, item = "coal", n = 50): Entity {
  const f = fireOf(w, piece); G.addItem(w, f, d.itemId(item), n); w.set(f, G.Fuel, { lit: 1, burnUntilTick: 0 }); G.setEmittersLit(w, f, 1); G.invalidateLightGrid(w); return f;
}
function snuff(w: World, f: Entity): void { w.set(f, G.Fuel, { lit: 0, burnUntilTick: 0 }); G.setEmittersLit(w, f, 0); G.invalidateLightGrid(w); }
const roomHeatOf = (w: World, e: Entity) => w.getField(e, G.RoomHeat, "heat") ?? 0;
const feltOf = (w: World, e: Entity) => w.getField(e, G.Exposure, "feltTemp") ?? 20;
const winterNoon = (w: World) => {
  setSeason(w, 2, 1.5); setTimeOfDay(w, 12);
  Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
};
/** Sealed 1-tile room, winter noon, player inside (no fire). */
function winterRoom(o: HutOpts = {}) {
  const h = hut(o); winterNoon(h.w);
  const p = spawnLearned(h.w, { x: 10.5, y: 10.5 });
  return { ...h, p };
}
/** winterRoom + a lit campfire inside; steps once so the emitter index picks the fire up. */
function litRoom(o: HutOpts = {}) {
  const r = winterRoom(o);
  const camp = place(r.w, "campfire", 10.5, 10.5); const f = light(r.w, camp);
  steps(r.w, SEC);
  expect(G.heatAt(r.w, 10.5, 10.5)).toBeGreaterThan(10);
  return { ...r, camp, f };
}

describe("ADR-440 Task 24 behaviour pinned", () => {
  it("a sealed room + lit campfire warms over a minute", () => {
    const { w, p } = litRoom();
    steps(w, 59 * SEC);
    const heat = roomHeatOf(w, p);
    expect(heat).toBeGreaterThan(3); expect(heat).toBeLessThan(8); // ~5.9C after 60s (tau 120s, cap 15C)
    expect(feltOf(w, p)).toBeGreaterThan(11);
  });
  it("outdoors a fire warms instantly but RoomHeat stays 0", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 }); winterNoon(w);
    const camp = place(w, "campfire", 0.5, 0.5); light(w, camp);
    steps(w, 30 * SEC);
    expect(roomHeatOf(w, p)).toBe(0);
    expect(feltOf(w, p)).toBeGreaterThan(ambientTemperature(w, 0, 0) + 5);
  });
  it("a room with an open doorway does not hold heat", () => {
    const { w, p } = litRoom({ walls: { N: "wall", S: "doorway", W: "wall", E: "wall" } });
    // no door hung: the S edge is an open doorway, so the room is not enclosed
    expect(shelteredAirTemp(w, 10.5, 10.5).enclosed).toBe(false);
    steps(w, 30 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
  it("a roofless room does not hold heat", () => {
    const { w, p } = litRoom({ roof: false });
    expect(shelteredAirTemp(w, 10.5, 10.5).enclosed).toBe(false);
    steps(w, 30 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
  it("a fire outside the sealed room does not warm it (walls occlude heat)", () => {
    const { w, p } = winterRoom();
    const camp = place(w, "campfire", 14, 10.5); light(w, camp);
    steps(w, SEC);
    expect(G.heatAt(w, 10.5, 10.5)).toBeLessThan(1);
    steps(w, 29 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
  it("a sealed room with a roaring fire still overheats in a heat wave (Task 24 guarantee)", () => {
    const h = hut(); const w = h.w; const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    const camp = place(w, "campfire", 10.5, 10.5); light(w, camp);
    steps(w, 30 * SEC);
    expect(feltOf(w, p)).toBeGreaterThan(32);
  });
});

describe("ADR-440 openness model", () => {
  it("roomOpennessAt: 0 sealed, 1 outdoors, 1 roofless", () => {
    expect(G.roomOpennessAt(hut().w, 10.5, 10.5, 0)).toBe(0);
    expect(G.roomOpennessAt(makeWorld(), 10.5, 10.5, 0)).toBe(1);
    expect(G.roomOpennessAt(hut({ roof: false }).w, 10.5, 10.5, 0)).toBe(1);
  });
  it("roomOpennessAt scales with open windows: one open shutter 0.15, four 0.6", () => {
    expect(G.roomOpennessAt(hut({ walls: { N: "wall", S: "window", W: "wall", E: "wall" }, shutters: { S: "open" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.15, 9);
    expect(G.roomOpennessAt(hut({ walls: { N: "window", S: "window", W: "window", E: "window" }, shutters: { N: "open", S: "open", W: "open", E: "open" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.6, 9);
    // closed shutters leak a little, but far less than open ones
    expect(G.roomOpennessAt(hut({ walls: { N: "window", S: "window", W: "window", E: "window" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.15, 9);
  });
  it("roomOpennessAt: an open door reads 0.25, an open doorway 0.1875, low walls 0.5", () => {
    expect(G.roomOpennessAt(hut({ walls: { N: "wall", S: "door", W: "wall", E: "wall" }, doors: { S: "open" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.25, 9);
    expect(G.roomOpennessAt(hut({ walls: { N: "wall", S: "doorway", W: "wall", E: "wall" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.1875, 9);
    expect(G.roomOpennessAt(hut({ walls: { N: "low", S: "low", W: "low", E: "low" } }).w, 10.5, 10.5, 0)).toBeCloseTo(0.5, 9);
  });
  it("edgeVentOf: solid 0, closed door 0, open door 1, doorway 0.75, glass 0, shutters closed 0.15 / open 0.6", () => {
    const idxOf = (w: World) => G.structures(w);
    const sealed = hut(); expect(G.edgeVentOf(sealed.w, idxOf(sealed.w), sealed.walls.N!)).toBe(0);
    const low = hut({ walls: { N: "low", S: "wall", W: "wall", E: "wall" } }); expect(G.edgeVentOf(low.w, idxOf(low.w), low.walls.N!)).toBe(0.5);
    const shut = hut({ walls: { N: "window", S: "wall", W: "wall", E: "wall" } });
    expect(G.edgeVentOf(shut.w, idxOf(shut.w), shut.walls.N!)).toBe(0.15);
    setOpen(shut.w, shut.inserts.N!, true);
    expect(G.edgeVentOf(shut.w, idxOf(shut.w), shut.walls.N!)).toBe(0.6);
    const glassW = makeWorld(); place(glassW, "foundation", 10.5, 10.5);
    const glassWall = place(glassW, "wall_window", 10.5, 10);
    place(glassW, "window_glass", 10.5, 10);
    expect(G.edgeVentOf(glassW, idxOf(glassW), glassWall)).toBe(0); // glass seals the window
    const door = hut({ walls: { N: "door", S: "wall", W: "wall", E: "wall" } });
    expect(G.edgeVentOf(door.w, idxOf(door.w), door.walls.N!)).toBe(0);
    setOpen(door.w, door.inserts.N!, true);
    expect(G.edgeVentOf(door.w, idxOf(door.w), door.walls.N!)).toBe(1);
    const open = hut({ walls: { N: "doorway", S: "wall", W: "wall", E: "wall" } });
    // a doorway with no door hung at all
    expect(G.edgeVentOf(open.w, idxOf(open.w), open.walls.N!)).toBe(0.75);
  });
  it("ventilation factor: 1 sealed, 1/4 fully open; approachRoomHeat takes a time constant", () => {
    expect(G.roomHeatVentFactor(0)).toBe(1);
    expect(G.roomHeatVentFactor(1)).toBeCloseTo(0.25, 9);
    expect(G.roomHeatVentFactor(0.6)).toBeCloseTo(1 / 2.8, 9);
    expect(G.roomHeatTau(0)).toBe(G.FIRE_HEAT_TAU_S);
    expect(G.roomHeatTau(1)).toBeCloseTo(30, 9);
    expect(G.approachRoomHeat(0, 15, 120, 40)).toBeCloseTo(15 * (1 - Math.exp(-3)), 6);
    expect(G.approachRoomHeat(0, 15, 120)).toBeCloseTo(15 * (1 - Math.exp(-1)), 6); // default tau unchanged
  });
});

describe("ADR-440 ventilation lowers the room temperature", () => {
  it("four open shutters: the room warms much less than the sealed room over two minutes", () => {
    const sealed = litRoom(); steps(sealed.w, 119 * SEC);
    const vented = litRoom({ walls: { N: "window", S: "window", W: "window", E: "window" }, shutters: { N: "open", S: "open", W: "open", E: "open" } });
    steps(vented.w, 119 * SEC);
    expect(roomHeatOf(sealed.w, sealed.p)).toBeGreaterThan(8); // ~9.5C sealed
    expect(roomHeatOf(vented.w, vented.p)).toBeLessThan(6.5); // ~5.0C ventilated
    expect(roomHeatOf(vented.w, vented.p)).toBeLessThan(roomHeatOf(sealed.w, sealed.p));
    expect(feltOf(vented.w, vented.p)).toBeLessThan(feltOf(sealed.w, sealed.p));
  });
  it("one open shutter warms less than sealed, and closing it again lets the room recover", () => {
    const sealed = litRoom(); steps(sealed.w, 119 * SEC);
    const one = litRoom({ walls: { N: "wall", S: "window", W: "wall", E: "wall" }, shutters: { S: "open" } });
    steps(one.w, 119 * SEC);
    expect(roomHeatOf(one.w, one.p)).toBeLessThan(roomHeatOf(sealed.w, sealed.p));
    // close the shutter: the room warms back toward the sealed level
    setOpen(one.w, one.inserts.S!, false); steps(one.w, 120 * SEC);
    expect(roomHeatOf(one.w, one.p)).toBeGreaterThan(8);
  });
  it("a warm room sheds its heat fast with the shutters open once the fire goes out", () => {
    const sealed = litRoom(); steps(sealed.w, 59 * SEC); snuff(sealed.w, sealed.f); steps(sealed.w, 120 * SEC);
    const vented = litRoom({ walls: { N: "window", S: "window", W: "window", E: "window" } });
    steps(vented.w, 59 * SEC); snuff(vented.w, vented.f);
    setOpen(vented.w, vented.inserts.N!, true); setOpen(vented.w, vented.inserts.S!, true);
    setOpen(vented.w, vented.inserts.W!, true); setOpen(vented.w, vented.inserts.E!, true);
    steps(vented.w, 120 * SEC);
    expect(roomHeatOf(sealed.w, sealed.p)).toBeGreaterThan(1.5); // ~2.2C still there sealed
    expect(roomHeatOf(vented.w, vented.p)).toBeLessThan(1); // ~0.4C ventilated
  });
  it("a warm room sheds its heat fast when the door is opened", () => {
    const sealed = litRoom(); steps(sealed.w, 59 * SEC); snuff(sealed.w, sealed.f); steps(sealed.w, 120 * SEC);
    const drafty = litRoom({ walls: { N: "wall", S: "door", W: "wall", E: "wall" } });
    steps(drafty.w, 59 * SEC); snuff(drafty.w, drafty.f);
    setOpen(drafty.w, drafty.inserts.S!, true);
    expect(shelteredAirTemp(drafty.w, 10.5, 10.5).enclosed).toBe(false);
    steps(drafty.w, 120 * SEC);
    expect(roomHeatOf(drafty.w, drafty.p)).toBeLessThan(roomHeatOf(sealed.w, sealed.p));
    expect(roomHeatOf(drafty.w, drafty.p)).toBeLessThan(1.5); // ~1.0C with the door open
  });
});

/** Two 1-tile rooms sharing one edge at x=11: fire in A (10,10), player in B (11,10). */
function twoRooms(shared: "door" | "window" | "glass", state: "closed" | "open") {
  const w = makeWorld();
  place(w, "foundation", 10.5, 10.5); place(w, "foundation", 11.5, 10.5);
  place(w, "wall", 10.5, 10); place(w, "wall", 10.5, 11); place(w, "wall", 10, 10.5);
  place(w, "wall", 11.5, 10); place(w, "wall", 11.5, 11); place(w, "wall", 12, 10.5);
  let sharedPiece: Entity;
  if (shared === "door") { place(w, "wall_doorway", 11, 10.5); sharedPiece = place(w, "door_wood", 11, 10.5); }
  else { place(w, "wall_window", 11, 10.5); sharedPiece = place(w, shared === "glass" ? "window_glass" : "window_shutters", 11, 10.5); }
  if (state === "open" && shared !== "glass") setOpen(w, sharedPiece, true);
  place(w, "roof_flat", 10.5, 10.5, { level: 1 }); place(w, "roof_flat", 11.5, 10.5, { level: 1 });
  winterNoon(w);
  const p = spawnLearned(w, { x: 11.5, y: 10.5 });
  const camp = place(w, "campfire", 10.5, 10.5); light(w, camp);
  steps(w, SEC);
  return { w, p, sharedPiece };
}

describe("ADR-440 heat distributes between rooms", () => {
  it("a closed door between rooms blocks the fire's heat", () => {
    const { w, p } = twoRooms("door", "closed");
    expect(G.heatAt(w, 11.5, 10.5)).toBeLessThan(0.5);
    steps(w, 60 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
  it("an open doorway lets the next room warm up", () => {
    const { w, p } = twoRooms("door", "open");
    expect(G.heatAt(w, 11.5, 10.5)).toBeGreaterThan(10); // 13.5C unoccluded at 1 tile (linear falloff)
    steps(w, 60 * SEC);
    expect(roomHeatOf(w, p)).toBeGreaterThan(3); // the joined rooms warm as one
  });
  it("closed shutters leak a little heat into the next room", () => {
    const { w, p } = twoRooms("window", "closed");
    expect(G.heatAt(w, 11.5, 10.5)).toBeGreaterThan(1); expect(G.heatAt(w, 11.5, 10.5)).toBeLessThan(3); // ~2.0C
    steps(w, 60 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(1.2);
  });
  it("open shutters let much more heat through than closed ones", () => {
    const { w, p } = twoRooms("window", "open");
    expect(G.heatAt(w, 11.5, 10.5)).toBeGreaterThan(6); expect(G.heatAt(w, 11.5, 10.5)).toBeLessThan(10); // ~8.1C
    steps(w, 60 * SEC);
    expect(roomHeatOf(w, p)).toBeGreaterThan(2);
    expect(roomHeatOf(w, p)).toBeLessThan(5); // ~2.9C: less than the open-door case (~5.3C)
  });
  it("glass seals the window: no heat gets through", () => {
    const { w, p } = twoRooms("glass", "closed");
    expect(G.heatAt(w, 11.5, 10.5)).toBeLessThan(0.5);
    steps(w, 60 * SEC);
    expect(roomHeatOf(w, p)).toBeLessThan(0.5);
  });
});

describe("ADR-440 doors and windows share the Interact toggle path", () => {
  it("ToggleDoor flips window shutters through the same action as a door, and Interact offers it", () => {
    const h = hut({ walls: { N: "window", S: "wall", W: "wall", E: "wall" } });
    const w = h.w; const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    const shutters = h.inserts.N!;
    const att = G.resolveAttachment(w, shutters, G.AttachKind.Door)!;
    expect(w.getField(att, G.DoorState, "open")).toBe(0);
    // nearestDoor finds shutters (def.door), so the Interact panel offers the window as a door
    const ctx = { world: w, player: p } as G.MenuCtx;
    expect(G.nearestDoor(ctx)?.entity).toBe(shutters);
    expect(G.interactPanel(ctx)).toMatchObject({ panel: "door", piece: shutters });
    // the real intent path toggles it
    w.set(p, G.PlayerIntent, { action: G.IntentAction.ToggleDoor, target: shutters });
    const toggled = collect(w, G.DoorToggled);
    steps(w, 1);
    expect(w.getField(att, G.DoorState, "open")).toBe(1);
    expect(toggled.length).toBe(1); expect(toggled[0]!.open).toBe(1);
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBeCloseTo(0.15, 9); // the room now vents through the open shutter
    w.set(p, G.PlayerIntent, { action: G.IntentAction.ToggleDoor, target: shutters });
    steps(w, 1);
    expect(w.getField(att, G.DoorState, "open")).toBe(0);
  });
});
