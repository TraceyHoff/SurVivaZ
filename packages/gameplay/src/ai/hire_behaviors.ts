import { type Agent } from "@engine/core";
import { aiMemoryOf, makePlan, markAiDirty } from "./planner.js";
import { planTerrainBase } from "./terrain_base.js";
/**
 * Task 22 hired-worker behavior: a recruited AI human is a bot whose owner is a player and whose behavior is
 * driven by its assigned job. `fillHireSensors` (called from buildAgentView after fillGoalSensors) re-anchors the
 * bot on the owner's base and clears the bot's own base plan — a hired bot stops building its own campfire, stops
 * planning trips, and works the owner's base instead. Survival basics (eat / drink / flee / sleep / greet) stay
 * active: a hired worker still eats, still runs from zombies, still sleeps at the owner's base.
 *
 * Jobs (WorkerJob):
 *  - Gather   — no new behavior: the existing gather + stash behaviors, with the owner's base as home/storage.
 *  - Defend   — work_defend: hold the anchor, attack zombies near it (claim hostiles first, else any zombie
 *    within 12 tiles of the anchor). Zombies only; the bot never chases a player.
 *  - Farm     — work_farm: harvest mature crop nodes near the anchor (gather), water thirsty crops and plant
 *    seeds on tilled soil (Use on the watering-can / seed slot). Task 23: till new soil too — with seeds and a
 *    hoe (withdrawn from the owner's storage if the worker carries none), till the nearest open tile, only while
 *    every tilled plot can still be planted (empty soil < seeds carried).
 *  - Craft    — work_craft: craft the next unowned goal tool (stone_axe -> stone_pickaxe -> stone_spear, the same
 *    Task 16 purpose gate) by hand at the owner's base; output is stashed by the existing stash behavior.
 *  - Maintain — work_maintain: repair the most damaged piece near the anchor (scanBase's repair target), withdrawing
 *    the missing materials from the owner's storage first. Only when the materials are carried or stored.
 *  - idle     — work_hold: a hired bot with no job target stays near the anchor instead of wandering off.
 */
import { Transform, evalCurve, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { BuildPiece, Crop, Dead, Health, ResourceNode, Survival, Worker, WorkerJob, WorkerOrder, Worn, Zombie } from "../components.js";
import { MOUNT_BOTS } from "../mount_defs.js";
import { GameplayConfig } from "../config.js";
import { countItem, exchangeItems, readSlots } from "../inventory.js";
import { pieceCost, tribeOf } from "../building/place.js";
import { maxHpOf } from "../building/integrity.js";
import { FARMING, FARM_TOOL, FarmFail, plantableBySeed, till } from "../farming.js";
import { GOAL_CRAFTS, instantChores, stuckOn } from "./autonomy.js";
import { crafterIdFor } from "../economy/provenance.js";
import { containerSeq, goTo, storageTargetFor } from "./base_behaviors.js";
import { storageWithdrawActions } from "./storage_api.js";
import { scanBase } from "./planner.js";
import { nearestClaimHostile } from "../territory.js";
import { workerAnchor, workerWorkAnchor, workerOrderTarget, workerSelections, workerRecipes } from "../recruitment.js";
import { playerEntity } from "../pets.js";
import { UseCmd } from "../input.js";
import { StationKind, type GameDefs } from "../defs.js";
import type { AgentOutputWithCommands } from "./agent_output.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";

type Ctx = AgentContext<AgentWorldView>;
type Out = { moveX: number; moveY: number; aimX: number; aimY: number; actions: string[] };
const toward = (o: Out, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };
const cooled = (c: Ctx, k: string, n: number): boolean => c.self.tick - c.bb.num(k, -1e9) >= n;
const step01 = { type: "step" as const, at: 0.5 };
const FARM_R = 12, DEFEND_R = 12;
/** Task 23: nearest tile centre near `anchor` the bot may till (dry run): rings out to FARM_R, scan capped so a
 * bot with no open ground does not burn the sensor tick. Tile centres sit at floor + 0.5. */
function nearestTillSpot(world: World, self: Entity, anchor: { x: number; y: number }): { x: number; y: number } | undefined {
  const cx = Math.floor(anchor.x), cy = Math.floor(anchor.y);
  let checked = 0;
  for (let r = 0; r <= FARM_R && checked < 60; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (++checked > 60) return undefined;
      const x = cx + dx + 0.5, y = cy + dy + 0.5;
      if (till(world, self, x, y, true) === FarmFail.None) return { x, y };
    }
  }
  return undefined;
}

