/**
 * ADR-443: weather response — shelter in rain/cold, dress warm.
 *
 * Repro (audit 2026-11-19, base 8616271): no reference to rain, wetness or
 * weather anywhere in ai/; a bot stands in the rain until already cold
 * (warm_up fires only at body < 36.2 C); no fur wear goal exists, so bots
 * can never reach insulation >= 10 (fur coat 7 + fur hat 3) that blocks
 * outdoor cold damage.
 */
import { describe, expect, it } from "vitest";
import { Transform, Weather, installPermissions, setTimeOfDay, type AgentOutput, type Entity, type World } from "@engine/core";
import { WeatherKind } from "../src/defs.js";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);
const iid = (k: string) => d.itemId(k);
const BASE = { x: 10, y: 10 };
function fresh(learned = true): { w: World; p: Entity } {
  const w = makeWorld(); const p = learned ? spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }) : G.spawnPlayer(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); steps(w, 1); plantClaim(w, p, BASE.x - 2, BASE.y - 2); setTimeOfDay(w, 9, 0); return { w, p }; // morning: no evening-fuel pre-goal
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 });
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
const tools = (w: World, p: Entity) => { G.addItem(w, p, iid("stone_axe"), 1); G.addItem(w, p, iid("stone_pickaxe"), 1); };
/** Wear `key` the way the walk in adr340 does (wearSlot + refreshWorn). */
const wear = (w: World, p: Entity, key: string): void => {
  G.addItem(w, p, iid(key), 1); const sl = G.readSlots(w, p);
  const slot = sl.items.findIndex((it) => it === iid(key));
  expect(slot, `${key} slot in the bag`).toBeGreaterThanOrEqual(0);
  expect(G.wearSlot(w, p, slot), `wear the ${key}`).toBe(true); G.refreshWorn(w, p);
};
/** A bot with a finished base (campfire + box + workbench + hut) so the winter fur goals can craft. */
function withBase(): { w: World; p: Entity } {
  const { w, p } = fresh(); tools(w, p);
  expect(put(w, p, "campfire", BASE.x + 3.5, BASE.y + 0.5).ok).toBe(true);
  expect(put(w, p, "basic_storage_box", BASE.x + 3.5, BASE.y + 1.6).ok).toBe(true);
  expect(put(w, p, "workbench", BASE.x - 1.6, BASE.y - 0.7).ok).toBe(true);
  steps(w, 25);
  return { w, p };
}
const plan = (w: World, p: Entity, extra: Partial<G.PlanInput> = {}) => { const bs = G.scanBase(w, d, BASE); return G.makePlan({ world: w, self: p, defs: d, base: BASE, bs, fails: {}, ...extra }); };
const fakeCtx = (over: Record<string, unknown> = {}) => {
  const bb = new Map<string, unknown>();
  const c = { self: { x: 0, y: 0, tick: 0, stamina: 1, ...(over.self as object) }, world: { ...(over.world as object) }, memory: { nearest: () => undefined },
    bb: { get: (k: string) => bb.get(k), set: (k: string, v: unknown) => { if (v === undefined) bb.delete(k); else bb.set(k, v); }, num: (k: string, def = 0) => (typeof bb.get(k) === "number" ? (bb.get(k) as number) : def) } };
  return c as never;
};
const out = (): AgentOutput => ({ moveX: 0.5, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] });
const behavior = (name: string) => G.baseBehaviors().find((b) => b.name === name)!;
const inputOf = (b: { considerations: { name: string; input: (c: never) => number }[] }, name: string, c: never) =>
  b.considerations.find((x) => x.name === name)!.input(c);

describe("ADR-443 repro: a bot in the rain has no shelter response", () => {
  it("a seek_shelter behavior exists", () => {
    expect(G.baseBehaviors().some((b) => b.name === "seek_shelter")).toBe(true);
  });
  it("the weather sensor reports rain (fillGoalSensors reads the Weather singleton)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    installPermissions(w); setTimeOfDay(w, 12, 1); // past the first-day rain ban (ADR-239)
    Object.assign(w.env(Weather), { kind: WeatherKind.Rain, intensity: 1, endsAtTick: 0xffffffff });
    steps(w, 1);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
    expect(v.world.weather?.raining).toBe(true);
    expect(v.world.weather?.wetness).toBeGreaterThanOrEqual(0);
    expect(v.world.weather?.wetness).toBeLessThanOrEqual(1);
  });
  it("the weather sensor is clear when it is not raining", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    installPermissions(w);
    steps(w, 1);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
    expect(v.world.weather?.raining).toBe(false);
  });
});

