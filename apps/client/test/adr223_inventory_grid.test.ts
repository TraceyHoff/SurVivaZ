// @vitest-environment jsdom
// ADR-223: slot-grid inventory — layout, quick eat (double-click / double-tap / pad A), hotbar food, drag-drop, pad reach.
import { beforeEach, describe, expect, test } from "vitest";
import { installPermissions, Membership, PlayerId, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus, padMenuAction } from "../src/game-menus.js";
import { PAD } from "../src/ui-nav.js";
import { craftUi, resetSlotDrag } from "../src/gameplay-panels.js";

type Pad = { buttons: { pressed: boolean; value?: number }[]; axes: number[] };
const pad = (): Pad => ({ buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes: [0, 0, 0, 0] });
const d = G.defaultDefs(); const id = (k: string): number => d.itemId(k);

beforeEach(() => { resetSlotDrag(); document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

function setup() {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
  const names = G.playerNames(w); const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(me, PlayerId, { id: 7 }).add(me, Membership, { partyId: 0, clanId: 0 }); names.set(7, "Ada");
  const sent: G.MenuIntent[] = []; const placing: unknown[] = []; const pads: Pad[] = [pad()];
  const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, getGamepads: () => pads,
    gameplay: { ctx: () => ({ world: w, player: me, names }), send: (i: G.MenuIntent) => { sent.push(i); const a = i.args as Record<string, number>; const f = i.cmd === G.SplitStackCmd ? G.splitStack(w, me, a["where"]!, a["slot"]!, a["count"]!) : i.cmd === G.MoveSlotCmd ? G.moveSlot(w, me, a["where"]!, a["slot"]!, a["to"]!) : 0; return f === 0; }, startPlacing: (s: unknown) => { placing.push(s); } } as never });
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


const q = (s: string): HTMLElement => { const e = document.querySelector<HTMLElement>(s); if (!e) throw new Error(`missing ${s}`); return e; };
const clickN = (b: HTMLElement, n: number): void => { for (let i = 1; i <= n; i++) b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: i })); };

