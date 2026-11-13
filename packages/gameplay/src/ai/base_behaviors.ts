import { MOUNT_BOTS } from "../mount_defs.js";
import { isUnderground } from "../terrain_depth.js";
import { walkerWaypoint } from "../systems/creature_nav.js";
import { planTerrainBase } from "./terrain_base.js";
/**
 * ADR-252: base life for AI humans, driven by the planner (planner.ts). Every behaviour here only moves the bot and
 * emits the action strings a human client sends (craft / build / copen / cdeposit / cwithdraw / cclose / fire / door /
 * wear / attack / gather); the server validates reach, stations, recipes, costs and placement exactly as for players.
 *  - base_work: the planner's step (withdraw from storage, craft at a station - lighting it first -, build the next
 *    station / base piece from the stand point, wear clothes / armour).
 *  - stash: deposit surplus into the base storage box. - hunt / skin: kill passive animals for planner items, then hand-loot the kill (no ground-bag perception, ADR-238).
 *  - trip: outbound gathering / hunting trip 18..36 tiles from the base and back (counts trips / max distance).
 *  - refuel: keep the base fire burning through the night. - leave_base / sleep: door-aware in / out of the 2x2 base.
 */
import { storageDepositActions, storageWithdrawActions, mayTakeFromStorageAt, nearbyStorage, storedCount, type StorageInfo } from "./storage_api.js";
import { timeOfDay, sunFractionOf, Transform, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { Animal, AttachKind, BotHome, BuildPiece, Container, Dead, Fuel, LootBag, NO_SLOT, StanceMode, Survival, Viewing, Worker, Worn } from "../components.js";
import { canUseBaseStorage } from "../building/actions.js";
import { resolveAttachment } from "../building/links.js";
import { countItem, hasBrushInHotbar, readSlots, slotFreshness } from "../inventory.js";
import { spoilStageIndex, spoilStages } from "../food.js";
import { StationKind, type GameDefs } from "../defs.js";
import { animalDefs } from "../population.js";
import { plantableBySeed } from "../farming.js";
/** ADR-252 / ADR-247: a plantable seed / sapling (kept and stashed, never dropped as junk). */
export const isSeedItem = (defs: GameDefs, item: number): boolean => { const k = defs.items.get(item)?.key; return !!k && plantableBySeed(k) > 0; };
import { isWinter, BASE_SLOTS, DOOR_IN, DOOR_OUT, HEARTH_SIT, aiMemoryOf, baseHome, bumpStat, insideBase, makePlan, markAiDirty, claimBaseSite, pickBaseSite, plannerIndex, scanBase, type BaseState, type Plan } from "./planner.js";
import { assessThreat, defenceMemoryOf } from "./defence_plan.js"; // ADR-341: threat level + memory for the planner's defence goal (leaf module: no input.ts cycle)
import { stuckOn } from "./autonomy.js";
import { ruinHomeAnchor } from "./claim_build.js"; // ADR-340: adopted ruin home anchors the planner (the autonomy <-> claim_build cycle already exists)
import { UpgradeCmd } from "../input.js";
import type { AgentOutputWithCommands } from "./agent_output.js";

export interface PlanSensors {
  plan?: Plan; base?: { x: number; y: number }; bs?: BaseState;
  /** ADR-341: adopted ruin home anchor (ADR-340), for the defence sensor's claim check — view.base stays unset for ruins. */
  ruinBase?: { x: number; y: number }; craftCount?: number; craftTicks?: number;
  huntTarget?: { id: number; x: number; y: number }; panel?: { id: number }; tripWanted?: boolean;
  surplus?: { item: number; count: number }[]; woodTotal?: number; stoneTotal?: number; junk?: { item: number; count: number };
  /** ADR-252 / ADR-239: winter (the season is mostly winter): fuel and warmth all day */ winter?: boolean;
}
export const PLAN_SENSOR_KEYS = ["plan", "base", "bs", "ruinBase", "craftCount", "craftTicks", "huntTarget", "panel", "tripWanted", "surplus", "woodTotal", "stoneTotal", "junk", "winter"] as const;
type Ctx = AgentContext<AgentWorldView>;
const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const KEEP_WOOD = 12, KEEP_FOOD = 6;
const GOAL_PATIENCE = 6000;
/** ADR-252: how long a kill's skin spot is remembered (creature loot bags last 120 s = 2400 ticks, ADR-238). */
export const SKIN_TTL = 2400;
const animalsCache = { defs: undefined as ReturnType<typeof animalDefs> | undefined };

/** Planner pass on a sense tick: base anchor, plan, needs (returned), craft / hunt / loot / stash sensors. */
export function fillPlanSensors(world: World, self: Entity, view: AgentWorldView, a: Agent, defs: GameDefs, slots: ReturnType<typeof readSlots>): Set<number> | undefined {
  a.bb.set("selfEntity", self);
  const mem = aiMemoryOf(a); const tick = world.tick; const t = world.get(self, Transform); if (!t) return undefined;
  // Task 28: a hired bot whose base moved (BotHome, set by hire relocation) follows the move instead of
  // rebuilding at the old site — the planner re-anchors on the new home from the next sense tick.
  const moved = world.get(self, BotHome);
  if (moved && (!mem.base || Math.hypot(moved.x - mem.base.x, moved.y - mem.base.y) > 0.5)) {
    mem.base = { x: moved.x, y: moved.y }; claimBaseSite(world, self, mem.base); markAiDirty(a, tick);
  }
  if (!mem.base && tick - a.bb.num("sitePickAt", -1e9) >= 200) {
    a.bb.set("sitePickAt", tick);
    if (view.claimTarget?.kind === "new") { mem.base = { x: view.claimTarget.x, y: view.claimTarget.y }; markAiDirty(a, tick); } // ADR-337: the claim layer already picked this site (pickBaseSite) — adopt it as the home record so the planner's ladder can start; the flag is still built first (planner flag-first rule / claim_build) before any hut piece, and ruin targets never reach here
    else if (!view.claimTarget) { const s = pickBaseSite(world, self, view.home, hash(a.identity.id) + mem.stats.relocations * 0.37); if (s) { mem.base = s; markAiDirty(a, tick); } }
  }
  claimBaseSite(world, self, mem.base); // ADR-252: keep other agents' new sites SITE_SPACING away
  const base = mem.base; const bs = base ? scanBase(world, defs, base) : undefined;
  if (base && bs) {
    for (const sl of BASE_SLOTS) if (bs.pieces.has(sl.id) && mem.fails[sl.id]) delete mem.fails[sl.id];
    const n = bs.pieces.size + bs.stations.size + (bs.storage ? 1 : 0); if (n > mem.stats.built) { mem.stats.built = n; markAiDirty(a, tick); }
    if (n === 0 && (mem.fails["f00"] ?? 0) >= 4) { delete mem.base; claimBaseSite(world, self, undefined); mem.fails = {}; mem.stats.relocations++; markAiDirty(a, tick); return undefined; } // the site is unusable: pick another
    view.base = base; view.bs = bs;
  }
  // ADR-340: a bot that claimed + reclaimed a ruin has no mem.base (ADR-337) — its adopted ruin home
  // anchors the planner's behaviour goals instead (furnish / hearth / bed / upgrade / piece / storage),
  // never the `base` goal that builds BASE_SLOTS over the ruin. view.base stays unset: goTo's door
  // logic, insideBase and sleep-in-bed all key on the 2x2 hut geometry, which a ruin does not have.
  // view.bs IS set, so the ruin's stations / storage / bed / fires drive warm_up, sleep-by-fire and
  // the Task 30 refuel behaviour exactly like a built base's scan. A dropped ruin home (or a lost
  // base) must not leave a stale scan behind.
  const ruin = !mem.base ? ruinHomeAnchor(world, self, a) : undefined;
  const rbs = ruin ? scanBase(world, defs, ruin) : undefined;
  if (ruin && rbs) view.bs = rbs;
  else if (!mem.base) delete view.bs;
  // ADR-341: the ruin anchor for the defence sensor (view.base stays unset for ruins, ADR-340).
  if (ruin) view.ruinBase = { x: ruin.x, y: ruin.y }; else delete view.ruinBase;
  /** The base scan the planner + fuel checks read: the built base, else the adopted ruin home. */
  const homeBs = bs ?? rbs;
  const hungry = (view as { self?: unknown }) && a.bb.num("hungerSeen", 1) < 0.5;
  const woodId = plannerIndex(defs).item.get("wood")?.id; let woodBag = 0; if (woodId !== undefined) for (let i = 0; i < slots.items.length; i++) if (slots.items[i] === woodId) woodBag += slots.counts[i] ?? 0;
  const body = world.getField(self, Survival, "bodyTemp") ?? 37; const dayT = sunFractionOf(timeOfDay(world));
  const freezing = body < 36.4 && woodBag < 7 && !(homeBs?.complete) && !(homeBs?.stations.get(StationKind.Campfire)?.lit);
  const winter = isWinter(world); if (winter) view.winter = true;
  const evening = dayT >= 0.45 && dayT < 0.66; // h11-h16: stock the night's fuel (NIGHT_WOOD) before the cold sets in
  if (base && !mem.earth && !bs?.pieces.size) {
    const earth = planTerrainBase(world, self, base, (hash(a.identity.id) * 4294967296) & 1 ? "pit" : "pad");
    if (earth) { mem.earth = earth; markAiDirty(a, tick); }
  }
  if (mem.earth && base && (mem.earth.x !== base.x || mem.earth.y !== base.y)) delete mem.earth;
  const earthActive = mem.earth && !mem.earth.done && !mem.earth.abandoned;
  const sg = a.bb.get<{ key: string } | null>("saddleGoal"); // ADR-323: the AI's saddle material chain (mount_behaviors.saddleGoalPass)
  // ADR-341: threat level + defence memory for the planner's defence goal (the sensor records the
  // events; the level here is from the previous sense pass — the same lag as every other sensor).
  const dmem = defenceMemoryOf(a); const threat = assessThreat(dmem.events, tick).level;
  const plan = makePlan({ ...(sg ? { priority: [{ key: sg.key, count: 1 }], maxDepth: MOUNT_BOTS.planMaxDepth } : {}), ...(mem.earth ? { earth: mem.earth } : {}), world, self, defs, ...(base ? { base } : {}), ...(homeBs ? { bs: homeBs } : {}), ...(ruin ? { ruinBase: ruin } : {}), threat, defenceMem: dmem, fails: mem.fails, hungry, freezing, evening, winter, ...(mem.snooze ? { snooze: mem.snooze } : {}) }); view.plan = plan; if (earthActive) markAiDirty(a, tick); a.bb.set("planGoal", plan.goal); a.bb.set("planStep", plan.step);
  { // patience: a goal with no step and no leaf gathered for GOAL_PATIENCE ticks is snoozed half a day (persisted), like a player giving up on reeds
    let leafN = 0; for (let i = 0; i < slots.items.length; i++) if (slots.items[i] && plan.leaves.includes(slots.items[i]!)) leafN += slots.counts[i] ?? 0;
    const gs = a.bb.get("goalSeen") as { g: string; last: number; n: number } | undefined;
    if (!gs || gs.g !== plan.goal || plan.step || leafN > gs.n) a.bb.set("goalSeen", { g: plan.goal, last: tick, n: leafN });
    else if (tick - gs.last > GOAL_PATIENCE && plan.goal !== "idle") { (mem.snooze ??= {})[plan.goal] = tick + 36000; mem.stats.snoozed++; a.bb.set("goalSeen", undefined); markAiDirty(a, tick); }
  }
  const ix = plannerIndex(defs);
  for (const d of ix.tools) if (plan.keep.has(d.id) && d.tool!.tier > mem.stats.bestTier) { for (let i = 0; i < slots.items.length; i++) if (slots.items[i] === d.id) { mem.stats.bestTier = d.tool!.tier; markAiDirty(a, tick); } }
  const st = plan.step;
  // crafts are counted when the output really lands in the bag (CraftCompleted is server-side; the bot only sees its inventory)
  const have = (id: number): number => { let n = 0; for (let i = 0; i < slots.items.length; i++) if (slots.items[i] === id) n += slots.counts[i] ?? 0; return n; };
  const pend = a.bb.get<{ item: number; n: number; until: number; station: boolean }>("craftPend");
  if (pend) { if (have(pend.item) > pend.n) { bumpStat(a, "crafts", tick); if (pend.station) bumpStat(a, "stationCrafts", tick); a.bb.set("craftPend", undefined); } else if (tick > pend.until) a.bb.set("craftPend", undefined); }
  if (st?.k === "craft") { const out = defs.recipes.get(st.recipe)?.output.item; if (out !== undefined) a.bb.set("craftNext", { item: out, n: have(out), until: tick + st.ticks + 200, station: st.station !== StationKind.None }); }
  else if (view.craftRecipe !== undefined) { const out = defs.recipes.get(view.craftRecipe)?.output.item; if (out !== undefined) a.bb.set("craftNext", { item: out, n: have(out), until: tick + 400, station: false }); }
  if (st?.k === "craft" && st.station === StationKind.None) { view.craftRecipe = st.recipe; view.craftCount = st.count; view.craftTicks = st.ticks; } else if (base) delete view.craftRecipe;
  if (base) delete view.buildPlan;
  const needs = new Set(plan.leaves);
  const wood = ix.item.get("wood")?.id; let woodN = 0; if (wood !== undefined) for (let i = 0; i < slots.items.length; i++) if (slots.items[i] === wood) woodN += slots.counts[i] ?? 0;
  view.woodTotal = woodN; { const sw = ix.item.get("stone")?.id; view.stoneTotal = sw === undefined ? 0 : have(sw); }
  if (st?.k === "craft" && st.station !== StationKind.None && wood !== undefined) { const s = homeBs?.stations.get(st.station); if (s?.fired && !s.lit && woodN < 4) needs.add(wood); }
  if (wood !== undefined && homeBs?.stations.has(StationKind.Campfire) && woodN < 6) needs.add(wood);
  for (const h of plan.hunt) needs.add(h);
  // hunt: a passive animal in memory that drops a wanted item, only with a weapon in hand
  if (plan.hunt.length) {
    const ad = animalsCache.defs ?? (animalsCache.defs = animalDefs()); let best: PlanSensors["huntTarget"], bd = 26 * 26;
    const hasWeapon = slots.items.some((it, i) => it && slots.counts[i] && defs.items.get(it)?.weapon);
    if (hasWeapon) for (const p of a.memory.items.values()) { if (p.kind !== "animal" || !world.isAlive(p.id) || world.has(p.id, Dead) || !world.has(p.id, Animal)) continue;
      const def = ad[world.getField(p.id, Animal, "kind") ?? -1]; if (!def || def.attack || def.hp > 60) continue;
      if (!def.loot.some((l) => plan.hunt.includes(defs.itemId(l.item)))) continue;
      const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2; if (d < bd) { bd = d; best = { id: p.id, x: p.x, y: p.y }; } }
    if (best) view.huntTarget = best;
  }
  // ADR-252 / ADR-238: AI humans never perceive ground loot bags. Killing their own prey leaves a "skin spot" (where it
  // fell); the bot walks there and presses gather like a player (the server's ADR-160 hand loot opens the bag), and then
  // reads only its own open container panel (Viewing), which a human sees on screen too.
  { const hh = a.bb.get<{ id: number; x: number; y: number }>("huntHit");
    if (hh && (!world.isAlive(hh.id as Entity) || world.has(hh.id as Entity, Dead))) { bumpStat(a, "hunts", tick); a.bb.set("huntHit", undefined); a.bb.set("skinAt", { x: hh.x, y: hh.y, until: tick + SKIN_TTL, tries: 0 }); }
    const sk = a.bb.get<{ until: number }>("skinAt"); if (sk && tick > sk.until) a.bb.set("skinAt", undefined);
    const vc = world.has(self, Viewing) ? world.getField(self, Viewing, "container") ?? 0 : 0;
    if (vc && world.isAlive(vc as Entity) && world.has(vc as Entity, LootBag) && world.has(vc as Entity, Container) && readSlots(world, vc as Entity).counts.some((n) => n > 0)) view.panel = { id: vc }; }
  // junk: with <= 2 free slots, drop a stack nothing on the ladder uses (grain / scrap clutter). ADR-252 / ADR-247: never seeds
  // (each species' seed only drops from its own plant): they go to the base box with the other surplus instead
  { let free = 0; for (let i = 0; i < slots.addLimit; i++) if (!slots.items[i] || !slots.counts[i]) free++;
    const stages = spoilStages(defs);
    for (let i = 0; i < slots.items.length && !view.junk; i++) { const it = slots.items[i]!; if (it && slots.counts[i] && defs.items.get(it)?.food && stages[spoilStageIndex(slotFreshness(world, self, i), stages)]?.sick) view.junk = { item: it, count: slots.counts[i]! }; }
    if (free <= 2 && !view.junk) for (let i = 0; i < slots.addLimit; i++) { const it = slots.items[i]!; if (!it || !slots.counts[i] || ix.useful.has(it) || plan.keep.has(it) || isSeedItem(defs, it)) continue;
      // Task 25: dye is purposeful material while the bot holds a paint brush (it will be consumed by the dye action,
      // never junk-dropped in a loop); a brush-less bot keeps the Task 16 behaviour (dye is junk).
      if (it === ix.item.get("dye")?.id && hasBrushInHotbar(world, self)) continue;
      view.junk = { item: it, count: slots.counts[i]! }; break; } }
  // stash: bag items the plan does not need (never tools / weapons / worn / food stock / fire wood)
  if (bs?.storage && bs.storage.free > 0) {
    const worn = new Set<number>(); const wi = world.getArray(self, Worn, "item"); if (wi) for (const x of wi) if (x) worn.add(x);
    const tot = new Map<number, number>(); for (let i = 0; i < slots.items.length; i++) { const it = slots.items[i]!; if (it && slots.counts[i]) tot.set(it, (tot.get(it) ?? 0) + slots.counts[i]!); }
    const sur: { item: number; count: number }[] = [];
    for (const [it, n] of tot) { const d = defs.items.get(it); if (!d || d.tool || d.weapon || d.wear || worn.has(it)) continue;
      const keep = it === wood ? KEEP_WOOD : d.food && d.food.health >= 0 ? KEEP_FOOD : plan.keep.has(it) ? n : 0; if (n > keep) sur.push({ item: it, count: n - keep }); }
    if (sur.length) view.surplus = sur;
  }
  return needs;
}
/** Called after gather selection: a trip is worth it when the plan needs something no known node near home gives. */
export function noteTripWanted(view: AgentWorldView, needs: Set<number>, wantedKnown: boolean, a?: Agent, tick?: number): void {
  if (view.base && needs.size && !wantedKnown) view.tripWanted = true;
  // ADR-343: the same unmet need is the resource expedition's fuel — record it on the agent (persisted AiMemory) so
  // the travel layer (and the off-screen planner, which has no view) can launch a trip to the nearest source of it;
  // clear it when the plan no longer needs anything. Refreshed on every sensor pass while the need persists, so its
  // age only ever matters off-screen (resourceNeedTtlTicks). A known node nearby needs no expedition: the local
  // trip / gather handles it, so a merely-known need leaves the record alone.
  if (a !== undefined && tick !== undefined) {
    const mem = aiMemoryOf(a);
    if (needs.size && !wantedKnown) { mem.resourceNeed = { items: [...needs], at: tick }; markAiDirty(a, tick); }
    else if (needs.size === 0 && mem.resourceNeed) { delete mem.resourceNeed; markAiDirty(a, tick); }
  }
}

// ---------------- movement helpers ----------------
const toward = (o: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1;
  // Navigation goals are world-relative; AgentOutput movement is player screen input.
  o.moveX = ((dx - dy) / d) * Math.SQRT1_2 * s; o.moveY = ((dx + dy) / d) * Math.SQRT1_2 * s;
  o.aimX = dx / d; o.aimY = dy / d; return d;
};
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };
/** Door-aware walk: crossing the base wall goes through the door (open, pass, close behind) like a player. Returns the distance to (tx, ty). */
export function goTo(c: Ctx, o: { moveX: number; moveY: number; aimX: number; aimY: number; actions: string[] }, tx: number, ty: number, s = 0.85): number {
  const b = c.world.base, door = c.world.bs?.door; const d = Math.hypot(tx - c.self.x, ty - c.self.y);
  c.bb.set("navGoalX", tx); c.bb.set("navGoalY", ty); c.bb.set("navGoalAt", c.self.tick); // ADR-321: trip length for mountPolicy
  if (b && door) {
    const inS = insideBase(b, c.self.x, c.self.y), inT = insideBase(b, tx, ty);
    const shut = c.bb.get<number>("doorShut");
    const dd = Math.hypot(door.x - c.self.x, door.y - c.self.y);
    // close the door behind us, only from within reach (ADR-252: a far toggle is a wasted, rejected command)
    if (shut !== undefined && (!door.open || dd > 2.2)) c.bb.set("doorShut", undefined);
    else if (shut !== undefined && dd > 1.1 && c.self.tick - c.bb.num("doorAt", -1e9) > 10) { o.actions.push(`door:${door.id}`); c.bb.set("doorAt", c.self.tick); c.bb.set("doorShut", undefined); }
    if (inS !== inT) {
      const near = inS ? { x: b.x + DOOR_IN.x, y: b.y + DOOR_IN.y } : { x: b.x + DOOR_OUT.x, y: b.y + DOOR_OUT.y };
      const far = inS ? { x: b.x + DOOR_OUT.x, y: b.y + DOOR_OUT.y } : { x: b.x + DOOR_IN.x, y: b.y + DOOR_IN.y };
      const dn = Math.hypot(near.x - c.self.x, near.y - c.self.y);
      // ADR-385: report the via-door path length, not the straight-line distance. Every
      // caller uses goTo's return as "am I close enough?" (withdraw / craft / build / stash
      // all stop on it); the straight line understates the trip through the wall, so a bot
      // standing inside 1.8 tiles from an outside box stopped and tried the container
      // through the wall forever instead of walking out through the door (ADR-252 live:
      // the bed's 6 planks never got withdrawn, the bot idled at the bed step). The
      // via-door length keeps every caller walking until it is actually on the target's
      // side; once across, the main path below reports the straight line as before.
      const viaDoor = dn + Math.hypot(far.x - near.x, far.y - near.y) + Math.hypot(tx - far.x, ty - far.y);
      // A cached crossing phase is valid only while actually in the doorway corridor.
      // Navigation around a pit can return us to the outside of a different wall.
      const crossing = c.bb.num("doorPhase") === 1 && Math.abs(c.self.x - near.x) < .45
        && c.self.y >= Math.min(near.y, far.y) - .3 && c.self.y <= Math.max(near.y, far.y) + .3;
      if (dn > 0.45 && !crossing) {
        c.bb.set("doorPhase", 0);
        const w = worldOf(c), wp = w ? walkerWaypoint(w, c.agent.bb.num("selfEntity") as Entity, c.self.x, c.self.y, near.x, near.y) : undefined; // ADR-382: always route (see the main path below)
        toward(o, c.self.x, c.self.y, wp?.x ?? near.x, wp?.y ?? near.y, s); return viaDoor;
      }
      if (!door.open) { stop(o); if (c.self.tick - c.bb.num("doorAt", -1e9) > 20) { o.actions.push(`door:${door.id}`); c.bb.set("doorAt", c.self.tick); } return viaDoor; }
      c.bb.set("doorPhase", 1); c.bb.set("doorShut", 1); toward(o, c.self.x, c.self.y, far.x, far.y, 0.6); return viaDoor;
    }
    c.bb.set("doorPhase", 0);
  }
  // ADR-382: always route through the pathfinder. The old gate (`editIndex(w).size ?`) only
  // routed when some terrain had already been edited, so on a pristine map a bot walked
  // directly at its target with no obstacle avoidance — it pushed against its own campfire
  // (which sits between the bot and its quarry stand) and never moved, tripped stuckOn /
  // workFail, and the travel behaviour walked it 150 tiles away; the raised pad was never
  // dug (ADR-252). The first dig itself needs the pathfinder, so the gate was a circular
  // dependency the pre-378 world only escaped by lucky timing. walkerWaypoint already
  // returns the direct goal when the ray is clear (navNeeded), so the gate saved nothing
  // but correctness.
  const w = worldOf(c); const wp = w ? walkerWaypoint(w, c.agent.bb.num("selfEntity") as Entity, c.self.x, c.self.y, tx, ty) : undefined;
  toward(o, c.self.x, c.self.y, wp?.x ?? tx, wp?.y ?? ty, s); return d;
}
/** ADR-252: container work goes through the ADR-250 storage API (storageDepositActions / storageWithdrawActions): the
 *  sequence (open -> one op -> close) is played one action per think tick (CONTAINER_STEP ticks apart), like a player
 *  clicking through the panel; the server validates every step. Returns true when the last action went out. */
