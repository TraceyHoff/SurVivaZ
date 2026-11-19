// ADR-445: own lives actually fire.
// Repro (audit 2026-11-19, base 8616271): isLifeIdle required plan goal "idle" with no
// step/leaves/hunt, so an unhired bot with a home almost never qualified — the planner ladder
// always has a next comfort goal with gather leaves (furnish / upgrade / ...). visit_water
// searched only 24 tiles and seed 42 has no water near spawn in that radius. No aspiration
// layer existed beyond the 6 short wants, and no multi-tick live test of an unhired bot
// completing a want existed at all.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, scoreBehavior, setSeason, setTimeOfDay, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import {
  aspirationOf, completeWant, fillLifeSensors, isComfortGoal, isLifeIdle, lifeBehaviors, lifeData,
  lifeStateOf, nearestWaterTile, personalityOf, pickPersonalWant,
  type LifeSensors,
} from "../src/ai/life.js";
import { aiMemoryOf, GOAL_LADDER } from "../src/ai/planner.js";
import { makeWorld, plantClaim, spawnLearned, steps, DT } from "./helpers.js";

let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(seed = 42, slot = 0): Rig {
  const w = makeWorld({}, seed);
  installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, slot, "bot_gatherer"), 1);
  a.bb.set("selfEntity", p);
  setTimeOfDay(w, personalityOf(a).rhythm === "owl" ? 2 : 12);
  return { w, p, a, home: { x: 0, y: 0 } };
}
type View = G.AgentWorldView & LifeSensors;
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
/** A finished shelter scan: every BASE_SLOT present, bed + hearth standing. */
const completeBs = (): G.BaseState => ({
  pieces: new Map(G.BASE_SLOTS.map((s) => [s.id, 1 as Entity])),
  stations: new Map([
    [G.StationKind.Campfire, { id: 10 as Entity, x: 11.5, y: 10.5, fired: true, lit: true, fuelTicks: 99999 }],
    [G.StationKind.Workbench, { id: 11 as Entity, x: 13.5, y: 10.5, fired: false, lit: false, fuelTicks: 0 }],
  ]),
  storage: { id: 12 as Entity, x: 13.5, y: 11.6, counts: new Map(), free: 10 },
  bed: { id: 13 as Entity, x: 10.5, y: 11 },
  complete: true,
  hearth: 10 as Entity,
});
const viewWithPlan = (r: Rig, goal: string, opts: { bs?: G.BaseState; gatherWanted?: boolean } = {}): View => ({
  seen: [], home: r.home, playerName: "friend", base: { x: 10, y: 10 },
  ...(opts.bs ? { bs: opts.bs } : {}),
  plan: { goal, leaves: [1], hunt: [], keep: new Set<number>(), blocked: [] },
  ...(opts.gatherWanted ? { gatherNode: { id: 1, x: 5, y: 5, wanted: true } } : {}),
} as unknown as View);

