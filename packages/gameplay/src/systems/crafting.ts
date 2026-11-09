/**
 * Crafting: IntentAction.Craft starts a timed job; IntentAction.CancelCraft cancels it.
 * Start validates recipe, station in range, ingredients, and that the output fits after the
 * ingredients are removed. Every tick the station must stay in range. On completion the inventory
 * exchange (consume ingredients + add output) is atomic and re-validated, so nothing is consumed
 * up-front and there is never anything to refund.
 * Deterministic and RNG-free: the client predicts it fully and reconciles.
 */
import { defineResource, entityIndex, Transform, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { CraftingStation, Crafter, Dead, Equipment, Fuel, Worn, IntentAction, Inventory, PlayerIntent, WorkerOrder, Worker, WorkerJob } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, StationKind, WearSlot, type RecipeDef } from "../defs.js";
import { CraftCompleted, CraftFail, CraftFailed, CraftStarted, emit } from "../events.js";
import { exchangeItems } from "../inventory.js";
import { crafterIdFor } from "../economy/provenance.js";
import { recordRecentCraft } from "../recent.js";
import stationsRaw from "../../data/stations.json";

/** Stations are looked up in the shared spatial index within this radius (>= any CraftingStation.range). */
export const MAX_STATION_RANGE = 4;
const FIRED = new Set<StationKind>([StationKind.Campfire, StationKind.Furnace]);
const near: Entity[] = [];

/** Extra station sources (e.g. parked camper interiors, vehicle_craft.ts): has(e, kind) = usable by e now. */
export interface StationProvider { readonly name: string; has(world: World, e: Entity, kind: StationKind): boolean }
export const StationProvidersRes = defineResource<StationProvider[]>("gameplay.StationProviders");
export function addStationProvider(world: World, p: StationProvider): void {
  let ps = world.getResource(StationProvidersRes); if (!ps) world.setResource(StationProvidersRes, (ps = []));
  if (!ps.some((x) => x.name === p.name)) ps.push(p);
}
/** A station of `kind` within its range of e (placed piece or a StationProvider). Fired pieces (campfire, furnace) must be lit. */
export function stationInRange(world: World, e: Entity, kind: StationKind): boolean {
  if (kind === StationKind.None) return true;
  if (pieceStationInRange(world, e, kind)) return true;
  for (const p of world.getResource(StationProvidersRes) ?? []) if (p.has(world, e, kind)) return true;
  return false;
}
function pieceStationInRange(world: World, e: Entity, kind: StationKind): boolean {
  const tf = world.store(Transform); const cs = world.store(CraftingStation);
  const a = tf.slot(entityIndex(e)); const x = tf.data.x[a]!, y = tf.data.y[a]!;
  near.length = 0;
  for (const st of installSpatialIndex(world).queryRadius(x, y, MAX_STATION_RANGE, near)) {
    const i = entityIndex(st); const s = cs.slot(i);
    if (s < 0 || cs.data.kind[s] !== kind || world.has(st, Dead)) continue;
    if (FIRED.has(kind) && !isLit(world, st)) continue;
    const b = tf.slot(i);
    if (Math.hypot(tf.data.x[b]! - x, tf.data.y[b]! - y) <= cs.data.range[s]!) return true;
  }
  return false;
}
/** ADR-262: the character holds the beginning torch (items.json "torch") in the main hand or off hand. Lanterns/candles do not count. */
export function holdingTorch(world: World, e: Entity): boolean {
  if (world.has(e, Dead)) return false;
  const id = torchId(world); if (id === undefined) return false;
  const mh = world.isRegistered(Equipment) ? (world.getField(e, Equipment, "mainHandItem") ?? 0) : 0;
  const oh = world.isRegistered(Worn) && world.has(e, Worn) ? (world.get(e, Worn)!.item[WearSlot.OffHand] ?? 0) : 0;
  return mh === id || oh === id;
}
function torchId(world: World): number | undefined { for (const d of gameplayDefs(world).items.values()) if (d.key === "torch") return d.id; return undefined; }
/** ADR-262: torch recipes (cooked meat) need no station or station unlock while the beginning torch is held. */
export const torchCraftable = (world: World, e: Entity, r: RecipeDef): boolean => r.torch === true && holdingTorch(world, e);
/** The recipe's station is satisfied: in range, or a torch recipe with the torch held. */
export const recipeStationOk = (world: World, e: Entity, r: RecipeDef): boolean => stationInRange(world, e, r.station) || torchCraftable(world, e, r);
/** Fired station is lit (Fuel.lit). */
export function isLit(world: World, e: Entity): boolean { return (world.getField(e, Fuel, "lit") ?? 0) !== 0; }

