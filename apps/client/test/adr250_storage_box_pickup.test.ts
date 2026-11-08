// @vitest-environment jsdom
// ADR-250: the Basic Storage Box shows in the build window for a fresh character (with the borrowed crate icon until Art
// ships build_basic_storage_box) and its build-mode action reads "Pick up" (full refund) instead of "Demolish".
import { describe, expect, test } from "vitest";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { BuildMode } from "../src/build-mode.js";

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  const put = (key: string, x: number, y: number): void => { const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`${key}: ${sn}`); G.placePiece(w, 0, sn, { pay: false }); };
  put("basic_storage_box", 2.5, 1.5); put("storage_box", 4.5, 1.5);
  let aim = { x: 2.5, y: 1.5 }; const sent: G.MenuIntent[] = [];
  const bm = new BuildMode({ input: { pressed: () => false, push: () => undefined, pop: () => undefined }, ctx: () => ({ world: w, player: me, names: new Map() }),
    aim: () => ({ ...aim, mode: 1 }), send: (i) => { sent.push(i); return true; } });
  bm.start({ piece: d.pieceId("basic_storage_box"), tier: 1, variant: 0, paint: 0 });
  return { w, me, d, bm, sent, at: (x: number, y: number) => { aim = { x, y }; } };
}
describe("ADR-250 storage box in the client", () => {
  test("the build list offers it unlocked to a character with no skills", () => {
    const { w, me } = setup();
    const v = G.buildView({ world: w, player: me } as G.MenuCtx).find((x) => x.key === "basic_storage_box")!;
    expect(v.tiers.some((t) => t.locked)).toBe(false);
  });
  test("aimed box: action reads Pick up, needs a second press, then sends the demolish intent", () => {
    const { bm, sent, at } = setup(); at(2.5, 1.5); bm.update();
    expect(bm.context?.actions.find((a) => a.id === "demolish")?.label).toBe("Pick up");
    expect(bm.act("demolish")).toBe(false); expect(bm.toast).toBe("Pick up Basic Storage Box? Press again to confirm");
    expect(bm.context?.actions.find((a) => a.id === "demolish")?.label).toBe("Confirm pick up Basic Storage Box");
    expect(bm.context?.title).toMatch(/Basic Storage Box/);
    expect(bm.act("demolish")).toBe(true); expect(bm.toast).toBe("Picking up Basic Storage Box…"); expect(sent).toHaveLength(1);
  });
  test("ordinary storage keeps Demolish", () => {
    const { bm, at } = setup(); at(4.5, 1.5); bm.update();
    expect(bm.context?.target.pieceKey).toBe("storage_box");
    expect(bm.context?.actions.find((a) => a.id === "demolish")?.label).toBe("Demolish");
  });
});
