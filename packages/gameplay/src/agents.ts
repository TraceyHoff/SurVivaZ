/**
 * Gameplay behaviors for virtual players (human bots) on @engine/core's agent framework (ai.ts).
 * Behaviors read an AgentWorldView built from the bot's OWN client replica (what a human would see on screen) and
 * only write AgentOutput (move axes / aim / action names / chat) - the host maps that to the same InputFrame +
 * commands a human client sends. Survival Systems extends this with registerBehavior() and data/agents.json.
 */
import { pickSkillNode, treesOf } from "./skills/progression.js";
import { Progression } from "./components.js";
import { Agent, AgentController, BehaviorRegistry, ChatTemplates, Rng, Transform, canSee, entityIndex, timeOfDay, sunFractionOf, type AgentContext, type AgentIdentity, type AgentSelf, type BehaviorDef, type ScheduleSlot, type World, type Entity, type Imperfections, type PerceptionConfig } from "@engine/core";
import raw from "../data/agents.json";
import { Animal, Dead, Health, ResourceNode, Survival, Zombie, WorkerJob } from "./components.js";
import { currentPhaseKey } from "./combat/zombies.js";
import { populationData, rollTraits, scoreUtilities } from "./ai/population.js";
import { fillAgentSensors, survivalBehaviors, type AgentSensors } from "./ai/survivor_behaviors.js";
import { fillPartySensors, partyBehaviors, type PartySensors } from "./ai/party_behaviors.js";
import { observeSocialMemory } from "./ai/social_memory.js";
import { fillVehicleSensors, vehicleBehaviors, type VehicleSensors } from "./ai/vehicle_behaviors.js";
import { fillMountSensors, mountBehaviors, mountPolicy, type MountSensors } from "./ai/mount_behaviors.js";
import { fillTravelSensors, travelBehaviors, type TravelSensors } from "./ai/travel.js";
import { clanBehaviors, fillClanSensors, type ClanSensors } from "./ai/clan_behaviors.js";
import { emitAgentCommands } from "./ai/agent_output.js";
import { fillStanceSensors, stancePolicy, type StanceSensors } from "./ai/stance_policy.js";
import { baseBehaviors, goTo, baseReturnRun, baseSleepRun, type PlanSensors } from "./ai/base_behaviors.js";
import { autonomyBehaviors, banNode, instantChores, fillGoalSensors, stuckOn, type GoalSensors } from "./ai/autonomy.js";
import { fillHireSensors, hireBehaviors, withHireDuty } from "./ai/hire_behaviors.js";

export interface AgentsData {
  archetypes: Record<string, { perception: PerceptionConfig; imperfections: Imperfections; schedule: ScheduleSlot[]; goals: string[]; chatMinSeconds: number }>;
  names: string[]; chat: Record<string, string[]>;
}
export const AGENTS_DATA: AgentsData = raw as unknown as AgentsData;

