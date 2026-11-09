// ADR-315: the Claim Flag area overlay (ghost preview + nearby borders, red on overlap), the client-local Use / hand
// toggle on a placed flag (never opens inventory), the brief border after placing, and the main.ts wiring.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "@engine/gameplay";
import { CLAIM_COLORS, CLAIM_FLASH_MS, ClaimView, claimRings, ringPoints } from "../src/claim-overlay.js";
import { CLAIM_HINT_KIND, holdStation } from "../src/station-hint.js";
import { makeWorld, plantClaim, spawnLearned } from "../../../packages/gameplay/test/helpers.js";

const d = G.defaultDefs(); const FLAG = d.pieceId("claim_totem"); const R = d.pieces.get(FLAG)!.privilegeRadius;
const setPid = (w: World, e: Entity, id: number) => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const moveTo = (w: World, e: Entity, x: number, y: number) => w.set(e, Transform, { ...w.get(e, Transform)!, x, y });
function world() {
  const w = makeWorld(); const me = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, me, 1);
  const other = spawnLearned(w, { x: 200, y: 0, maxWeight: 0, clientId: 2 }); setPid(w, other, 2);
  const mine = plantClaim(w, me, 0.5, 0.5); const theirs = plantClaim(w, other, 0.5 + 2 * R, 0.5);
  const def = d.pieces.get(FLAG)!; for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, me, c.item, c.count);
  return { w, me, other, mine, theirs };
}
const preview = (w: World, me: Entity, x: number, y: number) => G.buildPreviewFor(w, me, { piece: FLAG, tier: 0, variant: 0, paint: 0 }, 0, { mode: 1, x, y }, 0, false);

describe("ADR-315 claim preview rings", () => {
  it("the flag hologram shows its claim area (green) and nearby borders: own cyan, foreign amber", () => {
    const { w, me, mine, theirs } = world(); const v = new ClaimView();
    moveTo(w, me, 0.5 + R, 0.5 + 2 * R); const p = preview(w, me, 0.5 + R, 0.5 + 2 * R)!;
    expect(p.valid).toBe(true);
    const rings = claimRings(w, me, v, p, 0);
    const ghost = rings.find((r) => r.kind === "ghost")!; expect(ghost).toBeDefined(); expect(ghost.r).toBe(R); expect(ghost.color).toBe(CLAIM_COLORS.ghost);
    expect(rings.find((r) => r.zone === mine)?.kind).toBe("own");
    expect(rings.find((r) => r.zone === theirs)?.kind).toBe("foreign");
    expect(CLAIM_COLORS.own).not.toBe(CLAIM_COLORS.foreign);
  });
  it("turns red when the area would overlap, marking the overlapped claim red too", () => {
    const { w, me, mine } = world(); const v = new ClaimView();
    moveTo(w, me, 0.5, 0.5 + R + 8); const p = preview(w, me, 0.5, 0.5 + R + 8)!;
    expect(p.reason).toBe(G.BuildFail.ClaimOverlap);
    const rings = claimRings(w, me, v, p, 0);
    expect(rings.find((r) => r.zone === undefined)?.kind).toBe("invalid");
    expect(rings.find((r) => r.zone === mine)?.kind).toBe("invalid");
    expect(rings.find((r) => r.zone === mine)?.color).toBe(CLAIM_COLORS.invalid);
  });
  it("draws nothing when no flag is held and no border is toggled (no UI clutter)", () => {
    const { w, me } = world(); expect(claimRings(w, me, new ClaimView(), undefined, 0)).toEqual([]);
  });
  it("rim points follow the terrain height under them", () => {
    const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: (x: number, y: number) => ({ x, y }) };
    const ring = { x: 0, y: 0, r: R, kind: "own" as const, color: CLAIM_COLORS.own, alpha: 1 };
    const flat = ringPoints(ring, cam), hill = ringPoints(ring, cam, () => 4);
    expect(flat).toHaveLength(72); expect(hill[0]!.y).toBeLessThan(flat[0]!.y); expect(hill[0]!.x).toBeCloseTo(flat[0]!.x);
  });
});

describe("ADR-315 Use / hand on a Claim Flag", () => {
  it("Interact at a flag picks the claim toggle — never a panel or inventory", () => {
    const { w, me, mine } = world(); const t = w.get(mine, Transform)!; moveTo(w, me, t.x + 1, t.y + 0.5);
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "claim", piece: mine });
    const hold = holdStation({ kind: 0, lostAt: 0 }, { claim: mine }, () => true, 0);
    expect(hold).toEqual({ station: mine, kind: CLAIM_HINT_KIND, lostAt: 0 }); // the hand icon over the flag
  });
  it("a closer storage box still wins (ADR-303 distance rule)", () => {
    const { w, me, mine } = world(); const t = w.get(mine, Transform)!; moveTo(w, me, t.x + 3, t.y + 0.5);
    const sn = G.snapPlacement(w, { piece: d.pieceId("basic_storage_box"), x: t.x + 3.5, y: t.y + 1.5, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error(String(sn)); const box = G.placePiece(w, me, sn, { pay: false });
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "storage", piece: box });
  });
  it("toggles a client-local border on any flag, and forgets destroyed flags", () => {
    const { w, me, mine, theirs } = world(); const v = new ClaimView();
    expect(v.toggle(mine)).toBe(true); expect(v.toggle(theirs)).toBe(true);
    let rings = claimRings(w, me, v, undefined, 0);
    expect(rings.map((r) => r.kind).sort()).toEqual(["foreign", "own"]);
    expect(v.toggle(mine)).toBe(false); rings = claimRings(w, me, v, undefined, 0); expect(rings.map((r) => r.zone)).toEqual([theirs]);
    w.destroy(theirs); expect(claimRings(w, me, v, undefined, 0)).toEqual([]); expect(v.isShown(theirs)).toBe(false);
  });
  it("a just-placed flag shows its border briefly, then it is off by default", () => {
    const { w, me } = world(); const v = new ClaimView(); v.placed(100, 100, R, 1000);
    expect(claimRings(w, me, v, undefined, 1000 + 100)[0]?.r).toBe(R);
    expect(claimRings(w, me, v, undefined, 1000 + CLAIM_FLASH_MS + 1)).toEqual([]);
  });
  it("main.ts routes Use on a flag to the local toggle (keyboard / gamepad Interact and the touch hand), before the inventory fallback", () => {
    const src = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
    expect(src).toMatch(/t\?\.panel === "claim"\) toggleClaimView\(t\.piece\); else if \(t\) menus\?\.open\("character"\)/);
    expect(src).toMatch(/kind === CLAIM_HINT_KIND\) toggleClaimView\(st\)/);
    expect(src).toMatch(/t\.panel === "claim" \? \{ claim: t\.piece \}/);
    expect(src).toMatch(/mountClaimOverlay\(root/);
    expect(src).toMatch(/onPlaced: \(p\) => \{ if \(p\.claim\) claimView\.placed/);
  });
});