/** First unowned goal tool whose hand recipe is affordable with room for the output (Task 16 room gate). */
export function hireCraftPick(world: World, self: Entity, defs: GameDefs): number | undefined {
  const selected = workerSelections(world, self);
  if (selected.length) {
    const cursor = world.getField(self, WorkerOrder, "craftCursor") ?? 0;
    const allowed = new Set(workerRecipes(world, self).map((r) => r.id));
    for (let i = 0; i < selected.length; i++) {
      const r = defs.recipes.get(selected[(cursor + i) % selected.length]!);
      if (!r || !allowed.has(r.id) || countItem(world, self, r.output.item) > 0) continue;
      if (exchangeItems(world, self, r.ingredients, [r.output], true, crafterIdFor(world, self, r.output.item))) return r.id;
    }
    return undefined;
  }
  for (const key of GOAL_CRAFTS) {
    const item = [...defs.items.values()].find((d) => d.key === key); if (!item || countItem(world, self, item.id) > 0) continue;
    const r = [...defs.recipes.values()].find((x) => x.output.item === item.id && x.station === StationKind.None); if (!r) continue;
    if (exchangeItems(world, self, r.ingredients, [r.output], true, crafterIdFor(world, self, r.output.item))) return r.id;
  }
  return undefined;
}

/**
 * Hired-worker sensors. Runs after fillGoalSensors, so it overrides what the planner computed for the bot's own
 * base: home/base/bs become the owner's, the plan is dropped, and surplus is recomputed against the owner's
 * storage. A bot that is not hired (owner 0) is left exactly as the planner left it.
 * ADR-327: the one exception to dropping the plan is an idle hired worker's saddle-material chain (see the
 * block at the end of this function): its plan is built here, on the employer's base scan.
 */
/** Task 28 (was the hired-Farm sensor; now shared): harvest / water / plant / till around `anchor`. Returns
 * undefined when there is nothing to do. Unhired bots garden their own base with the same sensor. */