export interface SeenThing { id: number; kind: "zombie" | "player" | "node" | "animal"; x: number; y: number }
export interface AgentWorldView extends AgentSensors, GoalSensors, StanceSensors, PlanSensors, PartySensors, ClanSensors, VehicleSensors, MountSensors, TravelSensors {
  seen: SeenThing[]; home: { x: number; y: number }; playerName: string;
  /** Optional sensors (0..1 / plans) the host fills from the bot's replica; missing = neutral. */
  invSpaceFree?: number; craftRecipe?: number; buildPlan?: { piece: number; x: number; y: number };
  /** ADR-113: best affordable skill node for this personality (undefined = no points / nothing affordable). */
  skillPick?: number;
  /** Task 22: hired-worker sensors (fillHireSensors; absent for unhired bots and humans). */
  hire?: { job: number; owner: number; ax: number; ay: number; supply?: { item: number; count: number };
    /** ADR-327: no pending employer job work and survival needs met — the hired worker may run the
     *  saddle-material chain (fillHireSensors sets this; saddleGoalPass reads it). Absent = not idle. */
    idle?: boolean };
  /** Task 25: dye this (hair / worn / held) — set by fillAgentSensors when the bot holds a dye, a paint brush in its
   *  hotbar, and a dye target; instantChores turns it into a `dye:<kind>:<slot>:<palette>:<index>` command. */
  dye?: { kind: number; slot: number; palette: number; index: number };
  /** Task 22: nearest farm target near the owner's base (mature crop node to harvest, or a crop to tend). */
  farm?: { harvest?: { id: number; x: number; y: number }; tend?: { id: number; x: number; y: number; kind: "water" | "plant"; slot: number };
    /** Task 23: nearest tillable tile near the owner's base (hoe Use in front of it; lack = hoe to withdraw from base storage first). */
    till?: { x: number; y: number; slot: number; lack?: { item: number; count: number } } };
  /** Task 28: nearest farm animal to tame (wild) or feed (owned, hungry) with animal_feed in the bag — tame for
   * food production (milk / eggs / wool at a feeding trough) for winter stores and for the bot itself. */
  tameLivestock?: { id: number; x: number; y: number; slot: number };
  /** Task 28: a feeding_trough to fill with hay for hungry owned livestock (id = trough piece; the server resolves copen/cdeposit to its storage attachment) */
  feedTrough?: { id: number; x: number; y: number; item: number; count: number };
  /** Task 22: nearest zombie threatening the owner's base (Defend job). */
  defend?: { id: number; x: number; y: number };
  /** Task 22: damaged piece near the owner's base the worker can repair (lack = material to withdraw first). */
  repair?: { id: number; x: number; y: number; lack?: { item: number; count: number } };
}
export type GameBehavior = BehaviorDef<AgentWorldView>;

/** Perception from a client-side replica: everything replicated near `self` (sight cone + range is applied to memory). */
/** The cheap per-tick half of buildAgentView: the agent's own state only (no perception scan). */
export function buildAgentSelf(world: World, self: Entity, a: Agent): AgentSelf | undefined {
  const t = world.get(self, Transform); if (!t) return undefined;
  const sv = world.get(self, Survival); const hp = world.get(self, Health);
  const facing = a.bb.num("facing", t.facing); const tod = timeOfDay(world);
  return { x: t.x, y: t.y, facing, hp: hp ? hp.hp / Math.max(1, hp.max) : 1, hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100, stamina: sv ? sv.stamina / Math.max(1, sv.maxStamina) : 1, tick: world.tick, dayT: sunFractionOf(tod), phase: currentPhaseKey(world) };
}
/**
 * `candidates` (optional, ADR-105): entities to consider instead of every Transform entity (e.g. a spatial-hash lookup
 * around `self` covering at least sight / hearing range); Dead and kind filtering still apply.
 */
