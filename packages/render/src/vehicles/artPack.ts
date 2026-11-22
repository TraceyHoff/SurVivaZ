/**
 * Binding of Art's vehicle sub-manifest (packages/assets/pack/vehicles/manifest.vehicles.json) to the gameplay vehicle
 * defs. Pure (no GL), so it is unit-tested against the shipped manifest.
 *
 * Art's layout is not the one docs/VEHICLES_RENDER.md asked for (see checkVehicleArt for the list), so the renderer
 * adapts instead of waiting on a re-export:
 *  - grouped atlases (veh_cars_0 ...) instead of one `veh_<id>` per def; sprites are looked up by Art key, not by atlas
 *  - gameplay id -> Art key through VEHICLE_ART_ALIASES (only a few ids match 1:1)
 *  - one whole-vehicle billboard (no footprint segments) drawn with Footprint depth
 *  - 8 directions are consecutive frames (dirStride 1) in Art order E,SE,S,...,NE, while the engine's row 0 is heading 0
 *    (world +x = screen down-right = Art "SE"): Art index = render row + 1, so the drawn facing is heading + PI/4
 *  - Art's footprintTiles are drawn at Art's own pixel scale (~0.3-0.5x the gameplay footprint): the sprite is scaled
 *    so its length matches the gameplay footprint (seats, headlights and depth use the gameplay footprint)
 * Defs with no Art (or whose atlas is missing) keep the procedural placeholder (buildVehicleDebugPack).
 */
import type { AssetRegistry } from "@engine/assets";
import type { VehicleRenderDef } from "./layout.js";

/** Gameplay vehicle id -> Art sprite key. Ids not listed use their own id when Art has that key. */
import { artScaleFor } from "./scale.js";
export const VEHICLE_ART_ALIASES: Readonly<Record<string, string>> = {
  camper_rv: "camper_motorhome", trailer_camper: "camper_trailer", semi_tractor: "truck_semi_cab",
  truck_pickup: "car_pickup", trailer_utility_small: "trailer_utility", trailer_flatbed_large: "trailer_flatbed",
  semi_trailer_flatbed: "trailer_flatbed", semi_trailer_box: "trailer_box", trailer_cargo_medium: "trailer_box",
  van_cargo: "van_delivery", van_passenger: "van_minivan", car_compact: "car_hatchback", car_muscle: "car_sports",
  car_offroad: "car_suv",
};
/** Art faces: index 0 = E (screen right). Engine heading 0 = world +x = screen SE -> one step. */
export const ART_DIR_OFFSET = 1;
export const ART_FACING_OFFSET = (ART_DIR_OFFSET * Math.PI) / 4;
/** Art interior pieces (building sprites, 1x1 tile, single rotation row). */
export const ART_INTERIOR = { floor: "camper_interior_floor", wall: "camper_interior_wall", stations: { craft_bench: "camper_craft_bench", cook_stove: "camper_cook_stove" } as Record<string, string> };

export const artKeyFor = (id: string): string => VEHICLE_ART_ALIASES[id] ?? id;

/** Per-key metadata from the sub-manifest's `vehicles` section (footprintTiles is what the scale fit needs). */
export interface VehicleArtMeta { key: string; atlas: string; footprintTiles: [number, number]; seats?: string[]; states?: string[]; /** "native" = drawn at true target size (VEHICLES_RENDER.md), no fit scale. */ scaleMode?: string; aliasOf?: string }
export type VehicleArtTable = ReadonlyMap<string, VehicleArtMeta>;
export function vehicleArtTable(m: { vehicles?: unknown }): Map<string, VehicleArtMeta> {
  const out = new Map<string, VehicleArtMeta>(); const v = m.vehicles;
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object) : [];
  for (const e of list as VehicleArtMeta[]) if (e && typeof e.key === "string") out.set(e.key, e);
  return out;
}

export interface VehicleArtBinding { mode: "art"; key: string; spriteId: number; facingOffset: number; scale: number; atlas: string }
/**
 * Art sprite for a def, or null (placeholder). The sprite must exist with an 8-direction first animation. Scale fits
 * Art's footprint length to the gameplay one (1 without meta); clamped to [0.5, 4].
 */
export function resolveVehicleArt(reg: AssetRegistry, def: VehicleRenderDef, meta?: VehicleArtTable): VehicleArtBinding | null {
  // exact doc id first (native-size art), then the legacy alias
  let key = def.id; let s, id: number;
  try { s = reg.byKey(key); id = reg.id(key); } catch { key = artKeyFor(def.id); try { s = reg.byKey(key); id = reg.id(key); } catch { return null; } }
  const a0 = s.animList[0]; if (!a0 || a0.directions !== 8) return null;
  // ADR-518: Art's sheets are authored at true real-world scale (30.29 px/m height, 45.25 px/m length; scale.ts), so
  // they always draw 1:1 - no fit scale, no stretch or squash, whatever the meta says
  void meta; const scale = artScaleFor(def, key);
  return { mode: "art", key, spriteId: id, facingOffset: ART_FACING_OFFSET, scale, atlas: s.atlas.key };
}

/** Atlas keys of Art's vehicle sheets (streamed per vehicle): `veh_*` atlases whose source is a file (placeholders are blob URLs). */
export function isVehicleArtAtlas(key: string, url: string): boolean { return /^veh_/.test(key) && !/^(blob|data):/.test(url); }

