/**
 * Data-only spawn tables, per-archetype behavior and human-bot steering data (data/spawns.json, ai.json, bots.json).
 * Gameplay owns no spawn loop or controller: an external PopulationSpawner / AgentController consumes these.
 * Validators return error strings (empty = valid); loaders throw on invalid data. Browser-safe, pure.
 */
import spawnsRaw from "../../data/spawns.json";
import aiRaw from "../../data/ai.json";
import botsRaw from "../../data/bots.json";
import zombiesRaw from "../../data/zombies.json";
import itemsRaw from "../../data/items.json";
import type { SpawnEntry as WorldSpawnEntry } from "@engine/world";
import { TRAIT_KEYS, scheduledAt, type Imperfections, type ScheduleSlot, type Traits } from "@engine/core";
import { isTameableAnimalKey } from "../tameable_defs.js";
export type TraitKey = (typeof TRAIT_KEYS)[number];

export type SpawnPhase = "night" | "dawn" | "day" | "dusk";
export const DAY_PHASES: readonly SpawnPhase[] = ["night", "dawn", "day", "dusk"];
export type GameMode = "sp" | "mp";
export type SpawnCategory = "zombies" | "animals" | "humans";
export type PhaseRecord = Record<SpawnPhase, number>;
const CATEGORY = { zombies: "zombie", animals: "animal", humans: "human_bot" } as const;
/** Gameplay spawn table row: engine SpawnEntry field names (@engine/world) + gameplay extras (biomeWeights, groupSpread, modes, fromZombies). */
export interface GameSpawnEntry {
  kind: string; category: "zombie" | "animal" | "human_bot"; fromZombies?: boolean; density: number; timeWeights?: PhaseRecord;
  biomeWeights: Record<string, number>; minPlayerDistance: number; maxPlayerDistance?: number; perChunkCap: number; globalCap: number;
  despawnDistance: number; group: [number, number]; groupSpread: number; modes: Record<GameMode, boolean>;
}
export interface SpawnData {
  chunkTiles: number; intervalSeconds: number; phases: string[]; biomes: Record<string, number>;
  modes: Record<GameMode, { densityMul: number; capMul: number }>; tables: Record<SpawnCategory, GameSpawnEntry[]>;
}
export type AggroMode = "hostile" | "territorial" | "defensive" | "passive";
export interface Perception { sightRange: number; hearingMul: number; fovDeg: number }
export interface AttackData { damage: number; range: number; cooldownSeconds: number; structureDamage?: number }
export interface LootEntry { item: string; min: number; max: number; chance: number }
/** ADR-495: per-phase activity multipliers for an animal archetype — 1.0 = fully active, ~0.4 =
 * sluggish (bedded down, rarely wanders, slow to engage). All four phases are required when the
 * field is present; a species with no entry is unwindowed (1.0 at every phase = today's behaviour). */
export interface ActivityWindow { night: number; dawn: number; day: number; dusk: number }
/** ADR-496: rare old animals — the extra loot an old variant drops on top of its normal table.
 * Only species in tuning.old.eligible carry these rows (and only real-art species are eligible). */
export interface ArchetypeBehavior {
  kind: "zombie" | "animal" | "human"; fromZombies?: boolean; hp?: number; speed?: number; perception?: Perception;
  aggro: { mode: AggroMode; range: number; leashRange: number }; flee: { hpFrac: number; range: number };
  wander: { radius: number; idleSeconds: [number, number] }; attack?: AttackData | null; loot: LootEntry[];
  /** ADR-495: night-activity window (animals only; zombies/humans ignore it). */
  activity?: ActivityWindow;
  /** ADR-496: extra loot rows rolled only for old variants of this species. */
  oldLoot?: LootEntry[];
  /** ADR-494: pack hunter — a target-less animal of this archetype joins a packmate's hunt. */
  pack?: boolean;
}
export interface AiData { archetypes: Record<string, ArchetypeBehavior>; tuning?: { chaseLimitTiles?: number; /** ADR-462: wild-animal drink/shade (cosmetic). */ animalDrink?: { chance?: number; radius?: number; nearPlayerTiles?: number; drinkSeconds?: [number, number] }; /** ADR-463: carrion crows circling a fresh kill (ground only). */ carrion?: { crowsPerKill?: number; circleRadius?: number; maxSeconds?: number; nearPlayerTiles?: number }; /** ADR-475: wild-deer herds graze and move on when the patch is bare. */ herd?: { grazeCooldownSeconds?: number; bareRadius?: number; bareFrac?: number; moveMinTiles?: number; moveMaxTiles?: number }; /** ADR-496: rare old animals — 2% of spawns of the eligible species are old (bigger, tougher, extra loot). `eligible` is the only species list: real-art species only (boar/wolf in the live pack — deer has the only other animal_* art, but deer is a mount species, so the tameable exclusion removes it), never a tameable species. */ old?: { chance?: number; scaleMul?: number; hpMul?: number; eligible?: string[] } } }
/** Fully resolved behavior (zombie fields merged from zombies.json). */
export interface ResolvedBehavior extends ArchetypeBehavior { hp: number; speed: number; perception: Perception; attack: AttackData | null }