export function buildAgentView(world: World, self: Entity, a: Agent, home: { x: number; y: number }, playerName = "friend", candidates?: Iterable<Entity>): { self: AgentSelf; world: AgentWorldView } | undefined {
  const t = world.get(self, Transform); if (!t) return undefined;
  const sv = world.get(self, Survival); const hp = world.get(self, Health);
  const facing = a.bb.num("facing", t.facing);
  const seen: SeenThing[] = [];
  // Task 29: store-direct reads. The old loop did world.getField x2 + world.has x4-5 per candidate
  // (each a store() Map lookup + function calls) — ~2.3us/candidate, ~934us for one bot's view in a
  // busy village. Same predicate and kind order; the kind stores' has() is the same sparse-array
  // read world.has does, and rnStore.read is what getField does. (ADR-212's no-get() rule still holds.)
  const tfStore = world.store(Transform);
  const zStore = world.store(Zombie); const rnStore = world.store(ResourceNode);
  const anStore = world.store(Animal); const hpStore = world.store(Health);
  const deadStore = candidates ? world.store(Dead) : undefined;
  for (const e of candidates ?? world.query([Transform], [Dead])) {
    if (e === self) continue;
    const idx = entityIndex(e);
    if (deadStore?.has(idx)) continue;
    if (!tfStore.has(idx)) continue;
    const ts = tfStore.slot(idx); const ox = tfStore.data.x[ts]!, oy = tfStore.data.y[ts]!;
    const kind = zStore.has(idx) ? "zombie" : rnStore.has(idx) ? "node" : anStore.has(idx) ? "animal" : hpStore.has(idx) ? "player" : undefined;
    if (!kind) continue; if (kind === "node" && rnStore.read(idx, "amount") === 0) continue;
    const ddx = ox - t.x, ddy = oy - t.y; const d = Math.sqrt(ddx * ddx + ddy * ddy); // ADR-212: Math.hypot allocates its rest-args array per call
    const visible = canSee(a.perception, t.x, t.y, facing, ox, oy);
    if (visible) a.memory.see({ id: e, kind, x: ox, y: oy, tick: world.tick });
    else if (kind === "zombie" && d <= a.perception.hearingRange * 0.5) a.memory.hear({ id: e, kind, x: ox, y: oy, tick: world.tick }, 1);
    if (visible) seen.push({ id: e, kind, x: ox, y: oy });
  }
  const tod = timeOfDay(world);
  const view: AgentWorldView = { seen, home, playerName }; fillAgentSensors(world, self, view, (sv?.hunger ?? 100) < 50); fillPartySensors(world, self, view); fillClanSensors(world, self, view); if ((treesOf(world, self) ?? []).some((t) => t.points > 0)) { // ADR-221: per-tree points since ADR-209 (global points is always 0)
    const p = pickSkillNode(world, self, a.identity.traits); if (p !== undefined) view.skillPick = p; } fillVehicleSensors(world, self, view); fillStanceSensors(world, self, view); fillGoalSensors(world, self, view, a); fillHireSensors(world, self, view, a); fillMountSensors(world, self, view, a); fillTravelSensors(world, self, view, a); observeSocialMemory(world, self, a); // ADR-327: hire before mount — the saddle gate reads the hire sensors (idle flag) and the employer's base scan, both set by fillHireSensors
  return {
    self: { x: t.x, y: t.y, facing, hp: hp ? hp.hp / Math.max(1, hp.max) : 1, hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100, stamina: sv ? sv.stamina / Math.max(1, sv.maxStamina) : 1, tick: world.tick, dayT: sunFractionOf(tod), phase: currentPhaseKey(world) },
    world: view,
  };
}

const toward = (out: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; out.moveX = (dx / d) * s; out.moveY = (dy / d) * s; out.aimX = dx / d; out.aimY = dy / d; return d;
};
const night = (p: string): number => (p === "night" ? 1 : p === "dusk" ? 0.6 : 0);
/** ADR-203: inside Gatherer.reach (1.5) with margin for the bot's own drift. */
export const GATHER_STOP = 1.2;
const gatherGoal = (c: AgentContext<AgentWorldView>): { id: number; x: number; y: number } | undefined => c.world.gatherScanned ? c.world.gatherNode : c.memory.nearest("node", c.self.x, c.self.y);

