/**
 * ADR-336: wants, aspirations, personality, moods and routines for AI humans (Task 37 slice 1).
 *
 * A wants layer that runs ONLY when the bot is otherwise idle — never displacing survival needs, job work,
 * or the saddle chain. Hired bots pursue personal wants only under the ADR-327 idle gate (view.hire.idle);
 * unhired bots only when makePlan would return "idle" (view.plan.goal === "idle") with no danger near and
 * needs met. Every behaviour here only moves the bot and emits the action strings / commands a human client
 * sends (eat / craft / gather / Use / wave emote); the server validates reach, recipes and costs as for players.
 *
 * Determinism: personality is derived, never rolled at runtime — the core traits come from the bot's identity
 * (rollTraits, seeded per world/slot) and curiosity / rhythm / favourite food / keepsake come from fnv1a of
 * the bot's stable identity id (the same technique as the Task 25 dye colour and the Task 22 recruitment
 * wanted-item). Same bot, same personality, across saves. Only want progress / mood history is stored, under
 * `identity.aiLife`, with lifeStateOf / flushAiLife mirroring socialMemoryOf / flushSocialMemory (a
 * game.agents.put partial shallow-merges into the stored identity, so `{ aiLife }` never clobbers `ai` or
 * `social`; addBot restores it by spreading the stored record into the identity).
 *
 * NOT wired here: fillLifeSensors must be called from buildAgentView (after the second fillHireSensors, last
 * sensor) and lifeBehaviors() added to the registry — see /tmp/task37-336-integration.md.
 */