export type Range = [number, number];
export interface Consideration { base: number; inputs: Record<string, number> }
export interface BotArchetype {
  role: string; traits: Record<TraitKey, Range>; routine: string; goals: { base: number; gear: number; food: number };
  imperfections: Imperfections;
  chat: Record<string, string[]>; utility: Record<string, Consideration>;
}
export interface BotData {
  traits: TraitKey[]; actions: string[]; situations: string[];
  routines: Record<string, ScheduleSlot[]>; archetypes: Record<string, BotArchetype>;
}

type Z = { zombies: { key: string; hp: number; speed: number; damage: number; structureDamage: number; attackRange: number; attackCooldownSeconds: number; sightRange: number; hearingMul: number }[];
  spawning: { ratePerMinute: PhaseRecord; cap: PhaseRecord; weights: PhaseRecord extends never ? never : Record<SpawnPhase, number[]> } };
const ZOMBIES = zombiesRaw as unknown as Z;
const ITEM_KEYS = new Set((itemsRaw as unknown as { items: { key: string }[] }).items.map((i) => i.key));

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonNeg = (v: unknown): boolean => num(v) && v >= 0;
const frac = (v: unknown): boolean => num(v) && v >= 0 && v <= 1;
const inSlot = (s: ScheduleSlot, t: number): boolean => (s.from <= s.to ? t >= s.from && t < s.to : t >= s.from || t < s.to);
/** Representative dayT per phase (gameplay dayPhase bounds: night 0.85-0.2, dawn -0.3, day -0.75, dusk -0.85). */
export const PHASE_MID: PhaseRecord = { night: 0.02, dawn: 0.25, day: 0.5, dusk: 0.8 };
const range = (v: unknown, ok: (n: unknown) => boolean): boolean => Array.isArray(v) && v.length === 2 && ok(v[0]) && ok(v[1]) && (v[0] as number) <= (v[1] as number);

