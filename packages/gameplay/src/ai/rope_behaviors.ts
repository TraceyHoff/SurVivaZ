/**
 * ADR-351: AI humans lead farm animals home on a rope, on top of the rope system (rope.ts). Same shape as
 * mount_behaviors: a sensor pass fills AgentWorldView.rope from the authoritative world, a utility behaviour
 * walks / equips / attaches through the action strings players' commands map to ("equip:<slot>",
 * "rope:<target>", "rope:0" to release), and the server re-validates every one (checkLead: reach, rope
 * equipped, ownership).
 *
 * - lead_animal: rope in the bag + a leadable animal in reach (own tamed stray outside the home claim first,
 *   then the nearest wild farm animal) -> equip the rope, walk to the animal, attach, then walk it to the
 *   destination (claim centre, else home anchor). At a home anchor the bot releases the rope on arrival;
 *   inside a claim the system releases it on entry. Give up after giveUpTicks (the animal is then ignored
 *   for banTicks). A bot already leading keeps walking home even when not calm — the animal balks at danger
 *   on its own, and the defence behaviours outbid this one when the bot itself is threatened.
 * - No rope fetching: a bot without rope in its bag simply never leads (fetching rope from storage is
 *   deferred — see ADR-351 honest cuts). A hired worker leads its employer's animals, never anyone else's.
 * Deterministic: no rng, bb tick cooldowns, candidates sorted by score then entity id. Budget: the wild scan
 * is a spatial-hash radius query at most every scanEveryTicks per agent.
 */
import { Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { Animal, Dead, RopeLead, Tamed } from "../components.js";
import { ROPE_BOTS as B, ROPE_TUNING as T } from "../rope_defs.js";
import { isLeadable, leadDestination, ledAnimalOf, mayLead, ropeEquipped, ropeSlotOf } from "../rope.js";
import { mountOwnerIdFor } from "../mount_defs.js";
import { tribeOf } from "../building/place.js";
import { inClaim } from "../territory.js";
import { goTo } from "./base_behaviors.js";
import { baseHome } from "./planner.js";

export interface RopeTarget { id: number; x: number; y: number; slot: number }
export interface RopeView {
  /** The animal this bot is currently leading (with its live position). */
  leading?: { id: number; x: number; y: number };
  /** Best animal to go and lead (rope slot to equip first). */
  target?: RopeTarget;
  /** Where the led animal goes: claim centre, else the bot's home anchor (undefined: nowhere to lead it). */
  dest: { x: number; y: number; r: number } | undefined;
  ropeEquipped: boolean;
}
export interface RopeSensors { rope?: RopeView }
export const ROPE_SENSOR_KEYS = ["rope"] as const;
type Ctx = AgentContext<AgentWorldView>;
type Out = AgentOutput;

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);
const stop = (o: Out): void => { o.moveX = 0; o.moveY = 0; };
const on = (b: boolean): number => (b ? 1 : 0);
const zombieNear = (c: Ctx): boolean => { const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); return !!z && dist(c.self.x, c.self.y, z.x, z.y) < B.safeTiles; };
const calm = (c: Ctx): boolean => c.self.hp >= B.minHp && c.self.hunger > 0.3 && c.self.thirst > 0.3 && !zombieNear(c);
const bans = (a: { bb: { get<T>(k: string): T | undefined } }): Record<number, number> => a.bb.get<Record<number, number>>("ropeBans") ?? {};
/** The bot's home anchor for leading: its claim / BotHome / hire anchor, else the planner base. */
function homeDest(world: World, self: Entity, view: AgentWorldView): { x: number; y: number; r: number } | undefined {
  return leadDestination(world, self) ?? (view.base ? { ...baseHome(view.base), r: T.arrivalRadius } : undefined);
}
/** Own tamed animals outside the home claim are strays worth fetching first; wild animals are next. */
function pickLeadTarget(world: World, self: Entity, a: Agent): number {
  const t = world.get(self, Transform)!; const ban = bans(a); const tick = world.tick; const tribe = tribeOf(world, self);
  let best = -1, bs = -Infinity;
  for (const e of installSpatialIndex(world).queryRadius(t.x, t.y, T.scanRadius)) {
    if (!world.has(e, Animal) || world.has(e, Dead) || !isLeadable(world, e) || !mayLead(world, self, e)) continue;
    if ((ban[e] ?? 0) > tick) continue;
    const p = world.get(e, Transform); if (!p) continue; const d = dist(t.x, t.y, p.x, p.y); if (d > T.scanRadius) continue;
    // a stray own animal (tamed, outside the home claim) outranks a wild one at the same distance
    const stray = tribe !== 0 && world.has(e, Tamed) && !inClaim(world, tribe, p.x, p.y) ? 10 : 0;
    const s = stray - d * 0.15;
    if (s > bs || (s === bs && e < best)) { bs = s; best = e; }
  }
  return best;
}

