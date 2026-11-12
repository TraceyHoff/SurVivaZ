/**
 * ADR-362: in-game guide — content model (data + loader).
 *
 * The guide's content lives in `data/guide.json`: 15 sections, one per game system, each with an id,
 * title, an icon reference (a key only — ADR-364 wires the art) and body items. Body items are one of:
 * - `{ text }` — short prose. Prose never carries a number: every duration, temperature, damage, cost or
 *   stat is a `{ fact, label, format }` entry instead, so the guide cannot drift from the game.
 * - `{ fact, label, format }` — a number rendered from the same data files and named constants the game
 *   itself reads. `resolveGuideFact` looks the path up in the registry below; an unknown path is a
 *   validation error, never a silent blank.
 * - `{ keys, label, action? | actions?, verify? }` — a controls row. `verify: "profile"` rows are checked
 *   against `packages/input/profiles/keyboardMouse.json` by the ADR-362 tests; the one `"client-menu"`
 *   row (the character-sheet hotkey) is checked against `apps/client/src/game-menus.ts`.
 * - `{ image, caption }` — an action image (ADR-364). `image` is an id in the client registry
 *   (`apps/client/src/task364-art.ts`, `GUIDE_ACTION_IMAGES`); the registry composes it from the game's own
 *   sprites and runtime-painted art, so the guide never invents art. The caption is prose: no digits.
 *
 * ADR-363 (UI) renders sections through `resolvedGuideSection`, which returns the same shape with every
 * fact already resolved to a display string. ADR-364 resolves the icon keys to art.
 */
import { DEFAULT_TICK_HZ } from "@engine/core";
import guideRaw from "../data/guide.json";
import farmingRaw from "../data/farming.json";
import petsRaw from "../data/pets.json";
import skillsRaw from "../data/skills.json";
import pvpRaw from "../data/pvp.json";
import dungRaw from "../data/dung.json";
import defenceRaw from "../data/ai_defence.json";
import journeyRaw from "../data/ai_journey.json";
import ropeRaw from "../data/rope.json";
import economyRaw from "../data/economy.json";
import fireRaw from "../data/fire.json";
import inputRaw from "../data/input.json";
import piecesRaw from "../data/pieces.json";
import { INVENTORY_SLOTS, PACK_SLOTS } from "./components.js";
import { defaultDefs } from "./data.js";
import { StationKind, WeatherKind } from "./defs.js";
import { CARE_CURE_SECONDS, FLU_AFTER_SECONDS } from "./diseases.js";
import { temperatureTier, wetnessStage } from "./exposure-stages.js";
import { FROST_KILL_F, LATE_FALL_DAYS } from "./farming.js";
import { MOUNT_SPECIES, MOUNT_TUNING, SADDLES, mountSpeciesOfKey } from "./mount_defs.js";
import { WANTED_ITEM_KEYS } from "./recruitment.js";
import { SAFE_SPAWN_RADIUS } from "./spawn_points.js";
import { FIRE_HEAT_MAX_C, FIRE_HEAT_TAU_S, FREEZING_C, WET_INSULATION_LOSS } from "./systems/environment.js";
import { SALT_CONSUME_TICKS } from "./systems/spoilage.js";
import { drawnSpeedCap, VEHICLE_DEFS, vehicleDefId } from "./vehicles.js";

// ---- content model ----------------------------------------------------------------------------------

/** Icon reference: a key only. The kind tells ADR-364 which table to resolve it against. */
export type GuideIconRef = `item:${string}` | `piece:${string}` | `vehicle:${string}` | `mount:${string}` | `pet:${string}`;

export type GuideFactFormat =
  | "duration" | "seconds" | "number" | "count" | "percent" | "multiplier"
  | "tempF" | "fahrenheit" | "tempRangeF" | "tempDelta" | "item" | "items" | "cost" | "text"
  | "tiles" | "slots" | "speed" | "durationRange";

export interface GuideFactItem { readonly fact: string; readonly label: string; readonly format: GuideFactFormat }
export interface GuideTextItem { readonly text: string }
export interface GuideKeysItem {
  readonly keys: readonly string[];
  readonly label: string;
  /** Input action(s) this row documents; the ADR-362 tests pin them to the default profile. */
  readonly action?: string;
  readonly actions?: readonly string[];
  /** "profile" (default): checked against packages/input/profiles/keyboardMouse.json. "client-menu":
   *  checked against the menu hotkeys in apps/client/src/game-menus.ts. */
  readonly verify?: "profile" | "client-menu";
}
/** An action image (ADR-364): `image` is an id in the client's GUIDE_ACTION_IMAGES registry; `caption`
 *  is prose (no digits), shown under the composed picture. */