export const CONTAINER_STEP = 10;
export function containerSeq(c: Ctx, o: { actions: string[] }, id: number, seq: readonly string[]): boolean {
  if (o.actions.some((a) => /^c(open|close|deposit|withdraw)(:|$)/.test(a))) return false;
  const at = c.bb.num("cseqAt", -1e9); if (c.self.tick - at < CONTAINER_STEP) return false;
  const key = `${id}|${seq[1] ?? ""}`; const i = c.self.tick - at > 6 * CONTAINER_STEP || c.bb.get<string>("cseqKey") !== key ? 0 : c.bb.num("cseqStep");
  c.bb.set("cseqAt", c.self.tick); c.bb.set("cseqKey", key);
  o.actions.push(seq[i]!); if (i + 1 >= seq.length) { c.bb.set("cseqStep", 0); c.bb.set("cseqKey", undefined); return true; }
  c.bb.set("cseqStep", i + 1); return false;
}
/** Deposit then toggle the fire on (the hearth's fuel box is a container too). */
const depositAndLight = (id: number, item: number, n: number): string[] => { const a = storageDepositActions(id as Entity, item, n); a.splice(a.length - 1, 0, `fire:${id}`); return a; };
const night = (p: string): number => (p === "night" ? 1 : p === "dusk" ? 0.6 : 0);
const cooled = (c: Ctx, k: string, n: number): boolean => c.self.tick - c.bb.num(k, -1e9) >= n;
const step01 = { type: "step" as const, at: 0.5 };
/** Task 30: a fire is "low" under this much burn left (120 s) — top it up before it goes out. */
export const REFUEL_BELOW_TICKS = 2400;
/** Task 30: wood deposited per top-up (10 wood ≈ 200 s of burn; efficient fires stretch it further). */
export const REFUEL_DEPOSIT = 10;
/** Task 30: work fires (smelting / cooking) are refuelled whenever low, day or night. Warmth / light fires
 * (campfire, fireplace, torch stand) only when the fire is needed — night, dusk, cold or winter — so a bot
 * does not burn the wood pile keeping a summer-midday campfire lit. */
