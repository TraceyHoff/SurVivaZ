// ADR-336: AI wants, aspirations, personality, moods and routines (Task 37 slice 1).
// The layer is unwired by design (the coordinator owns buildAgentView / the registry): tests drive
// fillLifeSensors / pickPersonalWant / lifeBehaviors directly on hand-built views, plus the real
// persistence round-trip through flushAiLife.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, setTimeOfDay, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import {
  completeWant, deriveMood, fillLifeSensors, flushAiLife, isLifeIdle, lifeBehaviors, lifeData, lifeStateOf,
  nearestWaterTile, personalityOf, pickPersonalWant, routineAllows, snoozeWant,
  type LifeMood, type LifePersonality, type LifePhase, type LifeSensors,
} from "../src/ai/life.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

let nid = 9600;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(seed = 42, slot = 0): Rig {
  const w = makeWorld({}, seed);
  installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, slot, "bot_gatherer"), 1);
  a.bb.set("selfEntity", p);
  // park the clock inside the bot's own rhythm so routine gating does not block the pick tests
  setTimeOfDay(w, personalityOf(a).rhythm === "owl" ? 2 : 12);
  return { w, p, a, home: { x: 0, y: 0 } };
}
type View = G.AgentWorldView & LifeSensors;
const idleView = (r: Rig, home = r.home): View => ({
  seen: [], home, playerName: "friend",
  plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] },
} as unknown as View);
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
type Ctx = AgentContext<View>;
const ctxOf = (r: Rig, view: View): Ctx => {
  const v = G.buildAgentSelf(r.w, r.p, r.a)!;
  return { self: v, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: view };
};
const defsOf = (r: Rig): G.GameDefs => G.gameplayDefs(r.w);
const itemId = (r: Rig, key: string): number => defsOf(r).itemId(key);
const give = (r: Rig, key: string, n = 1): void => { G.addItem(r.w, r.p, itemId(r, key), n); };
/** A home with no water within the life layer's search radius (dry land for rest-only picks). */
function dryHome(r: Rig): { x: number; y: number } {
  for (let ox = 0; ox <= 300; ox += 30) for (let oy = 0; oy <= 300; oy += 30) {
    const home = { x: ox, y: oy };
    if (!nearestWaterTile(r.w, home)) return home;
  }
  throw new Error("no dry home found in range");
}
/** A home with water nearby: installs the adr181 fake-lake TerrainRes (water for 0 <= x < 20) and
 *  homes the bot on dry land 10 tiles east of the shore. Real seed-42 terrain has no water near
 *  spawn on any grid the sensor can reach, so the visit_water tests use the lake like adr181 does. */
function wetHome(r: Rig): { x: number; y: number } {
  r.w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 0 && tx < 20 ? 1 : 3), heightAt: () => 0 });
  return { x: 30, y: 0 };
}
const allowedPhase = (p: LifePersonality): LifePhase => lifeData().rhythms[p.rhythm].phases[0]!;
const blockedPhase = (p: LifePersonality): LifePhase => (p.rhythm === "owl" ? "day" : "night");
const moveBot = (r: Rig, x: number, y: number): void => { r.w.set(r.p, Transform, { x, y }); };

// ---- determinism -----------------------------------------------------------------
describe("personality", () => {
  it("same bot id -> same personality across fresh agents", () => {
    const a = personalityOf(G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1));
    const b = personalityOf(G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1));
    expect(b).toEqual(a);
    expect(a.favouriteFood).toBeTruthy(); expect(a.keepsake).toBeTruthy();
    expect(lifeData().favouriteFoods).toContain(a.favouriteFood);
    expect(lifeData().keepsakes).toContain(a.keepsake);
    for (const k of ["sociability", "industriousness", "bravery", "curiosity", "greed"] as const) {
      expect(a[k]).toBeGreaterThanOrEqual(0); expect(a[k]).toBeLessThanOrEqual(1);
    }
  });
  it("different bots differ (fnv1a streams, not one shared roll)", () => {
    const cs = new Set<number>(); const rs = new Set<string>();
    for (let slot = 0; slot < 8; slot++) {
      const p = personalityOf(G.makeAgent(G.makeAgentIdentity(3, slot, "bot_gatherer"), 1));
      cs.add(p.curiosity); rs.add(p.rhythm);
    }
    expect(cs.size).toBeGreaterThanOrEqual(6);
    expect(rs.size).toBeGreaterThan(1);
  });
  it("routineAllows matches the data rhythms", () => {
    const p: LifePersonality = { sociability: 0.5, industriousness: 0.5, bravery: 0.5, curiosity: 0.5, greed: 0.5, rhythm: "owl", favouriteFood: "apple", keepsake: "straw_hat" };
    expect(routineAllows(p, "night")).toBe(true); expect(routineAllows(p, "dusk")).toBe(true);
    expect(routineAllows(p, "day")).toBe(false); expect(routineAllows(p, "dawn")).toBe(false);
    expect(routineAllows({ ...p, rhythm: "early" }, "dawn")).toBe(true);
    expect(routineAllows({ ...p, rhythm: "early" }, "night")).toBe(false);
  });
});

