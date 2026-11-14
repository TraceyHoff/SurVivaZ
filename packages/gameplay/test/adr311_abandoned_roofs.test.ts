import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

/** Eave direction per rot from the roof art (assets/tools/buildings2.py roof_d): S, W, N, E. */
const EAVE: readonly (readonly [number, number])[] = [[0, 1], [-1, 0], [0, -1], [1, 0]];
const ROOF_KEYS = ["roof_flat", "roof_slope", "roof_corner", "roof_gable", "roof_hip", "roof_chimney", "roof_gambrel", "roof_shed", "roof_cottage"]; // ADR-400: + the live ADR-398 forms
const ALL_KINDS = Object.values(G.AbandonedKind) as G.AbandonedKindId[];

function roofsOf(p: G.PlannedSite) { return p.pieces.filter((s) => s.role === "roof"); }
function bounds(p: G.PlannedSite) {
  const r = roofsOf(p);
  const xs = r.map((s) => Math.floor(s.x)), ys = r.map((s) => Math.floor(s.y));
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

describe("ADR-311 abandoned roof variety", () => {
  it("uses more than one roof style and piece type across seeds, only from the existing roof catalog", () => {
    const styles = new Set<number>(); const keys = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const p = G.planAbandonedSite(seed, 16, 16);
      styles.add(p.roofStyle);
      for (const s of roofsOf(p)) keys.add(s.key);
    }
    expect(styles.size).toBe(7); // ADR-311 flat / slope / gable / hip + ADR-398 gambrel / shed / cottage (live since ADR-400)
    for (const k of keys) expect(ROOF_KEYS).toContain(k);
    for (const k of ROOF_KEYS) expect(keys.has(k)).toBe(true);
  });

  it("is deterministic per seed and keeps layout, loot, and furnishing rolls unchanged", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = G.planAbandonedSite(seed, 30, -12), b = G.planAbandonedSite(seed, 30, -12);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      // forcing flat reproduces the pre-ADR-311 plan everywhere except roof keys/rots
      const flat = G.planAbandonedSite(seed, 30, -12, { roof: G.RoofStyle.Flat });
      expect(flat.pieces.length).toBe(a.pieces.length);
      a.pieces.forEach((p, i) => {
        const q = flat.pieces[i]!;
        expect([q.x, q.y, q.level, q.role, q.omit, q.hpFrac, q.tier]).toEqual([p.x, p.y, p.level, p.role, p.omit, p.hpFrac, p.tier]);
        if (p.role !== "roof") expect([q.key, q.rot]).toEqual([p.key, p.rot]);
      });
    }
  });

  it("orients eave slopes outward, corners at corners, and hip caps at ridge ends (any building rotation)", () => {
    for (const kind of ALL_KINDS) for (let rot = 0; rot < 4; rot++) {
      for (const style of [G.RoofStyle.Eaves, G.RoofStyle.HipGable, G.RoofStyle.Gable]) {
        const p = G.planAbandonedSite(7, 0, 0, { kind, rot, ruin: 0, roof: style });
        const { x0, y0, x1, y1 } = bounds(p); const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
        for (const s of roofsOf(p)) {
          const tx = Math.floor(s.x), ty = Math.floor(s.y); const edgeX = tx === x0 || tx === x1, edgeY = ty === y0 || ty === y1;
          const out = (d: readonly [number, number]) => d[0] * (s.x - cx) + d[1] * (s.y - cy) > 0;
          if (s.key === "roof_slope") { expect(edgeX || edgeY).toBe(true); expect(edgeX && edgeY).toBe(false); expect(out(EAVE[s.rot]!)).toBe(true); }
          if (s.key === "roof_corner") { expect(edgeX && edgeY).toBe(true); expect(out(EAVE[s.rot]!)).toBe(true); expect(out(EAVE[(s.rot + 3) & 3]!)).toBe(true); }
          if (s.key === "roof_hip") { expect(edgeX || edgeY).toBe(true); expect(out(EAVE[(s.rot + 3) & 3]!)).toBe(true); }
          if (s.key === "roof_chimney" || (style === G.RoofStyle.Eaves && s.key === "roof_flat")) expect(edgeX || edgeY).toBe(false);
        }
        const ks = roofsOf(p).map((s) => s.key);
        if (style === G.RoofStyle.Eaves) { expect(ks.filter((k) => k === "roof_corner").length).toBe(4); expect(ks).toContain("roof_slope"); }
        if (style === G.RoofStyle.HipGable) { expect(ks).toContain("roof_hip"); expect(ks).toContain("roof_gable"); }
        if (style === G.RoofStyle.Gable) expect(ks.every((k) => k === "roof_gable")).toBe(true);
        // gable ridges all run along one axis (rot parity) — the long side
        const parities = new Set(roofsOf(p).filter((s) => s.key === "roof_gable").map((s) => s.rot & 1));
        expect(parities.size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("stamps every roof style fully on the top story through normal support/stability validation", () => {
    for (const kind of [G.AbandonedKind.Shed, G.AbandonedKind.Cottage, G.AbandonedKind.TwoStoryFarmhouse, G.AbandonedKind.Townhouse, G.AbandonedKind.Manor]) {
      for (const roof of [G.RoofStyle.Flat, G.RoofStyle.Eaves, G.RoofStyle.Gable, G.RoofStyle.HipGable]) {
        const w = makeWorld(); const d = G.gameplayDefs(w);
        const plan = G.planAbandonedSite(w.seed, 8, 8, { kind, rot: 1, ruin: 0, tier: 1, roof });
        const r = G.stampAbandonedSite(w, 8, 8, { kind, rot: 1, ruin: 0, tier: 1, roof });
        G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
        expect(r.skipped).toBe(false);
        const roofs = r.placed.filter((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.roof);
        expect(roofs.length).toBeGreaterThan(0);
        for (const e of roofs) {
          const z = w.getField(e, G.PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / d.building.levelHeight);
          expect(z).toBe(plan.stories);
          expect(w.getField(e, G.PieceStability, "value")!).toBeGreaterThanOrEqual(d.building.minStability);
          const key = d.pieces.get(w.getField(e, G.BuildPiece, "type")!)!.key;
          const spec = plan.pieces.find((s) => s.role === "roof" && Math.abs(s.x - w.getField(e, Transform, "x")!) < 0.01 && Math.abs(s.y - w.getField(e, Transform, "y")!) < 0.01)!;
          expect(key).toBe(spec.key);
          expect(w.getField(e, G.BuildPiece, "rot")).toBe(spec.rot);
        }
        // single-story roofs are wall-anchored everywhere: the whole roof lands (row order no longer drops a corner tile)
        if (plan.stories === 1) expect(roofs.length).toBe(roofsOf(plan).length);
      }
    }
  });

  it("multistory buildings roof only the top story", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const p = G.planAbandonedSite(seed, 4, 4);
      for (const s of roofsOf(p)) expect(s.level).toBe(p.stories);
    }
  });

  it("disrepair still omits some styled roof tiles, and they stay repairable/reclaimable under ADR-310 rules", () => {
    const ruined = G.planAbandonedSite(42, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.9, roof: G.RoofStyle.Eaves });
    expect(roofsOf(ruined).some((s) => s.omit)).toBe(true);
    const w = makeWorld(); const d = G.gameplayDefs(w);
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cabin, rot: 0, ruin: 0.6, tier: 1, roof: G.RoofStyle.HipGable });
    G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
    const roof = r.placed.find((e) => ["roof_hip", "roof_gable"].includes(d.pieces.get(w.getField(e, G.BuildPiece, "type")!)!.key))!;
    expect(roof).toBeTruthy();
    const p = spawnLearned(w, { x: 9.5, y: 9.5, maxWeight: 0, clientId: 1 });
    expect(G.reclaimAbandonedSite(w, p, roof)).toBe(G.BuildFail.NeedClaim);
    plantClaim(w, p, 6.5, 6.5);
    expect(G.reclaimAbandonedSite(w, p, roof)).toBe(0);
    // repair gating is the same piece/tier unlock rule as roof_flat (ADR-310 unchanged)
    const fresh = G.spawnPlayer(w, { x: 9.5, y: 9.5, maxWeight: 0, clientId: 2 });
    const flatDef = d.pieces.get(d.pieceId("roof_flat"))!;
    for (const k of ["roof_slope", "roof_corner", "roof_gable", "roof_hip", "roof_chimney"]) {
      const def = d.pieces.get(d.pieceId(k))!;
      expect(G.pieceUnlocked(w, p, def, 1)).toBe(true);
      expect(G.pieceUnlocked(w, fresh, def, 1)).toBe(G.pieceUnlocked(w, fresh, flatDef, 1));
    }
  });
});
