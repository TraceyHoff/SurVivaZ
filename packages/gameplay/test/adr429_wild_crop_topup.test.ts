/**
 * ADR-429: wild-crop top-up for already-generated chunks.
 *
 * The production server used to build `new ProceduralGenerator({ seed })` with no bands, so only the 7 fossil
 * resource kinds ever spawned. ADR-428 fixes new chunks; this slice fills in the wild-crop / fruit-tree kinds
 * that stored chunks (generated under the old rules) are missing — one node per missing kind per chunk, on a
 * free land tile that passes the ADR-134 clearance protections and is outside every claim / privilege zone.
 * Re-running the load after the top-up is persisted adds nothing further (idempotent).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Permissions, Transform, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, ProceduralGenerator, type Chunk, type NodePlacement } from "@engine/world";
import * as G from "../src/index.js";
import { BuildPiece, NodeRegrow, PrivilegeZone, Road } from "../src/index.js";
import { makeWorld } from "./helpers.js";

const FRUIT_TREES = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;
const NON_TOP_UP_NEW = ["clay_deposit", "salt_flat", "copper_vein", "oil_seep", "fish_shoal", "animal_carcass", "rubble_pile"] as const;
const SEEDS = [1234, 11, 99, 4242, 7, 2024];
const CHUNKS = [[0, 0], [1, 0], [0, 1], [-1, 0], [2, 2], [-2, 1], [3, -2], [-3, -3]] as const;

const keyOf = (defs: G.GameDefs, kind: number): string => defs.resources.get(kind)?.key ?? `#${kind}`;
const isTopUp = (defs: G.GameDefs, kind: number): boolean => G.isWildCropTopUpKey(keyOf(defs, kind));

/** Chunk (cx,cy) as the OLD server generated it (default bands) + what it WOULD have under the correct bands. */
function oldAndDesired(seed: number, cx: number, cy: number): { defs: G.GameDefs; chunk: Chunk; oldNodes: NodePlacement[]; desired: NodePlacement[] } {
  const defs = G.defaultDefs();
  const { chunk, nodes: oldNodes } = new ProceduralGenerator({ seed }).load(cx, cy);
  const desired = new ProceduralGenerator({ seed, bands: G.worldgenBands(defs) }).nodesInChunk(cx, cy);
  return { defs, chunk, oldNodes, desired };
}

/** Test world holding the stored chunk's nodes as live entities; returns them plus anything extra the caller adds. */
function storedWorld(seed: number, oldNodes: readonly NodePlacement[], extra?: (w: World, stored: Entity[]) => void): { w: World; stored: Entity[] } {
  const w = makeWorld({}, seed);
  const stored: Entity[] = [];
  for (const n of oldNodes) stored.push(G.spawnResourceNode(w, n.kind, n.tx + 0.5, n.ty + 0.5));
  extra?.(w, stored);
  return { w, stored };
}

const storedTiles = (w: World, stored: readonly Entity[]): Set<string> => {
  const out = new Set<string>();
  for (const e of stored) { const t = w.get(e, Transform); if (t) out.add(`${Math.floor(t.x)},${Math.floor(t.y)}`); }
  return out;
};