export function validateSpawnData(d: SpawnData, ai: AiData = aiRaw as unknown as AiData): string[] {
  const err: string[] = [];
  if (!(num(d.chunkTiles) && d.chunkTiles > 0)) err.push("chunkTiles must be > 0");
  for (const m of ["sp", "mp"] as const) if (!d.modes?.[m] || !nonNeg(d.modes[m].densityMul) || !nonNeg(d.modes[m].capMul)) err.push(`modes.${m} invalid`);
  const zKeys = new Set(ZOMBIES.zombies.map((z) => z.key)); const seen = new Set<string>();
  for (const cat of ["zombies", "animals", "humans"] as const) {
    const t = d.tables?.[cat]; if (!Array.isArray(t)) { err.push(`tables.${cat} missing`); continue; }
    for (const e of t) {
      const p = `${cat}.${e.kind}`;
      if (seen.has(e.kind)) err.push(`${p}: duplicate`); seen.add(e.kind);
      if (!ai.archetypes[e.kind]) err.push(`${p}: no behavior in ai.json`);
      if (e.category !== CATEGORY[cat]) err.push(`${p}: category must be ${CATEGORY[cat]}`);
      if (cat === "animals" && !e.kind.startsWith("animal_")) err.push(`${p}: animal kinds must match art keys animal_*`);
      if (e.fromZombies) { if (!zKeys.has(e.kind)) err.push(`${p}: fromZombies but not in zombies.json`); }
      else if (!e.timeWeights || DAY_PHASES.some((ph) => !nonNeg(e.timeWeights![ph]))) err.push(`${p}: timeWeights needs night/dawn/day/dusk >= 0`);
      if (!nonNeg(e.density)) err.push(`${p}: density`);
      if (!nonNeg(e.minPlayerDistance) || !(num(e.despawnDistance) && e.despawnDistance > e.minPlayerDistance) || (e.maxPlayerDistance !== undefined && !(e.maxPlayerDistance >= e.minPlayerDistance))) err.push(`${p}: player distances`);
      const bw = Object.entries(e.biomeWeights ?? {});
      if (!bw.length) err.push(`${p}: biomeWeights empty`);
      for (const [b, w] of bw) { if (!(b in d.biomes)) err.push(`${p}: unknown biome ${b}`); if (!nonNeg(w)) err.push(`${p}: biome weight ${b}`); }
      const g = e.group; if (!Array.isArray(g) || !(Number.isInteger(g[0]) && g[0] >= 1 && Number.isInteger(g[1]) && g[1] >= g[0]) || !nonNeg(e.groupSpread)) err.push(`${p}: group`);
      if (!(Number.isInteger(e.perChunkCap) && e.perChunkCap >= 1 && Number.isInteger(e.globalCap) && e.globalCap >= e.perChunkCap)) err.push(`${p}: caps`);
      if (Array.isArray(g) && e.perChunkCap < g[0]) err.push(`${p}: perChunkCap below group min`);
      if (typeof e.modes?.sp !== "boolean" || typeof e.modes?.mp !== "boolean") err.push(`${p}: modes`);
      if (cat === "humans" && e.modes?.mp) err.push(`${p}: human bots must be disabled in mp`);
    }
  }
  return err;
}

