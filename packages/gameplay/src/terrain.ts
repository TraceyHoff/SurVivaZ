/**
 * ADR-263 (Task 36): shovel terrain editing, flowing water, underground depth.
 *  - A shovel (any tier, items.json tool.kind "shovel") raises or lowers the ground one level per use. Players use the
 *    one in their main hand (hotbar); hired AI humans may use one carried in their bag. Edits write the chunk height
 *    field ADR-254 generated (so cliff faces / ledge lips redraw) and keep a TerrainEdit entity with the offset from the
 *    generated ground; absolute terrain levels are limited to -60..75 (ADR-297).
 *  - Flowing water: water spreads, one tile per neighbour per flow step, from any water tile into an adjacent dug tile
 *    (dig < 0) whose bed is at or below the source water's surface (a natural lake's surface is the flat ADR-182 level,
 *    a flowed tile's surface is its own bed). Raised ground (walls / berms) and undug ground never flood, so elevated
 *    bases stay dry and pits fill only when a channel connects them to water. Raising a water tile fills it with earth.
 *  - Underground: a tile dug >= TERRAIN.undergroundDepth (3) levels below ground is underground: air there is a constant
 *    60°F year-round (systems/environment ambientTemperature), it is dark unless a light (held torch / lantern / candle,
 *    campfire, lit station or lamp; systems/lights) reaches it, and crops there grow only with light + water.
 * Authority-only writes; the command is input-queued (gameplay.terrain) and validated for reach + shovel.
 */
import { defineCommand, defineResource, Transform, type CommandDef, type CommandHandlers, type Entity, type World } from "@engine/core";
import { flowWaterRaw, installSpatialIndex, isWaterId, renderTileHeight, terrainLevel, WATER_TILE } from "@engine/world";
import { BuildPiece, Crop, Dead, Equipment, ResourceNode, TerrainEdit, Worker } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { ToolKind } from "./defs.js";
import { countItem, exchangeItems } from "./inventory.js";
import { itemIdSafe } from "./roads.js";
import { StructureIndex, structures } from "./building/structure.js";
import { hasPrivilege } from "./building/place.js";
import { emit, XpActivity } from "./events.js";
import { indexEntity } from "./spawn.js";
import { TerrainRes, type Terrain } from "./world.js";
import { editAt, editIndex, invalidateTerrainIndex, LEVEL_MAX, LEVEL_MIN, terrainDigAt, TERRAIN, tkey, untkey } from "./terrain_depth.js";
export { LEVEL_MAX, LEVEL_MIN, TERRAIN, terrainDigAt, undergroundDepthAt, isUnderground, invalidateTerrainIndex } from "./terrain_depth.js";

export const enum TerrainFail { None = 0, NoShovel = 1, Limit = 2, NoPrivilege = 3, Occupied = 4, NotLoaded = 5, TooFar = 6, BadTile = 7, NoSoil = 8, InventoryFull = 9 }
export const TERRAIN_FAIL_REASONS = ["", "no_shovel", "limit", "no_privilege", "occupied", "not_loaded", "too_far", "bad_tile", "no_soil", "inventory_full"] as const;
export const TERRAIN_FAIL_TEXT: Readonly<Record<number, string>> = {
  [TerrainFail.NoShovel]: "Hold a shovel to dig or raise ground", [TerrainFail.Limit]: "Can't dig or build the ground any further here",
  [TerrainFail.NoPrivilege]: "Inside someone else's claim", [TerrainFail.Occupied]: "Something is in the way",
  [TerrainFail.NoSoil]: "Need soil to raise ground", [TerrainFail.InventoryFull]: "Inventory full — no room for soil",
  [TerrainFail.NotLoaded]: "Too far away", [TerrainFail.TooFar]: "Too far away", [TerrainFail.BadTile]: "Can't dig open water — raise it to fill",
};

// ---- shovel ---------------------------------------------------------------------------------------------------------
const shovelIds = new WeakMap<object, number[]>();
function shovels(world: World): number[] {
  const defs = gameplayDefs(world); let l = shovelIds.get(defs); if (l) return l;
  l = [...defs.items.values()].filter((d) => d.tool?.kind === ToolKind.Shovel).map((d) => d.id).sort((a, b) => a - b); shovelIds.set(defs, l); return l;
}
/** A shovel the entity can dig with: the main-hand item (players, hotbar), or for a hired AI human any shovel in its bag. */
export function hasShovel(world: World, e: Entity): boolean {
  const ids = shovels(world); if (!ids.length) return false;
  const mh = world.isRegistered(Equipment) ? (world.getField(e, Equipment, "mainHandItem") ?? 0) : 0;
  if (mh && ids.includes(mh)) return true;
  if (world.isRegistered(Worker) && world.has(e, Worker)) return ids.some((id) => { try { return countItem(world, e, id) > 0; } catch { return false; } });
  return false;
}
/** Whether the main-hand item is a shovel (client: shows the Dig / Raise controls). */
export function holdingShovel(world: World, e: Entity): boolean {
  const mh = world.isRegistered(Equipment) ? (world.getField(e, Equipment, "mainHandItem") ?? 0) : 0;
  return mh !== 0 && shovels(world).includes(mh);
}
/** The tile in front of an entity (its facing), as used for touch / gamepad / keyboard digging. */
export function frontTile(world: World, e: Entity): { x: number; y: number } | undefined {
  const t = world.get(e, Transform); if (!t) return undefined; const f = t.facing ?? 0;
  return { x: Math.floor(t.x + Math.cos(f)), y: Math.floor(t.y + Math.sin(f)) };
}

