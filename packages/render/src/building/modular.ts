/**
 * Modular building rendering helpers (ADR-104, gameplay building/modular.ts). Pure functions, unit-tested.
 *  - Triangle pieces (Placement.Tri, 12 rotation steps of 30°): an equilateral triangle repeats every 120°, so the 12
 *    steps are only 4 distinct orientations (0/30/60/90°). Art's unique4 rows are drawn at 0/90/180/270° = 0/90/60/30°
 *    modulo 120°, so every step maps EXACTLY onto one row (no quarter-turn snapping).
 *  - BuildPiece.rotation bit 0x80 (ROT_EXACT_PIVOT): pivot at the piece's exact Transform x/y (triangle centroid,
 *    free/vertex-snapped corner) instead of the floored footprint tile. Low 2 bits stay the art row.
 *  - Streaming fallback chain for a `<piece>@tier<N>` sprite whose tier page is not resident yet.
 *  - Gridless cutaway: a cover index built from the drawn pieces themselves (the client has no BuildingGrid).
 */
export const ROT_EXACT_PIVOT = 0x80;
/** ADR-152: BuildPiece.rotation bit 0x40: low ground prop (campfire) whose 128px frame is mostly empty above the art; never
 * auto-occlusion-faded (the frame-height test faded the unlit campfire to a 35 % alpha smudge next to the player). */
export const ROT_NO_OCCLUDE = 0x40;
export const TRI_ROT_STEPS = 12;
/** ADR-210: BuildPiece.rotation bit 0x20: upright standing on a deck; drawn lifted by the deck's top height (DECK_TOP_PX). */
export const ROT_DECK_LIFT = 0x20;
/** ADR-210: BuildPiece.rotation bit 0x10: vertex-snapped corner post; depth just in front of the wall ends it joins. */
export const ROT_VERTEX_POST = 0x10;
/** Minimal gameplay PieceDef view used by pieceRotFlags (Placement: Cell 0, Edge 1, Opening 2, Free 3, Tri 4). */
export interface PieceFlagDef { placement?: number; key?: string; snap?: string; fits?: number; layer?: number; }
/**
 * ADR-210: render flag bits for a gameplay piece. Edge pieces and edge openings sit on the shared tile edge, so they pivot
 * at the exact edge midpoint (their Transform), not the floored tile centre (the pre-ADR-210 half-tile offset bug).
 */
export function pieceRotFlags(def: PieceFlagDef | undefined): number {
  if (!def) return 0;
  const vertex = def.placement === 3 && (def.snap === "vertex" || !!def.key?.startsWith("wall_corner"));
  if (def.placement === 4) return ROT_EXACT_PIVOT;
  if (def.placement === 1 || (def.placement === 2 && def.fits !== 4)) return ROT_EXACT_PIVOT | ROT_DECK_LIFT;
  if (vertex) return ROT_EXACT_PIVOT | ROT_DECK_LIFT | ROT_VERTEX_POST;
  if (def.placement === 0 && def.layer === 1) return ROT_DECK_LIFT;
  return 0;
}

/** Art row (0-3, unique4 rows at 0/90/180/270°) for a triangle rotation step (0-11, 30° each). */
export function triArtRow(rot: number): number {
  const r = ((Math.round(rot) % 4) + 4) % 4; // orientation mod 120° in 30° units
  return [0, 3, 2, 1][r]!;
}

/** Art row for any piece: triangles map exactly (triArtRow); others round to the nearest quarter turn. */
export function pieceArtRow(rot: number, rotSteps: number): number {
  if (rotSteps === TRI_ROT_STEPS) return triArtRow(rot);
  if (rotSteps === 4) return ((rot % 4) + 4) % 4;
  return (((Math.round((rot * 4) / Math.max(1, rotSteps))) % 4) + 4) % 4;
}

/** Family default art for pieces that have no bare-key art of their own (ADR-104 pieces 52-67). */
const FAMILY: [RegExp, string[]][] = [
  [/^wall_corner/, ["wall_corner", "pillar"]],
  [/^wall_/, ["wall"]],
  [/^foundation_/, ["foundation"]],
  [/^floor_/, ["floor"]],
  [/^ceiling/, ["floor"]],
  [/^roof_(gable|ridge)/, ["roof_ridge", "roof_slope"]],
  [/^roof_/, ["roof_flat", "roof_slope"]],
];

/** Split "wall@tier2" -> { base: "wall", tier: 2 }. */
export function splitTierKey(piece: string): { base: string; tier: number } {
  const m = /^(.*)@tier(\d+)$/.exec(piece); return m ? { base: m[1]!, tier: Number(m[2]) } : { base: piece, tier: 0 };
}

/**
 * Keys to try (in order) while `<base>@tier<N>` streams in: the bare key, the other tiers (only if already resident;
 * caller checks), then the family default. Never contains the piece's own key.
 */
export function streamingFallbackKeys(piece: string): string[] {
  const { base, tier } = splitTierKey(piece); const out: string[] = [];
  if (tier) out.push(base);
  for (let t = 1; t <= 4; t++) if (t !== tier) out.push(`${base}@tier${t}`);
  for (const [re, keys] of FAMILY) if (re.test(base)) { for (const k of keys) if (k !== base) out.push(k); break; }
  return out;
}

/** Crack overlay anim name for damage stage 1-3 (gameplay crackOverlayAnim). */
export const crackAnim = (stage: number): string | undefined => (stage >= 1 && stage <= 3 ? `stage${stage}` : undefined);

/**
 * Attach-point px offset (from the sprite pivot, 1x) -> world offset. dx is screen-horizontal (negated when mirrored),
 * dy screen-vertical (negative = up = height).
 */
