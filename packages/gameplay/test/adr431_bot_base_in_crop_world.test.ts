// ADR-431: bots can claim bases and find berries in a crop-scattered world.
// ADR-428 made wild crops spawn, which exposed two latent couplings to the old 7-kind
// world: (1) berry_bush diluted 1-in-3 -> 1-in-70 of grass nodes, starving the dye ->
// Claim Flag chain (flag costs 2 dye; dye is 3 berries; only berry_bush yields berries),
// so bots sat on `goal=campfire, leaves=[berries]` forever; (2) pickBaseSite rejected
// any candidate with a ResourceNode in its 9x8 yard, which is node-free ~2% of the time
// at 0.055 nodes/tile, so bots could never claim a site at all.
import { describe, expect, it } from "vitest";
import { installPermissions, Transform } from "@engine/core";
import { ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { pickBaseSite } from "../src/ai/planner.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

describe("ADR-431 bots in a crop-scattered world", () => {
  it("berry bushes are a real share of spawned nodes (the dye chain can find them)", () => {
    const defs = G.defaultDefs();
    const berry = defs.resourceId("berry_bush");
    for (const seed of [11, 77, 1234]) {
      const gen = new ProceduralGenerator({ seed, bands: G.worldgenBands(defs) });
      let total = 0;
      let berries = 0;
      for (let cy = -5; cy < 5; cy++)
        for (let cx = -5; cx < 5; cx++)
          for (const n of gen.nodesInChunk(cx, cy)) {
            total++;
            if (n.kind === berry) berries++;
          }
      expect(total).toBeGreaterThan(0);
      // At the ADR-349 x1 weighting this share is ~1-2% (berry_bush 1-in-70 grass
      // kinds); at the ADR-431 x14 weighting it is ~10%+ (density back to ~0.009/tile,
      // the pre-ADR-428 level), so a bot reliably perceives one near spawn.
      expect(berries / total).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("stone is findable near the starter spawns (the flag needs 10 stone)", () => {
    // ADR-431: stone was diluted the same way as berries — sand loose_rocks fell from 100% of sand
    // nodes (0.01/tile) to 1-in-14 (0.002/tile), and rock boulder/rubble from 1-in-2 to 2-in-14 /
    // 1-in-14, so bots expeditioned 100-300 tiles for the flag's 10 stone instead of gathering it
    // near home. With the restored weights (loose_rocks x8 sand, boulder x6 + rubble_pile x3 rock)
    // the four ADR-203 starter spawns have 16 stone nodes within 30 tiles between them (seed 11).
    const defs = G.defaultDefs();
    const stone = new Set([defs.resourceId("boulder"), defs.resourceId("rubble_pile"), defs.resourceId("loose_rocks")]);
    const gen = new ProceduralGenerator({ seed: 11, bands: G.worldgenBands(defs) });
    let found = 0;
    for (const [sx, sy] of [[-136, -134], [-143, 142], [139, 132], [120, -131]] as const) {
      const cx0 = Math.floor((sx - 30) / 32), cx1 = Math.floor((sx + 30) / 32);
      const cy0 = Math.floor((sy - 30) / 32), cy1 = Math.floor((sy + 30) / 32);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++)
        for (const n of gen.nodesInChunk(cx, cy)) {
          if (Math.abs(n.tx - sx) > 30 || Math.abs(n.ty - sy) > 30) continue;
          if (stone.has(n.kind)) found++;
        }
    }
    expect(found).toBeGreaterThanOrEqual(10);
  });

  it("pickBaseSite finds a site in a yard scattered with nodes, with a node-free footprint", () => {
    const w = makeWorld({}, 42);
    installPermissions(w);
    const bot = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
    const defs = G.gameplayDefs(w);
    const kind = defs.resourceId("wild_wheat");
    // Scatter wild plants over the whole site-search disk, except the 2x2 footprints
    // of the first three candidates pickBaseSite tries for salt 0.5 (angles
    // 1.94/3.59/5.23 rad at r 5/7/9 -> (-2,4), (-7,-4), (4,-8)). Every yard rect in
    // the disk is node-dense, so the old yard-wide veto would reject all 24.
    const holes = new Set(["-2,4", "-1,4", "-2,5", "-1,5", "-7,-4", "-6,-4", "-7,-3", "-6,-3", "-7,-2", "-6,-2", "4,-8", "5,-8", "4,-7", "5,-7"]);
    for (let y = -14; y <= 14; y++)
      for (let x = -14; x <= 14; x++) {
        if (holes.has(`${x},${y}`)) continue;
        if ((x * 31 + y * 17) % 5 < 2) G.spawnResourceNode(w, kind, x + 0.5, y + 0.5);
      }
    steps(w, 5); // let the spatial index see the scattered nodes
    const site = pickBaseSite(w, bot, { x: 0, y: 0 }, 0.5);
    expect(site).toBeDefined();
    const bx = site!.x;
    const by = site!.y;
    const nodesAt = (x: number, y: number): number => {
      let n = 0;
      for (const e of w.query([G.ResourceNode, Transform])) {
        const t = w.get(e, Transform)!;
        if (Math.floor(t.x) === x && Math.floor(t.y) === y) n++;
      }
      return n;
    };
    // The found site's yard is node-dense (the old rule would have rejected it) ...
    let yard = 0;
    for (let y = by - 2; y <= by + 5; y++) for (let x = bx - 3; x <= bx + 5; x++) yard += nodesAt(x, y);
    expect(yard).toBeGreaterThan(0);
    // ... but its 2x2 foundation footprint is node-free (the new rule holds).
    for (const [x, y] of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]] as const)
      expect(nodesAt(x, y)).toBe(0);
  });
});
