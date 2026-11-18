/**
 * ADR-429: wild-crop top-up for already-generated chunks.
 *
 * The production server used to build `new ProceduralGenerator({ seed })` with no bands, so only the 7 fossil
 * resource kinds ever spawned. ADR-428 fixes new chunks by passing `worldgenBands(defs)`; this module fills in
 * the wild-crop / fruit-tree kinds that stored chunks (generated under the old rules) are missing.
 *
 * `computeWildCropTopUp(world, chunk, stored, desired)` is pure: it returns the placements to add and spawns
 * nothing, so the caller (persist's `topUpNodes` hook, wired by the server) hands them to the normal onLoad
 * spawn path and they persist exactly like generated nodes.
 *
 * Rules (all deterministic, so a re-run after the top-up is saved is a no-op):
 * - One node per missing kind per chunk, at the first desired placement (generator order) that passes.
 *   The desired set is what the chunk WOULD have under the correct bands (`generator.nodesInChunk`,
 *   same seed); a kind counts as present when any stored ResourceNode / NodeRegrow of that kind is in
 *   the chunk — including a depleted stump, which will regrow that kind itself.
 * - Only on tiles with no stored node / stump, whose STORED tile is land (0 void / 1 water / 8 shallows
 *   are skipped: the stored terrain may have been edited since generation, and the top-up never changes
 *   terrain). The generated terrain is band-independent (worldgen.json and DEFAULT_BANDS share the same
 *   band maxima), so a stored chunk's tiles are the generator's tiles unless a player edited them.
 * - The ADR-134 clearance protections, with the same radii as regrowth (`defs.depletion`): no structures
 *   (BuildPiece / PieceLink) within clearStructures, no roads within clearRoads, no living players
 *   within clearPlayers. Node clearance is the same-tile rule above (the generator itself places nodes
 *   on adjacent tiles), not regrowth's clearNodes radius.
 * - Never inside a claim: neither a core ClaimRegistry claim nor a Claim Flag privilege zone
 *   (`zonesNear`, ADR-315). Claims cannot exist at worldgen time, so this only binds stored chunks —
 *   which is exactly the case this top-up runs on.
 * - Scope is wild crops + fruit trees only (the ADR-349 set). Other kinds the old bands lacked
 *   (clay, salt, veins, ...) stay missing; that is a deliberate limit of this slice, not an oversight.
 *
 * CALLER CONTRACT (persist): call this ONLY for a stored chunk whose nodes are NOT regenerated
 * (`regenerateNodes` false for that chunk). For a fresh or regenerated chunk the generator's own nodes
 * already cover every kind, and calling this with an empty `stored` list would duplicate them.
 */
import { Permissions, Transform, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, type Chunk, type NodePlacement } from "@engine/world";
import { zonesNear } from "./building/zones.js";
import { BuildPiece, Dead, NodeRegrow, PieceLink, ResourceNode, Road, Survival } from "./components.js";
import { gameplayDefs } from "./config.js";

/** Fruit-tree species (ADR-349). */
export const FRUIT_TREE_KEYS = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;
/** Wild plants: every `wild_*` species plus the three named wild patches (same predicate as the ADR-349 test). */
export function isWildCropKey(key: string): boolean {
  return key.startsWith("wild_") || key === "flax_patch" || key === "cotton_bush" || key === "herb_patch";
}
export function isFruitTreeKey(key: string): boolean {
  return (FRUIT_TREE_KEYS as readonly string[]).includes(key);
}
/** Kinds this top-up fills in: wild crops + fruit trees. */
export function isWildCropTopUpKey(key: string): boolean {
  return isWildCropKey(key) || isFruitTreeKey(key);
}

interface Blocker { x: number; y: number; r: number }

/**
 * Placements to add to a stored chunk: at most one per wild-crop / fruit-tree kind missing from its
 * stored nodes. Pure and deterministic; re-running it after the returned nodes are spawned and saved
 * returns [] (every kind is then present). Spawns nothing itself.
 */
export function computeWildCropTopUp(
  world: World,
  chunk: Chunk,
  stored: readonly Entity[],
  desired: readonly NodePlacement[],
): NodePlacement[] {
  const defs = gameplayDefs(world);
  const x0 = chunk.cx * CHUNK_SIZE, y0 = chunk.cy * CHUNK_SIZE;
  // Kinds already in the chunk (live nodes and depleted stumps alike) + tiles they occupy.
  const present = new Set<number>();
  const occupied = new Set<number>();
  const hasNode = world.isRegistered(ResourceNode), hasRegrow = world.isRegistered(NodeRegrow);
  for (const e of stored) {
    if (!world.isAlive(e)) continue;
    let kind: number | undefined;
    if (hasNode && world.has(e, ResourceNode)) kind = world.getField(e, ResourceNode, "kind");
    else if (hasRegrow && world.has(e, NodeRegrow)) kind = world.getField(e, NodeRegrow, "kind");
    if (kind === undefined) continue;
    present.add(kind);
    const t = world.get(e, Transform);
    if (t) {
      const lx = Math.floor(t.x) - x0, ly = Math.floor(t.y) - y0;
      if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE) occupied.add(ly * CHUNK_SIZE + lx);
    }
  }
  // ADR-134 clearance blockers, collected once for the whole chunk (same radii as regrowth).
  const cfg = defs.depletion;
  const x1 = x0 + CHUNK_SIZE, y1 = y0 + CHUNK_SIZE;
  const maxR = Math.max(cfg.clearStructures, cfg.clearRoads, cfg.clearPlayers);
  const blockers: Blocker[] = [];
  const add = (q: Iterable<Entity>, r: number): void => {
    for (const e of q) {
      const p = world.get(e, Transform); if (!p) continue;
      if (p.x < x0 - maxR || p.x >= x1 + maxR || p.y < y0 - maxR || p.y >= y1 + maxR) continue;
      blockers.push({ x: p.x, y: p.y, r });
    }
  };
  if (world.isRegistered(BuildPiece)) add(world.query([BuildPiece, Transform]), cfg.clearStructures);
  if (world.isRegistered(PieceLink)) add(world.query([PieceLink, Transform]), cfg.clearStructures);
  if (world.isRegistered(Road)) add(world.query([Road, Transform]), cfg.clearRoads);
  if (world.isRegistered(Survival)) {
    add(world.query([Survival, Transform], world.isRegistered(Dead) ? [Dead] : []), cfg.clearPlayers);
  }
  const perms = world.getResource(Permissions);
  const inClaim = (x: number, y: number): boolean =>
    (perms !== undefined && perms.claims.claimAt(x, y) !== undefined) || zonesNear(world, x, y, 0).length > 0;

  const out: NodePlacement[] = [];
  const done = new Set<number>();
  for (const d of desired) {
    const key = defs.resources.get(d.kind)?.key;
    if (!key || !isWildCropTopUpKey(key)) continue;
    if (present.has(d.kind) || done.has(d.kind)) continue;
    const lx = d.tx - x0, ly = d.ty - y0;
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE) continue; // defensive: desired is in-chunk
    const tile = chunk.get(lx, ly);
    if (tile === 0 || tile === 1 || tile === 8) continue; // void / water / shallows in the STORED terrain
    if (occupied.has(ly * CHUNK_SIZE + lx)) continue;
    const px = d.tx + 0.5, py = d.ty + 0.5;
    if (blockers.some((b) => (b.x - px) ** 2 + (b.y - py) ** 2 < b.r * b.r)) continue;
    if (inClaim(px, py)) continue;
    out.push(d);
    done.add(d.kind);
  }
  return out;
}