export function computeFarmSensor(world: World, self: Entity, defs: GameDefs, anchor: { x: number; y: number }, bs: ReturnType<typeof scanBase>, target?: Entity): AgentWorldView["farm"] {
  let slots: ReturnType<typeof readSlots> | undefined; try { slots = readSlots(world, self); } catch { slots = undefined; }
  const canSlot = slots ? slots.items.findIndex((it, i) => it && slots.counts[i] && defs.items.get(it)?.key === FARM_TOOL.wateringCan) : -1;
  const seedSlot = slots ? slots.items.findIndex((it, i) => it && slots.counts[i] && plantableBySeed(defs.items.get(it)?.key ?? "") > 0) : -1;
  const hoeId = [...defs.items.values()].find((d) => d.key === FARM_TOOL.hoe)?.id ?? 0;
  const hoeSlot = hoeId && slots ? slots.items.findIndex((it, i) => it === hoeId && slots.counts[i]) : -1;
  const seedItem = seedSlot >= 0 ? slots!.items[seedSlot]! : 0;
  const seedCount = seedItem ? countItem(world, self, seedItem) : 0;
  const cropKeys = new Set(FARMING.plantables.map((p) => p.becomes));
  let harvest: { id: number; x: number; y: number } | undefined; let hd = Infinity;
  let water: { id: number; x: number; y: number; slot: number; kind: "water" } | undefined; let wd = Infinity;
  let soil: { id: number; x: number; y: number; slot: number; kind: "plant" } | undefined; let sd = Infinity;
  let emptySoil = 0;
  for (const e of installSpatialIndex(world).queryRadius(anchor.x, anchor.y, FARM_R)) {
    if (target !== undefined && e !== target) continue;
    const t = world.get(e, Transform); if (!t) continue; const d = (t.x - anchor.x) ** 2 + (t.y - anchor.y) ** 2;
    if (world.has(e, ResourceNode) && (world.getField(e, ResourceNode, "amount") ?? 0) > 0) {
      const key = defs.resources.get(world.getField(e, ResourceNode, "kind")!)?.key;
      if (key && cropKeys.has(key) && d < hd) { hd = d; harvest = { id: e, x: t.x, y: t.y }; }
    } else if (world.has(e, Crop)) {
      const c = world.get(e, Crop)!;
      if (c.kind === 0) { emptySoil++; if (seedSlot >= 0 && d < sd) { sd = d; soil = { id: e, x: t.x, y: t.y, slot: seedSlot, kind: "plant" }; } }
      else if (c.kind > 0 && c.growth < 1 && c.waterUntilTick <= world.tick && canSlot >= 0 && d < wd) { wd = d; water = { id: e, x: t.x, y: t.y, slot: canSlot, kind: "water" }; }
    }
  }
  // Task 23: till new soil when the worker has seeds — planting existing soil comes first, and only while every
  // tilled plot can still be planted (empty soil < seeds carried), so the field never outgrows the seed stock.
  let tillTarget: { x: number; y: number; slot: number; lack?: { item: number; count: number } } | undefined;
  if (target === undefined && seedSlot >= 0 && !soil && emptySoil < seedCount && (hoeSlot >= 0 || (hoeId && (bs?.storage?.counts?.get(hoeId) ?? 0) > 0))) {
    const spot = nearestTillSpot(world, self, anchor);
    if (spot) {
      if (hoeSlot >= 0) tillTarget = { ...spot, slot: hoeSlot };
      else tillTarget = { ...spot, slot: -1, lack: { item: hoeId, count: 1 } }; // hoe is in base storage: fetch it first
    }
  }
  if (harvest || water || soil || tillTarget) return { ...(harvest ? { harvest } : {}), ...(water ?? soil ? { tend: water ?? soil! } : {}), ...(tillTarget ? { till: tillTarget } : {}) };
  return undefined;
}

/** ADR-327: pending employer job work for a hired worker, from the hire sensors just set. `saddleLeaves` =
 *  the leaves / hunt of the saddle plan being considered: a gather node wanted only for those is the saddle
 *  chain itself, not job work. A Follow worker always has pending work (its duty is proximity: any saddle
 *  trip would abandon the owner), so it never runs the chain. `view.plan` here is a Maintain shelter / earth
 *  plan or nothing — a saddle plan never sits there, it is built after this check. */
function hireWorkPending(world: World, self: Entity, view: AgentWorldView, defs: GameDefs, saddleLeaves?: ReadonlySet<number>): boolean {
  const job = view.hire?.job;
  if (job === WorkerJob.Follow) return true;
  if (view.defend !== undefined || view.farm !== undefined || view.repair !== undefined) return true;
  if (view.craftRecipe !== undefined || view.hire?.supply !== undefined) return true;
  const p = view.plan;
  if (p && (p.step !== undefined || p.leaves.length > 0 || p.hunt.length > 0)) return true;
  const gn = view.gatherNode;
  if (gn?.wanted && (job === WorkerJob.Gather || job === WorkerJob.Craft)) {
    const kind = world.getField(gn.id as Entity, ResourceNode, "kind");
    const yields = kind === undefined ? [] : (defs.resources.get(kind)?.yields.map((y) => y.item) ?? []);
    if (yields.some((item) => !(saddleLeaves?.has(item) ?? false))) return true; // yields a job / food item (or an unknown node): job work
  }
  return false;
}
/** ADR-327: survival needs met for the saddle chain — the same danger thresholds ADR-323 abandons on
 *  (mount_behaviors needsLow: hp < minHp, hunger / thirst < 30, zombie within safeTiles). Kept as a twin
 *  here because hire_behaviors cannot import mount_behaviors (import cycle via autonomy). */