describe("ADR-429: wild-crop top-up for already-generated chunks", () => {
  it("tops up missing wild-crop and fruit-tree kinds; stored nodes (incl. depleted stumps) are untouched", () => {
    const { defs, chunk, oldNodes, desired } = oldAndDesired(1234, 0, 0);
    // A depleted stump of a top-up kind: its kind counts as present and its tile as occupied.
    const stumpTarget = desired.find((d) => isTopUp(defs, d.kind))!;
    const stumpKind = stumpTarget.kind;
    const { w, stored } = storedWorld(1234, oldNodes.slice(1), (w2, list) => {
      const g = w2.create();
      w2.add(g, Transform, { x: stumpTarget.tx + 0.5, y: stumpTarget.ty + 0.5 })
        .add(g, NodeRegrow, { kind: stumpKind, respawnAtTick: 10_000, stumpUntilTick: 0, tries: 0 });
      list.push(g);
      // A depleted legacy node (amount 0) also occupies its tile.
      const d = w2.create();
      w2.add(d, Transform, { x: oldNodes[0]!.tx + 0.5, y: oldNodes[0]!.ty + 0.5 })
        .add(d, G.ResourceNode, { kind: oldNodes[0]!.kind, amount: 0, respawnAtTick: 0 });
      list.push(d);
    });
    const before = [...w.query([G.ResourceNode, Transform]), ...w.query([NodeRegrow, Transform])].length;
    const result = G.computeWildCropTopUp(w, chunk, stored, desired);
    // Pure: the world is unchanged; the caller spawns the returned placements.
    expect([...w.query([G.ResourceNode, Transform]), ...w.query([NodeRegrow, Transform])]).toHaveLength(before);

    expect(result.length).toBeGreaterThanOrEqual(10);
    expect(result.length).toBeLessThanOrEqual(30); // at most one per top-up kind (25 wild + 5 fruit)
    const kinds = result.map((n) => n.kind);
    expect(new Set(kinds).size).toBe(kinds.length); // one node per kind
    for (const n of result) {
      expect(isTopUp(defs, n.kind), `${keyOf(defs, n.kind)} is a top-up kind`).toBe(true);
      expect(n.kind).not.toBe(stumpKind); // present as a stump: not re-added
      expect(NON_TOP_UP_NEW).not.toContain(keyOf(defs, n.kind)); // other new-band kinds stay missing (out of scope)
    }
    expect(kinds.map((k) => keyOf(defs, k)).some((k) => (FRUIT_TREES as readonly string[]).includes(k))).toBe(true);
    const occupied = storedTiles(w, stored);
    for (const n of result) {
      expect(occupied.has(`${n.tx},${n.ty}`), `top-up on occupied tile ${n.tx},${n.ty}`).toBe(false);
      const li = (n.ty - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + (n.tx - chunk.cx * CHUNK_SIZE);
      expect(chunk.tiles[li]).not.toBe(0); expect(chunk.tiles[li]).not.toBe(1); expect(chunk.tiles[li]).not.toBe(8);
    }
  });

  it("is deterministic, and idempotent once the top-up is persisted", () => {
    const { chunk, oldNodes, desired } = oldAndDesired(1234, 0, 0);
    const { w, stored } = storedWorld(1234, oldNodes);
    const first = G.computeWildCropTopUp(w, chunk, stored, desired);
    const second = G.computeWildCropTopUp(w, chunk, stored, desired);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    // Persist the top-up: spawn the returned nodes as the chunk's stored set, then load again.
    const grown = [...stored];
    for (const n of first) grown.push(G.spawnResourceNode(w, n.kind, n.tx + 0.5, n.ty + 0.5));
    expect(G.computeWildCropTopUp(w, chunk, grown, desired)).toEqual([]);
    // Loading twice in a row without any persist in between is the same computation: still the same set.
    expect(G.computeWildCropTopUp(w, chunk, stored, desired)).toEqual(first);
  });

  it("never tops up inside a claim, a privilege zone, or near structures / roads / players (ADR-134)", () => {
    const { defs, chunk, oldNodes, desired } = oldAndDesired(1234, 0, 0);
    const clear = (w: World, stored: Entity[]): NodePlacement[] => G.computeWildCropTopUp(w, chunk, stored, desired);
    // Whole-chunk privilege zone (Claim Flag, radius 40 at the centre covers the 32x32 chunk).
    {
      const { w, stored } = storedWorld(1234, oldNodes, (w2) => {
        const z = w2.create();
        w2.add(z, Transform, { x: 16.5, y: 16.5 }).add(z, PrivilegeZone, { radius: 40, tribe: 0 });
      });
      expect(clear(w, stored)).toEqual([]);
    }
    // Whole-chunk core claim (permissions ClaimRegistry).
    {
      const { w, stored } = storedWorld(1234, oldNodes, (w2) => {
        installPermissions(w2);
        w2.getResource(Permissions)!.claims.add({ ownerGroup: 0, x0: 0, y0: 0, x1: 32, y1: 32, flags: 0 });
      });
      expect(clear(w, stored)).toEqual([]);
    }
    // A grid of structures (spacing 8 < 2 x clearStructures 6) leaves no clear tile.
    {
      const { w, stored } = storedWorld(1234, oldNodes, (w2) => {
        for (let y = 4; y < 32; y += 8) for (let x = 4; x < 32; x += 8) {
          const e = w2.create();
          w2.add(e, Transform, { x: x + 0.5, y: y + 0.5 })
            .add(e, BuildPiece, { type: 0, rot: 0, variant: 0, tier: 0, hp: 100, damageStage: 0, paint: 0, tint: 0 });
        }
      });
      expect(clear(w, stored)).toEqual([]);
    }
    // One road / one player / one small zone on a candidate tile: that placement is skipped, the kind
    // moves to its next desired placement (or drops when it has none) — and nothing lands near the blocker.
    for (const blocker of ["road", "player", "zone"] as const) {
      const { w, stored } = storedWorld(1234, oldNodes);
      const base = clear(w, stored);
      expect(base.length).toBeGreaterThan(0);
      const target = base[0]!;
      const bx = target.tx + 0.5, by = target.ty + 0.5;
      if (blocker === "road") {
        const e = w.create();
        w.add(e, Transform, { x: bx, y: by }).add(e, Road, { surface: 1, mask: 0, owner: 0 });
      } else if (blocker === "player") {
        G.spawnPlayer(w, { x: bx, y: by });
      } else {
        const e = w.create();
        w.add(e, Transform, { x: bx, y: by }).add(e, PrivilegeZone, { radius: 5, tribe: 0 });
      }
      const after = clear(w, stored);
      const r = blocker === "road" ? 2 : blocker === "player" ? 10 : 0;
      for (const n of after) {
        if (blocker === "zone") expect(G.zonesNear(w, n.tx + 0.5, n.ty + 0.5, 0)).toEqual([]);
        else expect(Math.hypot(n.tx + 0.5 - bx, n.ty + 0.5 - by) >= r, `${blocker}: placement too close`).toBe(true);
      }
      // The blocked kind is not duplicated at the same tile, and a blocker can only remove or
      // relocate placements, never add or move another kind: every placement in `after` is either
      // unchanged from `base`, or a kind whose base tile the blocker covers, relocated to a later
      // desired tile of that same kind.
      expect(after.filter((n) => n.kind === target.kind && n.tx === target.tx && n.ty === target.ty)).toEqual([]);
      expect(after.length).toBeLessThanOrEqual(base.length); // a blocker only removes / relocates
      for (const n of after) {
        const unchanged = base.some((b) => b.kind === n.kind && b.tx === n.tx && b.ty === n.ty);
        if (unchanged) continue;
        const baseSpot = base.find((b) => b.kind === n.kind);
        expect(baseSpot, `${blocker}: ${keyOf(defs, n.kind)} appeared from nowhere`).toBeDefined();
        const blocked = blocker === "zone"
          ? G.zonesNear(w, baseSpot!.tx + 0.5, baseSpot!.ty + 0.5, 0).length > 0
          : Math.hypot(baseSpot!.tx + 0.5 - bx, baseSpot!.ty + 0.5 - by) < r;
        expect(blocked, `${blocker}: ${keyOf(defs, n.kind)} relocated without its base tile being blocked`).toBe(true);
      }
    }
  });

  it("never tops up on water, including a tile the player edited to water", () => {
    const { chunk, oldNodes, desired } = oldAndDesired(1234, 0, 0);
    const { w, stored } = storedWorld(1234, oldNodes);
    const first = G.computeWildCropTopUp(w, chunk, stored, desired);
    expect(first.length).toBeGreaterThan(0);
    const p = first[0]!;
    chunk.set(p.tx - chunk.cx * CHUNK_SIZE, p.ty - chunk.cy * CHUNK_SIZE, 1); // dug a pond on it
    const after = G.computeWildCropTopUp(w, chunk, stored, desired);
    expect(after.some((n) => n.tx === p.tx && n.ty === p.ty)).toBe(false);
  });

  it("measurement: added nodes per chunk stay modest across seeds", { timeout: 120_000 }, () => {
    let total = 0; let n = 0; let max = 0; let min = Infinity;
    for (const seed of SEEDS) for (const [cx, cy] of CHUNKS) {
      const { chunk, oldNodes, desired } = oldAndDesired(seed, cx, cy);
      const { w, stored } = storedWorld(seed, oldNodes);
      const added = G.computeWildCropTopUp(w, chunk, stored, desired).length;
      total += added; n++; max = Math.max(max, added); min = Math.min(min, added);
    }
    const mean = total / n;
    console.log(`[measure] ADR-429 top-up: mean ${mean.toFixed(1)} nodes/chunk over ${n} chunks (min ${min}, max ${max})`);
    expect(mean).toBeGreaterThanOrEqual(5);
    expect(mean).toBeLessThanOrEqual(25);
    expect(max).toBeLessThanOrEqual(30);
  });
});
