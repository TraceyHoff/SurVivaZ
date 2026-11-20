/**
 * ADR-471: water you can trust — river risk + wells run low.
 *
 * Two halves, one module. (1) River risk: drinking straight from a tile (or sipping a raw
 * container) is no longer one flat rate — the chance depends on the water feature under the
 * drinker, read through the existing `waterFeatureAt` layout. A river (0.05) is riskier than a
 * lake or pond (0.025, the old flat rate), an elevated or great lake (0.01) is safest; anything
 * else falls back to the old flat rate. (2) Wells: a well piece holds a level of sips
 * (environment.wells.capacity, 12). Rain recharges it (+1 sip per rainSecondsPerSip of rain,
 * 60 s), past the 2-day drought clock a well loses dryDrainSipsPerDay (2) per further dry day,
 * and drawing at a well swaps a raw container for its well variant — well water never rolls
 * dysentery. Wells are enumerated only on weather changes, day boundaries and Uses, never per
 * tick; the dry check that runs every tick is a few integer comparisons.
 *
 * State: the level lives on a networked + persistent `Well` component on the piece (so it
 * survives a save and replicates to the client); the rain/drought clock lives on a runtime-only
 * `WellWaterRes` resource (it resets on reload — a well never drains twice for the same dry day
 * in one session, but a reload can cost it one 2-sip drain if the world loads already past the
 * drought clock, and rain that is already falling at load recharges nothing when it ends).
 *
 * Honest cut: the client renders no text for failed Uses today, so the "Well is dry" prompt is a
 * client follow-up, not shipped in v1 — the sim emits `ConsumeFailed: Empty` (testable).
 */
import { DEFAULT_TICK_HZ, defineResource, timeOfDay, Transform, type Entity, type World } from "@engine/core";
import { waterFeatureAt, waterFeatureLayout } from "@engine/world";
import { BuildPiece, Well } from "./components.js";
import { gameplayDefs, isAuthority, rangeSlack } from "./config.js";
import { readSlots, writeSlots } from "./inventory.js";
import { WeatherChanged } from "./events.js";
import { WeatherKind } from "./defs.js";
import { isRaining } from "./realism.js";

/** Runtime-only rain/drought clock for wells (resets on reload; see the header note). */
const WellWaterRes = defineResource<{ rainStartTick: number; lastRainEndTick: number; lastDrainDay: number }>("gameplay.WellWater");
function wellWaterRes(world: World): { rainStartTick: number; lastRainEndTick: number; lastDrainDay: number } {
  const existing = world.getResource(WellWaterRes);
  if (existing) return existing;
  const fresh = { rainStartTick: -1, lastRainEndTick: 0, lastDrainDay: 0 };
  world.setResource(WellWaterRes, fresh);
  return fresh;
}

/** One in-game day in ticks — the same dayLengthTicks the 2-day drought clock is built from
 *  (`droughtTicks` in farming.ts is 2 × this; wells.ts reads it directly instead of importing
 *  farming, which would close a wells → farming → vitals → wells import cycle). */
function dayTicks(world: World): number {
  const len = timeOfDay(world).dayLengthTicks;
  return len > 0 ? len : 3600 * DEFAULT_TICK_HZ;
}

/** The numeric piece id of the well piece (pieces.json "well"). */
function wellPieceId(world: World): number {
  return gameplayDefs(world).pieceId("well");
}

/** Every well piece in the world (event-only enumeration — weather change, day boundary, Use). */
export function wellsOf(world: World): Entity[] {
  const id = wellPieceId(world);
  return [...world.query([BuildPiece, Transform])].filter((e) => world.get(e, BuildPiece)?.type === id);
}

/** Sips left in a well. A well without the component yet (stamped, placed or loaded before this
 *  ADR) is lazy-attached at full on first touch — a pre-471 well starts full. On a non-authority
 *  replica the level is only read (the attach is authority-only, like the draw). */
export function wellLevel(world: World, e: Entity): number {
  const cap = gameplayDefs(world).environment.wells.capacity;
  const w = world.get(e, Well);
  if (!w) {
    if (isAuthority(world)) world.add(e, Well, { level: cap });
    return cap;
  }
  return w.level;
}

export function setWellLevel(world: World, e: Entity, level: number): void {
  const cap = gameplayDefs(world).environment.wells.capacity;
  const clamped = Math.max(0, Math.min(cap, Math.floor(level)));
  const w = world.get(e, Well);
  if (w) world.setField(e, Well, "level", clamped);
  else if (isAuthority(world)) world.add(e, Well, { level: clamped });
}

