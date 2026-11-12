/**
 * Face expressions (Expression component, networked + broadcast, not persisted, separate from Appearance).
 * gameplay.expression (authority) writes it from moods (data/expressions.json, first match wins) and emotes
 * (EmoteCmd from players/bots, or requestEmote from host code such as bot AgentOutput.emote). An emote beats
 * moods until untilTick. id = expressions index + 1 (0 = none); expressionKey() gives Render's resolveLayers key.
 */
import { defineCommand, defineResource, DEFAULT_TICK_HZ, type CommandHandlers, type Entity, type World } from "@engine/core";
import raw from "../data/expressions.json";
import { Animal, Dead, Expression, Health, HitReact, Survival } from "./components.js";
import { isAuthority } from "./config.js";

export type MoodSensor = "hitRecently" | "lowHealth" | "fleeing" | "hungry" | "thirsty" | "tired";
export interface MoodRule { when: MoodSensor; below?: number; expression: string; holdSeconds: number }
export interface ExpressionData { expressions: string[]; moods: MoodRule[]; emotes: Record<string, { expression: string; seconds: number }> }
export const EXPRESSION_DATA: ExpressionData = raw as unknown as ExpressionData;
export const EXPRESSION_EVERY = 5;
/** ADR-368: emote names / expression ids computed once — expressionSystem runs every 5 ticks and the
 * old code called Object.keys + indexOf per entity per pass. */
const EMOTE_NAMES: readonly string[] = Object.keys(EXPRESSION_DATA.emotes);
const EXPRESSION_IDS: ReadonlyMap<string, number> = new Map(EXPRESSION_DATA.expressions.map((k, i) => [k, i + 1]));
/** ADR-368: scratch for expressionSystem's entity collection (single-threaded sim; never re-entrant). */
const EXPR_ENTS: Entity[] = [];
const FLEE_STATE = 2; // AnimalState.Flee

export function validateExpressionData(d: ExpressionData): string[] {
  const errs: string[] = []; const known = new Set(d.expressions);
  if (d.expressions.length > 254) errs.push("too many expressions (u8)");
  for (const m of d.moods) if (!known.has(m.expression)) errs.push(`mood ${m.when}: unknown expression ${m.expression}`);
  for (const [k, e] of Object.entries(d.emotes)) { if (!known.has(e.expression)) errs.push(`emote ${k}: unknown expression ${e.expression}`); if (!(e.seconds > 0)) errs.push(`emote ${k}: seconds`); }
  return errs;
}
export const expressionId = (key: string): number => EXPRESSION_IDS.get(key) ?? 0;
export const expressionKey = (id: number): string => EXPRESSION_DATA.expressions[id - 1] ?? "";
/** Emote ids for the net chat u16 / EmoteCmd: index into Object.keys(emotes) + 1. */
export const emoteNames = (): string[] => Object.keys(EXPRESSION_DATA.emotes);
export const emoteId = (name: string): number => EMOTE_NAMES.indexOf(name) + 1;

export const EmoteCmd = defineCommand("gameplay.emote", { emote: "u16" });
export const EXPRESSION_COMMANDS = [EmoteCmd] as const;
/** Pending emotes (entity -> emote id), drained by the expression system. */
export const EmoteRequests = defineResource<Map<Entity, number>>("gameplay.EmoteRequests");
const requests = (w: World): Map<Entity, number> => { let m = w.getResource(EmoteRequests); if (!m) { m = new Map(); w.setResource(EmoteRequests, m); } return m; };
export function requestEmote(world: World, e: Entity, emote: number | string): boolean {
  const id = typeof emote === "string" ? emoteId(emote) : emote; if (id < 1 || id > EMOTE_NAMES.length) return false;
  requests(world).set(e, id); return true;
}
export function installExpressionCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(EmoteCmd, { validate: (v) => (v.emote >= 1 && v.emote <= emoteNames().length ? undefined : "bad_emote"), handle: (v, c) => { requestEmote(world, c.actor, v.emote); } });
}

