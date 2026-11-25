// ADR-533: network rivers push you downstream, like forced rivers (ADR-490). A network
// channel tile's current is the channel record's downstream direction (it follows the
// channel's bends and points at the mouth); sink ponds and delta sand have no current.
// The test drives the REAL generated network (seed 42, region (1,0)) through the real
// generator for TerrainRes, so the swimmer is in a real channel, not a synthetic one.
import { describe, it, expect } from "vitest";
import { Transform, Weather, type World } from "@engine/core";
import { ProceduralGenerator, BOAT_ENTERABLE_MOUTH_LEVEL } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const SEED = 42;

/** The seed-42 network in region (1,0), from the same generator the server builds chunks from. */
const gen = new ProceduralGenerator({ seed: SEED });
const net = gen.riversInRegion(1, 0);

/** A mid-channel centreline tile of a long water-mouth channel (room to drift downstream). */
const channelTile = (): { tx: number; ty: number; dx: number; dy: number } => {
  const ch = net.channels
    .filter((c) => c.endKind === "water" && c.centreline.length >= 20)
    .sort((a, b) => b.centreline.length - a.centreline.length)[0]!;
  const mid = ch.centreline[Math.floor(ch.centreline.length / 2)]!;
  const next = ch.centreline[Math.floor(ch.centreline.length / 2) + 1]!;
  return { tx: mid.x, ty: mid.y, dx: next.x - mid.x, dy: next.y - mid.y };
};
const CH = channelTile();

/** The real generated world for TerrainRes (channel tiles are water, banks are land). Calm weather. */
function world(): World {
  const w = makeWorld();
  w.setResource(G.TerrainRes, {
    tileAt: (tx: number, ty: number) => gen.tileAt(tx, ty),
    heightAt: (tx: number, ty: number) => gen.heightAt(tx, ty),
  });
  Object.assign(w.env(Weather), { windSpeed: 0, windDir: 0 });
  return w;
}

describe("ADR-533 network rivers push you downstream", () => {
  it("riverCurrentAt: the channel record's downstream direction on a network tile", () => {
    const w = makeWorld();
    const dir = G.riverCurrentAt(w, CH.tx + 0.5, CH.ty + 0.5);
    expect(dir, "a network channel tile has a current").toBeDefined();
    expect(Math.hypot(dir!.x, dir!.y)).toBeCloseTo(1, 6);
    // The record's own downstream direction at that tile (the walk direction, axis-aligned).
    expect(dir!.x).toBeCloseTo(CH.dx, 6);
    expect(dir!.y).toBeCloseTo(CH.dy, 6);
    // Deterministic: the same tile twice gives the same direction.
    const again = G.riverCurrentAt(w, CH.tx + 0.5, CH.ty + 0.5)!;
    expect(again.x).toBe(dir!.x);
    expect(again.y).toBe(dir!.y);
  });

  it("riverCurrentAt: undefined on land, on a lake, and on sink water (still water)", () => {
    const w = makeWorld();
    // Land beside the channel (a bank tile — not a channel, not water).
    let land: { tx: number; ty: number } | undefined;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const tx = CH.tx + dx, ty = CH.ty + dy;
      if (gen.tileAt(tx, ty) !== 1) { land = { tx, ty }; break; }
    }
    expect(land, "a bank tile beside the channel").toBeDefined();
    expect(G.riverCurrentAt(w, land!.tx + 0.5, land!.ty + 0.5)).toBeUndefined();
    // A lake tile in region (1,0) (not a channel): find one from the network's own mouth.
    const mouth = net.channels.find((c) => c.endKind === "water")!;
    expect(G.riverCurrentAt(w, mouth.end.x + 0.5, mouth.end.y + 0.5)).toBeUndefined();
    // A sink pond's water (still water — a boxed-in stream's end) has no current.
    const sink = net.channels.find((c) => c.endKind === "sink" && c.sink);
    if (sink) {
      expect(G.riverCurrentAt(w, sink.sink!.x + 0.5, sink.sink!.y + 0.5)).toBeUndefined();
    }
    // Delta sand is land, not a current.
    const delta = net.channels.find((c) => c.endKind === "water" && c.delta.length > 0);
    if (delta) {
      const d = delta.delta[0]!;
      expect(G.riverCurrentAt(w, d.x + 0.5, d.y + 0.5)).toBeUndefined();
    }
  });

  it("an idle swimmer on a network river drifts downstream at the river current (0.3 tiles in 1 s)", () => {
    const w = world();
    const x0 = CH.tx + 0.5, y0 = CH.ty + 0.5;
    const p = G.spawnPlayer(w, { x: x0, y: y0 });
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, 0, 1 / 20); w.step(1 / 20); }
    const t = w.get(p, Transform)!;
    const along = (t.x - x0) * CH.dx + (t.y - y0) * CH.dy;
    const across = Math.abs((t.x - x0) * -CH.dy + (t.y - y0) * CH.dx);
    expect(along).toBeGreaterThan(0.2);
    expect(along).toBeLessThan(0.4);
    expect(across).toBeLessThan(0.05);
  });

  it("a low river mouth is a current the boat can ride in from the lake", () => {
    // The foothill guarantee: at least one mouth per region is low (<= 3) — a boat on the
    // lake can enter it. The mouth's channel tile (just inside the river) has a current
    // pointing downstream, i.e. INTO the river from the lake.
    const w = makeWorld();
    const low = net.channels.filter((c) => {
      if (c.endKind !== "water") return false;
      const last = c.centreline[c.centreline.length - 1]!;
      return last.level <= BOAT_ENTERABLE_MOUTH_LEVEL;
    });
    expect(low.length, "at least one low mouth").toBeGreaterThan(0);
    const c = low[0]!;
    const last = c.centreline[c.centreline.length - 1]!;
    const dir = G.riverCurrentAt(w, last.x + 0.5, last.y + 0.5);
    expect(dir, "the mouth tile has a current").toBeDefined();
    // Downstream points from the mouth tile toward the lake (the end tile), not back up-river.
    expect((c.end.x - last.x) * dir!.x + (c.end.y - last.y) * dir!.y).toBeGreaterThan(0);
  });
});
