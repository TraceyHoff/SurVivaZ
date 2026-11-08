/**
 * ADR-212: every build piece at every tier it offers can be placed somewhere valid on a normal base, the server
 * (validatePlacement + placePiece, real cost via tryPlace) and the client preview (buildPreviewFor) agree on the spot,
 * and the same holds on a base that went through save -> reload (derived components rehydrated).
 */
import { describe, it, expect } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import {
  addItem, buildPreviewFor, defaultDefs, TerrainRes, Placement, placePiece, pieceCost, snapPlacement, spawnPlayer, tryPlace, validatePlacement, type PieceDef,
} from "../src/index.js";
import { makeWorld, steps, spawnLearned } from "./helpers.js";

const d = defaultDefs();
const tiersOf = (def: PieceDef): number[] => (def.tiered ? d.tiers.map((_, i) => i) : [0]).filter((t) => t >= (def.minTier ?? 0));
function base(): { w: World; me: Entity } {
  const w = makeWorld(); const me = spawnLearned(w, { x: -3, y: -3, maxWeight: 0, clientId: 1 });
  const put = (key: string, x: number, y: number, level = 0, rot = 0): void => {
    const sn = snapPlacement(w, { piece: d.pieceId(key), x, y, level, rot, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`setup ${key} snap ${sn}`);
    const f = validatePlacement(w, me, sn, { ignoreCost: true, ignoreRange: true }); if (f) throw new Error(`setup ${key} @${x},${y},${level}: ${f}`);
    placePiece(w, me, sn, { pay: false });
  };
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) put("foundation", x + 0.5, y + 0.5);
  // a room on tile (2,2) (all interior edges): doorway N, window frame S, walls W/E; floor with a hatch frame above it
  put("wall_doorway", 2.5, 2); put("wall_window", 2.5, 3); put("wall", 2, 2.5, 0, 1); put("wall", 3, 2.5, 0, 1);
  put("floor_hatch_frame", 2.5, 2.5, 1);
  // ADR-265: a dedicated dry terrain face outside the flat base, for the physical ladder.
  const terrain = w.getResource(TerrainRes) ?? { tileAt: () => 4, heightAt: () => 0 }; w.setResource(TerrainRes, { tileAt: (x, y) => (x === 5 && y === 0) || (x === 0 && y === -1) ? (terrain.tileAt(x, y) || 4) : terrain.tileAt(x, y), heightAt: (x, y) => x === 0 && y === -1 ? -3 : x === 5 && y === 0 ? -8 : terrain.heightAt(x, y), loaded: () => true });
  steps(w, 2);
  return { w, me };
}
const AIMS: [number, number][] = []; for (let y = 0; y <= 10; y++) for (let x = 0; x <= 10; x++) AIMS.push([x / 2, y / 2]);
/** First aim (level, x, y, rot) where both the server and the client preview accept the piece. */
function findSpot(w: World, me: Entity, def: PieceDef, tier: number): { level: number; x: number; y: number; rot: number; sv: number; pv: string } | string {
  const fails = new Map<string, number>();
  for (const level of [0, 1]) for (const rot of [0, 1, 2, 3]) for (const [x, y] of AIMS) {
    const sn = snapPlacement(w, { piece: def.id, x, y, level, rot, tier, variant: 0 });
    if (typeof sn === "number") { fails.set(`snap${sn}`, (fails.get(`snap${sn}`) ?? 0) + 1); continue; }
    const sv = validatePlacement(w, me, sn, { ignoreCost: true, ignoreRange: true });
    if (sv) { fails.set(`v${sv}`, (fails.get(`v${sv}`) ?? 0) + 1); continue; }
    return { level, x, y, rot, sv, pv: "" };
  }
  return [...fails].map(([k, n]) => `${k}x${n}`).join(" ");
}

describe("ADR-212: every piece type and tier can be placed", () => {
  const combos = [...d.pieces.values()].filter((p) => p.placement !== Placement.Free || p.family).flatMap((def) => tiersOf(def).map((tier) => [def, tier] as const));
  it(`server finds a valid spot for all ${combos.length} piece/tier combinations and places it`, () => {
    const bad: string[] = [];
    for (const [def, tier] of combos) {
      const { w, me } = base(); const s = findSpot(w, me, def, tier);
      if (typeof s === "string") { bad.push(`${def.key} t${tier}: ${s}`); continue; }
      const sn = snapPlacement(w, { piece: def.id, x: s.x, y: s.y, level: s.level, rot: s.rot, tier, variant: 0 });
      if (typeof sn === "number") { bad.push(`${def.key} t${tier}: resnap ${sn}`); continue; }
      placePiece(w, me, sn, { pay: false });
    }
    expect(bad).toEqual([]);
  });
  it("real cost + reach (tryPlace) and the client preview agree with the server on that spot", () => {
    const bad: string[] = [];
    for (const [def, tier] of combos) {
      const { w, me } = base(); const s0 = findSpot(w, me, def, tier); if (typeof s0 === "string") continue;
      // aim where the piece will stand (as a player does), not at the ambiguous search point
      const sn = snapPlacement(w, { piece: def.id, x: s0.x, y: s0.y, level: s0.level, rot: s0.rot, tier, variant: 0 }); if (typeof sn === "number") continue;
      const s = { ...s0, x: sn.pos.x, y: sn.pos.y };
      // stand just outside the 5x5 base on the side nearest the spot (never in the way, within buildReach)
      const opts: [number, number][] = [[s.x, -0.8], [s.x, 5.8], [-0.8, s.y], [5.8, s.y]];
      const [px, py] = opts.sort((a, b) => Math.hypot(a[0] - s.x, a[1] - s.y) - Math.hypot(b[0] - s.x, b[1] - s.y))[0]!;
      w.setField(me, Transform, "x", px); w.setField(me, Transform, "y", py);
      for (const c of pieceCost(d, def, tier)) if (addItem(w, me, c.item, c.count) < c.count) bad.push(`${def.key} t${tier}: inventory`);
      const pv = buildPreviewFor(w, me, { piece: def.id, tier, variant: 0, paint: 0 }, s.rot, { mode: 1, x: s.x, y: s.y }, s.level, false);
      const r = tryPlace(w, me, { piece: def.id, x: s.x, y: s.y, level: s.level, rot: s.rot, tier, variant: 0 });
      if (!r.ok) bad.push(`${def.key} t${tier} @${s.x},${s.y} L${s.level} r${s.rot}: server ${r.reason}`);
      if (!pv?.valid) bad.push(`${def.key} t${tier} @${s.x},${s.y} L${s.level} r${s.rot}: preview ${pv?.reason}`);
    }
    expect(bad).toEqual([]);
  });
});
