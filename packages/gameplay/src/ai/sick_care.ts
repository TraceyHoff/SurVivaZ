/**
 * ADR-442: sick bots seek care and rest.
 *
 * Root cause (audit 2026-11-19, base 8616271): zero references to `Diseases` / `careStatus` /
 * sickness anywhere in `ai/` or `agents.ts`. A bot with a cold or the flu kept gathering, working its
 * hire job and travelling, and `transmissionScan` counts it as a carrier the whole time — so it spread
 * cold/flu to bots working shoulder-to-shoulder. The care cure itself works passively (240 s dry + fed
 * + hydrated + warm; any break resets the clock; untreated cold → flu after 300 s).
 *
 * Fix: a sickness sensor (`fillSickSensors`, last in `buildAgentView`) that sets `view.sickCare` while
 * the bot has a cold or the flu — the nearest lit campfire, which care conditions are still missing,
 * and how much care time is still owed — and a `seek_care` behaviour that walks to that fire (or home
 * when no fire is lit in reach) and rests there until the sensor clears, eating / drinking from the bag
 * via `instantChores` and detouring to known water when thirsty with nothing to drink. While sick,
 * `withSickRest` (applied in `survivorRegistry`, inside `withHireDuty`) zeroes the first consideration
 * of every behaviour except the survival set — flee, eat, drink, drink_water, warm_up, cool_down,
 * seek_shelter, sleep, rest, tend_fire, seek_care itself, and work_forage (a Follow bot fetching food
 * when hungry) — so a sick bot cannot work a hire job, gather, build, travel, or run life wants while
 * infectious. The one exception is `gather`, and only while the bot is hungry with no food in its bag:
 * gathering is how it gets the food the cure needs, and the gate closes again the moment it carries
 * food. A hired sick bot rests too: `seek_care` is exempt from `withHireDuty`'s Follow gating, and the
 * owner sees why through the existing bot chat channel (`chatOnStart: "sick_rest"` — the bot says so
 * in local chat when the behaviour starts). A mounted sick bot dismounts (`DISMOUNT_NOW`).
 *
 * Unchanged by design: disease durations, rates, cure conditions and transmission rules — this slice
 * only changes what the bot DOES while sick. `careStatus().sick` (cold or flu) is the definition of
 * sick, matching exactly the contagious diseases in `data/diseases.json`.
 */
import { Transform, evalCurve, type AgentContext, type Entity, type World } from "@engine/core";
import { BuildPiece, CraftingStation, Fuel, NO_SLOT } from "../components.js";
import { gameplayDefs } from "../config.js";
import { StationKind } from "../defs.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { careStatus } from "../diseases.js";
import { pieceOf } from "../building/links.js";
import { goTo } from "./base_behaviors.js";
import { instantChores, stuckOn } from "./autonomy.js";

export interface SickCareTarget { id: number; x: number; y: number }
/** Set by fillSickSensors while the bot has a cold or the flu; absent when healthy. */
export interface SickSensors {
  sickCare?: { fire?: SickCareTarget; missing: string[]; secondsLeft: number };
}
/** How far a sick bot walks for a lit fire (warm_up's "near" radius for fires). */
export const SICK_FIRE_RADIUS = 60;
/** Distance from the fire the bot stops at: close enough to warm up and dry off, not on top of it. */
export const SICK_REST_TILES = 1.2;

/**
 * Nearest lit campfire to (x, y) within `reach`: the same predicate as `nearLitCampfire` (a Fuel-lit
 * attachment whose piece is a campfire, or a free-standing lit campfire station), returning the
 * nearest instead of a boolean. The base hearth is found the same way — it is a Fuel entity too.
 */
export function nearestLitCampfire(world: World, x: number, y: number, reach: number): SickCareTarget | undefined {
  const defs = gameplayDefs(world); const fu = world.store(Fuel); const r2 = reach * reach;
  let best: SickCareTarget | undefined; let bd = r2;
  for (let k = 0; k < fu.size; k++) {
    if (fu.data.lit[k] !== 1) continue;
    const fire = fu.dense[k]!; const t = world.get(fire, Transform); if (!t) continue;
    const d2 = (t.x - x) ** 2 + (t.y - y) ** 2; if (d2 > bd) continue;
    if (world.getField(fire, CraftingStation, "kind") === StationKind.Campfire) { best = { id: fire, x: t.x, y: t.y }; bd = d2; continue; }
    const piece = pieceOf(world, fire); const type = piece === undefined ? undefined : world.getField(piece, BuildPiece, "type");
    if (type !== undefined && defs.pieces.get(type)?.station === StationKind.Campfire) { best = { id: fire, x: t.x, y: t.y }; bd = d2; }
  }
  return best;
}

