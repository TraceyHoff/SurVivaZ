// ADR-435: harden the abandoned-structure terrain gate (ADR-384) against its two
// remaining loopholes — a resumed partial stamp that bypasses the gate, and the AI
// claim-rebuild replaying the plan with no gate at all.
//
// Loophole 1: `stampAbandonedSite` gated only fresh stamps
// (`if (!resumed && !siteTerrainOk(...))`), so a stamp cut off by a restart resumed
// in place and completed even after the terrain under it had been edited (shovel)
// into a straddle — or a partial stamp from the ADR-382→384 window, when a 1–2
// level spread was still allowed. The resumed stamp must re-check the gate and
// skip the REMAINDER, leaving the already-placed pieces standing unmarked (the
// same outcome as the contested-footprint abort), never completing a straddling
// structure.
// Loophole 2: `planClaimRuin` rebuilds missing pieces from the replayed plan
// (`ruinLayout` → `planAbandonedSite`) with no terrain check, so an AI bot
// rebuilt a straddling ruin crooked. Only the rebuild stage is gated: flag /
// reclaim / repair of a standing (grandfathered) ruin place no new pieces, so
// they keep working on straddling ground — the ruin stays a ruin, unrebuilt.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { planClaimRuin, ruinLayout } from "../src/ai/claim_build.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

type W = ReturnType<typeof makeWorld>;

/** Terrain stub: grass everywhere (tile 3), heights from `h`. */
function stepTerrain(w: W, h: (x: number, y: number) => number): void {
  w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: h, loaded: () => true });
}
const FLAT = () => 0;
/** A one-level step cutting into a footprint at (8,8): tiles x >= 10 sit a level up. */
const STRADDLE = (x: number) => (x >= 10 ? 1 : 0);

const MANOR = { kind: G.AbandonedKind.Manor, rot: 0, ruin: 0, tier: 1 } as const;
const piecesIn = (w: W, ox: number, oy: number, pw: number, ph: number): Entity[] => {
  const out: Entity[] = [];
  for (const e of w.query([G.BuildPiece, Transform])) {
    const t = w.get(e, Transform)!;
    if (t.x >= ox - 0.6 && t.x <= ox + pw + 0.6 && t.y >= oy - 0.6 && t.y <= oy + ph + 0.6) out.push(e);
  }
  return out;
};

describe("ADR-435 resumed stamps re-check the terrain gate", () => {
  it("a resumed stamp does not complete a footprint whose terrain now straddles", () => {
    const w = makeWorld();
    stepTerrain(w, FLAT);
    const plan = G.planAbandonedSite(w.seed, 8, 8, { ...MANOR });
    expect(G.siteTerrainOk(w, 8, 8, plan.width, plan.height)).toBe(true);
    // Stamp flat, place one tick's worth, then simulate the restart: the queue is
    // gone but the placed pieces persist (ADR-382 resume).
    const r = G.stampAbandonedSite(w, 8, 8, { ...MANOR });
    expect(r.pending).toBe(true);
    expect(G.pumpAbandonedStamps(w)).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(r.placed.length).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(G._abandonedStampsInternal.forget(w, 8, 8)).toBe(true);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    // Terrain edited under the partial stamp (shovel dig/raise) before the resume.
    stepTerrain(w, STRADDLE);
    expect(G.siteTerrainOk(w, 8, 8, plan.width, plan.height)).toBe(false);
    // The resume must NOT complete the straddling structure: skipped, no marker,
    // no queue entry, and no new pieces — the 20 already-placed pieces just stand.
    const resumed = G.stampAbandonedSite(w, 8, 8, { ...MANOR });
    expect(resumed.skipped).toBe(true);
    expect(resumed.marker).toBe(0);
    expect(resumed.pending).toBe(false);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    G.drainAbandonedStamps(w);
    expect([...w.query([G.AbandonedSite])].length).toBe(0);
    expect(piecesIn(w, 8, 8, plan.width, plan.height).length).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
  });

  it("a resumed stamp on still-flat ground completes exactly as before (control)", () => {
    const w = makeWorld();
    stepTerrain(w, FLAT);
    const r = G.stampAbandonedSite(w, 8, 8, { ...MANOR });
    expect(G.pumpAbandonedStamps(w)).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(G._abandonedStampsInternal.forget(w, 8, 8)).toBe(true);
    const resumed = G.stampAbandonedSite(w, 8, 8, { ...MANOR });
    expect(resumed.skipped).toBe(false);
    expect(resumed.pending).toBe(true);
    expect(resumed.placed.length).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    G.drainAbandonedStamps(w);
    expect(resumed.pending).toBe(false);
    expect(resumed.marker).toBeGreaterThan(0);
    expect([...w.query([G.AbandonedSite])].length).toBe(1);
  });
});

