// ADR-477: bots get good at things — picks drift toward practiced skills, and practice makes
// actions slightly faster (new "speed" skill mod on the four tier-0 practice nodes).
// The pick term (+0.1 per owned node in the want's branch) is the scope default; the speed mod is
// one global multiplier for gather/craft (building placement is instant on this tree, so there is
// no build duration to wire — see REPORT.md).
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { lifeData, lifeStateOf, nearestWaterTile, pickWithMood, type LifePersonality, type LifeSensors } from "../src/ai/life.js";
import { branchLevel, skillMul } from "../src/skills/tree.js";
import { collect, makeWorld, steps } from "./helpers.js";

function world(): World { const w = makeWorld(); installPermissions(w); return w; }
const mk = (w: World, pid: number): Entity => { const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }); return p; };
const node = (key: string): number => G.skillNodeIndex(key);
const give = (w: World, e: Entity, pts: number): void => { for (const k of G.TREE_KEYS) G.grantTreePoints(w, e, k, Math.max(0, pts - G.treePoints(w, e, k))); };
/** Unlock a node and its prerequisites (skills.test.ts pattern). */
const chain = (w: World, e: Entity, i: number): void => {
  for (const r of G.skillNode(i)!.requires) if (!G.hasNode(w, e, node(r))) chain(w, e, node(r));
  G.unlockSkill(w, e, i);
};
/** The four tier-0 practice nodes that grant the speed mod (forager, green_thumb, tinkerer, carpenter). */
const SPEED_NODES = ["forager", "green_thumb", "tinkerer", "carpenter"];
const unlockSpeed = (w: World, e: Entity): void => {
  give(w, e, 5);
  for (const k of SPEED_NODES) if (!G.hasNode(w, e, node(k))) chain(w, e, node(k));
};

describe("ADR-477 branch level and speed multiplier", () => {
  it("branchLevel counts owned nodes per branch; speedMul is 1.0 fresh and +0.05 per practice node", () => {
    const w = world(); const p = mk(w, 1);
    expect(branchLevel(w, p, "farming")).toBe(0);
    expect(branchLevel(w, p, "crafting")).toBe(0);
    expect(skillMul(w, p, "speed")).toBe(1);
    give(w, p, 20); chain(w, p, node("master_farmer")); // all 7 farming nodes via prerequisites (12 pts)
    expect(branchLevel(w, p, "farming")).toBe(7);
    expect(branchLevel(w, p, "crafting")).toBe(0);
    expect(skillMul(w, p, "speed")).toBeCloseTo(1.05, 10); // green_thumb only
    chain(w, p, node("tinkerer"));
    expect(branchLevel(w, p, "crafting")).toBe(1);
    expect(skillMul(w, p, "speed")).toBeCloseTo(1.1, 10);
    unlockSpeed(w, p); // forager + carpenter join green_thumb + tinkerer
    expect(skillMul(w, p, "speed")).toBeCloseTo(1.2, 10);
  });

  it("speedMul is 1.0 for a bare entity with no Progression (legacy / NPC crafters)", () => {
    const w = world(); const e = w.create();
    expect(w.has(e, G.Progression)).toBe(false);
    expect(skillMul(w, e, "speed")).toBe(1);
    expect(branchLevel(w, e, "farming")).toBe(0);
  });
});