export const WORK_FIRES: ReadonlySet<string> = new Set(["furnace", "wood_stove", "stove_iron", "cook_range", "clay_oven"]);
const workFire = (key: string): boolean => WORK_FIRES.has(key);
const fireNeeds = (c: Ctx, key: string): boolean => {
  const w = worldOf(c), b = c.world.base;
  return workFire(key) || night(c.self.phase) > 0 || c.world.cold === true || c.world.winter === true
    || !!(w && b && isUnderground(w, b.x, b.y)); // an underground room is dark even at noon
};
/** Task 30: the lowest-fuel lit fire at the bot's base that needs refuelling now (all heat fires, not just
 * the campfire — fireplace, stove, furnace, torch stand included). Hired workers read the owner's base
 * scan (fillHireSensors re-anchors bs), so the same behaviour tends the player's fires. */
export function lowFire(c: Ctx): { id: number; key: string; x: number; y: number; fuelTicks: number } | undefined {
  let best: { id: number; key: string; x: number; y: number; fuelTicks: number } | undefined;
  for (const f of c.world.bs?.fires ?? []) {
    if (!f.lit || f.fuelTicks >= REFUEL_BELOW_TICKS || !fireNeeds(c, f.key)) continue;
    if (!best || f.fuelTicks < best.fuelTicks) best = { id: f.id, key: f.key, x: f.x, y: f.y, fuelTicks: f.fuelTicks };
  }
  return best;
}
const mark = (c: Ctx, k: Parameters<typeof bumpStat>[1], by = 1): void => bumpStat(c.agent, k, c.self.tick, by);