function hireSaddleNeedsMet(world: World, self: Entity, agent: Agent): boolean {
  const hp = world.get(self, Health); const frac = hp ? hp.hp / Math.max(1, hp.max) : 1;
  if (frac < MOUNT_BOTS.minHp) return false;
  const sv = world.get(self, Survival); if (sv && (sv.hunger < 30 || sv.thirst < 30)) return false;
  const t = world.get(self, Transform); if (!t) return false;
  const z = agent.memory.nearest("zombie", t.x, t.y, 0.3);
  return !(z && Math.hypot(t.x - z.x, t.y - z.y) < MOUNT_BOTS.safeTiles);
}
/** ADR-327: may this hired worker run the saddle chain right now (low priority: no job work, needs met)? */
function hireSaddleIdle(world: World, self: Entity, view: AgentWorldView, agent: Agent, defs: GameDefs, saddleLeaves?: ReadonlySet<number>): boolean {
  return !hireWorkPending(world, self, view, defs, saddleLeaves) && hireSaddleNeedsMet(world, self, agent);
}

export function fillHireSensors(world: World, self: Entity, view: AgentWorldView, agent?: Agent): void {
  if (!world.has(self, Worker)) return;
  const w = world.get(self, Worker)!;
  const cfg = world.getResource(GameplayConfig); if (!cfg) return; const defs = cfg.defs;
  if (w.owner === 0) {
    // Task 28: unhired bots garden their own base (the same farm sensor as a hired Farm worker, anchored on
    // their own base from fillPlanSensors) — till, plant, water and harvest for winter stores and themselves.
    const base = view.base, bs = view.bs;
    if (base && bs) { const f = computeFarmSensor(world, self, defs, base, bs); if (f) view.farm = f; else delete view.farm; }
    return;
  }
  const anchor = workerWorkAnchor(world, self);
  const base = workerAnchor(world, self); // work/follow anchor is not the deposit-storage anchor
  const target = workerOrderTarget(world, self);
  const hasTarget = world.getField(self, WorkerOrder, "kind") === 2;
  delete view.defend; delete view.farm; delete view.repair;
  view.hire = { job: w.job, owner: w.owner, ax: anchor.x, ay: anchor.y };
  view.home = anchor; view.base = base;
  const bs = scanBase(world, defs, base); view.bs = bs;
  delete view.plan; delete view.needs; delete view.tripWanted; delete view.buildPlan;
  if (w.job === WorkerJob.Follow) { delete view.craftRecipe; delete view.surplus; }
  // surplus vs the owner's storage (selected craft outputs may include tools)
  if (w.job !== WorkerJob.Follow && bs?.storage && bs.storage.free > 0) {
    let slots: ReturnType<typeof readSlots> | undefined; try { slots = readSlots(world, self); } catch { slots = undefined; }
    if (slots) {
      const worn = new Set<number>(); const wi = world.getArray(self, Worn, "item"); if (wi) for (const x of wi) if (x) worn.add(x);
      const wood = [...defs.items.values()].find((d) => d.key === "wood")?.id;
      const tot = new Map<number, number>(); for (let i = 0; i < slots.items.length; i++) { const it = slots.items[i]!; if (it && slots.counts[i]) tot.set(it, (tot.get(it) ?? 0) + slots.counts[i]!); }
      const outputs = new Set(w.job === WorkerJob.Craft ? workerSelections(world, self).map((id) => defs.recipes.get(id)?.output.item ?? 0) : []);
      const sur: { item: number; count: number }[] = [];
      for (const [it, n] of tot) { const d = defs.items.get(it); if (!d || worn.has(it)) continue;
        if (outputs.has(it)) { sur.push({ item: it, count: n }); continue; }
        if (d.tool || d.weapon || d.wear) continue;
        const keep = it === wood ? 12 : d.food && d.food.health >= 0 ? 6 : 0; if (n > keep) sur.push({ item: it, count: n - keep }); }
      if (sur.length) view.surplus = sur;
    }
  }
  if (w.job === WorkerJob.Defend || w.job === WorkerJob.Follow) {
    const owner = playerEntity(world, w.owner); const tribe = owner ? tribeOf(world, owner) : 0;
    let best: { id: number; x: number; y: number } | undefined;
    const claimed = tribe ? nearestClaimHostile(world, anchor.x, anchor.y, DEFEND_R, tribe) : undefined;
    if (claimed !== undefined) { const t = world.get(claimed, Transform)!; best = { id: claimed, x: t.x, y: t.y }; }
    else { let bd = DEFEND_R * DEFEND_R;
      for (const z of installSpatialIndex(world).queryRadius(anchor.x, anchor.y, DEFEND_R)) {
        if (!world.has(z, Zombie) || world.has(z, Dead)) continue; const t = world.get(z, Transform); if (!t) continue;
        const d = (t.x - anchor.x) ** 2 + (t.y - anchor.y) ** 2; if (d < bd) { bd = d; best = { id: z, x: t.x, y: t.y }; }
      }
    }
    if (best) view.defend = best;
  }
  if (w.job === WorkerJob.Farm) { const f = hasTarget && target === undefined ? undefined : computeFarmSensor(world, self, defs, anchor, bs, target); if (f) view.farm = f; else delete view.farm; }
  if (w.job === WorkerJob.Maintain && agent && !hasTarget) {
    // Maintain an explicitly anchored NEW shelter only. Never terraform an existing owner's floor.
    const mem = aiMemoryOf(agent);
    if (mem.hireEarth && ((mem.hireEarth.anchor?.x ?? mem.hireEarth.x) !== Math.floor(base.x) || (mem.hireEarth.anchor?.y ?? mem.hireEarth.y) !== Math.floor(base.y))) delete mem.hireEarth;
    if (!mem.hireEarth && !bs.pieces.size) {
      for (const [dx, dy] of [[0, 0], [2, 2], [-3, 2], [2, -3]]) {
        const earth = planTerrainBase(world, self, { x: Math.floor(base.x) + dx!, y: Math.floor(base.y) + dy! }, (self & 1) ? "pit" : "pad");
        if (earth) { earth.anchor = { x: Math.floor(base.x), y: Math.floor(base.y) }; mem.hireEarth = earth; break; }
      }
    }
    if (mem.hireEarth && !mem.hireEarth.abandoned) {
      const earthBase = { x: mem.hireEarth.x, y: mem.hireEarth.y };
      const earthScan = scanBase(world, defs, earthBase);
      view.base = earthBase; view.bs = { ...earthScan, ...(earthScan.storage ? {} : bs.storage ? { storage: bs.storage } : {}) };
      view.plan = makePlan({ world, self, defs, base: earthBase, bs: view.bs, fails: mem.fails, earth: mem.hireEarth, shelterOnly: true });
      view.needs = view.plan.leaves;
      // Preserve Soil / planned materials, but let ordinary surplus stashing free
      // addable slots when earthworks pause on a full pack (wood keeps its 12 stock).
      if (view.surplus) {
        const keep = view.plan.keep;
        view.surplus = view.surplus.filter(({ item }) => defs.items.get(item)?.key === "wood" || !keep.has(item));
        if (!view.surplus.length) delete view.surplus;
      }
      const step = view.plan.step;
      if (step?.k === "craft" && step.station === StationKind.None) { view.craftRecipe = step.recipe; view.craftCount = step.count; view.craftTicks = step.ticks; }
      markAiDirty(agent, world.tick);
    }
  }
  if (w.job === WorkerJob.Maintain) {
    const rep = hasTarget ? target : scanBase(world, defs, anchor)?.repair;
    if (rep !== undefined) {
      const def = defs.pieces.get(world.getField(rep, BuildPiece, "type") ?? 0); const t = world.get(rep, Transform);
      if (def && t && (world.getField(rep, BuildPiece, "hp") ?? 0) < maxHpOf(world, rep)) {
        const tier = world.getField(rep, BuildPiece, "tier") ?? 0;
        const missing = 1 - (world.getField(rep, BuildPiece, "hp") ?? 0) / Math.max(1, maxHpOf(world, rep));
        const mul = defs.tiers[tier]?.repairMul ?? 0.3;
        const cost = pieceCost(defs, def, tier, mul * missing).map((c) => ({ item: c.item, count: Math.max(1, Math.ceil(c.count)) }));
        // only a repair the bot can actually do: every material carried, or in the owner's storage
        const storage = bs?.storage?.counts;
        let ok = true; let lack: { item: number; count: number } | undefined;
        for (const c of cost) { const have = countItem(world, self, c.item); if (have >= c.count) continue;
          const short = c.count - have; if ((storage?.get(c.item) ?? 0) < short) { ok = false; break; } lack ??= { item: c.item, count: short }; }
        if (ok) view.repair = { id: rep, x: t.x, y: t.y, ...(lack ? { lack } : {}) };
      }
    }
  }
  if (w.job === WorkerJob.Craft) {
    const r = hireCraftPick(world, self, defs); if (r !== undefined) view.craftRecipe = r;
    else {
      delete view.craftRecipe;
      const selected = workerSelections(world, self), cursor = world.getField(self, WorkerOrder, "craftCursor") ?? 0;
      const allowed = new Set(workerRecipes(world, self).map((r) => r.id));
      for (let i = 0; i < selected.length && !view.hire.supply; i++) {
        const recipe = defs.recipes.get(selected[(cursor + i) % selected.length]!); if (!recipe || !allowed.has(recipe.id) || countItem(world, self, recipe.output.item) > 0) continue;
        for (const g of recipe.ingredients) {
          const missing = g.count - countItem(world, self, g.item), stored = bs?.storage?.counts.get(g.item) ?? 0;
          if (missing > 0 && stored > 0) { view.hire.supply = { item: g.item, count: Math.min(missing, stored) }; break; }
        }
      }
    }
  }
  // ADR-327: the saddle-material chain for an idle hired worker (LOW priority: only when hireSaddleIdle
  // says no job work is pending and needs are met). The plan is built here, on the EMPLOYER's base scan
  // (view.base / view.bs were re-anchored above), so withdraw / craft / gather all read the employer's
  // stations and storage — the planner never sees the worker's own base, and storage access still goes
  // through mayTakeFromStorage (own / employer / clan only). view.hire.idle is the flag saddleGoalPass
  // (mount_behaviors, which runs after this in buildAgentView) reads when picking a new tier.
  if (agent) {
    const sg = agent.bb.get<{ key: string } | null>("saddleGoal");
    let saddlePlan: ReturnType<typeof makePlan> | undefined;
    if (sg && view.base && view.bs) {
      saddlePlan = makePlan({ world, self, defs, base: view.base, bs: view.bs, fails: aiMemoryOf(agent).fails, priority: [{ key: sg.key, count: 1 }], onlyPriority: true, maxDepth: MOUNT_BOTS.planMaxDepth });
    }
    const idle = hireSaddleIdle(world, self, view, agent, defs, saddlePlan ? new Set([...saddlePlan.leaves, ...saddlePlan.hunt]) : undefined);
    view.hire.idle = idle;
    if (idle && saddlePlan && saddlePlan.goal !== "idle") {
      view.plan = saddlePlan; view.needs = [...saddlePlan.leaves, ...saddlePlan.hunt];
      const step = saddlePlan.step;
      if (step?.k === "craft" && step.station === StationKind.None) { view.craftRecipe = step.recipe; view.craftCount = step.count; view.craftTicks = step.ticks; }
    }
  }
}