describe("ADR-477 want picks drift toward practiced skills", () => {
  /** A home with no water within the life layer's search radius (adr336 pattern). */
  const dryHome = (w: World): { x: number; y: number } => {
    for (let ox = 0; ox <= 300; ox += 30) for (let oy = 0; oy <= 300; oy += 30) {
      const home = { x: ox, y: oy };
      if (!nearestWaterTile(w, home)) return home;
    }
    throw new Error("no dry home found in range");
  };
  it("a lazy bot rests; the same bot with 5 farming nodes tends the garden", () => {
    const w = makeWorld({}, 42); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 7 });
    const agent = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
    agent.bb.set("selfEntity", p);
    // All aspirations completed: no aspiration bonus touches the race between garden and rest.
    const st = lifeStateOf(agent, 0);
    for (const a of lifeData().aspirations) st.aspirations[a.id] = { tick: 0 };
    const home = dryHome(w); // no water nearby: visit_water is unavailable
    const view = {
      seen: [], home, playerName: "friend",
      plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] },
      farm: { harvest: { id: 99, x: home.x + 5, y: home.y } },
    } as unknown as G.AgentWorldView & LifeSensors;
    // Industriousness 0, greed 0: garden affinity 0 (score 0.315) vs rest affinity 1.0 (score 0.7).
    // Curiosity 1 makes the (completed) traveller aspiration the highest, so no live aspiration
    // bonus applies to either want in the race.
    const person: LifePersonality = {
      sociability: 0.5, industriousness: 0, bravery: 0.5, curiosity: 1, greed: 0,
      rhythm: "day", favouriteFood: "apple", keepsake: "straw_hat",
    };
    const vitals = { hunger: 0.9, thirst: 0.9, hp: 0.9, cold: false };
    const pick = () => pickWithMood(agent, w, view, person, st, 0, "day", undefined, undefined, vitals);
    expect(pick()?.kind).toBe("rest");
    // One farming node (+0.1) is not enough to tip it: 0.415 < 0.7.
    give(w, p, 10); chain(w, p, node("green_thumb"));
    expect(branchLevel(w, p, "farming")).toBe(1);
    expect(pick()?.kind).toBe("rest");
    // Five farming nodes (+0.5): garden 0.815 beats rest 0.7.
    chain(w, p, node("orchardist")); chain(w, p, node("seed_saver"));
    expect(branchLevel(w, p, "farming")).toBe(5);
    expect(pick()?.kind).toBe("tend_garden");
  });

  it("the want->skill mapping lives in data: only tend_garden and craft_keepsake carry a skill", () => {
    const wants = lifeData().wants;
    expect(wants.find((x) => x.id === "tend_garden")?.skill).toBe("farming");
    expect(wants.find((x) => x.id === "keepsake")?.skill).toBe("crafting");
    for (const x of wants) if (x.id !== "tend_garden" && x.id !== "keepsake") expect(x.skill).toBeUndefined();
  });

  it("drift over a session: a generalist rests, a farming specialist gardens, and practicing crafting more drifts it back to keepsakes", () => {
    const w = makeWorld({}, 42); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 7 });
    const agent = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
    agent.bb.set("selfEntity", p);
    const st = lifeStateOf(agent, 0);
    for (const a of lifeData().aspirations) st.aspirations[a.id] = { tick: 0 };
    const home = dryHome(w);
    const view = {
      seen: [], home, playerName: "friend",
      plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] },
      farm: { harvest: { id: 99, x: home.x + 5, y: home.y } },
    } as unknown as G.AgentWorldView & LifeSensors;
    const person: LifePersonality = {
      sociability: 0.5, industriousness: 0, bravery: 0.5, curiosity: 1, greed: 0,
      rhythm: "day", favouriteFood: "apple", keepsake: "straw_hat",
    };
    const vitals = { hunger: 0.9, thirst: 0.9, hp: 0.9, cold: false };
    const defs = G.gameplayDefs(w);
    // The pick only looks up the favourite food and the keepsake, so a two-entry index is enough.
    const ix = {
      itemId: new Map([["apple", defs.itemId("apple")], ["straw_hat", defs.itemId("straw_hat")]]),
      handRecipe: new Map([[defs.itemId("straw_hat"), defs.recipeId("straw_hat")]]),
    };
    G.addItem(w, p, defs.itemId("reeds"), 60); // 6 per straw_hat: the keepsake want stays available all session
    let tick = 0;
    const round = (): string | undefined => {
      const pick = pickWithMood(agent, w, view, person, st, tick, "day", ix, defs, vitals);
      if (pick) st.completed[pick.id] = { count: (st.completed[pick.id]?.count ?? 0) + 1, tick };
      tick += 25000; // past every want cooldown (longest: keepsake 24000), so each round is a fresh pick
      return pick?.kind;
    };
    const runPhase = (rounds: number): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (let i = 0; i < rounds; i++) { const k = round() ?? "none"; counts[k] = (counts[k] ?? 0) + 1; }
      return counts;
    };
    // Phase A — generalist (0 farming nodes): rest 0.7 beats garden 0.315 and keepsake 0.315.
    expect(runPhase(10)).toEqual({ rest: 10 });
    // Phase B — practice farming (5 nodes): garden 0.815 beats rest 0.7; the bot is a specialist.
    give(w, p, 10); chain(w, p, node("green_thumb")); chain(w, p, node("orchardist")); chain(w, p, node("seed_saver"));
    expect(branchLevel(w, p, "farming")).toBe(5);
    expect(runPhase(10)).toEqual({ tend_garden: 10 });
    // Phase C — practice crafting MORE (7 nodes): keepsake 1.015 beats garden 0.815. The drift is
    // continuous (level-based), not threshold-locked: the bot drifts back instead of staying a
    // farmer forever once it practices something else harder.
    give(w, p, 20); chain(w, p, node("smithing_3")); chain(w, p, node("armorsmithing_2")); chain(w, p, node("bowyery_1"));
    expect(branchLevel(w, p, "crafting")).toBe(7);
    expect(runPhase(10)).toEqual({ craft_keepsake: 10 });
  });
});