// ---------------- AI claim rebuild (ADR-337 rig, trimmed) ----------------
let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent }
function rig(opts: { seed?: number; x?: number; y?: number; pid?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: opts.pid ?? 7 }); pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a };
}
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100, bodyTemp: 37 }); };
/** Senses run 10 ticks apart and the ruin layout is cached 20 ticks: advance the clock after mutating the world. */
const tick = (r: Rig, n = 25): void => { r.w.tick += n; };
const stock = (r: Rig, n = 20): void => {
  const d = G.gameplayDefs(r.w);
  for (const k of ["wood", "stone", "sticks", "planks", "rope", "nails", "fiber", "clay", "dye", "berries"]) {
    try { G.addItem(r.w, r.p, d.itemId(k), n); } catch { /* renamed */ }
  }
};
function stampRuin(r: Rig, ox: number, oy: number, kind: number, ruin: number): { marker: Entity; placed: Entity[] } {
  const res = G.stampAbandonedSite(r.w, ox, oy, { kind: kind as never, rot: 0, ruin, tier: 1 });
  G.drainAbandonedStamps(r.w);
  expect(res.skipped, `stamp at ${ox},${oy}`).toBe(false);
  return { marker: res.marker as Entity, placed: res.placed };
}
const keyOf = (r: Rig, e: Entity): string => G.gameplayDefs(r.w).pieces.get(r.w.getField(e, G.BuildPiece, "type")!)?.key ?? "?";
const damage = (r: Rig, e: Entity, frac: number): void => {
  const max = G.gameplayDefs(r.w).pieces.get(r.w.getField(e, G.BuildPiece, "type")!)!.hp;
  r.w.setField(e, G.BuildPiece, "hp", Math.max(1, Math.round(max * frac)));
};
/** Drive a claimed ruin to the rebuild stage: flag down, reclaimed, nothing damaged, one roof piece demolished. */
function ruinAtRebuild(r: Rig, marker: Entity): void {
  plantClaim(r.w, r.p, 6.5, 8.5);
  expect(G.reclaimAbandonedSite(r.w, r.p, marker)).toBe(0);
  const plan = G.planAbandonedSite(r.w.seed, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.5 });
  const roof = piecesIn(r.w, 8, 8, plan.width, plan.height).find((e) => keyOf(r, e).startsWith("roof_"))!;
  expect(roof).toBeDefined(); r.w.destroy(roof); tick(r);
  const p = planClaimRuin(r.w, r.p, marker);
  expect(p.target.stage).toBe("rebuild");
  expect(p.step?.k).toBe("build");
}

describe("ADR-435 AI rebuilds respect the terrain gate", () => {
  it("an AI rebuild of a straddling site is skipped — but reclaim and repair still work", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.5);
    ruinAtRebuild(r, s.marker);
    // Terrain edited under the standing ruin (shovel) so its footprint straddles.
    const plan = G.planAbandonedSite(r.w.seed, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.5 });
    stepTerrain(r.w, STRADDLE);
    expect(G.siteTerrainOk(r.w, 8, 8, plan.width, plan.height)).toBe(false);
    tick(r);
    // Repair still works on straddling ground: it restores a standing piece, it
    // places nothing new, so the gate does not block it.
    const wall = piecesIn(r.w, 8, 8, plan.width, plan.height).find((e) => keyOf(r, e) === "wall")!;
    expect(wall).toBeDefined(); damage(r, wall, 0.3); tick(r);
    let p = planClaimRuin(r.w, r.p, s.marker);
    expect(p.target.stage).toBe("repair");
    expect(p.step).toEqual({ k: "repair", piece: wall });
    // Repaired, a roof piece is still missing — but the rebuild must not happen:
    // no build step, blocked on the terrain, and the ruin is left standing.
    r.w.setField(wall, G.BuildPiece, "hp", G.gameplayDefs(r.w).pieces.get(r.w.getField(wall, G.BuildPiece, "type")!)!.hp);
    tick(r);
    p = planClaimRuin(r.w, r.p, s.marker);
    expect(p.target.stage).toBe("rebuild");
    expect(p.step).toBeUndefined();
    expect(p.blocked).toContain("terrain-straddle");
    expect(ruinLayout(r.w, s.marker)?.missing.length).toBeGreaterThan(0);
    expect([...r.w.query([G.AbandonedSite])].length).toBe(1);
  });

  it("a level footprint still rebuilds normally (control)", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.5);
    stepTerrain(r.w, FLAT);
    const plan = G.planAbandonedSite(r.w.seed, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.5 });
    expect(G.siteTerrainOk(r.w, 8, 8, plan.width, plan.height)).toBe(true);
    ruinAtRebuild(r, s.marker);
    const p = planClaimRuin(r.w, r.p, s.marker);
    expect(p.target.stage).toBe("rebuild");
    expect(p.step?.k).toBe("build");
    expect(p.blocked).toEqual([]);
  });

  it("the unrecoverable-layout fallback hut is also gated on straddling ground", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    // A bare marker: no pieces at all, so no rotation matches and the plan falls
    // back to rebuilding a 2x2 hut on the footprint.
    const m = r.w.create();
    r.w.add(m, Transform, { x: 8.5, y: 8.5, z: 0 });
    r.w.add(m, G.AbandonedSite, { originX: 8, originY: 8, width: 3, height: 3, kind: G.AbandonedKind.Shed, stories: 1, claimed: 0, claimedBy: 0 });
    expect(ruinLayout(r.w, m)?.fallback).toBe(true);
    plantClaim(r.w, r.p, 6.5, 8.5);
    expect(G.reclaimAbandonedSite(r.w, r.p, m)).toBe(0);
    stepTerrain(r.w, STRADDLE);
    expect(G.siteTerrainOk(r.w, 8, 8, 3, 3)).toBe(false);
    tick(r);
    const p = planClaimRuin(r.w, r.p, m);
    expect(p.target.stage).toBe("rebuild");
    expect(p.step).toBeUndefined();
    expect(p.blocked).toContain("terrain-straddle");
    // And flat again: the fallback hut rebuilds (control — the gate is terrain, not kind).
    stepTerrain(r.w, FLAT);
    tick(r);
    const flat = planClaimRuin(r.w, r.p, m);
    expect(flat.target.stage).toBe("rebuild");
    expect(flat.step?.k).toBe("build");
    if (flat.step?.k === "build") expect(G.gameplayDefs(r.w).pieces.get(flat.step.piece)?.key).toBe("foundation");
  });
});
