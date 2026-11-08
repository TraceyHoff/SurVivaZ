// @vitest-environment jsdom
/** ADR-210: corner posts in every tier (twig included), placed with the gamepad only; auto-snap to wall junctions. */
import { describe, expect, test } from "vitest";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { InputSystem, KeyboardMouseDevice, GamepadDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
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

describe("ADR-210 corners", () => {
  test("corner pieces are unlocked from twig (tier 0) up to the top tier", () => {
    const d = G.defaultDefs();
    for (const k of ["wall_corner_inner", "wall_corner_outer", "wall_corner_angled"]) {
      const def = d.pieces.get(d.pieceId(k))!; expect(def.minTier).toBe(0);
      for (let t = 0; t < d.tiers.length; t++) expect(G.pieceCost(d, def, t).length, `${k} t${t}`).toBeGreaterThan(0);
    }
  });
  test("pad only: right stick to a wall junction, RB rotates 90° x4, A places the corner on the vertex (twig tier)", () => {
    const s = setup();
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) s.place("foundation", x + 0.5, y + 0.5);
    const corner = s.d.pieceId("wall_corner_outer"); // ADR-211: an L that wraps the deck's outer corner (0,0)
    s.bm.start({ piece: corner, tier: 0, variant: 0, paint: 0 });
    s.pad.set("pad.ry", -1); for (let i = 0; i < 30; i++) s.tick(); s.pad.set("pad.ry", 0); s.tick(); // cursor up toward the corner
    s.bm.padOffset = { x: 0.1, y: -2.4 }; s.tick(); // aim (0.6, 0.1): the outer corner (0,0) is 0.61 away
    const p = s.bm.preview!; expect(p.reason, JSON.stringify(p)).toBe(0); expect(p.valid).toBe(true); expect([p.x, p.y]).toEqual([0, 0]); expect(p.magnet).toBe(true); expect(p.rot).toBe(0);
    for (let r = 1; r <= 4; r++) { s.btn("pad.rb"); expect(s.bm.rot).toBe(r % 4); expect([s.bm.preview!.x, s.bm.preview!.y]).toEqual([0, 0]); expect(s.bm.preview!.valid).toBe(r % 4 === 0); }
    s.btn("pad.a"); expect(s.sent.map((i) => i.cmd.name)).toEqual(["gameplay.place"]); expect((s.sent[0]!.args as unknown as { x: number }).x).toBe(0);
    const args = s.sent[0]!.args as unknown as { x: number; y: number; rot: number; tier: number };
    const r = G.tryPlace(s.w, s.me, { piece: corner, x: args.x, y: args.y, level: 0, rot: args.rot, tier: args.tier, variant: 0 }); expect(r.ok).toBe(true);
  });
  test("server validation: a corner needs a deck at one of the four tiles around the vertex", () => {
    const s = setup(); const corner = s.d.pieceId("wall_corner_inner");
    expect(G.tryPlace(s.w, s.me, { piece: corner, x: 2, y: 1, level: 0, rot: 0, tier: 0, variant: 0 }).ok).toBe(false);
    s.place("foundation", 1.5, 0.5);
    expect(G.tryPlace(s.w, s.me, { piece: corner, x: 2, y: 1, level: 0, rot: 2, tier: 0, variant: 0 }).ok).toBe(true);
  });
  test("an L corner blocks crossing its arms, not walking inside the tile it wraps (ADR-211)", () => {
    const s = setup(); s.place("foundation", 3.5, 3.5); expect(G.tryPlace(s.w, s.me, { piece: s.d.pieceId("wall_corner_outer"), x: 3, y: 3, level: 0, rot: 0, tier: 0, variant: 0 }).ok).toBe(true);
    expect(G.movementBlocked(s.w, 2.5, 3.5, 3.5, 3.5, 0)).toBe(true); expect(G.movementBlocked(s.w, 3.5, 3.5, 3.5, 4.5, 0)).toBe(false);
  });
});