/** Follow is a duty, not a suggestion to the social/building scheduler. Do not let a scheduled
 * night sleep or a greeting beat catching up, guarding, or a concrete survival trip. Other jobs are unchanged. */
export function withHireDuty(b: GameBehavior): GameBehavior {
  if (b.name.startsWith("work_") || ["flee", "eat", "drink", "drink_water", "warm_up", "cool_down", "seek_shelter"].includes(b.name)) return b;
  const [first, ...rest] = b.considerations; if (!first) return b;
  // Preserve the consideration count/weight: adding a neutral factor would change core's compensation
  // and unintentionally rescore every unhired bot. Pre-evaluate just the first curve, or gate it to zero.
  return { ...b, considerations: [{ ...first, curve: { type: "linear", m: 1, b: 0 }, input: (c) => {
    const h = c.world.hire;
    if (h?.job === WorkerJob.Follow) {
      const catchingUp = c.self.hunger >= 0.55 && c.self.thirst >= 0.55 && Math.hypot(h.ax - c.self.x, h.ay - c.self.y) > 3;
      const foodTrip = c.self.hunger < 0.55 && c.world.food === undefined && c.world.gatherNode !== undefined;
      const waterTrip = c.self.thirst < 0.55 && c.world.water === undefined && c.world.waterAt !== undefined;
      if (catchingUp || foodTrip || waterTrip || c.world.defend) return 0;
    }
    return evalCurve(first.curve, first.input(c));
  } }, ...rest] };
}

