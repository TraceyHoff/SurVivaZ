// ADR-385: a bot whose goal node is unreachable re-targets instead of freezing.
//
// The ADR-383+384 gate proved the freeze on seed 5: SITE_CHANCE 0.25 moved a bot's respawn next to
// a ridge, and the nearest wild berry bush sat at height 14 while the bot stood at 8 (rise +6, max
// unaided climb 3). The garden behaviour re-picked that same bush every sense cycle — no reachability
// check, no ban — so the bot's displacement stayed exactly 0.0 for the full 120 s. The gather sensor
// had the same flaw (nearest node, no reachability check). These tests pin the fix at the unit level:
// the nav predicate, the gather re-pick, and the farm-sensor reachable pick + ban-awareness. The
// live end-to-end regression (the seed-5 scenario itself) is in
// apps/client/test/adr385_unreachable_retarget.test.ts.
import { describe, expect, it } from "vitest";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { fillGoalSensors } from "../src/ai/autonomy.js";
import { computeFarmSensor } from "../src/ai/hire_behaviors.js";
import { scanBase } from "../src/ai/planner.js";
import { navReachable } from "../src/systems/creature_nav.js";
import type { AgentWorldView } from "../src/agents.js";
import { makeWorld, spawnLearned } from "./helpers.js";

/** A world with a +6 ridge wall at x = 13 (max unaided climb is 3), spanning y -20..40 — beyond the
 *  nav window (radius 24) around the bot at (10.5, 10.5), so there is no route around it. */
function ridgeWorld() {
  const w = makeWorld();
  // makeWorld installs no terrain (setTerrainDig would silently no-op): flat land first, then the ridge.
  const map = new TileMap();
  for (let y = -30; y <= 50; y++) for (let x = -30; x <= 50; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const bot = spawnLearned(w, { x: 10.5, y: 10.5, maxWeight: 0, clientId: 7 });
  for (let y = -20; y <= 40; y++) G.setTerrainDig(w, 13, y, 6);
  return { w, bot };
}

describe("ADR-385 navReachable", () => {
  it("a goal across the ridge is unreachable, a goal on the same shelf is reachable", () => {
    const { w, bot } = ridgeWorld();
    expect(navReachable(w, bot, 10.5, 10.5, 16.5, 10.5)).toBe(false); // across the +6 ridge
    expect(navReachable(w, bot, 10.5, 10.5, 13.5, 10.5)).toBe(false); // on the ridge top itself
    expect(navReachable(w, bot, 10.5, 10.5, 11.5, 10.5)).toBe(true); // same shelf, short hop
    expect(navReachable(w, bot, 10.5, 10.5, 10.5, 20.5)).toBe(true); // same shelf, south
    expect(navReachable(w, bot, 10.5, 10.5, 5.5, 10.5)).toBe(true); // same shelf, west
  });
});

describe("ADR-385 gather re-target", () => {
  it("the gather sensor skips an unreachable nearest node and picks the next reachable one", () => {
    const { w, bot } = ridgeWorld();
    // Nearest tree sits on the ridge top (3 tiles away); the next tree is on the bot's own shelf
    // (5 tiles away). The old pick — nearest sight unseen — would freeze the bot against the ridge.
    const near = G.spawnResourceNode(w, "tree", 13.5, 10.5);
    const far = G.spawnResourceNode(w, "tree", 5.5, 10.5);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    a.memory.see({ id: near, kind: "node", x: 13.5, y: 10.5, tick: w.tick });
    a.memory.see({ id: far, kind: "node", x: 5.5, y: 10.5, tick: w.tick });
    const view: AgentWorldView = { seen: [], home: { x: 0, y: 0 }, playerName: "owner" };
    fillGoalSensors(w, bot, view, a);
    expect(view.gatherNode?.id).toBe(far);
  });

  it("no gather node when every candidate is unreachable", () => {
    const { w, bot } = ridgeWorld();
    const only = G.spawnResourceNode(w, "tree", 16.5, 10.5); // across the ridge, the only node
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    a.memory.see({ id: only, kind: "node", x: 16.5, y: 10.5, tick: w.tick });
    const view: AgentWorldView = { seen: [], home: { x: 0, y: 0 }, playerName: "owner" };
    fillGoalSensors(w, bot, view, a);
    expect(view.gatherNode).toBeUndefined();
  });
});

describe("ADR-385 farm-sensor reachable harvest", () => {
  it("the farm sensor harvests the nearest reachable bush, not the nearer bush across the ridge", () => {
    const { w, bot } = ridgeWorld();
    const d = G.gameplayDefs(w);
    const anchor = { x: 10.5, y: 10.5 };
    // blueberry_bush is a harvestable crop node (a plantable becomes it). Nearest by anchor
    // distance sits on the ridge top; the next one is on the bot's own shelf.
    const near = G.spawnResourceNode(w, "blueberry_bush", 13.5, 10.5);
    const far = G.spawnResourceNode(w, "blueberry_bush", 5.5, 10.5);
    const bs = scanBase(w, d, anchor);
    const farm = computeFarmSensor(w, bot, d, anchor, bs);
    expect(farm?.harvest?.id).toBe(far);
    expect(farm?.harvest?.id).not.toBe(near);
  });

  it("a banned harvest target is never re-picked while the ban holds", () => {
    const { w, bot } = ridgeWorld();
    const d = G.gameplayDefs(w);
    const anchor = { x: 10.5, y: 10.5 };
    const near = G.spawnResourceNode(w, "blueberry_bush", 13.5, 10.5); // unreachable
    const far = G.spawnResourceNode(w, "blueberry_bush", 5.5, 10.5); // reachable, but banned
    const bs = scanBase(w, d, anchor);
    const farm = computeFarmSensor(w, bot, d, anchor, bs, undefined, (id) => id === far);
    expect(farm?.harvest).toBeUndefined(); // near is unreachable, far is banned: nothing to harvest
    expect(farm).toBeUndefined();
  });
});