import { Transform, fnv1a, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import { Health, Survival } from "../components.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { GameplayConfig } from "../config.js";
import { countItem, readSlots } from "../inventory.js";
import { goTo } from "./base_behaviors.js";
import { stuckOn } from "./autonomy.js";
import { nearWater } from "../systems/vitals.js";
import { currentPhaseKey } from "../combat/zombies.js";
import { UseCmd } from "../input.js";
import type { AgentOutputWithCommands } from "./agent_output.js";
import type { GameDefs } from "../defs.js";
import raw from "../../data/ai_life.json";

export type LifeWantKind = "eat_favourite" | "craft_keepsake" | "visit_water" | "socialize" | "tend_garden" | "rest";
export type LifeRhythm = "early" | "day" | "dusk" | "owl";
export type MoodLabel = "content" | "lonely" | "restless" | "weary" | "cheerful";
export type LifePhase = "night" | "dawn" | "day" | "dusk";
/** Personality: the five core traits (identity) + curiosity (fnv1a — no core trait covers it). All 0..1. */
export interface LifePersonality {
  sociability: number; industriousness: number; bravery: number; curiosity: number; greed: number;
  rhythm: LifeRhythm; favouriteFood: string; keepsake: string;
}
export interface LifeMood { label: MoodLabel; social: number; explore: number; rest: number }
export interface LifeWantDef { id: string; kind: LifeWantKind; weight: number; traits: Partial<Record<"sociability" | "industriousness" | "bravery" | "curiosity" | "greed", number>>; cooldownTicks: number }
export interface LifeWantTarget {
  id: string; kind: LifeWantKind; mood: MoodLabel;
  target?: { x: number; y: number }; slot?: number; recipe?: number; item?: number;
}
export interface LifeSensors { lifeWant?: LifeWantTarget; lifeMood?: LifeMood }
export interface LifeVitals { hunger: number; thirst: number; hp: number; cold: boolean }
export interface LifeRecent { tick: number; lastSocialTick: number; lastAttackedTick: number; lastWantTick: number }
/** Persisted per-bot life state (identity.aiLife). Personality is derived, never stored. */
export interface LifeState {
  v: 1; bornTick: number; activeWant?: string;
  completed: Record<string, { count: number; tick: number }>; snooze: Record<string, number>;
  lastSocialTick: number; lastAttackedTick: number; restStartedTick?: number;
}

const u01 = (h: number): number => h / 4294967296;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

// ---------------- data ----------------
interface LifeData {
  gating: { arriveTiles: number; attackedRecentTicks: number; cheerfulAfterTicks: number; dangerTiles: number; lonelyAfterTicks: number; minHp: number; minHunger: number; minThirst: number; restTicks: number; restlessAfterTicks: number; socialRangeTiles: number; socialTiles: number; wantCooldownTicks: number; waterSearchCap: number; waterSearchTiles: number };
  favouriteFoods: readonly string[]; keepsakes: readonly string[];
  mood: { cheerfulBonus: number; lonelySocialBonus: number; restlessExploreBonus: number; wearyRestBonus: number };
  rhythms: Record<LifeRhythm, { phases: readonly LifePhase[] }>;
  wants: readonly LifeWantDef[];
}
const PHASES: readonly LifePhase[] = ["night", "dawn", "day", "dusk"];
const KINDS: readonly LifeWantKind[] = ["eat_favourite", "craft_keepsake", "visit_water", "socialize", "tend_garden", "rest"];
const TRAIT_KEYS: readonly (keyof Pick<LifePersonality, "sociability" | "industriousness" | "bravery" | "curiosity" | "greed">)[] = ["sociability", "industriousness", "bravery", "curiosity", "greed"];
let lifeDataCache: LifeData | undefined;
/** Validated ai_life.json (throws on a bad shape, like populationData). */
export function lifeData(): LifeData {
  if (lifeDataCache) return lifeDataCache;
  const d = raw as unknown as Record<string, unknown>;
  const err: string[] = [];
  const g = d.gating as Record<string, unknown> | undefined;
  const numKeys = ["arriveTiles", "attackedRecentTicks", "cheerfulAfterTicks", "dangerTiles", "lonelyAfterTicks", "minHp", "minHunger", "minThirst", "restTicks", "restlessAfterTicks", "socialRangeTiles", "socialTiles", "wantCooldownTicks", "waterSearchCap", "waterSearchTiles"];
  if (!g || numKeys.some((k) => typeof g[k] !== "number")) err.push("gating must carry every numeric knob");
  const strList = (v: unknown): v is readonly string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
  if (!strList(d.favouriteFoods)) err.push("favouriteFoods must be a non-empty string list");
  if (!strList(d.keepsakes)) err.push("keepsakes must be a non-empty string list");
  const m = d.mood as Record<string, unknown> | undefined;
  if (!m || ["cheerfulBonus", "lonelySocialBonus", "restlessExploreBonus", "wearyRestBonus"].some((k) => typeof m[k] !== "number")) err.push("mood must carry every bonus knob");
  const r = d.rhythms as Record<string, { phases?: unknown }> | undefined;
  const rhythms: Partial<Record<LifeRhythm, { phases: readonly LifePhase[] }>> = {};
  for (const k of ["early", "day", "dusk", "owl"] as const) {
    const ph = r?.[k]?.phases;
    if (!Array.isArray(ph) || !ph.length || !ph.every((p) => PHASES.includes(p as LifePhase))) { err.push(`rhythms.${k}.phases must be a non-empty list of day phases`); continue; }
    rhythms[k] = { phases: ph as LifePhase[] };
  }
  const wants = d.wants as LifeWantDef[] | undefined;
  if (!Array.isArray(wants) || !wants.length) err.push("wants must be a non-empty list");
  else for (const w of wants) {
    if (typeof w.id !== "string" || !KINDS.includes(w.kind) || typeof w.weight !== "number" || typeof w.cooldownTicks !== "number") err.push(`want ${String(w.id)} must have id / kind / weight / cooldownTicks`);
    if (w.traits && Object.keys(w.traits).some((k) => !TRAIT_KEYS.includes(k as (typeof TRAIT_KEYS)[number]) || typeof (w.traits as Record<string, unknown>)[k] !== "number")) err.push(`want ${String(w.id)} traits must use personality trait names`);
  }
  if (err.length) throw new Error(`ai_life.json invalid: ${err.join("; ")}`);
  lifeDataCache = { gating: g as unknown as LifeData["gating"], favouriteFoods: d.favouriteFoods as readonly string[], keepsakes: d.keepsakes as readonly string[], mood: m as unknown as LifeData["mood"], rhythms: rhythms as LifeData["rhythms"], wants: wants as readonly LifeWantDef[] };
  return lifeDataCache;
}

// ---------------- personality (derived, deterministic) ----------------
/** Deterministic per-bot personality: identity traits + fnv1a streams off the stable bot id. */
export function personalityOf(agent: Agent): LifePersonality {
  const id = agent.identity.id; const d = lifeData();
  const t = agent.identity.traits ?? { bravery: 0.5, sociability: 0.5, greed: 0.5, industriousness: 0.5, chattiness: 0.5 };
  const pick = (list: readonly string[], salt: string): string => list[fnv1a(`${id}:${salt}`) % list.length]!;
  const rhythms: readonly LifeRhythm[] = ["early", "day", "dusk", "owl"];
  return {
    sociability: clamp01(num(t.sociability, 0.5)), industriousness: clamp01(num(t.industriousness, 0.5)),
    bravery: clamp01(num(t.bravery, 0.5)), greed: clamp01(num(t.greed, 0.5)),
    curiosity: u01(fnv1a(`${id}:curiosity`)),
    rhythm: rhythms[fnv1a(`${id}:rhythm`) % rhythms.length]!,
    favouriteFood: pick(d.favouriteFoods, "food"), keepsake: pick(d.keepsakes, "keepsake"),
  };
}
/** Does this bot's daily rhythm allow personal wants in `phase`? */
export const routineAllows = (p: LifePersonality, phase: LifePhase): boolean => lifeData().rhythms[p.rhythm].phases.includes(phase);

// ---------------- mood (pure) ----------------
/** Mood from (personality, vitals, recent events): lonely after long solitude, restless after long
 *  stretches with no want completed, weary when hurt / hungry / cold / recently attacked, cheerful just
 *  after a want is completed, content otherwise. The numeric nudges feed want scoring, not behaviour. */
export function deriveMood(_p: LifePersonality, vitals: LifeVitals, recent: LifeRecent): LifeMood {
  const g = lifeData().gating, m = lifeData().mood;
  const sinceSocial = recent.tick - recent.lastSocialTick, sinceWant = recent.tick - recent.lastWantTick;
  const hadWant = recent.lastWantTick > -1e8; // a completion exists to be recent / long ago about
  const attacked = recent.tick - recent.lastAttackedTick < g.attackedRecentTicks;
  const needy = vitals.hp < 0.6 || vitals.hunger < 0.6 || vitals.thirst < 0.6 || vitals.cold;
  if (needy || attacked) return { label: "weary", social: 0, explore: 0, rest: m.wearyRestBonus };
  if (sinceSocial > g.lonelyAfterTicks) return { label: "lonely", social: m.lonelySocialBonus, explore: 0, rest: 0 };
  if (hadWant && sinceWant > g.restlessAfterTicks) return { label: "restless", social: 0, explore: m.restlessExploreBonus, rest: 0 };
  if (hadWant && sinceWant < g.cheerfulAfterTicks) return { label: "cheerful", social: m.cheerfulBonus, explore: m.cheerfulBonus, rest: m.cheerfulBonus };
  return { label: "content", social: 0, explore: 0, rest: 0 };
}

// ---------------- persistence (identity.aiLife) ----------------
type LifeIdentity = Agent["identity"] & { aiLife?: unknown };
const lifeDirty = new WeakMap<Agent, number>();
export const LIFE_WRITE_DEBOUNCE_TICKS = 300;
/** The agent's LifeState (identity.aiLife, validated / created on first use). `tick` seeds bornTick. */
export function lifeStateOf(agent: Agent, tick = 0): LifeState {
  const id = agent.identity as LifeIdentity; const raw = id.aiLife as Partial<LifeState> | undefined;
  if (raw && (raw as { __ok?: true }).__ok) return raw as LifeState;
  const d = lifeData(); const known = new Set(d.wants.map((w) => w.id));
  const completed: LifeState["completed"] = {};
  if (raw && typeof raw.completed === "object" && raw.completed) {
    for (const [k, v] of Object.entries(raw.completed)) {
      if (!known.has(k) || !v || typeof v !== "object") continue;
      completed[k] = { count: Math.max(0, Math.floor(num(v.count))), tick: num(v.tick) };
    }
  }
  const snooze: LifeState["snooze"] = {};
  if (raw && typeof raw.snooze === "object" && raw.snooze) for (const [k, v] of Object.entries(raw.snooze)) if (known.has(k) && typeof v === "number") snooze[k] = v;
  const st: LifeState = {
    v: 1, bornTick: num(raw?.bornTick, tick),
    ...(raw?.activeWant && known.has(raw.activeWant) ? { activeWant: raw.activeWant } : {}),
    completed, snooze,
    lastSocialTick: num(raw?.lastSocialTick, num(raw?.bornTick, tick)),
    lastAttackedTick: num(raw?.lastAttackedTick, -1e9),
    ...(typeof raw?.restStartedTick === "number" ? { restStartedTick: raw.restStartedTick } : {}),
  };
  Object.defineProperty(st, "__ok", { value: true, enumerable: false }); id.aiLife = st; return st;
}
export function markAiLifeDirty(a: Agent, tick: number): void { if (!lifeDirty.has(a)) lifeDirty.set(a, tick); }
export type LifePut = (id: string, partial: { aiLife: LifeState }) => unknown;
/** Debounced write-through of dirty LifeState via game.agents.put; force on shutdown / bot removal. */
export function flushAiLife(agents: Iterable<Agent>, put: LifePut, tick: number, force = false): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const at = lifeDirty.get(a); if (at === undefined || (!force && tick - at < LIFE_WRITE_DEBOUNCE_TICKS)) continue;
    lifeDirty.delete(a); put(a.identity.id, { aiLife: JSON.parse(JSON.stringify(lifeStateOf(a))) as LifeState }); out.push(a.identity.id);
  }
  return out;
}
/** Record a want completion (count + tick), clear the active want, mark dirty. */
export function completeWant(agent: Agent, wantId: string, tick: number): void {
  const st = lifeStateOf(agent, tick); const c = st.completed[wantId] ?? { count: 0, tick };
  st.completed[wantId] = { count: c.count + 1, tick };
  if (st.activeWant === wantId) delete st.activeWant;
  delete st.restStartedTick; markAiLifeDirty(agent, tick);
}
/** Park a want until `tick + ticks` (stuck target / unreachable water): it scores 0 until then. */
export function snoozeWant(agent: Agent, wantId: string, tick: number, ticks = 1200): void {
  const st = lifeStateOf(agent, tick); st.snooze[wantId] = tick + ticks;
  if (st.activeWant === wantId) delete st.activeWant;
  markAiLifeDirty(agent, tick);
}
export const lastWantTick = (st: LifeState): number => {
  const ts = Object.values(st.completed).map((c) => c.tick);
  return ts.length ? Math.max(...ts) : -1e9; // never completed: no cheerful / restless baseline
};

