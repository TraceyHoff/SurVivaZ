/**
 * ADR-347: the Place/Move command carries the hologram's snapped slot (preview.x/y/rot), not the raw aim
 * (preview.request). Magnet / snap-assist / claim bump / corner auto-fit all move the ghost off the raw
 * request, so a command carrying the request re-snaps somewhere else; fine pieces also need the FINE_ROT
 * flag re-attached, since preview.rot is the bare 15° step.
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Transform, World } from "@engine/core";
import * as G from "../src/index.js";
import { FINE_ROT } from "../src/building/structure.js";
import { plantClaim } from "./helpers.js";

function setup() {
  const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w);
  const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1, maxWeight: 0 }), d = G.gameplayDefs(w);
  plantClaim(w, p, -2, 2);
  for (const k of ["sticks", "planks", "rope", "stone", "cloth", "fiber", "wood"]) G.addItem(w, p, d.itemId(k), 99);
  return { w, p, d };
}

describe("ADR-347 placePreviewIntent sends the hologram's slot", () => {
  it("assist-hopped ghost: the intent carries the ghost's cell, not the ring point it hopped from", () => {
    const { w, p, d } = setup(); const foundation = d.pieceId("foundation");
    const taken = G.tryPlace(w, p, { piece: foundation, x: 2.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(taken.ok).toBe(true);
    // Gamepad-style assist (assist on): the taken aim hops to the neighbouring free cell.
    const ghost = G.buildPreviewFor(w, p, { piece: foundation, tier: 0, variant: 0, paint: 0 }, 0, { x: 2.5, y: 0.5, mode: 1 }, 0, true)!;
    expect(ghost.valid).toBe(true); expect(ghost.assisted).toBe(true);
    expect(ghost.request.x).not.toBeCloseTo(ghost.x); // the raw aim / ring point is not the snapped slot
    const intent = G.placePreviewIntent(ghost);
    expect(intent).toMatchObject({ cmd: G.PlaceCmd, args: { piece: foundation, x: ghost.x, y: ghost.y, rot: ghost.rot } });
    const placed = G.tryPlace(w, p, intent.args as unknown as G.PlaceRequest);
    expect(placed.ok).toBe(true);
    if (placed.ok) expect(w.get(placed.piece, Transform)).toMatchObject({ x: ghost.x, y: ghost.y });
  });
  it("fine placement (snap off): the intent keeps the 15° step and the 1/16-tile slot", () => {
    const { w, p, d } = setup(); const rug = d.pieceId("rug");
    const floor = G.tryPlace(w, p, { piece: d.pieceId("foundation"), x: 2.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(floor.ok).toBe(true); // the rug needs a floor beneath it (NoSupport on bare ground)
    const ghost = G.buildPreviewFor(w, p, { piece: rug, tier: 0, variant: 0, paint: 0 }, FINE_ROT | 5, { x: 2.37, y: 0.62, mode: 1 })!;
    expect(ghost.valid).toBe(true); expect(ghost.fine).toBe(true); expect(ghost.rot).toBe(5);
    expect(ghost).toMatchObject({ x: 2.375, y: 0.625 }); // 1/16-tile quantised, not the raw aim
    const intent = G.placePreviewIntent(ghost);
    expect(intent).toMatchObject({ cmd: G.PlaceCmd, args: { piece: rug, x: 2.375, y: 0.625, rot: FINE_ROT | 5 } });
    const placed = G.tryPlace(w, p, intent.args as unknown as G.PlaceRequest);
    expect(placed.ok).toBe(true);
    if (placed.ok) expect(w.get(placed.piece, Transform)).toMatchObject({ x: 2.375, y: 0.625 });
  });
  it("moveIntent sends the move ghost's snapped slot too", () => {
    const { w, p, d } = setup(); const foundation = d.pieceId("foundation");
    const first = G.tryPlace(w, p, { piece: foundation, x: 2.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(first.ok).toBe(true);
    const piece = first.ok ? first.piece : 0 as never;
    // The blocker must not be a structural dependent of the moved piece (else the lift itself is refused):
    // put it a few cells away, and aim the move ghost at it.
    const blocker = G.tryPlace(w, p, { piece: foundation, x: 0.5, y: -1.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(blocker.ok).toBe(true);
    // Aim the move ghost at the blocker's cell: it assist-hops to the neighbouring free cell.
    const ghost = G.buildPreviewFor(w, p, { piece: foundation, tier: 0, variant: 0, paint: 0, moving: piece }, 0, { x: 0.5, y: -1.5, mode: 1 }, 0, true)!;
    expect(ghost.valid).toBe(true); expect(ghost.assisted).toBe(true);
    expect(ghost.request.x).not.toBeCloseTo(ghost.x);
    const intent = G.moveIntent(piece, ghost);
    expect(intent).toMatchObject({ cmd: G.MoveCmd, args: { target: piece, x: ghost.x, y: ghost.y, rot: ghost.rot } });
    // Re-snapping the sent slot reproduces the ghost exactly (the server re-snaps the command the same way).
    const sn = G.snapPlacement(w, { piece: foundation, x: ghost.x, y: ghost.y, level: 0, rot: ghost.rot, tier: 0, variant: 0 });
    expect(typeof sn).not.toBe("number");
    if (typeof sn !== "number") expect(sn.pos).toMatchObject({ x: ghost.x, y: ghost.y });
  });
});
