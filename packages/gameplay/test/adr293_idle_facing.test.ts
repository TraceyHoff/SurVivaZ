import { describe, expect, it } from "vitest";
import { idleOutput, Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

for (const human of ["player", "AI human"]) describe(`ADR-293 ${human} stopped facing`, () => {
  it.each([[ -1, -1 ], [1, -1], [1, 1], [-1, 1], [1, 0], [0, -1], [0, 1], [-1, 0]])("retains travel heading %s,%s", (x, y) => {
    const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20, maxWeight: 0 }), reg = G.registerGameplayCommands();
    const move = (x: number, y: number) => {
      const f = human === "AI human" ? G.agentOutputFrame({ ...idleOutput(), moveX: x, moveY: y }, w.tick, reg) : { actions: 0, moveX: x, moveY: y };
      G.applyMovementInput(w, p, f.actions, .05, { x: f.moveX, y: f.moveY });
    };
    for (let i = 0; i < 12; i++) move(x, y);
    const before = w.get(p, Transform)!;
    expect(Math.cos(before.facing)).toBeCloseTo((x + y) * Math.SQRT1_2 / Math.hypot(x, y), 5);
    expect(Math.sin(before.facing)).toBeCloseTo((y - x) * Math.SQRT1_2 / Math.hypot(x, y), 5);
    for (let i = 0; i < 20; i++) move(0, 0);
    expect(w.get(p, Transform)).toEqual(before);
  });
});
