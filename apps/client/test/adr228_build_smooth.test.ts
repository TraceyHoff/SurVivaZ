// @vitest-environment jsdom
/** ADR-228: smoother build placement — throttled per-frame refresh, memoized validation in a preview pass, cheap target scan. */
import { describe, expect, test } from "vitest";
import { installPermissions, Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { InputSystem, KeyboardMouseDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { BuildMode, REFRESH_MAX_MS, REFRESH_STEP } from "../src/build-mode.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  plantClaim(w, me, -2, 2);
  for (const k of ["sticks", "planks", "rope", "stone"]) G.addItem(w, me, d.itemId(k), 50);
  const clock = { t: 0, now: () => clock.t };
  const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  sys.addDevice(new KeyboardMouseDevice()); sys.push("Gameplay");
  const aim = { x: 2, y: 0.5, mode: 1 };
  const bm = new BuildMode({ input: sys, ctx: () => ({ world: w, player: me, names: new Map() }), aim: () => aim, send: () => true, device: () => "keyboardMouse", now: () => clock.t });
  const frame = (ms = 16) => { clock.t += ms; sys.update(); bm.update(); };
  return { w, me, d, bm, aim, frame, clock };
}

describe("ADR-228 build placement smoothness", () => {
  test("per-frame refresh is skipped while only the aim jitters; big moves, time, actions and world changes refresh", () => {
    const s = setup(); s.bm.start({ piece: s.d.pieceId("foundation"), tier: 0, variant: 0, paint: 0 }); s.frame();
    const n0 = s.bm.refreshes;
    for (let i = 0; i < 4; i++) { s.aim.x += REFRESH_STEP / 8; s.frame(10); }
    expect(s.bm.refreshes).toBe(n0); // sub-step jitter within REFRESH_MAX_MS: reused
    s.aim.x += REFRESH_STEP; s.frame(10); expect(s.bm.refreshes).toBe(n0 + 1); // moved a step
    s.frame(REFRESH_MAX_MS); expect(s.bm.refreshes).toBe(n0 + 2); // time cap
    s.bm.rotate(1); expect(s.bm.refreshes).toBe(n0 + 3); // explicit action always refreshes
    const r = G.tryPlace(s.w, s.me, { piece: s.d.pieceId("foundation"), x: 2.5, y: 1.5, level: 0, rot: 0, tier: 0, variant: 0 }); expect(r.ok).toBe(true);
    s.frame(1); expect(s.bm.refreshes).toBe(n0 + 4); // structure count changed
    s.aim.x = 2.5; s.aim.y = 1.5; s.frame(1); expect(s.bm.target?.entity).toBeDefined(); // aim jumped: target found right away
  });
  test("one preview pass validates each distinct snapped slot once and gives the same answer every time", () => {
    const s = setup(); const sel = { piece: s.d.pieceId("foundation"), tier: 0, variant: 0, paint: 0, autoRot: true };
    for (let y = -1; y <= 1; y++) for (let x = 1; x <= 3; x++) { const sn = G.snapPlacement(s.w, { piece: sel.piece, x: x + 0.5, y: y + 0.5, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn !== "number") G.placePiece(s.w, s.me, sn, { pay: false }); }
    expect(G.structures(s.w).count).toBe(10);
    const before = { ...G.previewStats };
    // gamepad-style assist pass on an occupied cell: magnet + 16-offset ring
    const a = G.buildPreviewFor(s.w, s.me, sel, 0, { mode: 1, x: 2.6, y: 0.4 }, 0, true);
    const validated = G.previewStats.validated - before.validated, reused = G.previewStats.reused - before.reused;
    expect(reused).toBeGreaterThan(0); expect(validated).toBeLessThan(validated + reused);
    const b = G.buildPreviewFor(s.w, s.me, sel, 0, { mode: 1, x: 2.6, y: 0.4 }, 0, true);
    expect(b).toEqual(a); expect(a?.valid).toBe(false); expect(validated).toBeLessThanOrEqual(9); // ring: 16 offsets, <= 9 distinct cells
  });
  test("pieceTargetAt (aim-box reject, field reads) matches the brute-force nearest piece", () => {
    const s = setup(); const f = s.d.pieceId("foundation");
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) G.tryPlace(s.w, s.me, { piece: f, x: x + 0.5, y: y + 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    const brute = (at: { x: number; y: number }) => { let best: number | undefined, bd = Infinity;
      for (const e of s.w.query([G.BuildPiece, Transform], [G.Dead])) { const t = s.w.get(e, Transform)!; const dd = Math.hypot(t.x - at.x, t.y - at.y); if (dd <= 0.9 && dd < bd) { bd = dd; best = e; } } return best; };
    let rng = 7; const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32) * 6 - 3;
    for (let i = 0; i < 200; i++) { const at = { x: rnd(), y: rnd() }; expect(G.pieceTargetAt(s.w, s.me, at, 0)?.entity).toBe(brute(at)); }
  });
});
