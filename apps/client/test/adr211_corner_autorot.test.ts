// @vitest-environment jsdom
/** ADR-211: corners auto-rotate to fit the wall junction they snap to; RB overrides; twig corner art; atlas budget keeps building art. */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { InputSystem, KeyboardMouseDevice, GamepadDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { BUILD_ATLAS_RE, lCornerArmPiece, lCornerArmPivots } from "@engine/render";
import { BuildMode } from "../src/build-mode.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0.5, y: 2.5, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  plantClaim(w, me, -2, 2);
  for (const r of d.items.values()) G.addItem(w, me, r.id, 200);
  const clock = { t: 0, now: () => clock.t };
  const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const pad = new GamepadDevice(0); sys.addDevice(new KeyboardMouseDevice()); sys.addDevice(pad); sys.push("Gameplay");
  const sent: G.MenuIntent[] = [];
  const bm = new BuildMode({ input: sys, ctx: () => ({ world: w, player: me, names: new Map() }), aim: () => ({ x: 0.5, y: 2.5, mode: 0 }), send: (i) => { sent.push(i); return true; }, device: () => "gamepad", now: () => clock.t, onPickPiece: () => {} });
  const tick = () => { clock.t += 50; sys.update(); bm.update(); };
  const btn = (c: string) => { pad.set(c, 1); tick(); pad.set(c, 0); tick(); tick(); };
  const place = (key: string, x: number, y: number, tier = 0) => { const r = G.tryPlace(w, me, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier, variant: 0 }); expect(r.ok, `${key} ${x},${y}`).toBe(true); };
  return { w, me, d, pad, sent, bm, tick, btn, place };
}

/** 3x3 deck (no walls); its foundation outer corners: (0,0) (3,0) (3,3) (0,3). */
function ring() {
  const s = setup();
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) s.place("foundation", x + 0.5, y + 0.5);
  return s;
}
const aimAt = (s: ReturnType<typeof setup>, x: number, y: number) => { s.bm.padOffset = { x: x - 0.5, y: y - 2.5 }; s.tick(); return s.bm.preview!; };
const req = (s: ReturnType<typeof setup>, key: string, x: number, y: number, rot = 0, tier = 0) => ({ piece: s.d.pieceId(key), x, y, level: 0, rot, tier, variant: 0 });

describe("ADR-211 L corners: auto-rotate, RB override", () => {
  test("outerCornerRots: each foundation outer corner has exactly the outward quarter turn; edges/interior none", () => {
    const s = ring(); const idx = G.structures(s.w);
    expect(G.outerCornerRots(idx, 0, 0, 0)).toEqual([0]); expect(G.outerCornerRots(idx, 3, 0, 0)).toEqual([1]);
    expect(G.outerCornerRots(idx, 3, 3, 0)).toEqual([2]); expect(G.outerCornerRots(idx, 0, 3, 0)).toEqual([3]);
    expect(G.outerCornerRots(idx, 1, 0, 0)).toEqual([]); expect(G.outerCornerRots(idx, 1, 1, 0)).toEqual([]);
  });
  test("pad: snapping to each outer corner auto-rotates the ghost outward (rot 0 requested) and A places it", () => {
    const s = ring(); s.bm.start({ piece: s.d.pieceId("wall_corner_outer"), tier: 0, variant: 0, paint: 0 });
    for (const [x, y, r] of [[0, 0, 0], [3, 0, 1], [3, 3, 2], [0, 3, 3]] as const) {
      const p = aimAt(s, x + 0.3, y + 0.3); expect([p.x, p.y], JSON.stringify(p)).toEqual([x, y]); expect(p.valid).toBe(true); expect(p.request.rot).toBe(r); expect(p.rot).toBe(r); expect(p.magnet).toBe(true);
    }
    s.btn("pad.a"); const a = s.sent.at(-1)!.args as unknown as { rot: number; x: number; y: number };
    expect(G.tryPlace(s.w, s.me, req(s, "wall_corner_outer", a.x, a.y, a.rot)).ok).toBe(true);
  });
  test("mouse/touch aim inside the corner tile snaps the same way; a taken corner moves to the next one", () => {
    const s = ring(); const sel = { piece: s.d.pieceId("wall_corner_outer"), tier: 0, variant: 0, paint: 0 };
    const p = G.buildPreviewFor(s.w, s.me, sel, 0, { mode: 1, x: 2.7, y: 0.4 }, 0)!; expect([p.x, p.y, p.rot, p.valid]).toEqual([3, 0, 1, true]);
    const t = G.buildPreviewFor(s.w, s.me, sel, 0, { mode: 1, x: 2.7, y: 0.4 }, 0, true)!; expect([t.x, t.y, t.rot, t.valid]).toEqual([3, 0, 1, true]);
    expect(G.tryPlace(s.w, s.me, req(s, "wall_corner_outer", 3, 0, 1)).ok).toBe(true);
    const q = G.buildPreviewFor(s.w, s.me, sel, 0, { mode: 1, x: 2.7, y: 0.4 }, 0)!; expect(q.valid).toBe(false); // only corner in reach is taken
  });
  test("RB overrides the auto-fit in place (red when it no longer wraps the deck); another corner re-enables it", () => {
    const s = ring(); s.bm.start({ piece: s.d.pieceId("wall_corner_outer"), tier: 0, variant: 0, paint: 0 });
    expect(aimAt(s, 2.7, 2.7).request.rot).toBe(2);
    s.btn("pad.rb"); let p = s.bm.preview!; expect([p.x, p.y, p.request.rot, p.valid]).toEqual([3, 3, 3, false]);
    s.btn("pad.rb"); s.btn("pad.rb"); s.btn("pad.rb"); p = s.bm.preview!; expect([p.x, p.y, p.request.rot, p.valid]).toEqual([3, 3, 2, true]);
    expect(aimAt(s, 0.3, 2.7).request.rot).toBe(3);
  });
});