// ---------------- defs lookup (cached per GameDefs) ----------------
const defIx = new WeakMap<GameDefs, { itemId: Map<string, number>; handRecipe: Map<number, number> }>();
function defIndex(defs: GameDefs): { itemId: Map<string, number>; handRecipe: Map<number, number> } {
  let ix = defIx.get(defs); if (ix) return ix;
  ix = { itemId: new Map(), handRecipe: new Map() };
  for (const d of defs.items.values()) ix.itemId.set(d.key, d.id);
  for (const r of defs.recipes.values()) if (r.station === 0 && !ix.handRecipe.has(r.output.item)) ix.handRecipe.set(r.output.item, r.id);
  defIx.set(defs, ix); return ix;
}
const slotOf = (world: World, self: Entity, item: number): number => {
  let slots: ReturnType<typeof readSlots>; try { slots = readSlots(world, self); } catch { return -1; }
  for (let i = 0; i < slots.items.length; i++) if (slots.items[i] === item && slots.counts[i]) return i;
  return -1;
};
/** Nearest water-adjacent tile to `home` (spiral rings, capped): the scenic-spot target. */
export function nearestWaterTile(world: World, home: { x: number; y: number }): { x: number; y: number } | undefined {
  const g = lifeData().gating; const cx = Math.floor(home.x), cy = Math.floor(home.y); let checked = 0;
  for (let r = 0; r <= g.waterSearchTiles; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (++checked > g.waterSearchCap) return undefined;
      const x = cx + dx + 0.5, y = cy + dy + 0.5;
      if (nearWater(world, x, y)) return { x, y };
    }
  }
  return undefined;
}

