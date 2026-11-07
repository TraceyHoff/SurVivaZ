// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, it } from "vitest";
import { installPermissions, Membership, PlayerId, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";
import { GAMEPLAY_PANELS, iconKeysFromCss, petTitle } from "../src/gameplay-panels.js";
import { morph } from "../src/ui-diff.js";

const key = (k: string, code = k): void => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true })); };
const d = G.defaultDefs(); const id = (k: string): number => d.itemId(k);

function setup(social?: G.SocialDirectory) {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
  const names = G.playerNames(w);
  const mk = (pid: number, name: string, x = 0): Entity => { const p = G.spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); names.set(pid, name); return p; };
  const me = mk(7, "Ada"); const sent: G.MenuIntent[] = [];
  const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, gameplay: { ctx: () => ({ world: w, player: me, names }), send: (i) => { sent.push(i); return true; }, ...(social ? { social } : {}) } });
  return { w, me, mk, sent, menus };
}
const q = (sel: string): HTMLElement => { const e = document.querySelector<HTMLElement>(sel); if (!e) throw new Error(`missing ${sel}`); return e; };

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("gameplay panels (ADR-095 shell)", () => {
  test("every panel renders real data and every control is a focusable button reachable by Tab", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("wood"), 5, 7);
    for (const p of GAMEPLAY_PANELS) {
      menus.open(p); const modal = q(`[data-menu=${p}]`);
      expect(modal.textContent).not.toContain("placeholder");
      const controls = Array.from(modal.querySelectorAll<HTMLElement>("button,input")).filter((b) => !(b as HTMLButtonElement).disabled);
      const seen = new Set<Element>(); for (let i = 0; i < controls.length + 2; i++) { seen.add(document.activeElement!); key("Tab"); }
      for (const c of controls) expect(seen.has(c), `${p}: ${c.textContent}`).toBe(true);
      menus.nav.closeAll();
    }
    menus.destroy();
  });
  test("ADR-223: selecting a slot shows one details pane with Drop (no separate drop list)", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("wood"), 5); menus.open("inventory");
    expect(document.querySelector("[data-role=drop-section]")).toBeNull(); q("[data-role=slot][data-item]").click();
    expect(q("[data-role=inv-details]").textContent).toContain("×5"); G.addItem(w, me, id("stone"), 2); menus.refresh();
    expect(q("[data-role=inv-details] [data-role=drop]")).toBeTruthy(); menus.destroy();
  });
  test("inventory tooltip names the crafter", () => {
    const { w, me, menus } = setup(); G.addItem(w, me, id("wood"), 5, 7); menus.open("inventory");
    q("[data-role=slot][data-item]").click(); expect(q("[data-role=inv-details]").textContent).toContain("Crafted by Ada"); menus.destroy();
  });
  test("Task 13: a filled raw-water container near a lit campfire shows a Boil button that sends the Boil intent", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("water_flask"), 1);
    G.spawnStation(w, G.StationKind.Campfire, 1, 0, { burnSeconds: 600 });
    menus.open("inventory"); q("[data-role=slot][data-item]").click();
    const boil = q("[data-key=boil-0]"); expect(boil.textContent).toBe("Boil"); boil.click();
    expect(sent.at(-1)).toMatchObject({ cmd: G.BoilCmd, args: { slot: 0 } });
    menus.destroy();
    // without a lit campfire nearby, no Boil button appears
    const s2 = setup(); G.addItem(s2.w, s2.me, id("water_flask"), 1);
    s2.menus.open("inventory"); q("[data-role=slot][data-item]").click();
    expect(document.querySelector("[data-key=boil-0]")).toBeNull(); s2.menus.destroy();
  });
  test("ADR-274: splint Apply is gamepad-usable and unneeded splints explain why they are kept", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("leg_splint"), 1);
    menus.open("inventory"); q("[data-role=slot][data-item]").click();
    const apply = q("[data-key=use-0]"); expect(apply.textContent).toBe("Apply");
    apply.focus(); menus.nav.activate(true); expect(sent).toHaveLength(0);
    expect(document.body.textContent).toContain("No Broken Leg to heal");
    G.contractDisease(w, me, "broken_leg"); menus.refresh(); q("[data-key=use-0]").focus(); menus.nav.activate(true);
    expect(sent.at(-1)).toMatchObject({ cmd: G.UseCmd, args: { slot: 0 } }); menus.destroy();
  });
  test("ADR-274: handcraftable splint has its own icon and can be selected with A", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("sticks"), 2); G.addItem(w, me, id("cloth"), 2);
    menus.open("crafting"); const splint = q(`[data-key=recipe-${d.recipeId("leg_splint")}]`);
    expect(splint.dataset["icon"]).toBe("leg_splint"); splint.focus(); menus.nav.activate(true);
    expect(sent.at(-1)).toMatchObject({ cmd: G.QueueCraftCmd, args: { recipe: d.recipeId("leg_splint"), count: 1 } }); menus.destroy();
  });
  test("crafting: Enter on a recipe sends queueCraft with the chosen count; queue jobs cancel", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("wood"), 20); G.addItem(w, me, id("stone"), 10); G.addItem(w, me, id("fiber"), 10);
    menus.open("crafting"); q("[data-key=count-5]").click();
    const axe = d.recipeId("stone_axe"); const b = q(`[data-key=recipe-${axe}]`); b.focus(); b.click();
    expect(sent.at(-1)).toMatchObject({ cmd: G.QueueCraftCmd, args: { recipe: axe, count: 5 } });
    G.enqueueCraft(w, me, axe, 1); menus.refresh(); q("[data-key=job-0]").click();
    expect(sent.at(-1)).toMatchObject({ cmd: G.CancelQueuedCraftCmd, args: { slot: 0 } }); menus.destroy();
  });
  test("crafting: recipe buttons carry the output item icon; same-output alternates get distinct labels", () => {
    const { menus } = setup(); menus.open("crafting");
    const axe = d.recipeId("stone_axe"); const b = q(`[data-key=recipe-${axe}]`);
    expect(b.dataset["item"]).toBe(String(id("stone_axe"))); expect(b.dataset["icon"]).toBeTruthy();
    const hoe = q(`[data-key=recipe-${d.recipeId("hoe")}]`).textContent!; const bone = q(`[data-key=recipe-${d.recipeId("bone_hoe")}]`).textContent!;
    expect(hoe).not.toBe(bone); expect(bone.toLowerCase()).toContain("bone"); menus.destroy();
  });
  test("pause menu lists no context-only menus (crafting station / camper open from the world)", () => {
    const { menus } = setup(); menus.pause(); const txt = q("[data-menu=pause]").textContent!;
    expect(txt).not.toContain("Crafting Station"); expect(txt).not.toContain("Camper Station"); expect(txt).toContain("Crafting"); menus.destroy();
  });
  test("chat has a single close control (header ✕), no duplicate footer Close", () => {
    const { menus } = setup(); menus.open("chat"); const b = Array.from(q("[data-menu=chat]").querySelectorAll("button")).filter((x) => /close/i.test(x.textContent! + (x.getAttribute("aria-label") ?? "")));
    expect(b).toHaveLength(1); menus.destroy();
  });
  test("party: invite a nearby player (entity arg flagged for NetId mapping); pending invite accept/decline", () => {
    const { w, mk, sent, menus } = setup(); const bob = mk(8, "Bob", 2); menus.open("party");
    q("[data-key=invite-8]").click(); expect(sent.at(-1)).toMatchObject({ cmd: G.PartyInviteCmd, args: { target: bob }, entities: ["target"] });
    menus.destroy();
  });
  test("clan: create when clanless; trade: prompt when no stall nearby", () => {
    const { sent, menus } = setup(); menus.open("clan"); q("[data-key=clan-create]").click();
    expect(sent.at(-1)!.cmd).toBe(G.ClanCreateCmd); menus.nav.closeAll();
    menus.open("trade"); expect(q("[data-menu=trade]").textContent).toContain("trade stall"); menus.destroy();
  });
  test("chat: channel buttons + Send route through onChat; pushChat appends incoming lines", () => {
    const got: [string, number][] = [];
    const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, onChat: (t, c) => got.push([t, c]) });
    menus.open("chat"); q("[data-key=chan-2]").click();
    (q("[data-role=chat-input]") as HTMLInputElement).value = "hi party"; q("[data-role=submit]").click();
    expect(got).toEqual([["hi party", 2]]);
    menus.pushChat("[Party] Bob: yo"); expect(q("[data-role=chat-log]").textContent).toContain("Bob: yo"); menus.destroy();
  });
  test("interact opens a stall's trade panel; owner stock & price UI sends stockStall + setListing", () => {
    const { w, me, sent, menus } = setup(); G.addItem(w, me, id("wood"), 5, 7);
    const sn = G.snapPlacement(w, { piece: d.pieceId("stall_booth"), x: 1, y: 1, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error("snap"); const stall = G.stallOf(w, G.placePiece(w, me, sn, { pay: false }))!;
    const t = G.interactPanel({ world: w, player: me, names: new Map() }); expect(t).toEqual({ panel: "trade", stall });
    menus.openStall(stall); const modal = q("[data-menu=trade]"); expect(menus.nav.isOpen).toBe(true);
    const slot = modal.querySelector<HTMLButtonElement>("[data-key^=draft-slot-]"); expect(slot).toBeTruthy(); slot!.click();
    q("[data-menu=trade] [data-key=draft-list]").click();
    const cmds = sent.map((x) => x.cmd); expect(cmds).toContain(G.StockStallCmd); expect(cmds).toContain(G.SetListingCmd);
    menus.destroy();
  });
  test("social directory: roster events drive clan members, online players fill invites + whisper picker; Dismiss declines; paint", () => {
    const dir = new G.SocialDirectory(); const { w, me, mk, sent, menus } = setup(dir);
    mk(9, "Bo", 2); // replicated + nearby
    dir.onOnline({ player: 7, online: 1 }); dir.onOnline({ player: 9, online: 1 }); dir.onOnline({ player: 11, online: 1 }); // 11 = far away
    menus.open("party"); expect(q("[data-key=invite-9]")).toBeTruthy(); expect((q("[data-key=invite-11]") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-key=invite-7]")).toBeNull(); menus.nav.closeAll();
    dir.onOnline({ player: 11, online: 0 }); expect(dir.online.has(11)).toBe(false);
    // roster: clan 5, Bo officer, 12 leader offline; then 12 removed (role 0)
    dir.onRoster({ clan: 5, memberMask: 0, officerMask: 0, size: 3 }); dir.onMember({ clan: 5, player: 9, role: 2, online: 1 }); dir.onMember({ clan: 5, player: 12, role: 3, online: 0 });
    const rows = G.clanRosterRows({ world: w, player: me, names: new Map() }, dir, 5)!; expect(rows.map((r) => [r.playerId, r.roleName])).toEqual([[12, "Leader"], [9, "Officer"]]);
    expect(rows[1]!.entity).toBeDefined(); expect(rows[0]!.entity).toBeUndefined();
    dir.onMember({ clan: 5, player: 12, role: 0, online: 0 }); expect(dir.roster.has(12)).toBe(false);
    dir.onRoster({ clan: 0, memberMask: 0, officerMask: 0, size: 0 }); expect(dir.roster.size).toBe(0);
    expect(G.clanDeclineIntent(5)).toMatchObject({ cmd: G.ClanDeclineCmd, args: { clan: 5 } });
    // whisper picker
    menus.open("chat"); q("[data-key=chan-5]").click(); q("[data-key=whisper-9]").click();
    expect(q("[data-key=whisper-9]").getAttribute("aria-pressed")).toBe("true"); menus.nav.closeAll();
    // paint: nearest paintable piece in reach
    const piece = [...d.pieces.values()].find((x) => x.paintable)!;
    const sn = G.snapPlacement(w, { piece: piece.id, x: 1, y: 0, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error("snap");
    const pe = G.placePiece(w, me, sn, { pay: false }); expect(G.paintTarget({ world: w, player: me, names: new Map() })).toBe(pe);
    expect(G.paintIntent(pe, 2)).toMatchObject({ cmd: G.PaintCmd, args: { target: pe, paint: 2 }, entities: ["target"] });
    void sent; menus.destroy();
  });
  test("clan Dismiss sends clanDecline", () => {
    const { w, me, mk, sent, menus } = setup(); const lead = mk(9, "Bo", 1);
    expect(G.clanCreate(w, lead)).toBeUndefined(); expect(G.clanInvite(w, lead, me)).toBeUndefined();
    expect(G.clanView({ world: w, player: me, names: new Map() }).invite).toBeTruthy();
    menus.open("clan"); q("[data-key=clan-dismiss]").click(); expect(sent.at(-1)?.cmd).toBe(G.ClanDeclineCmd); menus.destroy();
  });
  test("Task 23: Character panel shows the live character sheet (body temp, vitals, XP, insulation, shelter)", () => {
    const { w, me, menus } = setup();
    menus.open("character");
    const txt = (role: string) => q(`[data-role=${role}]`).textContent!;
    expect(q("[data-menu=character]").textContent).toContain("Character sheet — Ada");
    expect(txt("sheet-body-temp")).toMatch(/Body temperature: -?−?\d+(\.\d)?°[CF]/);
    expect(txt("sheet-health")).toBe("Health: 100/100");
    expect(txt("sheet-hunger")).toBe("Food: 100/100");
    expect(txt("sheet-thirst")).toBe("Water: 100/100");
    expect(txt("sheet-stamina")).toBe("Energy: 100/100");
    expect(txt("sheet-xp")).toMatch(/Level 1 · 0\/\d+ XP/);
    expect(txt("sheet-diseases")).toBe("Diseases: Healthy");
    expect(txt("sheet-insulation")).toBe("Insulation: Base 0.0°F + clothing 0.0°F"); // ADR-282: °F default (a 7 °C difference = 12.6 °F)
    expect(txt("sheet-worn")).toContain("Nothing — craft clothing");
    expect(txt("sheet-shelter")).toMatch(/Outside: .* · summer/);
    // wearing a fur coat adds its insulation to the sheet, with a per-item row
    G.addItem(w, me, id("fur_coat"), 1);
    const slot = G.listSlots(w, me).find((s) => s.item === id("fur_coat"))!.slot;
    expect(G.wearSlot(w, me, slot)).toBe(true);
    menus.refresh();
    expect(txt("sheet-insulation")).toBe("Insulation: Base 0.0°F + clothing 12.6°F");
    expect(txt("sheet-worn")).toMatch(/Fur Coat · \+12\.6°F/);
    menus.destroy();
  });
  test("Task 31: Character panel is details only — wardrobe controls live in the Wardrobe panel", () => {
    const { menus } = setup();
    menus.open("character");
    expect(document.querySelector("[data-menu=character]")!.textContent).toContain("Character sheet — Ada");
    expect(document.querySelectorAll("[data-key^=wslot-]").length).toBe(0);
    expect(document.querySelector("[data-role=dye-status]")).toBeNull();
    expect(document.querySelector("[data-key=edit-character]")).toBeNull();
    expect(document.querySelectorAll("[data-role=unlock]").length).toBe(0);
    menus.nav.closeAll();
    menus.open("wardrobe");
    expect(document.querySelectorAll("[data-key^=wslot-]").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-role=dye-status]")).not.toBeNull();
    expect(document.querySelector("[data-key=edit-character]")).not.toBeNull();
    expect(document.querySelectorAll("[data-role=unlock]").length).toBeGreaterThan(0);
    menus.destroy();
  });
  test("styling hooks: data-item/data-icon, job --p, data-unlocked, data-rank, data-chan, data-tip (no title=)", () => {
    const dir = new G.SocialDirectory(); const { w, me, mk, menus } = setup(dir);
    G.addItem(w, me, id("wood"), 5, 7); G.addItem(w, me, id("reeds"), 3); G.addItem(w, me, id("stone"), 10); G.addItem(w, me, id("fiber"), 10);
    menus.open("inventory");
    const slots = Array.from(document.querySelectorAll<HTMLElement>("[data-role=slot]"));
    const reeds = slots.find((s) => s.dataset["item"] === String(id("reeds")))!; expect(reeds.dataset["icon"]).toBe("item_reeds");
    expect(slots.find((s) => s.dataset["item"] === String(id("wood")))!.dataset["icon"]).toBe("wood");
    menus.nav.closeAll();
    G.addItem(w, me, id("wood"), 20); G.enqueueCraft(w, me, d.recipeId("stone_axe"), 1); menus.open("crafting");
    const job = q("[data-role=job]"); expect(job.getAttribute("style")).toMatch(/^--p:(0|1)?\.\d{3}$/);
    menus.nav.closeAll(); menus.open("wardrobe");
    const unlocks = Array.from(document.querySelectorAll<HTMLElement>("[data-role=unlock]")); expect(unlocks.length).toBeGreaterThan(0);
    for (const u of unlocks) expect(u.textContent).not.toMatch(/[✓🔒]/u);
    expect(unlocks.some((u) => u.hasAttribute("data-unlocked")) || unlocks.every((u) => !u.hasAttribute("data-unlocked"))).toBe(true);
    menus.nav.closeAll();
    mk(9, "Bo", 2); dir.onRoster({ clan: 5, memberMask: 0, officerMask: 0, size: 3 }); dir.onMember({ clan: 5, player: 9, role: 2, online: 1 }); dir.onMember({ clan: 5, player: 12, role: 3, online: 0 });
    w.set(me, Membership, { partyId: 0, clanId: 5 }); menus.open("clan");
    expect(q("[data-role=member][data-key='9']").dataset["rank"]).toBe("officer"); expect(q("[data-role=member][data-key='12']").dataset["rank"]).toBe("leader");
    menus.nav.closeAll();
    for (const p of GAMEPLAY_PANELS) { menus.open(p); expect(document.querySelectorAll("[title]").length, p).toBe(0); menus.nav.closeAll(); }
    expect(document.querySelectorAll("[data-tip]").length).toBeGreaterThan(0);
    menus.pushChat("[Clan] Bo: hi", 3); menus.pushChat("(local note)"); menus.open("chat");
    const lines = Array.from(q("[data-role=chat-log]").children) as HTMLElement[]; expect(lines.map((l) => l.dataset["chan"])).toEqual(["clan", "system"]);
    menus.destroy();
  });
  test("morph keeps the node and updates the job --p style + data hooks", () => {
    const a = document.createElement("div"); a.innerHTML = `<button data-key="job-0" data-role="job" style="--p:0.100">x</button>`;
    const b = document.createElement("div"); b.innerHTML = `<button data-key="job-0" data-role="job" style="--p:0.600" data-tip="t">x</button>`;
    const before = a.firstElementChild; morph(a, b);
    expect(a.firstElementChild).toBe(before); expect(before!.getAttribute("style")).toBe("--p:0.600"); expect(before!.getAttribute("data-tip")).toBe("t");
  });

});

describe("camper station panel (assets/ui/screens/camper_station.md)", () => {
  test("vehicle items carry explicit item_<key> sprite overrides", () => {
    const keys = Array.from(d.items.values()).filter((i) => i.spriteKey?.startsWith("item_"));
    for (const k of ["plant_oil"]) { const it = d.items.get(id(k)); if (it) expect(it.spriteKey).toBe(`item_${k}`); }
    expect(keys.length).toBeGreaterThanOrEqual(69);
  });
  test("opens with spec hooks, switches tabs, refuels, withdraws, diff-refreshes", () => {
    const { w, me, sent, menus } = setup();
    const v = G.spawnVehicle(w, "camper_van", 0, 0); w.setField(v, G.Vehicle, "fuel", 5);
    const fuel = Array.from(d.items.values()).map((i) => i.id).find((it) => G.fuelFits(w, v, it));
    expect(fuel).toBeDefined(); expect(w.has(v, G.Container)).toBe(true);
    if (fuel !== undefined) G.addItem(w, me, fuel, 3);
    if (w.has(v, G.Container)) G.addItem(w, v, id("wood"), 4);
    menus.openCamper(v);
    expect(sent.some((i) => i.cmd === G.OpenContainerCmd && i.args["target"] === v)).toBe(true);
    const panel = q("[data-panel=camper-station]"); expect(panel.dataset["key"]).toBe(String(v));
    expect(panel.querySelector("[data-role=body]")!.getAttribute("style")).toBeNull();
    expect(q("[data-key=close]").dataset["tip"]).toBe("Close (B)");
    const gauge = q("[data-role=fuel-gauge]"); expect(gauge.getAttribute("role")).toBe("progressbar"); expect(gauge.getAttribute("style")).toMatch(/--p:/);
    const craft = q("[data-role=station-craft]"); const cook = q("[data-role=station-cook]");
    expect(craft.hidden).toBe(false); expect(cook.hidden).toBe(true);
    q("[data-key=tab-cook]").click();
    expect(q("[data-key=tab-cook]").getAttribute("aria-pressed")).toBe("true"); expect(q("[data-role=station-cook]").hidden).toBe(false); expect(q("[data-role=station-craft]").hidden).toBe(true);
    // pad RB/LB = tabs via data-pad shortcut
    expect(menus.nav.padShortcut("LB")).toBe(true); expect(q("[data-key=tab-craft]").getAttribute("aria-pressed")).toBe("true");
    if (fuel !== undefined) { q("[data-pad=Y]").click(); const r = sent.at(-1)!; expect(r.cmd).toBe(G.VehicleRefuelCmd); expect(r.args["target"]).toBe(v); }
    if (w.has(v, G.Container)) {
      expect(q("[data-role=station-inv]").textContent).toMatch(/Camper storage 1\/\d+/);
      q("[data-key=inv-0]").click(); const r = sent.at(-1)!; expect(r.cmd).toBe(G.WithdrawCmd); expect(r.args).toMatchObject({ target: v, item: id("wood"), count: 4 });
    }
    const keep = q("[data-role=fuel-gauge]"); menus.refresh(); expect(q("[data-role=fuel-gauge]")).toBe(keep);
    menus.nav.closeAll();
  });
  test("renders without a vehicle", () => { const { menus } = setup(); menus.open("camper"); expect(document.querySelector("[data-menu=camper]")).not.toBeNull(); });
});

describe("ADR-132 skill category tabs", () => {
  test("tabs show one tree at a time; ◀ ▶ and PgDn switch; each tab shows its own level + points (ADR-209)", () => {
    const { w, me, sent, menus } = setup(); G.migrateProgression(w, me); G.grantTreePoints(w, me, "perks", 3); menus.open("skills");
    const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-role=skill-tabs] [role=tab]")); expect(tabs.length).toBe(G.SKILLS.categories.length);
    // ADR-132 art: every tab carries its own skill_tab_<category> icon, and the stylesheet has art for it.
    const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");
    for (const t of tabs) { const k = t.dataset["category"]!; expect(t.dataset["icon"]).toBe(`skill_tab_${k}`); expect(css).toContain(`[data-icon="skill_tab_${k}"]`); }
    expect(q("[data-key=skill-tab-homestead]").dataset["icon"]).toBe("skill_tab_homestead");
    expect(G.SKILLS.branches.find((b) => b.key === "perks")!.icon).toBe("skill_branch_perks");
    expect(q("[data-role=skill-summary]").textContent).toContain("3 points to spend here"); expect(q("[data-key=skill-tab-perks]").textContent).toContain("Lv 1 · 3 pts");
    expect(q("[data-key=skill-tab-combat]").textContent).not.toContain("pts"); expect(q("[data-role=skill-xpbar]").getAttribute("aria-valuemax")).toBe(String(G.treeXpToNext(1)));
    const cat0 = q("[data-role=skill-tree]").dataset["category"]!;
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("[data-role=skill-node]"))) expect(b.dataset["category"]).toBe(cat0);
    q("[data-key=skill-tab-next]").click(); expect(q("[data-role=skill-tree]").dataset["category"]).toBe(G.SKILLS.categories[1]!.key);
    q("[data-key=skill-tab-combat]").click(); expect(q("[data-role=skill-tree]").dataset["category"]).toBe("combat");
    expect(document.querySelector("[data-key=skill-blade_mastery]")).not.toBeNull(); expect(document.querySelector("[data-key=skill-forager]")).toBeNull();
    q("[data-key=skill-tab-combat]").focus(); key("PageDown"); expect(q("[data-role=skill-tree]").dataset["category"]).toBe(G.SKILLS.categories[(G.SKILLS.categories.findIndex((c) => c.key === "combat") + 1) % G.SKILLS.categories.length]!.key);
    q("[data-key=skill-tab-perks]").click(); const b = q("[data-key=skill-iron_stomach]"); b.click(); q("[data-key=skill-iron_stomach]").click();
    expect(sent.at(-1)).toMatchObject({ cmd: G.UnlockSkillCmd, args: { node: G.skillNodeIndex("iron_stomach") } });
    menus.destroy();
  });
});