export interface GuideImageItem { readonly image: string; readonly caption: string }
export type GuideItem = GuideTextItem | GuideFactItem | GuideKeysItem | GuideImageItem;
export interface GuideSection {
  readonly id: string;
  readonly title: string;
  readonly icon: GuideIconRef;
  readonly intro: string;
  readonly items: readonly GuideItem[];
}

/** A section with every fact resolved to its display string, ready for ADR-363 to render. */
export type ResolvedGuideItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "fact"; readonly label: string; readonly value: string }
  | { readonly kind: "keys"; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: "image"; readonly image: string; readonly caption: string };
export interface ResolvedGuideSection {
  readonly id: string;
  readonly title: string;
  readonly icon: GuideIconRef;
  readonly intro: string;
  readonly items: readonly ResolvedGuideItem[];
}

// ---- raw JSON shapes (narrow: only the fields the fact registry reads) -------------------------------

interface RawPiece { readonly key: string; readonly container?: number; readonly spoilMul?: number; readonly privilegeRadius?: number; readonly accepts?: readonly string[]; readonly stall?: { readonly listings: number }; readonly cost?: readonly { readonly resource: string; readonly amount: number }[] }
interface RawPetSpecies { readonly key: string; readonly treats: Record<string, string> }

const pieces = (piecesRaw as unknown as { pieces: RawPiece[] }).pieces;
const pieceByKey = (key: string): RawPiece | undefined => pieces.find((p) => p.key === key);
const pets = (petsRaw as unknown as { species: RawPetSpecies[] }).species;
const farming = farmingRaw as unknown as {
  readonly plantables: readonly { readonly growSeconds: number }[];
  readonly wateredSeconds: number; readonly fertilizerSeconds: number; readonly fertilizerMul: number;
  readonly unwateredMul: number; readonly dungFertilizerSeconds: number; readonly plantReach: number; readonly waterRadius: number;
};
const pvp = pvpRaw as unknown as {
  readonly bagOwnerOnlySeconds: number; readonly respawnSeconds: number; readonly respawnHealthFrac: number;
  readonly combatTagSeconds: number; readonly guestSafeSeconds: number;
  readonly despawn: { readonly deathBagSeconds: number; readonly droppedSeconds: number };
};
const dung = dungRaw as unknown as { readonly despawnSeconds: number; readonly perDay: number };
const defence = defenceRaw as unknown as { readonly maxTurrets: number; readonly maxWire: number };
const journey = journeyRaw as unknown as { readonly longTripTiles: number; readonly minPrepTiles: number };
const rope = ropeRaw as unknown as { readonly tuning: { readonly attachRange: number; readonly breakDistance: number } };
const economy = economyRaw as unknown as { readonly currency: string; readonly stallNameMax: number; readonly tillSlots: number; readonly ledgerSize: number };
const fire = fireRaw as unknown as { readonly dps: number; readonly spreadRadius: number; readonly spreadChance: number; readonly flammableTiers: readonly number[] };
const input = inputRaw as unknown as { readonly hotbarSlots: number };
const farmAnimals = Object.keys((skillsRaw as unknown as { husbandry: { animals: Record<string, unknown> } }).husbandry.animals);

// ---- formatting -------------------------------------------------------------------------------------

export const celsiusToFahrenheit = (c: number): number => Math.round((c * 9) / 5 + 32);

/** Seconds as a short human duration: "45 s", "5 min", "1 hour". */
export function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) { const h = seconds / 3600; return `${h} hour${h === 1 ? "" : "s"}`; }
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function formatTempRangeC(range: readonly [number, number]): string {
  return `${celsiusToFahrenheit(range[0])}–${celsiusToFahrenheit(range[1])} °F`;
}

/** Display name for an item key. Throws on an unknown key: the guide must never name an item that does not exist. */
function itemName(key: string): string {
  const defs = defaultDefs();
  const name = defs.items.get(defs.itemId(key))?.name;
  if (!name) throw new Error(`guide fact: unknown item ${key}`);
  return name;
}

