import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

describe("ADR-303 house doors and supported floors", () => {
  it("Interact at an abandoned house door targets the door, not interior loot", () => {
    const w = makeWorld();
    installPermissions(w);
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    expect(r.skipped).toBe(false);
    const defs = G.gameplayDefs(w);
    const door = r.placed.find((e) => defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key === "door_wood");
    expect(door).toBeDefined();
    const dt = w.get(door!, Transform)!;
    const me = spawnLearned(w, { x: dt.x, y: dt.y + 0.45, clientId: 1 });
    w.add(me, PlayerId, { id: 1 });
    const pick = G.interactPanel({ world: w, player: me });
    expect(pick).toEqual({ panel: "door", piece: door });
    G.setIntent(w, me, { action: G.IntentAction.ToggleDoor, target: door! });
    steps(w, 1);
    const attach = G.resolveAttachment(w, door!, G.AttachKind.Door);
    expect(attach).toBeDefined();
    expect(w.getField(attach!, G.DoorState, "open")).toBe(1);
  });

  it("Interact next to a chest with no nearer door still opens storage", () => {
    const w = makeWorld();
    installPermissions(w);
    const me = spawnLearned(w, { x: 10, y: 10, clientId: 1 });
    w.add(me, PlayerId, { id: 1 });
    const d = G.defaultDefs();
    const snap = G.snapPlacement(w, { piece: d.pieceId("basic_storage_box"), x: 11, y: 10, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof snap === "number") throw new Error(`snap ${snap}`);
    const chest = G.placePiece(w, me, snap, { pay: false });
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "storage", piece: chest });
  });

  it("two-story floors sit one story above the ground, supported by walls on foundations", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.TwoStoryCottage, rot: 0, ruin: 0, tier: 1 });
    expect(r.skipped).toBe(false);
    const defs = G.gameplayDefs(w);
    const lh = defs.building.levelHeight;
    const floors = r.placed.filter((e) => {
      const key = defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key;
      return key === "floor" || key === "floor_stairwell";
    });
    expect(floors.length).toBeGreaterThan(0);
    for (const e of floors) {
      expect(w.getField(e, Transform, "z")).toBeCloseTo(lh);
    }
    const walls0 = r.placed.filter((e) => {
      const key = defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "";
      const z = w.getField(e, Transform, "z") ?? 0;
      return (key === "wall" || key === "wall_doorway" || key === "wall_window" || key === "wall_corner_outer") && z < 0.01;
    });
    expect(walls0.length).toBeGreaterThan(0);
    const foundations = r.placed.filter((e) => defs.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key === "foundation");
    expect(foundations.length).toBeGreaterThan(0);
  });
});