export function validateAiData(d: AiData): string[] {
  const err: string[] = []; const zKeys = new Set(ZOMBIES.zombies.map((z) => z.key));
  for (const [k, a] of Object.entries(d.archetypes ?? {})) {
    if (!["zombie", "animal", "human"].includes(a.kind)) err.push(`${k}: kind`);
    if (a.fromZombies) { if (!zKeys.has(k)) err.push(`${k}: fromZombies but not in zombies.json`); }
    else {
      if (!(num(a.hp) && a.hp > 0) || !(num(a.speed) && a.speed > 0)) err.push(`${k}: hp/speed`);
      const pc = a.perception; if (!pc || !nonNeg(pc.sightRange) || !nonNeg(pc.hearingMul) || !(num(pc.fovDeg) && pc.fovDeg > 0 && pc.fovDeg <= 360)) err.push(`${k}: perception`);
      if (a.attack != null && (!(num(a.attack.damage) && a.attack.damage > 0) || !(num(a.attack.range) && a.attack.range > 0) || !(num(a.attack.cooldownSeconds) && a.attack.cooldownSeconds > 0))) err.push(`${k}: attack`);
    }
    if (!["hostile", "territorial", "defensive", "passive"].includes(a.aggro?.mode)) err.push(`${k}: aggro.mode`);
    if (!nonNeg(a.aggro?.range) || !nonNeg(a.aggro?.leashRange) || (a.aggro.mode !== "passive" && a.aggro.leashRange < a.aggro.range)) err.push(`${k}: aggro ranges`);
    if (a.aggro?.mode !== "passive" && !a.fromZombies && !a.attack) err.push(`${k}: aggressive archetype needs attack`);
    if (!frac(a.flee?.hpFrac) || !nonNeg(a.flee?.range)) err.push(`${k}: flee`);
    if (!nonNeg(a.wander?.radius) || !range(a.wander?.idleSeconds, nonNeg)) err.push(`${k}: wander`);
    // ADR-495: an activity window is all four phases, each a multiplier in (0, 1] — 0 would be a hard
    // window (never active in that phase), which the ADR rejects in favour of soft multipliers.
    if (a.activity !== undefined) {
      for (const ph of ["night", "dawn", "day", "dusk"] as const) {
        const v = a.activity[ph];
        if (!(num(v) && v > 0 && v <= 1)) err.push(`${k}: activity.${ph} must be in (0, 1]`);
      }
    }
    for (const l of a.loot ?? []) {
      if (!ITEM_KEYS.has(l.item)) err.push(`${k}: unknown loot item ${l.item}`);
      if (!(Number.isInteger(l.min) && l.min >= 0 && Number.isInteger(l.max) && l.max >= l.min) || !frac(l.chance)) err.push(`${k}: loot ${l.item}`);
    }
    // ADR-496: old-variant extra loot rows have the same shape as loot, and a species only carries
    // them when it is in tuning.old.eligible (otherwise the rows could never roll — dead data).
    for (const l of a.oldLoot ?? []) {
      if (!ITEM_KEYS.has(l.item)) err.push(`${k}: unknown oldLoot item ${l.item}`);
      if (!(Number.isInteger(l.min) && l.min >= 0 && Number.isInteger(l.max) && l.max >= l.min) || !frac(l.chance)) err.push(`${k}: oldLoot ${l.item}`);
    }
    if (a.oldLoot !== undefined && !(d.tuning?.old?.eligible ?? []).includes(k)) err.push(`${k}: oldLoot needs the species in tuning.old.eligible`);
    if (a.pack !== undefined && typeof a.pack !== "boolean") err.push(`${k}: pack must be boolean`);
  }
  // ADR-496: old-variant tuning — a chance in (0, 1), scales at or above 1 (an "old" animal is
  // never smaller or frailer), and the eligible list is animal archetypes only, never tameable.
  const old = d.tuning?.old;
  if (old !== undefined) {
    if (old.chance !== undefined && !(num(old.chance) && old.chance > 0 && old.chance < 1)) err.push("tuning.old.chance must be in (0, 1)");
    if (old.scaleMul !== undefined && !(num(old.scaleMul) && old.scaleMul >= 1)) err.push("tuning.old.scaleMul must be >= 1");
    if (old.hpMul !== undefined && !(num(old.hpMul) && old.hpMul >= 1)) err.push("tuning.old.hpMul must be >= 1");
    for (const k of old.eligible ?? []) {
      const a = d.archetypes[k];
      if (!a || a.kind !== "animal") err.push(`tuning.old.eligible: ${k} is not an animal archetype`);
      else if (isTameableAnimalKey(k)) err.push(`tuning.old.eligible: ${k} is tameable — old variants exclude tameable species`);
    }
  }
  return err;
}

export function validateBotData(d: BotData, ai: AiData = aiRaw as unknown as AiData): string[] {
  const err: string[] = []; const acts = new Set(d.actions); const activities = new Set([...d.actions, "wander"]);
  if (d.traits?.length !== TRAIT_KEYS.length || TRAIT_KEYS.some((t, i) => d.traits[i] !== t)) err.push(`traits must be core TRAIT_KEYS ${TRAIT_KEYS.join(",")}`);
  for (const [r, slots] of Object.entries(d.routines ?? {})) {
    if (!Array.isArray(slots) || slots.some((s) => !frac(s.from) || !frac(s.to) || !Array.isArray(s.prefer) || !s.prefer.length)) { err.push(`routine ${r}: slots need from/to in 0..1 and prefer[]`); continue; }
    for (let i = 0; i < 100; i++) { const t = (i + 0.5) / 100; const n = slots.filter((s) => inSlot(s, t)).length; if (n !== 1) { err.push(`routine ${r}: must cover the day exactly once (t=${t})`); break; } }
    for (const s of slots) for (const a of s.prefer) if (!activities.has(a)) err.push(`routine ${r}: unknown activity ${a}`);
  }
  for (const [k, b] of Object.entries(d.archetypes ?? {})) {
    if (ai.archetypes[k]?.kind !== "human") err.push(`${k}: needs a human behavior in ai.json`);
    for (const t of d.traits) if (!range(b.traits?.[t], frac)) err.push(`${k}: trait ${t} range`);
    for (const t of Object.keys(b.traits ?? {})) if (!(d.traits as string[]).includes(t)) err.push(`${k}: unknown trait ${t}`);
    if (!d.routines[b.routine]) err.push(`${k}: unknown routine ${b.routine}`);
    const g = b.goals; if (!g || ![g.base, g.gear, g.food].every(frac) || Math.abs(g.base + g.gear + g.food - 1) > 1e-6) err.push(`${k}: goals must be 0..1 and sum to 1`);
    const im = b.imperfections;
    if (!im || !range(im.reactionTicks, (n) => Number.isInteger(n) && (n as number) >= 0) || !(num(im.aimErrorRad) && im.aimErrorRad >= 0 && im.aimErrorRad <= Math.PI / 2)
      || !frac(im.inputJitter) || !frac(im.idlePauseChance) || !frac(im.lookAroundChance) || !frac(im.pathWobble)) err.push(`${k}: imperfections`);
    for (const s of d.situations) { const lines = b.chat?.[s]; if (!Array.isArray(lines) || !lines.length || lines.some((l) => typeof l !== "string" || !/^[a-z0-9_.]+$/i.test(l))) err.push(`${k}: chat ${s} needs text keys`); }
    for (const s of Object.keys(b.chat ?? {})) if (!d.situations.includes(s)) err.push(`${k}: unknown chat situation ${s}`);
    for (const a of d.actions) { const c = b.utility?.[a]; if (!c || !num(c.base) || Object.values(c.inputs ?? {}).some((w) => !num(w))) err.push(`${k}: utility ${a}`); }
    for (const a of Object.keys(b.utility ?? {})) if (!acts.has(a)) err.push(`${k}: unknown utility action ${a}`);
  }
  return err;
}

