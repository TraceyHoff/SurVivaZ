// @vitest-environment jsdom
// ADR-313: hidden-ledge warnings look ahead along the travel heading (speed x 2 s + 1 tile) so a sprinting player
// has ~2 s to stop; the Settings toggle still hides them.
import { afterEach, describe, expect, test, vi } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import {
  LEDGE_MAX_HINTS, LEDGE_MIN_RANGE, LedgeMotionTracker, ledgeAlpha, ledgeLookahead, mountLedgeWarning, pickLedgeHint, pickLedgeHints,
} from "../src/ledge-warning.js";

const WALK = 2.9, SPRINT = 2.9 * 1.6;
const WEST = Math.PI; // q0: west (-x) is a camera-hidden side
/** A cliff: tiles x <= 3 are 10 tiles lower than the plateau (height 20) the player is on. */
const cliff = (tx: number) => (tx <= 3 ? 10 : 20);
const heightAt = (tx: number, _ty: number) => cliff(tx);

describe("ADR-313 ledge lookahead range", () => {
  test("range scales with speed: walk ~6.8 tiles, sprint ~10.3 tiles (>= 2 s of travel), idle 3 tiles", () => {
    expect(ledgeLookahead(0)).toBe(LEDGE_MIN_RANGE);
    expect(ledgeLookahead(WALK)).toBeCloseTo(6.8, 5);
    expect(ledgeLookahead(SPRINT)).toBeCloseTo(10.28, 5);
    expect(ledgeLookahead(SPRINT) / SPRINT).toBeGreaterThanOrEqual(2);
    expect(ledgeLookahead(WALK) / WALK).toBeGreaterThanOrEqual(2);
    expect(ledgeLookahead(100)).toBe(14);
  });
  test("a hidden ledge 6.5 tiles ahead shows while walking toward it (the old rim check did not)", () => {
    const o = { x: 10.5, y: 10.5, viewQ: 0, hp: 100, heightAt, facing: WEST };
    expect(pickLedgeHint(o)).toBeUndefined(); // ADR-306 only looked at the tile underfoot
    const hints = pickLedgeHints({ ...o, heading: WEST, range: ledgeLookahead(WALK) });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ drop: 10, risk: "hurt", dx: -1, dy: 0 });
    expect(hints[0]!.dist).toBeCloseTo(6.5, 5);
    expect(hints[0]!.dist! / WALK).toBeGreaterThan(2); // seconds to react
  });
  test("sprinting sees farther: 8.5 tiles ahead is out of walk range but in sprint range (~1.8 s to stop)", () => {
    const o = { x: 12.5, y: 10.5, viewQ: 0, hp: 100, heightAt, facing: WEST, heading: WEST };
    expect(pickLedgeHints({ ...o, range: ledgeLookahead(WALK) })).toHaveLength(0);
    const s = pickLedgeHints({ ...o, range: ledgeLookahead(SPRINT) });
    expect(s).toHaveLength(1); expect(s[0]!.dist! / SPRINT).toBeGreaterThan(1.5);
  });
  test("walking away, or a visible (camera-near) drop, shows nothing", () => {
    expect(pickLedgeHints({ x: 10.5, y: 10.5, viewQ: 0, hp: 100, heightAt, facing: 0, heading: 0, range: 10 })).toHaveLength(0);
    const east = (tx: number) => (tx >= 14 ? 10 : 20); // +x is camera-near at q0
    expect(pickLedgeHints({ x: 10.5, y: 10.5, viewQ: 0, hp: 100, heightAt: (tx) => east(tx), facing: 0, heading: 0, range: 10 })).toHaveLength(0);
  });
  test("a cliff face up ahead blocks the ray (no warning for ledges behind a wall of rock)", () => {
    const h = (tx: number) => (tx <= 3 ? 10 : tx === 7 ? 30 : 20);
    expect(pickLedgeHints({ x: 10.5, y: 10.5, viewQ: 0, hp: 100, heightAt: (tx) => h(tx), heading: WEST, range: 10 })).toHaveLength(0);
  });
  test("keeps colors / HP rules and shows at most a few nearest ledges, fading with distance", () => {
    const lethal = pickLedgeHints({ x: 10.5, y: 10.5, viewQ: 0, hp: 50, heightAt: (tx) => (tx <= 7 ? 5 : 20), heading: WEST, range: 10 });
    expect(lethal[0]).toMatchObject({ drop: 15, risk: "lethal" });
    // a staircase of 1-tile hidden steps along both hidden sides: never more than LEDGE_MAX_HINTS, nearest first
    const many = pickLedgeHints({ x: 10.5, y: 10.5, viewQ: 0, hp: 100, heightAt: (tx, ty) => tx + ty, heading: -3 * Math.PI / 4, range: 14 });
    expect(many.length).toBeGreaterThan(0); expect(many.length).toBeLessThanOrEqual(LEDGE_MAX_HINTS);
    for (let i = 1; i < many.length; i++) expect(many[i]!.dist!).toBeGreaterThanOrEqual(many[i - 1]!.dist!);
    expect(ledgeAlpha(0.5, 10)).toBe(1); expect(ledgeAlpha(10, 10)).toBeCloseTo(0.35, 5);
    expect(ledgeAlpha(5, 10)).toBeLessThan(1); expect(ledgeAlpha(5, 10)).toBeGreaterThan(0.35);
  });
  test("the rim under the player still shows at distance 0 (ADR-306 behaviour kept)", () => {
    const h = (tx: number, ty: number) => (tx === 9 && ty === 10 ? 16 : 20);
    const hints = pickLedgeHints({ x: 10.2, y: 10.5, viewQ: 0, hp: 100, heightAt: h });
    expect(hints[0]).toMatchObject({ drop: 4, risk: "hurt", dx: -1, dy: 0 });
  });
});

describe("ADR-313 motion tracking and toggle", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  test("the tracker measures sprint speed and heading from Transform between frames", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 10 }); G.installGameplay(w, {}); const p = G.spawnPlayer(w, { x: 20, y: 20 });
    const tr = new LedgeMotionTracker(); let t = 0, x = 20;
    let m = tr.sample(w, p, t);
    for (let i = 0; i < 40; i++) { t += 50; x -= SPRINT * 0.05; w.setField(p, Transform, "x", x); m = tr.sample(w, p, t); }
    expect(m.speed).toBeCloseTo(SPRINT, 1); expect(Math.abs(Math.abs(m.heading!) - Math.PI)).toBeLessThan(1e-6);
    expect(ledgeLookahead(m.speed)).toBeGreaterThan(10);
  });
  test("Settings toggle off: no arrows and no ledge scan at all", () => {
    let cb: FrameRequestCallback | undefined; vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { cb = f; return 1; }); vi.stubGlobal("cancelAnimationFrame", () => {});
    const root = document.createElement("div"); document.body.append(root);
    const world = vi.fn(() => new World({ seed: 1 }));
    const h = mountLedgeWarning(root, { world, player: () => undefined, camera: () => ({}) as never, hidden: () => false, enabled: () => false, alpha: () => 1 });
    cb!(0); cb!(16);
    const cv = root.querySelector<HTMLCanvasElement>("#ledge-warning")!;
    expect(cv.dataset["count"] ?? "").toBe(""); expect(world).not.toHaveBeenCalled();
    h.destroy();
  });
});
