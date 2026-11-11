/**
 * ADR-354 tameable animals don't attack on sight: the single tameable-species list.
 *
 * Tameable = a rideable mount species (mounts.json), a pet species (pets.json), or a farm
 * animal (skills.json husbandry.animals) — the same data the taming / husbandry systems
 * already read, so a species added to any taming path gets the calm rule automatically and
 * no caller keeps its own species list. Kept free of system imports (data JSON +
 * mount_defs only) so population.ts can read it without ESM cycles (pets.ts and
 * skills/husbandry.ts both import population.ts).
 */
import petsRaw from "../data/pets.json";
import skillsRaw from "../data/skills.json";
import { MOUNT_SPECIES } from "./mount_defs.js";

export interface PetSpeciesRow { animal: string }
export interface HusbandryData { animals: Record<string, unknown> }

/** Every animal archetype key (ai.json `animal_*`) with a taming path, deduplicated. */
export const TAMEABLE_ANIMAL_KEYS: readonly string[] = [...new Set([
  ...MOUNT_SPECIES.flatMap((s) => s.animals.map((a) => a.key)),
  ...(petsRaw as unknown as { species: PetSpeciesRow[] }).species.map((s) => s.animal),
  ...Object.keys((skillsRaw as unknown as { husbandry: HusbandryData }).husbandry.animals),
])];

/** True when the animal archetype key has a taming path (mount, pet or farm animal). */
export const isTameableAnimalKey = (key: string | undefined): boolean => !!key && TAMEABLE_ANIMAL_KEYS.includes(key);