describe("ADR-443 seek_shelter: head inside when rain starts", () => {
  const rainy = (self: { x: number; y: number }, extraWorld: Record<string, unknown> = {}) => fakeCtx({
    self, world: {
      weather: { raining: true, wetness: 0, sheltered: 0 },
      chill: { body: 37, felt: 20 },
      base: BASE, bs: { complete: true, door: { id: 1, x: BASE.x + 1, y: BASE.y, open: true } },
      home: BASE, ...extraWorld,
    },
  });
  it("fires when raining, exposed, and a finished base is nearby", () => {
    const b = behavior("seek_shelter");
    expect(inputOf(b, "raining", rainy({ x: 20, y: 10 }))).toBe(1);
    expect(inputOf(b, "hasShelter", rainy({ x: 20, y: 10 }))).toBe(1);
    expect(inputOf(b, "nearby", rainy({ x: 20, y: 10 }))).toBe(1);
  });
  it("does not fire in clear weather, when already inside, or with no base", () => {
    const b = behavior("seek_shelter");
    const clear = fakeCtx({ self: { x: 20, y: 10 }, world: { weather: { raining: false, wetness: 0, sheltered: 0 }, base: BASE, bs: { complete: true }, home: BASE } });
    expect(inputOf(b, "raining", clear)).toBe(0);
    expect(inputOf(b, "raining", rainy({ x: BASE.x + 1, y: BASE.y + 1 }))).toBe(0); // inside the hut
    const sheltered = rainy({ x: 20, y: 10 }, { weather: { raining: true, wetness: 0, sheltered: 0.9 } });
    expect(inputOf(b, "raining", sheltered)).toBe(0); // under a roof already
    const noBase = rainy({ x: 20, y: 10 }, { base: undefined, bs: undefined });
    expect(inputOf(b, "hasShelter", noBase)).toBe(0);
    const far = rainy({ x: 200, y: 200 });
    expect(inputOf(b, "nearby", far)).toBe(0); // no 200-tile death march in the rain
  });
  it("walks toward the base (through the door) and stops once inside", () => {
    const b = behavior("seek_shelter");
    const c = rainy({ x: 20, y: 10 }); const o = out();
    b.run(c, o);
    expect(o.moveX !== 0 || o.moveY !== 0).toBe(true);
    expect(o.aimX).toBeLessThan(0); // west, toward the base
    const inside = rainy({ x: BASE.x + 1, y: BASE.y + 1 }); const o2 = out();
    expect(b.run(inside, o2)).toBe(false); // releases: the hire job / base work resumes
    expect(o2.moveX).toBe(0); expect(o2.moveY).toBe(0);
  });
  it("releases when the rain stops", () => {
    const b = behavior("seek_shelter");
    const c = rainy({ x: 20, y: 10 }) as unknown as { bb: { set(k: string, v: unknown): void }; world: { weather: { raining: boolean } } };
    c.bb.set("sheltering", true);
    c.world.weather.raining = false;
    expect(b.run(c as never, out())).toBe(false);
  });
  it("is a survival override like warm_up: hire duty never gates it", () => {
    const b = behavior("seek_shelter");
    expect(G.withHireDuty(b)).toBe(b);
  });
});

describe("ADR-443 warm_up / cool_down extend to wetness and rain", () => {
  it("warm_up fires for a soaked bot before its body is cold (wet clothes insulate half)", () => {
    const b = behavior("warm_up");
    const soaked = fakeCtx({ self: { x: 0, y: 0, tick: 0 }, world: { chill: { body: 37, felt: 20 }, weather: { raining: true, wetness: 0.8, sheltered: 0 } } });
    expect(inputOf(b, "chilled", soaked)).toBe(1);
    const dry = fakeCtx({ self: { x: 0, y: 0, tick: 0 }, world: { chill: { body: 37, felt: 20 }, weather: { raining: false, wetness: 0, sheltered: 0 } } });
    expect(inputOf(b, "chilled", dry)).toBe(0); // warm and dry: no warming
  });
  it("cool_down stands down in the rain (the rain already cools) unless dangerously hot", () => {
    const b = behavior("cool_down");
    const hotRain = fakeCtx({ self: { x: 0, y: 0, tick: 0 }, world: { chill: { body: 38.8, felt: 37 }, weather: { raining: true, wetness: 0.5, sheltered: 0 } } });
    expect(inputOf(b, "overheated", hotRain)).toBe(0);
    const hotDry = fakeCtx({ self: { x: 0, y: 0, tick: 0 }, world: { chill: { body: 38.8, felt: 37 }, weather: { raining: false, wetness: 0, sheltered: 0 } } });
    expect(inputOf(b, "overheated", hotDry)).toBe(1);
    const extremeRain = fakeCtx({ self: { x: 0, y: 0, tick: 0 }, world: { chill: { body: 39.5, felt: 38 }, weather: { raining: true, wetness: 0.5, sheltered: 0 } } });
    expect(inputOf(b, "overheated", extremeRain)).toBe(1);
  });
});

