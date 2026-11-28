import type { AssetRegistry, ClanPalette, FrameRef } from "./manifest.js";

/**
 * THE single BuildPiece gameplay -> render mapping (ADR-081). Gameplay stores {type, rot, tint, paint, damageStage, ...}
 * (packages/gameplay BuildPiece); render draws {visualId, rotation, damageStage, level, layer, ghost, tint}
 * (packages/render BuildPieceDefT). Nothing else may re-derive these fields.
 *  - visualId: building sprite whose `building.piece` equals the piece def key (opts.pieceKey resolves type -> key).
 *  - frame: registry.buildingFrame(visualId, rot, damageStage, stateIndex) (handles 1/2/4 rotation rows + flipX, states).
 *  - crack: crackOverlay sprite anim stage1..3 for damage stages 1-3 (only when the sprite declares crackOverlay).
 *  - layer: manifest building.layer; level passes through (default 0).
 *  - palette: clan palette of the effective tint index = paint when paint != 0, else tint (clanPaletteForTint).
 *  - ghost: 0 none, 1 valid preview, 2 invalid preview (render shader convention).
 */
/**
 * rot is in units of 1/rotSteps turn (default 4 = quarter turns). Gameplay stores rotSteps on the piece def, not the
 * component: Placement.Free pieces use defs.building.freeRotSteps (16), grid/edge/opening pieces 4. Building art has
 * only 1/2/4 rotation rows, so other step counts map to the NEAREST quarter turn (round, not mask): see quarterTurn.
 */
export interface BuildPieceIn { type: number; rot: number; tint: number; paint: number; damageStage?: number; state?: number | string; level?: number; rotSteps?: number }

/** rot in 1/steps-turn units -> nearest quarter turn 0-3 (steps 4 or absent: rot & 3, unchanged). 16 steps: 0-1->0, 2-5->1, 6-9->2, 10-13->3, 14-15->0. */
export function quarterTurn(rot: number, steps = 4): number {
  if (!steps || steps === 4) return rot & 3;
  const n = ((Math.round((rot * 4) / steps) % 4) + 4) % 4; return n;
}
export interface BuildPieceVisualOpts {
  /** 0/false = none, 1/true = valid ghost, 2 = invalid ghost. */
  ghost?: boolean | 0 | 1 | 2;
  /** Piece type id -> BuildPieceDef key (e.g. (t) => defs.pieces.get(t)?.key). */
  pieceKey?: (type: number) => string | undefined;
  /**
   * Optional art variant: the manifest key `<piece>@<variant>` (a building sprite whose building.piece is e.g. "wall@mossy") is used when it exists; otherwise the default piece sprite. Strings for now;
   * a number is resolved through variantName (Survival's variant name order) and ignored without it.
   */
  variant?: string | number;
  variantName?: (pieceKey: string, index: number) => string | undefined;
  /**
   * Optional material tier (gameplay BuildPiece.tier). When the manifest has per-tier art, i.e. a building sprite whose
   * building.piece is `<pieceKey>@tier<N>` (e.g. "wall@tier2"), it is used; otherwise the default sprite. A variant with
   * its own art wins over the tier art. Tier art is drawn as-is (no extra tint).
   */
  tier?: number;
}
export interface BuildPieceVisual {
  visualId: number; rotation: number; damageStage: number; stateIndex: number;
  frame?: FrameRef; crack?: { sprite: number; anim: string; frame: FrameRef };
  level: number; layer: number; ghost: 0 | 1 | 2; tintIndex: number; palette?: ClanPalette;
  /** Variant actually drawn (undefined = default sprite, also when the requested variant has no art). */
  variant?: string;
  /** Tier whose own art is drawn (undefined = no per-tier art used). */
  tier?: number;
}

/** Building sprite whose building.piece is `<pieceKey>@<variant>` (sprite keys cannot contain '@'), else undefined. */
export function variantSprite(registry: AssetRegistry, pieceKey: string, variant: string): number | undefined {
  return registry.spriteForPiece(`${pieceKey}@${variant}`);
}

export function buildPieceVisual(registry: AssetRegistry, piece: BuildPieceIn, opts: BuildPieceVisualOpts = {}): BuildPieceVisual {
  const g = opts.ghost; const ghost: 0 | 1 | 2 = g === true ? 1 : g === false || g === undefined ? 0 : g;
  const tintIndex = piece.paint ? piece.paint : piece.tint; const palette = registry.clanPaletteForTint(tintIndex);
  const rotation = quarterTurn(piece.rot, piece.rotSteps); const damageStage = Math.max(0, Math.min(3, (piece.damageStage ?? 0) | 0)); const level = piece.level ?? 0;
  const key = opts.pieceKey?.(piece.type);
  const vname = key === undefined || opts.variant === undefined || opts.variant === "" ? undefined : typeof opts.variant === "number" ? opts.variantName?.(key, opts.variant) : opts.variant;
  const vid = key !== undefined && vname ? variantSprite(registry, key, vname) : undefined;
  // ADR-593: tiers above the four with shipped art (the powered tier, 5) borrow tier 4's art until their own lands
  const tierArt = (t: number): number | undefined => variantSprite(registry, key!, `tier${t}`) ?? (t > 4 ? variantSprite(registry, key!, "tier4") : undefined);
  const tid = vid === undefined && key !== undefined && opts.tier !== undefined && opts.tier >= 0 ? tierArt(opts.tier) : undefined;
  const visualId = vid ?? tid ?? (key === undefined ? 0 : registry.spriteForPiece(key) ?? 0);
  const base = { rotation, damageStage, level, ghost, tintIndex, ...(palette ? { palette } : {}) };
  if (!visualId) return { visualId: 0, stateIndex: -1, layer: 0, ...base };
  const b = registry.sprite(visualId).building!;
  const stateIndex = typeof piece.state === "string" ? b.stateNames.indexOf(piece.state) : piece.state !== undefined && piece.state >= 0 && piece.state < b.states.length ? piece.state : -1;
  const frame = registry.buildingFrame(visualId, rotation, damageStage, stateIndex);
  let crack: BuildPieceVisual["crack"];
  if (b.crackOverlay !== undefined && damageStage > 0) { const anim = `stage${damageStage}`; crack = { sprite: b.crackOverlay, anim, frame: registry.animFrame(b.crackOverlay, anim, rotation, 0) }; }
  return { visualId, stateIndex, frame, ...(crack ? { crack } : {}), layer: b.layer, ...base, ...(vid !== undefined ? { variant: vname! } : {}), ...(tid !== undefined ? { tier: opts.tier! } : {}) };
}
