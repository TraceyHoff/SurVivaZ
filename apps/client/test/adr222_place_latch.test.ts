// @vitest-environment jsdom
/** ADR-222: choosing a piece with pad A / Enter / click never places it; the player positions, rotates and confirms. */
import { describe, expect, test } from "vitest";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { BuildMode, type BuildDevice } from "../src/build-mode.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

function rig(device: BuildDevice) {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w); G.grantSkillUnlocks(w, me);
  plantClaim(w, me, -4, -4); // ADR-310: base pieces need a covering Claim Flag
  const held = new Set<string>(); const edge = new Set<string>(); const sent: G.MenuIntent[] = [];
  const bm = new BuildMode({ input: { pressed: (a) => edge.has(a), down: (a) => held.has(a), push: () => {}, pop: () => {} }, device: () => device,
    ctx: () => ({ world: w, player: me, names: new Map() }), aim: () => ({ x: 2, y: 1, mode: 1 }), send: (i) => { sent.push(i); return true; } });
  const frame = (press: string[] = [], hold: string[] = []) => { edge.clear(); held.clear(); press.forEach((a) => { edge.add(a); held.add(a); }); hold.forEach((a) => held.add(a)); bm.update(); };
  return { w, me, d, bm, sent, frame };
}
const PLACEABLES = ["campfire", "workbench", "storage_box", "foundation", "lantern"];

describe("ADR-222 placement never auto-confirms", () => {
  for (const dev of ["gamepad", "keyboardMouse", "touch"] as const) test(`${dev}: the selecting press (held through the menu close) does not place`, () => {
    const { w, me, d, bm, sent, frame } = rig(dev); let placed = 0;
    for (const key of PLACEABLES) {
      const def = [...d.pieces.values()].find((p) => p.key === key); if (!def) continue;
      for (const c of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(w, me, c.item, c.count * 2);
      sent.length = 0;
      bm.start({ piece: def.id, tier: def.tiered ? 0 : def.fixedTier, variant: 0, paint: 0 });
      frame(["Build.PlaceConfirm"]); frame([], ["Build.PlaceConfirm"]); frame([], ["Build.PlaceConfirm"]);
      expect(sent, `${key}: no placement from the selecting press`).toEqual([]); expect(bm.active).toBe(true);
      frame([]); frame(["Build.RotateCW"]); expect(bm.preview?.pieceKey).toBe(key);
      frame(["Build.PlaceConfirm"]); expect(sent.length, `${key} places on a fresh confirm (valid=${bm.preview?.valid})`).toBe(bm.preview!.valid ? 1 : 0);
      placed += sent.length; bm.stop();
    }
    expect(placed).toBeGreaterThan(0);
  });
  test("re-selecting from the picker while already placing re-arms the latch", () => {
    const { d, bm, sent, frame } = rig("gamepad"); const f = [...d.pieces.values()].find((p) => p.key === "foundation")!;
    bm.start({ piece: f.id, tier: 0, variant: 0, paint: 0 }); frame([]); bm.start({ piece: f.id, tier: 0, variant: 0, paint: 0 });
    expect(bm.awaitingRelease).toBe(true); frame(["Build.PlaceConfirm"]); expect(sent).toEqual([]);
  });
});
