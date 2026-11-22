/** ADR-515: the per-claim piece cap (maxPiecesPerZone) is counted from the index, so pieces indexed on load /
 *  replication count too (the running tally restarted at 0 after every load, so the cap never held across restarts). */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
function rig(cap: number) {
  const w = makeWorld(); installPermissions(w);
  (G.gameplayDefs(w).building as { maxPiecesPerZone: number }).maxPiecesPerZone = cap;
  const A = spawnLearned(w, { x: 2.5, y: 2.5, maxWeight: 0, clientId: 1 }); w.add(A, PlayerId, { id: 1 });
  const snap = (key: string, x: number, y: number) => G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
  const put = (key: string, x: number, y: number) => { const s = snap(key, x, y); if (typeof s === "number") throw new Error(`${key} ${s}`); return G.placePiece(w, A, s, { pay: false }); };
  const why = (x: number, y: number) => { const s = snap("foundation", x, y); return typeof s === "number" ? s : G.validatePlacement(w, A, s, { ignoreCost: true }); };
  return { w, A, put, why };
}
describe("ADR-515 claim piece cap", () => {
  it("counts placed pieces, and still counts them after they are re-indexed as on a load", () => {
    const cap = 3; const { w, put, why } = rig(cap);
    const flag = put("claim_totem", 0.5, 6.5);
    const ps = [put("foundation", 1, 1), put("foundation", 2, 1), put("foundation", 3, 1)];
    expect(G.zonePieceCount(w, flag)).toBe(3); expect(why(2, 3)).toBe(G.BuildFail.ZoneFull);
    // drop them from the index and let structureIndexSystem pick them up again (the load / replication path)
    const idx = G.structures(w); for (const p of ps) idx.removePiece(p); steps(w, 2);
    expect(idx.info.has(ps[0]!)).toBe(true);
    expect(G.zonePieceCount(w, flag)).toBe(3); expect(why(2, 3)).toBe(G.BuildFail.ZoneFull);
  });
  it("follows removals, and a lifted move preview does not leave a stale count", () => {
    const { w, A, put } = rig(10);
    const flag = put("claim_totem", 0.5, 6.5); const a = put("foundation", 1, 1); put("foundation", 2, 1); put("foundation", 3, 1);
    // a lifted move preview counts without the piece, then rewinds the index version: the cache must not keep that
    expect(G.structures(w).lifted(a, () => G.zonePieceCount(w, flag))).toBe(2);
    put("foundation", 1, 3); expect(G.zonePieceCount(w, flag)).toBe(4); void A;
    G.destroyPiece(w, a, G.DestroyCause.Demolish); expect(G.zonePieceCount(w, flag)).toBe(3);
  });
});