/** Minimal reference set (works end to end today): flee, gather, explore, return_home, rest, greet. */
export function referenceBehaviors(): GameBehavior[] {
  return [
    { name: "flee", chatOnStart: "flee", inertia: 0.3, traits: { bravery: -1.2 },
      considerations: [{ name: "zombieNear", curve: { type: "inverse" }, input: (c) => { const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); return z ? Math.hypot(z.x - c.self.x, z.y - c.self.y) / 12 : 1; } }],
      run: (c, o) => { const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3); if (!z) return false; toward(o, z.x, z.y, c.self.x * 2 - z.x, c.self.y * 2 - z.y); o.sprint = c.self.stamina > 0.2; o.aimX = -o.aimX; o.aimY = -o.aimY; } },
    { name: "gather", chatOnStart: "gather", scheduleBonus: 0.25, traits: { industriousness: 0.8, greed: 0.4 },
      considerations: [
        { name: "nodeKnown", curve: { type: "inverse" }, input: (c) => { const n = gatherGoal(c); return n ? Math.hypot(n.x - c.self.x, n.y - c.self.y) / (c.world.gatherNode?.wanted ? 40 : 20) : 1; } },
        // ADR-203: cold at night with no campfire -> gather what the fire needs instead of freezing asleep
        // ADR-252: a planner step that is not gathering (build / craft / withdraw) beats idle gathering of things the plan does not need
        { name: "planFree", curve: { type: "linear", m: 1, b: 0 }, input: (c) => (c.world.plan?.step && !c.world.gatherNode?.wanted ? 0.3 : 1) },
        { name: "daylight", curve: { type: "linear", m: -0.8, b: 1 }, input: (c) => (c.world.cold && (c.world.fireMissing || (c.world.fire && !c.world.fire.lit && !c.world.woodSlot)) ? 0 : night(c.self.phase)) },
      ],
      // ADR-203: stop inside the server's gather reach (1.5 tiles; was 1.6 -> every swing OutOfRange, bots froze), ban a node
      // that stays out of reach / is worked too long without depleting, and re-plan instead of re-picking it forever
      run: (c, o) => {
        instantChores(c, o); const n = gatherGoal(c); if (!n) return false;
        const d = goTo(c, o, n.x, n.y, 0.8);
        if (d >= GATHER_STOP) { if (stuckOn(c, n.x, n.y)) { banNode(c, n.id); return false; } return; }
        o.moveX = 0; o.moveY = 0; o.actions.push("gather");
        const at = c.bb.num("gatherAt", -1), id = c.bb.num("gatherId", -1);
        if (id !== n.id || at < 0) { c.bb.set("gatherId", n.id); c.bb.set("gatherAt", c.self.tick); }
        else if (c.self.tick - at > 240) { banNode(c, n.id); c.bb.set("gatherId", -1); return false; }
      } },
    { name: "explore", scheduleBonus: 0.15, traits: { industriousness: 0.3 },
      considerations: [{ name: "base", curve: { type: "linear", m: 0, b: 0.35 }, input: () => 0 }],
      run: (c, o) => {
        instantChores(c, o); let g = c.bb.get<{ x: number; y: number }>("exploreGoal");
        if (!g || Math.hypot(g.x - c.self.x, g.y - c.self.y) < 1.5 || stuckOn(c, g.x, g.y)) { const a = c.rng.range(-Math.PI, Math.PI), r = c.rng.range(4, 14); g = { x: c.world.home.x + Math.cos(a) * r, y: c.world.home.y + Math.sin(a) * r }; c.bb.set("exploreGoal", g); }
        goTo(c, o, g.x, g.y, 0.7); c.bb.set("facing", Math.atan2(o.aimY, o.aimX));
      } },
    { name: "return_home", chatOnStart: "return_home", scheduleBonus: 0.4,
      considerations: [{ name: "farFromHome", curve: { type: "logistic", k: 10, mid: 0.3 }, input: (c) => (c.bb.get("trip") ? 0 : Math.hypot(c.world.home.x - c.self.x, c.world.home.y - c.self.y) / 30) }, { name: "evening", curve: { type: "linear", m: 0.8, b: 0.2 }, input: (c) => night(c.self.phase) }],
      run: (c, o) => { instantChores(c, o); if (c.world.base) return baseReturnRun(c, o); if (goTo(c, o, c.world.home.x, c.world.home.y) < 2 || stuckOn(c, c.world.home.x, c.world.home.y, 100)) return false; } },
    { name: "rest", chatOnStart: "rest", scheduleBonus: 0.3,
      considerations: [{ name: "night", curve: { type: "step", at: 0.5 }, input: (c) => night(c.self.phase) }, { name: "nearHome", curve: { type: "inverse" }, input: (c) => Math.hypot(c.world.home.x - c.self.x, c.world.home.y - c.self.y) / 10 }],
      run: () => { /* stand still (sleep hook: Survival adds a sleep action) */ } },
    { name: "greet", chatOnStart: "greet", traits: { sociability: 1.2 }, inertia: 0,
      considerations: [{ name: "playerSeen", curve: { type: "inverse" }, input: (c) => { const p = c.memory.nearest("player", c.self.x, c.self.y, 0.5); return p ? Math.hypot(p.x - c.self.x, p.y - c.self.y) / 10 : 1; } },
        { name: "notGreetedRecently", curve: { type: "step", at: 0.5 }, input: (c) => (c.self.tick - c.bb.num("greetedAt", -1e9) > 1200 ? 1 : 0) }],
      run: (c, o) => { const p = c.memory.nearest("player", c.self.x, c.self.y); c.bb.set("greetedAt", c.self.tick); if (p) { toward(o, c.self.x, c.self.y, p.x, p.y, 0); o.emote = "wave"; } return false; } },
  ];
}

