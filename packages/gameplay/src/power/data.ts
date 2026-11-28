/**
 * ADR-590 electricity tier: power data (data/power.json) and the per-piece power spec lookup.
 * Kept import-light (json + types only) so building/place.ts and systems can read it without import cycles.
 */
import raw from "../../data/power.json";

export type PowerRole = "source" | "battery" | "consumer" | "pylon";
export type PowerSourceKind = "fuel" | "solar" | "wind" | "water";
export type PowerUse = "switch" | "craft" | "food" | "grow" | "always";
export interface PowerSpec {
  readonly role: PowerRole; readonly kind?: PowerSourceKind; readonly produce?: number; readonly watts?: number;
  /** battery / solar-generator capacity (Wh of sim time) and max charge / discharge (W) */
  readonly store?: number; readonly rate?: number;
  /** link reach in tiles (see power.json $comment) */
  readonly reach: number;
  readonly use?: PowerUse; readonly speed?: number; readonly heat?: number; readonly heatRadius?: number;
  /** water mills: "on" = stands in water, "adjacent" = beside a water tile */
  readonly water?: "on" | "adjacent";
  /** fridge / freezer: food temperature while powered (C) */
  readonly coldC?: number;
}
export interface PowerData {
  everyTicks: number; topologyEveryTicks: number; standbyFraction: number;
  solar: { seasonMul: Record<string, number>; weatherMul: Record<string, number> };
  wind: { cutIn: number; rated: number; cutOut: number; largeHubMul: number };
  water: { riverMul: number; shallowRiverMul: number; stillMul: number };
  fuel: { liquidSeconds: Record<string, number>; solidMul: number; minLoad: number };
  hydroponics: { growMul: number; yieldMul: number; tempMinC: number; tempMaxC: number; diseaseResist: number; spots: number; fertilizerItems: Record<string, number> };
  poweredTier: { tier: string; watts: Record<string, number>; lightRadius: number; heat: number; heatRadius: number; pieces: string[] };
  pieces: Record<string, PowerSpec>;
}
export const POWER: PowerData = raw as unknown as PowerData;
/** Tier index of the powered building tier in tiers.json (resolved lazily by key; -1 = absent). */
let poweredTierIdx: number | undefined;
export function poweredTierIndex(tiers: readonly { key: string }[]): number {
  if (poweredTierIdx === undefined) poweredTierIdx = tiers.findIndex((t) => t.key === POWER.poweredTier.tier);
  return poweredTierIdx;
}
const TIER_PIECES = new Set(POWER.poweredTier.pieces);
/** ADR-590: may this tiered piece be built in the powered tier? */
export const poweredTierAllowed = (key: string): boolean => TIER_PIECES.has(key);
const tierSpecs = new Map<string, PowerSpec>();
/** Spec of a powered-tier piece: always-on consumer (light + heat while powered). */
function tierSpec(key: string, family: string): PowerSpec {
  let s = tierSpecs.get(key); if (s) return s;
  const fam = key === "pillar" ? "pillar" : family === "foundation" ? "foundation" : family === "floor" ? "floor" : "wall";
  s = { role: "consumer", watts: POWER.poweredTier.watts[fam] ?? 20, reach: 0, use: "always", heat: POWER.poweredTier.heat, heatRadius: POWER.poweredTier.heatRadius };
  tierSpecs.set(key, s); return s;
}
/** Power spec of a piece def at a tier (undefined = not part of the grid). `tiers` = defs.tiers. */
export function powerSpecFor(def: { key?: string; family?: string; tiered?: boolean } | undefined, tier: number, tiers: readonly { key: string }[]): PowerSpec | undefined {
  const key = def?.key; if (!key) return undefined;
  const s = POWER.pieces[key]; if (s) return s;
  if (def.tiered && tier === poweredTierIndex(tiers) && TIER_PIECES.has(key)) return tierSpec(key, def.family ?? "");
  return undefined;
}
/** True for any electricity-tier piece key (fixed pieces only; powered-tier pieces are tier-dependent). */
export const isPowerPieceKey = (key: string | undefined): boolean => !!key && key in POWER.pieces;
