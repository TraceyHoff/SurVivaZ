/** ADR-295: room codes identify a host, not an individual guest. Never move restored characters here. */
import { Transform, type Entity, type World } from "@engine/core";
import { gameplayDefs, Health, inDeepWater, movementBlocked, solidCell, standHeightAt, StructureIndexRes, Vehicle, vehicleDefOf } from "@engine/gameplay";

/** Closest safe tile centre 1.5–64 tiles from the host. Elevated decks within eight tiles are preferred where supported;
 * caves/unsupported levels fall back to ground. Undefined lets the normal safe world spawn win. */
export function friendSpawn(world: World, friend: Entity): { x: number; y: number; z: number } | undefined {
  const t = world.get(friend, Transform); if (!t) return undefined;
  const defs = gameplayDefs(world), idx = world.getResource(StructureIndexRes), radius = defs.movement.bodyRadius;
  const level = Math.max(0, Math.floor(t.z / defs.building.levelHeight));
  const occupied = [...world.query([Health, Transform])].map(e => world.get(e, Transform)!);
  const vehicles = [...world.query([Vehicle, Transform])].map(e => ({ t: world.get(e, Transform)!, d: vehicleDefOf(world, e) }));
  const candidates: { x: number; y: number; distance: number }[] = [];
  for (let dy = -64; dy <= 64; dy++) for (let dx = -64; dx <= 64; dx++) {
    const x = Math.floor(t.x) + dx + .5, y = Math.floor(t.y) + dy + .5, distance = Math.hypot(x - t.x, y - t.y);
    if (distance >= 1.5 && distance <= 64) candidates.push({ x, y, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  // Try supported tiles at the friend's floor first, then the closest safe ground below/around them.
  for (const floor of level > 0 ? [level, 0] : [0]) for (const { x, y, distance } of candidates) {
    if (floor > 0 && distance > 8) continue;
    if (floor > 0) { const deck = idx?.deck(Math.floor(x), Math.floor(y), floor); if (!deck || idx?.def(deck)?.roof) continue; }
    if (inDeepWater(world, x, y) || movementBlocked(world, x, y, x, y, floor)) continue;
    if (idx && [[-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]].some(([dx, dy]) => solidCell(idx, Math.floor(x + dx!), Math.floor(y + dy!), floor))) continue;
    const z = standHeightAt(world, x, y, floor);
    if (occupied.some(p => Math.abs(p.z - z) < defs.building.levelHeight * .75 && Math.hypot(p.x - x, p.y - y) < Math.max(1, radius * 2))) continue;
    if (vehicles.some(v => v.d && Math.hypot(v.t.x - x, v.t.y - y) < Math.hypot(v.d.footprint.length, v.d.footprint.width) / 2 + radius)) continue;
    return { x, y, z };
  }
  return undefined;
}
