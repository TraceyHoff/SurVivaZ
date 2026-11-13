/**
 * ADR-300 / ADR-301: seed-driven abandoned structures stamped from real base-building pieces.
 * Layout, furnishings, stations, disrepair, and searchable container loot are a pure function of (world seed, origin).
 * ADR-311: the top-story roof style (flat, eaves, gable, hip-ended gable, optional chimney) is picked per site from its
 * own seeded stream, so layouts, loot, and furnishing rolls are unchanged.
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, isWaterId, parseChunkKey, waterDepthAt, WaterDepth, type ChunkKey } from "@engine/world";
import { AbandonedSite, BuildPiece, PieceOwner, PieceSlot, ResourceNode, Tribe } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { BuildFail } from "../events.js";
import { addItem } from "../inventory.js";
import { indexEntity } from "../spawn.js";
import { TerrainRes, addChunkLoadHook } from "../world.js";
import { AttachKind } from "../components.js";
import { resolveAttachment, unlinkPiece } from "./links.js";
import { structures, unmarkLinked } from "./structure.js";
import { damageStageFor, maxHpOf } from "./integrity.js";
import { hasOwnClaim, placePiece, snapPlacement, tribeOf, validatePlacement } from "./place.js";
import { exteriorStairsFor, STAIRS_DATA } from "./stairs.js";
import { ABANDONED_DATA } from "./abandoned_data.js";

/**
 * ADR-373: density raised 0.12 -> 0.15 per chunk (+25%): a chunk is 32x32 = 1024 tiles, so
 * expected sites go 12 -> 15 per 100 chunks, 12 -> 15 per 10x10-chunk region (320x320 tiles),
 * ~117 -> ~146 per 1M tiles (~977 chunks) — before terrain / near-spawn / busy skips, which only
 * lower the realised count. Stamping stays chunk-load-time only, O(site footprint) per site.
 */
export const SITE_CHANCE = 0.15;
export const ABANDONED_SCAN_RADIUS = 24;

export const AbandonedKind = {
  Shed: 0,
  Cottage: 1,
  Homestead: 2,
  Farmhouse: 3,
  Workshop: 4,
  Cabin: 5,
  Barn: 6,
  HunterShack: 7,
  LargeHomestead: 8,
  TwoStoryCottage: 9,
  TwoStoryFarmhouse: 10,
  TwoStoryHomestead: 11,
  Townhouse: 12,
  Manor: 13,
  // ADR-373: fourteen more kinds, all built from the same pieces / helpers as the old ones.
  Mill: 14,
  Schoolhouse: 15,
  Chapel: 16,
  TradingPost: 17,
  Smithy: 18,
  Bakery: 19,
  Stable: 20,
  Watchtower: 21,
  Bathhouse: 22,
  Inn: 23,
  Apiary: 24,
  Granary: 25,
  FisherHut: 26,
  Barracks: 27,
} as const;
export type AbandonedKindId = (typeof AbandonedKind)[keyof typeof AbandonedKind];

export const ABANDONED_KIND_KEYS: readonly string[] = [
  "shed", "cottage", "homestead", "farmhouse", "workshop", "cabin", "barn", "hunter_shack",
  "large_homestead", "two_story_cottage", "two_story_farmhouse", "two_story_homestead", "townhouse", "manor",
  "mill", "schoolhouse", "chapel", "trading_post", "smithy", "bakery", "stable", "watchtower",
  "bathhouse", "inn", "apiary", "granary", "fisher_hut", "barracks",
];

// ADR-373: the fourteen old weights are unchanged (they summed to 100); the new kinds add 46,
// so the catalogue total is 146 and every old kind keeps its relative order — each old kind's
// share of sites is scaled by 100/146, the new kinds together take 46/146 (~31%).
export const KIND_WEIGHTS: readonly { kind: AbandonedKindId; w: number }[] = [
  { kind: AbandonedKind.Shed, w: 12 },
  { kind: AbandonedKind.Cottage, w: 12 },
  { kind: AbandonedKind.Homestead, w: 11 },
  { kind: AbandonedKind.Farmhouse, w: 8 },
  { kind: AbandonedKind.Workshop, w: 8 },
  { kind: AbandonedKind.Cabin, w: 8 },
  { kind: AbandonedKind.Barn, w: 7 },
  { kind: AbandonedKind.HunterShack, w: 6 },
  { kind: AbandonedKind.LargeHomestead, w: 6 },
  { kind: AbandonedKind.TwoStoryCottage, w: 7 },
  { kind: AbandonedKind.TwoStoryFarmhouse, w: 5 },
  { kind: AbandonedKind.TwoStoryHomestead, w: 5 },
  { kind: AbandonedKind.Townhouse, w: 3 },
  { kind: AbandonedKind.Manor, w: 2 },
  { kind: AbandonedKind.Mill, w: 4 },
  { kind: AbandonedKind.Schoolhouse, w: 3 },
  { kind: AbandonedKind.Chapel, w: 3 },
  { kind: AbandonedKind.TradingPost, w: 4 },
  { kind: AbandonedKind.Smithy, w: 4 },
  { kind: AbandonedKind.Bakery, w: 4 },
  { kind: AbandonedKind.Stable, w: 4 },
  { kind: AbandonedKind.Watchtower, w: 2 },
  { kind: AbandonedKind.Bathhouse, w: 2 },
  { kind: AbandonedKind.Inn, w: 3 },
  { kind: AbandonedKind.Apiary, w: 3 },
  { kind: AbandonedKind.Granary, w: 4 },
  { kind: AbandonedKind.FisherHut, w: 3 },
  { kind: AbandonedKind.Barracks, w: 3 },
];

type Role = "deck" | "wall" | "opening" | "stair" | "furniture" | "fence" | "garden" | "loot" | "roof";
interface Spec { key: string; x: number; y: number; level: number; rot: number; role: Role; /** ADR-372: outside stair run (vs the interior flight). */ exterior?: boolean }

/**
 * ADR-311 roof styles built from the existing roof pieces (all have tier 1-4 art):
 * Flat = `roof_flat`; Eaves = `roof_corner` at corners, `roof_slope` along each edge (eave outward), flat centre;
 * Gable = rows of `roof_gable` ridges along the long axis; HipGable = the same rows with `roof_hip` caps at both ends.
 * Flat and Eaves roofs over a hearth may swap one centre tile for `roof_chimney`.
 */
export const RoofStyle = { Flat: 0, Eaves: 1, Gable: 2, HipGable: 3 } as const;
export type RoofStyleId = (typeof RoofStyle)[keyof typeof RoofStyle];
export const ROOF_STYLE_KEYS: readonly string[] = ["flat", "eaves", "gable", "hip_gable"];

export interface PlannedPiece {
  key: string; x: number; y: number; level: number; rot: number; role: Role;
  tier: number; omit: boolean; hpFrac: number;
  /** ADR-372: outside stair run (vs the interior flight). */
  exterior?: boolean;
}
export interface PlannedSite {
  kind: AbandonedKindId; kindKey: string; originX: number; originY: number;
  width: number; height: number; stories: number; rot: number; ruin: number; tier: number;
  garden: boolean; pen: boolean; pieces: PlannedPiece[];
  /** ADR-311 */ roofStyle: RoofStyleId; chimney: boolean;
}
export interface StampResult {
  marker: Entity | 0; placed: Entity[]; omitted: number; skipped: boolean;
  kind: AbandonedKindId; stories: number; garden: boolean; pen: boolean;
  /**
   * ADR-382: true while pieces are still queued for the time-sliced stamp. The result is a live
   * handle: `placed` grows and `marker` is set as the pump finishes the site (see
   * pumpAbandonedStamps / drainAbandonedStamps). Callers that need the finished site — tests,
   * reclaim flows — must drain or step the world first. `pending` is false for skipped stamps.
   */
  pending: boolean;
}

const PHASE: Record<Role, number> = { deck: 0, wall: 1, opening: 2, stair: 3, furniture: 4, loot: 4, fence: 4, garden: 4, roof: 5 };

