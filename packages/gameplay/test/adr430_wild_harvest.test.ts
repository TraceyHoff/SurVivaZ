/**
 * ADR-430: AI humans harvest wild plants, and wild plants render.
 *
 * ADR-428 (parallel slice) fixes the spawn side — the production server never passed
 * `worldgenBands`, so wild crops / fruit trees never spawned at all. Once they spawn, the
 * AI side has to hold up too:
 *
 * 1. General gather already works generically (autonomy.ts picks remembered `kind: "node"`
 *    items with amount > 0 and matches `def.yields` against needs) — pinned here, not fixed:
 *    a bot needing a wild plant's yield finds and gathers a `wild_*` node.
 * 2. The farm-job path did NOT: `computeFarmSensor` (ai/hire_behaviors.ts) only harvested
 *    nodes whose key is in `FARMING.plantables.map(p => p.becomes)` (farmed `crop_*` /
 *    bush / tree nodes), so hired farm workers — and unhired gardeners, who share the sensor
 *    — walked past every wild plant. Fixed here: every plantable's `wild` nodes are
 *    harvestable too. Yields are unchanged (ADR-247: a wild node still drops only its own
 *    species' seed and produce); the farm path just stops skipping them.
 * 3. `wild_garden` is deliberately NOT a farm target: it belongs to no plantable's `wild`
 *    list (a mixed garden, no single species' seed), so general gather stays its path.
 */
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, PlayerId, scoreBehavior, Transform, type AgentContext } from "@engine/core";
import * as G from "../src/index.js";
import { fillGoalSensors } from "../src/ai/autonomy.js";
import { computeFarmSensor } from "../src/ai/hire_behaviors.js";
import { scanBase } from "../src/ai/planner.js";
import type { AgentWorldView } from "../src/agents.js";
import { makeWorld, steps } from "./helpers.js";

function setup() {
  const w = makeWorld(); installPermissions(w);
  const mk = (id: number, x: number) => { const e = G.spawnPlayer(w, { x, y: 0, maxWeight: 0 }); w.add(e, PlayerId, { id }); return e; };
  const p = mk(7, 0), q = mk(8, 3), bot = mk(9, 1);
  G.setAiHumanPredicate(w, (e) => e === bot); G.ensureWorker(w, bot);
  G.addItem(w, p, w.get(bot, G.Worker)!.wantedItem, 1); expect(G.hireWorker(w, p, bot)).toBe(0);
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  const view = () => G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
  const ctx = (): AgentContext<G.AgentWorldView> => ({ ...view(), bb: agent.bb, memory: agent.memory, traits: agent.identity.traits, rng: agent.rng, agent });
  return { w, p, q, bot, agent, view, ctx, defs: G.gameplayDefs(w) };
}

describe("ADR-430 general gather sees wild plants", () => {
  it("a hired Gather worker needing wheat picks the wild_wheat node over closer non-wheat nodes", () => {
    const { w, p, bot, defs, view, ctx } = setup();
    const wild = G.spawnResourceNode(w, "wild_wheat", 4, 0);
    G.spawnResourceNode(w, "loose_rocks", 2.5, 0); // closer, but yields stone, not wheat
    G.spawnResourceNode(w, "wild_corn", 3, 0); // closer wild plant, but yields corn, not wheat
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Gather, { selections: [defs.itemId("wheat")] })).toBe(0);
    const v = view();
    expect(v.world.gatherNode?.id, "gatherNode").toBe(wild);
    expect(v.world.gatherNode?.wanted, "wanted").toBe(true);
    // …and the gather behaviour scores it and, stood next to the node, swings at it.
    const gather = G.referenceBehaviors().find((b) => b.name === "gather")!;
    const c = ctx();
    expect(scoreBehavior(gather, c, undefined, [])).toBeGreaterThan(0);
    w.set(bot, Transform, { x: 4, y: 0.5 });
    const c2 = ctx();
    expect(c2.world.gatherNode?.id).toBe(wild);
    const o = idleOutput(); gather.run(c2, o);
    expect(o.actions).toContain("gather");
  });

  it("an unhired bot picks a wild food plant it can see (generic path, no farm job involved)", () => {
    const w = makeWorld();
    const bot = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    w.set(bot, G.Survival, { hunger: 10, thirst: 100 }); // hungry, no food in the bag
    const wild = G.spawnResourceNode(w, "wild_carrot", 4, 0);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    a.memory.see({ id: wild, kind: "node", x: 4, y: 0, tick: w.tick });
    const view: AgentWorldView = { seen: [], home: { x: 0, y: 0 }, playerName: "owner" };
    fillGoalSensors(w, bot, view, a);
    expect(view.gatherNode?.id).toBe(wild);
  });
});

