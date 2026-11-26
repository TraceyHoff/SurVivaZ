// ADR-547: ruin stamps stay time-sliced from tick 0. The ADR-382 pump (plan on chunk load,
// place <= ABANDONED_STAMP_PIECES_PER_TICK/tick) already sliced in-play stamps — but
// game.ts drained every pending stamp synchronously while world.tick < 60, so a site chunk
// loaded during the world-entry window still cost one 4-9 ms stamp ending its tick. The
// drain is removed (the boot drain stays: ADR-203 needs boot-area ruins complete before
// the first tick, and it runs once at load time). Seed 11, chunk (-8,-8) is a site that
// loads after boot (found by probe: it goes pending on the first post-boot step).
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import {
  AbandonedSite, ABANDONED_STAMP_PIECES_PER_TICK, AttachKind, BuildPiece, PieceSlot,
  drainAbandonedStamps, gameplayDefs, listSlots, pendingAbandonedStamps,
  resolveAttachment,
} from "@engine/gameplay";
import { LoopbackNetwork } from "@engine/net";
import { MemoryWorldStore } from "@engine/persist";
import { createGameServer } from "../src/main.js";

const SEED = 11;
/** Chunk (-8,-8): a site that is NOT boot-loaded, so its stamp is an in-play stamp. */
const SITE = { id: 92, x: -8 * 32 + 16, y: -8 * 32 + 16, radius: 0 };

function zOf(w: ReturnType<typeof createGameServer>["world"], e: number): number {
  return w.getField(e, PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / gameplayDefs(w).building.levelHeight);
}
/** Exact final-ruin signature: piece key, position, level, rot, tier, hp — order-insensitive. */
function ruinSig(w: ReturnType<typeof createGameServer>["world"]): string[] {
  return [...w.query([BuildPiece])].map((e) => {
    const t = w.get(e, Transform)!;
    const k = gameplayDefs(w).pieces.get(w.getField(e, BuildPiece, "type")!)?.key ?? "?";
    return `${k}@${t.x.toFixed(2)},${t.y.toFixed(2)},${zOf(w, e)},r${w.getField(e, BuildPiece, "rot")},t${w.getField(e, BuildPiece, "tier")},hp${w.getField(e, BuildPiece, "hp")}`;
  }).sort();
}
/** Loot signature over storage pieces (loot follows placement order, so this pins the stream too). */
function ruinLoot(w: ReturnType<typeof createGameServer>["world"]): string[] {
  return [...w.query([BuildPiece])].flatMap((e) => {
    const k = gameplayDefs(w).pieces.get(w.getField(e, BuildPiece, "type")!)?.key ?? "?";
    if (!(k.includes("storage") || k.includes("chest") || k === "barrel_storage" || k.includes("wardrobe"))) return [];
    const st = resolveAttachment(w, e, AttachKind.Storage);
    if (!st) return [`${k}:nostorage`];
    return listSlots(w, st).map((s) => `${k}:${s.item}:${s.count}`);
  }).sort();
}
function markerSig(w: ReturnType<typeof createGameServer>["world"]): string[] {
  return [...w.query([AbandonedSite])].map((m) =>
    `${w.getField(m, AbandonedSite, "originX")},${w.getField(m, AbandonedSite, "originY")},${w.getField(m, AbandonedSite, "width")}x${w.getField(m, AbandonedSite, "height")},k${w.getField(m, AbandonedSite, "kind")}`).sort();
}

function makeGame() {
  const net = new LoopbackNetwork(3);
  const gs = createGameServer({ transport: net.createServer(), store: new MemoryWorldStore(), seed: SEED });
  return { gs, w: gs.world };
}

describe("ruin stamps stay time-sliced from tick 0 (ADR-547)", () => {
  it("a site chunk loaded in play leaves its stamp pending after the load tick, then completes over ticks", () => {
    const { gs, w } = makeGame();
    const bootPieces = [...w.query([BuildPiece])].length;
    const bootMarkers = [...w.query([AbandonedSite])].length;
    expect(bootPieces).toBeGreaterThan(0); // the boot drain completed the boot-area sites
    expect(pendingAbandonedStamps(w)).toEqual([]);
    gs.chunks.setSource(SITE);
    gs.step(1 / 20); // tick 1: the site chunk loads and its stamp is planned in onLoad
    expect(pendingAbandonedStamps(w).length).toBeGreaterThan(0); // NOT drained synchronously
    expect([...w.query([BuildPiece])].length).toBe(bootPieces); // no piece of the new site placed in the load tick
    expect([...w.query([AbandonedSite])].length).toBe(bootMarkers); // marker only when the site completes
    gs.step(1 / 20); // tick 2: the postSim pump places the first slice
    const afterSlice = [...w.query([BuildPiece])].length - bootPieces;
    expect(afterSlice).toBeGreaterThan(0);
    expect(afterSlice).toBeLessThanOrEqual(ABANDONED_STAMP_PIECES_PER_TICK); // 20 pieces/tick
    let guard = 0;
    while (pendingAbandonedStamps(w).length > 0 && guard++ < 30) gs.step(1 / 20);
    expect(pendingAbandonedStamps(w)).toEqual([]);
    expect([...w.query([AbandonedSite])].length).toBe(bootMarkers + 1); // the site finished, with its marker
    expect([...w.query([BuildPiece])].length).toBeGreaterThan(bootPieces);
  });

  it("a sliced stamp ends byte-identical to the old synchronous drain (pieces + loot + markers)", () => {
    const run = (drainEachStep: boolean) => {
      const { gs, w } = makeGame();
      gs.chunks.setSource(SITE);
      for (let i = 0; i < 40; i++) { gs.step(1 / 20); if (drainEachStep) drainAbandonedStamps(w); }
      expect(pendingAbandonedStamps(w)).toEqual([]);
      return { pieces: ruinSig(w), loot: ruinLoot(w), markers: markerSig(w) };
    };
    const sliced = run(false); // ADR-547: pump only, no tick<60 drain
    const drained = run(true); // old behaviour: drain after every step while tick < 60
    expect(sliced.markers).toEqual(drained.markers);
    expect(sliced.pieces).toEqual(drained.pieces);
    expect(sliced.loot).toEqual(drained.loot);
  });
});