export function hashU32(seed: number, a: number, b = 0, c = 0): number {
  let h = (seed ^ Math.imul(a, 0x9e3779b9) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function pickKind(rand: () => number): AbandonedKindId {
  let t = 0; for (const k of KIND_WEIGHTS) t += k.w;
  let r = rand() * t;
  for (const k of KIND_WEIGHTS) { r -= k.w; if (r <= 0) return k.kind; }
  return AbandonedKind.Cottage;
}

function rotPoint(x: number, y: number, rot: number, bw: number, bh: number): [number, number] {
  switch (rot & 3) {
    case 1: return [bh - y, x];
    case 2: return [bw - x, bh - y];
    case 3: return [y, bw - x];
    default: return [x, y];
  }
}

function foundations(out: Spec[], x0: number, y0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ key: "foundation", x: x0 + x + 0.5, y: y0 + y + 0.5, level: 0, rot: 0, role: "deck" });
}
function floors(out: Spec[], x0: number, y0: number, w: number, h: number, level: number, sx: number, sy: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const stair = x === sx && y === sy;
    out.push({ key: stair ? "floor_stairwell" : "floor", x: x0 + x + 0.5, y: y0 + y + 0.5, level, rot: 0, role: "deck" });
  }
}
function roofs(out: Spec[], x0: number, y0: number, w: number, h: number, level: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ key: "roof_flat", x: x0 + x + 0.5, y: y0 + y + 0.5, level, rot: 0, role: "roof" });
}
function edgeAim(side: string, i: number, x0: number, y0: number, w: number, h: number): { x: number; y: number } {
  if (side === "n") return { x: x0 + i + 0.5, y: y0 };
  if (side === "s") return { x: x0 + i + 0.5, y: y0 + h };
  if (side === "w") return { x: x0, y: y0 + i + 0.5 };
  return { x: x0 + w, y: y0 + i + 0.5 };
}
function walls(out: Spec[], x0: number, y0: number, w: number, h: number, level: number, doorSide: string, windows: readonly { side: string; i: number }[], withDoor: boolean, doorI?: number): void {
  // ADR-211: outer foundation corners take an L (`wall_corner_outer`), not a straight wall.
  out.push({ key: "wall_corner_outer", x: x0, y: y0, level, rot: 0, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0 + w, y: y0, level, rot: 1, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0 + w, y: y0 + h, level, rot: 2, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0, y: y0 + h, level, rot: 3, role: "wall" });
  const doorIdx = doorI ?? Math.floor(((doorSide === "n" || doorSide === "s") ? w : h) / 2);
  for (const side of ["n", "s", "e", "w"]) {
    const n = (side === "n" || side === "s") ? w : h;
    for (let i = 1; i < n - 1; i++) {
      const p = edgeAim(side, i, x0, y0, w, h);
      const isDoor = withDoor && side === doorSide && i === doorIdx;
      const isWin = windows.some((v) => v.side === side && v.i === i);
      out.push({ key: isDoor ? "wall_doorway" : isWin ? "wall_window" : "wall", x: p.x, y: p.y, level, rot: 0, role: "wall" });
      if (isDoor) out.push({ key: "door_wood", x: p.x, y: p.y, level, rot: 0, role: "opening" });
      if (isWin) out.push({ key: "window_shutters", x: p.x, y: p.y, level, rot: 0, role: "opening" });
    }
  }
}
function furnished(out: Spec[], items: readonly { key: string; x: number; y: number; level?: number; rot?: number; role?: Role }[]): void {
  for (const it of items) out.push({ key: it.key, x: it.x, y: it.y, level: it.level ?? 0, rot: it.rot ?? 0, role: it.role ?? (it.key.includes("storage") || it.key.includes("chest") || it.key === "barrel_storage" || it.key.includes("wardrobe") ? "loot" : "furniture") });
}
function fenceRect(out: Spec[], x0: number, y0: number, w: number, h: number, key: string, gateSide: string): void {
  for (let x = 0; x < w; x++) {
    const gn = gateSide === "n" && x === (w >> 1);
    const gs = gateSide === "s" && x === (w >> 1);
    out.push({ key: gn ? "garden_gate" : key, x: x0 + x + 0.5, y: y0 + 0.15, level: 0, rot: 0, role: "fence" });
    out.push({ key: gs ? "garden_gate" : key, x: x0 + x + 0.5, y: y0 + h - 0.15, level: 0, rot: 0, role: "fence" });
  }
  for (let y = 1; y < h - 1; y++) {
    const gw = gateSide === "w" && y === (h >> 1);
    const ge = gateSide === "e" && y === (h >> 1);
    out.push({ key: gw ? "garden_gate" : key, x: x0 + 0.15, y: y0 + y + 0.5, level: 0, rot: 1, role: "fence" });
    out.push({ key: ge ? "garden_gate" : key, x: x0 + w - 0.15, y: y0 + y + 0.5, level: 0, rot: 1, role: "fence" });
  }
}

interface Built { w: number; h: number; stories: number; garden: boolean; pen: boolean; pieces: Spec[] }

function house(x0: number, y0: number, w: number, h: number, stories: number, furn: readonly { key: string; x: number; y: number; level?: number; rot?: number; role?: Role }[], extraWindows?: boolean, exteriorStairs = false): Spec[] {
  const out: Spec[] = [];
  foundations(out, x0, y0, w, h);
  const win = extraWindows
    ? [{ side: "n", i: 1 }, { side: "n", i: w - 2 }, { side: "e", i: 1 }, { side: "w", i: 1 }, ...(h > 3 ? [{ side: "e", i: h - 2 }, { side: "w", i: h - 2 }] : [])]
    : [{ side: "n", i: Math.max(1, w >> 1) }, { side: "e", i: Math.max(1, h >> 1) }];
  walls(out, x0, y0, w, h, 0, "s", win, true);
  const sx = 1, sy = h - 2;
  // ADR-372: the outside stair run sits one tile west of the ground-floor door (its pillar would block the
  // doorway if it shared the door's x), climbs north onto a level-1 balcony, and enters through a level-1
  // doorway in the south wall above a plain ground-floor wall segment.
  const ex = Math.floor(w / 2) - 1;
  if (stories >= 2) {
    out.push({ key: "stairs", x: x0 + sx + 0.5, y: y0 + sy + 0.5, level: 0, rot: 0, role: "stair" });
    floors(out, x0, y0, w, h, 1, sx, sy);
    walls(out, x0, y0, w, h, 1, "s", [{ side: "n", i: w >> 1 }, { side: "e", i: h >> 1 }], exteriorStairs, exteriorStairs ? ex : undefined);
  }
  if (stories >= 3) {
    // ADR-372: the second flight sits on the tile EAST of the first flight, not on top of it — two flights
    // on one tile share one ramp line, so the upper one would shadow the way back down (see stairs.ts).
    // Its stairwell hole is the level-2 floor tile above it.
    out.push({ key: "stairs", x: x0 + sx + 1 + 0.5, y: y0 + sy + 0.5, level: 1, rot: 0, role: "stair" });
    floors(out, x0, y0, w, h, 2, sx + 1, sy);
    walls(out, x0, y0, w, h, 2, "s", [{ side: "n", i: w >> 1 }], false);
  }
  if (exteriorStairs && stories >= 2) {
    // Balcony tile B (ex, h) + stair tile A (ex, h+1), south of the house in local coords; the site height
    // grows by 2 rows for these (see buildKind). The pillar carries the balcony floor; the stairs climb
    // north (rot 0, upDir [0,-1]) from A onto B.
    out.push({ key: "foundation", x: x0 + ex + 0.5, y: y0 + h + 0.5, level: 0, rot: 0, role: "deck" });
    out.push({ key: "foundation", x: x0 + ex + 0.5, y: y0 + h + 1 + 0.5, level: 0, rot: 0, role: "deck" });
    out.push({ key: "pillar", x: x0 + ex + 0.5, y: y0 + h + 0.5, level: 0, rot: 0, role: "wall" });
    out.push({ key: "floor", x: x0 + ex + 0.5, y: y0 + h + 0.5, level: 1, rot: 0, role: "deck" });
    out.push({ key: "stairs", x: x0 + ex + 0.5, y: y0 + h + 1 + 0.5, level: 0, rot: 0, role: "stair", exterior: true });
  }
  roofs(out, x0, y0, w, h, stories);
  furnished(out, furn);
  return out;
}

function yard(out: Spec[], x0: number, y0: number, w: number, h: number, kind: "garden" | "pen"): void {
  fenceRect(out, x0, y0, w, h, kind === "pen" ? "fence_rail" : "fence_picket", kind === "pen" ? "n" : "w");
  if (kind === "garden") {
    out.push({ key: "garden_bed", x: x0 + 1.5, y: y0 + 1.5, level: 0, rot: 0, role: "garden" });
    if (w >= 4 && h >= 3) out.push({ key: "garden_bed", x: x0 + 1.5, y: y0 + 2.6, level: 0, rot: 0, role: "garden" });
    if (w >= 5) out.push({ key: "flower_bed", x: x0 + 3.5, y: y0 + 1.5, level: 0, rot: 0, role: "garden" });
  } else {
    out.push({ key: "feeding_trough", x: x0 + 1.5, y: y0 + 1.5, level: 0, rot: 0, role: "furniture" });
  }
}