/** ADR-355: the bot's own entity (set by fillPlanSensors); undefined on a bare replica context. */
const selfEntityOf = (c: Ctx): Entity | undefined => c.agent.bb.get<Entity>("selfEntity");
/** ADR-355: home this AI may take storage from — its employer's home when hired, else its own base. */
const takeHomeOf = (c: Ctx): { x: number; y: number } | undefined => {
  const w = worldOf(c); const self = selfEntityOf(c); if (!w || !self) return undefined;
  const wk = w.isRegistered(Worker) ? w.get(self, Worker) : undefined;
  if (wk?.owner) return { x: wk.homeX, y: wk.homeY };
  const base = aiMemoryOf(c.agent).base; return base ? baseHome(base) : undefined;
};
/**
 * ADR-355: storage target for one item — the nearest base store that accepts it (a matching store first,
 * a generic store when there is none), each permission-checked for the bot's own / employer's base, else
 * the scanned base box. `holding` = fetch (the store must actually hold the item); false = deposit (the
 * store must have a free slot when that is readable). Hired workers fetch from the employer's stores
 * under the existing permission rules, never another player's.
 */
export function storageTargetFor(c: Ctx, item: number, holding: boolean): { id: number; x: number; y: number } | undefined {
  const w = worldOf(c); const self = selfEntityOf(c);
  if (w && self) {
    const all = nearbyStorage(w, self, MOUNT_BOTS.storageRadius);
    const matching = (s: StorageInfo): boolean => !!s.accepts?.length && s.accepts.includes(item);
    const wanted = holding ? all.filter((s) => storedCount(s, item) > 0) : all.filter((s) => s.free === undefined || s.free > 0);
    for (const s of [...wanted.filter(matching), ...wanted.filter((s) => !matching(s))]) {
      const att = resolveAttachment(w, s.piece, AttachKind.Storage);
      const ok = holding
        ? mayTakeFromStorageAt(w, self, s, takeHomeOf(c), MOUNT_BOTS.homeStorageTiles)
        : att !== undefined && canUseBaseStorage(w, self, att);
      if (ok) return { id: s.piece, x: s.x, y: s.y };
    }
  }
  return c.world.bs?.storage;
}