describe("ADR-477 practice makes actions slightly faster", () => {
  it("gather swings: 15 ticks unskilled, 13 ticks with all four speed nodes", () => {
    const w = world(); const p = mk(w, 1);
    const n = G.spawnResourceNode(w, "fallen_branches", 1, 0);
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: n }); w.step(1 / 20);
    const until = w.getField(p, G.Gatherer, "cooldownUntilTick")! - (w.tick - 1);
    expect(until).toBe(15); // 0.75 s at 20 Hz
    const w2 = world(); const p2 = mk(w2, 1); unlockSpeed(w2, p2);
    const n2 = G.spawnResourceNode(w2, "fallen_branches", 1, 0);
    G.setIntent(w2, p2, { action: G.IntentAction.Gather, target: n2 }); w2.step(1 / 20);
    expect(w2.getField(p2, G.Gatherer, "cooldownUntilTick")! - (w2.tick - 1)).toBe(13); // 0.75 / 1.2 s
  });

  it("crafts: stone_axe 40 ticks unskilled, 39 with tinkerer alone, 34 with all four speed nodes", () => {
    const d = G.defaultDefs(); const id = (k: string) => d.itemId(k); const axe = d.recipeId("stone_axe");
    const setup = () => {
      const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
      G.addItem(w, p, id("wood"), 10); G.addItem(w, p, id("stone"), 4); G.addItem(w, p, id("fiber"), 4);
      G.installCraftQueue(w); return { w, p };
    };
    const a = setup(); const startedA = collect(a.w, G.CraftStarted);
    expect(G.enqueueCraft(a.w, a.p, axe, 1)).toBe(0);
    steps(a.w, 1); // the event bus is queued: CraftStarted is delivered at the end of the tick
    expect(startedA[0]?.totalTicks).toBe(40); // 2 s at 20 Hz
    steps(a.w, 34); expect(G.countItem(a.w, a.p, id("stone_axe"))).toBe(0);
    steps(a.w, 6); expect(G.countItem(a.w, a.p, id("stone_axe"))).toBe(1); // completes by 41 steps
    const b = setup(); unlockSpeed(b.w, b.p); const startedB = collect(b.w, G.CraftStarted);
    expect(G.enqueueCraft(b.w, b.p, axe, 1)).toBe(0);
    steps(b.w, 1);
    expect(startedB[0]?.totalTicks).toBe(34); // 2 / 1.2 s
    steps(b.w, 34); expect(G.countItem(b.w, b.p, id("stone_axe"))).toBe(1); // done 6 steps sooner
    const c = setup(); give(c.w, c.p, 5); chain(c.w, c.p, node("tinkerer")); const startedC = collect(c.w, G.CraftStarted);
    expect(G.enqueueCraft(c.w, c.p, axe, 1)).toBe(0);
    steps(c.w, 1);
    expect(startedC[0]?.totalTicks).toBe(39); // 2 / 1.05 s
  });

   it("single timed crafts (the player flow) are faster too: stone_axe 40 ticks unskilled, 34 with all four speed nodes", () => {
    const d = G.defaultDefs(); const id = (k: string) => d.itemId(k); const axe = d.recipeId("stone_axe");
    const setup = () => {
      const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
      G.addItem(w, p, id("wood"), 5); G.addItem(w, p, id("stone"), 2); G.addItem(w, p, id("fiber"), 2);
      return { w, p };
    };
    const start = (w: World, p: Entity) => {
      G.setIntent(w, p, { action: G.IntentAction.Craft, recipe: axe }); w.step(1 / 20);
      return w.get(p, G.Crafter)!.totalTicks;
    };
    const a = setup();
    expect(start(a.w, a.p)).toBe(40);
    steps(a.w, 39); expect(G.countItem(a.w, a.p, id("stone_axe"))).toBe(0);
    a.w.step(1 / 20); expect(G.countItem(a.w, a.p, id("stone_axe"))).toBe(1);
    const b = setup(); unlockSpeed(b.w, b.p);
    expect(start(b.w, b.p)).toBe(34);
    steps(b.w, 33); expect(G.countItem(b.w, b.p, id("stone_axe"))).toBe(0);
    b.w.step(1 / 20); expect(G.countItem(b.w, b.p, id("stone_axe"))).toBe(1);
  });
});
