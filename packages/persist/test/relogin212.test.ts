import { describe, it, expect } from "vitest";
import { Owner, PlayerId, Transform, World, type Entity } from "@engine/core";
import { ChunkManager, ProceduralGenerator } from "@engine/world";
import {
  BuildPiece, CraftingStation, Emitter, PieceLink, PieceStability, StationKind, gameplayDefs, installGameplay, placePiece,
  snapPlacement, stationInRange, structures, validatePlacement, type PlaceRequest,
} from "@engine/gameplay";
import { MemoryWorldStore, WorldPersistence, type WorldStore } from "../src/index.js";

/** Server as apps/server/src/game.ts runs it: core persistence, no STRC sidecar (pieces saved as persistent entities). */
function host(store: WorldStore) {
  const world = new World({ seed: 5, maxEntities: 1 << 16 }); installGameplay(world, { role: "server" });
  if (!world.isRegistered(PlayerId)) world.register(PlayerId);
  const persist = new WorldPersistence({ world, store, generator: new ProceduralGenerator({ seed: 5 }), autosaveSeconds: 0, playerSaveSeconds: 0 });
  const chunks = new ChunkManager({ provider: persist.provider, loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
  persist.attach(chunks); world.addSystem("postSim", "test.chunks", () => chunks.update());
  chunks.setSource({ id: 1, x: 16, y: 16 }); chunks.update();
  const player = world.create(); world.add(player, Transform, { x: 1.5, y: 1.2 });
  if (!world.has(player, PlayerId)) world.add(player, PlayerId, { id: 1 });
  if (world.isRegistered(Owner) && !world.has(player, Owner)) world.add(player, Owner, { clientId: 1 });
  return { world, persist, player, step: (n = 1) => { for (let i = 0; i < n; i++) world.step(1 / 20); } };
}
const id = (w: World, k: string): number => [...gameplayDefs(w).pieces.values()].find((p) => p.key === k)!.id;
function snap(w: World, r: Omit<PlaceRequest, "tier" | "variant" | "piece"> & { key: string; tier?: number }) {
  const sn = snapPlacement(w, { tier: r.tier ?? 0, variant: 0, piece: id(w, r.key), x: r.x, y: r.y, level: r.level, rot: r.rot });
  if (typeof sn === "number") throw new Error(`snap ${r.key}: ${sn}`); return sn;
}
const place = (w: World, b: Entity, r: Parameters<typeof snap>[1]): Entity => {
  const sn = snap(w, r); const f = validatePlacement(w, b, sn, { ignoreCost: true, ignoreRange: true }); if (f) throw new Error(`${r.key}: BuildFail ${f}`);
  return placePiece(w, b, sn, { pay: false });
};

describe("ADR-212: structures after a restart / log back in", () => {
  it("stations stay usable and walls / doorways can still be placed on loaded foundations", async () => {
    const store = new MemoryWorldStore(); const a = host(store); a.step();
    place(a.world, a.player, { key: "claim_totem", x: 5, y: 1, level: 0, rot: 0 });
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) place(a.world, a.player, { key: "foundation", x: tx + 0.5, y: ty + 0.5, level: 0, rot: 0 });
    place(a.world, a.player, { key: "workbench", x: 1.5, y: 1.5, level: 0, rot: 0 });
    place(a.world, a.player, { key: "campfire", x: 0.5, y: 0.5, level: 0, rot: 0 });
    place(a.world, a.player, { key: "wall", x: 1.5, y: 1, level: 0, rot: 0 });
    a.step(3);
    expect(stationInRange(a.world, a.player, StationKind.Workbench)).toBe(true);
    const fires = (w: World) => [...w.query([PieceLink, CraftingStation])].length;
    expect(fires(a.world)).toBe(1);
    await a.persist.saveAll();

    const b = host(store); b.step(3);
    expect([...b.world.query([BuildPiece])].length).toBe(13);
    // every loaded piece is back in the stability graph with a real value (foundations = ground, wall above = ground - loss)
    for (const e of b.world.query([BuildPiece])) expect(b.world.getField(e, PieceStability, "value") ?? 0).toBeGreaterThan(gameplayDefs(b.world).building.minStability);
    expect(stationInRange(b.world, b.player, StationKind.Workbench)).toBe(true);
    expect(fires(b.world)).toBe(1); // campfire's Fire attachment is a station again
    expect([...b.world.query([PieceLink, Emitter])].length).toBeGreaterThan(0);
    // pieces resting on loaded foundations validate on the server (was NoSupport = 11)
    for (const key of ["wall_doorway", "wall_window", "wall"]) {
      const sn = snap(b.world, { key, x: 1.5, y: 2, level: 0, rot: 0 });
      expect(validatePlacement(b.world, b.player, sn, { ignoreCost: true, ignoreRange: true }), key).toBe(0);
    }
    place(b.world, b.player, { key: "wall_doorway", x: 1.5, y: 2, level: 0, rot: 0 });
    expect(validatePlacement(b.world, b.player, snap(b.world, { key: "door_wood", x: 1.5, y: 2, level: 0, rot: 0 }), { ignoreCost: true, ignoreRange: true })).toBe(0);
    b.step(); expect(structures(b.world).dirty.size).toBe(0);
  });
});
