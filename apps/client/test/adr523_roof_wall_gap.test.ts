import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { World, Transform, PrevTransform, TimeOfDay, Appearance, PlayerId, type Entity } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS, floorToTerrainZ, type TileMap } from "@engine/world";
import {
  DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, loadDefs, BuildPiece, GameplayConfig, installGameplay,
  stampAbandonedSite, drainAbandonedStamps, AbandonedKind, TerrainRes,
  type GameDefs,
} from "@engine/gameplay";
import { Canvas2DRenderer } from "@engine/render";
import { IsoView, deckTileKey } from "../src/view.js";
import { LightTable } from "../src/lights.js";

/**
 * ADR-523 (investigation harness): drive the REAL IsoView.render mirror pass — net world with a
 * screenshot-like cabin (stone foundation, log walls, hip shake roof, door + window) over terrain
 * whose south side drops below the house terrace — and read the view Transform.z the render loop
 * actually assigns to the south wall and to the roof tile above it. ADR-433's rule is pinned at
 * function level only; this pins the wiring: the deck set the render loop builds from the pieces
 * it iterates, the per-frame re-grounding, and the wall-top/roof-seat pair.
 *
 * Screenshot (2026-11-23): 1-story log house, hip shake roof, roof floats ~42px on screen
 * (~17px at 1x, zoom ~2.4) above the walls on the south/east sides with the interior visible
 * through the gap; a raised grass terrace sits directly north of the house and the ground falls
 * away to the south. A gap that size is a wall grounded ~2 terrain levels below its roof tile:
 * the ADR-412 min fallback firing because the deck set missed the inside foundation/roof decks
 * — the exact failure ADR-433 fixed in Nov 2026. These tests pin the fix end to end: if the
 * deck wiring ever regresses, the south wall sinks to the dropped outside height and they fail.
 */

const reg = loadManifest(mergeManifests([
  { name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") },
  { name: "building", manifest: readManifestJson(PACK_DIR + "building/manifest.building.json") },
] as never).manifest).registry;
const DEFS: GameDefs = loadDefs(DEFAULT_RAW_DEFS, { lock: DEFAULT_ID_LOCK });

/** Minimal stub 2D context: IsoView.render never draws, so no call ever lands here. */
const stubCtx = new Proxy({}, { get: (_t, p) => (p === "canvas" ? {} : () => ({})) }) as unknown as CanvasRenderingContext2D;

const mkIso = (): IsoView => {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const renderer = new Canvas2DRenderer(canvas, stubCtx);
  const Ctor = IsoView as unknown as new (r: unknown, reg: unknown, ov: unknown, lights: unknown) => IsoView;
  return new Ctor(renderer as never, reg, {}, new LightTable());
};

/** TileMap with one resident chunk: `height` per tile, tile id 0 (not water). */
const tilesWith = (inside: number, outsideSouth: number, dropY = 9): TileMap => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(3);
  for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) {
    height[y * CHUNK_SIZE + x] = y >= dropY ? outsideSouth : inside;
  }
  const chunk = { tiles: new Uint16Array(CHUNK_SIZE * CHUNK_SIZE), height };
  // getTile: an id with no clutter table, so syncClutter adds nothing (the test is about pieces, not clutter).
  return { getChunk: () => chunk, getTile: () => 9999 } as unknown as TileMap;
};

interface Placed { e: Entity; key: string; x: number; y: number; z: number }

/** A cabin like the screenshot's: 5x5 footprint at tiles (4..8, 4..8), foundation under every tile,
 *  log walls (door + window on the south edge), hip roof at level 1. Returns the placed pieces. */
const buildCabin = (net: World): Placed[] => {
  const out: Placed[] = [];
  const place = (key: string, x: number, y: number, z: number, rot = 0, tier = 1): Placed => {
    const e = net.create();
    net.add(e, Transform, { x, y, z, facing: 0 });
    net.add(e, PrevTransform, { x, y, z, facing: 0 });
    net.add(e, BuildPiece, { type: DEFS.pieceId(key), rot, variant: 0, tier, hp: 100, damageStage: 0, paint: 0, tint: 0 });
    const p = { e, key, x, y, z };
    out.push(p);
    return p;
  };
  for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) place("foundation", x + 0.5, y + 0.5, 0);
  // corners (ADR-211 L-corners)
  place("wall_corner_outer", 4, 4, 0, 0); place("wall_corner_outer", 9, 4, 0, 1);
  place("wall_corner_outer", 9, 9, 0, 2); place("wall_corner_outer", 4, 9, 0, 3);
  for (let x = 5; x <= 8; x++) place("wall", x + 0.5, 4, 0); // north edge
  for (let x = 4; x <= 8; x++) place(x === 6 ? "wall_doorway" : x === 7 ? "wall_window" : "wall", x + 0.5, 9, 0); // south edge
  for (let y = 5; y <= 8; y++) { place("wall", 4, y + 0.5, 0); place("wall", 9, y + 0.5, 0); } // west + east edges
  for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) place("roof_hip", x + 0.5, y + 0.5, FLOOR_HEIGHT_LEVELS);
  return out;
};