// ---------------- want selection ----------------
export interface PickOpts { phase?: LifePhase; tick?: number }
const traitAffinity = (p: LifePersonality, w: LifeWantDef): number => {
  const entries = Object.entries(w.traits) as [keyof LifeWantDef["traits"], number][];
  if (!entries.length) return 0.5;
  let sum = 0, wsum = 0;
  for (const [k, wt] of entries) { sum += wt * ((p[k as keyof LifePersonality] as number) - 0.5); wsum += Math.abs(wt); }
  return clamp01(0.5 + (wsum ? sum / wsum : 0));
};
/**
 * Highest-priority unmet personal want for this bot, or null. Pure over (personality, state, mood, view)
 * except the water probe and bag reads. A want scores 0 when it is not actionable right now (favourite
 * food not carried, keepsake already owned or its hand recipe unaffordable, no water / nobody in range,
 * no garden work), on cooldown, snoozed, or outside the bot's daily rhythm. The active want gets a
 * stickiness bonus so the bot does not flip-flop between sense ticks.
 */
export function pickPersonalWant(agent: Agent, world: World, view: AgentWorldView & LifeSensors, opts: PickOpts = {}): LifeWantTarget | null {
  const defs = world.getResource(GameplayConfig)?.defs;
  const p = personalityOf(agent); const st = lifeStateOf(agent, world.tick);
  const tick = opts.tick ?? world.tick;
  const phase = opts.phase ?? currentPhaseKey(world);
  const self = agent.bb.get<Entity>("selfEntity");
  const sv = self !== undefined ? world.get(self, Survival) : undefined;
  const hp = self !== undefined ? world.get(self, Health) : undefined;
  const vitals: LifeVitals = {
    hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100,
    hp: hp ? hp.hp / Math.max(1, hp.max) : 1, cold: view.cold === true,
  };
  return pickWithMood(agent, world, view, p, st, tick, phase, defs ? defIndex(defs) : undefined, defs, vitals);
}
/** pickPersonalWant with the caller-supplied mood inputs (fillLifeSensors passes the real vitals-derived ones). */
export function pickWithMood(agent: Agent, world: World, view: AgentWorldView & LifeSensors, p: LifePersonality, st: LifeState, tick: number, phase: LifePhase, ix: { itemId: Map<string, number>; handRecipe: Map<number, number> } | undefined, defs: GameDefs | undefined, vitals?: LifeVitals): LifeWantTarget | null {
  if (!routineAllows(p, phase)) return null;
  const d = lifeData(); const g = d.gating;
  const mood = deriveMood(p, vitals ?? vitalsOf(world, agent.bb.get<Entity>("selfEntity")), { tick, lastSocialTick: st.lastSocialTick, lastAttackedTick: st.lastAttackedTick, lastWantTick: lastWantTick(st) });
  const self = agent.bb.get<Entity>("selfEntity");
  let best: LifeWantTarget | null = null; let bestScore = 0;
  for (const w of d.wants) {
    const done = st.completed[w.id];
    if (done && tick - done.tick < w.cooldownTicks) continue;
    if ((st.snooze[w.id] ?? -1e9) > tick) continue;
    const affinity = traitAffinity(p, w);
    const nudge = w.kind === "socialize" ? mood.social : w.kind === "visit_water" ? mood.explore : w.kind === "rest" ? mood.rest : 0;
    let score = w.weight * (0.35 + 0.65 * affinity) * (1 + nudge);
    if (st.activeWant === w.id) score *= 1.5;
    let target: LifeWantTarget | undefined;
    if (w.kind === "eat_favourite") {
      if (!ix) continue;
      const item = ix.itemId.get(p.favouriteFood); if (item === undefined) continue;
      const slot = self !== undefined ? slotOf(world, self, item) : -1;
      if (slot < 0) continue;
      target = { id: w.id, kind: w.kind, mood: mood.label, slot, item };
    } else if (w.kind === "craft_keepsake") {
      if (!ix || !defs) continue;
      const item = ix.itemId.get(p.keepsake); if (item === undefined) continue;
      if (self !== undefined && countItem(world, self, item) > 0) continue; // already owns one
      const recipe = ix.handRecipe.get(item); if (recipe === undefined) continue;
      const r = defs.recipes.get(recipe); if (!r) continue;
      if (self !== undefined && !r.ingredients.every((ing) => countItem(world, self, ing.item) >= ing.count)) continue;
      target = { id: w.id, kind: w.kind, mood: mood.label, recipe, item };
    } else if (w.kind === "visit_water") {
      const at = nearestWaterTile(world, view.home);
      if (!at) continue;
      if (self !== undefined) { const t = world.get(self, Transform); if (t && Math.hypot(t.x - at.x, t.y - at.y) <= g.arriveTiles) continue; }
      target = { id: w.id, kind: w.kind, mood: mood.label, target: at };
    } else if (w.kind === "socialize") {
      if (self === undefined) continue;
      const t = world.get(self, Transform); if (!t) continue;
      const other = agent.memory.nearest("player", t.x, t.y);
      if (!other || other.id === self) continue;
      if (Math.hypot(other.x - t.x, other.y - t.y) > g.socialRangeTiles) continue;
      target = { id: w.id, kind: w.kind, mood: mood.label, target: { x: other.x, y: other.y } };
    } else if (w.kind === "tend_garden") {
      if (!view.farm) continue;
      const f = view.farm; const at = f.harvest ?? f.tend ?? (f.till && !f.till.lack ? { x: f.till.x, y: f.till.y } : undefined);
      if (!at) continue;
      target = { id: w.id, kind: w.kind, mood: mood.label, target: { x: at.x, y: at.y } };
    } else {
      target = { id: w.id, kind: w.kind, mood: mood.label, target: { x: view.home.x, y: view.home.y } };
    }
    if (target && score > bestScore) { bestScore = score; best = target; }
  }
  return best;
}
const vitalsOf = (world: World, self: Entity | undefined): LifeVitals => {
  const sv = self !== undefined ? world.get(self, Survival) : undefined;
  const hp = self !== undefined ? world.get(self, Health) : undefined;
  return {
    hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100,
    hp: hp ? hp.hp / Math.max(1, hp.max) : 1, cold: false, // no view here; callers with one pass vitals explicitly
  };
};

