/** ADR-215 fixtures: build a small village of walled rooms (L corners, walls, doorways, doors, stations) in a test world. */
import { Transform, type Entity, type World } from "@engine/core";
import { AttachKind, DoorState, defaultDefs, placePiece, snapPlacement, spawnPlayer, structures, validatePlacement } from "../src/index.js";
import { resolveAttachment } from "../src/building/links.js";
import { makeWorld, steps, spawnLearned } from "./helpers.js";

export const defs = defaultDefs();
export type Put = (key: string, x: number, y: number, level?: number, rot?: number) => Entity;
export function world215(): { w: World; me: Entity; put: Put } {
  const w = makeWorld(); const me = spawnLearned(w, { x: -40, y: -40, maxWeight: 0, clientId: 1 });
  const put: Put = (key, x, y, level = 0, rot = 0) => {
    const sn = snapPlacement(w, { piece: defs.pieceId(key), x, y, level, rot, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`setup ${key} snap ${sn}`);
    const f = validatePlacement(w, me, sn, { ignoreCost: true, ignoreRange: true, ignoreClaim: true }); // ADR-310 claims are not under test here if (f) throw new Error(`setup ${key} @${x},${y} r${rot}: fail ${f}`);
    const e = placePiece(w, me, sn, { pay: false }); return e as Entity;
  };
  return { w, me, put };
}
/**
 * n x n room with its top-left tile at (ox, oy): foundations, an L corner at each outer corner, straight walls on the
 * other rim edges, a doorway in the middle of the north side (optionally with a door) and a workbench in the middle.
 */
export function room(w: World, put: Put, ox: number, oy: number, n = 3, opts: { door?: boolean; bench?: boolean } = {}): { door?: Entity; doorway: { x: number; y: number } } {
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) put("foundation", ox + x + 0.5, oy + y + 0.5);
  put("wall_corner_outer", ox, oy, 0, 0); put("wall_corner_outer", ox + n, oy, 0, 1); put("wall_corner_outer", ox + n, oy + n, 0, 2); put("wall_corner_outer", ox, oy + n, 0, 3);
  const mid = Math.floor(n / 2);
  for (let i = 1; i < n - 1; i++) {
    if (i === mid) put("wall_doorway", ox + i + 0.5, oy); else put("wall", ox + i + 0.5, oy);
    put("wall", ox + i + 0.5, oy + n, 0, 2); put("wall", ox, oy + i + 0.5, 0, 1); put("wall", ox + n, oy + i + 0.5, 0, 3);
  }
  let door: Entity | undefined;
  if (opts.door) door = put("door_wood", ox + mid + 0.5, oy);
  if (opts.bench && n >= 3) put("workbench", ox + mid + 0.5, oy + n - 1 + 0.5);
  steps(w, 2);
  return { ...(door !== undefined && { door }), doorway: { x: ox + mid + 0.5, y: oy } };
}
export function setDoor(w: World, door: Entity, open: boolean): void {
  const a = resolveAttachment(w, door, AttachKind.Door)!; w.setField(a, DoorState, "open", open ? 1 : 0); structures(w).version++;
}
export const pos = (w: World, e: Entity): { x: number; y: number; z: number } => { const t = w.get(e, Transform)!; return { x: t.x, y: t.y, z: t.z ?? 0 }; };
export const tp = (w: World, e: Entity, x: number, y: number, z = 0): void => { w.set(e, Transform, { x, y, z }); };