const must = (what: string, errs: string[]): void => { if (errs.length) throw new Error(`${what} invalid:\n  ${errs.join("\n  ")}`); };
export function loadPopulationData(raw: { spawns?: unknown; ai?: unknown; bots?: unknown } = {}): { spawns: SpawnData; ai: AiData; bots: BotData } {
  const ai = (raw.ai ?? aiRaw) as AiData, spawns = (raw.spawns ?? spawnsRaw) as SpawnData, bots = (raw.bots ?? botsRaw) as BotData;
  must("ai.json", validateAiData(ai)); must("spawns.json", validateSpawnData(spawns, ai)); must("bots.json", validateBotData(bots, ai));
  return { spawns, ai, bots };
}
let cached: ReturnType<typeof loadPopulationData> | undefined;
export const populationData = (): ReturnType<typeof loadPopulationData> => (cached ??= loadPopulationData());

/** Zombie fields come from zombies.json; others pass through. */
export function resolveBehavior(key: string, ai: AiData = populationData().ai): ResolvedBehavior {
  const a = ai.archetypes[key]; if (!a) throw new Error(`unknown archetype ${key}`);
  if (!a.fromZombies) return { ...a, hp: a.hp!, speed: a.speed!, perception: a.perception!, attack: a.attack ?? null };
  const z = ZOMBIES.zombies.find((q) => q.key === key)!;
  return { ...a, hp: z.hp, speed: z.speed, perception: { sightRange: z.sightRange, hearingMul: z.hearingMul, fovDeg: 360 },
    attack: { damage: z.damage, range: z.attackRange, cooldownSeconds: z.attackCooldownSeconds, structureDamage: z.structureDamage } };
}

/** Phase multiplier: explicit phaseMul, or (zombies) zombies.json ratePerMinute x weight share normalized so night of the walker = 1. */
export function phaseMultiplier(e: GameSpawnEntry, phase: SpawnPhase): number {
  if (!e.fromZombies) return e.timeWeights![phase];
  const i = ZOMBIES.zombies.findIndex((z) => z.key === e.kind); const s = ZOMBIES.spawning;
  const share = (ph: SpawnPhase): number => { const w = s.weights[ph]; const t = w.reduce((a, b) => a + b, 0); return t > 0 ? (w[i] ?? 0) / t : 0; };
  const ref = s.ratePerMinute.night * share("night") || 1;
  return (s.ratePerMinute[phase] * share(phase)) / ref;
}