// ---------------- idle gating ----------------
export interface IdleInput { hunger: number; thirst: number; hp: number; cold: boolean }
/** Needs met for personal wants (0..100 hunger/thirst, 0..1 hp). Stricter than the saddle chain: a bot that
 *  is even peckish does chores, not hobbies. */
export const needsMetForLife = (v: IdleInput): boolean => {
  const g = lifeData().gating;
  return v.hunger >= g.minHunger && v.thirst >= g.minThirst && v.hp >= g.minHp && !v.cold;
};
/**
 * May this bot run personal wants right now? Hired: the ADR-327 flag only (its needs/danger checks already
 * live in hireSaddleNeedsMet). Unhired: the planner is idle (no step/leaves/hunt), nothing the bot still
 * has to do (no wanted gather, no craft/build, no trip, no travel route, no repair), no danger near, needs met.
 */
export function isLifeIdle(world: World, self: Entity, view: AgentWorldView & LifeSensors, agent: Agent): boolean {
  if (view.hire?.idle === true) return true;
  if (view.hire !== undefined) return false; // hired but not idle: employer work (or Follow duty) comes first
  const plan = view.plan;
  if (!plan || plan.goal !== "idle" || plan.step !== undefined || plan.leaves.length > 0 || plan.hunt.length > 0) return false;
  if (view.tripWanted || view.gatherNode?.wanted || view.craftRecipe !== undefined || view.buildPlan !== undefined) return false;
  if (view.travel?.route !== undefined || view.defend !== undefined || view.repairTarget !== undefined) return false;
  if (view.cold) return false;
  const t = world.get(self, Transform); if (!t) return false;
  const z = agent.memory.nearest("zombie", t.x, t.y, 0.3);
  if (z && Math.hypot(z.x - t.x, z.y - t.y) < lifeData().gating.dangerTiles) return false;
  const sv = world.get(self, Survival); const hp = world.get(self, Health);
  return needsMetForLife({ hunger: sv?.hunger ?? 100, thirst: sv?.thirst ?? 100, hp: hp ? hp.hp / Math.max(1, hp.max) : 1, cold: false });
}