describe("ADR-445 repro: the comfort-goal idle gate", () => {
  it("isComfortGoal covers the post-shelter ladder and nothing before bed", () => {
    const names = GOAL_LADDER.map((g) => (g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k));
    const bedIdx = names.indexOf("bed");
    expect(bedIdx).toBeGreaterThan(0);
    // every goal after bed is comfort except the survival-adjacent ones (defence, cook,
    // cooked_meat, water_flask, wood — fuel/food/water chores are never deferred)
    for (const n of ["furnish:table", "furnish:torch_stand", "animal_feed", "knife", "stone_spear", "wear:straw_hat", "shovel", "furnace", "charcoal", "bronze_ingot", "anvil", "dock", "shipyard", "axe2", "pickaxe2", "bronze_spear", "upgrade"]) {
      expect(names, n).toContain(n);
      expect(isComfortGoal(n), n).toBe(true);
    }
    for (const n of ["axe", "pickaxe", "campfire", "basic_storage_box", "workbench", "wear:torch", "earthworks", "ramp", "base", "hearth", "bed", "defence", "cook", "cooked_meat", "water_flask", "wood"]) {
      expect(isComfortGoal(n), n).toBe(false);
    }
    void bedIdx;
  });
  it("an unhired homed bot on a comfort goal with gather leaves is idle for life (was: never)", () => {
    const r = rig(); fed(r);
    const view = viewWithPlan(r, "furnish:table", { bs: completeBs(), gatherWanted: true });
    expect(isLifeIdle(r.w, r.p, view, r.a)).toBe(true);
    fillLifeSensors(r.w, r.p, view, r.a);
    expect(view.lifeWant).toBeDefined();
  });
  it("the same bot on a shelter-core goal is NOT idle for life — the home build still wins", () => {
    const r = rig(); fed(r);
    for (const goal of ["axe", "campfire", "workbench", "base", "hearth", "bed", "defence", "cook", "wood"]) {
      const view = viewWithPlan(r, goal, { bs: completeBs(), gatherWanted: true });
      expect(isLifeIdle(r.w, r.p, view, r.a), goal).toBe(false);
    }
  });
  it("a comfort goal without a finished shelter is NOT idle — no deferring before the hut stands", () => {
    const r = rig(); fed(r);
    const view = viewWithPlan(r, "furnish:table", { gatherWanted: true }); // no bs at all
    expect(isLifeIdle(r.w, r.p, view, r.a)).toBe(false);
  });
  it("survival still wins on a comfort goal: hunger, cold, danger, travel and repair all block", () => {
    const cases: ((r: Rig, v: View) => void)[] = [
      (r) => { r.w.set(r.p, G.Survival, { hunger: 20, thirst: 100 }); },
      (_r, v) => { v.cold = true; },
      (_r, v) => { v.travel = { kind: "explore", x: 50, y: 50, since: 0, route: [{ x: 50, y: 50 }], leg: 0, origin: { x: 0, y: 0 } }; },
      (_r, v) => { v.repairTarget = { id: 1, x: 1, y: 1 }; },
      (_r, v) => { v.tripWanted = true; },
      (_r, v) => { v.buildPlan = { piece: 1, x: 1, y: 1 }; },
      (r) => { const z = spawnLearned(r.w, { x: 2, y: 0, maxWeight: 0, clientId: 9 }); r.a.memory.see({ id: z, kind: "zombie", x: 2, y: 0, tick: 0 }); },
    ];
    for (const setup of cases) {
      const r = rig(); fed(r);
      const v = viewWithPlan(r, "furnish:table", { bs: completeBs(), gatherWanted: true });
      setup(r, v);
      expect(isLifeIdle(r.w, r.p, v, r.a)).toBe(false);
    }
  });
  it("a pending hand-craft defers with a comfort goal but blocks a shelter-core goal", () => {
    const r = rig(); fed(r);
    const comfort = viewWithPlan(r, "furnish:table", { bs: completeBs(), gatherWanted: true });
    comfort.craftRecipe = 5; // a missing goal tool the bot could hand-craft right now (dry-run only)
    expect(isLifeIdle(r.w, r.p, comfort, r.a)).toBe(true);
    const core = viewWithPlan(r, "base", { bs: completeBs(), gatherWanted: true });
    core.craftRecipe = 5;
    expect(isLifeIdle(r.w, r.p, core, r.a)).toBe(false);
  });
  it("life_want scores above 0 on a comfort goal with a finished shelter (was: idle consideration 0)", () => {
    const r = rig(); fed(r);
    const view = viewWithPlan(r, "furnish:table", { bs: completeBs() });
    view.lifeWant = { id: "rest", kind: "rest", mood: "content", target: { x: 0, y: 0 } };
    const v = G.buildAgentSelf(r.w, r.p, r.a)!;
    const c = { self: v, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: view } as unknown as AgentContext<View>;
    const reg = G.survivorRegistry();
    expect(scoreBehavior(reg.get("life_want")!, c, undefined, [])).toBeGreaterThan(0);
    // ...and 0 on a shelter-core goal even with a want set (the sensor never sets one there)
    const busy = viewWithPlan(r, "base", { bs: completeBs() });
    busy.lifeWant = { id: "rest", kind: "rest", mood: "content", target: { x: 0, y: 0 } };
    const c2 = { ...c, world: busy } as unknown as AgentContext<View>;
    expect(scoreBehavior(reg.get("life_want")!, c2, undefined, [])).toBe(0);
  });
});