/** Skill level source (e.g. a future progression system); absent = recipe skill requirements are not enforced. */
export type SkillLevelFn = (e: Entity, skill: string) => number;
export const SkillLevelRes = defineResource<{ fn: SkillLevelFn | undefined }>("gameplay.SkillLevel");
export function setSkillLevelProvider(world: World, fn: SkillLevelFn | undefined): void { world.setResource(SkillLevelRes, { fn }); }
export function meetsSkill(world: World, e: Entity, r: RecipeDef): boolean {
  const fn = world.getResource(SkillLevelRes)?.fn; return !r.skill || !fn || fn(e, r.skill.key) >= r.skill.level;
}
/** ADR-221: station recipes need the station's piece unlock ("piece:<station key>"); hand recipes never. Absent provider = not enforced. */
export type UnlockFn = (e: Entity, token: string) => boolean;
export const UnlockRes = defineResource<{ fn: UnlockFn | undefined }>("gameplay.Unlock");
export function setUnlockProvider(world: World, fn: UnlockFn | undefined): void { world.setResource(UnlockRes, { fn }); }
const STATION_KEYS = Object.entries((stationsRaw as { stations: Record<string, number> }).stations).reduce<string[]>((a, [k, v]) => { a[v] = k; return a; }, []);
export const stationToken = (kind: StationKind): string | undefined => kind === StationKind.None ? undefined : `piece:${STATION_KEYS[kind]}`;
export function stationUnlocked(world: World, e: Entity, kind: StationKind): boolean {
  const t = stationToken(kind); const fn = world.getResource(UnlockRes)?.fn; return !t || !fn || fn(e, t);
}
/** ADR-320: a recipe whose output has an `item:<key>` unlock node (saddles) needs it; ungated outputs always pass. */
export function recipeOutputUnlocked(world: World, e: Entity, r: RecipeDef): boolean {
  const key = gameplayDefs(world).items.get(r.output.item)?.key; const fn = world.getResource(UnlockRes)?.fn; return !key || !fn || fn(e, `item:${key}`);
}
function checkRecipe(world: World, e: Entity, r: RecipeDef): CraftFail | 0 {
  if (!meetsSkill(world, e, r)) return CraftFail.SkillTooLow;
  if (!recipeOutputUnlocked(world, e, r)) return CraftFail.Locked;
  const torch = torchCraftable(world, e, r);
  if (!torch && !stationUnlocked(world, e, r.station)) return CraftFail.Locked;
  if (!torch && !stationInRange(world, e, r.station)) return CraftFail.NoStation;
  if (!exchangeItems(world, e, r.ingredients, [], true)) return CraftFail.MissingIngredients;
  if (!exchangeItems(world, e, r.ingredients, [r.output], true, crafterIdFor(world, e, r.output.item))) return CraftFail.InventoryFull;
  return 0;
}

export function craftingSystem(world: World, dt: number): void {
  const defs = gameplayDefs(world);
  const intent = world.store(PlayerIntent); const cr = world.store(Crafter);
  for (const e of world.query([PlayerIntent, Crafter, Inventory, Transform], [Dead])) {
    const idx = entityIndex(e); const is = intent.slot(idx); const cs = cr.slot(idx);
    const action = intent.data.action[is]!;
    const current = cr.data.recipe[cs]!;
    const clear = (): void => { cr.data.recipe[cs] = 0; cr.data.startTick[cs] = 0; cr.data.totalTicks[cs] = 0; cr.markChanged(idx); };
    const fail = (recipe: number, reason: CraftFail): void => emit(world, CraftFailed, { entity: e, recipe, reason });

    if (action === IntentAction.CancelCraft && current !== 0) { clear(); fail(current, CraftFail.Cancelled); continue; }
    if (action === IntentAction.Craft) {
      const id = intent.data.recipe[is]!;
      if (current !== 0) { fail(id, CraftFail.Busy); continue; }
      const r = defs.recipes.get(id); if (!r) { fail(id, CraftFail.UnknownRecipe); continue; }
      const why = checkRecipe(world, e, r); if (why) { fail(id, why); continue; }
      const total = Math.min(0xffff, secondsToTicks(r.seconds, dt));
      cr.data.recipe[cs] = id; cr.data.startTick[cs] = world.tick + 1; cr.data.totalTicks[cs] = total; cr.markChanged(idx);
      emit(world, CraftStarted, { entity: e, recipe: id, totalTicks: total });
      continue; // progress starts next tick
    }
    if (current === 0) continue;
    const r = defs.recipes.get(current);
    if (!r) { clear(); fail(current, CraftFail.UnknownRecipe); continue; }
    if (!recipeStationOk(world, e, r)) { clear(); fail(current, CraftFail.NoStation); continue; }
    // progress is derived from startTick (no per-tick writes); the client predicts only this
    if (craftProgressTicks(world, e) + 1 < cr.data.totalTicks[cs]!) continue;
    if (!isAuthority(world)) continue; // the result lands by replication (owner-scoped Inventory) + reliable CraftCompleted
    const why = checkRecipe(world, e, r);
    clear();
    if (why) { fail(current, why); continue; }
    exchangeItems(world, e, r.ingredients, [r.output], false, crafterIdFor(world, e, r.output.item));
    if (world.getField(e, Worker, "job") === WorkerJob.Craft && world.has(e, WorkerOrder)) {
      const selected = Array.from(world.getArray(e, WorkerOrder, "selections") ?? []).filter(Boolean);
      const i = selected.indexOf(current); if (i >= 0) world.setField(e, WorkerOrder, "craftCursor", (i + 1) % selected.length);
    }
    recordRecentCraft(world, e, current); // Task 33: a finished craft joins the player's Recently Crafted list
    emit(world, CraftCompleted, { entity: e, recipe: current, item: r.output.item, count: r.output.count });
  }
}

/** Ticks of progress on the current job (0 if idle) = world.tick - startTick; UI: progress / totalTicks. */
export function craftProgressTicks(world: World, e: Entity, tick = world.tick): number {
  const c = world.get(e, Crafter); if (!c || !c.recipe) return 0;
  return Math.min(c.totalTicks, Math.max(0, tick - c.startTick));
}