describe("ADR-211 L corners: server rules", () => {
  test("the L claims both arm edges: blocks movement across them, frees them on removal", () => {
    const s = ring(); const idx = G.structures(s.w);
    const r = G.tryPlace(s.w, s.me, req(s, "wall_corner_outer", 0, 0, 0)); expect(r.ok).toBe(true);
    const e = idx.edge(0, 0, 0, G.EdgeSide.North); expect(e).toBeTruthy(); expect(idx.edge(0, 0, 0, G.EdgeSide.West)).toBe(e);
    expect(G.movementBlocked(s.w, 0.5, -0.5, 0.5, 0.5, 0)).toBe(true); expect(G.movementBlocked(s.w, -0.5, 0.5, 0.5, 0.5, 0)).toBe(true);
    expect(G.movementBlocked(s.w, 0.5, 0.5, 1.5, 0.5, 0)).toBe(false);
    G.destroyPiece(s.w, e as never, 0 as G.DestroyCause); expect(idx.edge(0, 0, 0, G.EdgeSide.North)).toBe(0); expect(idx.edge(0, 0, 0, G.EdgeSide.West)).toBe(0);
  });
  test("validation: off-deck NoSupport, arm over a wall Occupied, straight walls rejected from corner slots (single or 90° pair)", () => {
    const s = ring(); const v = (k: string, x: number, y: number, rot = 0) => { const sn = G.snapPlacement(s.w, req(s, k, x, y, rot)); return typeof sn === "number" ? sn : G.validatePlacement(s.w, s.me, sn, { ignoreCost: true }); };
    expect(v("wall_corner_outer", 0, 0, 2)).toBe(G.BuildFail.NoSupport); // wraps the empty tile (-1,-1)
    expect(v("wall", 0.5, 0)).toBe(G.BuildFail.CornerSlot); expect(v("wall", 0, 0.5)).toBe(G.BuildFail.CornerSlot);
    expect(v("wall", 2.5, 3)).toBe(G.BuildFail.CornerSlot); expect(v("wall", 3, 2.5)).toBe(G.BuildFail.CornerSlot);
    expect(v("wall", 1.5, 0)).toBe(0); expect(v("wall", 1, 1.5)).toBe(0); // mid outer edge + interior edge stay free
    expect(v("wall_doorway", 0.5, 0)).toBe(0); // opening frames are not straight walls (small huts keep a door)
    s.place("wall", 1.5, 0); expect(v("wall_corner_outer", 1, 0, 0)).not.toBe(0);
  });
  test("closed ring: 4 L corners + straight walls between them seal the room", () => {
    const s = ring(); for (const [x, y, r] of [[0, 0, 0], [3, 0, 1], [3, 3, 2], [0, 3, 3]] as const) expect(G.tryPlace(s.w, s.me, req(s, "wall_corner_outer", x, y, r)).ok).toBe(true);
    for (const [x, y] of [[1.5, 0], [1.5, 3], [0, 1.5], [3, 1.5]] as const) s.place("wall", x, y);
    for (const [x, y] of [[0.5, -0.5], [1.5, -0.5], [2.5, -0.5], [-0.5, 1.5], [3.5, 2.5]] as const) expect(G.movementBlocked(s.w, x, y, Math.min(2.5, Math.max(0.5, x)), Math.min(2.5, Math.max(0.5, y)), 0), `${x},${y}`).toBe(true);
  });
  test("save migration: a 90° pair of plain walls on an outer corner loads as one L (lower tier); singles/doorways untouched", () => {
    const s = ring(); const d = s.d; const idx = G.structures(s.w);
    // legacy layout written by the pre-ADR-211 rules: bypass validation via the codec's own placePiece path
    const lh = d.building.levelHeight; const put = (k: string, x: number, y: number, tier: number, rot = 0) => { const def = d.pieces.get(d.pieceId(k))!; const slot = G.slotFromPos(def, x, y, 0, rot); return G.placePiece(s.w, 0 as never, { def, slot, parent: 0 as never, pos: G.slotTransform(def, slot, lh, x, y), tier, variant: 0 }, { pay: false }); };
    put("wall", 0.5, 0, 2); put("wall", 0, 0.5, 1, 1); put("wall", 2.5, 0, 1); put("wall_doorway", 3, 2.5, 1, 3); put("wall", 2.5, 3, 1, 2);
    const blob = G.encodeStructures(s.w, 0, 0);
    const w2 = setup().w; G.decodeStructures(w2, blob); const i2 = G.structures(w2); const d2 = G.gameplayDefs(w2);
    const at = (tx: number, ty: number, side: G.EdgeSide) => { const e = i2.edge(tx, ty, 0, side); return e ? d2.pieces.get(w2.getField(e, G.BuildPiece, "type")!)!.key : ""; };
    expect(at(0, 0, G.EdgeSide.North)).toBe("wall_corner_outer"); expect(i2.edge(0, 0, 0, G.EdgeSide.North)).toBe(i2.edge(0, 0, 0, G.EdgeSide.West));
    expect(w2.getField(i2.edge(0, 0, 0, G.EdgeSide.North) as never, G.BuildPiece, "tier")).toBe(1);
    expect(at(2, 0, G.EdgeSide.North)).toBe("wall"); expect(at(3, 2, G.EdgeSide.West)).toBe("wall_doorway"); expect(at(2, 3, G.EdgeSide.North)).toBe("wall");
    expect(G.encodeStructures(w2, 0, 0)).toEqual(G.encodeStructures((() => { const w3 = setup().w; G.decodeStructures(w3, G.encodeStructures(w2, 0, 0)); return w3; })(), 0, 0)); // idempotent
    void idx;
  });
});

