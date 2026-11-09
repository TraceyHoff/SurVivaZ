import { describe, expect, test } from "vitest";
import { AudioDirector, A, surfaceOf, weaponClass, tierMaterial, type EntSnap } from "../src/audio/events.js";
import { MusicDirector } from "../src/audio/music.js";
import { AmbienceDirector, daylight, dayBedKey } from "../src/audio/ambience.js";
import { LoopSet } from "../src/audio/loops.js";
const L = { x: 0, y: 0 };
const P = (o: Partial<EntSnap> = {}): EntSnap => ({ id: 1, kind: "player", x: 0, y: 0, z: 0, sub: "fists", anim: A.Idle, animStart: 0, hp: 100, surface: "grass", ...o });
/** Run frames 1..n after a settle period so spawn gating doesn't hide events. */
function settled(): AudioDirector { const d = new AudioDirector(); d.settleSec = 0; return d; }
const keys = (r: { events: { key: string }[] }): string[] => r.events.map((e) => e.key);
describe("ADR-117 event mapping", () => {
  test("helpers: surface, weapon class, tier material", () => {
    expect(surfaceOf(1)).toBe("water"); expect(surfaceOf(9)).toBe("dirt"); expect(surfaceOf(8)).toBe("water"); expect(surfaceOf(2)).toBe("sand"); expect(surfaceOf(5)).toBe("stone"); expect(surfaceOf(3, "wood")).toBe("wood");
    expect(weaponClass("machete")).toBe("blade"); expect(weaponClass("maul")).toBe("blunt"); expect(weaponClass(undefined)).toBe("fists"); expect(weaponClass("rifle")).toBe("rifle");
    expect(tierMaterial(0)).toBe("wood"); expect(tierMaterial(2)).toBe("stone"); expect(tierMaterial(4)).toBe("metal");
  });
  test("footsteps by distance travelled and surface", () => {
    const d = settled(); d.step([P()], { now: 0, listener: L }); const got: string[] = [];
    for (let i = 1; i <= 10; i++) got.push(...keys(d.step([P({ x: i * 0.25, anim: A.Walk, surface: "sand" })], { now: i * 0.1, listener: L })));
    expect(got.filter((k) => k === "footstep.sand").length).toBe(2);
    const z = settled(); z.step([P({ id: 9, kind: "zombie", sub: "walker" })], { now: 0, listener: L, rng: () => 0.99 });
    expect(keys(z.step([P({ id: 9, kind: "zombie", sub: "walker", x: 1.2 })], { now: 0.1, listener: L, rng: () => 0.99 }))).toContain("footstep.zombie");
  });
  test("teleport (>3 tiles) does not spam steps", () => { const d = settled(); d.step([P()], { now: 0, listener: L }); expect(keys(d.step([P({ x: 10 })], { now: 0.1, listener: L }))).not.toContain("footstep.grass"); });
  test("attack start -> swing / fire by weapon class; target hit uses attacker class", () => {
    const d = settled(); const z = { id: 5, kind: "zombie" as const, x: 1, y: 0, z: 0, sub: "runner", hp: 50, anim: A.Idle, animStart: 0 };
    d.step([P({ sub: "axe" }), z], { now: 0, listener: L, rng: () => 0.99 });
    const r = keys(d.step([P({ sub: "axe", anim: A.Attack, animStart: 10 }), { ...z, hp: 40 }], { now: 0.1, listener: L, rng: () => 0.99 }));
    expect(r).toContain("combat.swing.axe"); expect(r).toContain("combat.hit.axe"); expect(r).toContain("zombie.runner.hurt");
    const g = settled(); g.step([P({ sub: "shotgun" })], { now: 0, listener: L }); expect(keys(g.step([P({ sub: "shotgun", anim: A.Attack, animStart: 3 })], { now: 0.1, listener: L }))).toContain("weapon.fire.shotgun");
    const f = settled(); f.step([P()], { now: 0, listener: L }); expect(keys(f.step([P({ anim: A.Punch, animStart: 3 })], { now: 0.1, listener: L }))).toContain("combat.swing.fists");
  });
  test("death, reload, eat/drink, level up for the local player", () => {
    const d = settled(); d.step([P({ local: true, hunger: 50, thirst: 50, level: 1, reload: 0 })], { now: 0, listener: L });
    const r = keys(d.step([P({ local: true, hunger: 60, thirst: 70, level: 2, reload: 500, sub: "pistol", dead: true })], { now: 0.1, listener: L }));
    for (const k of ["consume.eat", "consume.drink", "ui.levelup", "weapon.reload.pistol", "player.death", "music.stinger.death"]) expect(r).toContain(k);
  });
  test("snuffer extinguishing a fire is distinct from a normal extinguish", () => {
    const fire = { id: 7, kind: "piece" as const, x: 2, y: 0, z: 0, sub: "campfire", lit: 1 };
    const sn = { id: 8, kind: "zombie" as const, x: 3, y: 0, z: 0, sub: "snuffer", anim: A.Idle, animStart: 0 };
    const d = settled(); d.step([fire, sn], { now: 0, listener: L, rng: () => 0.99 }); const r = keys(d.step([{ ...fire, lit: 0 }, sn], { now: 0.1, listener: L, rng: () => 0.99 }));
    expect(r).toContain("zombie.snuffer.snuff"); expect(r).toContain("fire.snuffed"); expect(r).not.toContain("fire.extinguish");
    const e = settled(); e.step([fire], { now: 0, listener: L }); expect(keys(e.step([{ ...fire, lit: 0 }], { now: 0.1, listener: L }))).toContain("fire.extinguish");
  });
  test("lit fire and running vehicle produce loops; engine pitch rises with speed", () => {
    const veh = (speed: number, on = true): EntSnap => ({ id: 3, kind: "vehicle", x: 1, y: 1, z: 0, sub: "truck", vehicle: { speed, maxSpeed: 20, engineOn: on, seats: 1, lights: false } });
    const d = settled(); d.step([veh(0, false)], { now: 0, listener: L });
    const a = d.step([veh(0)], { now: 0.1, listener: L }); expect(keys(a)).toContain("vehicle.engine.start");
    const idle = a.loops.find((l) => l.key === "vehicle.truck.idle")!; const fast = d.step([veh(18)], { now: 0.2, listener: L }).loops.find((l) => l.key === "vehicle.truck.rev")!;
    expect(fast.pitch!).toBeGreaterThan(idle.pitch!);
    const f = settled(); expect(f.step([{ id: 4, kind: "piece", x: 0, y: 0, z: 0, sub: "campfire", lit: 1 }], { now: 0, listener: L }).loops[0]!.key).toBe("fire.crackle");
  });
  test("door, explosion (despawn), build place gated by settle + bulk spawn", () => {
    const d = new AudioDirector(); d.settleSec = 1; const door = { id: 2, kind: "piece" as const, x: 1, y: 0, z: 0, sub: "door_metal", door: 0, material: "metal" };
    expect(keys(d.step([door, { id: 30, kind: "piece", x: 2, y: 0, z: 0, sub: "wall", material: "wood" }], { now: 0, listener: L }))).toEqual([]);
    expect(keys(d.step([door], { now: 0.5, listener: L }))).toEqual([]); // despawn before settle: silent
    expect(keys(d.step([{ ...door, door: 1 }, { id: 31, kind: "explosive", x: 3, y: 0, z: 0, sub: "" }], { now: 2, listener: L }))).toEqual(["door.open.swing"]); // ADR-314: Art's swing set (was door.open.metal)
    expect(keys(d.step([{ ...door, door: 1 }], { now: 2.1, listener: L }))).toContain("explosion");
    expect(keys(d.step([{ ...door, door: 1 }, { id: 40, kind: "piece", x: 2, y: 2, z: 0, sub: "wall", material: "stone" }], { now: 3, listener: L }))).toContain("build.place.stone");
    const bulk = Array.from({ length: 10 }, (_, i): EntSnap => ({ id: 100 + i, kind: "piece", x: 1, y: 1, z: 0, sub: "wall" }));
    expect(keys(d.step([{ ...door, door: 1 }, ...bulk], { now: 4, listener: L }))).not.toContain("build.place.wood");
  });
  test("far entities are silent", () => { const d = settled(); d.step([P({ x: 60 })], { now: 0, listener: L }); expect(keys(d.step([P({ x: 60, anim: A.Attack, animStart: 3 })], { now: 0.1, listener: L }))).toEqual([]); });
});
describe("ADR-117 music + ambience", () => {
  test("menu theme in menu; explore by day, night layer at night; combat overrides gaps", () => {
    const m = new MusicDirector(() => 0.5, [10, 10], [5, 5], 1);
    for (let i = 0; i < 20; i++) m.step({ mode: "menu", night: false, threat: 0, dt: 0.1 }); expect(m.gains["music.menu"]).toBe(1);
    for (let i = 0; i < 20; i++) m.step({ mode: "game", night: false, threat: 0, dt: 0.1 }); expect(m.gains["music.menu"]).toBe(0); expect(m.gains["music.explore"]).toBe(1);
    for (let i = 0; i < 20; i++) m.step({ mode: "game", night: true, threat: 0, dt: 0.1 }); expect(m.gains["music.night"]).toBe(1); expect(m.gains["music.explore"]).toBe(0);
    for (let i = 0; i < 100; i++) m.step({ mode: "game", night: true, threat: 0, dt: 0.1 }); expect(m.phase).toBe("gap"); expect(m.gains["music.night"]).toBe(0);
    for (let i = 0; i < 40; i++) m.step({ mode: "game", night: true, threat: 1, dt: 0.1 }); expect(m.gains["music.combat.low"]).toBe(1); expect(m.gains["music.combat.high"]).toBeGreaterThan(0.5);
  });
  test("ambience: day/night beds, biome pick, rain indoor variant, storm thunder", () => {
    expect(daylight(0)).toBe(0); expect(daylight(0.5)).toBe(1); expect(daylight(0.25)).toBeCloseTo(0.5);
    expect(dayBedKey({ water: 0, sand: 0, forest: 0.6, stone: 0 })).toBe("amb.day.forest"); expect(dayBedKey({ water: 0, sand: 0.1, forest: 0.1, stone: 0 })).toBe("amb.day");
    const a = new AmbienceDirector(() => 0.5); const base = { dayFrac: 0.5, weather: 0, intensity: 0, windSpeed: 0, indoors: false, biome: { water: 0.3, sand: 0.5, forest: 0, stone: 0 }, dt: 1, inGame: true };
    const day = a.step(base).loops.map((l) => l.key); expect(day).toContain("amb.day.beach"); expect(day).toContain("amb.water.shore"); expect(day).not.toContain("amb.night");
    expect(a.step({ ...base, dayFrac: 0 }).loops.map((l) => l.key)).toContain("amb.night");
    expect(a.step({ ...base, weather: 1, indoors: true }).loops.map((l) => l.key)).toContain("weather.rain.indoor");
    let thunder = 0; for (let i = 0; i < 200; i++) thunder += a.step({ ...base, weather: 2 }).events.filter((e) => e.key === "weather.thunder").length; expect(thunder).toBeGreaterThan(2);
  });
  test("LoopSet starts, updates, retries while loading and stops stale loops", () => {
    const calls: string[] = []; let next = 1; let loading = true;
    const ls = new LoopSet({ play: (k) => { if (loading) return 0; calls.push(`play:${k}`); return next++; }, update: (id) => calls.push(`upd:${id}`), stop: (id) => calls.push(`stop:${id}`) });
    ls.sync([{ id: "a", key: "fire.crackle", gain: 1 }]); expect(ls.size).toBe(0); loading = false;
    ls.sync([{ id: "a", key: "fire.crackle", gain: 1 }]); ls.sync([{ id: "a", key: "fire.crackle", gain: 0.5 }]); ls.sync([]);
    expect(calls).toEqual(["play:fire.crackle", "upd:1", "stop:1"]);
  });
});
