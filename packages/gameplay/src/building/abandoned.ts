/**
 * ADR-300 / ADR-301: seed-driven abandoned structures stamped from real base-building pieces.
 * Layout, furnishings, stations, disrepair, and searchable container loot are a pure function of (world seed, origin).
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, isWaterId, parseChunkKey, waterDepthAt, WaterDepth, type ChunkKey } from "@engine/world";
import { AbandonedSite, BuildPiece, PieceOwner, ResourceNode, Tribe } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { BuildFail } from "../events.js";
import { addItem } from "../inventory.js";
import { indexEntity } from "../spawn.js";
import { TerrainRes, addChunkLoadHook } from "../world.js";
import { AttachKind } from "../components.js";
import { resolveAttachment } from "./links.js";
import { damageStageFor, maxHpOf } from "./integrity.js";
import { placePiece, snapPlacement, tribeOf, validatePlacement } from "./place.js";

export const SITE_CHANCE = 0.12;
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
} as const;
export type AbandonedKindId = (typeof AbandonedKind)[keyof typeof AbandonedKind];

export const ABANDONED_KIND_KEYS: readonly string[] = [
  "shed", "cottage", "homestead", "farmhouse", "workshop", "cabin", "barn", "hunter_shack",
  "large_homestead", "two_story_cottage", "two_story_farmhouse", "two_story_homestead", "townhouse", "manor",
];

const KIND_WEIGHTS: readonly { kind: AbandonedKindId; w: number }[] = [
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
];

type Role = "deck" | "wall" | "opening" | "stair" | "furniture" | "fence" | "garden" | "loot" | "roof";
interface Spec { key: string; x: number; y: number; level: number; rot: number; role: Role }

export interface PlannedPiece {
  key: string; x: number; y: number; level: number; rot: number; role: Role;
  tier: number; omit: boolean; hpFrac: number;
}
export interface PlannedSite {
  kind: AbandonedKindId; kindKey: string; originX: number; originY: number;
  width: number; height: number; stories: number; rot: number; ruin: number; tier: number;
  garden: boolean; pen: boolean; pieces: PlannedPiece[];
}
export interface StampResult {
  marker: Entity | 0; placed: Entity[]; omitted: number; skipped: boolean;
  kind: AbandonedKindId; stories: number; garden: boolean; pen: boolean;
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
function walls(out: Spec[], x0: number, y0: number, w: number, h: number, level: number, doorSide: string, windows: readonly { side: string; i: number }[], withDoor: boolean): void {
  // ADR-211: outer foundation corners take an L (`wall_corner_outer`), not a straight wall.
  out.push({ key: "wall_corner_outer", x: x0, y: y0, level, rot: 0, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0 + w, y: y0, level, rot: 1, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0 + w, y: y0 + h, level, rot: 2, role: "wall" });
  out.push({ key: "wall_corner_outer", x: x0, y: y0 + h, level, rot: 3, role: "wall" });
  const doorIdx = Math.floor(((doorSide === "n" || doorSide === "s") ? w : h) / 2);
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

function house(x0: number, y0: number, w: number, h: number, stories: number, furn: readonly { key: string; x: number; y: number; level?: number; rot?: number; role?: Role }[], extraWindows?: boolean): Spec[] {
  const out: Spec[] = [];
  foundations(out, x0, y0, w, h);
  const win = extraWindows
    ? [{ side: "n", i: 1 }, { side: "n", i: w - 2 }, { side: "e", i: 1 }, { side: "w", i: 1 }, ...(h > 3 ? [{ side: "e", i: h - 2 }, { side: "w", i: h - 2 }] : [])]
    : [{ side: "n", i: Math.max(1, w >> 1) }, { side: "e", i: Math.max(1, h >> 1) }];
  walls(out, x0, y0, w, h, 0, "s", win, true);
  const sx = 1, sy = h - 2;
  if (stories >= 2) {
    out.push({ key: "stairs", x: x0 + sx + 0.5, y: y0 + sy + 0.5, level: 0, rot: 0, role: "stair" });
    floors(out, x0, y0, w, h, 1, sx, sy);
    walls(out, x0, y0, w, h, 1, "s", [{ side: "n", i: w >> 1 }, { side: "e", i: h >> 1 }], false);
  }
  if (stories >= 3) {
    out.push({ key: "stairs", x: x0 + sx + 0.5, y: y0 + sy + 0.5, level: 1, rot: 0, role: "stair" });
    floors(out, x0, y0, w, h, 2, sx, sy);
    walls(out, x0, y0, w, h, 2, "s", [{ side: "n", i: w >> 1 }], false);
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
    const furn = [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table", x: 3.5, y: 2.5 }, { key: "chair", x: 3.5, y: 1.5 }, { key: "chair", x: 2.5, y: 2.5 },
      { key: "storage_box", x: 3.5, y: 3.5 }, { key: "wardrobe_rustic", x: 1.5, y: 3.5 }, { key: "floor_lamp", x: 4.5, y: 1.5 },
      { key: "fireplace", x: 2.5, y: 0.5 },
      ...(stories >= 2 ? [{ key: "bed", x: 3.5, y: 1.5, level: 1 }, { key: "chair", x: 1.5, y: 1.5, level: 1 }, { key: "basic_storage_box", x: 3.5, y: 3.5, level: 1 }] : []),
    ];
    p.push(...house(0, 0, 5, 5, stories, furn, true));
    return { w: 5, h: 5, stories, garden: false, pen: false, pieces: p };
  }
  if (kind === AbandonedKind.Farmhouse || kind === AbandonedKind.TwoStoryFarmhouse) {
    const stories = kind === AbandonedKind.TwoStoryFarmhouse ? 2 : 1;
    const furn = [
      { key: "bed", x: 1.5, y: 1.0 }, { key: "table_dining_rustic", x: 3.5, y: 2.5 }, { key: "chair_rustic", x: 2.5, y: 2.5 },
      { key: "chair_rustic", x: 4.5, y: 2.5 }, { key: "large_chest", x: 5.5, y: 1.5 }, { key: "wardrobe_rustic", x: 1.5, y: 4.5 },
      { key: "fireplace", x: 3.5, y: 0.5 }, { key: "floor_lamp", x: 6.5, y: 1.5 },
      ...(stories >= 2 ? [{ key: "bed_double_rustic", x: 2.5, y: 1.5, level: 1 }, { key: "wardrobe_rustic", x: 5.5, y: 1.5, level: 1 }] : []),
    ];
    p.push(...house(0, 0, 7, 5, stories, furn, true));
    return { w: 7, h: 5, stories, garden: false, pen: false, pieces: p };
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
      { key: "storage_box", x: hw - 1.5, y: hh - 1.5 }, { key: "wardrobe_rustic", x: 1.5, y: hh - 1.5 }, { key: "fireplace", x: 2.5, y: 0.5 },
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
    const furn = [
      { key: "table", x: 2.5, y: 2.5 }, { key: "chair", x: 1.5, y: 2.5 }, { key: "storage_box", x: 3.5, y: 3.5 }, { key: "fireplace", x: 2.5, y: 0.5 },
      { key: "bed", x: 1.5, y: 1.5, level: 1 }, { key: "wardrobe_rustic", x: 3.5, y: 1.5, level: 1 },
      { key: "bed", x: 2.5, y: 1.5, level: 2 }, { key: "basic_storage_box", x: 1.5, y: 3.5, level: 2 },
    ];
    p.push(...house(0, 0, 4, 5, 3, furn, true));
    return { w: 4, h: 5, stories: 3, garden: false, pen: false, pieces: p };
  }
  return buildKind(AbandonedKind.Cottage);
}

function rotateBuilt(b: Built, rot: number): Built {
  if ((rot & 3) === 0) return b;
  const bw = b.w, bh = b.h;
  const pieces = b.pieces.map((s) => {
    const [x, y] = rotPoint(s.x, s.y, rot, bw, bh);
    const keep = s.role === "furniture" || s.role === "loot" || s.role === "fence" || s.role === "garden" || s.key === "wall_corner_outer";
    return { ...s, x, y, rot: keep ? (s.rot + rot) & 3 : 0 };
  });
  const w = (rot & 1) ? bh : bw, h = (rot & 1) ? bw : bh;
  return { ...b, w, h, pieces };
}

const STONE_KINDS = new Set<number>([
  AbandonedKind.Cottage, AbandonedKind.Farmhouse, AbandonedKind.TwoStoryCottage, AbandonedKind.TwoStoryFarmhouse,
  AbandonedKind.Townhouse, AbandonedKind.Manor, AbandonedKind.LargeHomestead,
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
  return [];
}
function extraRole(key: string): Role {
  return key.includes("storage") || key.includes("chest") || key === "barrel_storage" || key.includes("wardrobe") || key === "salt_barrel" ? "loot" : "furniture";
}

export function planAbandonedSite(seed: number, originX: number, originY: number, opts: { kind?: AbandonedKindId; rot?: number; ruin?: number; tier?: number } = {}): PlannedSite {
  const rand = rng(hashU32(seed >>> 0, originX, originY, 0xA5B30001));
  const kind = opts.kind ?? pickKind(rand);
  const rot = opts.rot ?? (rand() * 4 | 0);
  const built0 = buildKind(kind);
  const extraRand = rng(hashU32(seed >>> 0, originX, originY, 0x57A70001));
  for (const ex of extrasFor(kind)) {
    if (extraRand() < ex.chance) built0.pieces.push({ key: ex.key, x: ex.x, y: ex.y, level: ex.level ?? 0, rot: 0, role: extraRole(ex.key) });
  }
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
  return {
    kind, kindKey: ABANDONED_KIND_KEYS[kind] ?? "cottage", originX, originY,
    width: built.w, height: built.h, stories: built.stories, rot, ruin, tier,
    garden: built.garden, pen: built.pen, pieces,
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

function fillLoot(world: World, piece: Entity, rand: () => number): void {
  const box = resolveAttachment(world, piece, AttachKind.Storage); if (!box) return;
  const defs = gameplayDefs(world);
  const type = world.getField(piece, BuildPiece, "type");
  const wardrobe = !!(type !== undefined && defs.pieces.get(type)?.features.wardrobe);
  const n = 2 + (rand() * 4 | 0);
  for (let i = 0; i < n; i++) {
    const pick = pickLoot(rand, wardrobe);
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

export function stampAbandonedSite(world: World, originX: number, originY: number, opts: { kind?: AbandonedKindId; rot?: number; ruin?: number; tier?: number } = {}): StampResult {
  const empty = (kind: AbandonedKindId = opts.kind ?? AbandonedKind.Shed): StampResult => ({ marker: 0, placed: [], omitted: 0, skipped: true, kind, stories: 1, garden: false, pen: false });
  if (!isAuthority(world)) return empty();
  const plan = planAbandonedSite(world.seed, originX, originY, opts);
  if (siteExistsAt(world, plan.originX, plan.originY)) return { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
  if (footprintBusy(world, plan.originX, plan.originY, plan.width, plan.height)) return { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
  if (nearSpawn(plan.originX, plan.originY, plan.width, plan.height)) return { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
  if (!siteTerrainOk(world, plan.originX, plan.originY, plan.width, plan.height)) return { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
  const ordered = [...plan.pieces].sort((a, b) => a.level - b.level || PHASE[a.role] - PHASE[b.role]);
  const placed: Entity[] = []; let omitted = 0;
  const lootRand = rng(hashU32(world.seed, originX, originY, 0x1007));
  for (const spec of ordered) {
    if (spec.omit) { omitted++; continue; }
    const e = placeSpec(world, spec);
    if (!e) continue;
    placed.push(e);
    if (spec.role === "loot") fillLoot(world, e, lootRand);
  }
  if (placed.length === 0) return { ...empty(plan.kind), kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen, omitted };
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
  return { marker, placed, omitted, skipped: false, kind: plan.kind, stories: plan.stories, garden: plan.garden, pen: plan.pen };
}

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
  if (abandonedHooked) return;
  abandonedHooked = true;
  addChunkLoadHook((w, key) => { if (isAuthority(w)) stampAbandonedChunk(w, key); });
}

