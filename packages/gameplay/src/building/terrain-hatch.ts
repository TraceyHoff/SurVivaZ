/** ADR-299: a ground hatch over a dug shaft rides between the live rim and the live bottom. */
import { Transform, type Command, type CommandDef, type CommandRegistry, type Entity, type World } from "@engine/core";
import { BuildPiece, EdgeSide, InShaft, Stance, StanceMode } from "../components.js";
import { gameplayDefs } from "../config.js";
import { stanceMode } from "../stance.js";
import { TerrainRes, type Terrain } from "../world.js";
import { addInputHook, GameplayHoldBits } from "../input_hooks.js";
import { StructureIndexRes } from "./structure.js";

/** A hatch needs at least this much drop from the surrounding rim to the hole floor. */
export const MIN_SHAFT_DROP = 2;
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function shaftRimHeight(terrain: Terrain, tx: number, ty: number): number {
  let rim = -Infinity;
  for (const [dx, dy] of NEIGH) rim = Math.max(rim, terrain.heightAt(tx + dx, ty + dy));
  return Number.isFinite(rim) ? rim : terrain.heightAt(tx, ty);
}
export function shaftDrop(terrain: Terrain, tx: number, ty: number): number {
  return shaftRimHeight(terrain, tx, ty) - terrain.heightAt(tx, ty);
}
/** True when the four adjacent ground tiles around the hole share one height. */
export function shaftSidesLevel(terrain: Terrain, tx: number, ty: number): boolean {
  const h0 = terrain.heightAt(tx + NEIGH[0][0], ty + NEIGH[0][1]);
  for (const [dx, dy] of NEIGH) if (terrain.heightAt(tx + dx, ty + dy) !== h0) return false;
  return Number.isFinite(h0);
}
export function shaftHatchAt(world: World, tx: number, ty: number): Entity | 0 {
  return world.getResource(StructureIndexRes)?.hatch(tx, ty) ?? 0;
}
export function isShaftHatchPiece(world: World, e: Entity): boolean {
  if (!world.isAlive(e) || !world.has(e, BuildPiece)) return false;
  return !!gameplayDefs(world).pieces.get(world.getField(e, BuildPiece, "type")!)?.features.shaftHatch;
}
export function isInShaft(world: World, e: Entity): boolean {
  return !!world.getField(e, InShaft, "down");
}

/**
 * Height of column (x, y) for a step that started at (fromX, fromY).
 * A hatch tile is the rim when approached from above (you walk on the lid) and the hole when
 * approached from the pit or while the traveler is already down the shaft.
 */
export function shaftAwareHeight(world: World | undefined, terrain: Terrain, x: number, y: number, traveler?: Entity, fromX?: number, fromY?: number): number {
  const hole = terrain.heightAt(x, y);
  if (!world || !shaftHatchAt(world, x, y)) return hole;
  const rim = shaftRimHeight(terrain, x, y);
  if (traveler !== undefined && isInShaft(world, traveler)) {
    const t = world.get(traveler, Transform);
    if (t && Math.floor(t.x) === x && Math.floor(t.y) === y) return hole;
  }
  if (fromX !== undefined && fromY !== undefined && terrain.heightAt(fromX, fromY) <= hole + 1) return hole;
  return rim;
}

/** After a tile change: entering a hatch from pit depth marks the traveler down; leaving clears it. */
export function updateShaftOccupancy(world: World, e: Entity, prevX: number, prevY: number, x: number, y: number): void {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx === Math.floor(prevX) && ty === Math.floor(prevY)) return;
  const hatch = shaftHatchAt(world, tx, ty);
  if (!hatch) { if (world.has(e, InShaft)) world.remove(e, InShaft); return; }
  const terrain = world.getResource(TerrainRes); if (!terrain) return;
  if (terrain.heightAt(Math.floor(prevX), Math.floor(prevY)) <= terrain.heightAt(tx, ty) + 1) {
    if (world.has(e, InShaft)) world.set(e, InShaft, { down: 1 });
    else world.add(e, InShaft, { down: 1 });
  }
}

export function nearestShaftHatch(world: World, e: Entity): Entity | undefined {
  const t = world.get(e, Transform); if (!t) return undefined;
  const reach = gameplayDefs(world).building.buildReach + 0.35;
  const idx = world.getResource(StructureIndexRes);
  let best: Entity | undefined; let bd = reach;
  if (idx) {
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const h = idx.hatch(tx + dx, ty + dy); if (!h) continue;
      const ht = world.get(h, Transform); if (!ht) continue;
      const d = Math.hypot(ht.x - t.x, ht.y - t.y); if (d <= bd) { bd = d; best = h; }
    }
    if (best !== undefined) return best;
  }
  if (!world.isRegistered(BuildPiece)) return undefined;
  for (const h of world.query([BuildPiece, Transform])) {
    if (!isShaftHatchPiece(world, h)) continue;
    const ht = world.get(h, Transform)!; const d = Math.hypot(ht.x - t.x, ht.y - t.y);
    if (d <= bd) { bd = d; best = h; }
  }
  return best;
}

/** Toggle between standing on the lid and standing at the live bottom. Destinations always read current terrain. */
export function useShaftHatch(world: World, player: Entity, hatch?: Entity): boolean {
  const t = world.get(player, Transform); if (!t) return false;
  const h = hatch ?? nearestShaftHatch(world, player);
  if (h === undefined || !world.isAlive(h) || !isShaftHatchPiece(world, h)) return false;
  const ht = world.get(h, Transform); if (!ht) return false;
  if (Math.hypot(ht.x - t.x, ht.y - t.y) > gameplayDefs(world).building.buildReach + 0.35) return false;
  if (isInShaft(world, player)) {
    if (world.has(player, InShaft)) world.remove(player, InShaft);
  } else {
    if (world.has(player, InShaft)) world.set(player, InShaft, { down: 1 });
    else world.add(player, InShaft, { down: 1 });
  }
  world.set(player, Transform, { x: ht.x, y: ht.y });
  return true;
}

const prevInteract = new WeakMap<World, Map<Entity, boolean>>();

/** Interact (E / context) beside or on a hatch rides it, like toggling a door.
 *  queue/toggleDoor are passed in so this module never imports input.ts (ADR-115). */
export function installShaftHatchInput(
  world: World,
  enqueue: (world: World, e: Entity, reg: CommandRegistry, c: Command) => boolean,
  toggleDoor: CommandDef,
): void {
  addInputHook(world, {
    name: "shaft-hatch",
    onFrame(w, e, frame, reg) {
      const held = !!(frame.actions & GameplayHoldBits.Interact);
      let map = prevInteract.get(w); if (!map) prevInteract.set(w, (map = new Map()));
      const was = map.get(e) ?? false; map.set(e, held);
      if (!held || was) return;
      if (w.isRegistered(Stance) && stanceMode(w, e) === StanceMode.Carry) return;
      const hatch = nearestShaftHatch(w, e); if (hatch === undefined) return;
      try { enqueue(w, e, reg, reg.make(toggleDoor, { target: hatch })); } catch { /* registry without the door command */ }
    },
  });
}

/** Tile key shared with StructureIndex hatches (edgeKey at z=0, north). */
export const shaftHatchKey = (tx: number, ty: number): number => ((tx + (1 << 20)) * 2 ** 21 + (ty + (1 << 20))) * 32 + EdgeSide.North;