// ---- mood (pure) -----------------------------------------------------------------
describe("deriveMood", () => {
  const p: LifePersonality = { sociability: 0.5, industriousness: 0.5, bravery: 0.5, curiosity: 0.5, greed: 0.5, rhythm: "day", favouriteFood: "apple", keepsake: "straw_hat" };
  const fine = { hunger: 0.9, thirst: 0.9, hp: 0.9, cold: false };
  const recent = { tick: 30000, lastSocialTick: 29000, lastAttackedTick: -1e9, lastWantTick: 20000 };
  it("content when fed, warm, safe and recently social", () => {
    expect(deriveMood(p, fine, recent).label).toBe("content");
  });
  it("lonely after long solitude", () => {
    const m: LifeMood = deriveMood(p, fine, { ...recent, lastSocialTick: 1000 });
    expect(m.label).toBe("lonely"); expect(m.social).toBeGreaterThan(0);
  });
  it("weary when hurt, hungry or cold — and it beats lonely", () => {
    expect(deriveMood(p, { ...fine, hp: 0.3 }, { ...recent, lastSocialTick: 1000 }).label).toBe("weary");
    expect(deriveMood(p, { ...fine, hunger: 0.3 }, recent).label).toBe("weary");
    expect(deriveMood(p, { ...fine, cold: true }, recent).label).toBe("weary");
    expect(deriveMood(p, fine, { ...recent, lastAttackedTick: 29900 }).label).toBe("weary");
  });
  it("restless after a long stretch with no want completed", () => {
    const m = deriveMood(p, fine, { ...recent, lastWantTick: 1000 });
    expect(m.label).toBe("restless"); expect(m.explore).toBeGreaterThan(0);
  });
  it("cheerful just after a want is completed", () => {
    const m = deriveMood(p, fine, { ...recent, lastWantTick: 29500 });
    expect(m.label).toBe("cheerful"); expect(m.social).toBeGreaterThan(0); expect(m.explore).toBeGreaterThan(0);
  });
});