export function baseBehaviors(): GameBehavior[] {
  return [
    { name: "base_work", scheduleBonus: 0.35, inertia: 0.35, traits: { industriousness: 0.6 }, considerations: [
        { name: "step", weight: 1.3, curve: step01, input: (c) => { const s = c.world.plan?.step; return s && c.world.plan?.goal !== "defence" && (s.k !== "craft" || s.station !== StationKind.None) && cooled(c, "workFail", 120) ? 1 : 0; } },
        { name: "daylight", curve: { type: "linear", m: -0.7, b: 1 }, input: (c) => night(c.self.phase) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const s = c.world.plan?.step; const bs = c.world.bs; if (!s) return false;
        if (c.world.plan?.goal === "defence") return false; // ADR-341: the defence build step belongs to build_defence (withdraw + build + DefenceMemory fails), not base_work
        const fail = (): false => { c.bb.set("workFail", c.self.tick); return false; };
        if (s.k === "terrain") {
          if (goTo(c, o, s.stand.x, s.stand.y) > .55) { if (stuckOn(c, s.stand.x, s.stand.y)) return fail(); return; }
          stop(o); if (cooled(c, "earthAt", 20)) { o.actions.push(`terrain:${s.x}:${s.y}:${s.dir}`); c.bb.set("earthAt", c.self.tick); } return;
        }
        if (s.k === "light") {
          const wood = plannerIndex(gdefs(c)).item.get("wood"); if (!wood) return fail();
          const p = worldOf(c)?.get(s.piece, Transform); if (!p) return fail();
          if (goTo(c, o, p.x, p.y) > 2.2) return; stop(o);
          const w = worldOf(c)!;
          // Deposited fuel belongs to this job. Do not switch back to withdrawing a new
          // stack, or restart the open/deposit sequence before the staged fire is lit.
          if (w.getField(s.piece, Fuel, "lit")) return false;
          if (countItem(w, s.piece, wood.id) > 0 || (w.getField(s.piece, Fuel, "burnUntilTick") ?? 0) > w.tick) {
            if (cooled(c, "earthLightAt", 20)) { o.actions.push(`fire:${s.piece}`); c.bb.set("earthLightAt", c.self.tick); }
            return;
          }
          containerSeq(c, o, s.piece, depositAndLight(s.piece, wood.id, 4)); return;
        }
        if (s.k === "wear") { if (cooled(c, "wearAt", 60)) { o.actions.push(`wear:${s.invSlot}`); c.bb.set("wearAt", c.self.tick); mark(c, "wears"); } return false; }
        if (s.k === "withdraw") { const sb = storageTargetFor(c, s.item, true); if (!sb) return fail(); // ADR-355: fetch from the nearest store that holds the item (a matching store first), else the scanned base box
          // Container reach is 2.5 tiles: stop as soon as the box is reachable instead of pushing to 1.6
          // through furniture — a bot approaching from behind its own workbench pinned itself at ~2.1 tiles
          // forever (the workbench blocks the last stretch, and nothing else moves it while gated on workFail).
          if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) return fail(); return; } stop(o);
          if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, s.item, s.count))) { mark(c, "withdraws"); return false; } return; }
        if (s.k === "craft") { const st = bs?.stations.get(s.station); if (!st) return fail();
          const wait = c.bb.num("craftUntil", -1); if (wait > c.self.tick) { if (Math.hypot(st.x - c.self.x, st.y - c.self.y) > 2) goTo(c, o, st.x, st.y); else stop(o); return; }
          if (goTo(c, o, st.x, st.y) > 1.7) { if (stuckOn(c, st.x, st.y)) return fail(); return; } stop(o);
          if (st.fired && !st.lit) { const wood = plannerIndex(gdefs(c)).item.get("wood")?.id; if (wood === undefined || !(c.world.woodTotal ?? 0)) return fail();
            if (containerSeq(c, o, st.id, depositAndLight(st.id, wood, Math.min(6, c.world.woodTotal!)))) mark(c, "refuels"); return; }
          o.actions.push(`craft:${s.recipe}:${s.count}`); c.bb.set("craftUntil", c.self.tick + s.ticks); armCraft(c); return; }
        if (s.k === "upgrade") { // Task 28: walk to the piece (Upgrade reach is buildReach, 4 tiles) and send the same
          // Upgrade command a player sends; the server re-validates skill, cost and privilege.
          const wd = worldOf(c); const tp = wd?.get(s.piece as Entity, Transform);
          if (!tp) return fail();
          if (goTo(c, o, tp.x, tp.y) > 3.2) { if (stuckOn(c, tp.x, tp.y)) return fail(); return; }
          stop(o);
          if (!cooled(c, "upgradeAt", 30)) return;
          const oc = o as unknown as AgentOutputWithCommands;
          (oc.commands ??= []).push({ type: UpgradeCmd.name, payload: { target: s.piece, tier: s.tier } });
          c.bb.set("upgradeAt", c.self.tick); return false; }
        // build
        const d = goTo(c, o, s.stand.x, s.stand.y, 0.8);
        if (d > 0.5 && !(d < 3 && stuckOn(c, s.stand.x, s.stand.y, 40))) { if (d >= 3 && stuckOn(c, s.stand.x, s.stand.y)) return fail(); return; }
        stop(o); o.aimX = s.x - c.self.x; o.aimY = s.y - c.self.y;
        if (!cooled(c, "buildAt", 30)) return;
        o.actions.push(`build:${s.piece}:${s.x}:${s.y}:${s.level}:${s.rot ?? 0}:${s.tier ?? 0}`); c.bb.set("buildAt", c.self.tick);
        const m = aiMemoryOf(c.agent); m.fails[s.slot] = (m.fails[s.slot] ?? 0) + 1; markAiDirty(c.agent, c.self.tick); return false;
      } },
    { name: "stash", inertia: 0.4, traits: { greed: 0.3 }, considerations: [
        { name: "surplus", curve: step01, input: (c) => (c.world.surplus && cooled(c, "stashAt", 300) ? 1 : 0) },
        { name: "full", curve: { type: "linear", m: -0.6, b: 1 }, input: (c) => Math.min(1, c.world.invSpaceFree ?? 0.5) },
        { name: "nearBase", curve: { type: "inverse" }, input: (c) => { const sb = c.world.bs?.storage; return sb ? Math.min(1, Math.hypot(sb.x - c.self.x, sb.y - c.self.y) / 24) : 1; } }],
      run: (c, o) => { const sur = c.world.surplus; if (!sur) return false;
        // ADR-355: one stack at a time, each to the store that accepts it (ore to the ore store, crops to the
        // crop store, ...); the scanned base box is the fallback when no matching store exists.
        const list = sur.slice(0, 6); const k = c.bb.num("stashIdx"); const s = list[Math.min(k, list.length - 1)]!;
        const sb = storageTargetFor(c, s.item, false); if (!sb) return false;
        if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) { c.bb.set("stashAt", c.self.tick); return false; } return; } stop(o); // same reach-based stop as withdraw
        // one deposit per open/close cycle (ADR-250 API), one stack after another across think ticks
        if (containerSeq(c, o, sb.id, storageDepositActions(sb.id as Entity, s.item, s.count))) { mark(c, "deposits");
          if (k + 1 >= list.length) { c.bb.set("stashIdx", 0); c.bb.set("stashAt", c.self.tick); return false; } c.bb.set("stashIdx", k + 1); } } },
    { name: "hunt", inertia: 0.5, traits: { bravery: 0.6 }, considerations: [
        { name: "prey", curve: { type: "inverse" }, input: (c) => { const h = c.world.huntTarget; return h && cooled(c, "huntFail", 300) ? Math.min(1, Math.hypot(h.x - c.self.x, h.y - c.self.y) / 30) : 1; } },
        { name: "healthy", curve: { type: "step", at: 0.5 }, input: (c) => c.self.hp }],
      run: (c, o) => {
        const h = c.world.huntTarget; if (!h) return false; const w = c.agent; void w;
        const p = c.memory.items.get(h.id) ?? h; const id = c.bb.num("huntId", -1);
        if (id !== h.id) { c.bb.set("huntId", h.id); c.bb.set("huntStart", c.self.tick); }
        if (c.self.tick - c.bb.num("huntStart") > 900) { c.bb.set("huntFail", c.self.tick); return false; }
        const d = toward(o, c.self.x, c.self.y, p.x, p.y, 1); o.sprint = d > 3 && c.self.stamina > 0.4;
        if (d < 1.4) { o.moveX *= 0.2; o.moveY *= 0.2; if (cooled(c, "hitAt", 10)) { o.actions.push(`attack:${h.id}`); c.bb.set("hitAt", c.self.tick); c.bb.set("huntHit", { id: h.id, x: p.x, y: p.y }); } }
      } },
    { name: "skin", inertia: 0.6, considerations: [{ name: "carcass", curve: step01, input: (c) => (c.world.panel || c.bb.get("skinAt") ? 1 : 0) }],
      run: (c, o) => { const pn = c.world.panel; // own open panel: take all, close (one action per think tick)
        if (pn) { stop(o); if (containerSeq(c, o, pn.id, [`cwithdraw:${pn.id}:0:0`, "cclose"])) { mark(c, "loots"); c.bb.set("skinAt", undefined); return false; } return; }
        const s = c.bb.get<{ x: number; y: number; until: number; tries: number }>("skinAt"); if (!s) return false;
        if (toward(o, c.self.x, c.self.y, s.x, s.y, 0.8) > 0.9) { if (stuckOn(c, s.x, s.y)) { c.bb.set("skinAt", undefined); return false; } return; } stop(o);
        if (cooled(c, "skinTry", 2 * CONTAINER_STEP)) { if (s.tries >= 3) { c.bb.set("skinAt", undefined); return false; } c.bb.set("skinAt", { ...s, tries: s.tries + 1 }); c.bb.set("skinTry", c.self.tick); o.actions.push("gather"); } } },
    { name: "trip", inertia: 0.6, scheduleBonus: 0.2, traits: { industriousness: 0.4, bravery: 0.3 }, considerations: [
        { name: "want", curve: step01, input: (c) => {
          // ADR-346: the ADR-343 route gate applies to resource expeditions only. An explore / POI / return
          // route is undirected wandering the local trip is allowed to interrupt (base behaviour): the trip
          // is how a bot with unmet needs gathers locally — ADR-203's campfire depends on it — and a bot on
          // an explore route must still come home at dusk. The gate's rationale (the trip out-scores travel
          // ~1.0 vs 0.55 and would hijack an expedition into 36-tile loops) only holds for an expedition with
          // a destination that matters. An in-progress trip is ended only while an expedition route is active,
          // so a stale bb.trip cannot hijack the expedition's return leg either.
          if (c.world.travel?.route && c.world.travel.kind === "resource") { const tr = c.bb.get<{ max: number }>("trip"); if (tr) endTrip(c, tr.max); return 0; }
          return c.bb.get("trip") ? 1 : c.world.tripWanted && cooled(c, "tripEnd", 600) ? 0.8 : 0;
        } },
        { name: "day", curve: { type: "linear", m: -1, b: 1 }, input: (c) => (c.bb.get<{ ret: boolean }>("trip")?.ret ? 0 : night(c.self.phase)) },
        { name: "fed", curve: step01, input: (c) => (c.bb.get("trip") || (c.self.hunger > 0.5 && c.self.thirst > 0.5) ? 1 : 0) },
        { name: "warm", curve: step01, input: (c) => (c.bb.get<{ ret: boolean }>("trip")?.ret || (c.world.chill?.body ?? 37) >= 36.6 ? 1 : 0) }], // a chilled bot does not set out (and turns back)
      run: (c, o) => {
        const home = c.world.home; let tr = c.bb.get<{ x: number; y: number; t0: number; ret: boolean; max: number }>("trip");
        if (!tr) { const a = c.rng.range(-Math.PI, Math.PI), r = c.rng.range(18, 36); tr = { x: home.x + Math.cos(a) * r, y: home.y + Math.sin(a) * r, t0: c.self.tick, ret: false, max: 0 }; c.bb.set("trip", tr); }
        const dh = Math.hypot(home.x - c.self.x, home.y - c.self.y); tr.max = Math.max(tr.max, dh);
        if (!tr.ret && ((c.world.chill?.body ?? 37) < 36.6 || night(c.self.phase) > 0 || c.self.hunger < 0.35 || c.self.thirst < 0.35 || (c.world.invSpaceFree ?? 1) < 0.3 || c.self.tick - tr.t0 > 3600 || !c.world.tripWanted && tr.max > 12)) tr.ret = true;
        if (tr.ret) { if (goTo(c, o, home.x, home.y, 1) < 3 || stuckOn(c, home.x, home.y, 200)) { endTrip(c, tr.max); return false; } return; }
        // ADR-385: the outbound leg used toward (a direct walk), so a trip that started while the bot was
        // inside its base walked straight into the east wall and never left: toward pushed it into the wall,
        // stuckOn re-randomised the target every 120 ticks, and the trip monopolised the controller (it
        // returns false every tick and re-wins the think while bb.trip exists), starving base_work — the bot
        // idled at the bed withdraw forever (ADR-252 live). goTo is door-aware (the return leg already uses
        // it), so the bot exits through the door and the trip can actually complete. goTo's return is the
        // via-door length while crossing (same as the return leg's arrival check), so the < 2 test still
        // means "arrived" once the bot is on the target's side.
        if (goTo(c, o, tr.x, tr.y, 0.9) < 2 || stuckOn(c, tr.x, tr.y, 120)) { const a = c.rng.range(-Math.PI, Math.PI); tr.x = c.self.x + Math.cos(a) * 10; tr.y = c.self.y + Math.sin(a) * 10; }
        return false; // re-evaluate every tick so gather / hunt take over when a wanted node or prey shows up
      } },
    { name: "refuel", inertia: 0.4, considerations: [
        // Task 30: any low heat fire at the base (not just the campfire), fuel from the bag or base storage.
        // Bounded like the Task 28 garden: only when a fire is actually low, and 200 ticks of cooldown after
        // each top-up (or after finding no fuel anywhere), so it never starves the job / ladder work.
        { name: "low", weight: 1.5, curve: step01, input: (c) => (lowFire(c) !== undefined && cooled(c, "refuelAt", 200) ? 1 : 0) }],
      run: (c, o) => { const f = lowFire(c); const wood = plannerIndex(gdefs(c)).item.get("wood")?.id; if (!f || wood === undefined) return false;
        const bagWood = c.world.woodTotal ?? 0;
        if (bagWood <= 0) { // no wood in the bag: fetch it from base storage (the owner's box for a hired worker)
          const sb = c.world.bs?.storage; const stored = sb?.counts.get(wood) ?? 0;
          if (!sb || stored <= 0) { c.bb.set("refuelAt", c.self.tick); return false; } // no fuel anywhere: cool down, don't loop
          if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) { c.bb.set("refuelAt", c.self.tick); return false; } return; } stop(o);
          if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, wood, Math.min(REFUEL_DEPOSIT, stored)))) { mark(c, "withdraws"); return false; } return; }
        if (goTo(c, o, f.x, f.y) > 1.6) { if (stuckOn(c, f.x, f.y)) { c.bb.set("refuelAt", c.self.tick); return false; } return; } stop(o);
        if (containerSeq(c, o, f.id, storageDepositActions(f.id as Entity, wood, Math.min(REFUEL_DEPOSIT, bagWood)))) { mark(c, "refuels"); c.bb.set("refuelAt", c.self.tick); return false; } } },
    // ADR-252: cold kills in ~70 s once the body is under 35 C; get warm first (lit fire > light the fire > roofed base > a camp fire on the spot)
    { name: "warm_up", inertia: 0.6, considerations: [
        { name: "chilled", weight: 2.2, curve: step01, input: (c) => { const ch = c.world.chill; if (!ch) return 0;
          const on = (c.bb.get("warming") ? ch.body < 36.8 || (ch.felt < 10 && ch.body < 37) : ch.body < 36.2 || (ch.felt < 8 && ch.body < 36.6)) || (bankHours(c) && c.self.thirst > 0.45 && (c.self.hunger > 0.35 || c.world.food === undefined)); /* banking yields to drink / eat */ c.bb.set("warming", on); return on ? 1 : 0; } },
        { name: "canWarm", curve: step01, input: (c) => (warmOption(c) ? 1 : 0) }], // nothing to warm at: the planner's emergency wood/stone goal (gather) takes over
      run: warmRun },
    // Heat kills as fast as cold (hyperthermia above 39 C): get to shade / the enclosed base first, water first if
    // thirst is critical — the enclosed base clamps felt temperature to the comfort band, so reaching it saves the bot.
    { name: "cool_down", inertia: 0.6, considerations: [
        { name: "overheated", weight: 2.2, curve: step01, input: (c) => { const ch = c.world.chill; if (!ch) return 0;
          const on = c.bb.get("cooling") ? ch.body > 38.3 || (ch.felt > 34 && ch.body > 37.5) : ch.body > 38.6 || ch.felt > 36; c.bb.set("cooling", on); return on ? 1 : 0; } },
        { name: "canCool", curve: step01, input: (c) => (c.world.base || c.world.waterAt ? 1 : 0) }],
      run: (c, o) => {
        const w = c.world.waterAt;
        if (c.self.thirst < 0.35 && w) { if (toward(o, c.self.x, c.self.y, w.x, w.y) > 0.8) { if (stuckOn(c, w.x, w.y)) return false; return; } stop(o); if (cooled(c, "drankAt", 20)) { o.actions.push(`drink:${NO_SLOT}`); c.bb.set("drankAt", c.self.tick); } return; }
        const b = c.world.base; if (!b) { stop(o); return false; }
        if (goTo(c, o, b.x + 1, b.y + 1) < 0.6) stop(o);
      } },
    { name: "leave_base", inertia: 0.2, considerations: [
        { name: "inside", curve: step01, input: (c) => (c.world.base && c.world.bs?.door && insideBase(c.world.base, c.self.x, c.self.y) && night(c.self.phase) === 0 && (c.world.plan?.step || c.world.needs?.length) ? 1 : 0) }],
      run: (c, o) => { const b = c.world.base; if (!b) return false; const x = b.x + DOOR_OUT.x, y = b.y + DOOR_OUT.y + 0.6; if (goTo(c, o, x, y) < 0.6 || stuckOn(c, x, y, 120)) return false; } },
  ];
}
/** The craft command just went out: watch the bag for its output (fillPlanSensors counts it). */
export function armCraft(c: { bb: Agent["bb"]; self: { tick: number } }): void { const n = c.bb.get("craftNext"); if (n && !c.bb.get("craftPend")) c.bb.set("craftPend", n); }
function endTrip(c: Ctx, max: number): void { c.bb.set("trip", undefined); c.bb.set("tripEnd", c.self.tick); if (max >= 12) { const m = aiMemoryOf(c.agent); m.stats.trips++; m.stats.tripMax = Math.max(m.stats.tripMax, Math.round(max)); markAiDirty(c.agent, c.self.tick); } }
/** Sleep in the base (through the door) when it has one; else by the fire. Replaces the survivor sleep run. */
export function baseSleepRun(c: Ctx, o: { moveX: number; moveY: number; aimX: number; aimY: number; actions: string[] }): boolean | void {
  const b = c.world.base; let tx = c.world.home.x, ty = c.world.home.y;
  const f = c.world.bs?.stations.get(StationKind.Campfire); // ADR-252: a lit fire beats walls at 6 C nights; the roofed base when it is out
  const bed = c.world.bs?.bed; const inBed = !!bed && !!b && !!c.world.bs?.complete && (!f || c.world.bs?.hearth === f.id || !f.lit);
  if (inBed) { tx = bed.x; ty = bed.y; } // ADR-252 / ADR-244: the bed in the roofed base (by the hearth): lie down with the Rest edge
  else if (b && f && c.world.bs?.hearth === f.id) { tx = b.x + HEARTH_SIT.x; ty = b.y + HEARTH_SIT.y; }
  else if (f && (f.lit || !c.world.bs?.door)) { tx = f.x - 1.1; ty = f.y + 0.4; }
  if (c.world.stance === StanceMode.Sleep) { stop(o); o.actions.push("sleep"); }
  else if (goTo(c, o, tx, ty, 0.8) < (inBed ? 1.2 : 0.9) || stuckOn(c, tx, ty, 200)) { stop(o); o.aimX = 0; o.aimY = 0; o.actions.push("sleep"); if (inBed) o.actions.push("rest"); }
  if (night(c.self.phase) < 0.5) return false;
}
/** ADR-252: the cold hours (h15-h7.5) with a base fire in reach: stay by it and keep it stocked, like a player banking the hearth. */
function bankHours(c: Ctx): boolean {
  const w = worldOf(c); if (!w) return false; const t = sunFractionOf(timeOfDay(w)); if (t < 0.62 && t >= 0.31) return false;
  const f = c.world.bs?.stations.get(StationKind.Campfire); if (!f || Math.hypot(f.x - c.self.x, f.y - c.self.y) > 400) return false; // far bots walk home for the night
  const sw = plannerIndex(gdefs(c)).item.get("wood")?.id; const sb = sw !== undefined ? (c.world.bs?.storage?.counts.get(sw) ?? 0) : 0;
  return f.lit || (c.world.woodTotal ?? 0) > 0 || sb > 0;
}
/** Any way to get warm right now: a fire (lit, or unlit with wood to hand), the finished base, or campfire materials in the bag. */
function warmOption(c: Ctx): boolean {
  const near = (x: number, y: number): boolean => Math.hypot(x - c.self.x, y - c.self.y) < 60; const woodN = c.world.woodTotal ?? 0;
  const st = c.world.bs?.stations.get(StationKind.Campfire); const vf = c.world.fire; const camp = c.bb.get<{ x: number; y: number }>("camp");
  const sbWood = (() => { const w = plannerIndex(gdefs(c)).item.get("wood")?.id; return w !== undefined ? (c.world.bs?.storage?.counts.get(w) ?? 0) : 0; })();
  for (const f of [st, vf]) if (f && near(f.x, f.y) && (f.lit || woodN > 0 || sbWood > 0)) return true;
  if (camp && near(camp.x, camp.y) && woodN > 0) return true;
  const b = c.world.base; if (b && c.world.bs?.complete && near(b.x, b.y)) return true;
  return woodN >= 7 && (c.world.stoneTotal ?? 0) >= 4;
}
function warmRun(c: Ctx, o: { moveX: number; moveY: number; aimX: number; aimY: number; actions: string[] }): boolean | void {
  if (!c.bb.get("warming")) return false;
  const wd = worldOf(c); if (!wd) return false; const ix = plannerIndex(gdefs(c)); const wood = ix.item.get("wood")?.id; const woodN = c.world.woodTotal ?? 0;
  const st = c.world.bs?.stations.get(StationKind.Campfire); const vf = c.world.fire;
  let f: { id: number; x: number; y: number; lit: boolean } | undefined = st ? { id: st.id, x: st.x, y: st.y, lit: st.lit } : vf;
  const camp = c.bb.get<{ id: number; x: number; y: number }>("camp"); // a fire lit on the road
  if (camp && wd.isAlive(camp.id as Entity) && (!f || Math.hypot(camp.x - c.self.x, camp.y - c.self.y) < Math.hypot(f.x - c.self.x, f.y - c.self.y))) {
    const fa = resolveAttachment(wd, camp.id as Entity, AttachKind.Fire); f = { ...camp, lit: (fa !== undefined && (wd.getField(fa, Fuel, "lit") ?? 0) > 0) }; }
  const fd = f ? Math.hypot(f.x - c.self.x, f.y - c.self.y) : Infinity;
  const b0 = c.world.base; const atHearth = !!b0 && st !== undefined && c.world.bs?.hearth === st.id && f?.id === st.id;
  const bank = bankHours(c) && st !== undefined && f?.id === st.id;
  if (bank && f && f.lit && st!.fuelTicks < 16000 && wood !== undefined && woodN > 0 && c.self.tick - c.bb.num("bankAt", -1e9) > 100) { // top the burning fire up for the night
    if (goTo(c, o, f.x, f.y, 1) > 2) { if (stuckOn(c, f.x, f.y)) c.bb.set("bankAt", c.self.tick); return; } stop(o);
    if (containerSeq(c, o, f.id, storageDepositActions(f.id as Entity, wood, Math.min(50, woodN)))) { mark(c, "refuels"); c.bb.set("bankAt", c.self.tick); } return; }
  if (f && f.lit && fd < 60) { const ux = fd > 0.05 ? (c.self.x - f.x) / fd : -1, uy = fd > 0.05 ? (c.self.y - f.y) / fd : 0; // sit close on our own side (heat falls off linearly, walls occlude)
    const tx = atHearth ? b0!.x + HEARTH_SIT.x : f.x + ux * 0.6, ty = atHearth ? b0!.y + HEARTH_SIT.y : f.y + uy * 0.6; if (goTo(c, o, tx, ty, 1) < 0.25 || stuckOn(c, tx, ty, 200)) stop(o); return; }
  if (f && !f.lit && wood !== undefined && woodN > 0 && fd < 60) {
    if (goTo(c, o, f.x, f.y, 1) > 2) { if (stuckOn(c, f.x, f.y)) c.bb.set("warming", false); return; } stop(o);
    if (containerSeq(c, o, f.id, depositAndLight(f.id, wood, Math.min(bank ? 50 : 8, woodN)))) mark(c, "refuels"); return; }
  const sb = c.world.bs?.storage; // no wood in the bag: fetch some from the box (same container panel steps as a player)
  if (f && (!f.lit || bank && st!.fuelTicks < 16000) && wood !== undefined && woodN === 0 && sb && (sb.counts.get(wood) ?? 0) > 0 && fd < 60 && c.self.tick - c.bb.num("bankAt", -1e9) > 100) {
    if (goTo(c, o, sb.x, sb.y) > 1.6) { if (stuckOn(c, sb.x, sb.y)) c.bb.set("warming", false); return; } stop(o);
    if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, wood, Math.min(bank ? 50 : 12, sb.counts.get(wood)!)))) mark(c, "withdraws"); return; }
  const b = c.world.base;
  if (b && c.world.bs?.door && c.world.bs.complete && Math.hypot(b.x - c.self.x, b.y - c.self.y) < 60) { const h = { x: b.x + 1, y: b.y + 1 }; if (goTo(c, o, h.x, h.y, 1) < 0.5) stop(o); return; }
  // far from any fire: make camp like a player would (campfire from the bag, then light it)
  const cf = ix.piece.get("campfire"); const sw = ix.item.get("stone")?.id;
  if (cf && wood !== undefined && sw !== undefined && woodN >= 7 && c.self.tick - c.bb.num("campBuildAt", -1e9) > 200) {
    if ((c.world.stoneTotal ?? 0) >= 4) { const x = c.self.x + 1.2, y = c.self.y; stop(o); o.aimX = 1.2; o.aimY = 0; o.actions.push(`build:${cf.id}:${x}:${y}:0:0:0`); c.bb.set("campBuildAt", c.self.tick);
      c.bb.set("campPending", { x, y, t: c.self.tick }); return; } }
  const cp = c.bb.get<{ x: number; y: number; t: number }>("campPending");
  if (cp && cf && c.self.tick - cp.t < 100) { for (const e of installSpatialIndex(wd).queryRadius(cp.x, cp.y, 1.5)) if (wd.getField(e, BuildPiece, "type") === cf.id) { const p = wd.get(e, Transform)!; c.bb.set("camp", { id: e, x: p.x, y: p.y }); c.bb.set("campPending", undefined); break; } stop(o); return; }
  const h = c.world.home; goTo(c, o, h.x, h.y, 1);
}
/** return_home that respects the door. */
export function baseReturnRun(c: Ctx, o: { moveX: number; moveY: number; aimX: number; aimY: number; actions: string[] }): boolean | void {
  const h = c.world.home; const b = c.world.base; const tx = b && !c.world.bs?.door ? b.x + 1 : h.x, ty = b && !c.world.bs?.door ? b.y + 3.4 : h.y;
  if (goTo(c, o, tx, ty, 1) < 2 || stuckOn(c, tx, ty, 100)) return false;
}
const worldRef = new WeakMap<Agent, World>();
export function bindAgentWorld(a: Agent, w: World): void { worldRef.set(a, w); }
const worldOf = (c: Ctx): World | undefined => worldRef.get(c.agent);
/** ADR-321: the world an agent was bound to (fillGoalSensors), for policies that probe terrain / structures live. */
export const agentWorld = worldOf;
import { GameplayConfig } from "../config.js";
const gdefs = (c: Ctx): GameDefs => worldOf(c)!.getResource(GameplayConfig)!.defs;
