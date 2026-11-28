// ADR-594: generated abandoned sites spawn intact, so tests that exercise the repair / reclaim / rebuild
// flows damage a stamped site by hand, the way raids and decay would: deterministic, ruin-scaled, and only
// through the public world API (hp fields and destroyed pieces).
import type { Entity, World } from "@engine/core";
import * as G from "../src/index.js";

/** Damage every placed piece's HP by `ruin` (0..1) and demolish a share of the non-structural ones. Returns the demolished pieces' keys. */
export function weatherSite(w: World, placed: readonly Entity[], ruin: number): string[] {
  const defs = G.gameplayDefs(w); const gone: string[] = [];
  placed.forEach((e, i) => {
    if (!w.isAlive(e)) return;
    const key = defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "";
    const f = ((Math.imul(i + 1, 0x9e3779b1) >>> 8) & 0xff) / 255;
    const structural = key === "foundation" || key.startsWith("wall") || key.startsWith("floor") || key === "stairs";
    if (!structural && f < ruin * 0.4) { gone.push(key); G.destroyPiece(w, e, 1 as never); return; } // 1 = DestroyCause.Damage
    const max = G.maxHpOf(w, e);
    w.setField(e, G.BuildPiece, "hp", Math.max(1, Math.round(max * Math.max(0.22, 1 - ruin * (0.35 + f * 0.45)))));
  });
  return gone;
}

/** Remove a stamped site's furnishings and loot containers (keeps foundations, walls, openings, floors, stairs, roofs): the empty-ruin premise of the ADR-340 bed / furnish-spot planner tests. */
export function stripFurnishings(w: World, placed: readonly Entity[]): void {
  const defs = G.gameplayDefs(w);
  for (const e of placed) {
    if (!w.isAlive(e)) continue;
    const key = defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "";
    const structural = key === "foundation" || key.startsWith("wall") || key.startsWith("floor") || key === "stairs" || key.startsWith("roof") || key === "pillar" || key.startsWith("door") || key.startsWith("window");
    if (!structural) G.destroyPiece(w, e, 1 as never); // 1 = DestroyCause.Damage
  }
}
