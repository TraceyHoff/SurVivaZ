/**
 * ADR-212 walker collision: foundations are walked on at deck-top height with a smooth step-up; walls, L corners,
 * window walls, stations and closed doors block a body (bodyRadius) while open doors and doorways let it through;
 * the same function drives server authority and client prediction (deterministic replay), and zombies collide too.
 */
import { describe, it, expect } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { applyMovementInput, defaultDefs, DoorState, placePiece, PieceLink, snapPlacement, spawnPlayer, spawnZombie, validatePlacement, AttachKind, structures } from "../src/index.js";
import { resolveAttachment } from "../src/building/links.js";
import { makeWorld, steps, spawnLearned } from "./helpers.js";

const d = defaultDefs(); const DT = 1 / 20; const R = d.movement.bodyRadius;
function base(): { w: World; me: Entity; put: (key: string, x: number, y: number, level?: number, rot?: number) => Entity } {
  const w = makeWorld(); const me = spawnLearned(w, { x: -6, y: -6, maxWeight: 0, clientId: 1 });
  const put = (key: string, x: number, y: number, level = 0, rot = 0): Entity => {
    const sn = snapPlacement(w, { piece: d.pieceId(key), x, y, level, rot, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`setup ${key} snap ${sn}`);
    const f = validatePlacement(w, me, sn, { ignoreCost: true, ignoreRange: true }); if (f) throw new Error(`setup ${key} @${x},${y}: ${f}`);
    const e = placePiece(w, me, sn, { pay: false }); steps(w, 1); return e as Entity;
  };
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) put("foundation", x + 0.5, y + 0.5);
  // room on tile (2,2): doorway N (y=2), window wall S (y=3), walls W (x=2) / E (x=3)
  put("wall_doorway", 2.5, 2); put("wall_window", 2.5, 3); put("wall", 2, 2.5, 0, 1); put("wall", 3, 2.5, 0, 1);
  steps(w, 2); return { w, me, put };
}
const at = (w: World, e: Entity): { x: number; y: number; z: number } => { const t = w.get(e, Transform)!; return { x: t.x, y: t.y, z: t.z ?? 0 }; };
const tp = (w: World, e: Entity, x: number, y: number, z = 0): void => { w.set(e, Transform, { x, y, z }); };
/** Walk with a world-space direction (dx, dy) for n ticks (screen analog derived from the iso mapping). */
function walk(w: World, e: Entity, dx: number, dy: number, n: number, trace?: { x: number; y: number; z: number }[]): void {
  const sx = (dx - dy) * Math.SQRT1_2, sy = (dx + dy) * Math.SQRT1_2;
  for (let i = 0; i < n; i++) { applyMovementInput(w, e, 0, DT, { x: sx, y: sy }); trace?.push(at(w, e)); }
}