/** Fill the ADR-351 rope sensors (call after the plan sensors: the fallback destination is view.base). */
export function fillRopeSensors(world: World, self: Entity, view: AgentWorldView, a: Agent): void {
  if (!world.isRegistered(RopeLead) || !world.has(self, Transform)) return;
  const led = ledAnimalOf(world, self);
  if (led !== undefined) {
    const p = world.get(led, Transform); if (!p) return;
    view.rope = { leading: { id: led, x: p.x, y: p.y }, dest: homeDest(world, self, view), ropeEquipped: ropeEquipped(world, self) };
    a.bb.set("ropeTarget", -1); return;
  }
  const slot = ropeSlotOf(world, self); if (slot < 0) return; // no rope in the bag: never leads (no fetching yet)
  const tick = world.tick; let id = a.bb.num("ropeTarget", -1);
  const valid = (e: number): boolean => e >= 0 && world.isAlive(e as Entity) && isLeadable(world, e as Entity) && mayLead(world, self, e as Entity) && (bans(a)[e] ?? 0) <= tick;
  if (!valid(id)) {
    if (tick - a.bb.num("ropeScanAt", -1e9) < B.scanEveryTicks) return;
    a.bb.set("ropeScanAt", tick); id = pickLeadTarget(world, self, a); a.bb.set("ropeTarget", id); a.bb.set("ropeTargetAt", tick);
    if (id < 0) return;
  }
  const e = id as Entity; const p = world.get(e, Transform)!;
  view.rope = { target: { id, x: p.x, y: p.y, slot }, dest: homeDest(world, self, view), ropeEquipped: ropeEquipped(world, self) };
}

export function ropeBehaviors(): GameBehavior[] {
  return [
    { name: "lead_animal", inertia: 0.35, traits: { bravery: 0.3, industriousness: 0.4 },
      considerations: [
        { name: "candidate", weight: B.leadUtility, curve: { type: "step", at: 0.5 }, input: (c) => on(!!c.world.rope && (!!c.world.rope.target || !!c.world.rope.leading) && calm(c)) },
        // already leading: keep walking home even when not calm (the animal balks at danger itself)
        { name: "leading", weight: B.leadUtility, curve: { type: "step", at: 0.5 }, input: (c) => on(!!c.world.rope?.leading) },
      ],
      run: (c, o) => leadRun(c, o) },
  ];
}

function leadRun(c: Ctx, o: Out): boolean | void {
  const r = c.world.rope; if (!r) return false;
  const tick = c.self.tick;
  if (r.leading) {
    const dest = r.dest; if (!dest) return false; // no fenced-in area: hold the rope, do other work
    // wait for the animal when it lags: the bot walks 2.6 tiles/s, a cow runs at 2.0 and walks at 0.9,
    // so walking on would stretch the rope past breakDistance and lose it (move magnitude is normalised
    // away in the bot input frame, so slowing down is not an option — stopping is)
    if (dist(c.self.x, c.self.y, r.leading.x, r.leading.y) > B.waitBehind) { stop(o); return true; }
    const d = goTo(c, o, dest.x, dest.y);
    // home anchor (not a claim): release on arrival — inside a claim the system releases on entry
    if (dest.r <= T.arrivalRadius + 0.01 && d <= T.arrivalRadius) { stop(o); o.actions.push("rope:0"); }
    return true;
  }
  const t = r.target; if (!t) return false;
  // give up on an animal that never gets close enough (fence / water in the way): ban it for a while
  if (tick - c.bb.num("ropeTargetAt", -1e9) > B.giveUpTicks) {
    const b = { ...bans(c.agent) }; for (const k of Object.keys(b)) if (b[+k]! <= tick) delete b[+k];
    b[t.id] = tick + B.banTicks; c.bb.set("ropeBans", b); c.bb.set("ropeTarget", -1); return false;
  }
  if (!r.ropeEquipped) {
    if (tick - c.bb.num("ropeEquipAt", -1e9) >= B.attachCooldownTicks) { o.actions.push(`equip:${t.slot}`); c.bb.set("ropeEquipAt", tick); }
    return true;
  }
  const d = goTo(c, o, t.x, t.y);
  if (d <= T.attachRange && tick - c.bb.num("ropeAttachAt", -1e9) >= B.attachCooldownTicks) {
    o.actions.push(`rope:${t.id}`); c.bb.set("ropeAttachAt", tick);
  }
  return true;
}
