// @vitest-environment jsdom
// ADR-439: a hidden ledge onto water shows its drop-off number. Worldgen stores a water tile's bed
// height on the same smooth field as the shore next to it, so the gameplay drop (land height minus
// bed height) reads ~0 while the water the player sees renders at its surface (flat 0 for natural
// water, ADR-182; its own level for flowed water, ADR-263/297/411) — a multi-tile visual cliff
// with no arrow and no number. The warning must measure the drop to the water surface.
import { describe, expect, test } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { flowWaterRaw } from "@engine/world";
import { ledgeDraws, pickLedgeHint, pickLedgeHints } from "../src/ledge-warning.js";

/** Shore as worldgen builds it: land at 20, the water tile next to it storing the same bed height 20. */
const SHORE = {
  heightAt: (_tx: number, _ty: number) => 20,
  tileAt: (tx: number, _ty: number) => (tx === 9 ? 1 : 3),
  rawHeightAt: (_tx: number, _ty: number) => 20,
};
const RIM = { x: 10.2, y: 10.5, viewQ: 0, hp: 100 };

describe("ADR-439 ledge drop number by water", () => {
  test("repro: with gameplay heights only, the shore ledge hides the number (drop reads 0)", () => {
    expect(pickLedgeHint({ ...RIM, heightAt: SHORE.heightAt })).toBeUndefined();
  });

  test("the same shore shows the drop to the water surface (20) once the tile is known to be water", () => {
    const hint = pickLedgeHint({ ...RIM, heightAt: SHORE.heightAt, tileAt: SHORE.tileAt, rawHeightAt: SHORE.rawHeightAt });
    expect(hint).toMatchObject({ drop: 20, dx: -1, dy: 0 });
  });

  test("a non-water ledge number is unchanged by the tile lookup (land neighbour at 16 -> drop 4)", () => {
    const hint = pickLedgeHint({
      ...RIM,
      heightAt: (tx, _ty) => (tx === 9 ? 16 : 20),
      tileAt: () => 3,
      rawHeightAt: (tx, _ty) => (tx === 9 ? 16 : 20),
    });
    expect(hint).toMatchObject({ drop: 4, dx: -1, dy: 0 });
  });

  test("flow water (elevated lake) drops to its own surface level, not to 0", () => {
    const level = 10, raw = flowWaterRaw(level);
    const hint = pickLedgeHint({
      ...RIM,
      heightAt: (tx, _ty) => (tx === 9 ? level : 12),
      tileAt: (tx, _ty) => (tx === 9 ? 1 : 3),
      rawHeightAt: (tx, _ty) => (tx === 9 ? raw : 12),
    });
    expect(hint).toMatchObject({ drop: 2, dx: -1, dy: 0 });
  });

  test("the lookahead ray finds a water cliff ahead (heading west, water at x <= 3)", () => {
    const hints = pickLedgeHints({
      x: 10.5, y: 10.5, viewQ: 0, hp: 100, heading: Math.PI, range: 10,
      heightAt: SHORE.heightAt,
      tileAt: (tx, _ty) => (tx <= 3 ? 1 : 3),
      rawHeightAt: SHORE.rawHeightAt,
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ drop: 20, dx: -1, dy: 0 });
  });

  test("standing in the water shows no false drop onto neighbouring land or water", () => {
    const inWater = {
      ...RIM,
      heightAt: (tx: number, _ty: number) => (tx === 10 ? 7 : 2),
      tileAt: (tx: number, _ty: number) => (tx === 10 ? 1 : 3),
      rawHeightAt: (tx: number, _ty: number) => (tx === 10 ? 7 : 2),
    };
    expect(pickLedgeHint(inWater)).toBeUndefined(); // land next door is higher than the surface: a climb, not a drop
    const allWater = { ...inWater, tileAt: () => 1 };
    expect(pickLedgeHint(allWater)).toBeUndefined(); // flat surface in every direction
  });

  test("ledgeDraws wires the TerrainRes through: a shore rim draws the surface drop", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 10 });
    G.installGameplay(w, {});
    const p = G.spawnPlayer(w, { x: 10.2, y: 10.5 });
    w.setResource(G.TerrainRes, { tileAt: SHORE.tileAt, heightAt: SHORE.heightAt, rawHeightAt: SHORE.rawHeightAt });
    const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: () => ({ x: 0, y: 0 }) } as never;
    const draws = ledgeDraws(w, p, cam);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ drop: 20, dx: -1, dy: 0 });
  });
});
