// ADR-594: abandoned structures spawn fully formed (every planned piece, full HP, damage stage 0) and legacy
// (ruined) sites in older saves are restored once, without duplicating pieces or loot.
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";
import { weatherSite } from "./weather_site.js";

const allKinds = Object.values(G.AbandonedKind) as G.AbandonedKindId[];
const keyOf = (w: World, e: Entity): string => G.gameplayDefs(w).pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?";
const hpFull = (w: World, e: Entity): boolean => w.getField(e, G.BuildPiece, "hp") === G.maxHpOf(w, e) && w.getField(e, G.BuildPiece, "damageStage") === 0;
const pieceCount = (w: World): number => [...w.query([G.BuildPiece])].length;

/** Stamp the first chunk-planned site (through the real chunk-load entry) that the test world accepts. */
function stampFirstChunkSite(w: World, from = 1): { cx: number; cy: number; plan: NonNullable<ReturnType<typeof G.planAbandonedChunk>>; marker: Entity } {
  for (let cy = from; cy < from + 40; cy++) for (let cx = from; cx < from + 40; cx++) {
    const plan = G.planAbandonedChunk(w.seed, cx, cy); if (!plan) continue;
    const r = G.stampAbandonedChunk(w, { cx, cy }); if (!r || r.skipped) continue;
    G.drainAbandonedStamps(w);
    if (r.marker) return { cx, cy, plan, marker: r.marker };
  }
  throw new Error("no stampable chunk site found");
}

describe("ADR-594 intact abandoned structures", () => {
  it("every kind plans with nothing omitted, full HP fraction and every stair, at any ruin value", () => {
    for (const kind of allKinds) for (const ruin of [0, 0.4, 0.8]) {
      const plan = G.planAbandonedSite(7, 16, 16, { kind, rot: 1, ruin });
      expect(plan.pieces.length, `kind ${kind}`).toBeGreaterThan(0);
      expect(plan.pieces.every((p) => !p.omit && p.hpFrac === 1), `kind ${kind} ruin ${ruin}`).toBe(true);
    }
  });

  it("the plan layout does not depend on the ruin value (existing layouts unchanged)", () => {
    for (const kind of allKinds) {
      const a = G.planAbandonedSite(11, 8, 8, { kind, rot: 2, ruin: 0 }), b = G.planAbandonedSite(11, 8, 8, { kind, rot: 2, ruin: 0.9 });
      expect(b.pieces.map((p) => `${p.key}@${p.x},${p.y},${p.level}`)).toEqual(a.pieces.map((p) => `${p.key}@${p.x},${p.y},${p.level}`));
    }
  });

  it("every kind at every rotation places EVERY planned piece (walls, floors, roofs, doors, windows, furniture, loot, fences, beds), full HP, unowned", () => {
    for (const kind of allKinds) for (const rot of [0, 1, 2, 3]) {
      const w = makeWorld();
      const r = G.stampAbandonedSite(w, 8, 8, { kind, rot, ruin: 0.9, tier: 1 });
      G.drainAbandonedStamps(w);
      const tag = `kind ${G.ABANDONED_KIND_KEYS[kind]} rot ${rot}`;
      expect(r.skipped, tag).toBe(false);
      expect(r.omitted, tag).toBe(0);
      const plan = G.planAbandonedSite(w.seed, 8, 8, { kind, rot, ruin: 0.9, tier: 1 });
      const want = new Map<string, number>(), have = new Map<string, number>();
      for (const p of plan.pieces) want.set(p.key, (want.get(p.key) ?? 0) + 1);
      for (const e of r.placed) have.set(keyOf(w, e), (have.get(keyOf(w, e)) ?? 0) + 1);
      for (const [k, n] of want) expect(have.get(k) ?? 0, `${tag} ${k}`).toBeGreaterThanOrEqual(n);
      expect(r.placed.length, tag).toBe(plan.pieces.length);
      expect(r.placed.every((e) => hpFull(w, e)), tag).toBe(true);
      expect(r.placed.every((e) => (w.getField(e, G.PieceOwner, "player") ?? 0) === 0 && (w.getField(e, G.Tribe, "id") ?? 0) === 0), tag).toBe(true);
    }
  });

  it("a creature standing on a wall slot is stepped aside, not allowed to leave a hole", () => {
    const w = makeWorld();
    const plan = G.planAbandonedSite(w.seed, 8, 8, { kind: G.AbandonedKind.Farmhouse, rot: 0, ruin: 0.5, tier: 1 });
    const wall = plan.pieces.find((p) => p.role === "wall" && p.key === "wall")!;
    const cow = w.create();
    w.add(cow, Transform, { x: wall.x, y: wall.y, z: 0 }).add(cow, G.Health, { hp: 10, max: 10 } as never);
    G.indexEntity(w, cow);
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Farmhouse, rot: 0, ruin: 0.5, tier: 1 });
    G.drainAbandonedStamps(w);
    expect(r.placed.length).toBe(plan.pieces.length);
    const t = w.get(cow, Transform)!;
    expect(t.x < 8 - 0.5 || t.x > 8 + plan.width + 0.5 || t.y < 8 - 0.5 || t.y > 8 + plan.height + 0.5).toBe(true);
  });

  it("keeps abandonment: unclaimed marker, and loot containers still hold searchable loot", () => {
    const w = makeWorld();
    const s = stampFirstChunkSite(w);
    expect(w.getField(s.marker, G.AbandonedSite, "claimed")).toBe(0);
    const boxes = [...w.query([G.BuildPiece])].filter((e) => G.resolveAttachment(w, e, G.AttachKind.Storage));
    expect(boxes.length).toBeGreaterThan(0);
  });

  it("player damage still works on an intact site piece (HP drops, stage rises)", () => {
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0.5, tier: 1 });
    G.drainAbandonedStamps(w);
    const wall = r.placed.find((e) => keyOf(w, e) === "wall")!;
    const max = G.maxHpOf(w, wall);
    w.setField(wall, G.BuildPiece, "hp", Math.round(max * 0.2));
    w.setField(wall, G.BuildPiece, "damageStage", G.damageStageFor(w, Math.round(max * 0.2), max));
    expect(w.getField(wall, G.BuildPiece, "damageStage")).toBeGreaterThan(0);
  });
});

