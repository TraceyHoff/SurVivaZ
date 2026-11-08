import { fillHireSensors } from "./hire_behaviors.js";
/**
 * ADR-203: needs-driven autonomy for AI humans (virtual players). Sensors here pick concrete goals from the bot's own
 * view (gather node that yields a missing ingredient, water tile, a tool to hold, a damaged piece to repair); behaviors
 * turn them into the same inputs / commands a human sends (gather button, gameplay.use NO_SLOT by water, gameplay.equip,
 * gameplay.repair), so every rule (reach, tools, recipes, placement, costs) stays server-validated.
 * Stuck detection: a movement goal must get 0.5 tiles closer every STUCK_TICKS or it is banned / shifted and re-planned.
 * Cost: sensors run only on think ticks (AgentController thinkBudget / thinkEvery time-slicing) and scan bounded sets
 * (the agent's memory, a 7x7 water probe grid when thirsty, pieces near home).
 */
import { Transform, entityIndex, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { AttachKind, BuildPiece, Equipment, Exposure, Fuel, NO_SLOT, ResourceNode, Survival, Worker, WorkerOrder, WorkerJob } from "../components.js";
import { GameplayConfig } from "../config.js";
import { countItem, readSlots } from "../inventory.js";
import { bareHandsCan, heldTool } from "../systems/gathering.js";
import { nearWater } from "../systems/vitals.js";
import { ToolKind, type GameDefs, type ItemDef, type PieceDef, type RecipeDef, type ResourceDef } from "../defs.js";
import { hasOwnClaim, pieceCost, pieceUnlocked } from "../building/place.js";
import { StructureIndexRes } from "../building/structure.js";
import { bumpStat } from "./planner.js";
import { maxHpOf } from "../building/integrity.js";
import { nearbyAbandonedWork } from "../building/abandoned.js";
import { resolveAttachment } from "../building/links.js";
import { armCraft, goTo, bindAgentWorld, fillPlanSensors, noteTripWanted } from "./base_behaviors.js";

export interface GoalSensors {
  gatherNode?: { id: number; x: number; y: number; wanted: boolean };
  waterAt?: { x: number; y: number };
  equipSlot?: number;
  repairTarget?: { id: number; x: number; y: number };
  reclaimTarget?: { id: number; x: number; y: number };
  gatherScanned?: boolean;
  /** body temperature under COLD_BELOW (night without a fire / clothes) */
  cold?: boolean;
  /** body / felt temperature (Survival.bodyTemp, Exposure.feltTemp) for warm_up */
  chill?: { body: number; felt: number };
  /** the campfire at home (lit = Fuel.lit) */
  fire?: { id: number; x: number; y: number; lit: boolean };
  /** no campfire near home yet */
  fireMissing?: boolean;
  /** wood (fuel) in the bag */
  woodSlot?: { item: number; count: number };
  /** items the current goal (tool, then campfire) still lacks */
  needs?: number[];
}
/** Tools / weapons an AI human works toward, in order (hand recipes, the same RecipeDef rules players craft by). */
export const GOAL_CRAFTS = ["stone_axe", "stone_pickaxe", "stone_spear"] as const;
/** ADR-217: goal tools before the home campfire. Wood now comes from trees (an axe job), so the order is axe -> campfire -> rest. */
export const FIRE_AFTER_GOALS = 1;
export const STUCK_TICKS = 60;
export const COLD_BELOW = 36.3;
/** Hosts re-home an AI human that ends up farther than this from its home spot (spawn moved / account restored). */
export const HOME_MAX_DIST = 48;
const BAN_TICKS = 1200;

type Ctx = AgentContext<AgentWorldView>;
const bans = (bb: Agent["bb"]): Map<number, number> => { let m = bb.get<Map<number, number>>("nodeBan"); if (!m) { m = new Map(); bb.set("nodeBan", m); } return m; };
export function banNode(c: Ctx, id: number): void { bans(c.bb).set(id, c.self.tick + BAN_TICKS); c.memory.items.delete(id); }

/** True when the agent has not closed 0.5 tiles on (tx, ty) for STUCK_TICKS while trying to move there. */
export function stuckOn(c: Ctx, tx: number, ty: number, window = STUCK_TICKS): boolean {
  const d = Math.hypot(tx - c.self.x, ty - c.self.y); const k = c.bb.get<{ t: number; d: number; tx: number; ty: number }>("prog");
  if (!k || Math.abs(k.tx - tx) > 0.01 || Math.abs(k.ty - ty) > 0.01 || d < k.d - 0.5) { c.bb.set("prog", { t: c.self.tick, d, tx, ty }); return false; }
  if (c.self.tick - k.t <= window) return false;
  c.bb.set("prog", undefined); c.bb.set("stuckCount", c.bb.num("stuckCount") + 1); return true;
}

/** Fill GoalSensors (think ticks only). `a` is the agent (memory + blackboard). */
type DefIndex = { items: Map<string, ItemDef>; recipeFor: Map<number, RecipeDef>; campfire?: PieceDef; foods: number[] };
const defIndexes = new WeakMap<object, DefIndex>();
/** Key / output lookups built once per defs object (the per-view linear scans cost ~0.3 ms per bot). */
function defIndex(defs: GameDefs): DefIndex {
  let ix = defIndexes.get(defs); if (ix) return ix;
  ix = { items: new Map(), recipeFor: new Map(), foods: [] };
  for (const d of defs.items.values()) { ix.items.set(d.key, d); if (d.food && d.food.hunger > 0 && d.food.health >= 0) ix.foods.push(d.id); }
  for (const r of defs.recipes.values()) if (!ix.recipeFor.has(r.output.item)) ix.recipeFor.set(r.output.item, r);
  { const cf = [...defs.pieces.values()].find((p) => p.key === "campfire"); if (cf) ix.campfire = cf; }
  defIndexes.set(defs, ix); return ix;
}
/** Goal sensors refresh every SENSE_EVERY ticks per agent (16 bots: ~3 ms/tick -> ~0.3); behaviours tolerate the lag (stuck / fail re-plan). */
export const SENSE_EVERY = 10;
/** One alloc-free pass over build pieces near a home (campfire within 6, weakest piece < 60% within 8), shared per home for HOME_SCAN_EVERY ticks. */
const HOME_SCAN_EVERY = 30;
const homeScans = new WeakMap<World, Map<string, { tick: number; fire?: Entity; repair?: Entity }>>();
function homeScan(world: World, defs: GameDefs, hx: number, hy: number, fireType: number): { fire?: Entity; repair?: Entity } {
  let m = homeScans.get(world); if (!m) homeScans.set(world, (m = new Map()));
  const key = `${hx},${hy}`; const c = m.get(key);
  if (c && world.tick - c.tick < HOME_SCAN_EVERY && world.tick >= c.tick && (c.fire === undefined || world.isAlive(c.fire))) return c;
  const tf = world.store(Transform); const r: { tick: number; fire?: Entity; repair?: Entity } = { tick: world.tick }; let fd = 36;
  for (const e of world.query([BuildPiece, Transform])) {
    const ts = tf.slot(entityIndex(e)); const dx = tf.data.x[ts]! - hx, dy = tf.data.y[ts]! - hy, d2 = dx * dx + dy * dy; if (d2 > 64) continue;
    const type = world.getField(e, BuildPiece, "type")!;
    if (type === fireType && d2 < fd) { fd = d2; r.fire = e; }
    if (r.repair === undefined) { const def = defs.pieces.get(type); if (def?.hp && world.getField(e, BuildPiece, "hp")! < maxHpOf(world, e) * 0.6) r.repair = e; }
  }
  if (m.size > 256) m.clear(); m.set(key, r); return r;
}
const SENSOR_KEYS = ["plan", "base", "bs", "craftCount", "craftTicks", "huntTarget", "panel", "tripWanted", "surplus", "woodTotal", "stoneTotal", "junk", "winter", "craftRecipe", "buildPlan", "gatherNode", "gatherScanned", "waterAt", "equipSlot", "repairTarget", "reclaimTarget", "needs", "cold", "chill", "fire", "fireMissing", "woodSlot"] as const;
const sensed = new WeakMap<Agent, { tick: number; home: string; s: Partial<GoalSensors> }>();
export function fillGoalSensors(world: World, self: Entity, view: AgentWorldView, a: Agent): void {
  const wk = world.get(self, Worker); const order = world.getArray(self, WorkerOrder, "selections");
  const home = `${view.home.x},${view.home.y}:${wk?.owner ?? 0}:${wk?.job ?? 0}:${order ? Array.from(order).join(",") : ""}:${(world.getField(self, Survival, "hunger") ?? 100) < 55}:${(world.getField(self, Survival, "thirst") ?? 100) < 60}`; const c = sensed.get(a);
  if (c && world.tick - c.tick < SENSE_EVERY && world.tick >= c.tick && c.home === home) { for (const k of SENSOR_KEYS) if (!(k in c.s)) delete view[k]; Object.assign(view, c.s); return; } // a cached pass must also clear what the planner removed (fillAgentSensors refills legacy craftRecipe / buildPlan every tick)
  computeGoalSensors(world, self, view, a);
  const s: Partial<GoalSensors> = {}; for (const k of SENSOR_KEYS) if (view[k] !== undefined) (s as Record<string, unknown>)[k] = view[k];
  sensed.set(a, { tick: world.tick, home, s });
}
/** Expected count of `needs` items one successful swing yields (bare hands: first yield only, x yieldMul, / cooldownMul). */
function wantedYield(defs: GameDefs, def: ResourceDef, needs: ReadonlySet<number>, bare: boolean): number {
  const bh = defs.bareHands; let n = 0;
  def.yields.forEach((y, i) => {
    if (!needs.has(y.item) || (bare && i > 0)) return; const avg = y.chance * (y.min + y.max) / 2;
    n += bare ? Math.max(bh.minYield, Math.floor(avg * bh.yieldMul)) / bh.cooldownMul : avg;
  });
  return n;
}
function computeGoalSensors(world: World, self: Entity, view: AgentWorldView, a: Agent): void {
  const cfg = world.getResource(GameplayConfig); const t = world.get(self, Transform); if (!cfg || !t) return; const defs = cfg.defs;
  let slots: ReturnType<typeof readSlots>; try { slots = readSlots(world, self); } catch { return; }
  const ix = defIndex(defs); const item = (key: string) => ix.items.get(key);
  const have = (id: number): number => countItem(world, self, id);
  // needs: first missing goal tool's ingredients, then the campfire's cost, then food when the bag has none
  const needs = new Set<number>();
  const fire = ix.campfire;
  const hs = homeScan(world, defs, view.home.x, view.home.y, fire?.id ?? -1); const fe = hs.fire;
  const fireCost = (): void => { if (fire && fe === undefined && !(view as { base?: unknown }).base) for (const c of pieceCost(defs, fire, 0)) if (have(c.item) < c.count) needs.add(c.item); };
  let gi = 0;
  for (const key of GOAL_CRAFTS) {
    if (gi++ === FIRE_AFTER_GOALS) { fireCost(); if (needs.size) break; }
    const out = item(key); if (!out || have(out.id) > 0) continue;
    const r = ix.recipeFor.get(out.id); if (!r) continue;
    for (const g of r.ingredients) if (have(g.item) < g.count) needs.add(g.item);
    if (needs.size) break;
  }
  const body = world.getField(self, Survival, "bodyTemp") ?? 37; view.cold = body < COLD_BELOW;
  view.chill = { body, felt: world.getField(self, Exposure, "feltTemp") ?? 20 };
  if (fe !== undefined) { const p = world.get(fe, Transform)!; view.fire = { id: fe, x: p.x, y: p.y, lit: (world.getField(resolveAttachment(world, fe, AttachKind.Fire) ?? fe, Fuel, "lit") ?? 0) > 0 }; } // Fuel lives on the fire attachment
  else view.fireMissing = true;
  fireCost(); // ADR-252: a base bot's planner owns the campfire (fireCost skips it)
  if (view.food === undefined) for (const id of ix.foods) needs.add(id);
  if (needs.size) view.needs = [...needs];
  const wood = item("wood"); if (wood) { const n = have(wood.id); if (n > 0) view.woodSlot = { item: wood.id, count: n };
    if (view.fire && !view.fire.lit && n < 4) { view.needs = [wood.id, ...(view.needs ?? []).filter((x) => x !== wood.id)]; } } // fuel for the night
  // ADR-252: the planner owns needs / hand crafts / base pieces (needs = leaves of the first unmet goal)
  bindAgentWorld(a, world);
  { const pn = fillPlanSensors(world, self, view, a, defs, slots); if (pn) { needs.clear(); for (const x of pn) needs.add(x); if (view.food === undefined && view.bs?.stations.has(1)) for (const id of ix.foods) needs.add(id); if (needs.size) view.needs = [...needs]; else delete view.needs; } }
  // Owner earthwork leaves must be installed BEFORE gathering is selected, not one sensor later.
  if (world.getField(self, Worker, "owner") && world.getField(self, Worker, "job") === WorkerJob.Maintain) fillHireSensors(world, self, view, a);
  // ADR-259: employment replaces the personal building ladder, never survival food needs.
  const worker = world.get(self, Worker); const selected = Array.from(world.getArray(self, WorkerOrder, "selections") ?? []).filter(Boolean);
  const hungry = view.food === undefined && (world.getField(self, Survival, "hunger") ?? 100) < 55;
  let jobItems: Set<number> | undefined;
  if (worker?.owner) {
    needs.clear();
    if (worker.job === WorkerJob.Gather && selected.length) jobItems = new Set(selected);
    if (worker.job === WorkerJob.Craft && selected.length) {
      jobItems = new Set(selected.flatMap((id) => { const r = defs.recipes.get(id); return r && !have(r.output.item) ? r.ingredients.filter((g) => have(g.item) < g.count).map((g) => g.item) : []; }));
    }
    if (worker.job === WorkerJob.Maintain && view.plan) jobItems = new Set(view.plan.leaves);
    if (jobItems) for (const id of jobItems) needs.add(id);
    if (hungry) for (const id of ix.foods) needs.add(id);
    delete view.gatherNode;
  }
  // gather target from memory (bounded), skipping banned / empty / tool-locked nodes; wanted yields win within ~20 tiles
  const ban = bans(a.bb); const tool = heldTool(world, self, defs); let best: GoalSensors["gatherNode"], bs = Infinity;
  // ADR-217: best tool of each kind in the bag (trees are worked with the axe, not fists) -> switch to it for that node
  const carried = new Map<number, { slot: number; tier: number }>();
  for (let i = 0; i < slots.items.length; i++) { const tl = slots.items[i] && slots.counts[i] ? defs.items.get(slots.items[i]!)?.tool : undefined; if (tl && tl.kind !== ToolKind.None && (carried.get(tl.kind)?.tier ?? -1) < tl.tier) carried.set(tl.kind, { slot: i, tier: tl.tier }); }
  let bestNeeds: { slot: number } | undefined;
  for (const p of a.memory.items.values()) {
    if (p.kind !== "node") continue; const until = ban.get(p.id); if (until !== undefined) { if (until > world.tick) continue; ban.delete(p.id); }
    if (!world.isAlive(p.id) || !world.has(p.id, ResourceNode) || world.getField(p.id, ResourceNode, "amount") === 0) continue;
    const def = defs.resources.get(world.getField(p.id, ResourceNode, "kind")!); if (!def) continue;
    const bagTool = def.requiredTool !== ToolKind.None && !(tool.kind === def.requiredTool && tool.tier >= def.minTier) ? carried.get(def.requiredTool) : undefined;
    const withTool = def.requiredTool === ToolKind.None || (tool.kind === def.requiredTool && tool.tier >= def.minTier) || (bagTool !== undefined && bagTool.tier >= def.minTier);
    const bare = !withTool && bareHandsCan(defs, def);
    if (!withTool && !bare) continue;
    const foodNode = hungry && def.yields.some((y) => ix.foods.includes(y.item));
    if (worker?.owner) {
      if (jobItems && !def.yields.some((y, i) => jobItems.has(y.item) && (!bare || i === 0)) && !foodNode) continue;
      if (worker.job !== WorkerJob.Gather && worker.job !== WorkerJob.Craft && !(worker.job === WorkerJob.Maintain && view.plan) && !foodNode) continue;
    }
    const wanted = def.yields.some((y) => needs.has(y.item));
    if (!wanted && needs.size && def.yields[0] && have(def.yields[0].item) >= 8) continue; // stocked up: explore for what the goal needs
    // ADR-217: a wanted node's pull scales with how much of the needed items one swing is worth (an axe on a tree beats
    // picking twigs for an odd log; punching a tree only drops its first yield, at reduced rate and slower)
    const s = Math.hypot(p.x - t.x, p.y - t.y) - (wanted ? 20 * Math.min(1, wantedYield(defs, def, needs, bare)) : 0);
    if (s < bs || (s === bs && best && p.id < best.id)) { bs = s; best = { id: p.id, x: p.x, y: p.y, wanted }; bestNeeds = bagTool !== undefined && bagTool.tier >= def.minTier ? bagTool : undefined; }
  }
  view.gatherScanned = true; if (best) view.gatherNode = best;
  if (bestNeeds) view.equipSlot = bestNeeds.slot; // the inventory "Equip" a player taps before chopping
  noteTripWanted(view, needs, !!best?.wanted);
  // ADR-176 water: thirsty without a drink in the bag -> nearest tile next to water on a coarse 7x7 grid (2.5 tile step)
  const sv = view as { water?: number }; const thirst = (world.getField(self, Survival, "thirst") ?? 100) / 100;
  if (sv.water === undefined && thirst < 0.6) {
    let wb: { x: number; y: number } | undefined, wd = Infinity;
    for (let gy = -3; gy <= 3; gy++) for (let gx = -3; gx <= 3; gx++) { const x = t.x + gx * 2.5, y = t.y + gy * 2.5; const d = gx * gx + gy * gy; if (d < wd && nearWater(world, x, y)) { wd = d; wb = { x, y }; } }
    if (wb) view.waterAt = wb;
  }
  // hold the best tool / weapon when the main hand is empty (gameplay.equip, the inventory "Equip" a player taps)
  if (view.equipSlot === undefined && (world.getField(self, Equipment, "mainHandSlot") ?? NO_SLOT) === NO_SLOT) {
    let bi = -1, bsc = 0;
    for (let i = 0; i < slots.items.length; i++) { const d = slots.items[i] ? defs.items.get(slots.items[i]!) : undefined; if (!d || !slots.counts[i]) continue; const sc = (d.weapon?.damage ?? 0) + (d.tool ? 5 + d.tool.tier : 0); if (sc > bsc) { bsc = sc; bi = i; } }
    if (bi >= 0) view.equipSlot = bi;
  }
  // repair: own-base pieces under 60% hp near home (gameplay.repair; the server charges the cost)
  const canFix = (e: Entity): boolean => {
    const bp = world.get(e, BuildPiece); const tf = world.get(e, Transform); if (!bp || !tf) return false;
    const def = defs.pieces.get(bp.type); return !!def && hasOwnClaim(world, self, tf.x, tf.y) && pieceUnlocked(world, self, def, bp.tier);
  };
  if (hs.repair !== undefined && world.isAlive(hs.repair) && canFix(hs.repair)) { const p = world.get(hs.repair, Transform); if (p) view.repairTarget = { id: hs.repair, x: p.x, y: p.y }; }
  const selfT = world.get(self, Transform);
  if (selfT) {
    const work = nearbyAbandonedWork(world, selfT.x, selfT.y);
    if (work) {
      // Unclaimed ruins: reclaim after the bot has a tool or a base so day-one gather/craft still runs.
      if (work.repair !== undefined && !view.repairTarget && !work.reclaim && world.isAlive(work.repair) && canFix(work.repair)) {
        const p = world.get(work.repair, Transform);
        if (p) view.repairTarget = { id: work.repair, x: p.x, y: p.y };
      }
      if (work.reclaim && hasOwnClaim(world, self, work.x, work.y) && GOAL_CRAFTS.some((k) => { const it = item(k); return !!it && have(it.id) > 0; })) {
        view.reclaimTarget = { id: work.marker, x: work.x, y: work.y };
      }
    }
  }
}
// Task 29: pieceAt memo. fillAgentSensors asks for the same (type, home, 6) up to 4x per bot view rebuild,
// and the uncached scan is ~100us in a busy base (a full BuildPiece query + a Transform copy per piece).
// Results only change when pieces are placed/removed, which bumps StructureIndex.version — tier upgrades
// neither move nor retype pieces, so they correctly leave the memo alone. Worlds without a
// StructureIndex (minimal test worlds) skip the memo and just take the cheaper scan. Cached hits are
// re-validated with isAlive so a piece destroyed outside removePiece never comes back stale.
const pieceAtMemo = new WeakMap<World, { version: number; map: Map<string, Entity | undefined> }>();
export function pieceAt(world: World, type: number, x: number, y: number, r: number): Entity | undefined {
  const key = `${type}|${x}|${y}|${r}`;
  const si = world.getResource(StructureIndexRes);
  let memo: Map<string, Entity | undefined> | undefined;
  if (si) {
    let entry = pieceAtMemo.get(world);
    if (!entry || entry.version !== si.version) { entry = { version: si.version, map: new Map() }; pieceAtMemo.set(world, entry); }
    memo = entry.map;
    if (memo.has(key)) { const hit = memo.get(key); if (hit === undefined || world.isAlive(hit)) return hit; memo.delete(key); }
    if (memo.size > 128) memo.clear();
  }
  const bp = world.store(BuildPiece); const tf = world.store(Transform);
  for (const e of world.query([BuildPiece, Transform])) {
    const i = entityIndex(e);
    if (bp.read(i, "type") !== type) continue;
    const s = tf.slot(i); const dx = tf.data.x[s]! - x, dy = tf.data.y[s]! - y;
    if (dx * dx + dy * dy < r * r) { memo?.set(key, e); return e; }
  }
  memo?.set(key, undefined);
  return undefined;
}
export const pieceNear = (world: World, type: number, x: number, y: number, r: number): boolean => pieceAt(world, type, x, y, r) !== undefined;

const toward = (o: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const cooled = (tick: number, at: number, ticks: number): number => (tick - at >= ticks ? 1 : 0);
const night = (p: string): number => (p === "night" ? 1 : p === "dusk" ? 0.6 : 0);

/**
 * Instant chores (craft a goal recipe, equip a tool, eat / drink from the bag) take one command and no walking, so they
 * ride along with whatever long behavior is running instead of having to out-score it (gather's schedule bonus +
 * inertia always won, so bots carried axe materials for minutes without crafting). Same cooldowns as the behaviors.
 */
export function instantChores(c: Ctx, o: { actions: string[] }): void {
  const w = c.world, t = c.self.tick; c.bb.set("hungerSeen", c.self.hunger);
  if (w.equipSlot !== undefined && t - c.bb.num("equipAt", -1e9) >= 100) { o.actions.push(`equip:${w.equipSlot}`); c.bb.set("equipAt", t); }
  if (w.craftRecipe !== undefined && t - c.bb.num("craftedAt", -1e9) >= Math.max(100, w.craftTicks ?? 0)) { const n = w.craftCount ?? 1; o.actions.push(n > 1 ? `craft:${w.craftRecipe}:${n}` : `craft:${w.craftRecipe}`); c.bb.set("craftedAt", t); if (w.plan) armCraft(c); }
  // Task 25: dye it (the sensor only sets view.dye while the bot holds a dye + brush and still wants today's colour;
  // the command re-validates brush + dye server-side, so a stale sensor can never spend a dye the bot no longer has).
  if (w.dye !== undefined && t - c.bb.num("dyedAt", -1e9) >= 200) { o.actions.push(`dye:${w.dye.kind}:${w.dye.slot}:${w.dye.palette}:${w.dye.index}`); c.bb.set("dyedAt", t); }
  if (w.junk && t - c.bb.num("dropAt", -1e9) >= 30) { o.actions.push(`drop:${w.junk.item}:${w.junk.count}`); c.bb.set("dropAt", t); } // ADR-252: a full bag drops what no goal uses
  if (w.food !== undefined && c.self.hunger < 0.5 && t - c.bb.num("ateAt", -1e9) >= 40) { o.actions.push(`eat:${w.food}`); c.bb.set("ateAt", t); }
  if (w.water !== undefined && c.self.thirst < 0.5 && t - c.bb.num("drankAt", -1e9) >= 40) { o.actions.push(`drink:${w.water}`); c.bb.set("drankAt", t); }
}

/** ADR-252 / ADR-244: melee rhythm: DEFEND_STRIKE ticks striking, then the rest of the DEFEND_CYCLE behind a held guard (block: -70 % melee from the front, costs stamina) while stamina lasts. */
export const DEFEND_CYCLE = 30, DEFEND_STRIKE = 10, DEFEND_MIN_STAMINA = 0.25;
export function defendAction(c: Ctx): "gather" | "block" {
  const t = c.self.tick; let from = c.bb.get<number>("fightFrom"); if (from === undefined) { from = t; c.bb.set("fightFrom", t); } c.bb.set("fightSeen", t);
  return (t - from) % DEFEND_CYCLE >= DEFEND_STRIKE && c.self.stamina > DEFEND_MIN_STAMINA ? "block" : "gather";
}
/** defend, drink_water, equip, repair. */
export function autonomyBehaviors(): GameBehavior[] {
  return [
    { name: "defend", inertia: 0.3, traits: { bravery: 1 }, considerations: [
        { name: "zombieClose", curve: { type: "inverse" }, input: (c) => { const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); return z ? Math.hypot(z.x - c.self.x, z.y - c.self.y) / 8 : 1; } },
        { name: "healthy", curve: { type: "step", at: 0.45 }, input: (c) => c.self.hp }],
      run: (c, o) => {
        const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); if (!z || c.self.hp < 0.35) return false;
        const d = goTo(c, o, z.x, z.y, 1); if (d > 10) return false;
        if (d < 1.3) {
          o.moveX = 0; o.moveY = 0; o.aimX = (z.x - c.self.x) / Math.max(d, 1e-6); o.aimY = (z.y - c.self.y) / Math.max(d, 1e-6);
          o.actions.push(defendAction(c) === "block" ? "block" : `attack:${z.id}`);
        } // Dedicated combat primary, not the hand/interact gather action; then guard.
        else if (c.self.tick - c.bb.num("fightSeen", -1e9) > DEFEND_CYCLE) c.bb.set("fightFrom", undefined);
      } },
    // dusk / night or cold: fuel and light the home campfire (open -> deposit wood -> toggle, the station panel's steps)
    { name: "tend_fire", inertia: 0.4, considerations: [
        { name: "unlit", weight: 1.6, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.fire && !c.world.fire.lit && !(c.world as { base?: unknown }).base && cooled(c.self.tick, c.bb.num("fireAt", -1e9), 150) ? 1 : 0) }, // ADR-252: a base bot's warm_up tends its fires (door-aware)
        { name: "needed", curve: { type: "step", at: 0.5 }, input: (c) => (night(c.self.phase) > 0 || c.world.cold || c.world.winter ? 1 : 0) }, // ADR-252: winter days too
        { name: "hasWood", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.woodSlot !== undefined ? 1 : 0) }],
      run: (c, o) => {
        const f = c.world.fire; if (!f || f.lit) { c.bb.set("fireAt", c.self.tick); c.bb.set("fireStep", 0); return false; }
        if (goTo(c, o, f.x, f.y, 0.8) > 1.6) { if (stuckOn(c, f.x, f.y)) { c.bb.set("fireAt", c.self.tick); return false; } return; }
        o.moveX = 0; o.moveY = 0; const at = c.bb.num("fireStepAt", -1e9); if (c.self.tick - at < 8) return;
        const step = c.self.tick - at > 60 ? 0 : c.bb.num("fireStep"); // a stale sequence restarts
        if (o.actions.some((a) => /^c(open|close|deposit|withdraw)(:|$)/.test(a))) return;
        c.bb.set("fireStepAt", c.self.tick); c.bb.set("fireStep", step + 1);
        if (step === 0) o.actions.push(`copen:${f.id}`);
        else if (step === 1 && c.world.woodSlot) o.actions.push(`cdeposit:${f.id}:${c.world.woodSlot.item}:${Math.min(8, c.world.woodSlot.count)}`);
        else if (step === 2) o.actions.push(`fire:${f.id}`);
        else { o.actions.push(`cclose:${f.id}`); c.bb.set("fireAt", c.self.tick); c.bb.set("fireStep", 0); return false; }
      } },
    { name: "drink_water", inertia: 0.2, considerations: [
        { name: "thirsty", curve: { type: "logistic", k: 12, mid: 0.55 }, input: (c) => { c.bb.set("thirstSeen", c.self.thirst); return 1 - c.self.thirst; } },
        { name: "waterKnown", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.waterAt ? 1 : 0) }],
      run: (c, o) => {
        const w = c.world.waterAt; if (!w || c.self.thirst > 0.95) return false;
        if (goTo(c, o, w.x, w.y, 0.9) > 0.8) { if (stuckOn(c, w.x, w.y)) return false; return; }
        o.moveX = 0; o.moveY = 0; if (cooled(c.self.tick, c.bb.num("drankAt", -1e9), 20)) { o.actions.push(`drink:${NO_SLOT}`); c.bb.set("drankAt", c.self.tick); }
      } },
    { name: "equip", inertia: 0, considerations: [
        { name: "toolInBag", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.equipSlot !== undefined ? cooled(c.self.tick, c.bb.num("equipAt", -1e9), 100) : 0) }],
      run: (c, o) => { if (c.world.equipSlot === undefined) return false; o.actions.push(`equip:${c.world.equipSlot}`); c.bb.set("equipAt", c.self.tick); return false; } },
    { name: "repair", traits: { industriousness: 0.5 }, considerations: [
        { name: "damaged", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.repairTarget ? cooled(c.self.tick, c.bb.num("repairAt", -1e9), 100) : 0) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const r = c.world.repairTarget; if (!r) return false;
        if (goTo(c, o, r.x, r.y, 0.8) > 2) { if (stuckOn(c, r.x, r.y)) { c.bb.set("repairAt", c.self.tick); return false; } return; }
        o.moveX = 0; o.moveY = 0; o.actions.push(`repair:${r.id}`); c.bb.set("repairAt", c.self.tick); if (c.world.base) bumpStat(c.agent, "repairs", c.self.tick); return false;
      } },
    { name: "reclaim", traits: { industriousness: 0.45 }, considerations: [
        { name: "site", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.reclaimTarget ? cooled(c.self.tick, c.bb.num("reclaimAt", -1e9), 100) : 0) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const r = c.world.reclaimTarget; if (!r) return false;
        if (goTo(c, o, r.x, r.y, 0.8) > 2) { if (stuckOn(c, r.x, r.y)) { c.bb.set("reclaimAt", c.self.tick); return false; } return; }
        o.moveX = 0; o.moveY = 0; o.actions.push(`reclaim:${r.id}`); c.bb.set("reclaimAt", c.self.tick); return false;
      } },
  ];
}
export { night as nightLevel };