/** Hired-worker behaviors (registered in survivorRegistry; unhired bots never see view.hire, so these score 0). */
/** The farm run shared by hired Farm workers and unhired gardeners (Task 28): till (harvest / tending first),
 * then harvest mature crop nodes or water / plant with the Use command on the slot's item. */
function farmRun(c: Ctx, o: AgentOutput): boolean | void { const f = c.world.farm; if (!f) return false;
  if (f.till && !f.harvest && !f.tend) { // till new soil (harvest / tending come first)
    const t = f.till;
    if (t.lack) { const sb = storageTargetFor(c, t.lack.item, true); if (!sb) return false; // ADR-355: fetch the hoe from the store that holds it first (a matching store, else the base box)
      if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) return false; return; } stop(o);
      if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, t.lack.item, t.lack.count))) return false; return; }
    if (goTo(c, o, t.x, t.y) > 0.9) { if (stuckOn(c, t.x, t.y)) return false; return; } stop(o);
    // Use the hoe on the tile in front (farmUseSystem tills it); the sensor plants a seed there next tick
    if (cooled(c, "farmTillAt", 20)) { const oc = o as unknown as AgentOutputWithCommands; (oc.commands ??= []).push({ type: UseCmd.name, payload: { slot: t.slot } }); c.bb.set("farmTillAt", c.self.tick); }
    return false; }
  const target = f.harvest ?? f.tend; if (!target) return false;
  if (goTo(c, o, target.x, target.y) > 1.2) { if (stuckOn(c, target.x, target.y)) return false; return; } stop(o);
  if (f.harvest) { o.actions.push("gather"); return false; } // mature crop node: gather it like any node
  const t = f.tend!; // water a thirsty crop / plant a seed on tilled soil (Use on the slot's item)
  if (cooled(c, "farmUseAt", 20)) { const oc = o as unknown as AgentOutputWithCommands; (oc.commands ??= []).push({ type: UseCmd.name, payload: { slot: t.slot } }); c.bb.set("farmUseAt", c.self.tick); }
  return false; }

