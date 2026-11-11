/**
 * ADR-356: fill level of the five resource-specific stores (ADR-355), mirrored into the networked StoreFill
 * component so every peer draws the matching building state (empty / half / full). Same pattern as
 * stallDisplay: a postSim mirror system (postSim never runs on client replicas — they only `simulate`
 * simulation systems — so the authority's value is never clobbered by a replica that cannot see the
 * viewers-scoped Container). Marks changed only on a diff; cadence 10 ticks (0.5 s) is plenty for a visual
 * that changes only when something is deposited or withdrawn.
 */
import { type Entity, type World } from "@engine/core";
import { AttachKind, BuildPiece, Container, StoreFill } from "../components.js";
import { gameplayDefs } from "../config.js";
import { resolveAttachment } from "../building/links.js";

/** Piece keys whose fill level is mirrored (ADR-355 stores, fixed keys — the art slice depends on them). */
export const STORE_PIECE_KEYS = ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"] as const;
/** Building-state names in declaration order; index = StoreFill level (must match the pack/task355 fragment). */
export const STORE_FILL_STATE_NAMES = ["empty", "half", "full"] as const;
export const STORE_FILL_EVERY = 10;

export const isStorePieceKey = (key: string | undefined): boolean =>
  key !== undefined && (STORE_PIECE_KEYS as readonly string[]).includes(key);

/**
 * Fill bucket from used slots: 0 = empty (nothing stored), 1 = half (1–5 of 12 slots), 2 = full (6–12 of 12).
 * Slot fraction, not item count: one stack of 99 ore in a single slot still leaves most of the bin visibly empty.
 */
export function storeFillLevel(filled: number, slots: number): 0 | 1 | 2 {
  if (filled <= 0 || slots <= 0) return 0;
  return filled * 2 < slots ? 1 : 2;
}

/** Used slots of a piece's storage Container (0 when the piece has no storage attachment yet). */
export function storeFilledSlots(world: World, piece: Entity): { filled: number; slots: number } {
  const box = resolveAttachment(world, piece, AttachKind.Storage);
  if (box === undefined) return { filled: 0, slots: 0 };
  const c = world.get(box, Container);
  if (!c) return { filled: 0, slots: 0 };
  const items = world.getArray(box, Container, "items");
  let filled = 0;
  if (items) for (let i = 0; i < (c.slotCount ?? 0); i++) if (items[i] !== 0) filled++;
  return { filled, slots: c.slotCount ?? 0 };
}

/** Mirror one store piece's fill into StoreFill; true when the replicated level changed (or was first added). */
export function syncStoreFill(world: World, piece: Entity): boolean {
  const { filled, slots } = storeFilledSlots(world, piece);
  const level = storeFillLevel(filled, slots);
  if (!world.has(piece, StoreFill)) { world.add(piece, StoreFill, { level }); return true; }
  if (world.getField(piece, StoreFill, "level") === level) return false;
  world.setField(piece, StoreFill, "level", level); // setField marks changed
  return true;
}

export function storeFillSystem(world: World): void {
  if (!world.isRegistered(StoreFill) || !world.isRegistered(BuildPiece)) return;
  const defs = gameplayDefs(world);
  for (const e of [...world.query([BuildPiece])].sort((a, b) => a - b)) {
    const bp = world.get(e, BuildPiece);
    if (!bp || !isStorePieceKey(defs.pieces.get(bp.type)?.key)) continue;
    syncStoreFill(world, e);
  }
}