function buildKind(kind: AbandonedKindId): Built {
  const p: Spec[] = [];
  if (kind === AbandonedKind.Shed) {
    p.push(...house(0, 0, 3, 3, 1, [
      { key: "basic_storage_box", x: 1.5, y: 1.5 }, { key: "barrel_storage", x: 0.5, y: 1.5 },
    ]));
    return { w: 3, h: 3, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.HunterShack) {
    p.push(...house(0, 0, 3, 4, 1, [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "basic_storage_box", x: 0.5, y: 2.5 }, { key: "campfire", x: 3.5, y: 4.5, role: "furniture" },
    ]));
    return { w: 4, h: 5, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Cabin) {
    p.push(...house(0, 0, 4, 4, 1, [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 3.5, y: 2.5 },
      { key: "basic_storage_box", x: 1.5, y: 2.5 }, { key: "floor_lamp", x: 3.5, y: 1.5 },
    ]));
    return { w: 4, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Workshop) {
    p.push(...house(0, 0, 5, 4, 1, [
      { key: "workbench", x: 1.5, y: 1.5 }, { key: "storage_box", x: 3.5, y: 1.5 }, { key: "barrel_storage", x: 3.5, y: 2.5 },
      { key: "chair", x: 1.5, y: 2.5 }, { key: "table_lamp", x: 2.5, y: 1.5 },
    ]));
    return { w: 5, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Cottage || kind === AbandonedKind.TwoStoryCottage) {
    const stories = kind === AbandonedKind.TwoStoryCottage ? 2 : 1;
    const ext = stories >= 2 && exteriorStairsFor("two_story_cottage");
    const furn = [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table", x: 3.5, y: 2.5 }, { key: "chair", x: 3.5, y: 1.5 }, { key: "chair", x: 2.5, y: 2.5 },
      { key: "storage_box", x: 3.5, y: 3.5 }, { key: "wardrobe_rustic", x: 2.5, y: 3.5 }, { key: "floor_lamp", x: 4.5, y: 1.5 },
      { key: "fireplace", x: 2.5, y: 0.5 },
      ...(stories >= 2 ? [{ key: "bed", x: 3.5, y: 1.5, level: 1 }, { key: "chair", x: 1.5, y: 1.5, level: 1 }, { key: "basic_storage_box", x: 3.5, y: 3.5, level: 1 }] : []),
    ];
    p.push(...house(0, 0, 5, 5, stories, furn, true, ext));
    return { w: 5, h: ext ? 7 : 5, stories, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Farmhouse || kind === AbandonedKind.TwoStoryFarmhouse) {
    const stories = kind === AbandonedKind.TwoStoryFarmhouse ? 2 : 1;
    const ext = stories >= 2 && exteriorStairsFor("two_story_farmhouse");
    const furn = [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table_dining_rustic", x: 3.5, y: 2.5 }, { key: "chair_rustic", x: 2.5, y: 2.5 },
      { key: "chair_rustic", x: 4.5, y: 2.5 }, { key: "large_chest", x: 5.5, y: 1.5 }, { key: "wardrobe_rustic", x: 1.5, y: 4.5 },
      { key: "fireplace", x: 3.5, y: 0.5 }, { key: "floor_lamp", x: 6.5, y: 1.5 },
      ...(stories >= 2 ? [{ key: "bed_double_rustic", x: 2.5, y: 1.5, level: 1 }, { key: "wardrobe_rustic", x: 5.5, y: 1.5, level: 1 }] : []),
    ];
    p.push(...house(0, 0, 7, 5, stories, furn, true, ext));
    return { w: 7, h: ext ? 7 : 5, stories, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Barn) {
    p.push(...house(0, 0, 6, 4, 1, [
      { key: "feeding_trough", x: 1.5, y: 1.5 }, { key: "barrel_storage", x: 4.5, y: 1.5 }, { key: "storage_box", x: 4.5, y: 2.5 }, { key: "hay".replace("hay", "barrel_storage"), x: 1.5, y: 2.5 },
    ]));
    yard(p, 0, 5, 6, 4, "pen");
    return { w: 6, h: 9, stories: 1, garden: false, pen: true, pieces: p };
  }
  const homestead = kind === AbandonedKind.Homestead || kind === AbandonedKind.TwoStoryHomestead || kind === AbandonedKind.LargeHomestead || kind === AbandonedKind.Manor;
  if (homestead) {
    const large = kind === AbandonedKind.LargeHomestead || kind === AbandonedKind.Manor;
    const stories = kind === AbandonedKind.TwoStoryHomestead || kind === AbandonedKind.Manor ? 2 : 1;
    const hw = large ? 7 : 5, hh = large ? 6 : 5;
    const furn = [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table", x: 3.5, y: 2.5 }, { key: "chair", x: 2.5, y: 2.5 }, { key: "chair", x: 3.5, y: 1.5 },
      { key: "storage_box", x: hw - 1.5, y: hh - 1.5 }, { key: "wardrobe_rustic", x: 2.5, y: hh - 1.5 }, { key: "fireplace", x: 2.5, y: 0.5 },
      ...(stories >= 2 ? [{ key: "bed", x: 3.5, y: 1.5, level: 1 }, { key: "basic_storage_box", x: hw - 1.5, y: 1.5, level: 1 }] : []),
    ];
    p.push(...house(0, 0, hw, hh, stories, furn, true));
    const gw = large ? 5 : 4, gh = large ? 4 : 3;
    yard(p, hw + 1, 0, gw, gh, "garden");
    const pw = large ? 5 : 4, ph = large ? 4 : 3;
    yard(p, 0, hh + 1, pw, ph, "pen");
    return { w: hw + 1 + gw, h: hh + 1 + ph, stories, garden: true, pen: true, pieces: p };
  }
  if (kind === AbandonedKind.Townhouse) {
    const ext = exteriorStairsFor("townhouse");
    const furn = [
      { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 1.5, y: 2.5 }, { key: "storage_box", x: 3.5, y: 3.5 }, { key: "fireplace", x: 2.5, y: 0.5 },
      { key: "bed", x: 1.5, y: 1.5, level: 1 }, { key: "wardrobe_rustic", x: 3.5, y: 1.5, level: 1 },
      { key: "bed", x: 2.5, y: 1.5, level: 2 }, { key: "basic_storage_box", x: 3.5, y: 3.5, level: 2 },
    ];
    p.push(...house(0, 0, 4, 5, 3, furn, true, ext));
    return { w: 4, h: ext ? 7 : 5, stories: 3, garden: false, pen: false, pieces: p };
  }
  // ADR-373: fourteen more kinds, all composed from the existing house()/yard()/furnished()
  // helpers and piece keys already in pieces.json — no new art, no new helpers. Footprints stay
  // well inside the chunk (planAbandonedChunk needs w+4 <= 32 and h+4 <= 32); the largest new
  // kind is the Stable at 6x9, same shape as the Barn.
  if (kind === AbandonedKind.Mill) {
    p.push(...house(0, 0, 6, 5, 1, [
      { key: "workbench", x: 1.5, y: 1.5 }, { key: "crop_store", x: 4.5, y: 1.5 }, { key: "stone_store", x: 4.5, y: 2.5 },
      { key: "storage_box", x: 1.5, y: 3.5 }, { key: "barrel_storage", x: 3.5, y: 1.5 },
      { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 3.5, y: 2.5 },
    ]));
    return { w: 6, h: 5, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Schoolhouse) {
    p.push(...house(0, 0, 6, 4, 1, [
      { key: "desk_rustic", x: 1.5, y: 1.5 }, { key: "desk_rustic", x: 3.5, y: 1.5 },
      { key: "bench_rustic", x: 1.5, y: 2.5 }, { key: "bench_rustic", x: 3.5, y: 2.5 },
      { key: "bookcase_rustic", x: 5.5, y: 1.5 }, { key: "chair", x: 2.5, y: 3.5 }, { key: "table_lamp", x: 4.5, y: 3.5 },
    ]));
    return { w: 6, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Chapel) {
    p.push(...house(0, 0, 5, 6, 1, [
      { key: "bench_rustic", x: 1.5, y: 1.5 }, { key: "bench_rustic", x: 3.5, y: 1.5 },
      { key: "bench_rustic", x: 1.5, y: 2.5 }, { key: "bench_rustic", x: 3.5, y: 2.5 },
      { key: "table", x: 2.5, y: 4.5 }, { key: "statue", x: 4.5, y: 5.5 }, { key: "storage_box", x: 1.5, y: 5.5 },
    ]));
    return { w: 5, h: 6, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.TradingPost) {
    // NOTE: market_counter is NOT used here — it carries stall.clanOnly, and validatePlacement
    // rejects stall pieces with clanOnly for the worldgen builder (NoPrivilege), so it could
    // never stamp. counter_rustic is the same shop-counter shape without stall land rules.
    p.push(...house(0, 0, 6, 5, 1, [
      { key: "counter_rustic", x: 1.5, y: 1.5 }, { key: "shelf_rustic", x: 4.5, y: 1.5 },
      { key: "stall_booth", x: 4.5, y: 3.5 }, { key: "storage_box", x: 1.5, y: 3.5 },
      { key: "large_chest", x: 2.5, y: 4.5 }, { key: "barrel_storage", x: 5.5, y: 2.5 },
      { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 3.5, y: 2.5 },
    ]));
    return { w: 6, h: 5, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Smithy) {
    p.push(...house(0, 0, 5, 4, 1, [
      { key: "anvil", x: 1.5, y: 1.5 }, { key: "furnace", x: 3.5, y: 1.5 },
      { key: "workbench", x: 1.5, y: 2.5 }, { key: "tool_bench", x: 3.5, y: 2.5 },
      { key: "barrel_storage", x: 4.5, y: 2.5 }, { key: "storage_box", x: 1.5, y: 3.5 },
    ]));
    return { w: 5, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Bakery) {
    p.push(...house(0, 0, 5, 4, 1, [
      { key: "clay_oven", x: 1.5, y: 1.5 }, { key: "cook_range", x: 3.5, y: 1.5 },
      { key: "pantry", x: 4.5, y: 2.5 }, { key: "kitchen_cupboard", x: 1.5, y: 2.5 },
      { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 3.5, y: 2.5 }, { key: "storage_box", x: 4.5, y: 1.5 },
    ]));
    return { w: 5, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Stable) {
    p.push(...house(0, 0, 6, 4, 1, [
      { key: "feeding_trough", x: 1.5, y: 1.5 }, { key: "feeding_trough", x: 4.5, y: 1.5 },
      { key: "barrel_storage", x: 1.5, y: 2.5 }, { key: "log_store", x: 4.5, y: 2.5 }, { key: "storage_box", x: 2.5, y: 3.5 },
    ]));
    yard(p, 0, 5, 6, 4, "pen");
    return { w: 6, h: 9, stories: 1, garden: false, pen: true, pieces: p };
  }
  if (kind === AbandonedKind.Watchtower) {
    p.push(...house(0, 0, 3, 3, 1, [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "basic_storage_box", x: 0.5, y: 2.5 }, { key: "table", x: 2.5, y: 2.5 },
    ]));
    // The watchtower piece is ground-placed (2x2, free/layer 1), so it stands on bare ground
    // beside the hut like the HunterShack's outside campfire — no foundation pad needed.
    p.push({ key: "watchtower", x: 4.5, y: 1.5, level: 0, rot: 0, role: "furniture" });
    return { w: 6, h: 3, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Bathhouse) {
    p.push(...house(0, 0, 5, 5, 1, [
      { key: "fountain", x: 2.5, y: 2.5 }, { key: "bench_rustic", x: 1.5, y: 4.5 }, { key: "bench_rustic", x: 4.5, y: 0.5 },
      { key: "table", x: 3.5, y: 4.5 }, { key: "potted_plant", x: 4.5, y: 3.5 }, { key: "storage_box", x: 4.5, y: 2.5 },
    ]));
    yard(p, 6, 0, 3, 3, "garden");
    return { w: 9, h: 5, stories: 1, garden: true, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Inn) {
    const furn = [
      { key: "table_dining_rustic", x: 3.5, y: 2.5 }, { key: "chair_rustic", x: 2.5, y: 2.5 }, { key: "chair_rustic", x: 4.5, y: 2.5 },
      { key: "counter_rustic", x: 4.5, y: 1.5 }, { key: "cook_range", x: 1.5, y: 1.5 }, { key: "fireplace", x: 3.5, y: 0.5 },
      { key: "barrel_storage", x: 5.5, y: 3.5 },
      { key: "bed", x: 1.5, y: 1.5, level: 1 }, { key: "bed", x: 4.5, y: 1.5, level: 1 },
      { key: "wardrobe_rustic", x: 1.5, y: 3.5, level: 1 }, { key: "basic_storage_box", x: 4.5, y: 3.5, level: 1 },
    ];
    p.push(...house(0, 0, 6, 5, 2, furn, true));
    return { w: 6, h: 5, stories: 2, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Apiary) {
    p.push(...house(0, 0, 3, 3, 1, [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "barrel_storage", x: 0.5, y: 2.5 }, { key: "basic_storage_box", x: 2.5, y: 2.5 },
    ]));
    yard(p, 4, 0, 5, 3, "garden");
    // Apiaries are ground-placed (free/layer 2) inside the fenced garden, clear of the beds.
    p.push({ key: "apiary", x: 8.5, y: 1.5, level: 0, rot: 0, role: "furniture" });
    p.push({ key: "apiary", x: 8.5, y: 2.5, level: 0, rot: 0, role: "furniture" });
    return { w: 9, h: 3, stories: 1, garden: true, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Granary) {
    p.push(...house(0, 0, 5, 4, 1, [
      { key: "crop_store", x: 1.5, y: 1.5 }, { key: "ore_store", x: 3.5, y: 1.5 },
      { key: "log_store", x: 1.5, y: 2.5 }, { key: "stick_store", x: 3.5, y: 2.5 },
      { key: "large_chest", x: 4.5, y: 1.5 }, { key: "storage_box", x: 4.5, y: 2.5 }, { key: "barrel_storage", x: 2.5, y: 3.5 },
    ]));
    return { w: 5, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.FisherHut) {
    p.push(...house(0, 0, 3, 4, 1, [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "basket", x: 0.5, y: 2.5 }, { key: "barrel_storage", x: 2.5, y: 2.5 },
      { key: "campfire", x: 3.5, y: 4.5, role: "furniture" },
    ]));
    return { w: 4, h: 5, stories: 1, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Barracks) {
    p.push(...house(0, 0, 6, 4, 1, [
      { key: "bunk_bed", x: 1.5, y: 1.5 }, { key: "bunk_bed", x: 3.5, y: 1.5 }, { key: "bed", x: 5.5, y: 1.5 },
      { key: "table", x: 2.5, y: 3.5 }, { key: "chair", x: 1.5, y: 3.5 }, { key: "chair", x: 3.5, y: 3.5 },
      { key: "large_chest", x: 5.5, y: 3.5 }, { key: "storage_box", x: 4.5, y: 3.5 },
    ]));
    return { w: 6, h: 4, stories: 1, garden: false, pen: false, pieces: p };
  }
  return buildKind(AbandonedKind.Cottage);
}

function rotateBuilt(b: Built, rot: number): Built {
  if ((rot & 3) === 0) return b;
  const bw = b.w, bh = b.h;
  const pieces = b.pieces.map((s) => {
    const [x, y] = rotPoint(s.x, s.y, rot, bw, bh);
    // ADR-372: stairs keep their rotation (their up-direction rotates with the site, like furniture) —
    // a rotated site's stair run must still climb toward its landing.
    const keep = s.role === "furniture" || s.role === "loot" || s.role === "fence" || s.role === "garden" || s.role === "roof" || s.role === "stair" || s.key === "wall_corner_outer";
    return { ...s, x, y, rot: keep ? (s.rot + rot) & 3 : 0 };
  });
  const w = (rot & 1) ? bh : bw, h = (rot & 1) ? bw : bh;
  return { ...b, w, h, pieces };
}

const STONE_KINDS = new Set<number>([
  AbandonedKind.Cottage, AbandonedKind.Farmhouse, AbandonedKind.TwoStoryCottage, AbandonedKind.TwoStoryFarmhouse,
  AbandonedKind.Townhouse, AbandonedKind.Manor, AbandonedKind.LargeHomestead,
  // ADR-373: the solid public buildings read as stone too.
  AbandonedKind.Chapel, AbandonedKind.Inn, AbandonedKind.TradingPost,
]);

function extrasFor(kind: AbandonedKindId): readonly { key: string; x: number; y: number; level?: number; chance: number }[] {
  if (kind === AbandonedKind.Shed) return [{ key: "workbench", x: 1.5, y: 0.5, chance: 0.28 }];
  if (kind === AbandonedKind.HunterShack) return [{ key: "workbench", x: 1.5, y: 2.5, chance: 0.22 }, { key: "basic_storage_box", x: 2.5, y: 1.5, chance: 0.4 }];
  if (kind === AbandonedKind.Cabin) return [{ key: "wood_stove", x: 0.5, y: 2.5, chance: 0.45 }, { key: "workbench", x: 2.5, y: 0.5, chance: 0.22 }];
  if (kind === AbandonedKind.Workshop) return [{ key: "anvil", x: 0.5, y: 2.5, chance: 0.55 }, { key: "furnace", x: 4.5, y: 2.5, chance: 0.4 }];
  if (kind === AbandonedKind.Cottage || kind === AbandonedKind.TwoStoryCottage) {
    return [
      { key: "wood_stove", x: 4.5, y: 3.5, chance: 0.38 }, { key: "workbench", x: 0.5, y: 2.5, chance: 0.22 },
      ...(kind === AbandonedKind.TwoStoryCottage ? [{ key: "table_lamp", x: 4.5, y: 2.5, level: 1, chance: 0.5 }, { key: "chair", x: 2.5, y: 3.5, level: 1, chance: 0.45 }] : []),
    ];
  }
  if (kind === AbandonedKind.Farmhouse || kind === AbandonedKind.TwoStoryFarmhouse) {
    return [
      { key: "cook_range", x: 5.5, y: 3.5, chance: 0.42 }, { key: "stove_iron", x: 0.5, y: 3.5, chance: 0.3 },
      { key: "workbench", x: 5.5, y: 4.5, chance: 0.22 }, { key: "salt_barrel", x: 0.5, y: 4.5, chance: 0.4 },
    ];
  }
  if (kind === AbandonedKind.Barn) return [{ key: "workbench", x: 2.5, y: 2.5, chance: 0.25 }, { key: "salt_barrel", x: 3.5, y: 1.5, chance: 0.35 }];
  if (kind === AbandonedKind.Homestead || kind === AbandonedKind.TwoStoryHomestead) {
    return [{ key: "wood_stove", x: 4.5, y: 3.5, chance: 0.4 }, { key: "workbench", x: 0.5, y: 2.5, chance: 0.25 }, { key: "well", x: 5.5, y: 5.5, chance: 0.38 }];
  }
  if (kind === AbandonedKind.LargeHomestead || kind === AbandonedKind.Manor) {
    return [
      { key: "cook_range", x: 5.5, y: 3.5, chance: 0.5 }, { key: "workbench", x: 0.5, y: 3.5, chance: 0.28 },
      { key: "anvil", x: 6.5, y: 4.5, chance: 0.18 }, { key: "well", x: 7.5, y: 6.5, chance: 0.4 }, { key: "salt_barrel", x: 5.5, y: 5.5, chance: 0.35 },
    ];
  }
  if (kind === AbandonedKind.Townhouse) return [{ key: "stove_iron", x: 3.5, y: 1.5, chance: 0.45 }, { key: "cook_range", x: 1.5, y: 3.5, chance: 0.28 }, { key: "workbench", x: 0.5, y: 1.5, chance: 0.2 }];
  // ADR-373: one or two chance extras per new kind, same pattern (existing keys, inside the footprint).
  if (kind === AbandonedKind.Mill) return [{ key: "log_store", x: 5.5, y: 3.5, chance: 0.35 }, { key: "stone_store", x: 0.5, y: 3.5, chance: 0.3 }];
  if (kind === AbandonedKind.Schoolhouse) return [{ key: "bookcase_rustic", x: 5.5, y: 2.5, chance: 0.35 }, { key: "table_lamp", x: 0.5, y: 3.5, chance: 0.4 }];
  if (kind === AbandonedKind.Chapel) return [{ key: "candelabra", x: 2.5, y: 3.5, chance: 0.4 }, { key: "candle", x: 4.5, y: 1.5, chance: 0.35 }];
  if (kind === AbandonedKind.TradingPost) return [{ key: "salt_barrel", x: 5.5, y: 3.5, chance: 0.35 }, { key: "workbench", x: 0.5, y: 2.5, chance: 0.2 }];
  if (kind === AbandonedKind.Smithy) return [{ key: "ore_store", x: 4.5, y: 3.5, chance: 0.4 }, { key: "tool_bench", x: 0.5, y: 3.5, chance: 0.3 }];
  if (kind === AbandonedKind.Bakery) return [{ key: "wood_stove", x: 4.5, y: 3.5, chance: 0.35 }, { key: "salt_barrel", x: 0.5, y: 3.5, chance: 0.4 }];
  if (kind === AbandonedKind.Stable) return [{ key: "workbench", x: 2.5, y: 2.5, chance: 0.25 }, { key: "salt_barrel", x: 5.5, y: 2.5, chance: 0.3 }];
  if (kind === AbandonedKind.Watchtower) return [{ key: "basic_storage_box", x: 2.5, y: 1.5, chance: 0.4 }, { key: "table_lamp", x: 0.5, y: 1.5, chance: 0.3 }];
  if (kind === AbandonedKind.Bathhouse) return [{ key: "potted_plant", x: 1.5, y: 3.5, chance: 0.5 }, { key: "flower_box", x: 4.5, y: 1.5, chance: 0.35 }];
  if (kind === AbandonedKind.Inn) return [{ key: "table_lamp", x: 5.5, y: 2.5, level: 1, chance: 0.5 }, { key: "chair_rustic", x: 2.5, y: 3.5, level: 1, chance: 0.4 }];
  if (kind === AbandonedKind.Apiary) return [{ key: "herb_planter", x: 7.5, y: 2.5, chance: 0.5 }];
  if (kind === AbandonedKind.Granary) return [{ key: "barrel_storage", x: 0.5, y: 3.5, chance: 0.4 }, { key: "salt_barrel", x: 2.5, y: 3.5, chance: 0.3 }];
  if (kind === AbandonedKind.FisherHut) return [{ key: "log_store", x: 2.5, y: 1.5, chance: 0.4 }, { key: "basket", x: 1.5, y: 2.5, chance: 0.5 }];
  if (kind === AbandonedKind.Barracks) return [{ key: "storage_box", x: 5.5, y: 2.5, chance: 0.4 }, { key: "table", x: 4.5, y: 3.5, chance: 0.3 }];
  return [];
}
function extraRole(key: string): Role {
  return key.includes("storage") || key.includes("chest") || key === "barrel_storage" || key.includes("wardrobe") || key === "salt_barrel" ? "loot" : "furniture";
}

/** ADR-311: roof style weights [flat, eaves, gable, hip_gable] by kind — light huts lean flat/gable, homes lean eaves/hip. */
function roofWeights(kind: AbandonedKindId): readonly number[] {
  switch (kind) {
    case AbandonedKind.Shed: case AbandonedKind.HunterShack: return [0.4, 0, 0.45, 0.15];
    case AbandonedKind.Workshop: case AbandonedKind.Barn: return [0.25, 0.1, 0.45, 0.2];
    case AbandonedKind.Cabin: return [0.15, 0.15, 0.4, 0.3];
    case AbandonedKind.Townhouse: return [0.3, 0.4, 0.05, 0.25];
    // ADR-373: civic buildings lean gable, the mill and stable read as barns.
    case AbandonedKind.Chapel: case AbandonedKind.Schoolhouse: return [0.05, 0.15, 0.5, 0.3];
    case AbandonedKind.Mill: case AbandonedKind.Stable: return [0.25, 0.1, 0.45, 0.2];
    case AbandonedKind.TwoStoryCottage: case AbandonedKind.TwoStoryFarmhouse: case AbandonedKind.TwoStoryHomestead: case AbandonedKind.Manor: case AbandonedKind.Inn:
      return [0.1, 0.4, 0.2, 0.3];
    default: return [0.1, 0.35, 0.25, 0.3];
  }
}
function pickRoofStyle(kind: AbandonedKindId, rand: () => number): RoofStyleId {
  const ws = roofWeights(kind); let r = rand() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ws.length; i++) { r -= ws[i]!; if (r < 0 && ws[i]! > 0) return i as RoofStyleId; }
  return RoofStyle.Flat;
}
/**
 * ADR-311: restyle the flat top-story roof tiles in place (same count and order, so the main plan stream is untouched).
 * Rotations follow the roof art (assets/tools/buildings2.py roof_d): eave direction for rot 0..3 is S, W, N, E;
 * a corner's eaves are rot and rot+3; a hip's eave end is rot+3; a gable ridge runs E-W at rot 0 and N-S at rot 1.
 */
function styleRoof(pieces: Spec[], style: RoofStyleId, rand: () => number): boolean {
  const roofs = pieces.filter((s) => s.role === "roof"); if (roofs.length === 0) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of roofs) { x0 = Math.min(x0, Math.floor(s.x)); y0 = Math.min(y0, Math.floor(s.y)); x1 = Math.max(x1, Math.floor(s.x)); y1 = Math.max(y1, Math.floor(s.y)); }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const ew = w > h || (w === h && rand() < 0.5); // ridge axis along the long side
  for (const s of roofs) {
    const i = Math.floor(s.x) - x0, j = Math.floor(s.y) - y0;
    if (style === RoofStyle.Eaves && w >= 3 && h >= 3) {
      const n = j === 0, so = j === h - 1, we = i === 0, ea = i === w - 1;
      if (n && we) { s.key = "roof_corner"; s.rot = 2; } else if (n && ea) { s.key = "roof_corner"; s.rot = 3; }
      else if (so && ea) { s.key = "roof_corner"; s.rot = 0; } else if (so && we) { s.key = "roof_corner"; s.rot = 1; }
      else if (n) { s.key = "roof_slope"; s.rot = 2; } else if (so) { s.key = "roof_slope"; s.rot = 0; }
      else if (we) { s.key = "roof_slope"; s.rot = 1; } else if (ea) { s.key = "roof_slope"; s.rot = 3; }
      else { s.key = "roof_flat"; s.rot = 0; }
    } else if (style === RoofStyle.Gable || style === RoofStyle.HipGable) {
      const along = ew ? i : j, len = ew ? w : h;
      s.key = "roof_gable"; s.rot = ew ? 0 : 1;
      if (style === RoofStyle.HipGable && len >= 3 && along === 0) { s.key = "roof_hip"; s.rot = ew ? 2 : 3; }
      else if (style === RoofStyle.HipGable && len >= 3 && along === len - 1) { s.key = "roof_hip"; s.rot = ew ? 0 : 1; }
    } else { s.key = "roof_flat"; s.rot = 0; }
  }
  const hearth = pieces.find((s) => s.key === "fireplace");
  if (!hearth || (style !== RoofStyle.Flat && style !== RoofStyle.Eaves) || w < 3 || h < 3 || rand() >= 0.65) return false;
  const ci = Math.min(w - 2, Math.max(1, Math.floor(hearth.x) - x0)), cj = Math.min(h - 2, Math.max(1, Math.floor(hearth.y) - y0));
  const cell = roofs.find((s) => Math.floor(s.x) - x0 === ci && Math.floor(s.y) - y0 === cj);
  if (!cell) return false;
  cell.key = "roof_chimney"; cell.rot = 0;
  return true;
}

export interface AbandonedOpts { kind?: AbandonedKindId; rot?: number; ruin?: number; tier?: number; roof?: RoofStyleId }
export function planAbandonedSite(seed: number, originX: number, originY: number, opts: AbandonedOpts = {}): PlannedSite {
  const rand = rng(hashU32(seed >>> 0, originX, originY, 0xA5B30001));
  const kind = opts.kind ?? pickKind(rand);
  const rot = opts.rot ?? (rand() * 4 | 0);
  const built0 = buildKind(kind);
  const extraRand = rng(hashU32(seed >>> 0, originX, originY, 0x57A70001));
  for (const ex of extrasFor(kind)) {
    // ADR-372: a random extra never lands on a stair tile (a cook_range used to spawn on the townhouse
    // flight) or on the tile its second flight climbs from — the flight must stay walkable.
    const onStair = built0.pieces.some((s) => s.role === "stair" && (ex.level ?? 0) === s.level
      && Math.floor(s.x) === Math.floor(ex.x) && Math.floor(s.y) === Math.floor(ex.y));
    if (!onStair && extraRand() < ex.chance) built0.pieces.push({ key: ex.key, x: ex.x, y: ex.y, level: ex.level ?? 0, rot: 0, role: extraRole(ex.key) });
  }
  const roofRand = rng(hashU32(seed >>> 0, originX, originY, 0x2F0F0311)); // ADR-311: own stream
  const roofStyle = opts.roof ?? pickRoofStyle(kind, roofRand);
  const chimney = styleRoof(built0.pieces, roofStyle, roofRand);
  const built = rotateBuilt(built0, rot);
  const ruin = opts.ruin ?? (0.18 + rand() * 0.62);
  const tier = opts.tier ?? (STONE_KINDS.has(kind) && rand() < 0.35 ? 2 : 1);
  const pieces: PlannedPiece[] = built.pieces.map((s) => {
    const omitable = s.role === "opening" || s.role === "furniture" || s.role === "loot" || s.role === "fence" || s.role === "garden" || s.role === "roof";
    const omit = omitable && rand() < ruin * (s.role === "roof" ? 0.22 : 0.42);
    const hpFrac = s.role === "opening" || s.role === "furniture" || s.role === "loot" || s.role === "fence" || s.role === "garden"
      ? Math.max(0.25, 1 - ruin * (0.2 + rand() * 0.4))
      : Math.max(0.22, 1 - ruin * (0.35 + rand() * 0.45));
    return { ...s, x: originX + s.x, y: originY + s.y, tier, omit, hpFrac };
  });
  // ADR-372: broken / missing stairs. A two-story+ site can spawn with its ground flight missing (interior
  // and/or exterior), so the upper floor is only reachable by building the stairs back — through the
  // existing build system for players, and through the claim-build rebuild flow for AI humans (the missing
  // stair is a structural piece in the plan, so ruinLayout + planClaimRuin already rebuild it). The roll is
  // ruin-scaled (a ruin-0 site never loses its stairs) on its own seeded stream, so the main plan stream —
  // layouts, loot, furnishing rolls — is untouched.
  if (built.stories >= 2) {
    const sr = rng(hashU32(seed >>> 0, originX, originY, 0x5A172));
    const interiorMissing = sr() < STAIRS_DATA.brokenChance * ruin;
    const exteriorMissing = sr() < STAIRS_DATA.brokenExteriorChance * ruin;
    for (const p of pieces) {
      if (p.role !== "stair" || p.level !== 0) continue; // only the ground flight goes missing
      if (p.exterior ? exteriorMissing : interiorMissing) p.omit = true;
    }
  }
  return {
    kind, kindKey: ABANDONED_KIND_KEYS[kind] ?? "cottage", originX, originY,
    width: built.w, height: built.h, stories: built.stories, rot, ruin, tier,
    garden: built.garden, pen: built.pen, pieces, roofStyle, chimney,
  };
}

function siteExistsAt(world: World, ox: number, oy: number): boolean {
  if (!world.isRegistered(AbandonedSite)) return false;
  for (const e of world.query([AbandonedSite])) {
    if (world.getField(e, AbandonedSite, "originX") === ox && world.getField(e, AbandonedSite, "originY") === oy) return true;
  }
  return false;
}

function footprintBusy(world: World, ox: number, oy: number, w: number, h: number): boolean {
  if (!world.isRegistered(BuildPiece)) return false;
  for (const e of world.query([BuildPiece, Transform])) {
    const x = world.getField(e, Transform, "x")!, y = world.getField(e, Transform, "y")!;
    if (x >= ox - 0.05 && x < ox + w + 0.05 && y >= oy - 0.05 && y < oy + h + 0.05) return true;
  }
  return false;
}

export function siteTerrainOk(world: World, ox: number, oy: number, w: number, h: number): boolean {
  const terrain = world.getResource(TerrainRes); if (!terrain) return true;
  const defs = gameplayDefs(world);
  let lo = Infinity, hi = -Infinity;
  for (let y = oy; y < oy + h; y++) for (let x = ox; x < ox + w; x++) {
    if (terrain.loaded?.(x, y) === false) return false;
    const tile = terrain.tileAt(x, y); if (!tile) return false;
    if (isWaterId(tile)) return false;
    if (defs.worldgen.unbuildableTiles.has(tile) && waterDepthAt(terrain.tileAt, x, y, defs.movement.shallowRadius) !== WaterDepth.Shallow) return false;
    const ht = terrain.heightAt(x, y); lo = Math.min(lo, ht); hi = Math.max(hi, ht);
  }
  return hi - lo <= Math.max(1, defs.building.maxSlope);
}

function nearSpawn(ox: number, oy: number, w: number, h: number): boolean {
  const cx = ox + w / 2, cy = oy + h / 2;
  for (const [sx, sy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]] as const) {
    if (Math.hypot(cx - sx * 96 - 0.5, cy - sy * 96 - 0.5) < 32) return true;
  }
  return false;
}

const LOOT_COMMON = ["wood", "stone", "nails", "cloth", "rope", "fiber", "sticks", "planks", "scrap_metal"] as const;
const LOOT_FOOD = ["apple", "potato", "blueberry", "carrot", "corn", "wild_onion", "bread", "salt", "raspberry"] as const;
const LOOT_SEEDS = ["wheat_seeds", "carrot_seeds", "seed_potato", "corn_seeds", "onion_seeds", "berry_seeds"] as const;
const LOOT_MED = ["bandage", "cloth", "medicated_bandage"] as const;
const LOOT_RARE = ["torch", "stone_knife", "leg_splint", "stone_axe"] as const;
const LOOT_CLOTHES = ["cloth", "padded_cloth", "cloth_gloves", "cloth_mask", "leather_boots", "leather_cap"] as const;

function pickLoot(rand: () => number, wardrobe: boolean): { key: string; count: number } {
  const r = rand();
  const pool = wardrobe
    ? (r < 0.62 ? LOOT_CLOTHES : r < 0.88 ? LOOT_COMMON : LOOT_RARE)
    : r < 0.48 ? LOOT_COMMON : r < 0.72 ? LOOT_FOOD : r < 0.86 ? LOOT_SEEDS : r < 0.95 ? LOOT_MED : LOOT_RARE;
  const key = pool[(rand() * pool.length) | 0]!;
  const rare = (LOOT_RARE as readonly string[]).includes(key);
  return { key, count: rare ? 1 : 1 + (rand() * 4 | 0) };
}

/** ADR-382: roll the loot picks for one container from `rand` without placing them. */
function rollLootPicks(rand: () => number, wardrobe: boolean): { key: string; count: number }[] {
  const n = 2 + (rand() * 4 | 0);
  const picks: { key: string; count: number }[] = [];
  for (let i = 0; i < n; i++) picks.push(pickLoot(rand, wardrobe));
  return picks;
}

function fillLoot(world: World, piece: Entity, rand: () => number): void {
  const box = resolveAttachment(world, piece, AttachKind.Storage); if (!box) return;
  const defs = gameplayDefs(world);
  const type = world.getField(piece, BuildPiece, "type");
  const wardrobe = !!(type !== undefined && defs.pieces.get(type)?.features.wardrobe);
  for (const pick of rollLootPicks(rand, wardrobe)) {
    try { addItem(world, box, defs.itemId(pick.key), pick.count); } catch { /* item renamed */ }
  }
}

function placeSpec(world: World, p: PlannedPiece): Entity | 0 {
  if (p.omit) return 0;
  const defs = gameplayDefs(world);
  let pieceId: number;
  try { pieceId = defs.pieceId(p.key); } catch { return 0; }
  const def = defs.pieces.get(pieceId); if (!def) return 0;
  const tier = def.tiered ? Math.max(def.minTier || 1, p.tier) : def.fixedTier;
  const sn = snapPlacement(world, { piece: pieceId, x: p.x, y: p.y, level: p.level, rot: p.rot, tier, variant: 0 });
  if (typeof sn === "number") return 0;
  const why = validatePlacement(world, 0 as Entity, sn, { ignoreCost: true, ignoreRange: true });
  if (why) return 0;
  const cap = def.tiered ? Math.min(0xffff, Math.round(def.hp * (defs.tiers[sn.tier]?.hpMul ?? 1))) : Math.min(0xffff, def.hp);
  const hp = Math.max(1, Math.round(cap * p.hpFrac));
  const e = placePiece(world, 0, sn, { pay: false, hp, tribe: 0 });
  world.setField(e, BuildPiece, "hp", hp);
  world.setField(e, BuildPiece, "damageStage", damageStageFor(world, hp, cap));
  return e;
}

/**
 * ADR-382: time-sliced abandoned stamping. A site chunk used to cost 4.5–9.2 ms inside one tick
 * (terrain ~0.67 ms + stamp 3.7–8.4 ms, ~30–50 µs per placed piece, ~55 pieces/site average,
 * manor 204 pieces / 10.1 ms), all of it synchronous inside ChunkManager.install → onLoad →
 * world.step — about one hitch per ~6 chunks while moving. The stamp is now plan-now /
 * place-N-per-tick: stampAbandonedSite plans (~0.1 ms) and enqueues, and the postSim pump
 * (gameplay.abandonedStamps, in GAMEPLAY_SYSTEM_ORDER) places at most
 * ABANDONED_STAMP_PIECES_PER_TICK pieces per tick, so a site appears over ~3–10 ticks
 * instead of one long tick. The per-piece cost is the placed piece itself (placePiece +
 * index + loot fill), so the cap is counted in placed pieces; failed placements and omitted
 * specs cost only a validation and do not consume the budget.
 * The cap is a data knob, `stampPiecesPerTick` in packages/gameplay/data/abandoned.json
 * (leaf module building/abandoned_data.ts, same precedent as stairs_data.ts): 20 pieces
 * ≈ 0.6–1.0 ms/tick at the measured 30–50 µs per placed piece — inside the 2 ms
 * chunk-load budget (ADR-379) with room for the chunk's own terrain gen. Site kinds,
 * weights, density (SITE_CHANCE stays 0.15), piece counts, and loot are unchanged; only
 * the timing moves.
 *
 * Ordering: pieces land in the old order (level, then PHASE: deck → wall → opening → stair →
 * furniture/loot/fence/garden → roof), so foundations/walls land first and the site keeps its
 * shape while it builds; the roof retry passes (ADR-311) run inside the same budget once the
 * main queue drains. The loot stream (lootRand) is consumed in placement order, so a sliced
 * stamp fills exactly the loot a synchronous stamp would.
 *
 * Safety: the queue lives in a module WeakMap keyed by World (no persistence/schema impact).
 * A second stamp for the same origin while one is pending returns the pending handle instead
 * of double-planning. A chunk that unloads mid-stamp is rolled back on the next pump tick
 * (placed pieces destroyed, entry dropped) so a reload re-plans and re-stamps from scratch —
 * no leak, no duplication. A server restart mid-stamp loses the queue but keeps the placed
 * pieces; the next stamp attempt resumes from those pieces (matchPartialStamp) instead of
 * leaving a permanent half-ruin behind footprintBusy. The marker (AbandonedSite) is only
 * created when the site completes, so reclaim / nearby-work / AI claim flows never see a
 * half-built site — they see nothing until it is whole.
 */
export const ABANDONED_STAMP_PIECES_PER_TICK = ABANDONED_DATA.stampPiecesPerTick;

interface PendingStamp {
  key: string; originX: number; originY: number; plan: PlannedSite;
  /** Placement order (level, PHASE); specs already placed by a resumed stamp are removed. */
  ordered: PlannedPiece[];
  next: number; placed: Entity[]; retry: PlannedPiece[]; retryPasses: number;
  lootRand: () => number;
  /** Live handle returned by stampAbandonedSite: placed grows, marker is set on completion. */
  result: StampResult;
}
export interface PendingStampInfo { key: string; originX: number; originY: number; kind: AbandonedKindId; placed: number; remaining: number }
const stampQueues = new WeakMap<World, Map<string, PendingStamp>>();
const stampKey = (ox: number, oy: number): string => `${ox},${oy}`;
function queueOf(world: World): Map<string, PendingStamp> {
  let q = stampQueues.get(world);
  if (!q) { q = new Map(); stampQueues.set(world, q); }
  return q;
}

/** True when the chunk holding this stamp's origin is no longer resident (evicted). */
function stampChunkGone(world: World, entry: PendingStamp): boolean {
  const terrain = world.getResource(TerrainRes);
  if (!terrain?.loaded) return false; // no terrain view (tests): cannot tell, keep the stamp
  return terrain.loaded(entry.originX, entry.originY) === false;
}

/**
 * Roll back a pending stamp: destroy what it placed so far and drop the entry. Mirrors
 * unloadStructures (building/persist.ts): the piece MUST leave the StructureIndex before
 * it is destroyed — pieces destroyed in the postSim pump would otherwise never be cleaned
 * up (structureIndexSystem runs in the simulation phase, before the pump, and the removal
 * record is cleared at the end of the step), leaving ghost decks/edges that make the
 * re-stamp's validation fail. Attachments (storage boxes) go with their piece, unspilled:
 * the site was never visible or claimable, so there is nothing to drop as loot.
 */
function rollbackStamp(world: World, entry: PendingStamp): void {
  stampQueues.get(world)?.delete(entry.key);
  const idx = structures(world);
  for (const e of entry.placed) {
    if (!world.isAlive(e)) continue;
    for (const a of unlinkPiece(world, e)) if (world.isAlive(a)) { unmarkLinked(world, a); world.destroy(a); }
    idx.removePiece(e);
    if (world.isAlive(e)) world.destroy(e);
  }
  entry.placed.length = 0;
  entry.result.pending = false;
  entry.result.skipped = true;
}

/** Finish a stamp: clear footprint nodes, then create the marker (only now is the site visible). */
function finishStamp(world: World, entry: PendingStamp): void {
  stampQueues.get(world)?.delete(entry.key);
  const result = entry.result;
  if (entry.placed.length === 0) { result.skipped = true; result.pending = false; return; }
  const plan = entry.plan;
  if (world.isRegistered(ResourceNode)) {
    for (const e of [...world.query([ResourceNode, Transform])]) {
      const x = world.getField(e, Transform, "x")!, y = world.getField(e, Transform, "y")!;
      if (x >= plan.originX && x < plan.originX + plan.width && y >= plan.originY && y < plan.originY + plan.height) world.destroy(e);
    }
  }
  const marker = world.create();
  world.add(marker, Transform, { x: plan.originX + 0.5, y: plan.originY + 0.5, z: 0 })
    .add(marker, AbandonedSite, { originX: plan.originX, originY: plan.originY, width: plan.width, height: plan.height, kind: plan.kind, stories: plan.stories, claimed: 0, claimedBy: 0 });
  indexEntity(world, marker);
  result.marker = marker;
  result.pending = false;
}

function pieceMatches(world: World, e: Entity, spec: PlannedPiece): boolean {
  const defs = gameplayDefs(world);
  const type = world.getField(e, BuildPiece, "type");
  if (type === undefined || (defs.pieces.get(type)?.key ?? "") !== spec.key) return false;
  const t = world.get(e, Transform); if (!t) return false;
  if (Math.abs(t.x - spec.x) > 0.01 || Math.abs(t.y - spec.y) > 0.01) return false;
  const slot = world.has(e, PieceSlot) ? world.get(e, PieceSlot) : undefined;
  const level = slot ? slot.z : Math.round((t.z ?? 0) / defs.building.levelHeight);
  return level === spec.level;
}

/**
 * Resume a stamp interrupted by a server restart: the queue is gone but the placed pieces
 * persisted. Every unowned footprint piece must match a non-omitted planned spec (same key,
 * level, position); any owned piece (player-built) or any unowned piece that matches nothing
 * aborts the resume and the stamp stays skipped, exactly as before ADR-382. Matched pieces
 * are the site's own — a player-built piece always carries an owner/tribe, and another
 * site's pieces cannot overlap this footprint (sites are chunk-contained, one per chunk).
 * Returns the matched pieces in placement order, or undefined to skip.
 */
function matchPartialStamp(world: World, plan: PlannedSite): { placed: Entity[]; placedSpecs: Set<PlannedPiece>; pieceOf: Map<PlannedPiece, Entity> } | undefined {
  const pieces: Entity[] = [];
  for (const e of world.query([BuildPiece, Transform])) {
    const x = world.getField(e, Transform, "x")!, y = world.getField(e, Transform, "y")!;
    if (x < plan.originX - 0.05 || x >= plan.originX + plan.width + 0.05 || y < plan.originY - 0.05 || y >= plan.originY + plan.height + 0.05) continue;
    pieces.push(e);
  }
  for (const e of pieces) {
    const owner = world.isRegistered(PieceOwner) ? world.getField(e, PieceOwner, "player") ?? 0 : 0;
    const tribe = world.isRegistered(Tribe) ? world.getField(e, Tribe, "id") ?? 0 : 0;
    if (owner !== 0 || tribe !== 0) return undefined; // contested footprint: keep the old skip
  }
  const ordered = [...plan.pieces].sort((a, b) => a.level - b.level || PHASE[a.role] - PHASE[b.role]);
  const used = new Set<Entity>();
  const placed: Entity[] = []; const placedSpecs = new Set<PlannedPiece>(); const pieceOf = new Map<PlannedPiece, Entity>();
  for (const spec of ordered) {
    if (spec.omit) continue;
    const found = pieces.find((e) => !used.has(e) && pieceMatches(world, e, spec));
    if (!found) continue; // not placed yet: the queue will place it
    used.add(found); placed.push(found); placedSpecs.add(spec); pieceOf.set(spec, found);
  }
  if (pieces.some((e) => !used.has(e))) return undefined; // foreign unowned piece: abort
  if (placed.length === 0) return undefined; // nothing of this site is here (cannot happen after footprintBusy)
  return { placed, placedSpecs, pieceOf };
}

export function stampAbandonedSite(world: World, originX: number, originY: number, opts: AbandonedOpts = {}): StampResult {
  const empty = (kind: AbandonedKindId = opts.kind ?? AbandonedKind.Shed): StampResult => ({ marker: 0, placed: [], omitted: 0, skipped: true, kind, stories: 1, garden: false, pen: false, pending: false });
  if (!isAuthority(world)) return empty();
  const key = stampKey(originX, originY);
  const pending = queueOf(world).get(key);
  if (pending) return pending.result; // already stamping here: same live handle, no double-plan
  const plan = planAbandonedSite(world.seed, originX, originY, opts);
  const skipped = { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
  if (siteExistsAt(world, plan.originX, plan.originY)) return skipped;
  // ADR-382 resume: a busy footprint with no marker can be a stamp cut off by a restart.
  let resumed: { placed: Entity[]; placedSpecs: Set<PlannedPiece>; pieceOf: Map<PlannedPiece, Entity> } | undefined;
  if (footprintBusy(world, plan.originX, plan.originY, plan.width, plan.height)) {
    resumed = matchPartialStamp(world, plan);
    if (!resumed) return skipped;
  }
  if (nearSpawn(plan.originX, plan.originY, plan.width, plan.height)) return skipped;
  if (!siteTerrainOk(world, plan.originX, plan.originY, plan.width, plan.height)) return skipped;
  const ordered = [...plan.pieces].sort((a, b) => a.level - b.level || PHASE[a.role] - PHASE[b.role]);
  const omitted = plan.pieces.filter((p) => p.omit).length;
  const lootRand = rng(hashU32(world.seed, originX, originY, 0x1007));
  const result: StampResult = { marker: 0, placed: [], omitted, skipped: false, kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen, pending: true };
  const entry: PendingStamp = {
    key, originX: plan.originX, originY: plan.originY, plan,
    ordered: resumed ? ordered.filter((s) => !resumed!.placedSpecs.has(s)) : ordered,
    next: 0, placed: result.placed, retry: [], retryPasses: 0, lootRand, result,
  };
  if (resumed) {
    // The matched pieces are already standing, in placement order. Replaying their loot
    // rolls against the fresh stream (without adding items — the containers were filled
    // when the pieces were first placed) keeps the loot stream aligned with an
    // uninterrupted stamp, so the resumed site fills exactly the same loot.
    entry.placed.push(...resumed.placed);
    for (const spec of ordered) {
      if (!resumed.placedSpecs.has(spec) || spec.role !== "loot") continue;
      const piece = resumed.pieceOf.get(spec)!;
      const box = resolveAttachment(world, piece, AttachKind.Storage);
      if (!box) continue; // fillLoot consumed nothing for it either
      const type = world.getField(piece, BuildPiece, "type");
      const wardrobe = !!(type !== undefined && gameplayDefs(world).pieces.get(type)?.features.wardrobe);
      rollLootPicks(lootRand, wardrobe);
    }
  }
  queueOf(world).set(key, entry);
  return result;
}

/**
 * ADR-382: advance every pending stamp by up to `maxPieces` placed pieces total (default
 * ABANDONED_STAMP_PIECES_PER_TICK). Called once per tick by the gameplay.abandonedStamps
 * postSim system; tests and tools can call it directly. Returns pieces placed this call.
 * A stamp whose chunk has been evicted is rolled back instead of pumped.
 */
export function pumpAbandonedStamps(world: World, maxPieces: number = ABANDONED_STAMP_PIECES_PER_TICK): number {
  const queue = stampQueues.get(world);
  if (!queue || queue.size === 0) return 0;
  let placedThisCall = 0;
  let budget = Math.max(0, Math.floor(maxPieces));
  for (const entry of [...queue.values()]) {
    if (budget <= 0) break;
    if (stampChunkGone(world, entry)) { rollbackStamp(world, entry); continue; }
    while (budget > 0 && entry.next < entry.ordered.length) {
      const spec = entry.ordered[entry.next++]!;
      if (spec.omit) continue;
      const e = placeSpec(world, spec);
      if (!e) { if (spec.role === "roof") entry.retry.push(spec); continue; }
      entry.placed.push(e);
      if (spec.role === "loot") fillLoot(world, e, entry.lootRand);
      placedThisCall++; budget--;
    }
    // ADR-311 roof retry passes, still inside this tick's budget. A pass only counts when
    // every spec in it was attempted; a pass that makes no progress ends retries.
    while (entry.next >= entry.ordered.length && entry.retry.length > 0 && entry.retryPasses < 3 && budget > 0) {
      const pass = entry.retry; entry.retry = [];
      const failed: PlannedPiece[] = [];
      let attempted = 0;
      for (const spec of pass) {
        if (budget <= 0) { failed.push(spec); continue; }
        attempted++;
        const e = placeSpec(world, spec);
        if (e) { entry.placed.push(e); placedThisCall++; budget--; }
        else failed.push(spec);
      }
      if (attempted < pass.length) { entry.retry = failed; break; } // partial pass: resume next tick, not counted
      if (failed.length === pass.length) { entry.retry = []; entry.retryPasses = 3; break; } // no progress: stop
      entry.retry = failed; entry.retryPasses++;
    }
    if (entry.next >= entry.ordered.length && (entry.retry.length === 0 || entry.retryPasses >= 3)) finishStamp(world, entry);
  }
  return placedThisCall;
}

/** ADR-382: pump until no stamp is pending (tests and callers that need the site now). */
export function drainAbandonedStamps(world: World): number {
  let total = 0;
  for (let i = 0; i < 100 && (stampQueues.get(world)?.size ?? 0) > 0; i++) total += pumpAbandonedStamps(world, Infinity);
  return total;
}

/** ADR-382: summaries of the stamps still building (empty when idle). */
export function pendingAbandonedStamps(world: World): PendingStampInfo[] {
  const queue = stampQueues.get(world);
  if (!queue) return [];
  return [...queue.values()].map((e) => ({ key: e.key, originX: e.originX, originY: e.originY, kind: e.plan.kind, placed: e.placed.length, remaining: (e.ordered.length - e.next) + e.retry.length }));
}

/**
 * ADR-382: roll back a pending stamp (destroy what it placed, drop the entry). Returns true
 * when a stamp was pending. Tests use this to simulate a chunk unloading mid-stamp; the
 * pump does the same automatically when it sees the chunk is gone.
 */
export function cancelAbandonedStamp(world: World, originX: number, originY: number): boolean {
  const entry = stampQueues.get(world)?.get(stampKey(originX, originY));
  if (!entry) return false;
  rollbackStamp(world, entry);
  return true;
}

/** Test/dev hooks (same `_internal` precedent as roads._roadsInternal). */
export const _abandonedStampsInternal = {
  /**
   * Forget a pending stamp WITHOUT touching its placed pieces — simulates a process
   * restart, where the in-memory queue is gone but the pieces persist. The next stamp
   * attempt for that origin must resume from the standing pieces (matchPartialStamp).
   */
  forget(world: World, originX: number, originY: number): boolean {
    return stampQueues.get(world)?.delete(stampKey(originX, originY)) ?? false;
  },
  pendingCount(world: World): number { return stampQueues.get(world)?.size ?? 0; },
};

export function planAbandonedChunk(seed: number, cx: number, cy: number): { originX: number; originY: number; kind: AbandonedKindId; rot: number; ruin: number } | undefined {
  if (hashU32(seed, cx, cy, 0xC40CE) / 4294967296 >= SITE_CHANCE) return undefined;
  const rand = rng(hashU32(seed, cx, cy, 0x51CE0001));
  const kind = pickKind(rand);
  const rot = rand() * 4 | 0;
  const built = rotateBuilt(buildKind(kind), rot);
  const margin = 2;
  if (built.w + margin * 2 > CHUNK_SIZE || built.h + margin * 2 > CHUNK_SIZE) return undefined;
  const ox = cx * CHUNK_SIZE + margin + ((rand() * (CHUNK_SIZE - built.w - margin * 2 + 1)) | 0);
  const oy = cy * CHUNK_SIZE + margin + ((rand() * (CHUNK_SIZE - built.h - margin * 2 + 1)) | 0);
  const ruin = 0.18 + rand() * 0.62;
  return { originX: ox, originY: oy, kind, rot, ruin };
}

/**
 * ADR-382: chunk-load entry point. Plans the chunk's site (if any) and starts the time-sliced
 * stamp; the site completes over the next few ticks via the gameplay.abandonedStamps pump.
 * Returns undefined when the chunk has no site, otherwise the stamp's live handle (see
 * StampResult.pending) — a re-load while a stamp is pending returns the same handle.
 */
export function stampAbandonedChunk(world: World, key: ChunkKey | { cx: number; cy: number }): StampResult | undefined {
  const { cx, cy } = typeof key === "number" || typeof key === "string" ? parseChunkKey(key as ChunkKey) : key;
  const plan = planAbandonedChunk(world.seed, cx, cy); if (!plan) return undefined;
  return stampAbandonedSite(world, plan.originX, plan.originY, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
}

export function siteOf(world: World, target: Entity): Entity | undefined {
  if (!world.isRegistered(AbandonedSite)) return undefined;
  if (world.has(target, AbandonedSite)) return target;
  const t = world.get(target, Transform); if (!t) return undefined;
  for (const e of world.query([AbandonedSite])) {
    const ox = world.getField(e, AbandonedSite, "originX")!, oy = world.getField(e, AbandonedSite, "originY")!;
    const w = world.getField(e, AbandonedSite, "width") ?? 8, h = world.getField(e, AbandonedSite, "height") ?? 8;
    if (t.x >= ox - 0.6 && t.x <= ox + w + 0.6 && t.y >= oy - 0.6 && t.y <= oy + h + 0.6) return e;
  }
  return undefined;
}

export function siteUnclaimed(world: World, marker: Entity): boolean {
  return (world.getField(marker, AbandonedSite, "claimed") ?? 0) === 0;
}

export function reclaimAbandonedSite(world: World, actor: Entity, target: Entity): number {
  const marker = siteOf(world, target); if (!marker) return BuildFail.InvalidTarget;
  const claimed = world.getField(marker, AbandonedSite, "claimed") ?? 0;
  const pid = world.isRegistered(PlayerId) ? world.getField(actor, PlayerId, "id") ?? 0 : 0;
  if (claimed) return (world.getField(marker, AbandonedSite, "claimedBy") ?? 0) === pid ? 0 : BuildFail.NoPrivilege;
  const tribe = tribeOf(world, actor);
  const ox = world.getField(marker, AbandonedSite, "originX")!, oy = world.getField(marker, AbandonedSite, "originY")!;
  const w = world.getField(marker, AbandonedSite, "width") ?? 8, h = world.getField(marker, AbandonedSite, "height") ?? 8;
  const at = world.get(target, Transform);
  const covered = (at && hasOwnClaim(world, actor, at.x, at.y)) || hasOwnClaim(world, actor, ox + w / 2, oy + h / 2);
  if (!covered) return BuildFail.NeedClaim;
  for (const e of world.query([BuildPiece, Transform])) {
    const x = world.getField(e, Transform, "x")!, y = world.getField(e, Transform, "y")!;
    if (x < ox - 0.6 || x > ox + w + 0.6 || y < oy - 0.6 || y > oy + h + 0.6) continue;
    const owner = world.isRegistered(PieceOwner) ? world.getField(e, PieceOwner, "player") ?? 0 : 0;
    if (owner !== 0 && owner !== pid) continue;
    const existing = world.getField(e, Tribe, "id") ?? 0;
    if (existing !== 0 && existing !== tribe) continue;
    if (pid && world.isRegistered(PieceOwner)) {
      if (world.has(e, PieceOwner)) world.setField(e, PieceOwner, "player", pid);
      else world.add(e, PieceOwner, { player: pid });
    }
    if (tribe) {
      if (world.has(e, Tribe)) world.setField(e, Tribe, "id", tribe);
      else world.add(e, Tribe, { id: tribe });
    }
  }
  world.setField(marker, AbandonedSite, "claimed", 1);
  world.setField(marker, AbandonedSite, "claimedBy", pid);
  return 0;
}

export function nearbyAbandonedWork(world: World, x: number, y: number, radius = ABANDONED_SCAN_RADIUS): { marker: Entity; x: number; y: number; repair?: Entity; reclaim: boolean } | undefined {
  if (!world.isRegistered(AbandonedSite)) return undefined;
  const r2 = radius * radius; let best: { marker: Entity; x: number; y: number; repair?: Entity; reclaim: boolean } | undefined; let bd = Infinity;
  for (const m of world.query([AbandonedSite, Transform])) {
    const mx = world.getField(m, Transform, "x")!, my = world.getField(m, Transform, "y")!;
    const d = (mx - x) * (mx - x) + (my - y) * (my - y); if (d > r2 || d >= bd) continue;
    const ox = world.getField(m, AbandonedSite, "originX")!, oy = world.getField(m, AbandonedSite, "originY")!;
    const w = world.getField(m, AbandonedSite, "width") ?? 8, h = world.getField(m, AbandonedSite, "height") ?? 8;
    const reclaim = siteUnclaimed(world, m);
    let repair: Entity | undefined;
    for (const e of world.query([BuildPiece, Transform])) {
      const px = world.getField(e, Transform, "x")!, py = world.getField(e, Transform, "y")!;
      if (px < ox - 0.6 || px > ox + w + 0.6 || py < oy - 0.6 || py > oy + h + 0.6) continue;
      const max = maxHpOf(world, e);
      if (world.getField(e, BuildPiece, "hp")! < max * 0.95) { repair = e; break; }
    }
    best = { marker: m, x: mx, y: my, ...(repair !== undefined ? { repair } : {}), reclaim }; bd = d;
  }
  return best;
}

export function catalogHas(kind: AbandonedKindId): { stories: number; garden: boolean; pen: boolean; w: number; h: number } {
  const b = buildKind(kind);
  return { stories: b.stories, garden: b.garden, pen: b.pen, w: b.w, h: b.h };
}

let abandonedHooked = false;
export function installAbandonedStructures(_world: World): void {
  if (!abandonedHooked) {
    abandonedHooked = true;
    addChunkLoadHook((w, key) => { if (isAuthority(w)) stampAbandonedChunk(w, key); });
  }
  // ADR-382: the time-slice pump itself is a gameplay system now — "gameplay.abandonedStamps"
  // in GAMEPLAY_SYSTEM_ORDER (install.ts), so it runs once per tick on every world installed
  // through installGameplay (server, singleplayer, tests). A chunk loaded by server.chunks
  // (registered later, same phase) gets its first slice on the next tick. On a client world
  // the queue is always empty (stamps are authority-only), so this is a single empty-map
  // check per tick. Kept out of the hook guard above: the hook is once-per-process, the
  // system is per-world.
}