type SpriteJ = { key: string; category?: string; atlas: string; anchor?: { x: number; y: number }; animations?: Record<string, { frames: number[]; directions?: number; dirStride?: number }>; building?: { frames: number[][] } };
type AtlasJ = { key: string; image: string; frameW: number; frameH: number; columns: number; rows: number; pages?: { scale: number; image: string }[]; masks?: Record<string, unknown>; emissive?: unknown };
/**
 * Mismatches between Art's vehicle sub-manifest and docs/VEHICLES_RENDER.md + the gameplay defs (for Art; the renderer
 * adapts to each one). `defs` = gameplay vehicle defs.
 */
export function checkVehicleArt(m: { atlases: AtlasJ[]; sprites: SpriteJ[]; vehicles?: unknown }, defs: readonly VehicleRenderDef[]): string[] {
  const out: string[] = []; const meta = vehicleArtTable(m); const sk = new Set(m.sprites.map((s) => s.key));
  const grouped = m.atlases.filter((a) => /^veh_/.test(a.key) && !defs.some((d) => a.key === `veh_${d.id}`));
  if (grouped.length) out.push(`atlas layout: ${grouped.length} grouped atlases (${grouped.slice(0, 3).map((a) => a.key).join(", ")}...) instead of one veh_<id> per def`);
  const exact = defs.filter((d) => sk.has(d.id)).map((d) => d.id);
  const aliased = defs.filter((d) => !sk.has(d.id) && VEHICLE_ART_ALIASES[d.id] && sk.has(VEHICLE_ART_ALIASES[d.id]!)).map((d) => `${d.id}->${VEHICLE_ART_ALIASES[d.id]}`);
  const missing = defs.filter((d) => !sk.has(artKeyFor(d.id))).map((d) => d.id);
  out.push(`keys: ${exact.length}/${defs.length} gameplay ids match an Art key (${exact.join(", ")}); aliased ${aliased.length} (${aliased.join(", ")})`);
  if (missing.length) out.push(`no Art for ${missing.length} ids (placeholder kept): ${missing.join(", ")}`);
  const used = new Set(defs.map((d) => artKeyFor(d.id)));
  const orphan = [...meta.keys()].filter((k) => !used.has(k)); if (orphan.length) out.push(`Art vehicles with no gameplay def: ${orphan.join(", ")}`);
  const veh = m.sprites.filter((s) => meta.has(s.key));
  const cats = new Set(veh.map((s) => s.category ?? "?")); if (!cats.has("vehicle") || cats.size > 1) out.push(`category: ${[...cats].join("/")} (spec: "vehicle")`);
  const rowsLayout = veh.filter((s) => { const a = Object.values(s.animations ?? {})[0]; return a && a.directions === 8 && (a.dirStride ?? 1) === 1; });
  if (rowsLayout.length) out.push(`directions: ${rowsLayout.length} sprites use 8 consecutive frames (dirStride 1, Art order E,SE,...,NE) instead of rows; Art dir = render row + ${ART_DIR_OFFSET}`);
  if (!m.sprites.some((s) => /_s\d+(_int)?$/.test(s.key))) out.push("segments: no per-segment (_s<i>) or interior (_int) columns; long vehicles drawn as one billboard");
  for (const d of defs) {
    const k = artKeyFor(d.id); const e = meta.get(k); if (!e?.footprintTiles) continue;
    const r = e.footprintTiles[0] / d.footprint.length;
    if (r < 0.8 || r > 1.25) out.push(`scale: ${k} footprintTiles ${e.footprintTiles[0]}x${e.footprintTiles[1]} vs gameplay ${d.footprint.length}x${d.footprint.width} (x${r.toFixed(2)}); renderer scales the sprite x${(1 / r).toFixed(2)}`);
  }
  for (const s of veh) { const ay = s.anchor?.y ?? 1; if (ay < 0.5 || ay > 0.9) out.push(`pivot: ${s.key} anchor.y ${ay} (expected the ground centre, 0.5..0.9)`); }
  const emisInMasks = m.atlases.filter((a) => a.masks && "emissive" in a.masks).length; if (emisInMasks) out.push(`emissive: ${emisInMasks} atlases name the emissive page under masks.emissive (fine; loaded as emissiveImage)`);
  const big = m.atlases.filter((a) => (a.pages ?? []).some((p) => p.scale === 2) && Math.max(a.columns * a.frameW, a.rows * a.frameH) * 2 > 2048);
  if (big.length) out.push(`@2x pages over 2048 px (mobile layer cap): ${big.map((a) => a.key).join(", ")}`);
  const wall = m.sprites.find((s) => s.key === ART_INTERIOR.wall);
  if (wall && (wall.building?.frames?.length ?? 0) < 2) out.push(`interior: ${ART_INTERIOR.wall} has one rotation row (renderer mirrors it for the cross walls); a second wall orientation + a cutaway (low) wall frame would look better`);
  if (!m.sprites.some((s) => s.key.startsWith("camper_interior"))) out.push("interior: no camper_interior_* pieces");
  if (!m.atlases.some((a) => (a.pages ?? []).some((p) => /\.ktx2$|\.basis$/i.test(p.image)))) out.push("compression: no KTX2/Basis pages (PNG only)");
  return out;
}
