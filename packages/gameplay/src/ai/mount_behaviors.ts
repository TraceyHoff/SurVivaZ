/**
 * ADR-321: AI humans tame, ride, saddle and look after mounts on their own (on top of ADR-319 taming / riding and the
 * ADR-320 saddles). Same shape as vehicle_behaviors: a sensor pass fills AgentWorldView.mount* from the authoritative
 * world, utility behaviours walk / feed / craft through the action strings players' commands map to
 * ("mfeed:<target>:<item>", "mride:<target>", "mdismount", "msaddle:<target>:<slot>", "mrepair:<target>"), and the server
 * re-validates every one (checkFeed / checkRide / checkSaddle / checkRepair: reach, Horsemanship, ownership).
 *
 * - tame_mount: no own mount + Horsemanship + a liked food in the bag -> seek the best wild rideable animal in reach
 *   (faster / tougher species first; kickers skipped when hurt; never inside someone else's claim), hold the food (lure),
 *   feed every feedEveryTicks, back off when a feed spooks it, abort when kicked to low HP, give up after giveUpTicks
 *   (the animal is then ignored for banTicks).
 * - mountPolicy (wraps every behaviour, like stancePolicy): mount the own mount for long trips (goTo goal > longTripTiles)
 *   or to flee; dismount on arrival, before a building / doorway / low ceiling (rideClearanceBlocked), and for tasks
 *   (gather, combat, crafting, building, sleep, vehicles).
 * - saddle_up: equip the best saddle in the bag, else craft the best unlocked affordable one (at the base station),
 *   else repair a worn saddle when the Saddlery unlock allows it.
 * - tend_mount: feed a hurt mount, fetch a mount that strayed from home, use the saddlebag as overflow storage.
 *   A dead mount is simply gone from the sensors, so tame_mount picks a replacement.
 *
 * Ownership: only mounts recorded under mountOwnerIdFor(self) are "own" (a hired worker's are its employer's) and
 * mayUseMount must agree; mounts of others (even tribe-mates') are never ridden. Deterministic: no rng, bb tick
 * cooldowns, candidates sorted by score then entity id. Budget: the wild scan is a spatial-hash radius query at most every
 * scanEveryTicks per agent; the own-mount lookup is cached and re-scanned every ownScanEveryTicks.
 */