describe("ADR-445 repro: visit_water search", () => {
  it("finds water 40+ tiles from home (was: 24-tile radius, undefined)", () => {
    const r = rig();
    // a lake 40-60 tiles west of home, like the adr181 fake lake but out of the old reach
    r.w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= -60 && tx < -40 ? 1 : 3), heightAt: () => 0 });
    const at = nearestWaterTile(r.w, { x: 0, y: 0 });
    expect(at).toBeDefined();
    expect(Math.hypot(at!.x - 0, at!.y - 0)).toBeGreaterThan(24);
    expect(G.nearWater(r.w, at!.x, at!.y)).toBe(true);
  });
  it("still finds nothing on genuinely dry land (no false positives from the coarser scan)", () => {
    const r = rig();
    r.w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: () => 0 });
    expect(nearestWaterTile(r.w, { x: 0, y: 0 })).toBeUndefined();
  });
  it("seed-42 spawn has no water within the widened radius — the spawn region is dry (probe: none within 200 tiles), so visit_water still cannot fire there; the widening helps where water exists within 64 tiles (fake-lake test above)", () => {
    const r = rig(42);
    expect(nearestWaterTile(r.w, { x: 0, y: 0 })).toBeUndefined();
  });
});

describe("ADR-445 aspirations", () => {
  it("ai_life.json carries aspirations over the short wants, validated by lifeData()", () => {
    const d = lifeData();
    expect(d.aspirations.length).toBeGreaterThanOrEqual(4);
    const wantIds = new Set(d.wants.map((w) => w.id));
    for (const a of d.aspirations) {
      expect(wantIds.has(a.want), a.id).toBe(true);
      expect(a.targetCount).toBeGreaterThan(0);
      expect(a.weight).toBeGreaterThan(0);
    }
  });
  it("aspirationOf picks a deterministic aspiration per bot; completing its want advances it", () => {
    const r = rig();
    const st = lifeStateOf(r.a, 0);
    const asp = aspirationOf(r.a, st);
    expect(asp).toBeDefined();
    expect(aspirationOf(G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1), lifeStateOf(G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1), 0))?.id).toBe(asp!.id);
    for (let i = 0; i < asp!.targetCount; i++) completeWant(r.a, asp!.want, 100 + i);
    expect(st.aspirations[asp!.id]).toBeDefined();
    expect(st.aspirations[asp!.id]!.tick).toBe(100 + asp!.targetCount - 1);
    // the next aspiration is a different one (or none, if every aspiration is done)
    const next = aspirationOf(r.a, st);
    expect(next?.id).not.toBe(asp!.id);
  });
  it("the aspiration bonus is decisive: with it the aspiration want beats its rival, without it the rival wins", () => {
    // Slot-0 bot (owl, curiosity 0.46) with traits set so old_friend is the aspiration:
    // friend affinity = sociability 0.6, eater ties at greed 0.6 (friend first in data order),
    // gardener 0.53, traveller 0.47, homebody 0.5. Base scores: socialize 0.74 = eat 0.74
    // (eat first in wants order), rest 0.47 — the x1.5 aspiration bonus is the only thing
    // that puts socialize ahead; once the aspiration is complete it falls back behind eat.
    const r = rig(); fed(r);
    const t = r.a.identity.traits;
    t.sociability = 0.6; t.industriousness = 0.5; t.bravery = 0.5; t.greed = 0.6;
    const st = lifeStateOf(r.a, 0);
    expect(aspirationOf(r.a, st)?.id).toBe("old_friend");
    const p = personalityOf(r.a);
    G.addItem(r.w, r.p, G.gameplayDefs(r.w).itemId(p.favouriteFood), 2);
    const other = spawnLearned(r.w, { x: 3, y: 0, maxWeight: 0, clientId: 8 }); pid(r.w, other, 8); net(r.w, other);
    r.a.memory.see({ id: other, kind: "player", x: 3, y: 0, tick: 0 });
    const view = viewWithPlan(r, "idle", {});
    view.plan = { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] };
    const phase = lifeData().rhythms[p.rhythm].phases[0]!;
    const before = pickPersonalWant(r.a, r.w, view, { phase, tick: 100 });
    expect(before?.kind).toBe("socialize");
    expect(before?.aspiration).toBe("old_friend");
    for (let i = 0; i < 4; i++) completeWant(r.a, "socialize", 100 + i);
    expect(st.aspirations.old_friend).toBeDefined();
    // past the 12000-tick socialize cooldown (last completion tick 103), aspiration done:
    // eat wins now — the bonus has moved to hearty_eater, socialize is back to its base score
    const after = pickPersonalWant(r.a, r.w, view, { phase, tick: 12104 });
    expect(after?.kind).toBe("eat_favourite");
    expect(after?.aspiration).toBe("hearty_eater");
  });
  it("completed aspirations persist through flushAiLife like want progress", () => {
    const r = rig();
    const st = lifeStateOf(r.a, 0);
    const asp = aspirationOf(r.a, st)!;
    for (let i = 0; i < asp.targetCount; i++) completeWant(r.a, asp.want, 100 + i);
    const seen: { partial: { aiLife: ReturnType<typeof lifeStateOf> } }[] = [];
    expect(G.flushAiLife([r.a], (_id, partial) => { seen.push({ partial }); }, 500, true)).toEqual([r.a.identity.id]);
    const stored = JSON.parse(JSON.stringify(seen[0]!.partial.aiLife));
    const fresh = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
    (fresh.identity as unknown as { aiLife: unknown }).aiLife = stored;
    expect(lifeStateOf(fresh).aspirations[asp.id]).toBeDefined();
    expect(aspirationOf(fresh, lifeStateOf(fresh))?.id).not.toBe(asp.id);
  });
});