// ---------------- sensors (unwired: coordinator calls from buildAgentView, last) ----------------
/**
 * Fill life sensors. Updates mood history from the replica (a nearby AI human / player counts as social
 * contact; a zombie close by counts as an attack scare), completes the active want when its condition is
 * met in the world, then — only when idle — picks the bot's personal want into view.lifeWant. When not
 * idle the stale want is cleared but the active want is kept, so the bot resumes it when idle again.
 */
export function fillLifeSensors(world: World, self: Entity, view: AgentWorldView & LifeSensors, agent: Agent): void {
  const tick = world.tick; const g = lifeData().gating;
  const st = lifeStateOf(agent, tick);
  const t = world.get(self, Transform);
  if (t) {
    const other = agent.memory.nearest("player", t.x, t.y, 0.3);
    if (other && other.id !== self && Math.hypot(other.x - t.x, other.y - t.y) <= g.socialTiles) st.lastSocialTick = tick;
    const z = agent.memory.nearest("zombie", t.x, t.y, 0.3);
    if (z && Math.hypot(z.x - t.x, z.y - t.y) <= g.socialTiles) st.lastAttackedTick = tick;
  }
  const sv = world.get(self, Survival); const hp = world.get(self, Health);
  const vitals: LifeVitals = {
    hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100,
    hp: hp ? hp.hp / Math.max(1, hp.max) : 1, cold: view.cold === true,
  };
  const mood = deriveMood(personalityOf(agent), vitals, { tick, lastSocialTick: st.lastSocialTick, lastAttackedTick: st.lastAttackedTick, lastWantTick: lastWantTick(st) });
  view.lifeMood = mood;
  // ---- complete the active want when the world says so (eat/socialize/garden complete in the behaviour) ----
  if (st.activeWant === "keepsake" && self !== undefined) {
    const defs = world.getResource(GameplayConfig)?.defs;
    const item = defs ? defIndex(defs).itemId.get(personalityOf(agent).keepsake) : undefined;
    if (item !== undefined && countItem(world, self, item) > 0) completeWant(agent, "keepsake", tick);
  } else if (st.activeWant === "visit_water") {
    const at = nearestWaterTile(world, view.home);
    if (t && at && Math.hypot(t.x - at.x, t.y - at.y) <= g.arriveTiles) completeWant(agent, "visit_water", tick);
  } else if (st.activeWant === "tend_garden" && !view.farm) {
    completeWant(agent, "tend_garden", tick); // the garden work is gone (done, by anyone)
  } else if (st.activeWant === "rest") {
    if (t && Math.hypot(t.x - view.home.x, t.y - view.home.y) <= 4) {
      if (st.restStartedTick === undefined) { st.restStartedTick = tick; markAiLifeDirty(agent, tick); }
      else if (tick - st.restStartedTick >= g.restTicks) completeWant(agent, "rest", tick);
    } else if (st.restStartedTick !== undefined) { delete st.restStartedTick; markAiLifeDirty(agent, tick); }
  }
  if (!isLifeIdle(world, self, view, agent)) { delete view.lifeWant; return; }
  const defs = world.getResource(GameplayConfig)?.defs;
  const want = pickWithMood(agent, world, view, personalityOf(agent), st, tick, currentPhaseKey(world), defs ? defIndex(defs) : undefined, defs, vitals);
  if (want) {
    if (st.activeWant !== want.id) { st.activeWant = want.id; markAiLifeDirty(agent, tick); }
    if (want.id === "rest" && t && Math.hypot(t.x - view.home.x, t.y - view.home.y) <= 4 && st.restStartedTick === undefined) {
      st.restStartedTick = tick; markAiLifeDirty(agent, tick); // the rest timer starts when the want is picked
    }
    view.lifeWant = want;
  } else {
    if (st.activeWant !== undefined) { delete st.activeWant; markAiLifeDirty(agent, tick); }
    delete view.lifeWant;
  }
}