const mkNet = (): World => {
  const net = new World({ seed: 1 });
  net.register(Transform); net.register(PrevTransform);
  net.register(Appearance); net.register(PlayerId); // core components classify() probes with net.has
  installGameplay(net, { defs: DEFS, role: "client" });
  net.env(TimeOfDay).epochTick = 0;
  return net;
};

/** View Transform.z per placed piece after one IsoView.render. */
const viewZ = (iso: IsoView, placed: Placed[]): Map<string, number> => {
  const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
  const out = new Map<string, number>();
  for (const p of placed) {
    const ve = map.get(p.e);
    if (ve === undefined) { out.set(`${p.key}@${p.x},${p.y}`, NaN); continue; }
    out.set(`${p.key}@${p.x},${p.y}`, iso.view.get(ve, Transform)!.z);
  }
  return out;
};

describe("ADR-523 investigation: wall/roof grounding through IsoView.render", () => {
  it("south wall grounds on the inside terrace, not the dropped ground outside", () => {
    const iso = mkIso();
    const net = mkNet();
    const placed = buildCabin(net);
    const tiles = tilesWith(3, 1); // inside 3, south outside dropped 2 levels
    iso.render(net, tiles, undefined, 1);
    const zs = viewZ(iso, placed);
    const deckKeys = (iso as unknown as { deckKeys: ReadonlySet<number> }).deckKeys;
    // the deck set the loop built must hold the inside foundation (level 0) and roof (level 1)
    expect(deckKeys.has(deckTileKey(6, 8, 0))).toBe(true);
    expect(deckKeys.has(deckTileKey(6, 8, 1))).toBe(true);
    expect(deckKeys.size).toBeGreaterThan(0);
    const southWall = zs.get("wall@5.5,9")!;
    const southRoof = zs.get("roof_hip@6.5,8.5")!;
    // eslint-disable-next-line no-console
    console.log("south wall viewZ:", southWall, "roof viewZ:", southRoof, "deckKeys:", deckKeys.size);
    expect(southRoof).toBe(3);
    expect(southWall).toBe(3);
    // wall top meets the roof seat: base + one story == roof floor
    expect(floorToTerrainZ(0, southWall) + FLOOR_HEIGHT_LEVELS).toBe(floorToTerrainZ(1, southRoof));
  });

  it("flat control: no drop, wall and roof agree", () => {
    const iso = mkIso();
    const net = mkNet();
    const placed = buildCabin(net);
    iso.render(net, tilesWith(3, 3), undefined, 1);
    const zs = viewZ(iso, placed);
    expect(zs.get("wall@5.5,9")).toBe(3);
    expect(zs.get("roof_hip@6.5,8.5")).toBe(3);
  });

  it("HipGable cabin: south-row roof lift + wall clip plane agree (no floating roof)", () => {
    const iso = mkIso();
    const net = mkNet();
    // HipGable layout (abandoned.ts restyleRoof): gable rows along the long axis, hip caps at both ends.
    const placed: Placed[] = [];
    const place = (key: string, x: number, y: number, z: number, rot = 0, tier = 1): Placed => {
      const e = net.create();
      net.add(e, Transform, { x, y, z, facing: 0 });
      net.add(e, PrevTransform, { x, y, z, facing: 0 });
      net.add(e, BuildPiece, { type: DEFS.pieceId(key), rot, variant: 0, tier, hp: 100, damageStage: 0, paint: 0, tint: 0 });
      const p = { e, key, x, y, z };
      placed.push(p);
      return p;
    };
    for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) place("foundation", x + 0.5, y + 0.5, 0);
    for (let x = 5; x <= 8; x++) place("wall", x + 0.5, 4, 0);
    for (let x = 4; x <= 8; x++) place(x === 6 ? "wall_doorway" : x === 7 ? "wall_window" : "wall", x + 0.5, 9, 0);
    for (let y = 5; y <= 8; y++) { place("wall", 4, y + 0.5, 0); place("wall", 9, y + 0.5, 0); }
    for (let y = 4; y <= 8; y++) for (let x = 4; x <= 8; x++) place(x === 4 || x === 8 ? "roof_hip" : "roof_gable", x + 0.5, y + 0.5, FLOOR_HEIGHT_LEVELS);
    iso.render(net, tilesWith(3, 1), undefined, 1);
    const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
    const roofs = (iso as unknown as { roofs: { binding(v: number): { liftPx: number; row: number } | undefined; pick(v: number): { form: string; row: number; zoffPx: number } | undefined; planeOver(x: number, y: number, l: number): number | undefined } }).roofs;
    // south-row roof tiles: lift must be the hip/gable seat only (band 0, zoff 0), never a band lift
    for (const p of placed.filter((q) => q.key.startsWith("roof") && q.y === 8.5)) {
      const ve = map.get(p.e)!;
      const b = roofs.binding(ve);
      const pk = roofs.pick(ve);
      // eslint-disable-next-line no-console
      console.log(p.key, "tile", p.x, p.y, "pick", JSON.stringify(pk), "liftPx", b?.liftPx);
      expect(b).toBeDefined();
      expect(b!.liftPx).toBeLessThanOrEqual(13); // hip seat 13 is the largest seat; a band lift would exceed it
    }
    // the clip plane over the south wall: hip uses clip "posts" (ADR-509), so an EDGE wall gets no
    // clip by design — the roof wins the overlap by depth bias (RFX_SEAT_BIAS) / painter order, and
    // the wall top (91px) sits below the seated roof plane (80 + 13 = 93). A VERTEX post does clip.
    expect(roofs.planeOver(6.5, 9, 0)).toBeUndefined();
    expect(roofs.planeOver(9, 9, 0)).toBe(93);
    expect(roofs.planeOver(4, 4, 0)).toBe(93);
  });

  it("real stamped cabin (ruin 0.3, HipGable): every perimeter wall meets its roof over a 2-level drop", () => {
    const iso = mkIso();
    const net = mkNet();
    // stamp as authority (the server side), then flip the world to the client role for the render pass
    net.setResource(GameplayConfig, { defs: DEFS, role: "standalone" });
    // terrain the stamp sees: flat 3 under the site, 1 south of it (the screenshot's terrace + drop)
    net.setResource(TerrainRes, { tileAt: () => 3, heightAt: (x: number, y: number) => (y >= 12 ? 1 : 3), loaded: () => true });
    const r = stampAbandonedSite(net, 8, 8, { kind: AbandonedKind.Cabin as never, rot: 0, ruin: 0.3, tier: 1 });
    drainAbandonedStamps(net);
    expect(r.skipped).toBe(false);
    expect(r.placed.length).toBeGreaterThan(0);
    net.setResource(GameplayConfig, { defs: DEFS, role: "client" });
    iso.render(net, tilesWith(3, 1, 12), undefined, 1);
    const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
    const deckKeys = (iso as unknown as { deckKeys: ReadonlySet<number> }).deckKeys;
    // every placed wall / roof / foundation must have a view entity, grounded on the inside height 3
    let walls = 0, roofs = 0, bad: string[] = [];
    for (const e of r.placed) {
      const type = net.getField(e, BuildPiece, "type")!;
      const key = DEFS.pieces.get(type)!.key;
      const t = net.get(e, Transform)!;
      const ve = map.get(e);
      if (ve === undefined) { bad.push(`${key}@${t.x},${t.y} NO-VIEW-ENTITY`); continue; }
      const vz = iso.view.get(ve, Transform)!.z;
      if (key.startsWith("wall")) { walls++; if (vz !== 3) bad.push(`${key}@${t.x},${t.y} viewZ=${vz}`); }
      if (key.startsWith("roof")) { roofs++; if (vz !== 3) bad.push(`${key}@${t.x},${t.y} viewZ=${vz}`); }
    }
    // eslint-disable-next-line no-console
    console.log("stamped cabin: walls", walls, "roofs", roofs, "deckKeys", deckKeys.size, "bad", JSON.stringify(bad));
    expect(walls).toBeGreaterThan(0);
    expect(roofs).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("sweep: every cabin kind, ruin 0.3 — all perimeter walls meet their roof over a 2-level drop", () => {
    const kinds = Object.values(AbandonedKind).filter((k) => typeof k === "number") as number[];
    expect(kinds.length).toBeGreaterThan(10);
    for (const kind of kinds) {
      const iso = mkIso();
      const net = mkNet();
      net.setResource(GameplayConfig, { defs: DEFS, role: "standalone" });
      net.setResource(TerrainRes, { tileAt: () => 3, heightAt: () => 3, loaded: () => true });
      const r = stampAbandonedSite(net, 8, 8, { kind: kind as never, rot: 0, ruin: 0.3, tier: 1 });
      drainAbandonedStamps(net);
      if (r.skipped) continue; // some kinds need more room / a garden / pen; not the gap question
      // drop line: one row south of the southernmost foundation
      let maxFy = -1;
      for (const e of r.placed) {
        const type = net.getField(e, BuildPiece, "type")!;
        if (DEFS.pieces.get(type)!.key !== "foundation") continue;
        maxFy = Math.max(maxFy, Math.floor(net.get(e, Transform)!.y));
      }
      net.setResource(GameplayConfig, { defs: DEFS, role: "client" });
      iso.render(net, tilesWith(3, 1, maxFy + 1), undefined, 1);
      const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
      const bad: string[] = [];
      for (const e of r.placed) {
        const type = net.getField(e, BuildPiece, "type")!;
        const key = DEFS.pieces.get(type)!.key;
        if (!key.startsWith("wall") && !key.startsWith("roof")) continue;
        const ve = map.get(e);
        if (ve === undefined) { bad.push(`${key} NO-VIEW`); continue; }
        const vz = iso.view.get(ve, Transform)!.z;
        if (vz !== 3) bad.push(`${key}@${net.get(e, Transform)!.x},${net.get(e, Transform)!.y} viewZ=${vz}`);
      }
      expect(bad, `kind ${kind}`).toEqual([]);
    }
  });
});