// ---- live test: an unhired bot with a finished home completes a want over many ticks ----
const BASE = { x: 10, y: 10 };
const d = G.defaultDefs();
const pidOf = (k: string) => d.pieceId(k);
const iid = (k: string) => d.itemId(k);
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
interface LiveRig extends Rig { home: { x: number; y: number } }
function liveRig(): LiveRig {
  const w = makeWorld({}, 42);
  installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  steps(w, 1);
  plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  a.bb.set("selfEntity", p);
  aiMemoryOf(a).base = { ...BASE };
  setSeason(w, 0, 0.2); // summer: no winter fuel pre-goal hijacking the plan
  setTimeOfDay(w, personalityOf(a).rhythm === "owl" ? 2 : 12);
  return { w, p, a, home: { x: BASE.x + 1, y: BASE.y + 1 } };
}
const givePiece = (r: LiveRig, key: string, tier = 0): void => {
  const def = d.pieces.get(pidOf(key))!;
  for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(r.w, r.p, c.item, c.count);
};
const put = (r: LiveRig, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }): boolean => {
  const def = d.pieces.get(pidOf(key))!;
  const t = tier ?? (def.tiered ? 0 : def.fixedTier);
  givePiece(r, key, t);
  r.w.set(r.p, Transform, stand ?? { x, y: y + 1.2 });
  const res = G.tryPlace(r.w, r.p, { piece: pidOf(key), x, y, level, rot, tier: t, variant: 0 });
  return res.ok;
};
/** Wear the torch the ladder wants (adr341 pattern). */
const wearTorch = (r: LiveRig): void => {
  const tid = iid("torch"); G.addItem(r.w, r.p, tid, 1);
  const sl = G.readSlots(r.w, r.p);
  const slot = sl.items.findIndex((it) => it === tid);
  expect(slot, "torch slot in the bag").toBeGreaterThanOrEqual(0);
  expect(G.wearSlot(r.w, r.p, slot), "wear the torch").toBe(true);
  G.refreshWorn(r.w, r.p);
};
/** Build the whole home for real, following the planner like the adr252 walk. */
function buildHome(r: LiveRig): void {
  for (const k of ["stone_axe", "stone_pickaxe"] as const) G.addItem(r.w, r.p, iid(k), 1);
  for (const [k, n] of [["wood", 200], ["stone", 100], ["planks", 100], ["sticks", 99], ["rope", 30], ["fiber", 50]] as const) G.addItem(r.w, r.p, iid(k), n);
  // Food stock in the bag (cooked_meat, NOT the slot-0 bot's favourite apple, so eat_favourite
  // stays unactionable and rest is the want under test). Without any food, noteTripWanted
  // flags a permanent expedition need (view.food undefined -> all foods join needs) and the
  // life gate correctly never opens — a homed bot with an empty pantry works, it does not play.
  G.addItem(r.w, r.p, iid("cooked_meat"), 5);
  wearTorch(r);
  for (let i = 0; i < 40; i++) {
    const bs = G.scanBase(r.w, d, BASE);
    if (bs.complete && bs.bed && bs.hearth && bs.storage && bs.stations.has(G.StationKind.Campfire) && bs.stations.has(G.StationKind.Workbench)) return;
    const pl = G.makePlan({ world: r.w, self: r.p, defs: d, base: BASE, bs, fails: {} });
    const s = pl.step;
    if (pl.goal === "idle") return; // nothing left the planner can do here
    if (!s) {
      if (pl.leaves.length) { for (const id of pl.leaves) G.addItem(r.w, r.p, id, 50); steps(r.w, 25); continue; }
      return; // stuck goal with no step and no leaves: nothing to place
    }
    if (s.k === "build") {
      r.w.set(r.p, Transform, { x: s.stand.x, y: s.stand.y });
      const def = d.pieces.get(s.piece)!;
      givePiece(r, def.key, s.tier ?? 0);
      expect(G.tryPlace(r.w, r.p, { piece: s.piece, x: s.x, y: s.y, level: s.level, rot: s.rot ?? 0, tier: s.tier ?? 0, variant: 0 }).ok, `place ${def.key} for ${pl.goal}`).toBe(true);
      steps(r.w, 25);
    } else if (s.k === "wear") {
      expect(G.wearSlot(r.w, r.p, s.invSlot)).toBe(true);
      G.refreshWorn(r.w, r.p);
      steps(r.w, 5);
    } else if (s.k === "craft") {
      // hand the bot the craft output's ingredients are already in the bag; run the craft action once
      const recipe = d.recipes.get(s.recipe)!;
      for (const ing of recipe.ingredients) G.addItem(r.w, r.p, ing.item, ing.count);
      G.addItem(r.w, r.p, recipe.output.item, recipe.output.count);
      steps(r.w, 5);
    } else {
      // withdraw / terrain / light / clear / ramp / upgrade: hand the bot what it needs and move on
      if (s.k === "withdraw") G.addItem(r.w, r.p, s.item, s.count);
      steps(r.w, 5);
    }
  }
  const bs = G.scanBase(r.w, d, BASE);
  expect(bs.complete, "home complete after build walk").toBe(true);
}
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const applyMove = (r: LiveRig, o: AgentOutput): void => {
  let bits = 0;
  const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) {
    if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft;
    if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp;
  }
  G.applyMovementInput(r.w, r.p, bits, DT);
};