describe("ADR-211 art", () => {
  test("twig corner sprites point at the twig corner page", () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/building/manifest.building.json"), "utf8")) as Record<string, unknown>;
    const txt = JSON.stringify(m); expect(txt).toContain("building_tw");
    const sprites = (Array.isArray(m) ? m : (m.sprites ?? {})) as Record<string, { atlas?: string }> | { key: string; atlas?: string }[];
    const list = Array.isArray(sprites) ? sprites : Object.entries(sprites).map(([key, v]) => ({ key, ...v }));
    for (const k of ["bld_wall_corner_outer", "bld_wall_corner_inner", "bld_wall_corner_angled"]) expect(list.find((e) => e.key === k)?.atlas, k).toBe("building_tw");
  });
  test("building atlases are recognised (demoted last under a tight budget)", () => {
    for (const k of ["buildings", "buildings_twig", "building_tw", "openings", "furniture"]) expect(BUILD_ATLAS_RE.test(k), k).toBe(true);
    for (const k of ["terrain", "creatures", "items"]) expect(BUILD_ATLAS_RE.test(k), k).toBe(false);
  });
});

describe("ADR-211 L corners: render expansion", () => {
  test("render arm pivots/rots match the gameplay arm edges for every rotation (no gaps/overlaps at the joint)", () => {
    for (let r = 0; r < 4; r++) for (const [vx, vy] of [[0, 0], [5, -3]] as const) {
      const g = G.lCornerArms(vx, vy, r), rr = lCornerArmPivots(vx, vy, r);
      expect(rr).toEqual(g.map((a) => ({ x: a.x, y: a.y, rot: a.wallRot })));
      for (const a of rr) expect(Math.hypot(a.x - vx, a.y - vy)).toBeCloseTo(0.5); // each arm spans vertex -> next vertex
      const [ax, ay] = G.lCornerTile(vx, vy, r); for (const a of rr) expect(Math.abs(a.x - (ax + 0.5)) + Math.abs(a.y - (ay + 0.5))).toBeCloseTo(0.5); // on the wrapped tile's edges
    }
  });
  test("every tier's L draws that tier's straight wall on its arms", () => {
    expect(lCornerArmPiece("wall_corner_outer")).toBe("wall");
    for (let t = 1; t <= 4; t++) expect(lCornerArmPiece(`wall_corner_outer@tier${t}`)).toBe(`wall@tier${t}`);
    expect(lCornerArmPiece("wall_corner_inner")).toBeUndefined(); expect(lCornerArmPiece("wall")).toBeUndefined();
  });
});

