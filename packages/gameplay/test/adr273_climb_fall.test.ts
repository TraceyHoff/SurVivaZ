import { describe, expect, it } from "vitest";
import { Transform, idleOutput, installPermissions } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";
import { goTo } from "../src/ai/base_behaviors.js";

function setup(height: number, role: "server" | "client" = "server") {
  const w = makeWorld({ role }); const map = new TileMap();
  for (let y = -4; y < 5; y++) for (let x = -4; x < 5; x++) { map.setTile(x, y, 3); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, x >= 1 ? height : 0); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = G.spawnPlayer(w, { x: .9, y: .5, maxWeight: 0 });
  return { w, p };
}
const inputX = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
describe("ADR-273 climb and gravity", () => {
  it.each([1, 2, 3, 4, 8, 22, 60, 75])("unaided natural ascent of %i tiles", h => {
    const { w, p } = setup(h); G.applyMovementInput(w, p, 0, .1, inputX);
    expect(w.get(p, Transform)!.x > 1).toBe(h <= 3);
  });
  it.each([0, 1, 3, 4, 6, 10, 14, 20, 60, 75])("a %i tile drop applies scaled damage exactly once", h => {
    const { w, p } = setup(-h); const hp = w.getField(p, G.Health, "hp")!;
    G.applyMovementInput(w, p, 0, .1, inputX);
    expect(w.get(p, Transform)!.x).toBeGreaterThan(1);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(Math.max(0, hp - G.terrainFallDamage(h)));
    G.applyMovementInput(w, p, 0, .05, inputX);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(Math.max(0, hp - G.terrainFallDamage(h)));
  });
  it("ADR-297: a fall from +75 to -60 uses the unchanged 135-tile damage formula", () => {
    const {w,p}=setup(-60); const terrain=w.resource(G.TerrainRes);
    for(let y=-4;y<5;y++)for(let x=-4;x<1;x++)terrain.setRawHeight!(x,y,75);
    const hp=w.getField(p,G.Health,"hp")!;
    G.applyMovementInput(w,p,0,.1,inputX);
    expect(w.getField(p,G.Health,"hp")).toBe(Math.max(0,hp-G.terrainFallDamage(135)));
    expect(Number.isFinite(G.terrainFallDamage(135))).toBe(true);
    expect(G.terrainFallDamage(135)).toBeGreaterThan(G.terrainFallDamage(75));
  });
  it("a four tile stumble is mild, ten serious and fifteen lethal to a healthy human", () => {
    expect([3, 4, 6, 10, 14, 15].map(G.terrainFallDamage)).toEqual([0, 4, 15, 49, 99, 114]);
  });
  it("a full-height face ladder protects both directions", () => {
    const { w, p } = setup(-25); const d = G.gameplayDefs(w); G.grantSkillUnlocks(w, p);
    const sn = G.snapPlacement(w, { piece: d.pieceId("ladder"), x: 1, y: .5, rot: 1, level: 0, tier: 0, variant: 0 });
    expect(typeof sn).toBe("object"); if (typeof sn === "number") return;
    G.placePiece(w, p, sn, { pay: false }); const hp = w.getField(p, G.Health, "hp");
    G.applyMovementInput(w, p, 0, .1, inputX); expect(w.get(p, Transform)!.x).toBeGreaterThan(1);
    expect(w.getField(p, G.Health, "hp")).toBe(hp);
    G.applyMovementInput(w, p, 0, .1, { x: -inputX.x, y: -inputX.y });
    expect(w.get(p, Transform)!.x).toBeLessThan(1); expect(w.getField(p, G.Health, "hp")).toBe(hp);
  });
  it("AI humans' actual input frames obey climbing and falling, with safe path planning", () => {
    const { w, p } = setup(4); installPermissions(w); const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!, out = idleOutput();
    goTo({ ...v, world: { ...v.world, base: { x: 0, y: 0 } }, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a }, out, 2.5, .5);
    const f = G.agentOutputFrame(out, w.tick, G.registerGameplayCommands()); G.applyMovementInput(w, p, f.actions, .1);
    expect(w.get(p, Transform)!.x).toBeLessThan(1);
    // A shove/forced movement input off the same ledge still uses the human gravity rule.
    w.set(p, Transform, { x: 1.1 }); const hp = w.getField(p, G.Health, "hp")!;
    G.applyMovementInput(w, p, 0, .1, { x: -inputX.x, y: -inputX.y });
    expect(w.getField(p, G.Health, "hp")).toBe(hp - 4);
  });
  it("prediction/replay never double-applies authority damage", () => {
    const { w, p } = setup(-10, "client"); const hp = w.getField(p, G.Health, "hp");
    G.applyMovementInput(w, p, 0, .1, inputX); expect(w.getField(p, G.Health, "hp")).toBe(hp);
  });
});