// ---- flow frontier ---------------------------------------------------------------------------------------------------
interface FlowState { frontier: Set<number>; lastReseed: number }
export const FlowRes = defineResource<FlowState>("gameplay.TerrainFlow");
function flow(world: World): FlowState { let f = world.getResource(FlowRes); if (!f) world.setResource(FlowRes, (f = { frontier: new Set(), lastReseed: -1 })); return f; }
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
function wake(world: World, tx: number, ty: number): void { const f = flow(world).frontier; f.add(tkey(tx, ty)); for (const [dx, dy] of N4) f.add(tkey(tx + dx, ty + dy)); }

const raw = (t: Terrain, x: number, y: number): number => t.rawHeightAt?.(x, y) ?? t.heightAt(x, y);
/** Surface level of the water on (x,y), or undefined when it is not water. */
export function waterSurfaceAt(t: Terrain, x: number, y: number): number | undefined {
  const id = t.tileAt(x, y); return isWaterId(id) ? renderTileHeight(id, raw(t, x, y)) : undefined;
}

function blocked(world: World, tx: number, ty: number): boolean {
  // ADR-266: protect the WHOLE footprint and both supporting tiles of an edge wall,
  // not just the tile containing its Transform anchor. Terrain ladders may extend with the face.
  const building = structures(world);
  for (let layer = 0; layer <= 3; layer++) if (building.cell(tx, ty, 0, layer)) return true;
  for (const [ex, ey, side] of StructureIndex.tileEdges(tx, ty)) if (building.edge(ex, ey, 0, side)) return true;

  const idx = installSpatialIndex(world); idx.update();
  for (const o of idx.queryRadius(tx + 0.5, ty + 0.5, 0.75)) {
    if (!world.isAlive(o) || world.has(o, Dead)) continue;
    if (!(world.has(o, BuildPiece) || world.has(o, ResourceNode) || world.has(o, Crop))) continue;
    const p = world.get(o, Transform); if (p && Math.floor(p.x) === tx && Math.floor(p.y) === ty) return true;
  }
  return false;
}

/**
 * Raise (dir > 0) or lower (dir < 0) the tile (tx,ty) one level with a shovel. Authority writes; dryRun only validates.
 * Lowering water is refused (fill it by raising instead); raising water turns it into earth at its level.
 */
export function editTerrain(world: World, e: Entity, tx: number, ty: number, dir: number, dryRun = false): TerrainFail {
  tx = Math.floor(tx); ty = Math.floor(ty); const t = world.getResource(TerrainRes);
  if (!t || !t.setRawHeight || !t.setTile || (t.loaded && !t.loaded(tx, ty))) return TerrainFail.NotLoaded;
  if (!hasShovel(world, e)) return TerrainFail.NoShovel;
  const body = world.get(e, Transform); if (body && Math.hypot(body.x - tx - 0.5, body.y - ty - 0.5) > TERRAIN.reach + 0.75) return TerrainFail.TooFar;
  if (!hasPrivilege(world, e, tx + 0.5, ty + 0.5)) return TerrainFail.NoPrivilege;
  const id = t.tileAt(tx, ty); if (id === 0) return TerrainFail.NotLoaded;
  const h = raw(t, tx, ty); const water = isWaterId(id);
  const dig = terrainDigAt(world, tx, ty); const up = dir > 0;
  if (water && !up) return TerrainFail.BadTile;
  if (blocked(world, tx, ty)) return TerrainFail.Occupied;
  const level = terrainLevel(id, h); // bed level (flowing water decodes its height offset)
  const nextDig = water ? dig : dig + (up ? 1 : -1); const nextLevel = water ? level : level + (up ? 1 : -1);
  // ADR-297: absolute height-zero datum; both humans and players use this validation.
  if (nextLevel < LEVEL_MIN || nextLevel > LEVEL_MAX) return TerrainFail.Limit;
  // ADR-264: one unit of earth per edit, including filling water and undoing earlier edits.
  // exchangeItems validates on scratch slots: previews never mutate inventory, and a full bag never loses dug soil.
  const soil = itemIdSafe(world, "soil");
  const fail = up ? TerrainFail.NoSoil : TerrainFail.InventoryFull;
  if (soil === undefined) return fail;
  const unit = [{ item: soil, count: 1 }];
  if (!exchangeItems(world, e, up ? unit : [], up ? [] : unit, dryRun)) return fail;
  if (dryRun) return TerrainFail.None;
  if (water) { t.setTile(tx, ty, TERRAIN.earthTile); t.setRawHeight(tx, ty, level); }
  else { t.setRawHeight(tx, ty, nextLevel); if (id !== TERRAIN.earthTile) t.setTile(tx, ty, TERRAIN.earthTile); setDig(world, tx, ty, nextDig); }
  wake(world, tx, ty);
  emit(world, XpActivity, { entity: e, source: "dig", units: 1 });
  return TerrainFail.None;
}
function setDig(world: World, tx: number, ty: number, dig: number): void {
  const ex = editAt(world, tx, ty);
  if (dig === 0) { if (ex !== undefined) { world.destroy(ex); invalidateTerrainIndex(world); } return; }
  if (ex !== undefined) { world.setField(ex, TerrainEdit, "dig", dig); return; }
  const n = world.create(); world.add(n, Transform, { x: tx + 0.5, y: ty + 0.5 }).add(n, TerrainEdit, { dig });
  indexEntity(world, n); invalidateTerrainIndex(world);
}
/** Tests / tools: write a terrain edit offset (and the matching height) directly, no shovel / reach checks. */
export function setTerrainDig(world: World, tx: number, ty: number, dig: number): void {
  const t = world.getResource(TerrainRes); const cur = terrainDigAt(world, tx, ty);
  if (!t?.setRawHeight) return;
  const id = t.tileAt(tx, ty); const height = terrainLevel(id, raw(t, tx, ty));
  const next = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, height + dig - cur));
  t.setRawHeight(tx, ty, isWaterId(id) ? flowWaterRaw(next) : next);
  setDig(world, tx, ty, cur + next - height); wake(world, tx, ty);
}

