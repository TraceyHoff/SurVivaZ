// ADR-589: spawnPointAt returns one specific installed spawn point (the world creator's
// chosen start) with the standard jitter, deterministically; indices clamp.
import { describe, expect, it } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const PTS = [{ x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }, { x: -100, y: -100 }];

describe("ADR-589 spawnPointAt", () => {
  it("returns the requested point within jitter, deterministically", () => {
    const w = makeWorld(); G.setSpawnPoints(w, PTS);
    const p = G.spawnPointAt(w, 2, "join", 7);
    expect(p.index).toBe(2);
    expect(Math.hypot(p.x - -100, p.y - 100)).toBeLessThanOrEqual(G.SPAWN_JITTER);
    expect(G.spawnPointAt(w, 2, "join", 7)).toEqual(p);
  });

  it("ignores crowding — the chosen point is used even when occupied", () => {
    const w = makeWorld(); G.setSpawnPoints(w, PTS);
    G.spawnPlayer(w, { x: -100, y: 100, clientId: 1 });
    expect(G.spawnPointAt(w, 2, "join", 3).index).toBe(2);
    expect(G.pickSpawnPoint(w, "join", 3).index).not.toBe(2); // the least-crowded pick differs
  });

  it("clamps out-of-range indices to the installed list", () => {
    const w = makeWorld(); G.setSpawnPoints(w, PTS);
    expect(G.spawnPointAt(w, 99, "join", 0).index).toBe(3);
    expect(G.spawnPointAt(w, -5, "join", 0).index).toBe(0);
  });
});
