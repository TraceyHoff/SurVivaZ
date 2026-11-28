// Building variety (ADR number set at push): the realistic catalogue's floor plans obey real-building rules.
import { describe, expect, it } from "vitest";
import { REALISTIC_KINDS, buildRealistic, pieceFacts, type KindDef, type RSpec } from "../src/building/realistic.js";

const k2 = (x: number, y: number): string => `${x},${y}`;
function blockTiles(def: KindDef, bi: number, l: number): Map<string, number> {
  const b = def.blocks[bi]!; const m = new Map<string, number>();
  b.rooms.forEach((r, i) => { if (r.l !== l) return; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { expect(m.has(k2(x, y)), `${def.key} block ${bi} floor ${l}: rooms overlap at ${x},${y}`).toBe(false); m.set(k2(x, y), i); } });
  return m;
}
/** Walk the floor: tiles connect unless a wall without a doorway stands between them. */
function reachable(pieces: RSpec[], def: KindDef, bi: number, l: number, start: [number, number], solid: Set<string>): Set<string> {
  const b = def.blocks[bi]!;
  const walls = new Set<string>(); const doors = new Set<string>();
  for (const p of pieces) if (p.level === l && (p.role === "wall")) { const key = k2(p.x - b.x, p.y - b.y); if (p.key === "wall_doorway") doors.add(key); else walls.add(key); }
  const seen = new Set<string>([k2(...start)]); const q: [number, number][] = [start];
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [nx, ny, ex, ey] of [[x + 1, y, x + 1, y + 0.5], [x - 1, y, x, y + 0.5], [x, y + 1, x + 0.5, y + 1], [x, y - 1, x + 0.5, y]] as const) {
      if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h) continue;
      const e = k2(ex, ey); if (walls.has(e) && !doors.has(e)) continue;
      const t = k2(nx, ny); if (seen.has(t) || solid.has(t)) continue; seen.add(t); q.push([nx, ny]);
    }
  }
  return seen;
}

describe("building variety: realistic floor plans", () => {
  for (const def of REALISTIC_KINDS) {
    it(`${def.key}: rooms tile every floor, doors and windows sit on walls, every room is reachable and furnished`, () => {
      const built = buildRealistic(def);
      expect(built.w).toBeLessThanOrEqual(28); expect(built.h).toBeLessThanOrEqual(28);
      for (const p of built.pieces) { expect(p.x, `${def.key} ${p.key}`).toBeGreaterThanOrEqual(0); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(def.w); expect(p.y).toBeLessThanOrEqual(def.h); expect(pieceFacts(p.key), p.key).toBeDefined(); }
      def.blocks.forEach((b, bi) => {
        expect(b.x + b.w).toBeLessThanOrEqual(def.w); expect(b.y + b.h).toBeLessThanOrEqual(def.h);
        if (b.canopy) return;
        for (let l = 0; l < b.stories; l++) {
          const tiles = blockTiles(def, bi, l);
          expect(tiles.size, `${def.key} block ${bi} floor ${l} fully tiled by rooms`).toBe(b.w * b.h);
          // solid furniture on this floor
          const solid = new Set<string>();
          for (const p of built.pieces) if (p.level === l && (p.role === "furniture" || p.role === "loot") && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h) {
            const f = pieceFacts(p.key)!; const w = p.rot & 1 ? f.h : f.w, h = p.rot & 1 ? f.w : f.h;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) solid.add(k2(Math.round(p.x - b.x - w / 2) + i, Math.round(p.y - b.y - h / 2) + j));
          }
          // starts: every exterior door tile of the block on the ground floor, every stair landing above
          const starts: [number, number][] = [];
          const inB = (x: number, y: number): boolean => x >= b.x - 0.01 && x <= b.x + b.w + 0.01 && y >= b.y - 0.01 && y <= b.y + b.h + 0.01;
          if (l === 0) {
            for (const door of built.pieces) {
              if (!(door.level === 0 && door.role === "opening" && door.key.startsWith("door") && inB(door.x, door.y))) continue;
              const lx = door.x - b.x, ly = door.y - b.y;
              if (ly === 0) starts.push([Math.floor(lx), 0]); else if (ly === b.h) starts.push([Math.floor(lx), b.h - 1]);
              else if (lx === 0) starts.push([0, Math.floor(ly)]); else if (lx === b.w) starts.push([b.w - 1, Math.floor(ly)]);
            }
            expect(starts.length, `${def.key} block ${bi}: an exterior door`).toBeGreaterThan(0);
          } else {
            for (const s of b.stairs ?? []) if (s.l === l - 1) starts.push([s.x, s.y - 1]);
            expect(starts.length, `${def.key} floor ${l}: a flight up to it`).toBeGreaterThan(0);
          }
          for (const st of starts) expect(solid.has(k2(...st)), `${def.key} block ${bi} floor ${l}: entry tile ${st} clear`).toBe(false);
          const start = starts[0]!;
          const seen = new Set<string>(); for (const st of starts) for (const t of reachable(built.pieces, def, bi, l, st, solid)) seen.add(t);
          b.rooms.forEach((r) => {
            if (r.l !== l) return;
            let any = false; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (seen.has(k2(x, y))) any = true;
            expect(any, `${def.key} block ${bi} floor ${l}: ${r.t} room at ${r.x},${r.y} is reachable (start ${start}, seen ${[...seen].join(' ')})`).toBe(true);
          });
          // stairs: the entry tile below and the landing above are walkable
          for (const s of b.stairs ?? []) if (s.l === l) expect(seen.has(k2(s.x, s.y + 1)), `${def.key}: stair entry reachable on floor ${l}`).toBe(true);
        }
      });
      // windows only in exterior walls, never interior partitions
      for (const p of built.pieces) if (p.key === "wall_window") {
        const b = def.blocks.find((q) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h)!;
        const onEdge = Math.abs(p.x - b.x) < 0.01 || Math.abs(p.x - b.x - b.w) < 0.01 || Math.abs(p.y - b.y) < 0.01 || Math.abs(p.y - b.y - b.h) < 0.01;
        expect(onEdge, `${def.key}: window at ${p.x},${p.y} is in an exterior wall`).toBe(true);
      }
      const furn = built.pieces.filter((p) => p.role === "furniture" || p.role === "loot").length;
      expect(furn, `${def.key} has furnishings`).toBeGreaterThan(2);
    });
  }
  it("prints a catalogue summary", () => {
    for (const def of REALISTIC_KINDS) {
      const b = buildRealistic(def); const c = (r: string) => b.pieces.filter((p) => p.role === r).length;
      console.log(`${def.key.padEnd(18)} ${def.w}x${def.h} st${b.stories} pieces ${b.pieces.length} rooms ${b.rooms.length} furn ${c("furniture")} loot ${c("loot")} win ${b.pieces.filter((p) => p.key === "wall_window").length} doors ${b.pieces.filter((p) => p.role === "opening" && p.key.startsWith("door")).length}`);
    }
  });
});