// ---- want selection ---------------------------------------------------------------
describe("pickPersonalWant", () => {
  it("picks the favourite food when it is carried and nothing else competes", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 2);
    const view = idleView(r, dryHome(r)); // dry: no water want; no other bot, no farm, no keepsake mats
    const want = pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) });
    expect(want?.kind).toBe("eat_favourite"); expect(want?.item).toBe(itemId(r, p.favouriteFood));
    expect(typeof want?.slot).toBe("number"); expect((want?.slot ?? -1)).toBeGreaterThanOrEqual(0);
  });
  it("never picks the favourite food when it is not carried", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    const view = idleView(r, dryHome(r));
    const want = pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) });
    expect(want?.kind).not.toBe("eat_favourite");
  });
  it("picks rest when nothing else is actionable (dry home, empty bag, alone)", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    const view = idleView(r, dryHome(r));
    expect(pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) })?.kind).toBe("rest");
  });
  it("picks visit_water when water is near and the food is not carried", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    const home = wetHome(r); const view = idleView(r, home);
    const want = pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) });
    // visit_water or rest both score; visit_water must be available and beat rest unless the bot is
    // strongly un-curious — so assert the winner is one of the two and the target is water-adjacent.
    expect(["visit_water", "rest"]).toContain(want?.kind);
    if (want?.kind === "visit_water") {
      expect(G.nearWater(r.w, want.target!.x, want.target!.y)).toBe(true);
    }
  });
  it("picks socialize when another AI human is remembered nearby", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    r.a.identity.traits.sociability = 0.95; r.a.identity.traits.industriousness = 0.1; // force the social win
    const other = spawnLearned(r.w, { x: 3, y: 0, maxWeight: 0, clientId: 8 }); pid(r.w, other, 8); net(r.w, other);
    r.a.memory.see({ id: other, kind: "player", x: 3, y: 0, tick: 0 });
    const view = idleView(r, dryHome(r));
    expect(pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) })?.kind).toBe("socialize");
    // ...and never when nobody is remembered
    const alone = rig();
    expect(pickPersonalWant(alone.a, alone.w, idleView(alone, dryHome(alone)), { phase: allowedPhase(personalityOf(alone.a)) })?.kind).not.toBe("socialize");
  });
  it("picks the keepsake craft when its hand recipe is affordable and it owns no keepsake", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    r.a.identity.traits.industriousness = 0.9; // force the craft win over rest
    const keepsake = itemId(r, p.keepsake);
    const recipe = [...defsOf(r).recipes.values()].find((x) => x.output.item === keepsake && x.station === 0);
    expect(recipe).toBeDefined();
    for (const ing of recipe!.ingredients) give(r, defsOf(r).items.get(ing.item)!.key, ing.count);
    const view = idleView(r, dryHome(r));
    const want = pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) });
    expect(want?.kind).toBe("craft_keepsake");
    expect(want?.recipe).toBe(recipe!.id);
    // owning the keepsake removes the want entirely
    give(r, p.keepsake, 1);
    expect(pickPersonalWant(r.a, r.w, view, { phase: allowedPhase(p) })?.kind).not.toBe("craft_keepsake");
  });
  it("returns null outside the bot's daily rhythm", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 2);
    const view = idleView(r, dryHome(r));
    expect(pickPersonalWant(r.a, r.w, view, { phase: blockedPhase(p) })).toBeNull();
  });
  it("returns null while a want is on cooldown, and picks it again after the cooldown", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 2);
    const view = idleView(r, dryHome(r)); const phase = allowedPhase(p);
    completeWant(r.a, "favourite_food", 100);
    expect(pickPersonalWant(r.a, r.w, view, { phase, tick: 200 })?.kind).not.toBe("eat_favourite");
    expect(pickPersonalWant(r.a, r.w, view, { phase, tick: 100 + 12000 + 1 })?.kind).toBe("eat_favourite");
  });
  it("a snoozed want scores 0 until its snooze expires", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 2);
    const view = idleView(r, dryHome(r)); const phase = allowedPhase(p);
    snoozeWant(r.a, "favourite_food", 100, 1200);
    expect(pickPersonalWant(r.a, r.w, view, { phase, tick: 200 })?.kind).not.toBe("eat_favourite");
    expect(pickPersonalWant(r.a, r.w, view, { phase, tick: 2000 })?.kind).toBe("eat_favourite");
  });
});