export function hireBehaviors(): GameBehavior[] {
  const survivalBreak = (c: Ctx): boolean => c.self.hunger < 0.55 || c.self.thirst < 0.55;
  const hiredJob = (job: WorkerJob) => (c: Ctx): number => (c.world.hire?.job === job ? 1 : 0);
  return [
    { name: "work_defend", inertia: 0.5, traits: { bravery: 0.6 }, considerations: [
        { name: "job", curve: step01, input: (c) => ([WorkerJob.Defend, WorkerJob.Follow].includes(c.world.hire?.job ?? 0) ? 1 : 0) },
        { name: "hostile", curve: step01, input: (c) => (c.world.defend ? 1 : 0) }],
      run: (c, o) => { instantChores(c, o); const h = c.world.hire; if (!h) return false; const d = c.world.defend;
        if (!d) { if (Math.hypot(h.ax - c.self.x, h.ay - c.self.y) > 3) goTo(c, o, h.ax, h.ay); else stop(o); return false; }
        const dist = toward(o, c.self.x, c.self.y, d.x, d.y, 1); o.sprint = dist > 4 && c.self.stamina > 0.4; // urgency/stance hint only; shared movement owns on-foot auto-sprint (ADR-289)
        if (dist < 1.4) { stop(o); if (cooled(c, "hitAt", 10)) { o.actions.push(`attack:${d.id}`); c.bb.set("hitAt", c.self.tick); } } } },
    { name: "work_farm", inertia: 0.5, traits: { industriousness: 0.8 }, considerations: [
        { name: "job", curve: step01, input: hiredJob(WorkerJob.Farm) },
        { name: "target", curve: step01, input: (c) => (c.world.farm ? 1 : 0) }],
      run: farmRun },
    { name: "garden", inertia: 0.1, traits: { industriousness: 0.3 }, considerations: [
        // Task 28: gardening is background work for an unhired bot — it never outranks the ladder. A wild
        // berry bush near the base is a permanent harvest target (it regrows), so an ungated garden starves
        // the home build: the bot harvests instead of gathering foundation materials or building. Garden
        // only fills idle gaps (no plan step, no wanted gathering trip), e.g. blocked/snoozed goals or the
        // endgame — the home comes first, the garden second.
        { name: "plot", curve: step01, input: (c) => (c.world.farm && !c.world.hire && !c.world.plan?.step && !c.world.tripWanted ? 1 : 0) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: farmRun },
    { name: "work_maintain", inertia: 0.5, traits: { industriousness: 0.8 }, considerations: [
        { name: "job", curve: step01, input: hiredJob(WorkerJob.Maintain) },
        { name: "repair", curve: step01, input: (c) => (c.world.repair ? 1 : 0) }],
      run: (c, o) => { const r = c.world.repair; if (!r) return false;
        if (r.lack) { const sb = storageTargetFor(c, r.lack.item, true); if (!sb) return false; // ADR-355: fetch the missing material from the store that holds it first
          if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) return false; return; } stop(o);
          if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, r.lack.item, r.lack.count))) return false; return; }
        if (goTo(c, o, r.x, r.y) > 1.7) { if (stuckOn(c, r.x, r.y)) return false; return; } stop(o);
        if (cooled(c, "repairAt", 20)) { o.actions.push(`repair:${r.id}`); c.bb.set("repairAt", c.self.tick); } } },
    { name: "work_craft", inertia: 0.5, traits: { industriousness: 0.8 }, considerations: [
        { name: "job", curve: step01, input: hiredJob(WorkerJob.Craft) },
        { name: "recipe", curve: step01, input: (c) => (c.world.craftRecipe !== undefined || c.world.hire?.supply ? 1 : 0) }],
      run: (c, o) => { const h = c.world.hire; if (!h) return false;
        if (h.supply) { const sb = storageTargetFor(c, h.supply.item, true); if (!sb) return false; // ADR-355: fetch the supply from the store that holds it first
          if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) return false; return; } stop(o);
          if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, h.supply.item, h.supply.count))) return false; return; }
        if (c.world.craftRecipe === undefined) return false;
        if (goTo(c, o, h.ax, h.ay) > 3) return; stop(o); // hand recipes: craft at the base, stash via the stash behavior
        if (cooled(c, "craftedAt", 200)) { o.actions.push(`craft:${c.world.craftRecipe}`); c.bb.set("craftedAt", c.self.tick); } return false; } },
    { name: "work_forage", inertia: 0.1, considerations: [
        { name: "following", curve: step01, input: hiredJob(WorkerJob.Follow) },
        { name: "hungry", curve: step01, input: (c) => c.self.hunger < 0.55 && c.world.food === undefined && c.world.gatherNode && !c.world.defend ? 1 : 0 }],
      run: (c, o) => { instantChores(c, o); const n = c.world.gatherNode; if (!n) return false;
        if (goTo(c, o, n.x, n.y) > 1.2) { if (stuckOn(c, n.x, n.y)) return false; return; }
        stop(o); o.actions.push("gather"); return false; } },
    { name: "work_follow", inertia: 0.1, considerations: [
        { name: "following", curve: step01, input: hiredJob(WorkerJob.Follow) },
        { name: "fed", curve: step01, input: (c) => survivalBreak(c) ? 0 : 1 }],
      run: (c, o) => { instantChores(c, o); const h = c.world.hire; if (!h) return false;
        if (Math.hypot(h.ax - c.self.x, h.ay - c.self.y) > 2.5) goTo(c, o, h.ax, h.ay); else stop(o); return false; } },
    { name: "work_hold", inertia: 0.3, considerations: [
        { name: "hired", curve: { type: "linear", m: 0.45, b: 0 }, input: (c) => (c.world.hire && !(c.world.hire.job === WorkerJob.Follow && survivalBreak(c)) ? 1 : 0) }],
      run: (c, o) => { instantChores(c, o); const h = c.world.hire; if (!h) return false;
        if (Math.hypot(h.ax - c.self.x, h.ay - c.self.y) > 4) { goTo(c, o, h.ax, h.ay); return; } stop(o); return false; } },
  ];
}