describe("ADR-212 walker collision", () => {
  it("foundations are walked on at deck-top height with a smooth step-up and step-down", () => {
    const { w, me } = base(); tp(w, me, -1.5, 0.5);
    const tr: { x: number; y: number; z: number }[] = []; walk(w, me, 1, 0, 30, tr); // ADR-289: auto-run would carry 40 ticks beyond the deck
    expect(at(w, me).x).toBeGreaterThan(1.5); // walked onto the deck (foundations are not obstacles)
    expect(at(w, me).z).toBeCloseTo(d.movement.deckStandHeight, 5);
    for (let i = 1; i < tr.length; i++) { const dz = tr[i]!.z - tr[i - 1]!.z; expect(dz).toBeGreaterThanOrEqual(-1e-9); expect(dz).toBeLessThanOrEqual(d.movement.stepRate * DT + 1e-6); }
    expect(tr.filter((p) => p.z > 0 && p.z < d.movement.deckStandHeight).length).toBeGreaterThanOrEqual(2); // eased, not popped
    tp(w, me, 4.5, 0.5, d.movement.deckStandHeight); walk(w, me, 1, 0, 30);
    expect(at(w, me).x).toBeGreaterThan(5.5); expect(at(w, me).z).toBe(0); // off the deck back to the ground
  });
  it("walls, a window wall and side walls block the body; the doorway lets it through", () => {
    const { w, me } = base();
    tp(w, me, 2.5, 2.5, 0.75); walk(w, me, -1, 0, 30); expect(at(w, me).x).toBeGreaterThanOrEqual(2 + R - 1e-3);
    tp(w, me, 2.5, 2.5, 0.75); walk(w, me, 1, 0, 30); expect(at(w, me).x).toBeLessThanOrEqual(3 - R + 1e-3);
    tp(w, me, 2.5, 2.5, 0.75); walk(w, me, 0, 1, 30); expect(at(w, me).y).toBeLessThanOrEqual(3 - R + 1e-3);
    tp(w, me, 2.5, 2.5, 0.75); walk(w, me, 0, -1, 30); expect(at(w, me).y).toBeLessThan(1); // out through the doorway
    // jamb: entering off-centre never clips the side wall; the doorway assist slides the body in
    tp(w, me, 2.1, 1.4, 0.75); walk(w, me, 0, 1, 40); const p = at(w, me);
    expect(p.y).toBeGreaterThan(2.2); expect(p.x).toBeGreaterThanOrEqual(2 + R - 1e-3);
  });
  it("closed doors block, open doors pass", () => {
    const { w, me, put } = base(); const door = put("door_wood", 2.5, 2); steps(w, 2);
    const att = resolveAttachment(w, door, AttachKind.Door)!; expect(att).toBeDefined();
    expect(w.get(att, DoorState)!.open).toBe(0);
    tp(w, me, 2.5, 2.5, 0.75); walk(w, me, 0, -1, 30); expect(at(w, me).y).toBeGreaterThanOrEqual(2 + R - 1e-3);
    w.setField(att, DoorState, "open", 1); structures(w).version++;
    walk(w, me, 0, -1, 30); expect(at(w, me).y).toBeLessThan(1);
    void door; void PieceLink;
  });
  it("stations and furniture block; an L corner's arms block", () => {
    const { w, me, put } = base();
    put("workbench", 1, 3.5); tp(w, me, -1.5, 3.5); walk(w, me, 1, 0, 40); expect(at(w, me).x).toBeLessThanOrEqual(0 - R + 1e-3 + 0); // stopped before the bench tile
    put("wall_corner_outer", 5, 0, 0, 1); // wraps tile (4,0): arms on its north and east edges
    tp(w, me, 4.5, 0.5, 0.75); walk(w, me, 1, 0, 30); expect(at(w, me).x).toBeLessThanOrEqual(5 - R + 1e-3);
    tp(w, me, 4.5, 0.5, 0.75); walk(w, me, 0, -1, 30); expect(at(w, me).y).toBeGreaterThanOrEqual(0 + R - 1e-3);
  });
  it("prediction replay: the same inputs from the same state give bit-identical positions (no rubber-band)", () => {
    const run = (): string => { const { w, me } = base(); tp(w, me, -1.5, 1.7); const tr: { x: number; y: number; z: number }[] = [];
      walk(w, me, 1, 0.3, 60, tr); walk(w, me, 0.2, 1, 40, tr); walk(w, me, -1, -0.6, 50, tr); return JSON.stringify(tr); };
    expect(run()).toBe(run());
  });
  it("zombies collide with walls and stand on decks", () => {
    const { w } = base(); const z = spawnZombie(w, d.zombies.keys().next().value!, 2.5, 2.5, 0) as Entity;
    w.set(z, Transform, { x: 2.5, y: 2.5 });
    for (let i = 0; i < 200; i++) { w.step(DT); const p = at(w, z); expect(p.x).toBeGreaterThanOrEqual(2 + R - 1e-3); expect(p.x).toBeLessThanOrEqual(3 - R + 1e-3); expect(p.y).toBeLessThanOrEqual(3 - R + 1e-3); if (p.y < 2) break; }
  });
});