/**
 * Fill the sick-care sensor. Only cold / flu count as "sick" (`careStatus().sick`): those are the
 * contagious diseases the care cure treats. The scan runs only while sick (sick bots are rare), so
 * healthy bots pay nothing but the `careStatus` read. No fire in reach still sets sickCare — the
 * bot rests at home instead of working, and `warm_up` / `tend_fire` (both exempt from the sick
 * gate) can light the home fire under it.
 */
export function fillSickSensors(world: World, self: Entity, view: AgentWorldView & SickSensors): void {
  const st = careStatus(world, self);
  if (!st.sick) { delete view.sickCare; return; }
  const t = world.get(self, Transform);
  const fire = t ? nearestLitCampfire(world, t.x, t.y, SICK_FIRE_RADIUS) : undefined;
  view.sickCare = { ...(fire ? { fire } : {}), missing: st.missing, secondsLeft: st.secondsLeft };
}

type Ctx = AgentContext<AgentWorldView & SickSensors>;
const step01 = { type: "step" as const, at: 0.5 };
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };

/** Walk to the care fire and rest there until cured; the sensor clears sickCare when the cure lands. */
export function sickCareBehaviors(): GameBehavior[] {
  return [
    { name: "seek_care", chatOnStart: "sick_rest", inertia: 0.6, considerations: [
        { name: "sick", curve: step01, input: (c) => ((c.world as AgentWorldView & SickSensors).sickCare ? 1 : 0) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const sc = (c.world as AgentWorldView & SickSensors).sickCare; if (!sc) return false;
        // A zombie on top of the bot: yield at once so flee can take over (the calm gate already
        // scores this 0, but the current behaviour runs until the next think switches it).
        if (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3)) return false;
        const w = c.world as AgentWorldView & SickSensors;
        // Thirsty with nothing to drink in the bag: detour to known water first, like cool_down —
        // the care cure needs "hydrated", and a dry bag must not strand the bot by the fire.
        if (c.self.thirst < 0.5 && w.water === undefined && w.waterAt) {
          if (goTo(c, o, w.waterAt.x, w.waterAt.y, 0.9) > 0.8) { if (stuckOn(c, w.waterAt.x, w.waterAt.y)) return false; return; }
          stop(o);
          if (c.self.tick - c.bb.num("drankAt", -1e9) >= 20) { o.actions.push(`drink:${NO_SLOT}`); c.bb.set("drankAt", c.self.tick); }
          return;
        }
        const at = sc.fire ?? c.world.home;
        if (goTo(c, o, at.x, at.y) > SICK_REST_TILES) {
          if (stuckOn(c, at.x, at.y)) stop(o); // unreachable fire: rest where we stand, still not working
          return;
        }
        stop(o); instantChores(c, o); // eat / drink from the bag while resting; the cure accrues on its own
        return; // stay current (inertia) until the sensor clears sickCare
      } },
  ];
}

/**
 * While sick, only the survival set may run. Mirrors `withHireDuty`: the first consideration is
 * gated to 0 (its count / weight preserved, so unhired healthy bots rescore exactly as before).
 * `gather` is the one conditional exemption — a hungry bot with no food in its bag may gather (that
 * is how it gets the food the cure needs); the gate closes again the moment it carries food.
 */
const SICK_EXEMPT = new Set(["flee", "eat", "drink", "drink_water", "warm_up", "cool_down", "seek_shelter", "sleep", "rest", "tend_fire", "seek_care", "work_forage"]);
export function withSickRest(b: GameBehavior): GameBehavior {
  if (SICK_EXEMPT.has(b.name)) return b;
  const [first, ...rest] = b.considerations; if (!first) return b;
  return { ...b, considerations: [{ ...first, curve: { type: "linear", m: 1, b: 0 }, input: (c) => {
    const w = c.world as AgentWorldView & SickSensors;
    if (!w.sickCare) return evalCurve(first.curve, first.input(c));
    if (b.name === "gather" && c.self.hunger < 0.55 && w.food === undefined) return evalCurve(first.curve, first.input(c));
    return 0;
  } }, ...rest] };
}