/** Nearest well within reach of an entity (the same reach the Boil action uses). */
export function nearestWell(world: World, e: Entity): Entity | undefined {
  const t = world.get(e, Transform);
  if (!t) return undefined;
  const reach = gameplayDefs(world).building.containerReach + rangeSlack(world, e);
  let best: Entity | undefined;
  let bestD = reach * reach;
  for (const w of wellsOf(world)) {
    const wt = world.get(w, Transform);
    if (!wt) continue;
    const dx = wt.x - t.x, dy = wt.y - t.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { best = w; bestD = d; }
  }
  return best;
}

/**
 * Dysentery chance for drinking straight from the water at (x, y) — the river-risk half.
 * Checks the drinker's own tile first, then the 8 neighbours (a drinker on the bank drinks the
 * adjacent water). The first water feature found wins: river 0.05, elevated / great lake 0.01,
 * lake / pond the old flat rate; no guaranteed feature nearby (biome sea, a stray puddle) falls
 * back to the flat rate. The layout is computed once per call, not once per tile.
 */
export function drinkWaterChance(world: World, x: number, y: number): number {
  const causes = gameplayDefs(world).diseaseTuning.causes;
  const layout = waterFeatureLayout(world.seed);
  const tx = Math.floor(x), ty = Math.floor(y);
  const offsets: [number, number][] = [[0, 0], [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (const [dx, dy] of offsets) {
    const f = waterFeatureAt(world.seed, tx + dx, ty + dy, layout);
    if (f === "river") return causes.riverWaterChance;
    if (f === "elevatedLake" || f === "greatLake") return causes.isolatedWaterChance;
    if (f === "lake" || f === "pond") return causes.rawWaterChance;
  }
  return causes.rawWaterChance;
}

/**
 * Draw water from the nearest well in reach into a container slot (the well half of a Use).
 * Returns undefined when no well is in reach, { added: 0, dry: true } when the nearest well is
 * dry, and { added: n, dry: false } when n sips were drawn. The well loses exactly the sips
 * drawn; a raw container becomes its well variant at the well, a boiled or well container stays
 * itself (boiled water is already safe, and a well container is already safe).
 */
export function drawFromWell(world: World, e: Entity, slot: number): { added: number; dry: boolean } | undefined {
  const well = nearestWell(world, e);
  if (!well) return undefined;
  const level = wellLevel(world, well);
  if (level <= 0) return { added: 0, dry: true };
  const defs = gameplayDefs(world);
  const v = readSlots(world, e);
  if (slot < 0 || slot >= v.slotCount) return { added: 0, dry: false };
  const item = v.item(slot);
  const idef = defs.items.get(item);
  const max = idef?.sips ?? 0;
  if (!idef || !max) return { added: 0, dry: false };
  const cur = v.durability(slot);
  const next = Math.min(max, cur + level);
  if (next === cur) return { added: 0, dry: false };
  const added = next - cur;
  v.put(slot, idef.wellTarget || item, v.count(slot), v.created(slot), next);
  writeSlots(world, e, v, defs);
  setWellLevel(world, well, level - added);
  return { added, dry: false };
}

/**
 * Dry-drain check, called from the top of weatherSystem (after the authority guard, before the
 * early return while weather is still running). When the dry spell since the last rain end
 * crosses a new day boundary past the 2-day drought clock, every well loses
 * dryDrainSipsPerDay sips — one drain per dry day, never a catch-up lump. The per-tick cost is
 * a few integer comparisons; the well enumeration only runs on a crossed boundary.
 */
export function wellDryCheck(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const res = wellWaterRes(world);
  const day = dayTicks(world);
  if (day <= 0) return;
  const dryDays = Math.floor((world.tick - res.lastRainEndTick) / day);
  if (dryDays < 2 || dryDays <= res.lastDrainDay) return;
  res.lastDrainDay = dryDays;
  const drain = gameplayDefs(world).environment.wells.dryDrainSipsPerDay;
  for (const well of wellsOf(world)) setWellLevel(world, well, wellLevel(world, well) - drain);
}

/** Rain recharge: +1 sip per rainSecondsPerSip of rain, capped at capacity, on every rain end. */
export function installWells(world: World): void {
  world.events.on(WeatherChanged, (p: { from: WeatherKind; to: WeatherKind; intensity: number; ticks: number }) => {
    if (!isAuthority(world) || world.isReplaying) return;
    const res = wellWaterRes(world);
    if (isRaining(p.to)) {
      if (res.rainStartTick < 0) res.rainStartTick = world.tick;
      return;
    }
    if (!isRaining(p.from)) return;
    const start = res.rainStartTick;
    res.rainStartTick = -1;
    res.lastRainEndTick = world.tick;
    if (start < 0) return; // rain was already falling when this world loaded — no start was tracked
    const seconds = (world.tick - start) / DEFAULT_TICK_HZ;
    const sips = Math.floor(seconds / gameplayDefs(world).environment.wells.rainSecondsPerSip);
    if (sips <= 0) return;
    for (const well of wellsOf(world)) setWellLevel(world, well, wellLevel(world, well) + sips);
  });
}