/** Render one resolved fact value. `raw` is what the registry returned for the fact's path. */
export function formatGuideValue(raw: unknown, format: GuideFactFormat): string {
  switch (format) {
    case "duration": if (typeof raw !== "number") throw new Error(`duration fact needs a number, got ${typeof raw}`); return formatDuration(raw);
    case "seconds": if (typeof raw !== "number") throw new Error(`seconds fact needs a number, got ${typeof raw}`); return `${raw} s`;
    case "number": case "count": if (typeof raw !== "number") throw new Error(`${format} fact needs a number, got ${typeof raw}`); return String(raw);
    case "percent": if (typeof raw !== "number") throw new Error(`percent fact needs a number, got ${typeof raw}`); return `${Math.round(raw * 100)}%`;
    case "multiplier": if (typeof raw !== "number") throw new Error(`multiplier fact needs a number, got ${typeof raw}`); return `×${raw}`;
    case "tempF": if (typeof raw !== "number") throw new Error(`tempF fact needs °C, got ${typeof raw}`); return `${celsiusToFahrenheit(raw)} °F`;
    case "fahrenheit": if (typeof raw !== "number") throw new Error(`fahrenheit fact needs °F, got ${typeof raw}`); return `${raw} °F`;
    case "tempRangeF": {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "number" || typeof raw[1] !== "number") throw new Error("tempRangeF fact needs [min, max] °C");
      return formatTempRangeC([raw[0], raw[1]]);
    }
    case "tempDelta": if (typeof raw !== "number") throw new Error(`tempDelta fact needs °C, got ${typeof raw}`); return `+${raw} °C (+${Math.round((raw * 9) / 5)} °F)`;
    case "item": {
      if (raw === null || raw === undefined) return "Rest";
      if (typeof raw !== "string") throw new Error(`item fact needs an item key, got ${typeof raw}`);
      return itemName(raw);
    }
    case "items": {
      if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string")) throw new Error("items fact needs an array of item keys");
      return (raw as string[]).map(itemName).join(", ");
    }
    case "cost": {
      if (!Array.isArray(raw)) throw new Error("cost fact needs a cost array");
      return (raw as readonly { resource: string; amount: number }[]).map((c) => `${c.amount} ${itemName(c.resource)}`).join(", ");
    }
    case "text": return String(raw);
    case "tiles": if (typeof raw !== "number") throw new Error(`tiles fact needs a number, got ${typeof raw}`); return `${raw} tile${raw === 1 ? "" : "s"}`;
    case "slots": if (typeof raw !== "number") throw new Error(`slots fact needs a number, got ${typeof raw}`); return `${raw} slot${raw === 1 ? "" : "s"}`;
    case "speed": if (typeof raw !== "number") throw new Error(`speed fact needs a number, got ${typeof raw}`); return `${raw} tiles/s`;
    case "durationRange": {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "number" || typeof raw[1] !== "number") throw new Error("durationRange fact needs [min, max] seconds");
      const [lo, hi] = raw as [number, number];
      if (lo % 60 === 0 && hi % 60 === 0) return `${lo / 60}–${hi / 60} min`;
      return `${formatDuration(lo)}–${formatDuration(hi)}`;
    }
  }
}

// ---- fact registry: every path the guide may reference, resolved from the game's own data -------------

type FactResolver = () => unknown;
const disease = (key: string) => {
  const defs = defaultDefs();
  const d = defs.diseases.find((x) => x.key === key);
  if (!d) throw new Error(`guide fact: unknown disease ${key}`);
  return d;
};
const season = (key: "summer" | "fall" | "winter" | "spring") => {
  const seasons = defaultDefs().environment.seasons;
  if (!seasons) throw new Error("guide fact: seasons are off");
  const s = seasons.seasons.find((x) => x.key === key);
  if (!s) throw new Error(`guide fact: unknown season ${key}`);
  return s;
};
/**
 * Body-temperature tier boundaries (°C), derived by probing the game's own `temperatureTier` in 0.1°
 * steps — the thresholds live inside that function, not in a data file, so the guide reads them from
 * the code instead of copying the numbers.
 */
