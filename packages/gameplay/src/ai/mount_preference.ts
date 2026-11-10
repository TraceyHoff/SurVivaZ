/**
 * ADR-339: an AI human tames a mount OF ITS CHOICE and keeps it until it dies (Task 37, user question 4).
 *
 * Most of the mount flow already exists (ADR-321 tame / ride / saddle / tend, ADR-323 liked-food fetch and
 * forage, ADR-322 mount death): this file adds only the missing "of their choice" preference, as pure,
 * testable functions the coordinator wires into `fillMountSensors` / `mountBehaviors` (see
 * /tmp/task37-339-integration.md). Nothing here touches the world, the planner, or storage rules.
 *
 * - Preference: deterministic per bot, seeded by the fnv1a hash of the bot's stable PlayerId (same technique
 *   as the Task 22 recruitment wanted-item and the Task 25 dye colour): a liked mount species from the
 *   rideable species in `mounts.json`, and its liked food (the species' `love` entries, first in file order).
 *   Same PlayerId -> same species and food on every peer and every session; no rng, no stored state.
 * - Tame choice: `pickTameTarget` reuses the ADR-321 score verbatim (gallop + hp/60 - distance * 0.15, lowest
 *   entity id wins ties) and adds `preferredSpeciesBonus` for candidates of the liked species. The bonus
 *   (default 10) exceeds the largest possible score spread between two species in range — gallop 3.2 +
 *   hp/60 2.83 + distance 3.6 = 9.63 — so a liked species in `seekRadius` always wins; with none present the
 *   pick falls back to the existing nearest / best-utility animal unchanged.
 * - Keep until it dies: `shouldSeekMount` is the guard (false while the bot's own mount is alive). The
 *   existing sensor pass already guarantees this — `fillMountSensors` only computes `tameMount` in the
 *   no-own-mount branch, and `tame_mount` / `tameRun` both require `!world.mount` — so the guard is a
 *   belt-and-braces predicate for the coordinator's wiring, not a behaviour change. Mounts can already die
 *   (ADR-322); after death the bot may seek again, preferring its liked species.
 * - Feeding: `preferredFeedFood` picks the best liked food (love > like > ok) the bot already carries for the
 *   mount's own species. That is the same order `bestMountFood` (mounts.ts) and the ADR-323 `likedFoods`
 *   already use for `feedItem` / fetch / forage, so no storage rule changes; this is the pure, tested form
 *   of that choice for the coordinator to call.
 */
import { fnv1a } from "@engine/core";
import { MOUNT_BOTS as B, MOUNT_SPECIES, type MountSpecies } from "../mount_defs.js";

/** A bot's mount preference: liked species (1-based index into the species table) and its liked food (item key). */
export interface MountPreference { species: number; key: string; food: string; }

/** Liked food keys of a species, best first (love > like > ok), file order inside each tier. */
export function likedFoodKeys(spec: Pick<MountSpecies, "foods">): string[] {
  const out: string[] = [];
  for (const pref of ["love", "like", "ok"] as const)
    for (const [k, p] of Object.entries(spec.foods)) if (p === pref) out.push(k);
  return out;
}

/**
 * Deterministic mount preference for a bot. `species` defaults to the full rideable table; a caller passing
 * a shorter list gets a 1-based index into that list (tests). The food is the species' first `love` food,
 * falling back to its first `like`, then `ok`; "" only when a species lists no food at all.
 */
export function preferredMount(playerId: number, species: readonly MountSpecies[] = MOUNT_SPECIES): MountPreference {
  const list = species.length ? species : MOUNT_SPECIES;
  const sp = list[fnv1a(`mount:${playerId}`) % list.length]!;
  return { species: list.indexOf(sp) + 1, key: sp.key, food: likedFoodKeys(sp)[0] ?? "" };
}

/** One wild rideable animal visible to the tame scan (already filtered: wild, unbanned, unclaimed, food on hand). */
export interface TameCandidate { id: number; x: number; y: number; species: number; }
export interface TamePickOptions { seekRadius?: number; preferredSpeciesBonus?: number; }

/**
 * Which wild animal to tame: the ADR-321 score plus `preferredSpeciesBonus` for the liked species, lowest
 * entity id on ties. Returns -1 when no candidate is in `seekRadius`. Kicker / claim / ban / food filtering
 * stays in the sensor pass that builds `candidates` — this only ranks what it is given.
 */
export function pickTameTarget(
  candidates: readonly TameCandidate[], fromX: number, fromY: number, preferredSpecies: number,
  species: readonly MountSpecies[] = MOUNT_SPECIES, opts: TamePickOptions = {},
): number {
  const radius = opts.seekRadius ?? B.seekRadius;
  const bonus = opts.preferredSpeciesBonus ?? B.preferredSpeciesBonus;
  let best = -1, bs = -Infinity;
  for (const c of candidates) {
    const spec = species[c.species - 1]; if (!spec) continue;
    const d = Math.hypot(c.x - fromX, c.y - fromY); if (d > radius) continue;
    const s = spec.gallop + spec.hp / 60 - d * 0.15 + (c.species === preferredSpecies ? bonus : 0);
    if (s > bs || (s === bs && (best < 0 || c.id < best))) { bs = s; best = c.id; }
  }
  return best;
}

/** The bot's own mount, as the keep-alive guard sees it (alive = present in the world, not Dead). */
export interface OwnMountState { alive: boolean; }
/** False while the bot's own mount is alive — it never seeks a new tame until that mount dies (or it has none). */
export function shouldSeekMount(ownMount: OwnMountState | undefined): boolean {
  return !ownMount || !ownMount.alive;
}

/**
 * The liked food to feed the bot's own mount: the best food of the mount's own species (love > like > ok)
 * among the item keys the bot already carries. Undefined when it carries none of the species' foods.
 */
export function preferredFeedFood(
  species: number, carriedItemKeys: readonly string[], speciesList: readonly MountSpecies[] = MOUNT_SPECIES,
): string | undefined {
  const spec = speciesList[species - 1]; if (!spec) return undefined;
  const carried = new Set(carriedItemKeys);
  for (const k of likedFoodKeys(spec)) if (carried.has(k)) return k;
  return undefined;
}
