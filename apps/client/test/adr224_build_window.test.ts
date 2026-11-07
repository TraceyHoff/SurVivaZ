// @vitest-environment jsdom
// ADR-224: build window — data tabs, tier tabs, tile grid (glyph, cost, lock), details pane, choose = start placing.
import { beforeEach, describe, expect, test } from "vitest";
import { installPermissions, Membership, PlayerId, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";
import { BuildMode } from "../src/build-mode.js";
import { PAD } from "../src/ui-nav.js";
import { pieceGlyph } from "../src/gameplay-panels.js";

type Pad = { buttons: { pressed: boolean; value?: number }[]; axes: number[] };
const pad = (): Pad => ({ buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes: [0, 0, 0, 0] });
const d = G.defaultDefs(); const id = (k: string): number => d.itemId(k);

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
  const names = G.playerNames(w); const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(me, PlayerId, { id: 7 }).add(me, Membership, { partyId: 0, clanId: 0 }); names.set(7, "Ada");
  const sent: G.MenuIntent[] = []; const placing: unknown[] = []; const pads: Pad[] = [pad()];
  const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, getGamepads: () => pads,
    gameplay: { ctx: () => ({ world: w, player: me, names }), send: (i: G.MenuIntent) => { sent.push(i); return true; }, startPlacing: (s: unknown) => { placing.push(s); } } as never });
  const press = (b: number): void => { const p = pad(); p.buttons[b]!.pressed = true; pads[0] = p; menus.nav.pollGamepad(); pads[0] = pad(); menus.nav.pollGamepad(); };
  /** D-pad until the focused element matches (bounded, like a player holding ↓/→). */
  const seek = (sel: string, txt?: string): HTMLElement => {
    for (const dir of [PAD.DOWN, PAD.RIGHT, PAD.UP]) for (let i = 0; i < 80; i++) {
      const a = document.activeElement as HTMLElement | null; if (a?.matches(sel) && (!txt || a.textContent!.includes(txt))) return a; press(dir);
    }
    throw new Error(`pad could not reach ${sel} ${txt ?? ""}`);
  };
  return { w, me, sent, placing, menus, press, seek };
}

const q = <T extends HTMLElement = HTMLElement>(s: string): T => { const e = document.querySelector<T>(s); if (!e) throw new Error("missing " + s); return e; };
const rich = (w: World, me: number): void => { for (const k of ["wood", "stone", "fiber", "sticks"]) G.addItem(w, me as never, id(k), 200); };