/** bots.json utility action each behavior answers to (behaviors without one are not biased). */
export const BEHAVIOR_ACTION: Readonly<Record<string, string>> = { flee: "flee", gather: "gather", rest: "sleep", sleep: "sleep", eat: "eat", drink: "eat", craft: "craft", build: "build", stall_trade: "trade" };
const ACTION_BEHAVIOR: Readonly<Record<string, string>> = { sleep: "sleep", trade: "stall_trade" };
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** scoreUtilities signals from what the bot perceives: traits + sensors in 0..1. */
export function botSignals(c: AgentContext<AgentWorldView>): Record<string, number> {
  const near = (k: string, r: number): number => { const m = c.memory.nearest(k, c.self.x, c.self.y, 0.3); return m ? clamp01(1 - Math.hypot(m.x - c.self.x, m.y - c.self.y) / r) : 0; };
  const w = c.world;
  return { ...c.traits, enemyNear: Math.max(near("zombie", 12), w.seen.some((s) => s.kind === "animal") ? 0.2 : 0), lowHealth: clamp01(1 - c.self.hp * 2), healthFrac: c.self.hp,
    hunger: clamp01(1 - c.self.hunger), thirst: clamp01(1 - c.self.thirst), fatigue: clamp01(1 - c.self.stamina), isNight: night(c.self.phase) >= 1 ? 1 : 0,
    playerNear: near("player", 10), invSpaceFree: w.invSpaceFree ?? 0.5, hasIngredients: w.craftRecipe !== undefined ? 1 : 0, baseMissing: w.buildPlan ? 1 : 0 };
}
/** Multiplier 0.5..1 from bots.json scoreUtilities for the agent's bot archetype (1 when the archetype is not a bots.json one). */
export function botUtilityFactor(c: AgentContext<AgentWorldView>, behavior: string): number {
  const act = BEHAVIOR_ACTION[behavior]; const arch = c.agent.identity.archetype;
  if (!act || !populationData().bots.archetypes[arch]) return 1;
  return 0.5 + 0.5 * clamp01(scoreUtilities(arch, botSignals(c))[act] ?? 0);
}
const withBotUtility = (b: GameBehavior): GameBehavior => (BEHAVIOR_ACTION[b.name] ? { ...b, considerations: [...b.considerations, { name: "botUtility", curve: { type: "linear", m: 1, b: 0 }, input: (c) => botUtilityFactor(c, b.name) }] } : b);

/** ADR-113: spend skill points through the same UnlockSkillCmd players use ("skill:<node>"). */
export const skillPickBehavior: GameBehavior = { name: "skill_pick", inertia: 0, considerations: [
  { name: "points", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.skillPick !== undefined && c.self.tick - c.bb.num("skillPickAt", -1e9) >= 100 ? 1 : 0) }],
  run: (c, o) => { o.actions.push(`skill:${c.world.skillPick}`); c.bb.set("skillPickAt", c.self.tick); return false; } };