import { entityIndex, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { Animal, Dead, Equipment, Health, Mount, MountTaming, Pet, Tamed } from "../components.js";
import { gameplayDefs } from "../config.js";
import { countItem, readSlots } from "../inventory.js";
import { animalDefs } from "../population.js";
import { MOUNT_BOTS as B, mayUseMount, mountOfRider, mountOwnerIdFor, mountSpecies, mountSpeciesOfAnimal, saddleOfItemKey, SADDLES } from "../mount_defs.js";
import { bestMountFood, checkRepair, isRiding, liveRider, MOUNT_TAME_TOKEN, saddleInfo } from "../mounts.js";
import { hasSkillUnlock } from "../skills/tree.js";
import { zoneOwnedBy, zonesAt } from "../building/place.js";
import { recipeOutputUnlocked, stationInRange, stationUnlocked } from "../systems/crafting.js";
import { rideClearanceBlocked } from "../systems/movement.js";
import { agentWorld, containerSeq, goTo } from "./base_behaviors.js";
import { storageDepositActions } from "./storage_api.js";
import { insideBase } from "./planner.js";

export interface SeenMount {
  id: number; x: number; y: number; species: number; hp: number; riding: boolean; busy: boolean;
  saddle: number; saddleDur: number; saddleMax: number; bagFree: number; feedItem?: number;
}
export interface TameTarget { id: number; x: number; y: number; species: number; item: number; slot: number; holding: boolean; progress: number; kicker: boolean }
export type SaddlePlan = { kind: "equip"; slot: number } | { kind: "craft"; recipe: number; here: boolean; x: number; y: number } | { kind: "repair" };
export interface MountSensors {
  /** ADR-321: the bot's own (or its employer's) mount; riding = the bot sits on it. */
  mount?: SeenMount;
  /** Horsemanship learned (MOUNT_TAME_TOKEN): may tame and ride. */
  mountSkill?: boolean;
  /** Best wild rideable animal to tame (only without an own mount). */
  tameMount?: TameTarget;
  /** Next saddle step for the own mount. */
  saddleUp?: SaddlePlan;
  /** Free inventory slots (saddlebag overflow). */
  invFree?: number;
}
export const MOUNT_SENSOR_KEYS = ["mount", "mountSkill", "tameMount", "saddleUp", "invFree"] as const;
type Ctx = AgentContext<AgentWorldView>;
type Out = AgentOutput;

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);
const toward = (o: Out, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const stop = (o: Out): void => { o.moveX = 0; o.moveY = 0; };
const bans = (a: { bb: { get<T>(k: string): T | undefined } }): Record<number, number> => a.bb.get<Record<number, number>>("mountBans") ?? {};
/** Mark `id` as not worth taming until tick + banTicks (give-up timeout, kicked, unreachable). */
export function banTameTarget(bb: Ctx["bb"], id: number, tick: number): void {
  const b = { ...(bb.get<Record<number, number>>("mountBans") ?? {}) }; for (const k of Object.keys(b)) if (b[+k]! <= tick) delete b[+k];
  b[id] = tick + B.banTicks; bb.set("mountBans", b); bb.set("tameId", -1);
}

// ---- sensors --------------------------------------------------------------------------------------------------
function ownMount(world: World, self: Entity, a: Agent): Entity | undefined {
  if (isRiding(world, self)) { const m = mountOfRider(world, self); return m !== undefined && isOwn(world, self, m) ? m : undefined; }
  const cached = a.bb.num("mountId", -1);
  if (cached >= 0 && world.isAlive(cached as Entity) && isOwn(world, self, cached as Entity)) return cached as Entity;
  const tamed = a.bb.num("tameId", -1); // the animal it was just taming became its mount: no wait for the next scan
  if (tamed >= 0 && world.isAlive(tamed as Entity) && isOwn(world, self, tamed as Entity)) { a.bb.set("mountId", tamed); return tamed as Entity; }
  const tick = world.tick; if (cached < 0 && tick - a.bb.num("mountScanAt", -1e9) < B.ownScanEveryTicks) return undefined;
  a.bb.set("mountScanAt", tick); let best: Entity | undefined;
  for (const m of world.query([Mount, Transform], [Dead])) if (isOwn(world, self, m) && (best === undefined || m < best)) best = m;
  a.bb.set("mountId", best ?? -1); return best;
}
/** Own = recorded under the bot's owner id (its employer's for a hired worker) and usable by it. */
function isOwn(world: World, self: Entity, m: Entity): boolean {
  if (!world.has(m, Mount) || world.has(m, Dead)) return false;
  const owner = world.getField(m, Mount, "owner") ?? 0; const me = mountOwnerIdFor(world, self);
  return !!owner && owner === me && mayUseMount(world, self, m);
}
function seenMount(world: World, self: Entity, m: Entity): SeenMount {
  const t = world.get(m, Transform)!; const mm = world.get(m, Mount)!; const h = world.get(m, Health);
  const si = saddleInfo(world, m); const rider = liveRider(world, m);
  let bagFree = 0; if (si) { const v = readSlots(world, m); for (let i = 0; i < si.slots; i++) if (!v.item(i) || !v.count(i)) bagFree++; }
  const out: SeenMount = { id: m, x: t.x, y: t.y, species: mm.species, hp: h ? h.hp / Math.max(1, h.max) : 1, riding: rider === self, busy: rider !== undefined && rider !== self,
    saddle: mm.saddle, saddleDur: si?.dur ?? 0, saddleMax: si?.max ?? 0, bagFree };
  if (out.hp < B.feedBelowHp) { const f = bestMountFood(world, self, mm.species); if (f) out.feedItem = f; }
  return out;
}
/** MountTaming.by of this tamer (feedMount: the owner id, else the entity index). */
const tamerId = (world: World, self: Entity): number => mountOwnerIdFor(world, self) || entityIndex(self);
const slotOf = (v: ReturnType<typeof readSlots>, item: number): number => { for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
/** Wild candidates: a radius query on the spatial hash (no full-world scan), scored, banned / claimed / dangerous ones skipped. */
function pickTameTarget(world: World, self: Entity, a: Agent, hp: number): number {
  const t = world.get(self, Transform)!; const ban = bans(a); const ad = animalDefs(); const tick = world.tick;
  let best = -1, bs = -Infinity;
  for (const e of installSpatialIndex(world).queryRadius(t.x, t.y, B.seekRadius)) {
    if (!world.has(e, Animal) || world.has(e, Dead) || world.has(e, Mount) || world.has(e, Pet) || world.has(e, Tamed)) continue;
    if ((ban[e] ?? 0) > tick) continue;
    const def = ad[world.getField(e, Animal, "kind") ?? -1]; const sp = mountSpeciesOfAnimal(def?.key); const spec = mountSpecies(sp); if (!spec) continue;
    const p = world.get(e, Transform); if (!p) continue; const d = dist(t.x, t.y, p.x, p.y); if (d > B.seekRadius) continue;
    if (def!.attack && hp < B.kickerMinHp) continue; // a kicker is not worth the risk while hurt
    if (!bestMountFood(world, self, sp)) continue;
    if (zonesAt(world, p.x, p.y).some((z) => !zoneOwnedBy(world, z, self))) continue; // someone else's claim
    const tm = world.get(e, MountTaming); if (tm && tm.by !== tamerId(world, self) && tm.progress > 0 && tick - tm.lastTick < 200) continue; // someone else is taming it
    const s = spec.gallop + spec.hp / 60 - d * 0.15;
    if (s > bs || (s === bs && e < best)) { bs = s; best = e; }
  }
  return best;
}
function tameTarget(world: World, self: Entity, a: Agent, hp: number): TameTarget | undefined {
  const tick = world.tick; let id = a.bb.num("tameId", -1);
  const valid = (e: number): boolean => e >= 0 && world.isAlive(e as Entity) && world.has(e as Entity, Animal) && !world.has(e as Entity, Dead) && !world.has(e as Entity, Mount) && !world.has(e as Entity, Tamed) && (bans(a)[e] ?? 0) <= tick;
  if (!valid(id)) {
    if (tick - a.bb.num("tameScanAt", -1e9) < B.scanEveryTicks) return undefined;
    a.bb.set("tameScanAt", tick); id = pickTameTarget(world, self, a, hp); a.bb.set("tameId", id); if (id < 0) return undefined;
  }
  const e = id as Entity; const p = world.get(e, Transform)!; const kind = world.getField(e, Animal, "kind") ?? 0; const def = animalDefs()[kind];
  const sp = mountSpeciesOfAnimal(def?.key); const item = bestMountFood(world, self, sp); if (!item) return undefined;
  const v = readSlots(world, self); const slot = slotOf(v, item);
  const tm = world.get(e, MountTaming); const by = tamerId(world, self);
  return { id, x: p.x, y: p.y, species: sp, item, slot, holding: (world.getField(self, Equipment, "mainHandItem") ?? 0) === item,
    progress: tm && tm.by === by ? tm.progress : 0, kicker: !!def?.attack };
}
type RecipeRow = { id: number; station: number; output: { item: number }; ingredients: readonly { item: number; count: number }[] };
function saddlePlan(world: World, self: Entity, view: AgentWorldView, m: SeenMount): SaddlePlan | undefined {
  const defs = gameplayDefs(world); const v = readSlots(world, self); const cur = m.saddle;
  let bestSlot = -1, bestTier = cur;
  for (let i = 0; i < v.slotCount; i++) { const it = v.item(i); if (!it || !v.count(i)) continue; const sd = saddleOfItemKey(defs.items.get(it)?.key); if (sd && sd.tier > bestTier) { bestTier = sd.tier; bestSlot = i; } }
  if (bestSlot >= 0) return { kind: "equip", slot: bestSlot };
  const t = world.get(self, Transform)!;
  for (const sd of [...SADDLES].sort((a, b) => b.tier - a.tier)) {
    if (sd.tier <= m.saddle) break;
    const itemId = [...defs.items.values()].find((d) => d.key === sd.item)?.id; if (!itemId) continue;
    const r = [...defs.recipes.values()].find((x) => x.output.item === itemId) as RecipeRow | undefined; if (!r) continue;
    if (!recipeOutputUnlocked(world, self, r as never) || !stationUnlocked(world, self, r.station)) continue;
    if (!r.ingredients.every((g) => countItem(world, self, g.item) >= g.count)) continue;
    if (stationInRange(world, self, r.station)) return { kind: "craft", recipe: r.id, here: true, x: t.x, y: t.y };
    const st = view.bs?.stations.get(r.station); if (st) return { kind: "craft", recipe: r.id, here: false, x: st.x, y: st.y };
  }
  if (m.saddle && m.saddleMax > 0 && m.saddleDur / m.saddleMax < B.repairBelow) {
    const why = checkRepair(world, self, m.id as Entity); if (!why || why === "too_far") return { kind: "repair" };
  }
  return undefined;
}
/** Fill the ADR-321 mount sensors (call after the plan sensors: the base stations come from view.bs). */
export function fillMountSensors(world: World, self: Entity, view: AgentWorldView, a: Agent): void {
  if (!world.isRegistered(Mount) || !world.has(self, Transform)) return;
  const skill = hasSkillUnlock(world, self, MOUNT_TAME_TOKEN); view.mountSkill = skill;
  const hpc = world.get(self, Health); const hp = hpc ? hpc.hp / Math.max(1, hpc.max) : 1;
  const m = ownMount(world, self, a);
  if (m !== undefined) {
    view.mount = seenMount(world, self, m); a.bb.set("tameId", -1);
    const tick = world.tick;
    if (tick - a.bb.num("saddleScanAt", -1e9) >= B.saddleScanEveryTicks) { a.bb.set("saddleScanAt", tick); a.bb.set("saddlePlan", saddlePlan(world, self, view, view.mount) ?? null); }
    const sp = a.bb.get<SaddlePlan | null>("saddlePlan"); if (sp) view.saddleUp = sp;
  } else if (skill && !isRiding(world, self)) { const tt = tameTarget(world, self, a, hp); if (tt) view.tameMount = tt; }
  if (view.mount?.bagFree) { const v = readSlots(world, self); let free = 0; for (let i = 0; i < v.addLimit; i++) if (!v.item(i) || !v.count(i)) free++; view.invFree = free; } // saddlebag overflow only
}

// ---- behaviours -----------------------------------------------------------------------------------------------
const zombieNear = (c: Ctx): boolean => { const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); return !!z && dist(c.self.x, c.self.y, z.x, z.y) < B.safeTiles; };
const calm = (c: Ctx): boolean => c.self.hp >= B.minHp && c.self.hunger > 0.3 && c.self.thirst > 0.3 && !zombieNear(c);
const on = (b: boolean): number => (b ? 1 : 0);
export function mountBehaviors(): GameBehavior[] {
  return [
    { name: "tame_mount", inertia: 0.35, traits: { bravery: 0.4, industriousness: 0.3 },
      considerations: [
        // one factor (no compensation): a mount is worth more than one more resource trip (trip ~1.0-1.2), so a
        // calm bot that meets a tameable animal with a liked food on hand takes the chance
        { name: "candidate", weight: B.tameUtility, curve: { type: "step", at: 0.5 }, input: (c) => on(!!c.world.tameMount && !c.world.mount && !!c.world.mountSkill && calm(c)) },
      ],
      run: (c, o) => tameRun(c, o) },
    { name: "saddle_up", inertia: 0.3, traits: { industriousness: 0.6 },
      considerations: [
        { name: "plan", weight: B.saddleUtility, curve: { type: "step", at: 0.5 }, input: (c) => on(!!c.world.saddleUp && !!c.world.mount && c.self.tick - c.bb.num("saddleAt", -1e9) >= B.saddleCooldownTicks) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => on(calm(c)) },
      ],
      run: (c, o) => saddleRun(c, o) },
    { name: "tend_mount", inertia: 0.25, traits: { industriousness: 0.3 },
      considerations: [
        { name: "need", curve: { type: "linear", m: 1, b: 0 }, input: (c) => tendNeed(c) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => on(calm(c)) },
      ],
      run: (c, o) => tendRun(c, o) },
  ];
}
function tameRun(c: Ctx, o: Out): boolean | void {
  const t = c.world.tameMount; if (!t || c.world.mount) return false;
  const tick = c.self.tick;
  if (c.bb.num("tameTarget", -1) !== t.id) { c.bb.set("tameTarget", t.id); c.bb.set("tameSince", tick); c.bb.set("tameProg", t.progress); c.bb.set("tameHp", c.self.hp); }
  if (tick - c.bb.num("tameSince", tick) > B.giveUpTicks) { banTameTarget(c.bb, t.id, tick); c.bb.set("tameTarget", -1); return false; } // give up
  if (c.self.hp < B.minHp || (t.kicker && c.self.hp < B.kickerMinHp && c.self.hp < c.bb.num("tameHp", 1))) { banTameTarget(c.bb, t.id, tick); c.bb.set("tameTarget", -1); return false; } // kicked: back away for good
  if (t.progress < c.bb.num("tameProg", 0) - 0.5) c.bb.set("tameBackoffUntil", tick + B.backoffTicks); // spooked: it lost trust
  c.bb.set("tameProg", t.progress);
  if (tick < c.bb.num("tameBackoffUntil", -1e9)) { // step back and let it settle
    const d = dist(c.self.x, c.self.y, t.x, t.y); if (d < B.backoffDist) toward(o, t.x, t.y, c.self.x * 2 - t.x, c.self.y * 2 - t.y, 0.5); else stop(o);
    return;
  }
  if (!t.holding && t.slot >= 0 && tick - c.bb.num("lureAt", -1e9) >= 40) { o.actions.push(`equip:${t.slot}`); c.bb.set("lureAt", tick); } // hold the food: lures, no flee / charge
  const d = dist(c.self.x, c.self.y, t.x, t.y);
  if (d > B.feedReach) { goTo(c, o, t.x, t.y, d > 6 ? 0.85 : B.approachSpeed); return; }
  stop(o); toward(o, c.self.x, c.self.y, t.x, t.y, 0);
  if (tick - c.bb.num("tameFeedAt", -1e9) >= B.feedEveryTicks) { o.actions.push(`mfeed:${t.id}:${t.item}`); c.bb.set("tameFeedAt", tick); }
}
function saddleRun(c: Ctx, o: Out): boolean | void {
  const p = c.world.saddleUp, m = c.world.mount; if (!p || !m) return false;
  const tick = c.self.tick; const done = (): false => { c.bb.set("saddleAt", tick); c.bb.set("saddleScanAt", -1e9); return false; };
  if (p.kind === "craft") {
    if (!p.here && goTo(c, o, p.x, p.y) > 1.5) return;
    stop(o); o.actions.push(`craft:${p.recipe}`); return done();
  }
  if (!m.riding && goTo(c, o, m.x, m.y, 0.8) > B.mountReach) return;
  stop(o); o.actions.push(p.kind === "equip" ? `msaddle:${m.id}:${p.slot}` : `mrepair:${m.id}`); return done();
}
function tendNeed(c: Ctx): number {
  const m = c.world.mount; if (!m || m.busy) return 0;
  if (m.feedItem) return B.feedUtility;
  if (!m.riding && dist(m.x, m.y, c.world.home.x, c.world.home.y) > B.homeRadius && dist(c.self.x, c.self.y, c.world.home.x, c.world.home.y) < B.homeRadius && c.self.phase !== "night") return B.tendUtility;
  if (bagOverflow(c)) return B.tendUtility;
  return 0;
}
const bagOverflow = (c: Ctx): { item: number; count: number } | undefined => {
  const m = c.world.mount; const s = c.world.surplus?.[0];
  return m && m.bagFree > 0 && (c.world.invFree ?? 99) <= B.bagOverflowFreeSlots && s && dist(c.self.x, c.self.y, m.x, m.y) <= B.fetchRadius ? s : undefined;
};
function tendRun(c: Ctx, o: Out): boolean | void {
  const m = c.world.mount; if (!m || m.busy) return false; const tick = c.self.tick;
  if (m.feedItem) {
    if (!m.riding && goTo(c, o, m.x, m.y, 0.8) > B.mountReach) return;
    stop(o); if (tick - c.bb.num("mountFeedAt", -1e9) >= B.feedEveryTicks) { o.actions.push(`mfeed:${m.id}:${m.feedItem}`); c.bb.set("mountFeedAt", tick); }
    return;
  }
  const s = bagOverflow(c);
  if (s) { if (!m.riding && goTo(c, o, m.x, m.y, 0.8) > B.mountReach) return; stop(o); if (containerSeq(c, o, m.id, storageDepositActions(m.id as Entity, s.item, s.count))) return false; return; }
  // fetch a strayed mount: walk to it, ride it home (mountPolicy dismounts on arrival)
  const home = c.world.home;
  if (m.riding) { if (goTo(c, o, home.x, home.y) < B.arriveTiles) { o.actions.push("mdismount"); c.bb.set("mountActAt", tick); return false; } return; }
  if (dist(m.x, m.y, home.x, home.y) <= B.homeRadius) return false;
  if (goTo(c, o, m.x, m.y, 0.85) > B.mountReach) return;
  stop(o); if (tick - c.bb.num("mountActAt", -1e9) >= B.actionCooldownTicks) { o.actions.push(`mride:${m.id}`); c.bb.set("mountActAt", tick); }
}

// ---- ride / dismount policy -----------------------------------------------------------------------------------
/** Behaviours that end the ride at once (rest, vehicles, leaving / warming inside a building). */
const DISMOUNT_NOW = new Set(["sleep", "rest", "drive", "vehicle_service", "hitch", "deploy_vehicle", "leave_base", "warm_up", "cool_down", "work_hold"]);
/** Task behaviours: ride there, dismount within taskDismountTiles of the work spot (gather, combat, craft, build, chores). */
const DISMOUNT_TASK = new Set(["gather", "hunt", "skin", "defend", "work_defend", "craft", "build", "base_work", "stash", "refuel", "tend_fire", "repair", "reclaim",
  "equip", "stall_trade", "tame_pet", "tame_livestock", "feed_trough", "work_farm", "work_maintain", "work_craft", "work_forage", "clan_stock", "trip"]);
/** Action verbs that need feet on the ground (blocked while riding, or crafting / combat by policy). */
const FOOT_ACTIONS = /^(gather|attack|build|craft|door|fire|upgrade|repair|reclaim|terrain|sleep|venter|tame|dye)(:|$)/;
/** Recent goTo goal (base_behaviors.goTo records it every call), else undefined. */
export function navGoal(c: Ctx): { x: number; y: number } | undefined {
  return c.self.tick - c.bb.num("navGoalAt", -1e9) <= 2 ? { x: c.bb.num("navGoalX", 0), y: c.bb.num("navGoalY", 0) } : undefined;
}
/** Why a riding bot should get off now (undefined = keep riding). */
export function dismountReason(c: Ctx, o: Out, behavior: string, world: World | undefined): string | undefined {
  const m = c.world.mount!; const flee = behavior === "flee"; const moving = o.moveX !== 0 || o.moveY !== 0;
  if (moving && world) { // doorway / low ceiling ahead (the same check movement applies to the rider)
    const len = Math.hypot(o.moveX, o.moveY) || 1; const px = c.self.x + (o.moveX / len) * B.clearanceProbeTiles, py = c.self.y + (o.moveY / len) * B.clearanceProbeTiles;
    if (rideClearanceBlocked(world, m.species, c.self.x, c.self.y, px, py, 0)) return "clearance";
  }
  if (flee) return undefined;
  if (DISMOUNT_NOW.has(behavior)) return "task";
  if (o.actions.some((a) => FOOT_ACTIONS.test(a))) return "task";
  const g = navGoal(c); const gd = g ? dist(c.self.x, c.self.y, g.x, g.y) : 0;
  const b = c.world.base; if (b && g && insideBase(b, g.x, g.y) && dist(c.self.x, c.self.y, b.x + 1, b.y + 1) < B.buildingDismountTiles + 1) return "building";
  if (DISMOUNT_TASK.has(behavior) && (!g || gd < B.taskDismountTiles)) return "task";
  if (g && gd < B.arriveTiles) return "arrived";
  if (!moving) { const since = c.bb.num("mountStillSince", -1); if (since < 0) c.bb.set("mountStillSince", c.self.tick); else if (c.self.tick - since >= B.idleDismountTicks) return "arrived"; }
  else c.bb.set("mountStillSince", -1);
  return undefined;
}
/** True when a walking bot should get on its mount for this behaviour's trip (long goTo trip, or fleeing). */
export function wantsRide(c: Ctx, o: Out, behavior: string): boolean {
  const m = c.world.mount; if (!m || m.riding || m.busy || !c.world.mountSkill) return false;
  if (DISMOUNT_NOW.has(behavior) || o.actions.some((a) => FOOT_ACTIONS.test(a))) return false;
  const md = dist(c.self.x, c.self.y, m.x, m.y);
  if (behavior === "flee") return md <= B.fleeMountRadius;
  if (c.self.tick - c.bb.num("dismountAt", -1e9) < B.remountCooldownTicks) return false;
  const g = navGoal(c); if (!g || md > B.fetchRadius) return false;
  const trip = dist(c.self.x, c.self.y, g.x, g.y); if (trip <= B.longTripTiles) return false;
  const b = c.world.base; if (b && insideBase(b, c.self.x, c.self.y)) return false; // walk out of the building first
  return dist(m.x, m.y, g.x, g.y) <= trip + md; // the mount is not the wrong way
}
/** ADR-321: wraps every survivor behaviour (survivorRegistry): auto mount / dismount on the bot's own mount. */
export function mountPolicy(c: Ctx, o: Out, behavior: string): void {
  const m = c.world.mount; if (!m) return;
  if (o.actions.some((a) => a === "mdismount" || a.startsWith("mride:"))) return; // the behaviour decided itself (tend_mount)
  const tick = c.self.tick; const ready = tick - c.bb.num("mountActAt", -1e9) >= B.actionCooldownTicks;
  if (m.riding) {
    const why = dismountReason(c, o, behavior, agentWorld(c)); if (!why) return;
    if (why === "clearance") stop(o); // do not push into the doorway / under the deck mounted
    if (ready) { o.actions.push("mdismount"); c.bb.set("mountActAt", tick); c.bb.set("dismountAt", tick); c.bb.set("dismountWhy", why); c.bb.set("mountStillSince", -1); }
    return;
  }
  if (!wantsRide(c, o, behavior)) return;
  const md = dist(c.self.x, c.self.y, m.x, m.y);
  if (md > B.mountReach) { toward(o, c.self.x, c.self.y, m.x, m.y, 0.9); return; } // detour to the mount first
  if (ready) { o.actions.push(`mride:${m.id}`); c.bb.set("mountActAt", tick); c.bb.set("mountStillSince", -1); }
}