describe("ADR-594 legacy sites are restored once on load", () => {
  it("heals damaged pieces and re-places missing ones with no duplicates", () => {
    const w = makeWorld();
    const s = stampFirstChunkSite(w);
    const full = pieceCount(w);
    const gone = weatherSite(w, [...w.query([G.BuildPiece])], 0.9);
    expect(gone.length).toBeGreaterThan(0);
    expect(pieceCount(w)).toBeLessThan(full);
    G.markLegacyAbandonedChunk(w, s.cx, s.cy);
    G.stampAbandonedChunk(w, { cx: s.cx, cy: s.cy });
    G.drainAbandonedStamps(w);
    expect(pieceCount(w)).toBe(full);
    expect([...w.query([G.BuildPiece])].every((e) => hpFull(w, e))).toBe(true);
    // one marker, and a second load of the same chunk (no legacy mark) changes nothing
    expect([...w.query([G.AbandonedSite])].length).toBe(1);
    G.stampAbandonedChunk(w, { cx: s.cx, cy: s.cy }); G.drainAbandonedStamps(w);
    expect(pieceCount(w)).toBe(full);
  });

  it("restoring an already intact site is a no-op (idempotent, no duplicated pieces or loot)", () => {
    const w = makeWorld();
    const s = stampFirstChunkSite(w);
    const before = pieceCount(w);
    const items = (): number => [...w.query([G.BuildPiece])].reduce((n, e) => n + (G.resolveAttachment(w, e, G.AttachKind.Storage) ? 1 : 0), 0);
    const boxes = items();
    G.markLegacyAbandonedChunk(w, s.cx, s.cy); G.stampAbandonedChunk(w, { cx: s.cx, cy: s.cy }); G.drainAbandonedStamps(w);
    expect(pieceCount(w)).toBe(before); expect(items()).toBe(boxes);
  });

  it("never touches a claimed site or the loot already in its containers", () => {
    const w = makeWorld();
    const s = stampFirstChunkSite(w);
    const box = [...w.query([G.BuildPiece])].map((e) => G.resolveAttachment(w, e, G.AttachKind.Storage)).find((b) => !!b)!;
    const content = (): string => JSON.stringify(w.get(box, G.Container));
    const snapshot = content();
    const victim = [...w.query([G.BuildPiece])].find((e) => keyOf(w, e).startsWith("roof_"))!;
    G.destroyPiece(w, victim, 1 as never);
    // claimed: untouched (the missing roof is NOT restored)
    w.setField(s.marker, G.AbandonedSite, "claimed", 1);
    const n = pieceCount(w);
    G.markLegacyAbandonedChunk(w, s.cx, s.cy); G.stampAbandonedChunk(w, { cx: s.cx, cy: s.cy }); G.drainAbandonedStamps(w);
    expect(pieceCount(w)).toBe(n);
    expect(content()).toBe(snapshot); // existing container loot untouched
  });

  it("leaves player-owned pieces inside an unclaimed footprint alone", () => {
    const w = makeWorld();
    const s = stampFirstChunkSite(w);
    const p = spawnLearned(w, { x: s.plan.originX + 0.5, y: s.plan.originY - 2.5, maxWeight: 0, clientId: 1 });
    plantClaim(w, p, s.plan.originX - 3, s.plan.originY - 3);
    steps(w, 1);
    const mine = [...w.query([G.BuildPiece])].filter((e) => keyOf(w, e) === "claim_totem");
    expect(mine.length).toBe(1);
    const hp = w.getField(mine[0]!, G.BuildPiece, "hp");
    G.markLegacyAbandonedChunk(w, s.cx, s.cy); G.stampAbandonedChunk(w, { cx: s.cx, cy: s.cy }); G.drainAbandonedStamps(w);
    expect(w.getField(mine[0]!, G.BuildPiece, "hp")).toBe(hp);
    expect([...w.query([G.BuildPiece])].filter((e) => keyOf(w, e) === "claim_totem").length).toBe(1);
  });
});