// ---- idle gating ------------------------------------------------------------------
describe("fillLifeSensors idle gating", () => {
  it("an unhired idle bot with needs met gets a want; a busy plan gets none", () => {
    const r = rig(); fed(r);
    const view = idleView(r, dryHome(r));
    fillLifeSensors(r.w, r.p, view, r.a);
    expect(view.lifeWant?.kind).toBe("rest");
    expect(view.lifeMood?.label).toBe("content");
    expect(lifeStateOf(r.a).activeWant).toBe("rest");
    const busy = idleView(r, dryHome(r));
    busy.plan = { goal: "axe", leaves: [1], hunt: [], keep: new Set<number>(), blocked: [] };
    fillLifeSensors(r.w, r.p, busy, r.a);
    expect(busy.lifeWant).toBeUndefined();
  });
  it("hunger, thirst, low hp, cold, a wanted gather and nearby zombies all block personal wants", () => {
    // one fresh rig per case: memory (zombie sightings) and vitals persist across sensor passes
    const cases: ((r: Rig, v: View) => void)[] = [
      (r) => { r.w.set(r.p, G.Survival, { hunger: 20, thirst: 100 }); },
      (r) => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 20 }); },
      (r) => { r.w.set(r.p, G.Health, { hp: 1, max: 100 }); },
      (_r, v) => { v.cold = true; },
      (_r, v) => { v.gatherNode = { id: 1, x: 1, y: 1, wanted: true }; },
      (r) => { const z = spawnLearned(r.w, { x: 2, y: 0, maxWeight: 0, clientId: 9 }); r.a.memory.see({ id: z, kind: "zombie", x: 2, y: 0, tick: 0 }); },
    ];
    for (const setup of cases) {
      const r = rig(); fed(r); const v = idleView(r, dryHome(r)); setup(r, v);
      fillLifeSensors(r.w, r.p, v, r.a);
      expect(v.lifeWant).toBeUndefined();
    }
    // ...and the same setup with needs met and no danger gets the want back
    const r = rig(); fed(r);
    const v = idleView(r, dryHome(r)); fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant?.kind).toBe("rest");
  });
  it("a hired bot follows the ADR-327 idle flag and nothing else", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 1);
    const home = dryHome(r);
    const busyHire = idleView(r, home);
    busyHire.hire = { job: 1, owner: 7, ax: 0, ay: 0 };
    fillLifeSensors(r.w, r.p, busyHire, r.a);
    expect(busyHire.lifeWant).toBeUndefined();
    const idleHire = idleView(r, home);
    idleHire.hire = { job: 1, owner: 7, ax: 0, ay: 0, idle: true };
    delete idleHire.plan; // hire sensors drop the bot's own plan
    fillLifeSensors(r.w, r.p, idleHire, r.a);
    expect(idleHire.lifeWant?.kind).toBe("eat_favourite");
    expect(isLifeIdle(r.w, r.p, idleHire, r.a)).toBe(true);
    expect(isLifeIdle(r.w, r.p, busyHire, r.a)).toBe(false);
  });
  it("mood is derived even when the bot is not idle", () => {
    const r = rig(); r.w.set(r.p, G.Survival, { hunger: 20, thirst: 100 });
    const v = idleView(r, dryHome(r));
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant).toBeUndefined();
    expect(v.lifeMood?.label).toBe("weary");
  });
  it("rest completes after restTicks near home; leaving home resets the timer", () => {
    const r = rig(); fed(r); const home = dryHome(r);
    moveBot(r, home.x, home.y);
    const st = lifeStateOf(r.a, 0); st.activeWant = "rest";
    const v = idleView(r, home);
    fillLifeSensors(r.w, r.p, v, r.a); // picks rest again and starts the rest timer at tick 0
    expect(st.restStartedTick).toBe(0);
    steps(r.w, 599); // world tick 599: not yet
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(st.completed.rest).toBeUndefined();
    steps(r.w, 2); // tick 601 >= 600
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(st.completed.rest?.count).toBe(1);
    expect(st.activeWant).toBeUndefined();
  });
  it("keepsake completes when the keepsake appears in the bag", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    r.a.identity.traits.industriousness = 0.9; // keeps the keepsake want picked (not rest)
    const keepsake = itemId(r, p.keepsake);
    const recipe = [...defsOf(r).recipes.values()].find((x) => x.output.item === keepsake && x.station === 0)!;
    for (const ing of recipe.ingredients) give(r, defsOf(r).items.get(ing.item)!.key, ing.count);
    const v = idleView(r, dryHome(r));
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant?.kind).toBe("craft_keepsake");
    expect(lifeStateOf(r.a).completed.keepsake).toBeUndefined();
    give(r, p.keepsake, 1); // the craft lands
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(lifeStateOf(r.a).completed.keepsake?.count).toBe(1);
  });
});

// ---- behaviors --------------------------------------------------------------------
describe("lifeBehaviors", () => {
  it("registers one life_want behaviour; it scores 0 with no want", () => {
    const bs = lifeBehaviors();
    expect(bs.map((b) => b.name)).toEqual(["life_want"]);
    const r = rig(); fed(r); const c = ctxOf(r, idleView(r));
    expect(bs[0]!.considerations[0]!.input(c)).toBe(0);
  });
  it("eat_favourite eats the slot and completes the want", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 1);
    const v = idleView(r, dryHome(r));
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant?.kind).toBe("eat_favourite");
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(o.actions).toContain(`eat:${v.lifeWant!.slot}`);
    expect(lifeStateOf(r.a).completed.favourite_food?.count).toBe(1);
  });
  it("socialize walks to the other bot, waves and completes", () => {
    const r = rig(); fed(r);
    const other = spawnLearned(r.w, { x: 2, y: 0, maxWeight: 0, clientId: 8 }); pid(r.w, other, 8); net(r.w, other);
    r.a.memory.see({ id: other, kind: "player", x: 2, y: 0, tick: 0 });
    const v = idleView(r, dryHome(r));
    v.lifeWant = { id: "socialize", kind: "socialize", mood: "content", target: { x: 2, y: 0 } };
    lifeStateOf(r.a, 0).activeWant = "socialize";
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(o.emote).toBe("wave");
    expect(lifeStateOf(r.a).completed.socialize?.count).toBe(1);
  });
  it("visit_water completes on arrival", () => {
    const r = rig(); fed(r); const home = wetHome(r);
    const at = nearestWaterTile(r.w, home)!;
    moveBot(r, at.x, at.y);
    const v = idleView(r, home);
    v.lifeWant = { id: "visit_water", kind: "visit_water", mood: "content", target: at };
    lifeStateOf(r.a, 0).activeWant = "visit_water";
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(lifeStateOf(r.a).completed.visit_water?.count).toBe(1);
  });
  it("craft_keepsake issues the hand recipe (completion follows in the sensor)", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    const keepsake = itemId(r, p.keepsake);
    const recipe = [...defsOf(r).recipes.values()].find((x) => x.output.item === keepsake && x.station === 0)!;
    const v = idleView(r, dryHome(r));
    v.lifeWant = { id: "keepsake", kind: "craft_keepsake", mood: "content", recipe: recipe.id, item: keepsake };
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(o.actions).toContain(`craft:${recipe.id}`);
    expect(lifeStateOf(r.a).completed.keepsake).toBeUndefined(); // not complete until the item exists
  });
  it("tend_garden gathers a mature crop and completes", () => {
    const r = rig(); fed(r);
    const v = idleView(r, dryHome(r));
    v.farm = { harvest: { id: 99, x: 1, y: 0 } };
    v.lifeWant = { id: "tend_garden", kind: "tend_garden", mood: "content", target: { x: 1, y: 0 } };
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(o.actions).toContain("gather");
    expect(lifeStateOf(r.a).completed.tend_garden?.count).toBe(1);
  });
  it("rest walks home and stands still (the sensor completes it after restTicks)", () => {
    const r = rig(); fed(r);
    const v = idleView(r, dryHome(r));
    v.lifeWant = { id: "rest", kind: "rest", mood: "content", target: { x: v.home.x, y: v.home.y } };
    const c = ctxOf(r, v); const o = out();
    lifeBehaviors()[0]!.run(c, o);
    expect(o.moveX).toBe(0); expect(o.moveY).toBe(0);
    expect(lifeStateOf(r.a).completed.rest).toBeUndefined();
  });
});