describe("item icons never fall back to the generic bag (CSS)", () => {
  const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");
  // specificity (ids, classes/attrs/pseudo-classes incl. :is() max arg, types/pseudo-elements) of one selector
  const spec = (sel: string): number[] => {
    let s = sel, isMax = [0, 0, 0];
    s = s.replace(/:is\(([^()]*)\)/g, (_, inner: string) => { for (const x of inner.split(",")) { const v = spec(x.trim()); if (v.join() > isMax.join()) isMax = v; } return ""; });
    const ids = (s.match(/#[\w-]+/g) ?? []).length, cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (s.replace(/\[[^\]]+\]/g, "").match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
    return [ids + isMax[0]!, cls + isMax[1]!, types + isMax[2]!];
  };
  const gt = (a: number[], b: number[]): boolean => a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim().split(/,(?![^(]*\))/).map((x) => x.trim()), body: m[2]! }));
  it("the [data-icon] slot ::after rule out-ranks every bag ::after rule for slots", () => {
    const icon = rules.find((r) => r.body.includes("var(--cz-icon") && r.sels.some((s) => s.includes("[data-icon]") && s.includes("slot") && s.endsWith("::after")))!;
    expect(icon).toBeDefined(); const iconSpec = spec(icon.sels.find((s) => s.includes("slot"))!);
    const bags = rules.filter((r) => r.body.includes("ui_ic_bag") && r !== icon).flatMap((r) => r.sels.filter((s) => s.includes("data-role=slot") && s.endsWith("::after")));
    expect(bags.length).toBeGreaterThan(0); for (const b of bags) expect(gt(iconSpec, spec(b)), `${b} beats the icon rule`).toBe(true);
  });
  it("every item (incl. pet treats and Iron Sword) has a [data-icon] art rule; treat offers show it", () => {
    const keys = iconKeysFromCss([css]); const missing: string[] = [];
    for (const it of d.items.values()) if (!keys.has(G.iconForItem(it, (k) => keys.has(k)))) missing.push(it.key);
    expect(missing).toEqual([]); for (const k of ["iron_sword", "dog_biscuit", "meaty_chew"]) expect(keys.has(k)).toBe(true);
    expect(css).toMatch(/button\[data-role=offer\] > \[data-role=ic\]\[data-icon\]\{[^}]*--cz-icon/);
  });
  it("pet title shows the species once", () => {
    expect(petTitle({ wild: false, name: "Dachshund", speciesName: "Dachshund", level: 1 })).toBe("Dachshund · Lv 1");
    expect(petTitle({ wild: false, name: "Biscuit", speciesName: "Dachshund", level: 2 })).toBe("Biscuit · Dachshund · Lv 2");
    expect(petTitle({ wild: true, name: "Dachshund", speciesName: "Dachshund", level: 1 })).toBe("Dachshund");
  });
});
