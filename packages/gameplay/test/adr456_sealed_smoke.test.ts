/**
 * ADR-456: smoke in a sealed room — a roaring fire (heat >= 12 C, i.e. close to a lit campfire or
 * fireplace; a torch at 4 never counts) in a sealed-ish room (openness <= 0.1) hurts at
 * hpPerSec * (1 - openness) hp/s, as a HealthRegen Add modifier (the sick-food pattern, stateless
 * v1: refreshed while the condition holds, lapsing on its own when a door/shutter is opened or the
 * fire goes out). Opening a window/door vents it. Threshold 0.1 (not the SCOPE's 0.25): ADR-440
 * pins one open door at 0.25 and one open shutter at 0.15, so 0.25 would still smoke with the door
 * open; 0.1 sits between one closed-shutter window (0.0375, still smokes) and one open shutter
 * (0.15, vents).
 */
import { describe, expect, it } from "vitest";
import { evaluate, setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

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
  expect(G.heatAt(r.w, 10.5, 10.5)).toBeGreaterThanOrEqual(12);
  return { ...r, camp, f };
}
const hpOf = (w: World, p: Entity) => w.getField(p, G.Health, "hp") ?? 0;
const smokeMod = (w: World, p: Entity) => evaluate(w, p, G.Buffs, G.Stat.HealthRegen, 0);

describe("ADR-456 smoke in a sealed room", () => {
  it("tuning: heatC 12, openness 0.1, hpPerSec 1", () => {
    expect(d.environment.smoke).toEqual({ heatC: 12, openness: 0.1, hpPerSec: 1 });
  });

  it("a sealed room + roaring fire hurts (hp drops ~45 in 60 s; modifier -1.0 hp/s)", () => {
    const { w, p } = litRoom();
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBe(0);
    expect(hpOf(w, p)).toBeGreaterThan(99); // litRoom's 1 s setup step already costs ~0.6 hp to smoke
    steps(w, 60 * SEC);
    expect(smokeMod(w, p)).toBeCloseTo(-1, 2);
    const hp = hpOf(w, p);
    expect(hp).toBeLessThan(70); expect(hp).toBeGreaterThan(30); // ~55: drain 0.75/s (1.0 smoke - 0.25 base regen)
  });

  it("opening the door vents it (hp stops dropping and the modifier lapses)", () => {
    const r = litRoom({ walls: { N: "wall", S: "door", W: "wall", E: "wall" } });
    const { w, p } = r;
    steps(w, 30 * SEC);
    const atOpen = hpOf(w, p);
    expect(atOpen).toBeLessThan(100); // sealed + lit: already hurting
    expect(smokeMod(w, p)).toBeCloseTo(-1, 2);
    setOpen(w, r.inserts.S!, true);
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBeCloseTo(0.25, 9); // open door: above the 0.1 threshold
    steps(w, 30 * SEC);
    expect(smokeMod(w, p)).toBe(0);
    expect(hpOf(w, p)).toBeGreaterThanOrEqual(atOpen - 0.5); // no more smoke; regen resumes (+0.25/s)
  });

  it("an unlit fire does not smoke (hp unchanged)", () => {
    const r = winterRoom();
    place(r.w, "campfire", 10.5, 10.5); // placed, never lit
    steps(r.w, SEC);
    expect(G.heatAt(r.w, 10.5, 10.5)).toBe(0);
    steps(r.w, 60 * SEC);
    expect(smokeMod(r.w, r.p)).toBe(0);
    expect(hpOf(r.w, r.p)).toBe(100);
  });

  it("an open doorway vents it (hp unchanged)", () => {
    const { w, p } = litRoom({ walls: { N: "wall", S: "doorway", W: "wall", E: "wall" } });
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBeCloseTo(0.1875, 9);
    steps(w, 60 * SEC);
    expect(smokeMod(w, p)).toBe(0);
    expect(hpOf(w, p)).toBe(100);
  });

  it("one open shutter vents it (hp unchanged)", () => {
    const { w, p } = litRoom({ walls: { N: "wall", S: "window", W: "wall", E: "wall" }, shutters: { S: "open" } });
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBeCloseTo(0.15, 9);
    steps(w, 60 * SEC);
    expect(smokeMod(w, p)).toBe(0);
    expect(hpOf(w, p)).toBe(100);
  });

  it("one closed-shutter window still smokes, weaker (modifier -0.9625; hp drops)", () => {
    const { w, p } = litRoom({ walls: { N: "wall", S: "window", W: "wall", E: "wall" } });
    expect(G.roomOpennessAt(w, 10.5, 10.5, 0)).toBeCloseTo(0.0375, 9);
    steps(w, 60 * SEC);
    expect(smokeMod(w, p)).toBeCloseTo(-0.9625, 2); // -1.0 * (1 - 0.0375)
    expect(hpOf(w, p)).toBeLessThan(70);
  });
});
