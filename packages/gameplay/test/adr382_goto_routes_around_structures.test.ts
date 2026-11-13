// ADR-382: goTo routes around structures even when no terrain has been edited yet.
// Root cause of the ADR-378 revert (ADR-252): goTo only used the pathfinder when
// editIndex(w).size > 0, so on a pristine map a bot walked directly at its target with no
// obstacle avoidance — it pushed against its own campfire (which sits between the bot and
// its quarry stand), tripped stuckOn/workFail, and the travel behaviour walked it 150 tiles
// away, so the raised pad was never dug. The first dig itself needs the pathfinder, so the
// gate was a circular dependency the pre-378 world only escaped by lucky timing.
// This test pins the fix at the unit level: a campfire directly on the straight segment,
// zero terrain edits, and the bot must still reach the goal (by routing around it).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, Transform } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { goTo } from "../src/ai/base_behaviors.js";
import { editIndex } from "../src/terrain_depth.js";
import { makeWorld, ensureClaim } from "./helpers.js";

function setup() {
  const w = makeWorld(), map = new TileMap();
  for (let y = -10; y < 20; y++) for (let x = -10; x < 20; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
  w.add(p, G.Worker, {} as never);
  G.grantSkillUnlocks(w, p);
  const d = G.gameplayDefs(w);
  for (const k of ["wood", "sticks", "stone", "fiber"]) G.addItem(w, p, d.itemId(k), 50);
  ensureClaim(w, p, 6, -4);
  return { w, p };
}

describe("ADR-382 goTo routes around structures with no terrain edits", () => {
  it("walks around a campfire directly on the path instead of pushing against it", () => {
    const { w, p } = setup();
    installPermissions(w);
    const d = G.gameplayDefs(w);
    // Campfire directly on the straight segment from (0.5, 0.5) to (4.5, 0.5).
    const placed = G.tryPlace(w, p, { piece: d.pieceId("campfire"), x: 2.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(placed.ok).toBe(true);
    // Precondition: no terrain has been edited — the old goTo gate walked directly here.
    expect(editIndex(w).size).toBe(0);
    const reg = G.registerGameplayCommands();
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1), v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
    const goal = { x: 4.5, y: 0.5 };
    let reached = false;
    for (let n = 0; n < 400; n++) {
      const t = w.get(p, Transform)!;
      if (Math.hypot(t.x - goal.x, t.y - goal.y) < 0.6) { reached = true; break; }
      const c = { ...v, self: { ...v.self, x: t.x, y: t.y, tick: w.tick }, world: { ...v.world, base: { x: 0, y: 0 } }, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a };
      const out = idleOutput();
      goTo(c, out, goal.x, goal.y);
      const frame = G.agentOutputFrame(out, w.tick, reg);
      G.applyMovementInput(w, p, frame.actions, 0.05);
      w.tick++;
    }
    const t = w.get(p, Transform)!;
    expect(reached).toBe(true);
    expect(Math.hypot(t.x - goal.x, t.y - goal.y)).toBeLessThan(0.6);
    // Still no terrain edits: the route was pure pathfinding, not the edit-gated branch.
    expect(editIndex(w).size).toBe(0);
  });
});