// ---------------- behaviors (unwired: coordinator adds to the registry) ----------------
type Ctx = AgentContext<AgentWorldView & LifeSensors>;
const step01 = { type: "step" as const, at: 0.5 };
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };
/** One behaviour dispatching on view.lifeWant.kind — the sensor already gated it to idle bots. */
export function lifeBehaviors(): GameBehavior[] {
  return [
    { name: "life_want", inertia: 0.1, traits: { sociability: 0.3 }, considerations: [
        { name: "want", curve: step01, input: (c) => ((c.world as AgentWorldView & LifeSensors).lifeWant ? 1 : 0) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) },
        { name: "idle", curve: step01, input: (c) => (c.world.hire?.idle === true || c.world.plan?.goal === "idle" ? 1 : 0) }],
      run: (c, o) => {
        const w = (c.world as AgentWorldView & LifeSensors).lifeWant; if (!w) return false;
        const tick = c.self.tick;
        if (w.kind === "eat_favourite") {
          if (w.slot === undefined) return false;
          o.actions.push(`eat:${w.slot}`); completeWant(c.agent, w.id, tick); return false;
        }
        if (w.kind === "craft_keepsake") {
          if (w.recipe === undefined) return false;
          if (tick - c.bb.num("lifeActAt", -1e9) < 200) return;
          o.actions.push(`craft:${w.recipe}`); c.bb.set("lifeActAt", tick); return false; // completion: sensor sees the keepsake in the bag
        }
        if (w.kind === "visit_water" || w.kind === "rest") {
          const at = w.target ?? c.world.home;
          const d = goTo(c, o, at.x, at.y);
          if (d <= lifeData().gating.arriveTiles) {
            if (w.kind === "visit_water") completeWant(c.agent, w.id, tick);
            else stop(o); // rest completes in the sensor after restTicks near home
            return false;
          }
          if (stuckOn(c, at.x, at.y)) { snoozeWant(c.agent, w.id, tick); return false; }
          return;
        }
        if (w.kind === "socialize") {
          const other = c.memory.nearest("player", c.self.x, c.self.y);
          const selfE = c.agent.bb.get<Entity>("selfEntity");
          if (!other || (selfE !== undefined && other.id === selfE)) return false;
          const d = goTo(c, o, other.x, other.y);
          if (d < 3) { stop(o); o.emote = "wave"; completeWant(c.agent, w.id, tick); return false; }
          if (stuckOn(c, other.x, other.y)) { snoozeWant(c.agent, w.id, tick); return false; }
          return;
        }
        if (w.kind === "tend_garden") {
          const f = c.world.farm; if (!f) return false;
          if (f.till && !f.harvest && !f.tend) {
            const tl = f.till; if (tl.lack) return false; // hoe is in storage: not a tendable garden right now
            if (goTo(c, o, tl.x, tl.y) > 0.9) { if (stuckOn(c, tl.x, tl.y)) { snoozeWant(c.agent, w.id, tick); return false; } return; }
            stop(o);
            if (tick - c.bb.num("lifeActAt", -1e9) < 20) return;
            (o as unknown as AgentOutputWithCommands).commands ??= [];
            (o as AgentOutputWithCommands).commands!.push({ type: UseCmd.name, payload: { slot: tl.slot } });
            c.bb.set("lifeActAt", tick); completeWant(c.agent, w.id, tick); return false;
          }
          const target = f.harvest ?? f.tend; if (!target) return false;
          if (goTo(c, o, target.x, target.y) > 1.2) { if (stuckOn(c, target.x, target.y)) { snoozeWant(c.agent, w.id, tick); return false; } return; }
          stop(o);
          if (f.harvest) { o.actions.push("gather"); completeWant(c.agent, w.id, tick); return false; }
          const td = f.tend!;
          if (tick - c.bb.num("lifeActAt", -1e9) < 20) return;
          (o as unknown as AgentOutputWithCommands).commands ??= [];
          (o as unknown as AgentOutputWithCommands).commands!.push({ type: UseCmd.name, payload: { slot: td.slot } });
          c.bb.set("lifeActAt", tick); completeWant(c.agent, w.id, tick); return false;
        }
        return false;
      } },
  ];
}
