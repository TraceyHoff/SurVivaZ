/**
 * ADR-315: bigger claim areas, the claim preview data, no-overlap claims (clanmates may touch), the claim-zone grid,
 * legacy-claim growth, and AI site picking that respects claims.
 */
import { describe, expect, it } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { growLegacyClaims } from "../src/building/rehydrate.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const FLAG = d.pieceId("claim_totem");
const R = d.pieces.get(FLAG)!.privilegeRadius;

function setPid(w: World, e: Entity, id: number): void {
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id });
}
function setTribe(w: World, e: Entity, id: number): void { if (w.has(e, G.Tribe)) w.setField(e, G.Tribe, "id", id); else w.add(e, G.Tribe, { id }); }
/** Validate a Claim Flag request at (x, y) for `p`, ignoring range and cost (the rule under test is the claim). */
function flagAt(w: World, p: Entity, x: number, y: number): number {
  const sn = G.snapPlacement(w, { piece: FLAG, x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  return typeof sn === "number" ? sn : G.validatePlacement(w, p, sn, { ignoreCost: true, ignoreRange: true });
}
const pos = (w: World, e: Entity) => w.get(e, Transform)!;

describe("ADR-315 claim radius", () => {
  it("a Claim Flag claims radius 32 (within the zone-grid bound) and a placed flag carries it", () => {
    expect(R).toBe(32);
    for (const def of d.pieces.values()) expect(def.privilegeRadius).toBeLessThanOrEqual(G.MAX_PRIVILEGE_RADIUS);
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const f = plantClaim(w, p, 0, 0);
    expect(w.getField(f, G.PrivilegeZone, "radius")).toBe(32);
    expect(G.hasOwnClaim(w, p, 31, 0.5)).toBe(true);
    expect(G.hasOwnClaim(w, p, 33, 0.5)).toBe(false);
  });
});

describe("ADR-315 no overlapping claims", () => {
  function two(sameTribe: boolean, samePlayer = false) {
    const w = makeWorld();
    const a = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, a, 1);
    const b = samePlayer ? a : spawnLearned(w, { x: 2 * R, y: 0, maxWeight: 0, clientId: 2 });
    if (!samePlayer) setPid(w, b, 2);
    if (sameTribe) { setTribe(w, a, 77); setTribe(w, b, 77); }
    const fa = plantClaim(w, a, 0.5, 0.5); return { w, a, b, fa, ax: pos(w, fa).x, ay: pos(w, fa).y };
  }
  it("clanmates may place flags whose areas touch edge to edge", () => {
    const { w, b, ax, ay } = two(true);
    expect(flagAt(w, b, ax + 2 * R, ay)).toBe(0);
    const fb = plantClaim(w, b, ax + 2 * R, ay);
    expect(Math.hypot(pos(w, fb).x - ax, pos(w, fb).y - ay)).toBeCloseTo(2 * R, 3);
    expect(G.claimOverlap(w, pos(w, fb).x, pos(w, fb).y, R, fb)).toBeUndefined();
  });
  it("a clanmate's overlapping flag is rejected with ClaimOverlap", () => {
    const { w, b, ax, ay } = two(true);
    expect(flagAt(w, b, ax + 2 * R - 1, ay)).toBe(G.BuildFail.ClaimOverlap);
    expect(flagAt(w, b, ax + 40, ay)).toBe(G.BuildFail.ClaimOverlap);
  });
  it("a player's own second flag may touch but never overlap their first", () => {
    const { w, a, ax, ay } = two(false, true);
    expect(flagAt(w, a, ax + 40, ay)).toBe(G.BuildFail.ClaimOverlap);
    expect(flagAt(w, a, ax + 2 * R, ay)).toBe(0); // multiple flags per player are allowed
  });
  it("a foreign overlap is ClaimOverlap; a flag inside a foreign claim is NoPrivilege; foreign rims may touch", () => {
    const { w, b, ax, ay } = two(false);
    expect(flagAt(w, b, ax + 2 * R - 2, ay)).toBe(G.BuildFail.ClaimOverlap);
    expect(flagAt(w, b, ax + 10, ay)).toBe(G.BuildFail.NoPrivilege);
    expect(flagAt(w, b, ax + 2 * R, ay)).toBe(0);
  });
  it("clan members still build inside each other's claims (zoneOwnedBy unchanged)", () => {
    const { w, b, fa, ax, ay } = two(true);
    expect(G.zoneOwnedBy(w, fa, b)).toBe(true);
    const sn = G.snapPlacement(w, { piece: d.pieceId("foundation"), x: ax + 3.5, y: ay + 3.5, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error(String(sn));
    expect(G.validatePlacement(w, b, sn, { ignoreCost: true, ignoreRange: true })).toBe(0);
  });
});

describe("ADR-315 build-mode preview", () => {
  function setup() {
    const w = makeWorld(); const a = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, a, 1);
    const fa = plantClaim(w, a, 0.5, 0.5); const t = pos(w, fa);
    const def = d.pieces.get(FLAG)!; for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, a, c.item, c.count);
    return { w, a, fa, t };
  }
  it("a flag hologram carries its claim radius, valid in the clear", () => {
    const { w, a, t } = setup();
    w.set(a, Transform, { ...w.get(a, Transform)!, x: t.x + 80, y: t.y });
    const p = G.buildPreviewFor(w, a, { piece: FLAG, tier: 0, variant: 0, paint: 0 }, 0, { mode: 1, x: t.x + 80, y: t.y });
    expect(p?.claim?.radius).toBe(R); expect(p?.valid).toBe(true);
  });
  it("turns invalid (ClaimOverlap, naming the overlapped claim) when the area would overlap", () => {
    const { w, a, fa, t } = setup();
    w.set(a, Transform, { ...w.get(a, Transform)!, x: t.x + 40, y: t.y });
    const p = G.buildPreviewFor(w, a, { piece: FLAG, tier: 0, variant: 0, paint: 0 }, 0, { mode: 1, x: t.x + 40, y: t.y });
    expect(p?.valid).toBe(false); expect(p?.reason).toBe(G.BuildFail.ClaimOverlap); expect(p?.claim?.overlap).toBe(fa);
  });
  it("bumps a slightly overlapping hologram out to touch the claim", () => {
    const { w, a, t } = setup();
    w.set(a, Transform, { ...w.get(a, Transform)!, x: t.x + 2 * R - 2, y: t.y });
    const p = G.buildPreviewFor(w, a, { piece: FLAG, tier: 0, variant: 0, paint: 0 }, 0, { mode: 1, x: t.x + 2 * R - 1.5, y: t.y });
    expect(p?.valid).toBe(true); expect(p?.bumped).toBe(true);
    expect(Math.hypot(p!.x - t.x, p!.y - t.y)).toBeGreaterThanOrEqual(2 * R - 1e-3);
    expect(Math.hypot(p!.x - t.x, p!.y - t.y)).toBeLessThan(2 * R + 1.5);
  });
});

describe("ADR-315 claim-zone grid", () => {
  function zone(w: World, x: number, y: number, radius: number, tribe: number): Entity {
    const z = w.create(); w.add(z, Transform, { x, y }).add(z, G.PrivilegeZone, { radius, tribe }); return z;
  }
  it("matches a full scan, tracks adds / removes, and stays fast with thousands of claims", () => {
    const w = makeWorld({}, 7, 1 << 15); let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const zs: Entity[] = []; for (let i = 0; i < 3000; i++) zs.push(zone(w, (rnd() - 0.5) * 6000, (rnd() - 0.5) * 6000, 8 + rnd() * 32, 1 + (i % 50)));
    for (let i = 0; i < 300; i++) { const x = (rnd() - 0.5) * 6000, y = (rnd() - 0.5) * 6000, e = i % 3 === 0 ? R : 0; expect(G.zonesAt(w, x, y, e)).toEqual(G.scanZones(w, x, y, e)); }
    const t = zs[0]!; const tp = pos(w, t); expect(G.zonesAt(w, tp.x, tp.y)).toContain(t);
    w.destroy(t); expect(G.zonesAt(w, tp.x, tp.y)).not.toContain(t);
    const n = zone(w, tp.x, tp.y, 20, 9); expect(G.zonesAt(w, tp.x, tp.y)).toContain(n);
    const rebuilds = G.zoneGridRebuilds(w); const t0 = performance.now();
    for (let i = 0; i < 20000; i++) { G.zonesAt(w, (rnd() - 0.5) * 6000, (rnd() - 0.5) * 6000); G.claimOverlap(w, (rnd() - 0.5) * 6000, (rnd() - 0.5) * 6000, R); }
    const ms = performance.now() - t0;
    expect(G.zoneGridRebuilds(w)).toBe(rebuilds); // no membership change: no rebuild
    expect(ms).toBeLessThan(2000); // ~40k lookups over 3000 claims (a per-zone scan would be 120M distance checks)
  });
});

describe("ADR-315 legacy claims", () => {
  it("saved radius-12 flags grow to the new radius but stop at a foreign claim's rim", () => {
    const w = makeWorld(); const mk = (x: number, tribe: number) => { const z = w.create(); w.add(z, Transform, { x, y: 0 }).add(z, G.PrivilegeZone, { radius: 12, tribe }); return z; };
    const a = mk(0, 1), b = mk(50, 2), c = mk(-60, 1);
    growLegacyClaims(w, [[a, R], [b, R], [c, R]]);
    expect(w.getField(a, G.PrivilegeZone, "radius")).toBe(R);
    expect(w.getField(b, G.PrivilegeZone, "radius")).toBe(50 - R); // meets a's rim
    expect(w.getField(c, G.PrivilegeZone, "radius")).toBe(R); // same tribe as a: grows freely
  });
});

describe("ADR-315 AI humans follow the claim rules", () => {
  it("never picks a site whose flag would overlap a claim, and plants its flag clear of it", () => {
    const w = makeWorld(); const other = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, other, 1);
    const fo = plantClaim(w, other, 0.5, 0.5); const t = pos(w, fo);
    const bot = spawnLearned(w, { x: t.x + 20, y: t.y, maxWeight: 0, clientId: 2 }); setPid(w, bot, 2); steps(w, 1);
    expect(G.siteClaimOk(w, bot, t.x + 20, t.y, R)).toBe(false);
    const site = G.pickBaseSite(w, bot, { x: t.x + 20, y: t.y }, 0.3);
    expect(site).toBeDefined(); if (!site) return;
    expect(Math.hypot(site.x + 1 - t.x, site.y + 1 - t.y)).toBeGreaterThanOrEqual(2 * R + G.SITE_FLAG_PAD);
    // the flag slot the planner picks is a valid, non-overlapping flag
    const flagDef = d.pieces.get(FLAG)!; for (const c of G.pieceCost(d, flagDef, flagDef.fixedTier)) G.addItem(w, bot, c.item, c.count);
    G.addItem(w, bot, d.itemId("stone_axe"), 1); G.addItem(w, bot, d.itemId("stone_pickaxe"), 1);
    const fire = d.pieces.get(d.pieceId("campfire"))!; for (const c of G.pieceCost(d, fire, fire.fixedTier)) G.addItem(w, bot, c.item, c.count);
    G.addItem(w, bot, d.itemId("wood"), G.WOOD_RESERVE + 8);
    const pl = G.makePlan({ world: w, self: bot, defs: d, base: site, bs: G.scanBase(w, d, site), fails: {} });
    expect(pl.step?.k).toBe("build"); if (pl.step?.k !== "build") return;
    expect(pl.step.piece).toBe(FLAG);
    w.set(bot, Transform, { ...w.get(bot, Transform)!, x: pl.step.x, y: pl.step.y });
    expect(flagAt(w, bot, pl.step.x, pl.step.y)).toBe(0);
  });
  it("a second agent's site keeps a whole claim apart from another agent's planned site", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const q = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 2 }); steps(w, 1);
    const a = G.pickBaseSite(w, p, { x: 0, y: 0 }, 0.25)!; G.claimBaseSite(w, p, a);
    const b = G.pickBaseSite(w, q, { x: 0, y: 0 }, 0.25);
    expect(b).toBeDefined(); expect(Math.hypot(b!.x - a.x, b!.y - a.y)).toBeGreaterThanOrEqual(2 * R);
  });
});