export function attachToWorld(dx: number, dy: number, flipX: boolean, iso: { tileW: number; zStep: number }): { x: number; y: number; z: number } {
  const sx = flipX ? -dx : dx; const k = sx / iso.tileW; // (x - y) * tileW/2 = sx, x + y unchanged
  return { x: k, y: -k, z: -dy / iso.zStep };
}

/**
 * Painter's depth key of a building piece (centre pivot): front corner of its front-most tile + height. Stacked
 * floors sort by level because every level adds FLOOR_HEIGHT_LEVELS * zf (= 1.0 with the default iso = one full tile
 * row), which is exactly the screen offset of one floor.
 */
export function pieceDepthKey(ax: number, ay: number, fw: number, fh: number, z: number, zf: number, bias: number): number {
  return ax + fw + ay + fh - 2 + 1.95 + z * zf + bias;
}

/** Cover index: which tiles have a deck/roof piece per level (from the pieces drawn last frame). */
export class PieceCoverIndex {
  /** "x,y" -> bit mask of levels with any piece; roofs/decks tracked separately */
  private any = new Map<string, number>(); private deck = new Map<string, number>(); private roof = new Map<string, number>();
  size = 0;
  clear(): void { this.any.clear(); this.deck.clear(); this.roof.clear(); this.size = 0; }
  add(ax: number, ay: number, fw: number, fh: number, level: number, deck: boolean, roof: boolean): void {
    const bit = 1 << Math.min(30, level); this.size++;
    for (let y = ay; y < ay + fh; y++) for (let x = ax; x < ax + fw; x++) {
      const k = `${x},${y}`;
      this.any.set(k, (this.any.get(k) ?? 0) | bit);
      if (deck) this.deck.set(k, (this.deck.get(k) ?? 0) | bit);
      if (roof) this.roof.set(k, (this.roof.get(k) ?? 0) | bit);
    }
  }
  /** Same semantics as cutawayRegion(grid): tiles of the building around (tx,ty) when covered above `level`. */
  region(tx: number, ty: number, level: number, maxTiles = 600): Set<string> | null {
    const above = ~((2 << Math.min(30, level)) - 1); const bit = 1 << Math.min(30, level);
    const covered = (k: string): boolean => (((this.any.get(k) ?? 0) & above) !== 0) || (((this.roof.get(k) ?? 0) & (bit | above)) !== 0);
    const k0 = `${tx},${ty}`; if (!covered(k0)) return null;
    const inside = (k: string): boolean => covered(k) || ((this.deck.get(k) ?? 0) & bit) !== 0;
    const seen = new Set<string>([k0]); const q: [number, number][] = [[tx, ty]];
    while (q.length && seen.size < maxTiles) {
      const [x, y] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
        if (!seen.has(k) && inside(k)) { seen.add(k); q.push([nx, ny]); }
      }
    }
    return seen;
  }
}

/**
 * ADR-211 L corner (gameplay building/structure.ts lCornerArms, kept in lockstep by apps/client/test/adr211_lcorner):
 * the two arm walls of a corner at vertex (vx, vy), rot r (arms rot0 +x/+y, rot1 -x/+y, rot2 -x/-y, rot3 +x/-y), as
 * edge-midpoint pivots with the outward-facing wall rotation (north 0, west 1, south 2, east 3). Both renderers draw
 * the tier's straight wall at each arm and the corner post art at the vertex as the joint cap.
 */
export function lCornerArmPivots(vx: number, vy: number, rot: number): { x: number; y: number; rot: number }[] {
  const r = rot & 3; const cx = r === 1 || r === 2 ? vx - 1 : vx, cy = r >= 2 ? vy - 1 : vy;
  return [{ x: cx + 0.5, y: vy, rot: r >= 2 ? 2 : 0 }, { x: vx, y: cy + 0.5, rot: r === 1 || r === 2 ? 3 : 1 }];
}
/** Straight-wall piece key drawn for an L corner piece key (`wall_corner_outer[@tierN]` -> `wall[@tierN]`), else undefined. */
export function lCornerArmPiece(piece: string | undefined): string | undefined {
  const m = piece ? /^wall_corner_outer(@tier\d+)?$/.exec(piece) : null; return m ? `wall${m[1] ?? ""}` : undefined;
}

/** Walls, doors, and gates that enclose a room (not furniture). A `@tierN` suffix is ignored. */
export function isEnclosurePieceKey(key: string): boolean {
  const k = (key.split("@")[0] ?? key);
  return k === "wall" || k.startsWith("wall_") || k === "door" || k.startsWith("door_") || k === "garden_gate";
}

/**
 * ADR-304: a piece in the indoor cutaway region fades when it would hide the room.
 * Everything above the player's story (ceilings, upper floors, roofs above) fades, as do roofs on
 * the player's story. Camera-near enclosure (view-space south/east, rot 2 or 3) at the player's
 * story that sits at or in front of the focus also fades, so walls and doors no longer hide
 * furniture. Far/back walls stay solid so the room still reads as enclosed. Furniture never fades.
 */
/** ADR-308: other stories inside the building are not drawn (above or below the player). */
export function pieceHiddenByStory(inRegion: boolean, level: number, playerLevel: number): boolean {
  return inRegion && level !== playerLevel;
}

export function pieceShouldCutaway(
  inRegion: boolean,
  level: number,
  playerLevel: number,
  roof: boolean,
  enclosure: boolean,
  viewRot: number,
  pieceFront: number,
  focusFront: number,
): boolean {
  if (!inRegion) return false;
  if (level > playerLevel) return true;
  if (level !== playerLevel) return false;
  if (roof) return true;
  if (!enclosure) return false;
  const facing = (viewRot & 3) === 2 || (viewRot & 3) === 3;
  return facing && pieceFront + 1e-3 >= focusFront - 0.5;
}
