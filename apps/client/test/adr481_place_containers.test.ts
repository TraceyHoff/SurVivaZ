// @vitest-environment jsdom
/**
 * ADR-481: the inventory panel shows a Place button for liquid containers (next to Drop) that sends
 * the PlaceItem intent; other items show no Place button.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { installPermissions, Membership, PlayerId, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";

const d = G.defaultDefs(); const id = (k: string): number => d.itemId(k);

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
  const names = G.playerNames(w);
  const mk = (pid: number, name: string, x = 0): Entity => { const p = G.spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); names.set(pid, name); return p; };
  const me = mk(7, "Ada"); const sent: G.MenuIntent[] = [];
  const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, gameplay: { ctx: () => ({ world: w, player: me, names }), send: (i) => { sent.push(i); return true; } } });
  return { w, me, mk, sent, menus };
}
const q = (sel: string): HTMLElement => { const e = document.querySelector<HTMLElement>(sel); if (!e) throw new Error(`missing ${sel}`); return e; };

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("ADR-481 Place button", () => {
  test("a liquid container shows Place next to Drop and sends the PlaceItem intent", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("water_flask"), 1);
    menus.open("inventory"); q("[data-role=slot][data-item]").click();
    const place = q("[data-key=place-0]"); expect(place.textContent).toBe("Place");
    expect(q("[data-role=drop]")).toBeTruthy(); // Drop is still there, Place sits next to it
    place.click();
    expect(sent.at(-1)).toMatchObject({ cmd: G.PlaceItemCmd, args: { item: id("water_flask") } });
    menus.destroy();
  });

  test("a non-container shows no Place button", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("wood"), 5);
    menus.open("inventory"); q("[data-role=slot][data-item]").click();
    expect(document.querySelector("[data-key=place-0]")).toBeNull();
    expect(q("[data-role=drop]")).toBeTruthy();
    menus.destroy();
  });
});