/**
 * Flow step (authority, every TERRAIN.flowEveryTicks): each frontier tile that is dry, dug (dig < 0) and has a 4-neighbour
 * water surface at or above its bed floods (WATER_TILE, flowing-water height encoding); its neighbours join the next
 * frontier. Deterministic (sorted keys), at most TERRAIN.flowPerStep floods per step. Returns tiles flooded.
 */
export function terrainFlowStep(world: World): number {
  const t = world.getResource(TerrainRes); if (!t?.setTile || !t.setRawHeight) return 0;
  const st = flow(world);
  if (st.lastReseed < 0 || world.tick - st.lastReseed >= TERRAIN.reseedEveryTicks) { // after restart / chunk reload
    st.lastReseed = world.tick;
    for (const [k, e] of editIndex(world).tiles) if (world.isAlive(e) && (world.getField(e, TerrainEdit, "dig") ?? 0) < 0) st.frontier.add(k);
  }
  if (!st.frontier.size) return 0;
  const keys = [...st.frontier].sort((a, b) => a - b); st.frontier = new Set(); let n = 0;
  const flooded: [number, number][] = [];
  for (const k of keys) {
    const [x, y] = untkey(k);
    if (n >= TERRAIN.flowPerStep) { st.frontier.add(k); continue; }
    if (t.loaded && !t.loaded(x, y)) continue;
    const id = t.tileAt(x, y); if (id === 0 || isWaterId(id)) continue;
    if (terrainDigAt(world, x, y) >= 0 || blocked(world, x, y)) continue;
    const bed = raw(t, x, y);
    let src = false;
    for (const [dx, dy] of N4) { const s = waterSurfaceAt(t, x + dx, y + dy); if (s !== undefined && s >= bed) { src = true; break; } }
    if (!src) continue;
    flooded.push([x, y]); n++;
  }
  // apply after scanning so water advances exactly one tile per step (visible flow, order-independent)
  for (const [x, y] of flooded) { const bed = raw(t, x, y); t.setTile(x, y, WATER_TILE); t.setRawHeight(x, y, flowWaterRaw(bed)); for (const [dx, dy] of N4) st.frontier.add(tkey(x + dx, y + dy)); }
  return n;
}
export function terrainFlowSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return; // scheduled every TERRAIN.flowEveryTicks (install.ts)
  terrainFlowStep(world);
}

// ---- command ---------------------------------------------------------------------------------------------------------
/** dir: +1 raise, -1 lower. */
export const TerrainCmd = defineCommand("gameplay.terrain", { x: "i32", y: "i32", dir: "i8" });
export const TERRAIN_COMMANDS: readonly CommandDef[] = [TerrainCmd];
export function installTerrainCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(TerrainCmd, {
    validate: (v, c) => { const r = editTerrain(world, c.actor, v.x, v.y, v.dir, true); return r ? TERRAIN_FAIL_REASONS[r] : undefined; },
    handle: (v, c) => { const r = editTerrain(world, c.actor, v.x, v.y, v.dir); if (r) throw new Error(TERRAIN_FAIL_REASONS[r]); },
  });
}