describe("ADR-223 slot-grid inventory", () => {
  test("pack grid (scroll area) + 8-slot hotbar row + equipment column + one details pane; no floating tooltips on tiles", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("wood"), 5); menus.open("inventory");
    const n = G.readSlots(w, me as never).slotCount;
    expect(document.querySelectorAll("[data-role=inv-hotbar] [data-role=slot]").length).toBe(G.HOTBAR_SIZE);
    expect(document.querySelectorAll("[data-role=inv-grid] [data-role=slot]").length).toBe(n - G.HOTBAR_SIZE);
    expect(document.querySelector("[data-role=inv-layout] [data-role=equipment] [data-role=equip]")).not.toBeNull();
    expect(document.querySelector("[data-role=inv-details]")).not.toBeNull();
    expect(document.querySelector("[data-role=inv-layout] [data-role=slot][data-tip]")).toBeNull();
    expect(document.querySelector("[data-role=consume], [data-role=drop-section], [data-role=arrange-section]")).toBeNull(); // no long Eat / Drop / Split lists
    menus.destroy();
  });
  test("mouse / touch: one tap selects (no eat), a double-click / double-tap eats — no Eat button needed", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("cooked_meat"), 3); menus.open("inventory");
    clickN(q("[data-role=slot][data-use]"), 1); expect(sent.some((i) => i.cmd === G.UseCmd)).toBe(false);
    expect(q("[data-role=inv-details]").textContent).toContain("Eat");
    clickN(q("[data-role=slot][data-use]"), 1); const use = sent.find((i) => i.cmd === G.UseCmd); expect(use).toBeTruthy(); expect(use!.args).toMatchObject({ slot: 0 });
    menus.destroy();
  });
  test("gamepad: A on a food tile eats it, A on a tool equips it; X / Y still split / to hotbar", () => {
    const { w, me, sent, menus, press, seek } = setup(); G.addItem(w, me, id("cooked_meat"), 4); G.addItem(w, me, id("stone_axe"), 1); menus.open("inventory");
    seek("[data-role=slot][data-use]"); const hints = q("[data-role=pad-hints]").textContent!; expect(hints).toContain("Split"); expect(hints).toContain("To hotbar");
    press(PAD.A); expect(sent.filter((i) => i.cmd === G.UseCmd).length).toBe(1);
    seek("[data-role=slot][data-equip]"); press(PAD.A); expect(sent.some((i) => i.cmd === G.EquipCmd)).toBe(true);
    seek("[data-role=slot][data-use]"); press(PAD.X); expect(document.querySelector("[data-role=split-picker]")).not.toBeNull();
    menus.destroy();
  });
  test("drag a tile onto another slot moves it (MoveSlotCmd); onto Equipment equips", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("wood"), 5); G.addItem(w, me, id("stone_axe"), 1); menus.open("inventory");
    // ADR-231: pointer drag (was HTML5 drag-and-drop): mouse down, move past the threshold, release over the target slot
    const drag = (from: HTMLElement, to: HTMLElement): void => { const pe = (t: string, x: number): void => { const e = new MouseEvent(t, { bubbles: true, clientX: x, clientY: x, button: 0 }); Object.defineProperty(e, "pointerId", { value: 1 }); Object.defineProperty(e, "pointerType", { value: "mouse" }); from.dispatchEvent(e); };
      (document as { elementFromPoint?: unknown }).elementFromPoint = () => to; pe("pointerdown", 10); pe("pointermove", 40); pe("pointerup", 40); };
    drag(q("[data-key=slot-0]"), q(`[data-key=slot-${G.HOTBAR_SIZE + 2}]`)); const mv = sent.find((i) => i.cmd === G.MoveSlotCmd); expect(mv?.args).toMatchObject({ slot: 0, to: G.HOTBAR_SIZE + 2 });
    expect(G.readSlots(w, me as never).item(G.HOTBAR_SIZE + 2)).toBe(id("wood"));
    drag(q("[data-key=slot-1]"), q("[data-role=equipment] [data-role=equip]")); expect(sent.some((i) => i.cmd === G.EquipCmd)).toBe(true);
    menus.destroy();
  });
  test("hotbar key / hotbar tap on food eats (UseCmd), on a tool equips (EquipCmd)", () => {
    const { w, me } = setup(); G.addItem(w, me, id("cooked_meat"), 2); G.addItem(w, me, id("stone_axe"), 1);
    // Pack (0..15) is separate from the hotbar (16..23): move the food/tool onto hotbar slots 1/2 first.
    expect(G.moveSlot(w, me, 0, 0, G.HOTBAR_OFFSET)).toBeUndefined(); expect(G.moveSlot(w, me, 0, 1, G.HOTBAR_OFFSET + 1)).toBeUndefined();
    expect(G.hotbarConsumes(w, me as never, G.HOTBAR_OFFSET)).toBe(true); expect(G.hotbarConsumes(w, me as never, G.HOTBAR_OFFSET + 1)).toBe(false);
    expect(G.edgeCommands(G.GameplayEdgeBits.Hotbar1, w, me as never)[0]!.def).toBe(G.UseCmd);
    expect(G.edgeCommands(G.GameplayEdgeBits.Hotbar2, w, me as never)[0]!.def).toBe(G.EquipCmd);
    expect(G.edgeCommands(G.GameplayEdgeBits.Hotbar1)[0]!.def).toBe(G.EquipCmd); // no world: unchanged ADR-180 mapping
  });
  test("crafting: category tabs + search filter a tile grid; details pane shows the focused recipe; pad A queues", () => {
    const { w, me, sent, menus, press, seek } = setup(); G.addItem(w, me, id("wood"), 20); G.addItem(w, me, id("stone"), 10); G.addItem(w, me, id("fiber"), 10);
    craftUi.q = ""; craftUi.cat = "all"; menus.open("crafting"); const all = document.querySelectorAll("[data-role=recipe-grid] [data-role=recipe]").length; expect(all).toBeGreaterThan(1);
    expect(document.querySelector("[data-role=recipe][data-tip]")).toBeNull();
    const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-role=craft-cats] button")); expect(tabs[0]!.textContent).toBe("All"); expect(tabs.length).toBeGreaterThan(1);
    tabs[1]!.click(); const some = document.querySelectorAll("[data-role=recipe-grid] [data-role=recipe]").length; expect(some).toBeGreaterThan(0); expect(some).toBeLessThan(all);
    q("[data-key=ccat-all]").click();
    const inp = q("[data-role=craft-search]") as HTMLInputElement; const first = q("[data-role=recipe] .nm").textContent!; inp.value = first.slice(0, 5); inp.dispatchEvent(new Event("input"));
    const hits = Array.from(document.querySelectorAll("[data-role=recipe-grid] [data-role=recipe]")); expect(hits.length).toBeGreaterThan(0); expect(hits.length).toBeLessThan(all);
    inp.value = "zzzz"; inp.dispatchEvent(new Event("input")); expect(document.querySelector("[data-role=recipe-grid]")).toBeNull();
    inp.value = ""; inp.dispatchEvent(new Event("input"));
    seek("[data-role=recipe]:not(.alt)"); const k = (document.activeElement as HTMLElement).dataset["key"]!;
    expect(q("[data-role=craft-details]").textContent).toContain((document.activeElement as HTMLElement).querySelector(".nm")!.textContent!.split(" (")[0]);
    press(PAD.A); expect(sent.some((i) => i.cmd === G.QueueCraftCmd)).toBe(true); expect(k).toMatch(/^recipe-/);
    menus.destroy();
  });
});

describe("ADR-290 liquid fill bar in the inventory", () => {
  test("pack + hotbar-row tiles of liquid containers get a fill bar (full / near-empty / empty); other items do not", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("canteen"), 1); G.addItem(w, me, id("waterskin"), 1); G.addItem(w, me, id("water_bottle"), 1); G.addItem(w, me, id("wood"), 5);
    const v = G.readSlots(w, me as never); const at = (k: string): number => { for (let i = 0; i < v.slotCount; i++) if (v.item(i) === id(k)) return i; return -1; };
    const c = at("canteen"), s = at("waterskin"), b = at("water_bottle");
    v.put(c, id("canteen"), 1, v.created(c), 6); v.put(s, id("waterskin"), 1, v.created(s), 1); v.put(b, id("water_bottle"), 1, v.created(b), 0); G.writeSlots(w, me as never, v, d);
    expect(G.moveSlot(w, me as never, 0, s, G.HOTBAR_OFFSET + 2)).toBeFalsy(); menus.open("inventory");
    const bar = (slot: number): HTMLElement | null => document.querySelector(`[data-role=inv-layout] button[data-slot="${slot}"] .lfill`);
    expect(bar(c)!.dataset["level"]).toBe("full"); expect(bar(G.HOTBAR_OFFSET + 2)!.dataset["level"]).toBe("low"); expect(bar(b)!.dataset["level"]).toBe("empty");
    expect(bar(at("wood"))).toBeNull();
    expect(q(`[data-role=inv-layout] button[data-slot="${c}"]`).getAttribute("aria-label")).toContain("6/6 sips left");
  });
});