export function survivorRegistry(extra: readonly GameBehavior[] = []): BehaviorRegistry<AgentWorldView> {
  const r = new BehaviorRegistry<AgentWorldView>(); for (const b of [...referenceBehaviors(), ...survivalBehaviors(), ...autonomyBehaviors(), ...partyBehaviors(), ...clanBehaviors(), ...vehicleBehaviors(), ...mountBehaviors(), ...travelBehaviors(), ...baseBehaviors(), ...hireBehaviors(), skillPickBehavior, ...extra]) {
    const run = b.name === "sleep" ? (c: AgentContext<AgentWorldView>, o: Parameters<GameBehavior["run"]>[1]) => (c.world.base && c.world.hire?.job !== WorkerJob.Follow ? baseSleepRun(c, o) : b.run(c, o)) : b.run;
    r.register(withBotUtility(withHireDuty({ ...b, run: (c, o) => { const res = run(c, o); stancePolicy(c, o, b.name); mountPolicy(c, o, b.name); return res; } }))); // ADR-252: sleep stillness + sneak crouch; ADR-321: auto mount / dismount
  }
  return r;
}
/**
 * Deterministic identity for virtual player #slot of a world seed. archetype = a bots.json archetype (picked by the
 * seed when omitted); traits come from rollTraits within that archetype's ranges, goals from its goal weights.
 */
export function makeAgentIdentity(seed: number, slot: number, archetype?: string): AgentIdentity {
  const rng = new Rng((seed * 2654435761 + slot * 40503) >>> 0); const bots = populationData().bots; const keys = Object.keys(bots.archetypes);
  const arch = archetype ?? keys[rng.int(0, keys.length)]!; const b = bots.archetypes[arch]; if (!b) throw new Error(`unknown bot archetype ${arch}`);
  // unique per world for the first names.length slots: a per-seed offset, then one name per slot (the rng draw is kept so
  // trait rolls stay identical); the old per-slot random pick gave several "Ash" bots in one world
  const N = AGENTS_DATA.names.length; rng.int(0, N); const off = ((seed * 2246822519) >>> 0) % N;
  const name = AGENTS_DATA.names[(off + slot) % N]!;
  const goals = Object.entries(b.goals).sort((x, y) => y[1] - x[1]).map(([g]) => ({ name: g, progress: 0 }));
  return { id: `bot-${seed}-${slot}`, name, relationship: 0, traits: rollTraits(arch, () => rng.next()), archetype: arch, goals };
}
/** Agent from an identity: bots.json archetypes use their routine (as behavior names) + imperfections; others agents.json. */
export function makeAgent(identity: AgentIdentity, seed: number, tickHz = 20): Agent {
  const base = AGENTS_DATA.archetypes[identity.archetype] ?? AGENTS_DATA.archetypes["survivor"]!;
  const bots = populationData().bots; const b = bots.archetypes[identity.archetype];
  const schedule = b ? bots.routines[b.routine]!.map((s) => ({ ...s, prefer: s.prefer.map((p) => ACTION_BEHAVIOR[p] ?? p) })) : base.schedule;
  return new Agent(identity, seed, { perception: base.perception, imperfections: b ? b.imperfections : base.imperfections, schedule, chatMinSeconds: base.chatMinSeconds, tickHz });
}
/**
 * The survivor AgentController. Each output's buy, use, craft, place and stall-open actions become AgentOutput.commands
 * through emitAgentCommands. Set opts.commands to false to keep them as action strings only.
 */
export function survivorController(opts: { seed: number; thinkBudget?: number; thinkEvery?: number; extra?: readonly GameBehavior[]; chat?: ConstructorParameters<typeof AgentController<AgentWorldView>>[0]["chat"]; commands?: boolean }): AgentController<AgentWorldView> {
  const rng = new Rng(opts.seed ^ 0x5bd1e995);
  const ctl = makeSurvivorController(opts, rng);
  if (opts.commands === false) return ctl;
  const tick = ctl.tick.bind(ctl);
  ctl.tick = (t, view) => { const outs = tick(t, view); for (const o of outs.values()) emitAgentCommands(o); return outs; };
  return ctl;
}
function makeSurvivorController(opts: Parameters<typeof survivorController>[0], rng: Rng): AgentController<AgentWorldView> {
  return new AgentController<AgentWorldView>({ behaviors: survivorRegistry(opts.extra), chat: opts.chat ?? new ChatTemplates(AGENTS_DATA.chat, () => rng.next()), thinkBudget: opts.thinkBudget ?? 4, thinkEvery: opts.thinkEvery ?? 10 });
}
