// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { BuildMode } from "../src/build-mode.js";

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  const put = (key: string, x: number, y: number): void => {
    const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
    if (typeof sn === "number") throw new Error(`${key}: ${sn}`);
    G.placePiece(w, 0, sn, { pay: false });
  };
  put("foundation", 1, 1);
  let aim = { x: 1.5, y: 1.5 }; const sent: G.MenuIntent[] = [];
  const bm = new BuildMode({ input: { pressed: () => false, push: () => undefined, pop: () => undefined }, ctx: () => ({ world: w, player: me, names: new Map() }),
    aim: () => ({ ...aim, mode: 1 }), send: (i) => { sent.push(i); return true; } });
  bm.start({ piece: d.pieceId("foundation"), tier: 1, variant: 0, paint: 0 });
  return { bm, sent, at: (x: number, y: number) => { aim = { x, y }; } };
}

describe("ADR-302 demolish target naming", () => {
  test("title-cases the aimed piece and names it in the confirm prompt, button, and toast", () => {
    const { bm, sent, at } = setup(); at(1.5, 1.5); bm.update();
    expect(bm.context?.target.pieceKey).toBe("foundation");
    expect(bm.context?.title).toMatch(/^Foundation · /);
    expect(bm.act("demolish")).toBe(false);
    expect(bm.toast).toBe("Demolish Foundation? Press again to confirm");
    expect(bm.context?.actions.find((a) => a.id === "demolish")?.label).toBe("Confirm demolish Foundation");
    expect(bm.context?.title).toMatch(/^Demolish Foundation\?/);
    expect(bm.act("demolish")).toBe(true);
    expect(bm.toast).toBe("Demolishing Foundation…");
    expect(sent).toHaveLength(1);
  });
  test("exposes an amber-ready outline of the aimed piece", () => {
    const { bm, at } = setup(); at(1.5, 1.5); bm.update();
    const out = bm.targetOutline;
    expect(out?.segments.length).toBeGreaterThanOrEqual(1);
    expect(typeof out?.z).toBe("number");
  });
});