describe("ADR-445 live: an unhired homed bot completes a want over many ticks", () => {
  it("the bot pursues a want while its plan sits on a comfort goal, and completes one", () => {
    const r = liveRig();
    buildHome(r);
    // the planner must now sit on a post-shelter goal, not on the home build
    const first = G.buildAgentView(r.w, r.p, r.a, r.home)!;
    expect(isComfortGoal(first.world.plan?.goal ?? ""), `plan goal after build: ${first.world.plan?.goal}`).toBe(true);
    expect(G.scanBase(r.w, d, BASE).complete).toBe(true);
    const st = lifeStateOf(r.a, 0);
    const totalCompleted = (): number => Object.values(st.completed).reduce((n, c) => n + c.count, 0);
    const before = totalCompleted();
    let sawWantOnComfortGoal = false;
    let sawWantKind: string | undefined;
    const beh = lifeBehaviors()[0]!;
    for (let t = 0; t < 1200 && totalCompleted() === before; t++) {
      const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
      if (v.world.lifeWant && isComfortGoal(v.world.plan?.goal ?? "")) { sawWantOnComfortGoal = true; sawWantKind = v.world.lifeWant.kind; }
      const c = { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world } as unknown as AgentContext<View>;
      const o = out();
      beh.run(c, o);
      applyMove(r, o);
      r.w.step(DT);
      fed(r);
    }
    expect(sawWantOnComfortGoal, `never saw a want on a comfort goal (last kind: ${sawWantKind})`).toBe(true);
    expect(totalCompleted()).toBeGreaterThan(before);
    // the home build was not starved: the hut still stands complete at the end
    expect(G.scanBase(r.w, d, BASE).complete).toBe(true);
    expect(G.scanBase(r.w, d, BASE).bed).toBeDefined();
  });
});
