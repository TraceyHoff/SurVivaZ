// ADR-421: merged-registry half of the boat art tests (node environment — the node-only
// manifest loader in @engine/assets/node cannot run under jsdom, so these live apart from the
// jsdom pixel/icon tests in adr421_boats_art.test.ts). The merged registry resolves every boat
// sprite (resolveVehicleArt binds by def id, native scale, idle = mid-stroke frame 8, row cycle
// [0, 8, 16]) — plus the ADR-420 wiring this slice lands: the pack/task420 fragment registers
// the dock / shipyard atlases and buildPieceVisual resolves their damage frames.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPieceVisual } from "@engine/assets";
import { loadMergedPackManifest } from "@engine/assets/node";
import { resolveVehicleArt } from "@engine/render";
import { defaultDefs } from "@engine/gameplay";
import { BOAT_IDS, MOTORBOAT_IDS } from "../src/task421-art.js";
import { MANIFEST_INDEX } from "../src/manifest-index.js";
import rawVehicles from "../../../packages/gameplay/data/vehicles.json";

describe("ADR-421 boat registry", () => {
  it("the merged registry resolves every boat sprite (resolveVehicleArt binds by def id)", async () => {
    expect(MANIFEST_INDEX.some((f) => f.name === "task421")).toBe(true);
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => c.key.startsWith("veh_art_") && ["raft", "canoe", "rowboat"].some((b) => c.key.endsWith(b)))).toEqual([]);
    expect(result.warnings).toEqual([]);
    const defs = (rawVehicles as { vehicles: { id: string; class: string; seats: number; footprint: { length: number; width: number } }[] }).vehicles;
    for (const id of BOAT_IDS) {
      expect(result.registry.atlases.has(`veh_art_${id}`), id).toBe(true);
      const json = defs.find((v) => v.id === id)!;
      const binding = resolveVehicleArt(result.registry, { id, class: "boat", seats: json.seats, footprint: json.footprint, hitches: [], interior: { stations: [] } });
      expect(binding, id).not.toBeNull();
      expect(binding!.key).toBe(id);
      expect(binding!.scale).toBe(1); // veh_art_* atlases are native scale
      const s = result.registry.sprite(binding!.spriteId);
      expect(s.animList[0]!.directions).toBe(8);
      // The idle animation is the mid-stroke frame (phase 1 = frame 8); the row cycle is [0, 8, 16].
      const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task421/manifest.task421.json"), "utf8")) as {
        sprites: { key: string; animations?: Record<string, { frames?: number[]; directions?: number; dirStride?: number }> }[];
      };
      const sprite = manifest.sprites.find((x) => x.key === id)!;
      expect(sprite.animations!.idle!.frames).toEqual([8]);
      expect(sprite.animations!.row!.frames).toEqual([0, 8, 16]);
    }
  });

  it("ADR-420 wiring: the task420 fragment registers and buildPieceVisual resolves dock/shipyard damage frames", async () => {
    expect(MANIFEST_INDEX.some((f) => f.name === "task420")).toBe(true);
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => c.key === "dec_dock" || c.key === "dec_shipyard")).toEqual([]);
    const d = defaultDefs();
    const pk = (t: number): string | undefined => d.pieces.get(t)?.key;
    for (const key of ["dock", "shipyard"] as const) {
      expect(result.registry.atlases.has(`decor_${key}`), key).toBe(true);
      const sprite = result.registry.spriteForPiece(key);
      expect(sprite, key).toBeGreaterThan(0);
      expect(result.registry.sprite(sprite!).key, key).toBe(`dec_${key}`);
      const intact = buildPieceVisual(result.registry, { type: d.pieceId(key), rot: 0, tint: 0, paint: 0, damageStage: 0, state: 0 }, { pieceKey: pk });
      const broken = buildPieceVisual(result.registry, { type: d.pieceId(key), rot: 0, tint: 0, paint: 0, damageStage: 3, state: 0 }, { pieceKey: pk });
      expect(intact.frame!.frame).toBe(0);
      expect(broken.frame!.frame).toBe(3);
      const side = buildPieceVisual(result.registry, { type: d.pieceId(key), rot: 1, tint: 0, paint: 0, damageStage: 0, state: 0 }, { pieceKey: pk });
      expect(side.frame!.frame).toBe(4);
    }
  });
});

describe("ADR-422 motorboat registry", () => {
  it("the merged registry resolves every motorboat sprite (resolveVehicleArt binds by def id)", async () => {
    expect(MANIFEST_INDEX.some((f) => f.name === "task422")).toBe(true);
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => c.key.startsWith("veh_art_") && ["motorboat", "pontoon", "speedboat"].some((b) => c.key.endsWith(b)))).toEqual([]);
    expect(result.warnings).toEqual([]);
    const defs = (rawVehicles as { vehicles: { id: string; class: string; seats: number; footprint: { length: number; width: number } }[] }).vehicles;
    for (const id of MOTORBOAT_IDS) {
      expect(result.registry.atlases.has(`veh_art_${id}`), id).toBe(true);
      const json = defs.find((v) => v.id === id)!;
      const binding = resolveVehicleArt(result.registry, { id, class: "boat", seats: json.seats, footprint: json.footprint, hitches: [], interior: { stations: [] } });
      expect(binding, id).not.toBeNull();
      expect(binding!.key).toBe(id);
      expect(binding!.scale).toBe(1); // veh_art_* atlases are native scale
      const s = result.registry.sprite(binding!.spriteId);
      expect(s.animList[0]!.directions).toBe(8);
      // The idle animation is the full-throttle frame (phase 1 = frame 8); the wake cycle is [0, 8, 16].
      const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task422/manifest.task422.json"), "utf8")) as {
        sprites: { key: string; animations?: Record<string, { frames?: number[]; directions?: number; dirStride?: number }> }[];
      };
      const sprite = manifest.sprites.find((x) => x.key === id)!;
      expect(sprite.animations!.idle!.frames).toEqual([8]);
      expect(sprite.animations!.wake!.frames).toEqual([0, 8, 16]);
    }
  });
});