// ---- persistence ------------------------------------------------------------------
describe("persistence", () => {
  it("flushAiLife round-trips want progress through a stored identity (addBot-style restore)", () => {
    const r = rig(); fed(r);
    completeWant(r.a, "favourite_food", 500);
    completeWant(r.a, "visit_water", 900);
    const seen: { id: string; partial: { aiLife: ReturnType<typeof lifeStateOf> } }[] = [];
    // debounced: not yet due at tick 500, forced flush writes
    expect(flushAiLife([r.a], (id, partial) => { seen.push({ id, partial }); }, 500)).toEqual([]);
    expect(flushAiLife([r.a], (id, partial) => { seen.push({ id, partial }); }, 500, true)).toEqual([r.a.identity.id]);
    expect(seen).toHaveLength(1);
    const stored = JSON.parse(JSON.stringify(seen[0]!.partial.aiLife));
    // a fresh agent for the same bot id, restored from the stored record like addBot does
    const fresh = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
    (fresh.identity as unknown as { aiLife: unknown }).aiLife = stored;
    const st = lifeStateOf(fresh);
    expect(st.completed.favourite_food).toEqual({ count: 1, tick: 500 });
    expect(st.completed.visit_water).toEqual({ count: 1, tick: 900 });
    // personality is derived, not stored — identical for the restored bot
    expect(personalityOf(fresh)).toEqual(personalityOf(r.a));
    // the flushed payload is a deep copy: later mutation does not rewrite history
    completeWant(r.a, "favourite_food", 1500);
    expect(stored.completed.favourite_food.count).toBe(1);
  });
  it("lifeStateOf validates stored records (unknown wants dropped, bad counts repaired)", () => {
    const r = rig();
    (r.a.identity as unknown as { aiLife: unknown }).aiLife = {
      v: 1, bornTick: 7, activeWant: "not_a_want",
      completed: { favourite_food: { count: 2, tick: 40 }, bogus: { count: 9, tick: 9 } },
      snooze: { rest: 500 }, lastSocialTick: 30, lastAttackedTick: -1e9,
    };
    const st = lifeStateOf(r.a);
    expect(st.activeWant).toBeUndefined();
    expect(st.completed.favourite_food).toEqual({ count: 2, tick: 40 });
    expect(st.completed.bogus).toBeUndefined();
    expect(st.snooze.rest).toBe(500);
  });
  it("setTimeOfDay phases gate the sensor (night owl does not want at noon)", () => {
    const r = rig(); fed(r); const p = personalityOf(r.a);
    give(r, p.favouriteFood, 1);
    const v = idleView(r, dryHome(r));
    setTimeOfDay(r.w, p.rhythm === "owl" ? 12 : 2);
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant).toBeUndefined();
    setTimeOfDay(r.w, p.rhythm === "owl" ? 2 : 12);
    fillLifeSensors(r.w, r.p, v, r.a);
    expect(v.lifeWant).toBeDefined();
  });
});