const bodyTierBoundary = (tier: "freezing" | "overheating"): number => {
  if (tier === "freezing") {
    let boundary = 30;
    for (let i = 300; i <= 370; i++) if (temperatureTier(i / 10) === "freezing") boundary = i / 10;
    return boundary;
  }
  for (let i = 370; i <= 420; i++) if (temperatureTier(i / 10) === "overheating") return i / 10;
  throw new Error("guide fact: no overheating boundary found in temperatureTier");
};
const horseGallopCap = (vehicleId: string): number => {
  const def = VEHICLE_DEFS[vehicleDefId(vehicleId) - 1];
  if (!def) throw new Error(`guide fact: unknown vehicle ${vehicleId}`);
  return drawnSpeedCap(def, mountSpeciesOfKey("horse"), true);
};
const loveTreats = (speciesKey: string): string[] => {
  const s = pets.find((p) => p.key === speciesKey);
  if (!s) throw new Error(`guide fact: unknown pet species ${speciesKey}`);
  return Object.entries(s.treats).filter(([, pref]) => pref === "love").map(([key]) => key);
};

/** Every fact path in guide.json, resolved from the data files / named constants the game reads. */
export const GUIDE_FACTS: Readonly<Record<string, FactResolver>> = {
  // diseases (data/diseases.json; care/flu constants in src/diseases.ts)
  "diseases.count": () => defaultDefs().diseases.length,
  "diseases.food_poisoning.durationSeconds": () => disease("food_poisoning").durationSeconds,
  "diseases.food_poisoning.cure": () => disease("food_poisoning").cure,
  "diseases.dysentery.durationSeconds": () => disease("dysentery").durationSeconds,
  "diseases.dysentery.cure": () => disease("dysentery").cure,
  "diseases.common_cold.durationSeconds": () => disease("common_cold").durationSeconds,
  "diseases.common_cold.cure": () => disease("common_cold").cure,
  "diseases.heatstroke.durationSeconds": () => disease("heatstroke").durationSeconds,
  "diseases.heatstroke.cure": () => disease("heatstroke").cure,
  "diseases.wound_infection.durationSeconds": () => disease("wound_infection").durationSeconds,
  "diseases.wound_infection.cure": () => disease("wound_infection").cure,
  "diseases.influenza.durationSeconds": () => disease("influenza").durationSeconds,
  "diseases.influenza.cure": () => disease("influenza").cure,
  "diseases.broken_leg.durationSeconds": () => disease("broken_leg").durationSeconds,
  "diseases.broken_leg.cure": () => disease("broken_leg").cure,
  "diseases.exhaustion.cure": () => disease("exhaustion").cure,
  "diseases.transmission.radiusTiles": () => defaultDefs().diseaseTuning.transmission.radiusTiles,
  "diseases.transmission.contactSeconds": () => defaultDefs().diseaseTuning.transmission.contactSeconds,
  "diseases.transmission.chance": () => defaultDefs().diseaseTuning.transmission.chance,
  "diseases.exposure.coldSeconds": () => defaultDefs().diseaseTuning.exposure.coldSeconds,
  "diseases.exposure.heatSeconds": () => defaultDefs().diseaseTuning.exposure.heatSeconds,
  "diseases.careCureSeconds": () => CARE_CURE_SECONDS,
  "diseases.fluAfterSeconds": () => FLU_AFTER_SECONDS,
  // temperature (src/systems/environment.ts, src/exposure-stages.ts, items.json wear)
  "temperature.fireHeatMaxC": () => FIRE_HEAT_MAX_C,
  "temperature.fireHeatTauSeconds": () => FIRE_HEAT_TAU_S,
  "temperature.freezingC": () => FREEZING_C,
  "temperature.frostKillF": () => FROST_KILL_F,
  "temperature.wetInsulationLoss": () => WET_INSULATION_LOSS,
  "temperature.furCoatInsulation": () => (defaultDefs().items.get(defaultDefs().itemId("fur_coat")) as unknown as { wear?: { insulation?: number } } | undefined)?.wear?.insulation,
  "temperature.furHatInsulation": () => (defaultDefs().items.get(defaultDefs().itemId("fur_hat")) as unknown as { wear?: { insulation?: number } } | undefined)?.wear?.insulation,
  "temperature.bodyFreezingC": () => bodyTierBoundary("freezing"),
  "temperature.bodyOverheatingC": () => bodyTierBoundary("overheating"),
  // seasons + weather (data/environment.json)
  "seasons.lengthDays": () => defaultDefs().environment.seasons?.lengthDays,
  "seasons.dayLengthSeconds": () => defaultDefs().environment.dayLengthSeconds,
  "seasons.summer.tempRange": () => season("summer").tempRange,
  "seasons.fall.tempRange": () => season("fall").tempRange,
  "seasons.winter.tempRange": () => season("winter").tempRange,
  "seasons.spring.tempRange": () => season("spring").tempRange,
  "seasons.summer.heatWaveRange": () => season("summer").heatWaveRange,
  "weather.rain.durationSeconds": () => defaultDefs().environment.weather.find((w) => w.kind === WeatherKind.Rain)?.durationSeconds,
  // inventory (src/components.ts, data/input.json)
  "inventory.packSlots": () => PACK_SLOTS,
  "inventory.hotbarSlots": () => input.hotbarSlots,
  "inventory.totalSlots": () => INVENTORY_SLOTS,
  // cooking + food (data/recipes.json via defs, data/environment.json spoilage, src/systems/spoilage.ts)
  "cooking.recipeCount": () => defaultDefs().recipes.size,
  "cooking.campfireRecipeCount": () => [...defaultDefs().recipes.values()].filter((r) => r.station === StationKind.Campfire).length,
  "food.spoilageStages": () => (defaultDefs().environment.spoilage.stages ?? []).map((s) => s.key).join(", "),
  "food.saltConsumeSeconds": () => SALT_CONSUME_TICKS / DEFAULT_TICK_HZ,
  "food.frozenBelowC": () => FREEZING_C,
  // building (data/pieces.json, data/tiers.json via defs)
  "building.claimRadiusTiles": () => pieceByKey("claim_totem")?.privilegeRadius,
  "building.claimCost": () => pieceByKey("claim_totem")?.cost,
  "building.maxPiecesPerZone": () => defaultDefs().building.maxPiecesPerZone,
  "building.maxLevel": () => defaultDefs().building.maxLevel,
  "building.containerReachTiles": () => defaultDefs().building.containerReach,
  "building.repairBlockedSeconds": () => defaultDefs().building.repairBlockedSeconds,
  "building.demolishRefund": () => defaultDefs().building.demolishRefund,
  // AI humans (src/recruitment.ts, data/ai_journey.json, data/ai_defence.json, src/spawn_points.ts)
  "ai.wantedPoolCount": () => WANTED_ITEM_KEYS.length,
  "ai.travelLongTripTiles": () => journey.longTripTiles,
  "ai.travelMinPrepTiles": () => journey.minPrepTiles,
  "ai.defenceMaxTurrets": () => defence.maxTurrets,
  "ai.defenceMaxWire": () => defence.maxWire,
  // safety (shared safe-spawn radius, src/spawn_points.ts)
  "safety.safeRadiusTiles": () => SAFE_SPAWN_RADIUS,
  // animals (data/pets.json, data/skills.json husbandry, data/dung.json, data/rope.json, data/mounts.json)
  "animals.petSpeciesCount": () => pets.length,
  "animals.petSkillMaxLevel": () => defaultDefs().animalSkillsTuning.xp.maxLevel,
  "animals.farmSpeciesCount": () => farmAnimals.length,
  "animals.dungDespawnSeconds": () => dung.despawnSeconds,
  "animals.dungPerDay": () => dung.perDay,
  "animals.dungFertilizerSeconds": () => farming.dungFertilizerSeconds,
  "animals.fertilizerSeconds": () => farming.fertilizerSeconds,
  "animals.ropeAttachRangeTiles": () => rope.tuning.attachRange,
  "animals.ropeBreakDistanceTiles": () => rope.tuning.breakDistance,
  "animals.troughRangeTiles": () => MOUNT_TUNING.troughRange,
  "animals.mountFedSeconds": () => MOUNT_TUNING.fedSeconds,
  "animals.treats.dog_lab": () => loveTreats("dog_lab"),
  "animals.treats.cat_tabby": () => loveTreats("cat_tabby"),
  "animals.treats.fox": () => loveTreats("fox"),
  "animals.treats.owl": () => loveTreats("owl"),
  // mounts + vehicles (data/mounts.json, data/vehicles.json via src/vehicles.ts)
  "mounts.speciesCount": () => MOUNT_SPECIES.length,
  "mounts.horse.walkSpeed": () => MOUNT_SPECIES[mountSpeciesOfKey("horse") - 1]?.walk,
  "mounts.horse.gallopSpeed": () => MOUNT_SPECIES[mountSpeciesOfKey("horse") - 1]?.gallop,
  "mounts.saddleCount": () => SADDLES.length,
  "mounts.saddleSlots": () => SADDLES.map((s) => `${s.name} ${s.slots}`).join(", "),
  "mounts.harnessItem": () => "harness",
  "vehicles.drawnCount": () => VEHICLE_DEFS.filter((d) => d.drawn).length,
  "vehicles.chariotGallopCap": () => horseGallopCap("chariot"),
  "vehicles.wagonLargeGallopCap": () => horseGallopCap("wagon_large"),
  "vehicles.carriageSeats": () => VEHICLE_DEFS[vehicleDefId("carriage") - 1]?.seats,
  "vehicles.wagonLargeStorageSlots": () => VEHICLE_DEFS[vehicleDefId("wagon_large") - 1]?.storage.slots,
  // farming (data/farming.json, src/farming.ts)
  "farming.plantableCount": () => farming.plantables.length,
  "farming.growMinSeconds": () => Math.min(...farming.plantables.map((p) => p.growSeconds)),
  "farming.growMaxSeconds": () => Math.max(...farming.plantables.map((p) => p.growSeconds)),
  "farming.wateredSeconds": () => farming.wateredSeconds,
  "farming.fertilizerSeconds": () => farming.fertilizerSeconds,
  "farming.fertilizerMul": () => farming.fertilizerMul,
  "farming.unwateredMul": () => farming.unwateredMul,
  "farming.dungFertilizerSeconds": () => farming.dungFertilizerSeconds,
  "farming.lateFallDormantDays": () => LATE_FALL_DAYS,
  "farming.plantReachTiles": () => farming.plantReach,
  "farming.waterRadiusTiles": () => farming.waterRadius,
  // storage (data/pieces.json, data/pvp.json)
  "storage.storeCount": () => ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"].filter((k) => pieceByKey(k)).length,
  "storage.storeSlots": () => pieceByKey("ore_store")?.container,
  "storage.oreAccepts": () => pieceByKey("ore_store")?.accepts,
  "storage.cropAcceptsCount": () => pieceByKey("crop_store")?.accepts?.length,
  "storage.saltBarrelMul": () => pieceByKey("salt_barrel")?.spoilMul,
  "storage.curingBoxMul": () => pieceByKey("curing_box")?.spoilMul,
  "storage.coldStoreMul": () => pieceByKey("cold_store")?.spoilMul,
  "storage.genericBoxSlots": () => pieceByKey("basic_storage_box")?.container,
  "storage.deathBagSeconds": () => pvp.despawn.deathBagSeconds,
  "storage.droppedSeconds": () => pvp.despawn.droppedSeconds,
  "storage.bagOwnerOnlySeconds": () => pvp.bagOwnerOnlySeconds,
  // combat + defence (data/zombies.json + data/fire.json via defs/raw, data/pvp.json)
  "combat.zombieNightRate": () => defaultDefs().spawning.ratePerMinute.night,
  "combat.zombieNightCap": () => defaultDefs().spawning.cap.night,
  "combat.zombieMinDistanceTiles": () => defaultDefs().spawning.minDistance,
  "combat.zombieMaxDistanceTiles": () => defaultDefs().spawning.maxDistance,
  "combat.fireDps": () => fire.dps,
  "combat.fireSpreadChance": () => fire.spreadChance,
  "combat.fireSpreadRadiusTiles": () => fire.spreadRadius,
  "combat.flammableTiers": () => fire.flammableTiers.map((i) => defaultDefs().tiers[i]?.key ?? `tier${i}`).join(", "),
  "combat.combatTagSeconds": () => pvp.combatTagSeconds,
  "combat.respawnSeconds": () => pvp.respawnSeconds,
  "combat.respawnHealthFrac": () => pvp.respawnHealthFrac,
  "combat.guestSafeSeconds": () => pvp.guestSafeSeconds,
  // multiplayer + trade (data/pieces.json stalls, data/economy.json)
  "trade.stallBlanketListings": () => pieceByKey("stall_blanket")?.stall?.listings,
  "trade.stallCartListings": () => pieceByKey("stall_cart")?.stall?.listings,
  "trade.stallBoothListings": () => pieceByKey("stall_booth")?.stall?.listings,
  "trade.stallPavilionListings": () => pieceByKey("clan_pavilion")?.stall?.listings,
  "trade.stallCounterListings": () => pieceByKey("market_counter")?.stall?.listings,
  "trade.stallNameMax": () => economy.stallNameMax,
  "trade.tillSlots": () => economy.tillSlots,
  "trade.ledgerSize": () => economy.ledgerSize,
  "trade.currency": () => economy.currency,
  // HUD icons (src/exposure-stages.ts wetness stages; body-temp tiers share the temperature paths)
  "icons.wetnessStages": () => [0.1, 0.5, 0.9].map((w) => wetnessStage(w)).join(", "),
};