/** Target live count for one chunk (spawner input). 0 when disabled for the mode or biome. */
export function chunkTarget(e: GameSpawnEntry, biomeTile: number, phase: SpawnPhase, mode: GameMode, d: SpawnData = populationData().spawns): number {
  if (!e.modes[mode]) return 0;
  const biome = Object.keys(d.biomes).find((b) => d.biomes[b] === biomeTile); const bw = biome ? e.biomeWeights[biome] ?? 0 : 0;
  const raw = e.density * bw * phaseMultiplier(e, phase) * d.modes[mode].densityMul;
  return Math.min(raw, capFor(e, mode, d).perChunk);
}
export function capFor(e: GameSpawnEntry, mode: GameMode, d: SpawnData = populationData().spawns): { perChunk: number; global: number } {
  const m = d.modes[mode].capMul; return { perChunk: Math.max(1, Math.floor(e.perChunkCap * m)), global: Math.max(1, Math.floor(e.globalCap * m)) };
}
/** All entries enabled in a mode (game-mode config hook). */
export function entriesForMode(mode: GameMode, d: SpawnData = populationData().spawns): { category: SpawnCategory; entry: GameSpawnEntry }[] {
  return (["zombies", "animals", "humans"] as const).flatMap((category) => d.tables[category].filter((e) => e.modes[mode]).map((entry) => ({ category, entry })));
}
/** Routine activity for a phase. */
export function routineActivity(archetype: string, phase: SpawnPhase, b: BotData = populationData().bots): string {
  const a = b.archetypes[archetype]; if (!a) throw new Error(`unknown bot ${archetype}`);
  return scheduledAt(b.routines[a.routine]!, PHASE_MID[phase])[0]!;
}
/** Roll traits in range from a caller-supplied rng (pass world.rngFor(...) - never Math.random). */
export function rollTraits(archetype: string, rand: () => number, b: BotData = populationData().bots): Traits {
  const a = b.archetypes[archetype]; if (!a) throw new Error(`unknown bot ${archetype}`);
  return Object.fromEntries(TRAIT_KEYS.map((t) => { const [lo, hi] = a.traits[t]; return [t, lo + (hi - lo) * rand()]; })) as unknown as Traits;
}
/** Score each utility action: base + sum(weight * signal), signals = traits + sensors (0..1; missing = 0). */
export function scoreUtilities(archetype: string, signals: Record<string, number>, b: BotData = populationData().bots): Record<string, number> {
  const a = b.archetypes[archetype]; if (!a) throw new Error(`unknown bot ${archetype}`);
  return Object.fromEntries(b.actions.map((act) => { const c = a.utility[act]!; let s = c.base; for (const [k, w] of Object.entries(c.inputs)) s += w * (signals[k] ?? 0); return [act, s]; }));
}

/**
 * Engine PopulationSpawner rows for a mode, built from entriesForMode + chunkTarget + capFor:
 * density = best-biome chunkTarget at the peak phase; timeWeights[phase] = that phase's best chunkTarget / density;
 * tiles = biome tiles with weight > 0; caps from capFor. Deterministic and pure.
 */
export function toSpawnEntries(mode: GameMode, d: SpawnData = populationData().spawns): WorldSpawnEntry[] {
  return entriesForMode(mode, d).map(({ entry: e }) => {
    const tiles = Object.entries(e.biomeWeights).filter(([, w]) => w > 0).map(([b]) => d.biomes[b]!).sort((a, b) => a - b);
    const per = Object.fromEntries(DAY_PHASES.map((ph) => [ph, Math.max(0, ...tiles.map((t) => chunkTarget(e, t, ph, mode, d)))])) as PhaseRecord;
    const density = Math.max(...DAY_PHASES.map((ph) => per[ph]));
    const timeWeights = Object.fromEntries(DAY_PHASES.map((ph) => [ph, density > 0 ? per[ph] / density : 0])) as PhaseRecord;
    const cap = capFor(e, mode, d);
    const out: WorldSpawnEntry = { kind: e.kind, category: e.category, density, timeWeights, tiles, minPlayerDistance: e.minPlayerDistance,
      perChunkCap: cap.perChunk, globalCap: cap.global, despawnDistance: e.despawnDistance, group: [e.group[0], Math.min(e.group[1], cap.perChunk)] };
    if (e.maxPlayerDistance !== undefined) out.maxPlayerDistance = e.maxPlayerDistance;
    return out;
  });
}