describe("ADR-430 farm workers harvest wild plants", () => {
  it("computeFarmSensor harvests a wild plant near the anchor (was: skipped — not a `becomes` node)", () => {
    const w = makeWorld(); const d = G.gameplayDefs(w);
    const bot = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const anchor = { x: 0, y: 0 };
    const wild = G.spawnResourceNode(w, "wild_wheat", 4, 0);
    const farm = computeFarmSensor(w, bot, d, anchor, scanBase(w, d, anchor));
    expect(farm?.harvest?.id).toBe(wild);
  });

  it("computeFarmSensor harvests every plantable's wild source, plus the farmed nodes it already did", () => {
    const w = makeWorld(); const d = G.gameplayDefs(w);
    const bot = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const anchor = { x: 0, y: 0 };
    // One wild node per plantable species (nearest wins per call, so probe them one at a time).
    for (const p of G.FARMING.plantables) {
      for (const key of p.wild) {
        const node = G.spawnResourceNode(w, key, 4, 0);
        const farm = computeFarmSensor(w, bot, d, anchor, scanBase(w, d, anchor));
        expect(farm?.harvest?.id, `${p.key} wild ${key}`).toBe(node);
        w.destroy(node);
      }
      const farmed = G.spawnResourceNode(w, p.becomes, 4, 0);
      const farm = computeFarmSensor(w, bot, d, anchor, scanBase(w, d, anchor));
      expect(farm?.harvest?.id, `${p.key} farmed ${p.becomes}`).toBe(farmed);
      w.destroy(farmed);
    }
  });

  it("a hired Farm worker's view carries the wild harvest (and work_farm gathers it)", () => {
    const { w, p, bot, view, ctx } = setup();
    const wild = G.spawnResourceNode(w, "wild_wheat", 4, 0);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm)).toBe(0);
    expect(view().world.farm?.harvest?.id).toBe(wild);
    // work_farm scores and, stood next to the node, swings the gather action.
    const workFarm = G.hireBehaviors().find((b) => b.name === "work_farm")!;
    const c = ctx();
    expect(scoreBehavior(workFarm, c, undefined, [])).toBeGreaterThan(0);
    w.set(bot, Transform, { x: 4, y: 0.5 });
    const c2 = ctx();
    const o = idleOutput(); workFarm.run(c2, o);
    expect(o.actions).toContain("gather");
  });

  it("wild_garden stays out of the farm path (no plantable's wild source: general gather owns it)", () => {
    const w = makeWorld(); const d = G.gameplayDefs(w);
    const bot = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const anchor = { x: 0, y: 0 };
    G.spawnResourceNode(w, "wild_garden", 4, 0);
    expect(computeFarmSensor(w, bot, d, anchor, scanBase(w, d, anchor))).toBeUndefined();
  });

  it("farm-harvesting a wild plant yields its own produce and seed only (ADR-247 untouched)", () => {
    const { w, bot, defs } = setup();
    // One node = 2 swings at a 0.3 seed chance, so harvest several (ADR-349 does the same).
    w.set(bot, Transform, { x: 3, y: 2.5 }); // adjacent: the Gather intent swings in reach
    for (let i = 0; i < 12; i++) {
      const node = G.spawnResourceNode(w, "wild_wheat", 3, 3);
      for (let k = 0; k < 12 && w.isAlive(node); k++) { G.setIntent(w, bot, { action: G.IntentAction.Gather, target: node }); steps(w, 30); }
      if (w.isAlive(node)) w.destroy(node);
    }
    expect(G.countItem(w, bot, defs.itemId("wheat"))).toBeGreaterThan(0);
    expect(G.countItem(w, bot, defs.itemId("wheat_seeds"))).toBeGreaterThan(0);
    for (const p of G.FARMING.plantables) {
      if (p.seed === "wheat_seeds") continue;
      expect(G.countItem(w, bot, defs.itemId(p.seed)), p.seed).toBe(0);
    }
  });
});