/** Resolve one fact path to its display string. Throws on an unknown path, format or value. */
export function resolveGuideFact(path: string, format: GuideFactFormat): string {
  const resolver = GUIDE_FACTS[path];
  if (!resolver) throw new Error(`guide fact: unknown path ${path}`);
  const raw = resolver();
  if (raw === undefined) throw new Error(`guide fact: ${path} resolved to undefined`);
  return formatGuideValue(raw, format);
}

// ---- validation + accessors ---------------------------------------------------------------------------

const GUIDE_FORMATS: readonly GuideFactFormat[] = [
  "duration", "seconds", "number", "count", "percent", "multiplier", "tempF", "fahrenheit",
  "tempRangeF", "tempDelta", "item", "items", "cost", "text", "tiles", "slots", "speed", "durationRange",
];
const ICON_KINDS = ["item", "piece", "vehicle", "mount", "pet"] as const;
const ID_RE = /^[a-z][a-z0-9-]*$/;
const DIGIT_RE = /\d/;

function iconResolves(icon: string): boolean {
  const [kind, key] = icon.split(":", 2);
  if (!kind || !key || !(ICON_KINDS as readonly string[]).includes(kind)) return false;
  try {
    switch (kind) {
      case "item": defaultDefs().itemId(key); return true;
      case "piece": defaultDefs().pieceId(key); return true;
      case "vehicle": return vehicleDefId(key) > 0;
      case "mount": return mountSpeciesOfKey(key) > 0;
      case "pet": return pets.some((p) => p.key === key);
    }
  } catch { return false; }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a guide document (defaults to the shipped `data/guide.json`). Returns every problem found;
 * empty means the guide is well-formed, every fact resolves and every icon key exists. Prose must carry
 * no digits: any number a player reads comes from a fact entry, so it stays in step with the game.
 */
export function validateGuide(doc: unknown = guideRaw): string[] {
  const errs: string[] = [];
  if (!isRecord(doc) || !Array.isArray(doc.sections)) return ["guide: needs a sections array"];
  const seen = new Set<string>();
  doc.sections.forEach((raw, si) => {
    const where = `sections[${si}]`;
    if (!isRecord(raw)) { errs.push(`${where}: not an object`); return; }
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) errs.push(`${where}.id: needs a kebab-case id`);
    else if (seen.has(raw.id)) errs.push(`${where}.id: duplicate section ${raw.id}`);
    else seen.add(raw.id);
    if (typeof raw.title !== "string" || raw.title.length === 0) errs.push(`${where}.title: needs a non-empty title`);
    if (typeof raw.icon !== "string" || !iconResolves(raw.icon)) errs.push(`${where}.icon: unresolvable icon key ${String(raw.icon)}`);
    if (typeof raw.intro !== "string" || raw.intro.length === 0) errs.push(`${where}.intro: needs a non-empty intro`);
    else if (DIGIT_RE.test(raw.intro)) errs.push(`${where}.intro: prose must not contain digits (use a fact entry)`);
    if (!Array.isArray(raw.items) || raw.items.length === 0) { errs.push(`${where}.items: needs at least one body item`); return; }
    raw.items.forEach((item, ii) => {
      const iw = `${where}.items[${ii}]`;
      if (!isRecord(item)) { errs.push(`${iw}: not an object`); return; }
      const kinds = ["text", "fact", "keys", "image"].filter((k) => k in item);
      if (kinds.length !== 1) { errs.push(`${iw}: needs exactly one of text/fact/keys/image`); return; }
      if ("image" in item) {
        // An image id is a registry key, not a fact path: kebab-case, and the client (ADR-364 tests)
        // pins it to a GUIDE_ACTION_IMAGES entry — gameplay cannot import the client registry.
        if (typeof item.image !== "string" || !ID_RE.test(item.image)) errs.push(`${iw}.image: needs a kebab-case registry id`);
        if (typeof item.caption !== "string" || item.caption.length === 0) errs.push(`${iw}.caption: needs a non-empty caption`);
        else if (DIGIT_RE.test(item.caption)) errs.push(`${iw}.caption: prose must not contain digits (use a fact entry)`);
      } else if ("text" in item) {
        if (typeof item.text !== "string" || item.text.length === 0) errs.push(`${iw}.text: needs non-empty prose`);
        else if (DIGIT_RE.test(item.text)) errs.push(`${iw}.text: prose must not contain digits (use a fact entry)`);
      } else if ("fact" in item) {
        if (typeof item.fact !== "string" || !(item.fact in GUIDE_FACTS)) errs.push(`${iw}.fact: unknown fact path ${String(item.fact)}`);
        if (typeof item.label !== "string" || item.label.length === 0) errs.push(`${iw}.label: needs a non-empty label`);
        else if (DIGIT_RE.test(item.label)) errs.push(`${iw}.label: prose must not contain digits`);
        if (typeof item.format !== "string" || !(GUIDE_FORMATS as readonly string[]).includes(item.format)) errs.push(`${iw}.format: unknown format ${String(item.format)}`);
        if (typeof item.fact === "string" && item.fact in GUIDE_FACTS && typeof item.format === "string" && (GUIDE_FORMATS as readonly string[]).includes(item.format)) {
          try { resolveGuideFact(item.fact, item.format as GuideFactFormat); } catch (e) { errs.push(`${iw}: ${String((e as Error).message)}`); }
        }
      } else {
        if (!Array.isArray(item.keys) || item.keys.length === 0 || item.keys.some((k) => typeof k !== "string" || k.length === 0)) errs.push(`${iw}.keys: needs a non-empty array of key labels`);
        if (typeof item.label !== "string" || item.label.length === 0) errs.push(`${iw}.label: needs a non-empty label`);
        else if (DIGIT_RE.test(item.label)) errs.push(`${iw}.label: prose must not contain digits`);
        if (item.verify !== undefined && item.verify !== "profile" && item.verify !== "client-menu") errs.push(`${iw}.verify: must be "profile" or "client-menu"`);
        if (item.action !== undefined && typeof item.action !== "string") errs.push(`${iw}.action: must be an action name`);
        if (item.actions !== undefined && (!Array.isArray(item.actions) || item.actions.some((a) => typeof a !== "string"))) errs.push(`${iw}.actions: must be an array of action names`);
      }
    });
  });
  return errs;
}

let cached: readonly GuideSection[] | undefined;

/** All guide sections, validated. Throws when the shipped guide is malformed. */
export function getGuideSections(): readonly GuideSection[] {
  if (cached) return cached;
  const errs = validateGuide();
  if (errs.length) throw new Error(`guide.json invalid:\n${errs.join("\n")}`);
  cached = (guideRaw as unknown as { sections: GuideSection[] }).sections;
  return cached;
}

/** One section by id, or undefined. */
export function guideSection(id: string): GuideSection | undefined {
  return getGuideSections().find((s) => s.id === id);
}

/** One section with every fact resolved to its display string, for ADR-363 to render. */
export function resolvedGuideSection(id: string): ResolvedGuideSection | undefined {
  const s = guideSection(id);
  if (!s) return undefined;
  return {
    id: s.id, title: s.title, icon: s.icon, intro: s.intro,
    items: s.items.map((item): ResolvedGuideItem => {
      if ("text" in item) return { kind: "text", text: item.text };
      if ("fact" in item) return { kind: "fact", label: item.label, value: resolveGuideFact(item.fact, item.format) };
      if ("image" in item) return { kind: "image", image: item.image, caption: item.caption };
      return { kind: "keys", keys: item.keys, label: item.label };
    }),
  };
}
