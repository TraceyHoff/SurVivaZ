/**
 * ADR-592 hydroponic tables (powered planters). A crop on a hydroponic table whose piece is powered and whose air
 * (sheltered temperature + nearby heat) sits inside power.json hydroponics.tempMinC..tempMaxC grows year round:
 * no season dormancy, no frost kill, no drought (the table waters it), no daylight rule (the table's grow light),
 * growth x growMul; fertilizer items in the table's tray auto-dose an unfertilized crop; the ripe node yields
 * x yieldMul. Unpowered or out of range it is an ordinary planter. Read once per crop pass (cheap: tables are few).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { AttachKind, BuildPiece, Dead, Power } from "../components.js";
import { gameplayDefs } from "../config.js";
import { resolveAttachment } from "../building/links.js";
import { readSlots, removeItem } from "../inventory.js";
import { heatAt, shelteredAirTemp } from "../systems/environment.js";
import { POWER } from "./data.js";

export const HYDRO = POWER.hydroponics;
export interface HydroTable { readonly e: Entity; readonly x: number; readonly y: number; readonly live: boolean }
/** Hydroponic tables this pass; `live` = powered and the air temperature is favourable. */
export function hydroTables(world: World): HydroTable[] {
  if (!world.isRegistered(Power)) return [];
  const defs = gameplayDefs(world); const out: HydroTable[] = [];
  for (const e of world.query([Power, BuildPiece, Transform])) {
    if (world.has(e, Dead)) continue;
    const key = defs.pieces.get(world.getField(e, BuildPiece, "type") ?? 0)?.key; if (!key || POWER.pieces[key]?.use !== "grow") continue;
    const x = world.getField(e, Transform, "x")!, y = world.getField(e, Transform, "y")!;
    let live = (world.getField(e, Power, "powered") ?? 0) !== 0;
    if (live) { const t = hydroTempC(world, x, y); live = t >= HYDRO.tempMinC && t <= HYDRO.tempMaxC; }
    out.push({ e, x, y, live });
  }
  return out;
}
/** Air temperature a hydroponic table's plants feel (C): sheltered air + heat emitters (heaters, powered walls, fires). */
export function hydroTempC(world: World, x: number, y: number): number { return shelteredAirTemp(world, x, y).temp + heatAt(world, x, y); }
/** The table a crop at x,y sits on (within the planter radius), if any. */
export function hydroTableAt(tables: readonly HydroTable[], x: number, y: number): HydroTable | undefined {
  for (const t of tables) if (Math.hypot(t.x - x, t.y - y) <= 1.1) return t;
  return undefined;
}
/** Take one fertilizer item from the table's tray (true = dosed). */
export function takeTrayFertilizer(world: World, table: Entity): boolean {
  const st = resolveAttachment(world, table, AttachKind.Storage); if (st === undefined) return false;
  const defs = gameplayDefs(world); const v = readSlots(world, st);
  for (let i = 0; i < v.slotCount; i++) { const it = v.item(i); const k = it && v.count(i) ? defs.items.get(it)?.key : undefined; if (k && k in HYDRO.fertilizerItems && removeItem(world, st, it, 1)) return true; }
  return false;
}
/** Crop spot offsets on a table (tiles from the piece centre) for a piece rotation: two spots along the long side. */
export function hydroSpots(rot: number): [number, number][] {
  const n = Math.max(1, HYDRO.spots); const along = (rot & 1) === 0 ? [1, 0] : [0, 1]; const out: [number, number][] = [];
  for (let i = 0; i < n; i++) { const o = n === 1 ? 0 : -0.5 + i / (n - 1); out.push([along[0]! * o + 0, along[1]! * o + 0]); }
  return out;
}
/** ADR-592: hydroponic plants resist disease (immunity factor 0..1) — the hook a future crop blight reads. */
export const hydroDiseaseResist = (): number => HYDRO.diseaseResist;