describe("ADR-224 build window", () => {
  test("category tabs from data, tile grid with glyph + cost, no tooltips, no Place button", () => {
    const { menus } = setup(); menus.open("build");
    const cats = document.querySelectorAll("[data-role=build-cats] button"); expect(cats.length).toBeGreaterThan(1);
    expect(q("[data-role=build-cats]").dataset["tabs"]).toBe("tab");
    const tiles = document.querySelectorAll<HTMLElement>("[data-role=piece-grid] [data-role=piece]"); expect(tiles.length).toBeGreaterThan(3);
    for (const t of Array.from(tiles)) { expect(t.dataset["glyph"]).toBeTruthy(); expect(t.querySelector(".nm")!.textContent).toBeTruthy(); expect(t.querySelector(".ct")!.textContent).toBeTruthy(); expect(t.getAttribute("aria-label")).toBeTruthy(); }
    expect(document.querySelector("[data-menu=build] [data-role=piece][data-tip], [data-menu=build] [data-key^=tier-][data-tip]")).toBeNull();
    expect(document.querySelector("[data-key=place]")).toBeNull();
    expect(q("[data-role=build-details]").textContent).toBeTruthy();
    const other = Array.from(cats).find((b) => b.getAttribute("aria-pressed") !== "true") as HTMLElement; const before = tiles[0]!.dataset["key"]; other.click();
    expect(document.querySelector<HTMLElement>("[data-role=piece-grid] [data-role=piece]")!.dataset["key"]).not.toBe(before); menus.destroy();
  });
  test("ADR-288: Furniture consolidates storage, wardrobes and crop plots without moving structure", () => {
    const { menus } = setup(); menus.open("build");
    const tabKeys = Array.from(document.querySelectorAll<HTMLElement>("[data-role=build-cats] button")).map((b) => b.dataset["key"]);
    expect(tabKeys.slice(0, 2)).toEqual(["bcat-structure", "bcat-furniture"]);
    const furniture = ["storage_box", "basic_storage_box", "large_chest", "wardrobe_rustic", "wardrobe_fine", "wardrobe_luxury",
      "herb_planter", "window_planter", "planter_box", "garden_bed", "barrel_storage", "basket", "mirror_standing", "mirror_wall",
      "weapon_rack", "wall_shelf", "apiary", "feeding_trough", "pet_trough", "salt_barrel", "curing_box", "cold_store",
      "bed", "chair", "table", "shelf_rustic"];
    const tile = (key: string) => `[data-role=piece-grid] [data-key=piece-${d.pieceId(key)}]`;
    q("[data-key=bcat-furniture]").click();
    expect(q("[data-key=bcat-furniture]").textContent).toBe("Furniture");
    for (const key of furniture) expect(document.querySelector(tile(key)), key).not.toBeNull();
    expect(q("[data-role=piece-grid] button .nm").textContent).toBe("herb planter");
    for (const cat of ["structure", "decor", "plants", "wall", "outdoor"]) {
      q(`[data-key=bcat-${cat}]`).click();
      for (const key of furniture) expect(document.querySelector(tile(key)), `${key} not in ${cat}`).toBeNull();
    }
    q("[data-key=bcat-structure]").click();
    for (const key of ["foundation", "wall", "floor", "roof_flat", "stairs", "door_wood"]) expect(document.querySelector(tile(key)), key).not.toBeNull();
    q("[data-key=bcat-outdoor]").click();
    for (const key of ["fence_picket", "garden_gate", "path_stone", "bench_park"]) expect(document.querySelector(tile(key)), key).not.toBeNull();
    q("[data-key=bcat-decor]").click();
    for (const key of ["crate_decor", "ladder"]) expect(document.querySelector(tile(key)), key).not.toBeNull();
    menus.destroy();
  });
  test("ADR-288: pad shoulders, D-pad and A reach Furniture and choose a piece through the existing placement path", () => {
    const { menus, w, me, press, seek, placing } = setup(); rich(w, me as never);
    menus.open("build"); q("[data-key=bcat-structure]").click();
    press(PAD.RB); expect(q("[data-key=bcat-furniture]").getAttribute("aria-pressed")).toBe("true");
    press(PAD.LB); expect(q("[data-key=bcat-structure]").getAttribute("aria-pressed")).toBe("true");
    seek("[data-key=bcat-furniture]"); press(PAD.A);
    expect(q("[data-key=bcat-furniture]").getAttribute("aria-pressed")).toBe("true");
    seek(`[data-key=piece-${d.pieceId("basic_storage_box")}]`); press(PAD.A);
    expect(placing).toHaveLength(1); expect(placing[0]).toMatchObject({ piece: d.pieceId("basic_storage_box") });
    expect(menus.nav.isOpen).toBe(false);
    // Restore the remembered tier so this pad placement does not leak state into the existing tier test.
    menus.open("build"); q("[data-key=bcat-structure]").click(); q("[data-role=build-tiers] button").click(); menus.destroy();
  });
  test("structural pieces get tier tabs (LT/RT) and the tile cost follows the tier", () => {
    const { menus } = setup(); menus.open("build"); q("[data-key=bcat-structure]").click();
    const tg = q("[data-role=build-tiers]"); expect(tg.dataset["tabs"]).toBe("page"); const tb = tg.querySelectorAll<HTMLElement>("button"); expect(tb.length).toBeGreaterThan(1);
    const ct0 = q("[data-role=piece-grid] [data-role=piece] .ct").textContent; tb[tb.length - 1]!.click();
    expect(q("[data-role=build-tiers] button[aria-pressed=true]").dataset["key"]).toBe(tb[tb.length - 1]!.dataset["key"]);
    expect(q("[data-role=piece-grid] [data-role=piece] .ct").textContent).not.toBe(ct0); menus.destroy();
  });
  test("focus / hover shows the piece in the details pane; choosing an affordable tile starts placing and closes (mouse + pad)", () => {
    const { w, me, placing, menus, press, seek } = setup(); rich(w, me as never); menus.open("build"); q("[data-key=bcat-structure]").click(); q("[data-role=build-tiers] button").click();
    const tiles = document.querySelectorAll<HTMLElement>("[data-role=piece-grid] [data-role=piece]"); tiles[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(q("[data-role=build-name]").textContent!.toLowerCase()).toContain(tiles[1]!.querySelector(".nm")!.textContent!.toLowerCase());
    q("[data-role=piece-grid] [data-role=piece]:not([data-locked]):not([data-short])").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(placing).toHaveLength(1); expect(menus.nav.isOpen).toBe(false);
    menus.open("build"); seek("[data-role=piece]:not([data-locked]):not([data-short])"); press(PAD.A); expect(placing).toHaveLength(2); expect(menus.nav.isOpen).toBe(false); menus.destroy();
  });
  test("an unaffordable tile does not start placing; it explains what is missing", () => {
    const { placing, menus } = setup(); menus.open("build"); q("[data-key=bcat-structure]").click();
    const t = q("[data-role=piece-grid] [data-role=piece][data-short]"); t.click(); expect(placing).toHaveLength(0); expect(menus.nav.isOpen).toBe(true);
    expect(document.querySelector("[data-role=build-cost] [data-have='0']")).not.toBeNull(); menus.destroy();
  });
  test("pieceGlyph maps keys to a preview symbol", () => {
    expect(pieceGlyph("foundation_triangle")).toBe("▦"); expect(pieceGlyph("door_wood")).toBe("🚪"); expect(pieceGlyph("campfire")).toBe("🔥"); expect(pieceGlyph("zzz")).toBe("◼");
  });
  test("Cancel after a menu-started placement goes back to the menu only once Cancel is released", () => {
    const st = { pressed: new Set<string>(), down: new Set<string>() }; let back = 0;
    const input = { pressed: (a: string) => st.pressed.has(a), down: (a: string) => st.down.has(a), push() {}, pop() {} };
    const w = new World({ seed: 1, maxEntities: 1 << 10 }); G.installGameplay(w, {}); const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const bm = new BuildMode({ input, ctx: () => ({ world: w, player: me }), send: () => true, aim: () => undefined, device: () => "gamepad", onBack: () => { back++; } } as never);
    bm.start({ piece: 1, tier: 0, variant: 0, paint: 0 }, { fromMenu: true }); bm.update();
    st.pressed.add("Build.Cancel"); st.down.add("Build.Cancel"); bm.update(); expect(bm.active).toBe(false); expect(back).toBe(0);
    st.pressed.clear(); bm.update(); expect(back).toBe(0); st.down.clear(); bm.update(); expect(back).toBe(1); bm.update(); expect(back).toBe(1);
    bm.start({ piece: 1, tier: 0, variant: 0, paint: 0 }); st.pressed.add("Build.Cancel"); bm.update(); st.pressed.clear(); bm.update(); expect(back).toBe(1);
  });
});
