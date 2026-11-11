/**
 * ADR-351 rope leading: data (data/rope.json) and pure helpers. Kept free of system imports (components,
 * config and core only) so pets.ts (panel), the AI behaviours and the client overlay can read it without
 * ESM cycles.
 *
 * Leadable = a land farm animal in rope.json `farm` (the husbandry species from skills.json, minus
 * animal_bee: bees fly, and honey goes to the Apiary) or — when `mounts` is true — any rideable mount
 * species from mounts.json. Pets are not leadable: they already Follow.
 */
import raw from "../data/rope.json";
import { animalDefs } from "./population.js";
import { mountSpeciesOfAnimal } from "./mount_defs.js";

export const ROPE_TUNING: Readonly<typeof raw.tuning> = raw.tuning;
export const ROPE_BOTS: Readonly<typeof raw.bots> = raw.bots;
export const ROPE_FARM: readonly string[] = raw.farm;
export const ROPE_MOUNTS: boolean = raw.mounts;

/** Animal archetype key (ai.json `animal_*`) of an Animal.kind index, undefined when unknown. */
export const animalKeyOfKind = (kind: number): string | undefined => animalDefs()[kind]?.key;

/** True when the animal archetype key is a leadable farm species (rope.json `farm`). */
export const isLeadableFarmKey = (key: string | undefined): boolean => !!key && ROPE_FARM.includes(key);
/** True when the animal archetype key is a rideable mount species and rope.json allows leading mounts. */
export const isLeadableMountKey = (key: string | undefined): boolean => ROPE_MOUNTS && !!key && mountSpeciesOfAnimal(key) > 0;
/** True when the animal archetype key is leadable at all (farm species or, when allowed, a mount species). */
export const isLeadableKey = (key: string | undefined): boolean => isLeadableFarmKey(key) || isLeadableMountKey(key);