/** ADR-368: getField reads instead of world.get() copies (Health / Survival / Animal per entity per pass). */
function mood(world: World, e: Entity): MoodRule | undefined {
  const hp = world.getField(e, Health, "hp"); const max = world.getField(e, Health, "max");
  const hunger = world.getField(e, Survival, "hunger"); const thirst = world.getField(e, Survival, "thirst");
  const stamina = world.getField(e, Survival, "stamina"); const maxStamina = world.getField(e, Survival, "maxStamina");
  const state = world.getField(e, Animal, "state");
  const hitAt = world.getField(e, HitReact, "startTick");
  for (const m of EXPRESSION_DATA.moods) {
    const b = m.below ?? 0;
    if (m.when === "hitRecently" && hitAt !== undefined && world.tick - hitAt < Math.max(1, Math.round(b * DEFAULT_TICK_HZ))) return m; // ADR-134: below = seconds
    if (m.when === "lowHealth" && hp !== undefined && max !== undefined && max > 0 && hp / max < b) return m;
    if (m.when === "fleeing" && state === FLEE_STATE) return m;
    if (m.when === "hungry" && hunger !== undefined && hunger < b) return m;
    if (m.when === "thirsty" && thirst !== undefined && thirst < b) return m;
    if (m.when === "tired" && stamina !== undefined && maxStamina !== undefined && maxStamina > 0 && stamina / maxStamina < b) return m;
  }
  return undefined;
}

/** Server-side emote expiry (not replicated; the component only carries id + untilTick). */
const EmoteUntil = defineResource<Map<Entity, number>>("gameplay.EmoteUntil");

export function expressionSystem(world: World): void {
  if (!isAuthority(world)) return;
  const tick = world.tick; const req = requests(world);
  let emoteUntil = world.getResource(EmoteUntil); if (!emoteUntil) { emoteUntil = new Map(); world.setResource(EmoteUntil, emoteUntil); }
  // ADR-368: one reused array instead of a Set + 4 spreads + sort per pass (an entity can match
  // several queries; sorting + in-place dedupe keeps the old deterministic order, once each).
  const ents = EXPR_ENTS; ents.length = 0;
  for (const e of world.query([Survival], [Dead])) ents.push(e);
  for (const e of world.query([Animal], [Dead])) ents.push(e);
  for (const e of world.query([HitReact], [Dead])) ents.push(e);
  for (const e of world.query([Expression])) ents.push(e);
  ents.sort((a, b) => a - b);
  let n = 0; for (let i = 0; i < ents.length; i++) { if (i === 0 || ents[i] !== ents[i - 1]) ents[n++] = ents[i]!; } ents.length = n;
  for (let ei = 0; ei < ents.length; ei++) {
    const e = ents[ei]!;
    if (!world.isAlive(e)) { emoteUntil.delete(e); continue; }
    const curId = world.getField(e, Expression, "id"); const curUntil = world.getField(e, Expression, "untilTick");
    const r = req.get(e);
    let id = 0, until = 0;
    if (r !== undefined) {
      const em = EXPRESSION_DATA.emotes[EMOTE_NAMES[r - 1]!]!; id = expressionId(em.expression); until = tick + Math.round(em.seconds * DEFAULT_TICK_HZ); emoteUntil.set(e, until);
    } else if ((emoteUntil.get(e) ?? 0) > tick) continue; // emote showing
    else {
      emoteUntil.delete(e);
      const m = world.has(e, Dead) ? undefined : mood(world, e);
      if (m) {
        id = expressionId(m.expression);
        if (curId === id && (curUntil ?? 0) > tick + EXPRESSION_EVERY) continue; // still held; avoid churn
        until = tick + Math.round(m.holdSeconds * DEFAULT_TICK_HZ) + EXPRESSION_EVERY;
      }
    }
    if (curId === undefined) { if (id) world.add(e, Expression, { id, untilTick: until }); continue; }
    if (!id) { if (curId && curUntil !== undefined && curUntil <= tick) world.set(e, Expression, { id: 0, untilTick: 0 }); continue; }
    if (curId !== id || curUntil !== until) world.set(e, Expression, { id, untilTick: until });
  }
  req.clear();
}