describe("ADR-443 fur wear goals: dress warm in winter", () => {
  it("fur coat (7) + fur hat (3) reach insulation 10, the outdoor cold-damage bar", () => {
    const coat = d.items.get(iid("fur_coat"))!; const hat = d.items.get(iid("fur_hat"))!;
    expect(coat.wear?.insulation).toBe(7); expect(hat.wear?.insulation).toBe(3);
    expect((coat.wear?.insulation ?? 0) + (hat.wear?.insulation ?? 0)).toBe(10);
    expect(G.effectiveInsulation(10, 0)).toBe(10); // dry fur holds the bar
  });
  it("the fur chain is reachable in the planner index (fur <- hunt, pelt/leather/thread <- workbench)", () => {
    const ix = G.plannerIndex(d);
    for (const k of ["fur", "fur_pelt", "fur_coat", "fur_hat", "hide", "leather", "thread", "flax"]) expect(ix.reachable.has(iid(k)), k).toBe(true);
    expect(ix.animal.has(iid("fur"))).toBe(true);
  });
  it("in winter with a workbench, a bot holding a fur coat plans to wear it", () => {
    const { w, p } = withBase(); wear(w, p, "fur_hat"); G.addItem(w, p, iid("fur_coat"), 1); G.addItem(w, p, iid("wood"), 30);
    const pl = plan(w, p, { winter: true });
    expect(pl.goal).toBe("wear:fur_coat");
    expect(pl.step?.k).toBe("wear");
  });
  it("in winter with a workbench, a bot holding a fur hat plans to wear it", () => {
    const { w, p } = withBase(); wear(w, p, "fur_coat"); G.addItem(w, p, iid("fur_hat"), 1); G.addItem(w, p, iid("wood"), 30);
    const pl = plan(w, p, { winter: true });
    expect(pl.goal).toBe("wear:fur_hat");
    expect(pl.step?.k).toBe("wear");
  });
  it("in winter a bot with the fur materials crafts the coat at the workbench (chain is satisfiable, not dead weight)", () => {
    const { w, p } = withBase(); wear(w, p, "fur_hat");
    G.addItem(w, p, iid("fur_pelt"), 3); G.addItem(w, p, iid("leather"), 1); G.addItem(w, p, iid("thread"), 3); G.addItem(w, p, iid("wood"), 30);
    const pl = plan(w, p, { winter: true });
    expect(pl.goal).toBe("wear:fur_coat");
    expect(pl.step).toMatchObject({ k: "craft", station: 2 }); // StationKind.Workbench
  });
  it("with no fur at all the winter plan works the chain instead of stalling (knife first, then carcass fur)", () => {
    const { w, p } = withBase(); G.addItem(w, p, iid("wood"), 30);
    const pl = plan(w, p, { winter: true });
    expect(pl.goal).toBe("wear:fur_hat");
    // fur comes from animal_carcass nodes (knife tier 1), thread from flax: the planner's leaves are the
    // stone-knife ingredients (flint / sticks / fiber) plus flax — a concrete next step, not a stall.
    for (const k of ["flint", "sticks", "fiber", "flax"]) expect(pl.leaves, k).toContain(iid(k));
  });
  it("with a knife in hand the winter plan gathers fur from carcasses directly", () => {
    const { w, p } = withBase(); G.addItem(w, p, iid("stone_knife"), 1); G.addItem(w, p, iid("wood"), 30);
    const pl = plan(w, p, { winter: true });
    expect(pl.goal).toBe("wear:fur_hat");
    expect(pl.leaves).toContain(iid("fur"));
    expect(pl.leaves).toContain(iid("hide"));
  });
  it("outside winter there is no fur pre-goal jumping the ladder (summer bots do not chase fur first)", () => {
    const { w, p } = withBase(); G.addItem(w, p, iid("fur_coat"), 1); G.addItem(w, p, iid("wood"), 16);
    const pl = plan(w, p, {});
    expect(pl.goal).not.toBe("wear:fur_coat");
  });
  it("the comfort band and exposure damage behaviour are untouched", () => {
    expect(d.vitals.comfortMin).toBe(8); expect(d.vitals.comfortMax).toBe(32);
  });
});
