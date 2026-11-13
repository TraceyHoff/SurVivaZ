/**
 * Gameplay bodies for the ADR-095 menu shell (game-menus.ts): inventory, crafting, build, character, party, clan and
 * trade stall, from @engine/gameplay's menu view-models (packages/gameplay/src/ui/menus.ts). Data + commands only:
 * every control is a shell <button> (44px, focusable, so UINav reaches it by touch, D-pad/stick + A, Tab/arrows + Enter)
 * and every action is a gameplay command intent sent through `GameplaySource.send`. No art: styling is the shell's.
 * Data hooks for Art: `[data-role=slot|recipe|job|owed|piece|listing|member|invite|perm|unlock]`, `[data-key]`;
 * slots `[data-item=<itemId>][data-icon=<manifest icon key>]`; jobs `style="--p:<0..1>"`; unlocks `[data-unlocked]`
 * (present = unlocked); member rows `[data-rank=member|officer|leader]`; tooltips `[data-tip]` (never `title=`).
 * Chat log lines (game-menus.ts) carry `[data-chan=global|local|party|clan|trade|whisper|system]`.
 */
import { workerJobMenu, beginWorkerJob } from "./worker-job-menu.js";
import { revealAboveFooter } from "./back-history.js";
import { deployKitIntent, isKit } from "./vehicle-controls.js";
import { clanMemberActions } from "./clan-actions.js";
import "./gameplay-panels.css";
import { conditionIconImg, iconImg } from "./game-icons.js";
import { installSlotDrag, slotRef, type SlotDrag, type SlotKind, type SlotRef } from "./slot-drag.js";
import { hasDisease, iconForItem, ROADS, clanTintIndex,
  buildView, gameplayDefs, cancelQueuedCraftIntent, clanAcceptIntent, clanDeclineIntent, clanRosterRows, onlineTargets, paintIntent, paintTarget, type SocialDirectory, clanCreateIntent, clanDemoteIntent, clanDisbandIntent, clanInviteIntent, clanKickIntent, clanLeaveIntent,
  clanPromoteIntent, takeAllIntent, LootBag, Container, clanSetGoalIntent, clanSetRankPermsIntent, clanView, collectTillIntent, containerView, CONTAINER_PAGE_SIZE, craftingView, depositIntent, fuelView, toggleFireIntent, openContainer, withdrawIntent, equipCosmeticIntent, inventoryView, JOB_STATE_LABEL, capacityView, capacityText,
  nearestStall, partyAcceptIntent, partyDeclineIntent, partyInviteIntent, partyKickIntent, partyLeaveIntent, partyView, queueCraftIntent, buyFromStallIntent,
  setAppearanceIntent, setStallNameIntent, priceItemChoices, listItemIntents, unstockStallIntent, type StallListDraft, setStallOpenIntent, stallView, togglePermMask, wardrobeView, placeIntent,
  type BuildSelection, type MenuCtx, type MenuIntent, camperStationView, vehicleRefuelIntent, type CamperRecipeView,
  progressionView, unlockSkillIntent, respecSkillsIntent, SKILL_REJECT_TEXT, useIntent, drinkWaterIntent, nearWater,
  SKILLS, equipIntent, wearIntent, equipmentView, boilIntent, nearLitCampfire, holdingTorch,
  mountView, mountRideIntent, mountDismountIntent, mountFeedIntent, mountSaddleIntent, mountUnsaddleIntent, mountRepairIntent, mountHarnessIntent, mountUnharnessIntent, mountHitchIntent, mountUnhitchIntent, MOUNT_SPECIES,
  petView, petsOf, petOfferIntent, petCommandIntent, petGuardIntent, animalSkillIntent, animalSkillView, petStatusLabel, dropItemIntent, splitStackIntent, moveSlotIntent, containerToSlotIntent, slotToContainerIntent, defaultSplit, HOTBAR_SIZE, PACK_SLOTS, HOTBAR_OFFSET, PET_HELP, petName, petSpecies, Pet, Animal, BuildPiece, Tamed,
  ropeLeadIntent, ropeEquipped,
  workerView, WORKER_JOBS, WORKER_JOB_LABELS, WORKER_JOB_HELP, WORKER_HELP, hireWorkerIntent, dismissWorkerIntent,
  treeShortName, treeIndex, readSlots, SPRITE_FALLBACKS, characterSheetView, dyeView, dyeIntent, wetnessStage,
  recentBuildsView, recentCraftsView,
} from "@engine/gameplay";
import { formatBodyTemp, formatTemp, formatTempDelta, loadTempUnit } from "./hud-temp.js";
import { colorChoices, requestCharacterEdit } from "./character-creator.js";
import { GroupRole, Membership, PlayerId, SLOT_PALETTE, swatchColor, Transform, type Entity, type WearableSlot } from "@engine/core";
import { fillBar, fillLabel } from "./fill-bar.js";

export const GAMEPLAY_PANELS = ["inventory", "crafting", "build", "character", /* Task 31 */ "wardrobe", "party", "clan", "trade", "camper", "skills", "station", /* ADR-145 */ "pet", /* Task 22 */ "worker", /* ADR-319 */ "mount"] as const;
export type GameplayPanel = (typeof GAMEPLAY_PANELS)[number];
/** What the client wires in (main.ts): the local replica + player, and a command sender (NetId mapping + gameplayNet). */
export interface GameplaySource {
  ctx(): MenuCtx | undefined;
  /** Send a command intent; returns false when not connected / not bridged. */
  send(i: MenuIntent): boolean;
  /** Build selection changed. */
  onBuildSelect?(s: BuildSelection): void;
  /** Enter build mode with this selection (aim-point placement, see build-mode.ts). */
  startPlacing?(s: BuildSelection): void;
  /** ADR-316: enter demolish mode without a hologram (the Build menu's "Demolish / Move" entry). */
  startDemolish?(): void;
  /** ADR-229: clan palette primary (0xRRGGBB) for a BuildPiece tint index (registry.clanPaletteForTint); tints the white cloth icons. */
  clanTint?(tint: number): number | undefined;
  /** Task 25: clan palette secondary (0xRRGGBB) for a BuildPiece tint index — the tint swatch's second half. */
  clanTint2?(tint: number): number | undefined;
  /** ADR-122 road / sign tools (world-tools.ts): Build panel buttons so gamepad and touch reach them. */
  worldTools?: { road(surface: number): void; roadSurface(): number; placeSign(): boolean; editNearestSign(): boolean; surfaces: readonly string[] };
  /** Stall the trade panel shows (set by interacting with a stall); falls back to the nearest stall. */
  stall?(): Entity | undefined;
  /** Owner-scoped clan roster + online directory (net events gameplay.clanRoster / clanRosterMember / onlinePlayer). */
  social?: SocialDirectory;
  /** Camper whose station panel is open (set from the vehicleStationOpened event, GameMenus.openCamper). */
  camper?(): Entity | undefined;
  /** ADR-136: station whose crafting panel is open (Interact near a workbench / forge / campfire …, GameMenus.openStation). */
  station?(): { entity: Entity; kind: number } | undefined;
  /** ADR-145: pet / tameable animal the pet panel shows (Interact next to it, or picked from the list). */
  pet?(): Entity | undefined;
  /** ADR-145: choose another pet from the panel's list. */
  selectPet?(e: Entity | undefined): void;
  /** Task 22: AI human the worker panel shows (Interact next to them). */
  worker?(): Entity | undefined;
  /** Task 22: choose another AI human from the worker panel. */
  selectWorker?(e: Entity | undefined): void;
  /** ADR-145: open the rename editor (modal; on-screen keyboard on gamepad). */
  renamePet?(pet: Entity, current: string): void;
  /** ADR-319: mount / wild rideable animal the mount panel shows (GameMenus.openMount). */
  mount?(): Entity | undefined;
  /** ADR-320: open the saddlebag in the normal container (inventory) panel. */
  openSaddlebag?(m: Entity): void;
  /** ADR-319: mount rename editor. */
  renameMount?(m: Entity, current: string): void;
}
export interface PanelKit { para(t: string): HTMLElement; rerender(): void; status(t: string): void; close(): void }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith("data-")) e.dataset[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = v; else e.setAttribute(k, v); }
  if (text !== undefined) e.textContent = text; return e;
};
const grid = (): HTMLElement => el("div", { class: "gm-grid" });
/** Capacity bar for a pack / container / station storage: weight + slots, with what is left, and an encumbrance
 * note for the player's own pack (movement slows from 70% of max weight). */
const capacityBar = (c: MenuCtx, e: Entity, label: string): HTMLElement | undefined => {
  const cv = capacityView(c, e); if (!cv) return undefined;
  const sec = el("section", { "data-role": "capacity" });
  const p = el("p", { "data-role": "capacity-text" }, `${label} · ${capacityText(cv)}`);
  const bar = el("div", { "data-role": "capacity-bar" }); bar.style.setProperty("--p", String(Math.min(1, cv.pct)));
  sec.append(p, bar);
  if (label === "Pack" && cv.pct >= 0.7) sec.append(el("p", { "data-role": "capacity-note" }, `Encumbered: at ${Math.round(cv.pct * 100)}% of max weight your movement is slowed (down to 45% speed at full weight).`));
  return sec;
};

const heading = (t: string): HTMLElement => { const h = el("p", { "data-role": "section" }); const b = el("strong", {}, t); h.append(b); return h; };

/** Build-panel selection survives re-renders. */
const buildSel: BuildSelection = { piece: 0, tier: 0, variant: 0, paint: 0 };
const castSel = { recipe: 0, count: 1 };
/** ADR-223: crafting category tab, search text and focused recipe (details pane) survive re-renders. */
export const craftUi = { cat: "all", q: "", sel: 0 };
let buildCat = "";
/** ADR-224: tile preview glyph from the piece key (pieces have no item art; keyword → symbol, else a block). */
export function pieceGlyph(key: string): string {
  const m: [RegExp, string][] = [[/foundation/, "▦"], [/roof/, "⌂"], [/stair|steps|ramp/, "▤"], [/floor|hatch_frame|skylight/, "▭"], [/pillar/, "▮"], [/door|gate|hatch/, "🚪"], [/window/, "🪟"],
    [/wall|barricade/, "🧱"], [/fire|stove|furnace|torch/, "🔥"], [/lantern|lamp|light|candle/, "💡"], [/chest|box|storage|crate|shelf|cabinet/, "📦"], [/bed/, "🛏"], [/chair|bench|stool|sofa|couch/, "🪑"],
    [/table|counter|desk|workbench|anvil/, "🛠"], [/plant|flower|tree|bush|garden/, "🌿"], [/rug|carpet|mat/, "🟫"], [/banner|flag|windsock/, "🚩"], [/totem|bell|tower/, "🗼"], [/stall|booth|pavilion|cart/, "🎪"], [/mirror|painting|trophy|frame/, "🖼"], [/garage/, "🚗"]];
  for (const [r, g] of m) if (r.test(key)) return g; return "◼";
}
let wardrobeSlot = 0;
/** Task 31: seconds as "45s" / "3m 12s" for the sheet's dry / cure timers. */
const fmtDur = (s: number): string => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
/** Task 31: care conditions the sheet reports as still unmet, in plain words. */
const CARE_NEED_LABEL: Record<string, string> = { dry: "drying off", fed: "food", hydrated: "water", warm: "warmth" };
/** Camper station: active tab + selected cook recipe survive re-renders. */
const camperSel = { tab: "craft" as "craft" | "cook", cook: 0 };
const dismissedClan = new Set<number>();
/** Container panel page (ADR-098): survives re-renders; clamped by containerView. */
let containerPage = 0;
/** ADR-145: inventory "Drop items…" section open state (survives panel re-renders). */
export const dropUi = { open: false };
/** ADR-223: selected inventory slot (details pane) + last tap for double-tap quick use; survives re-renders. */
export const invUi: { sel: number; lastTap: { slot: number; t: number }; /** ADR-231 selected container slot */ csel: number; /** ADR-231 picked tile (pad / keys / tap move) */ pick?: SlotRef | undefined } = { sel: -1, lastTap: { slot: -1, t: 0 }, csel: -1 };
/** ADR-231: drop handler of the inventory panel currently on screen (the panel re-renders; looked up at release). */
let invDrop: ((from: SlotRef, to: SlotRef) => void) | undefined;
let slotDrag: SlotDrag | undefined;
/** ADR-231: one document-level pointer drag for every slot tile inside a menu (installed on first inventory render). */
export function ensureSlotDrag(): SlotDrag | undefined {
  if (!slotDrag && typeof document !== "undefined" && typeof window !== "undefined") slotDrag = installSlotDrag(document, { within: "[data-modal]", onDrop: () => (document.querySelector("[data-role=inv-layout]") ? invDrop : undefined) });
  return slotDrag;
}
/** Test hook: drop the document-level drag (jsdom documents are reset between tests). */
export function resetSlotDrag(): void { slotDrag?.destroy(); slotDrag = undefined; invDrop = undefined; }
/** ADR-204: split / move-to-hotbar picker state (outside the DOM: the panel re-renders on every inventory change). */
export const arrangeUi: { mode: "" | "split" | "hotbar"; where: 0 | 1; slot: number; count: number; open: boolean } = { mode: "", where: 0, slot: -1, count: 1, open: false };
/** Focus a control by data-key after the (synchronous) re-render; pad focus ring when the pad drove it. */
function focusKey(key: string): void { const t = typeof document !== "undefined" ? document.querySelector<HTMLElement>(`[data-modal] [data-key="${key}"]`) : null; if (t) { t.focus(); t.scrollIntoView?.({ block: "nearest" }); revealAboveFooter(t); } }
/** Skill tree (ADR-113): zoom + selected node survive re-renders; the viewport scroll position is kept by the diffing refresh. */
/** ADR-219: scroll the tree viewport (only) so the focused node is fully inside it with a small margin. */
function revealIn(vp: HTMLElement, b: HTMLElement, m = 12): void {
  const l = b.offsetLeft, t = b.offsetTop, r = l + b.offsetWidth, btm = t + b.offsetHeight;
  if (l - m < vp.scrollLeft) vp.scrollLeft = Math.max(0, l - m); else if (r + m > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = r + m - vp.clientWidth;
  if (t - m < vp.scrollTop) vp.scrollTop = Math.max(0, t - m); else if (btm + m > vp.scrollTop + vp.clientHeight) vp.scrollTop = btm + m - vp.clientHeight;
}
const skillUi = { zoom: 0.6, sel: -1, branch: "", cat: "", /** ADR-219 last focused / hovered node (survives re-renders) */ peek: -1 };
/** ADR-132: active skill category tab (one tree per tab); ◀ ▶ / tab buttons (touch, mouse, Tab+Enter, gamepad focus+A), PgUp/PgDn and gamepad LB/RB. */
export function selectSkillCategory(key: string): void { if (skillUi.cat !== key) { skillUi.cat = key; skillUi.sel = -1; } }
export const skillCategory = (): string => skillUi.cat;
/** ADR-132: cycle the skill tree tab (PgUp/PgDn, gamepad LB/RB, ◀ ▶). */
export function pageSkillCategory(d: number): void { const cs = SKILLS.categories; const i = Math.max(0, cs.findIndex((c) => c.key === skillUi.cat)); selectSkillCategory(cs[(i + d + cs.length) % cs.length]!.key); }
export const SKILL_ZOOM = { min: 0.35, max: 1.4, step: 0.15 };
export function zoomSkills(d: number): number { skillUi.zoom = Math.max(SKILL_ZOOM.min, Math.min(SKILL_ZOOM.max, +(skillUi.zoom + d).toFixed(2))); return skillUi.zoom; }
/** Page the open container by `d` (PgUp/PgDn, LB/RB, ◀ ▶). Returns true if a page change applies. */
export function pageContainer(d: number): boolean { containerPage = Math.max(0, containerPage + d); return true; }
export function containerPageIndex(): number { return containerPage; }
const gameplayDefsIcon = (c: MenuCtx, item: number): string => gameplayDefs(c.world).items.get(item)?.spriteKey ?? "";
const draft: StallListDraft = { listing: 0, invSlot: -1, count: 1, priceItem: 0, priceCount: 1, qty: 1 };

/** ADR-145 pet panel title: the species shows once (an unnamed pet's name is its species). */
export function petTitle(v: { wild: boolean; name: string; speciesName: string; level: number }): string {
  if (v.wild) return v.name; return v.name === v.speciesName ? `${v.name} · Lv ${v.level}` : `${v.name} · ${v.speciesName} · Lv ${v.level}`;
}
/** ADR-110: icon keys the stylesheet has art for ([data-icon="x"] rules; Art's generated block), scanned once. */
let knownIcons: Set<string> | undefined;
export function iconKeysFromCss(cssTexts: Iterable<string>): Set<string> {
  const out = new Set<string>(); for (const t of cssTexts) for (const m of t.matchAll(/\[data-icon="([^"]+)"\]/g)) out.add(m[1]!); return out;
}
function hasIcon(k: string): boolean {
  if (!knownIcons) { const texts: string[] = []; try { for (const sh of Array.from(document.styleSheets)) { try { for (const r of Array.from(sh.cssRules)) texts.push(r.cssText); } catch { /* cross-origin sheet */ } } } catch { /* no DOM */ } knownIcons = iconKeysFromCss(texts); }
  return knownIcons.size === 0 || knownIcons.has(k); // no stylesheet info (tests / headless): keep keys as-is
}
/**
 * ADR-229: build window icon key (Art's items_build atlas, packages/assets/pack/items/src/adr224.py). Tiered pieces have
 * build_<key>_t<N> for N = minTier..4 (the selected tier's art, else the nearest tier above it); untiered build_<key>.
 * undefined = no art -> the tile keeps its placeholder glyph.
 */
export function buildIconKey(pieceKey: string, tier: number, tiered: boolean, has: (k: string) => boolean = hasIcon): string | undefined {
  const c = tiered ? [...Array.from({ length: Math.max(0, 5 - tier) }, (_, i) => `build_${pieceKey}_t${tier + i}`), `build_${pieceKey}`] : [`build_${pieceKey}`];
  return c.find(has) ?? fallbackBuildIcon(pieceKey, has);
}
/** ADR-250: a piece without its own build icon borrows the icon of its art fallback (sprite_fallbacks.json `to` chain):
 *  basic_storage_box -> build_crate_decor until Art ships build_basic_storage_box. */
function fallbackBuildIcon(pieceKey: string, has: (k: string) => boolean, depth = 0): string | undefined {
  const e = SPRITE_FALLBACKS.sprites[pieceKey]; if (!e || depth > 4) return undefined;
  for (const k of e.to) { const r = has(`build_${k}`) ? `build_${k}` : fallbackBuildIcon(k, has, depth + 1); if (r) return r; }
  return undefined;
}
/** ADR-229: roads tab — road-<i> = surfaces[i-1] -> build_road_<surface key>; sign tools use the wooden post sign. */
export const roadIconKey = (surfaceKey: string): string => `build_road_${surfaceKey}`;
export const signIconKey = (signKey: string): string => `build_${signKey}`;
export const SIGN_TOOL_ICON = "build_sign_wooden_post";
/** ADR-229/230: icons Art ships white/neutral (rugs, curtains, tapestry, clan flag, vase, pottery, picket fence): tinted with the clan palette at draw time. */
export const isClanTintedIcon = (pieceKey: string): boolean => /^(rug_.+|curtains|tapestry|clan_flag|vase|pottery|fence_picket)$/.test(pieceKey);
/** 0xRRGGBB -> #rrggbb */
const hex6 = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
/** Real icon when Art has it, else the item's mapped fallback, else its category's generic icon. */
export function panelIcon(world: Parameters<typeof gameplayDefs>[0], icon: string, item: string | undefined): string {
  if (!icon || hasIcon(icon)) return icon;
  const it = item ? gameplayDefs(world).items.get(Number(item)) : undefined;
  return it ? iconForItem(it, hasIcon) : icon;
}
/** Short label telling apart recipes with the same output: first ingredient not shared by every sibling recipe. */
export function recipeVariantLabel(r: { output: { item: number }; ingredients: { item: number; name: string }[] }, all: readonly { output: { item: number }; ingredients: { item: number }[] }[]): string {
  const sib = all.filter((o) => o.output.item === r.output.item && o !== r);
  const d = r.ingredients.find((i) => sib.every((o) => !o.ingredients.some((x) => x.item === i.item))) ?? r.ingredients.find((i) => sib.some((o) => !o.ingredients.some((x) => x.item === i.item)));
  return (d ?? r.ingredients[0])?.name.toLowerCase() ?? "alt";
}
export function gameplayBody(id: GameplayPanel, src: GameplaySource, kit: PanelKit): Node[] {
  const c = src.ctx(); if (!c) return [kit.para("Join a game to use this menu.")];
  const rankOf = (role: number): string => role === 3 ? "leader" : role === 2 ? "officer" : "member";
  const btn = (label: string, key: string, fn: (ev?: MouseEvent) => void, opts: { alt?: boolean; disabled?: boolean; title?: string; role?: string; pressed?: boolean; data?: Record<string, string>; p?: number } = {}): HTMLButtonElement => {
    const b = el("button", { type: "button", "data-key": key }, label || undefined); if (opts.alt) b.className = "alt"; if (opts.disabled) b.disabled = true; if (opts.title) { b.dataset["tip"] = opts.title; b.setAttribute("aria-label", `${label}. ${opts.title}`); }
    if (opts.data) for (const [k, v] of Object.entries(opts.data)) b.setAttribute(`data-${k}`, k === "icon" ? panelIcon(c.world, v, opts.data["item"]) : v);
    if (opts.p !== undefined) b.setAttribute("style", `--p:${Math.max(0, Math.min(1, opts.p)).toFixed(3)}`);
    if (opts.role) b.dataset["role"] = opts.role; if (opts.pressed !== undefined) b.setAttribute("aria-pressed", String(opts.pressed));
    b.onclick = fn; return b; // property (not listener) so the diffing refresh can swap in fresh closures
  };
  const send = (i: MenuIntent, ok: string): void => { kit.status(src.send(i) ? ok : "Not connected."); kit.rerender(); };
  switch (id) {
    case "inventory": {
      const v = inventoryView(c); const box = openContainer(c); const cv = box !== undefined ? containerView(c, box, containerPage) : undefined;
      if (cv) containerPage = cv.page;
      const out: Node[] = [];
      const packCap = capacityBar(c, c.player, "Pack"); if (packCap) out.push(packCap);
      // ADR-108: fired stations / lights show a fuel section — status, Light/Put out toggle (X on pad), and one button
      // per fuel item in the pack (adds the whole stack). All plain focusable buttons: touch, D-pad and keys work alike.
      const fv = cv ? fuelView(c, cv.entity) : undefined;
      if (cv && fv) {
        const fs = el("section", { "data-role": "station-fuel" }); const secs = Math.round(fv.secondsLeft);
        fs.append(el("p", { "data-role": "fuel-time" }, `${fv.lit ? "Lit" : "Out"} · fuel ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`));
        fs.append(btn(fv.lit ? "Put out" : "Light", "fire-toggle", () => send(toggleFireIntent(cv.entity), fv.lit ? "Put out." : "Lit."), { role: "toggle", pressed: fv.lit, disabled: !fv.lit && secs <= 0, title: fv.lit ? "Extinguish (X)" : secs > 0 ? "Light (X)" : "Add fuel first", data: { pad: "X" } }));
        const g = grid(); g.dataset["role"] = "fuel-slots";
        for (const f of fv.fuels) g.append(btn(`${f.name} ×${f.count}`, `fuel-${f.item}`, () => send(depositIntent(cv.entity, f.item, f.count), `Added ${f.name} ×${f.count}.`), { role: "slot", title: `${f.seconds}s each · add as fuel`, data: { item: String(f.item), icon: f.key } }));
        if (!fv.fuels.length) fs.append(kit.para("Carry wood, coal or crude oil to fuel this."));
        else fs.append(g);
        out.push(heading("Fuel"), fs);
      }
      // ADR-204/205 split / to-hotbar pickers take over the details pane while active (pad X / Y on a slot, or the pane's
      // buttons). where 0 = pack, 1 = the open container (to hotbar moves it into the pack's hotbar slot, swapping the old one back).
      type Ent = { slot: number; item: number; count: number; name: string; icon: string; tooltip: string };
      const boxE: Ent[] = cv ? cv.slots.filter((x) => x.item) : [];
      const listOf = (w: 0 | 1): Ent[] => (w === 1 ? boxE : v);
      const back = (w: 0 | 1, sl: number): string => (w === 1 ? `cslot-${sl}` : `slot-${sl}`);
      const startArrange = (mode: "split" | "hotbar", w: 0 | 1, sl: number): void => { const it = listOf(w).find((x) => x.slot === sl); if (!it) return;
        arrangeUi.mode = mode; arrangeUi.where = w; arrangeUi.slot = sl; arrangeUi.count = defaultSplit(it.count); invUi.pick = undefined; kit.rerender();
        let h = 0; while (h < HOTBAR_SIZE && ((w === 0 && HOTBAR_OFFSET + h === sl) || v.some((x) => x.slot === HOTBAR_OFFSET + h))) h++; if (h >= HOTBAR_SIZE) h = w === 0 && sl === HOTBAR_OFFSET ? 1 : 0;
        focusKey(mode === "split" ? "split-go" : `hb-to-${h}`); };
      if (arrangeUi.where === 1 && !cv) arrangeUi.mode = "";
      const picker = (): HTMLElement | undefined => {
        const W = arrangeUi.where; const cur = listOf(W).find((x) => x.slot === arrangeUi.slot);
        if (arrangeUi.mode && (!cur || (arrangeUi.mode === "split" && cur.count < 2))) arrangeUi.mode = "";
        if (!arrangeUi.mode || !cur) return undefined;
        const cancel = (): void => { const sl = arrangeUi.slot; arrangeUi.mode = ""; kit.rerender(); focusKey(back(W, sl)); };
        const ar = el("section", { "data-role": "arrange" });
        if (arrangeUi.mode === "split") {
          const max = cur.count - 1; arrangeUi.count = Math.max(1, Math.min(max, arrangeUi.count));
          const adj = (d: number): void => { arrangeUi.count = Math.max(1, Math.min(max, arrangeUi.count + d)); kit.rerender(); };
          // amount readout sits in the heading (own line) so no tooltip / button ever covers it
          const hd = heading(`Split ${cur.name} — `); hd.append(el("output", { "data-role": "split-count", "aria-live": "polite" }, `${arrangeUi.count} / ${cur.count}`));
          const row = grid(); row.dataset["role"] = "split-picker"; row.dataset["tabsLabel"] = "Amount";
          row.append(btn("−", "split-dec", () => adj(-1), { alt: true, disabled: arrangeUi.count <= 1, data: { pad: "LT", padLabel: "Less" } }),
            btn("+", "split-inc", () => adj(1), { alt: true, disabled: arrangeUi.count >= max, data: { pad: "RT", padLabel: "More" } }),
            btn(`Split ×${arrangeUi.count}`, "split-go", () => { const n = arrangeUi.count; arrangeUi.mode = ""; send(splitStackIntent(cur.slot, n, W), `Split ${cur.name} ×${n} into a new stack.`); focusKey(back(W, cur.slot)); }, { role: "split" }),
            btn("Cancel", "arrange-cancel", cancel, { alt: true }));
          ar.append(hd, row);
        } else {
          const row = grid(); row.dataset["role"] = "hotbar-picker";
          for (let h = 0; h < HOTBAR_SIZE; h++) { const hs = HOTBAR_OFFSET + h; const o = v.find((x) => x.slot === hs); const lock = W === 1 && !!o?.equipped;
            row.append(btn(`${h + 1}${o ? `: ${o.name}` : ""}${lock ? " (equipped)" : ""}`, `hb-to-${h}`, () => { arrangeUi.mode = "";
              send(W === 1 ? containerToSlotIntent(cur.slot, hs) : moveSlotIntent(cur.slot, hs), o ? `Swapped ${cur.name} with ${o.name} (hotbar ${h + 1}).` : `${cur.name} → hotbar ${h + 1}.`); focusKey(`slot-${hs}`); },
              { role: "hotbar-slot", disabled: (W === 0 && hs === cur.slot) || lock, alt: !!o, data: { slot: String(hs) } })); }
          row.append(btn("Cancel", "arrange-cancel", cancel, { alt: true }));
          ar.append(heading(`Put ${cur.name} on hotbar slot${W === 1 ? " (from storage)" : ""}`), row);
        }
        return ar;
      };
      // ADR-223 slot-grid inventory + ADR-231 drag-and-drop. Pack slots (0..PACK_SLOTS-1) in a contained scroll area, the hotbar
      // (HOTBAR_OFFSET..HOTBAR_OFFSET+HOTBAR_SIZE-1) as a bottom row, equipment to the right (stacked on narrow screens) — or, with a container open, the
      // container's grid beside / below the pack (the old split / to-hotbar list is gone) — and ONE details pane.
      // Tile input: pad A / Enter = primary action (eat · drink · equip · store / take); mouse / touch: tap selects, double-click /
      // double-tap = primary; drag a tile (mouse: small move, touch: long-press) onto any pack / hotbar / container / equipment
      // slot = move · swap · merge (server-authoritative MoveSlot / ContainerToSlot / equip); releasing anywhere else cancels.
      // Pad / keys: the pane's "Move" (or a picked tile) then A / Enter / tap on the destination slot; pad X = split, Y = to hotbar.
      const nSlots = readSlots(c.world, c.player).slotCount;
      const bySlot = new Map(v.map((s) => [s.slot, s] as const)); const byC = new Map(boxE.map((s) => [s.slot, s] as const));
      const equipSlot = (s: (typeof v)[number]): void => send(s.equip === "hand" ? equipIntent(s.slot) : wearIntent(s.slot), s.equipped ? `Unequipped ${s.name}.` : `Equipped ${s.name}.`);
      const me = c.world.get(c.player, Transform); const wet = !!me && nearWater(c.world, me.x, me.y);
      const useVerb = (s: (typeof v)[number]): string => { const empty = s.consume === "drink" && /Empty:/.test(s.tooltip); return empty ? (wet ? "Refill" : "Empty") : s.consume === "apply" ? "Apply" : s.consume === "drink" ? "Drink" : "Eat"; };
      const eat = (s: (typeof v)[number]): void => {
        const vb = useVerb(s);
        if (vb === "Apply" && !gameplayDefs(c.world).items.get(s.item)?.cures.some(key => hasDisease(c.world, c.player, key))) return kit.status("No Broken Leg to heal — splint kept.");
        if (vb === "Empty") return kit.status(`${s.name} is empty — refill it at water.`);
        send(useIntent(s.slot), `${vb === "Refill" ? "Refilled" : vb === "Drink" ? "Drank" : vb === "Apply" ? "Applied" : "Ate"} ${s.name}.`);
      };
      const store = (s: Ent): void => { if (cv) send(depositIntent(cv.entity, s.item, s.count), `Stored ${s.name} ×${s.count}.`); };
      const take = (s: Ent): void => { if (cv) send(withdrawIntent(cv.entity, s.item, s.count), `Took ${s.name} ×${s.count}.`); };
      const primary = (s: (typeof v)[number]): void => cv ? store(s) : s.consume ? eat(s) : s.equip ? equipSlot(s) : kit.status(s.tooltip.replace(/\n/g, " · "));
      const primaryLabel = (s: (typeof v)[number]): string => cv ? "Store" : s.consume ? useVerb(s) : s.equip ? (s.equipped ? "Unequip" : "Equip") : "";
      const eqv = cv ? [] : equipmentView(c);
      // ADR-231: one drop rule for drag (mouse / touch), pick + place (pad / keys / tap) — reuses the existing server commands.
      const entOf = (r: SlotRef): Ent | undefined => r.kind === "c" ? byC.get(r.slot) : r.kind === "e" ? (() => { const q = eqv.find((x) => x.slot === r.slot); return q?.item ? bySlot.get(q.invSlot) : undefined; })() : bySlot.get(r.slot);
      const dropTo = (from: SlotRef, to: SlotRef): void => {
        invUi.pick = undefined; const a = entOf(from); if (!a) { kit.status("Nothing to move there."); return kit.rerender(); }
        const o = entOf(to); const verb = o ? (o.item === a.item ? `Stacked ${a.name}.` : `Swapped ${a.name} with ${o.name}.`) : `Moved ${a.name}.`;
        const unequip = (): void => { const q = eqv.find((x) => x.slot === from.slot); if (q?.item) src.send(q.slot < 0 ? equipIntent(q.invSlot) : wearIntent(q.invSlot)); };
        if (from.kind === "e") { // dragging gear out of an equipment slot: unequip, then move it where it was dropped
          if (to.kind === "e") return kit.rerender(); unequip(); const sl = a.slot;
          if (to.kind === "p" && to.slot !== sl) send(moveSlotIntent(sl, to.slot), `Unequipped ${a.name}.`); else if (to.kind === "c") send(slotToContainerIntent(sl, to.slot), `Stored ${a.name}.`); else { kit.status(`Unequipped ${a.name}.`); kit.rerender(); }
          return;
        }
        if (to.kind === "e") { const s = bySlot.get(from.slot); if (from.kind === "p" && s?.equip && !s.equipped) return equipSlot(s); kit.status(s?.equipped ? `${a.name} is already equipped.` : `${a.name} can't be equipped.`); return kit.rerender(); }
        if (from.kind === "p" && to.kind === "p") return send(moveSlotIntent(from.slot, to.slot), verb);
        if (from.kind === "c" && to.kind === "c") return send(moveSlotIntent(from.slot, to.slot, 1), verb);
        if (from.kind === "c" && to.kind === "p") { invUi.sel = to.slot; invUi.csel = -1; return send(containerToSlotIntent(from.slot, to.slot), verb); }
        if (from.kind === "p" && to.kind === "c") { invUi.csel = to.slot; invUi.sel = -1; return send(slotToContainerIntent(from.slot, to.slot), verb); }
        kit.rerender();
      };
      invDrop = dropTo; ensureSlotDrag();
      const placePick = (to: SlotRef): boolean => { const p = invUi.pick; if (!p) return false; if (p.kind === to.kind && p.slot === to.slot) { invUi.pick = undefined; kit.rerender(); return true; } dropTo(p, to); return true; };
      const startPick = (r: SlotRef, name: string): void => { invUi.pick = r; kit.status(`Moving ${name} — tap or press A on a slot (Cancel to stop).`); kit.rerender(); focusKey(r.kind === "c" ? `cslot-${r.slot}` : r.kind === "e" ? `equip-${r.slot}` : `slot-${r.slot}`); };
      const isPicked = (k: SlotKind, sl: number): boolean => invUi.pick?.kind === k && invUi.pick.slot === sl;
      if (invUi.sel >= 0 && !bySlot.has(invUi.sel)) invUi.sel = -1;
      if (invUi.csel >= 0 && !byC.has(invUi.csel)) invUi.csel = -1;
      if (invUi.pick && !entOf(invUi.pick)) invUi.pick = undefined;
      const equippedIn = (slot: number): string | undefined => { const q = eqv.find((x) => x.invSlot === slot); return q?.item ? q.label : undefined; };
      const tile = (slot: number): HTMLElement => {
        const s = bySlot.get(slot); const hot = slot >= HOTBAR_OFFSET; const ref = slotRef("p", slot);
        if (s?.equipped) { // equipped pieces live in the paper-doll slot, not in the pack: show where they went
          const label = equippedIn(s.slot) ?? "Equipment";
          const b = btn(`→ ${label}`, `slot-${slot}`, () => kit.status(`${s.name} is equipped in ${label} — unequip it there to return it to your pack.`), { alt: true, role: "slot", data: { slot: String(slot), equipped: label } });
          b.setAttribute("aria-label", `${s.name} equipped in ${label}`); if (hot) b.append(el("span", { class: "hk" }, String(slot - HOTBAR_OFFSET + 1)));
          return b;
        }
        if (!s) { // empty slot: a drop target; hotbar empties are focusable so the bar reads as 8 cells on every input
          const b = btn("", `slot-${slot}`, () => { if (placePick({ kind: "p", slot })) return; invUi.sel = -1; kit.rerender(); }, { alt: true, role: "slot", data: { slot: String(slot), empty: "", drop: ref } });
          b.setAttribute("aria-label", hot ? `Hotbar ${slot - HOTBAR_OFFSET + 1} (empty)` : `Slot ${slot + 1} (empty)`); if (!hot && !invUi.pick) b.tabIndex = -1;
          if (hot) b.append(el("span", { class: "hk" }, String(slot - HOTBAR_OFFSET + 1)));
          return b;
        }
        const b = btn("", `slot-${s.slot}`, (ev?: MouseEvent) => {
          if (placePick({ kind: "p", slot: s.slot })) return;
          const now = Date.now(); const twice = invUi.lastTap.slot === s.slot && now - invUi.lastTap.t < 450;
          if (!ev || ev.detail === 0 || twice) { invUi.lastTap = { slot: -1, t: 0 }; invUi.sel = s.slot; invUi.csel = -1; primary(s); kit.rerender(); return; } // pad A / Enter / double-click / double-tap
          invUi.lastTap = { slot: s.slot, t: now }; if (invUi.sel !== s.slot) { invUi.sel = s.slot; invUi.csel = -1; kit.rerender(); }
        }, { role: "slot", data: { item: String(s.item), icon: s.icon, slot: String(s.slot), drag: ref, drop: ref, ...(s.equip && { equip: s.equip }), ...(s.equipped && { equipped: "" }), ...(s.consume && { use: s.consume }), ...(invUi.sel === s.slot && { sel: "" }), ...(isPicked("p", s.slot) && { picked: "" }) } });
        b.append(el("span", { class: "nm" }, `${s.equipped ? "◆ " : ""}${s.name} ×${s.count}`));
        if (s.fill) b.append(fillBar(document, s.fill)); // ADR-290
        if (s.count > 1) b.append(el("span", { class: "ct", "aria-hidden": "true" }, String(s.count)));
        if (hot) b.append(el("span", { class: "hk", "aria-hidden": "true" }, String(slot - HOTBAR_OFFSET + 1)));
        const pl = invUi.pick ? "Put here" : primaryLabel(s); b.setAttribute("aria-label", `${s.name} ×${s.count}${s.fill ? ` (${fillLabel(s.fill)})` : ""}${pl ? `. ${pl}` : ""}`); if (pl) { b.dataset["padLabel"] = pl; }
        b.onfocus = () => { if (invUi.sel !== s.slot && !invUi.pick) { invUi.sel = s.slot; invUi.csel = -1; kit.rerender(); } };
        // ADR-204/205: pad X = split, Y = to hotbar on the focused slot (UINav contextual shortcuts + footer hints)
        if (s.count >= 2) { b.dataset["padX"] = `split-${s.slot}`; b.dataset["padXLabel"] = "Split"; }
        b.dataset["padY"] = `tohb-${s.slot}`; b.dataset["padYLabel"] = "To hotbar";
        return b;
      };
      const ctile = (s: NonNullable<typeof cv>["slots"][number]): HTMLElement => {
        const ref = slotRef("c", s.slot);
        if (!s.item) { const b = btn("", `cslot-${s.slot}`, () => { if (placePick({ kind: "c", slot: s.slot })) return; invUi.csel = -1; kit.rerender(); }, { alt: true, role: "cslot", data: { item: "0", slot: String(s.slot), empty: "", drop: ref } });
          b.setAttribute("aria-label", `Storage slot ${s.slot + 1} (empty)`); return b; }
        const b = btn("", `cslot-${s.slot}`, (ev?: MouseEvent) => {
          if (placePick({ kind: "c", slot: s.slot })) return;
          const now = Date.now(); const twice = invUi.lastTap.slot === 1000 + s.slot && now - invUi.lastTap.t < 450;
          if (!ev || ev.detail === 0 || twice) { invUi.lastTap = { slot: -1, t: 0 }; take(s); return; } // pad A / Enter / double-tap = take
          invUi.lastTap = { slot: 1000 + s.slot, t: now }; if (invUi.csel !== s.slot) { invUi.csel = s.slot; invUi.sel = -1; kit.rerender(); }
        }, { role: "cslot", data: { item: String(s.item), icon: s.icon, slot: String(s.slot), drag: ref, drop: ref, ...(invUi.csel === s.slot && { sel: "" }), ...(isPicked("c", s.slot) && { picked: "" }),
          ...(s.count >= 2 && { "pad-x": `csplit-${s.slot}`, "pad-x-label": "Split" }), "pad-y": `ctohb-${s.slot}`, "pad-y-label": "To hotbar" } }); // ADR-205
        if (s.fill) b.append(fillBar(document, s.fill)); b.append(el("span", { class: "nm" }, `${s.name} ×${s.count}`)); if (s.count > 1) b.append(el("span", { class: "ct", "aria-hidden": "true" }, String(s.count)));
        b.setAttribute("aria-label", `${s.name} ×${s.count}. ${invUi.pick ? "Put here" : "Take"}`); b.dataset["padLabel"] = invUi.pick ? "Put here" : "Take";
        b.onfocus = () => { if (invUi.csel !== s.slot && !invUi.pick) { invUi.csel = s.slot; invUi.sel = -1; kit.rerender(); } };
        return b;
      };
      const lay = el("div", { "data-role": "inv-layout", ...(cv && { "data-mode": "container" }) });
      const pack = el("div", { "data-role": "inv-grid", "aria-label": "Pack" }); const bar = el("div", { "data-role": "inv-hotbar", "aria-label": "Hotbar" });
      for (let i = 0; i < PACK_SLOTS; i++) pack.append(tile(i));
      for (let i = HOTBAR_OFFSET; i < HOTBAR_OFFSET + HOTBAR_SIZE; i++) bar.append(tile(i));
      const left = el("div", { "data-role": "inv-main" }); if (cv) left.append(heading("Your pack")); left.append(pack, bar); lay.append(left);
      if (!cv) {
        // Paper-doll: a human silhouette in the centre, equipment slots arranged around it (head above, hands at
        // the sides, feet below), so equipped pieces are seen on the body, not as a list of large slots. Equipped
        // pieces no longer appear as items in the pack grid above: they live here until unequipped.
        const eq = el("section", { "data-role": "equipment", "aria-label": "Equipment" });
        const doll = el("div", { "data-role": "doll", "aria-hidden": "true" });
  // Task 25: the 🧍 emoji placeholder is a custom pixel-art silhouette now.
  doll.append(iconImg("ic_doll.png", 64, "Character"));
        eq.append(doll);
        for (const q of eqv) {
          const ref = slotRef("e", q.slot);
          const b = btn(q.item ? q.name : q.label, `equip-${q.slot}`, () => { if (placePick({ kind: "e", slot: q.slot })) return; if (!q.item) return kit.status(`Drag an item here, or double-tap / press A on it to equip it (${q.label}).`); send(q.slot < 0 ? equipIntent(q.invSlot) : wearIntent(q.invSlot), `Unequipped ${q.name}.`); },
            { role: "equip", alt: !q.item, data: { slot: String(q.slot), equip: q.label, drop: ref, ...(q.item && { item: String(q.item), icon: q.icon, drag: ref }), ...(isPicked("e", q.slot) && { picked: "" }) } });
          b.setAttribute("aria-label", `${q.label}: ${q.item ? `${q.name}. Unequip` : "empty"}`);
          eq.append(b);
        }
        lay.append(eq);
      } else {
        // ADR-098 paged container grid (CONTAINER_PAGE_SIZE per page) as tiles beside / below the pack. Every slot is a focusable
        // button so the D-pad / arrows walk the grid; ◀ ▶ (touch), PgUp/PgDn (keyboard) and LB/RB (gamepad) change pages.
        const right = el("section", { "data-role": "container-side", "aria-label": cv.name });
        const ccap = capacityView(c, cv.entity);
        right.append(heading(`${cv.name} · ${cv.slotCount} slots${ccap ? ` · ${ccap.slotsUsed} used · ${ccap.freeSlots} free` : ""}${cv.maxWeight > 0 ? ` · ${Math.round(cv.weight)}/${Math.round(cv.maxWeight)} kg · ${Math.round(ccap?.freeWeight ?? 0)} kg free` : ""}`));
        const cbar = capacityBar(c, cv.entity, "Storage"); if (cbar) right.append(cbar);
        // ADR-160: loot bags (zombie / animal / death / dropped) get a "Take all" first (focusable: click, tap, D-pad + A)
        if (c.world.isRegistered(LootBag) && c.world.has(cv.entity, LootBag) && cv.slots.some((x) => x.item)) right.append(btn("Take all", "take-all", () => send(takeAllIntent(cv.entity), "Took everything that fits."), { role: "use", title: "Move every stack into your pack" }));
        const g = el("div", { "data-role": "container-grid", "aria-label": `${cv.name} slots` }); g.dataset["page"] = String(cv.page);
        for (const s of cv.slots) g.append(ctile(s));
        right.append(g);
        if (cv.pages > 1) {
          const pg = grid(); pg.dataset["role"] = "container-pager";
          pg.append(btn("◀", "page-prev", () => { pageContainer(-1); kit.rerender(); }, { alt: true, disabled: cv.page === 0, title: "Previous page (PgUp / LB)" }));
          const label = kit.para(`Page ${cv.page + 1}/${cv.pages} · slots ${cv.first + 1}-${Math.min(cv.slotCount, cv.first + CONTAINER_PAGE_SIZE)}`); label.dataset["role"] = "page-label"; pg.append(label);
          pg.append(btn("▶", "page-next", () => { pageContainer(1); kit.rerender(); }, { alt: true, disabled: cv.page >= cv.pages - 1, title: "Next page (PgDn / RB)" }));
          right.append(pg);
        }
        lay.append(right);
      }
      out.push(lay);
      if (!v.length && !cv) out.push(kit.para("Your pack is empty."));
      const pk = picker();
      if (pk) out.push(pk);
      else {
        const s = bySlot.get(invUi.sel); const cs = byC.get(invUi.csel); const det = el("section", { "data-role": "inv-details", "aria-live": "polite" });
        const pickRow = (r: SlotRef, name: string): HTMLButtonElement => btn("Move", `${r.kind === "c" ? "c" : ""}move-${r.slot}`, () => startPick(r, name), { alt: true, role: "move-start", title: "Then tap / press A on a slot" });
        if (invUi.pick) { const a = entOf(invUi.pick);
          det.append(el("p", { "data-role": "inv-name" }, `Moving ${a?.name ?? "item"}`), kit.para("Tap or press A on a slot to put it there — or drag tiles directly."));
          const row = grid(); row.dataset["role"] = "inv-actions"; row.append(btn("Cancel move", "move-cancel", () => { const p = invUi.pick; invUi.pick = undefined; kit.rerender(); if (p) focusKey(p.kind === "c" ? `cslot-${p.slot}` : p.kind === "e" ? `equip-${p.slot}` : `slot-${p.slot}`); }, { alt: true })); det.append(row);
        } else if (cs && cv) {
          const [first, ...rest] = cs.tooltip.split("\n");
          det.append(el("p", { "data-role": "inv-name" }, first ?? cs.name)); if (rest.length) det.append(el("p", { "data-role": "inv-tip" }, rest.filter(Boolean).join(" · ")));
          const row = grid(); row.dataset["role"] = "inv-actions";
          row.append(btn("Take", `take-${cs.slot}`, () => take(cs), { role: "use" }));
          if (cs.count >= 2) row.append(btn("Split", `csplit-${cs.slot}`, () => startArrange("split", 1, cs.slot), { alt: true, role: "split-start" }));
          row.append(btn("To hotbar", `ctohb-${cs.slot}`, () => startArrange("hotbar", 1, cs.slot), { alt: true, role: "hotbar-start" }), pickRow({ kind: "c", slot: cs.slot }, cs.name));
          det.append(row);
        } else if (!s) det.append(kit.para(cv ? "Drag items between your pack and the storage (long-press on touch), or select one: double-tap / A stores or takes it." : v.length ? "Select an item. Double-tap or press A to eat, drink or equip. Drag (long-press on touch) to move." : "Gather or craft items to fill your pack."));
        else {
          const [first, ...rest] = s.tooltip.split("\n");
          det.append(el("p", { "data-role": "inv-name" }, first ?? s.name)); if (rest.length) det.append(el("p", { "data-role": "inv-tip" }, rest.filter(Boolean).join(" · ")));
          const row = grid(); row.dataset["role"] = "inv-actions";
          if (cv && !s.equipped) row.append(btn("Store", `store-${s.slot}`, () => store(s), { role: "use" }));
          if (s.consume) row.append(btn(useVerb(s), `use-${s.slot}`, () => eat(s), { role: "use", disabled: useVerb(s) === "Empty", data: { use: s.consume } }));
          // Task 13: boil a filled raw-water container at a lit campfire (button only shows when one is in reach).
          // Note: a nearby campfire station has a Container, so openContainer() puts the panel in container mode
          // (cv truthy) — the button must show in that mode too, not only with no container open.
          if (!s.equipped) {
            const bd = gameplayDefs(c.world).items.get(s.item);
            const boilable = !!bd && bd.sips > 0 && !bd.boiled && !!bd.boilTarget && readSlots(c.world, c.player).durability(s.slot) > 0;
            if (boilable && me && (holdingTorch(c.world, c.player) || nearLitCampfire(c.world, me.x, me.y, gameplayDefs(c.world).building.containerReach))) row.append(btn("Boil", `boil-${s.slot}`, () => send(boilIntent(s.slot), `Boiled ${s.name}.`), { role: "use" }));
          }
          if (s.equip) row.append(btn(s.equipped ? "Unequip" : "Equip", `eq-${s.slot}`, () => equipSlot(s), { role: "equip-toggle" }));
          if (!cv && s.equip === "hand" && gameplayDefs(c.world).items.get(s.item)?.wear?.slot === 6 /* WearSlot.OffHand */) row.append(btn("Off hand", `offhand-${s.slot}`, () => send(wearIntent(s.slot), `Off hand ${s.name}.`), { role: "use" }));
          if (!cv && isKit(c.world, s.item)) row.append(btn("Deploy", `deploy-${s.slot}`, () => { const i = deployKitIntent(c.world, c.player, s.slot); if (i) send(i, `Deployed ${s.name}. Walk up and press Use to get in.`); }, { role: "deploy" }));
          if (s.count >= 2) row.append(btn("Split", `split-${s.slot}`, () => startArrange("split", 0, s.slot), { alt: true, role: "split-start" }));
          row.append(btn("To hotbar", `tohb-${s.slot}`, () => startArrange("hotbar", 0, s.slot), { alt: true, role: "hotbar-start" }), pickRow({ kind: "p", slot: s.slot }, s.name));
          if (!s.equipped && !cv) row.append(btn("Drop", `drop-${s.slot}`, () => { invUi.sel = -1; send(dropItemIntent(s.item, s.count), `Dropped ${s.name} ×${s.count}.`); }, { alt: true, role: "drop" }));
          det.append(row);
        }
        if (wet && !cv) { const w = grid(); w.dataset["role"] = "consume"; w.append(btn("Drink water", "use-water", () => send(drinkWaterIntent(), "You drink from the water."), { role: "use", alt: true, data: { use: "drink" } })); det.append(w); }
        out.push(det);
      }
      return out;
    }
    case "station":
    case "crafting": {
      // ADR-136: personal menu = hand recipes only; a station's panel = that station's recipes only
      const st = id === "station" ? src.station?.() : undefined;
      if (id === "station" && !st) return [kit.para("Walk up to a crafting station and interact (E / X / tap) to use it.")];
      const v = craftingView(c, st?.kind ?? 0); const out: Node[] = [];
      if (st) {
        out.push(el("p", { "data-role": "station-name" }, v.stationName));
        if (c.world.isRegistered(Container) && c.world.has(st.entity, Container)) { const sc = capacityBar(c, st.entity, "Station storage"); if (sc) out.push(sc); }
        const pc = capacityBar(c, c.player, "Pack"); if (pc) out.push(pc); // crafted outputs go to your pack: its free space decides whether they are owed
        const fv = fuelView(c, st.entity); // fired stations (campfire, furnace): light / fuel without leaving the panel
        if (fv) { const secs = Math.round(fv.secondsLeft); const fs = el("section", { "data-role": "station-fuel" });
          fs.append(el("p", { "data-role": "fuel-time" }, `${fv.lit ? "Lit" : "Out — light it to craft"} · fuel ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`));
          fs.append(btn(fv.lit ? "Put out" : "Light", "fire-toggle", () => send(toggleFireIntent(st.entity), fv.lit ? "Put out." : "Lit."), { role: "toggle", pressed: fv.lit, disabled: !fv.lit && secs <= 0, title: fv.lit ? "Extinguish (X)" : secs > 0 ? "Light (X)" : "Add fuel first", data: { pad: "X" } }));
          const f0 = fv.fuels[0]; if (f0) fs.append(btn(`Add ${f0.name} ×${f0.count}`, `fuel-${f0.item}`, () => send(depositIntent(st.entity, f0.item, f0.count), `Added ${f0.name} ×${f0.count}.`), { role: "slot", title: `${f0.seconds}s each · add as fuel` }));
          out.push(fs); }
      } else {
        const pc = capacityBar(c, c.player, "Pack"); if (pc) out.push(pc);
      }
      if (v.queue.length) { out.push(heading("Queue")); const g = grid(); for (const j of v.queue) g.append(btn(`✕ ${j.name} ×${j.count} · ${JOB_STATE_LABEL[j.state] ?? ""} ${Math.round(j.progress * 100)}%`, `job-${j.slot}`, () => send(cancelQueuedCraftIntent(j.slot), `Cancelled ${j.name}.`), { alt: true, role: "job", p: j.progress, title: `${Math.ceil(j.secondsLeft)}s left. Cancel refunds unfinished units.` })); out.push(g); }
      if (v.owed.length) { out.push(heading("Owed (delivered when you have space)")); for (const o of v.owed) { const p = kit.para(`${o.name} ×${o.count}${o.crafterName ? ` · crafted by ${o.crafterName}` : ""}`); p.dataset["role"] = "owed"; out.push(p); } }
      if (!st) { const n = v.elsewhere.reduce((a, e) => a + e.count, 0); if (n) { const h = kit.para(`More recipes at stations (${n}): ${v.elsewhere.map((e) => `${e.name} ${e.count}`).join(" · ")}`); h.dataset["role"] = "station-hint"; out.push(h); } }
      // ADR-223: compact crafting — category tabs (from the output item's category; LB/RB on pad), a search box, a tile grid
      // (icon + short name, scrolls inside) and ONE details pane for the focused / hovered recipe (no floating tooltips).
      // Tile click / tap / Enter / pad A queues ×count, as before.
      const catOf = (item: number): string => { const k = gameplayDefs(c.world).items.get(item)?.category; return k === 1 ? "food" : k === 2 ? "tools" : k === 4 || k === 7 || k === 8 ? "combat" : k === 5 || k === 6 ? "wear" : "materials"; };
      const CAT_LABEL: Record<string, string> = { all: "All", tools: "Tools", combat: "Combat", wear: "Wear", food: "Food", materials: "Materials" };
      const present = new Set(v.recipes.map((r) => catOf(r.output.item))); const cats = ["all", ...["tools", "combat", "wear", "food", "materials"].filter((k) => present.has(k))];
      if (!cats.includes(craftUi.cat)) craftUi.cat = "all";
      const tabs = grid(); tabs.dataset["role"] = "craft-cats"; tabs.dataset["tabs"] = "tab"; tabs.dataset["tabsLabel"] = "Category";
      for (const k of cats) tabs.append(btn(CAT_LABEL[k] ?? k, `ccat-${k}`, () => { craftUi.cat = k; kit.rerender(); }, { pressed: craftUi.cat === k, alt: craftUi.cat !== k }));
      const tools = el("div", { "data-role": "craft-tools" });
      const search = el("input", { type: "search", "data-key": "craft-search", "data-role": "craft-search", "aria-label": "Search recipes", placeholder: "Search…", enterkeyhint: "search" }); search.value = craftUi.q;
      search.oninput = () => { craftUi.q = search.value; kit.rerender(); };
      const counts = grid(); counts.dataset["tabs"] = "page"; counts.dataset["tabsLabel"] = "Amount"; counts.dataset["role"] = "craft-counts"; for (const n of [1, 5, 10]) counts.append(btn(`×${n}`, `count-${n}`, () => { castSel.count = n; kit.rerender(); }, { alt: castSel.count !== n, pressed: castSel.count === n }));
      tools.append(search, counts); out.push(tabs, tools);
      // Task 33: Recently Crafted — the last recipes this player finished, craftable first within the list.
      // Same queue action as the main grid (same count selector, same intent).
      const recent = recentCraftsView(c);
      if (recent.length) {
        out.push(heading("Recently Crafted"));
        const rg = grid(); rg.dataset["role"] = "recent-crafts";
        for (const r of recent) {
          const b = btn("", `recent-recipe-${r.id}`, () => { craftUi.sel = r.id; send(queueCraftIntent(r.id, castSel.count), `Queued ${r.output.name} ×${castSel.count}.`); }, { role: "recipe", alt: !!r.reason, data: { item: String(r.output.item), icon: gameplayDefsIcon(c, r.output.item), ...(craftUi.sel === r.id && { sel: "" }) } });
          b.append(el("span", { class: "nm" }, r.output.name)); if (r.output.count > 1) b.append(el("span", { class: "ct" }, `×${r.output.count}`));
          b.setAttribute("aria-label", `${r.output.name} ×${r.output.count}${r.reason ? `. ${r.reason.replace(/_/g, " ")}` : ""}`);
          const pick = (): void => { if (craftUi.sel !== r.id) { craftUi.sel = r.id; kit.rerender(); } }; b.onfocus = pick; b.onmouseenter = pick;
          rg.append(b);
        }
        out.push(rg);
      }
      const qq = craftUi.q.trim().toLowerCase();
      const shown = v.recipes.filter((r) => (craftUi.cat === "all" || catOf(r.output.item) === craftUi.cat) && (!qq || r.output.name.toLowerCase().includes(qq) || r.ingredients.some((i) => i.name.toLowerCase().includes(qq))));
      const g = grid(); g.dataset["role"] = "recipe-grid";
      const dupOut = new Set<number>(); { const seen = new Set<number>(); for (const r of v.recipes) { if (seen.has(r.output.item)) dupOut.add(r.output.item); seen.add(r.output.item); } }
      const why = (r: (typeof v.recipes)[number]): string => r.reason ? (r.reason === "no_station" && st ? "light it / move closer" : r.reason === "skill_locked" ? "🔒 learn this station in the skill tree" : r.reason === "recipe_locked" ? "🔒 learn it in the skill tree" : r.reason.replace(/_/g, " ")) : "";
      for (const r of shown) {
        // alternate recipes for the same item (e.g. Hoe from stone or bone) are told apart by their first distinct ingredient
        const alt = dupOut.has(r.output.item) ? ` (${recipeVariantLabel(r, v.recipes)})` : "";
        const b = btn("", `recipe-${r.id}`, () => { craftUi.sel = r.id; send(queueCraftIntent(r.id, castSel.count), `Queued ${r.output.name} ×${castSel.count}.`); }, { role: "recipe", alt: !!r.reason, data: { item: String(r.output.item), icon: gameplayDefsIcon(c, r.output.item), ...(craftUi.sel === r.id && { sel: "" }) } });
        b.append(el("span", { class: "nm" }, `${r.output.name}${alt}`)); if (r.output.count > 1) b.append(el("span", { class: "ct" }, `×${r.output.count}`));
        b.setAttribute("aria-label", `${r.output.name}${alt} ×${r.output.count}${r.reason ? `. ${why(r)}` : ""}`);
        const pick = (): void => { if (craftUi.sel !== r.id) { craftUi.sel = r.id; kit.rerender(); } }; b.onfocus = pick; b.onmouseenter = pick;
        g.append(b);
      }
      out.push(shown.length ? g : kit.para(qq ? `No recipe matches “${craftUi.q}”.` : "Nothing to craft here yet."));
      const r = v.recipes.find((x) => x.id === craftUi.sel) ?? shown[0];
      const det = el("section", { "data-role": "craft-details", "aria-live": "polite" });
      if (r) {
        det.append(el("p", { "data-role": "craft-name" }, `${r.output.name} ×${r.output.count} · ${r.seconds}s`));
        const ing = el("p", { "data-role": "craft-need" }); for (const i of r.ingredients) { const sp = el("span", { "data-have": i.have >= i.count * castSel.count ? "1" : "0" }, `${i.name} ${i.have}/${i.count * castSel.count}`); ing.append(sp, document.createTextNode(" ")); } det.append(ing);
        if (r.reason) det.append(el("p", { "data-role": "craft-why" }, why(r)));
      }
      out.push(det);
      return out;
    }
    case "build": {
      // ADR-224: data-derived category tabs (LB/RB) · tier tabs for structural pieces (LT/RT) · tile grid (icon, cost, lock) ·
      // one details pane for the focused / hovered tile. Choosing a tile (click / tap / pad A / Enter) closes the window and
      // enters placement at once (nothing is spent until the placement is confirmed; B / Esc there comes back here).
      const all = buildView(c); if (!buildSel.piece && all[0]) buildSel.piece = all[0].id;
      // ADR-229: Art's items_build icon on the tile (::before) instead of the glyph; white cloth icons get the clan palette
      // (the selected paint, else the player's clan, else palette 1) as a multiply tint masked to the icon's alpha.
      const tintIdx = buildSel.paint || clanTintIndex(c.world.isRegistered(Membership) ? c.world.getField(c.player, Membership, "clanId") ?? 0 : 0);
      const tintCss = ((): string | undefined => { const rgb = src.clanTint?.(tintIdx) ?? src.clanTint?.(1); /* ADR-230: registry.clanPaletteForTint (building manifest clanPalettes) */ return rgb === undefined ? undefined : hex6(rgb); })();
      const iconize = <T extends HTMLElement>(b: T, key: string | undefined, tinted = false): T => {
        if (!key) return b; b.dataset["icon"] = key; b.dataset["bicon"] = "1";
        if (tinted && tintCss) { b.dataset["tint"] = "clan"; b.style.setProperty("--bt", tintCss); }
        return b;
      };
      // ADR-288: keep Furniture beside Structure, including on the phone's scrolling tab strip.
      const wt = src.worldTools; const cats = [...new Set(all.map((p) => p.category))];
      const furnitureIndex = cats.indexOf("furniture");
      if (furnitureIndex >= 0) { cats.splice(furnitureIndex, 1); cats.splice(cats.indexOf("structure") + 1, 0, "furniture"); }
      if (wt) cats.push("roads");
      if (!cats.includes(buildCat)) buildCat = all.find((p) => p.id === buildSel.piece)?.category ?? cats[0] ?? "structure";
      const v = all.filter((p) => p.category === buildCat);
      // Useful furniture first: crop plots, wardrobes, then containers, before the seating/decorative furniture.
      // Stable within each job; only the menu order changes, never the selected piece or placement path.
      if (buildCat === "furniture") {
        const defs = gameplayDefs(c.world);
        const rank = (p: (typeof v)[number]): number => {
          const d = defs.pieces.get(p.id)!;
          return d.features.planter ? 0 : d.features.wardrobe ? 1 : d.container ? 2 : 3;
        };
        v.sort((a, b) => rank(a) - rank(b));
      }
      // ADR-302: property claim flag lives with the stations; keep it first so it is easy to find.
      if (buildCat === "crafting") v.sort((a, b) => Number(b.key === "claim_totem") - Number(a.key === "claim_totem"));
      if (!v.some((p) => p.id === buildSel.piece) && v[0]) { buildSel.piece = v[0].id; buildSel.variant = 0; }
      const out: Node[] = []; const cg0 = grid(); cg0.dataset["role"] = "build-cats"; cg0.dataset["tabs"] = "tab";
      const BUILD_CAT_LABEL: Record<string, string> = { crafting: "Hand Crafted" };
      for (const k of cats) cg0.append(btn(BUILD_CAT_LABEL[k] ?? (k[0]!.toUpperCase() + k.slice(1)), `bcat-${k}`, () => { buildCat = k; kit.rerender(); }, { pressed: k === buildCat, alt: k !== buildCat }));
      out.push(cg0);
      if (src.startDemolish) { // ADR-316: demolish / move placed pieces without picking a piece first (no hologram)
        const dg = grid(); dg.dataset["role"] = "build-edit"; const start = src.startDemolish;
        dg.append(btn("Demolish / Move", "build-demolish", () => { start(); kit.close(); }, { alt: true })); out.push(dg);
      }
      if (buildCat === "roads" && wt) {
        // ADR-224: roads & signs are a tab of their own (keeps the piece view short)
        const rg = grid(); rg.dataset["role"] = "world-tools"; const signIcon = hasIcon(SIGN_TOOL_ICON) ? SIGN_TOOL_ICON : undefined;
        wt.surfaces.forEach((name, i) => { const sk = ROADS.surfaces[i]?.key; rg.append(iconize(btn(`Lay ${name.toLowerCase()} (G)`, `road-${i + 1}`, () => { wt.road(i + 1); kit.close(); }, { pressed: wt.roadSurface() === i + 1, alt: wt.roadSurface() !== i + 1 }), sk && hasIcon(roadIconKey(sk)) ? roadIconKey(sk) : undefined)); });
        if (wt.roadSurface()) rg.append(btn("Road tool off", "road-0", () => { wt.road(0); kit.rerender(); }, { alt: true }));
        rg.append(iconize(btn("Place sign (N)", "sign-place", () => { if (wt.placeSign()) { kit.status("Sign placed — choose Edit nearest sign to write on it."); } else kit.status("You need a sign item (craft one first)."); }), signIcon));
        rg.append(iconize(btn("Edit nearest sign", "sign-edit", () => { kit.close(); if (!wt.editNearestSign()) kit.status("No sign within reach."); }), signIcon));
        out.push(rg, kit.para("Roads: drag (mouse) · drag then ✓ (touch) · right stick + A (gamepad)."));
        return out;
      }
      const tiered = v.find((p) => p.tiers.length > 1);
      if (tiered) {
        if (!tiered.tiers.some((x) => x.tier === buildSel.tier)) buildSel.tier = tiered.tiers[0]!.tier;
        const tg = grid(); tg.dataset["role"] = "build-tiers"; tg.dataset["tabs"] = "page";
        for (const t of tiered.tiers) tg.append(btn(`${t.locked ? "🔒 " : ""}${t.key}`, `tier-${t.tier}`, () => { buildSel.tier = t.tier; src.onBuildSelect?.({ ...buildSel }); kit.rerender(); }, { pressed: t.tier === buildSel.tier, alt: t.tier !== buildSel.tier, ...(t.locked ? { data: { locked: "1" } } : {}) }));
        out.push(tg);
      }
      const tierOf = (p: (typeof all)[number]) => p.tiers.find((x) => x.tier === buildSel.tier) ?? p.tiers[0]!;
      const choose = (p: (typeof all)[number]): void => {
        if (buildSel.piece !== p.id) buildSel.variant = 0; buildSel.piece = p.id; const t = tierOf(p); buildSel.tier = t.tier; src.onBuildSelect?.({ ...buildSel });
        if (t.locked) { kit.status(`🔒 ${t.requirement ?? "Locked"} — open the Skills panel to learn it.`); kit.rerender(); return; }
        if (!t.affordable) { kit.status(`Need ${t.cost.filter((x) => x.have < x.count).map((x) => `${x.name} ${x.have}/${x.count}`).join(", ")}.`); kit.rerender(); return; }
        if (!src.startPlacing) { kit.status("Placement unavailable."); return; }
        src.startPlacing({ ...buildSel }); kit.close();
      };
      const focusPiece = (id: number): void => { if (buildSel.piece === id) return; buildSel.piece = id; buildSel.variant = 0; src.onBuildSelect?.({ ...buildSel }); kit.rerender(); };
      // Task 33: Recently Crafted — the last pieces this player placed, in recency order. Same choose flow
      // as the main grid (same snapping, validation and cost).
      const recentPieces = recentBuildsView(c);
      if (recentPieces.length) {
        out.push(heading("Recently Crafted"));
        const rg = grid(); rg.dataset["role"] = "recent-builds";
        for (const p of recentPieces) {
          const t = tierOf(p); const lk = t.locked; const name = p.key.replace(/_/g, " ");
          const costTxt = t.cost.map((x) => `${x.count} ${x.name}`).join(" · ") || "free";
          const b = btn("", `recent-piece-${p.id}`, () => choose(p), { role: "piece", pressed: p.id === buildSel.piece, alt: !t.affordable || lk,
            data: { padLabel: lk ? "Locked" : t.affordable ? "Place" : "Can't afford", glyph: pieceGlyph(p.key), ...(lk ? { locked: "1" } : {}), ...(!t.affordable ? { short: "1" } : {}) } });
          iconize(b, buildIconKey(p.key, t.tier, p.tiers.length > 1), isClanTintedIcon(p.key));
          const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = name;
          const ct = document.createElement("span"); ct.className = "ct"; ct.textContent = lk ? "Locked" : costTxt;
          b.append(nm, ct); b.setAttribute("aria-label", `${name}, ${lk ? (t.requirement ?? "locked") : t.affordable ? costTxt : `need ${costTxt}`}`);
          b.addEventListener("focus", () => focusPiece(p.id)); b.addEventListener("mouseenter", () => focusPiece(p.id));
          rg.append(b);
        }
        out.push(rg);
      }
      const g = grid(); g.dataset["role"] = "piece-grid";
      for (const p of v) {
        const t = tierOf(p); const lk = t.locked; const name = p.key.replace(/_/g, " ");
        const costTxt = t.cost.map((x) => `${x.count} ${x.name}`).join(" · ") || "free";
        const b = btn("", `piece-${p.id}`, () => choose(p), { role: "piece", pressed: p.id === buildSel.piece, alt: !t.affordable || lk,
          data: { padLabel: lk ? "Locked" : t.affordable ? "Place" : "Can't afford", glyph: pieceGlyph(p.key), ...(lk ? { locked: "1" } : {}), ...(!t.affordable ? { short: "1" } : {}) } });
        iconize(b, buildIconKey(p.key, t.tier, p.tiers.length > 1), isClanTintedIcon(p.key));
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = name;
        const ct = document.createElement("span"); ct.className = "ct"; ct.textContent = lk ? "Locked" : costTxt;
        b.append(nm, ct); b.setAttribute("aria-label", `${name}, ${lk ? (t.requirement ?? "locked") : t.affordable ? costTxt : `need ${costTxt}`}`);
        b.addEventListener("focus", () => focusPiece(p.id)); b.addEventListener("mouseenter", () => focusPiece(p.id));
        g.append(b);
      }
      out.push(g);
      const sel = all.find((p) => p.id === buildSel.piece);
      if (sel) {
        const t = tierOf(sel); const d = document.createElement("section"); d.dataset["role"] = "build-details";
        const h = document.createElement("p"); h.dataset["role"] = "build-name"; h.textContent = `${sel.key.replace(/_/g, " ")}${sel.tiers.length > 1 ? ` · ${t.key}` : ""}`; d.append(h);
        const need = document.createElement("p"); need.dataset["role"] = "build-cost";
        if (!t.cost.length) need.textContent = "Free"; else for (const x of t.cost) { const sp = document.createElement("span"); sp.dataset["have"] = x.have >= x.count ? "1" : "0"; sp.textContent = `${x.name} ${x.have}/${x.count}`; need.append(sp); }
        d.append(need);
        // ADR-221: locked tier / station — the requirement stays visible in the pane (no hover tooltip to clip)
        if (t.locked) { const lp = document.createElement("p"); lp.dataset["role"] = "build-locked"; lp.textContent = `🔒 ${t.requirement ?? "Locked"} — open the Skills panel to learn it.`; d.append(lp); }
        else { const hp = document.createElement("p"); hp.dataset["role"] = "build-hint"; hp.textContent = t.affordable ? "Choose to place · aim, rotate, confirm · Back returns here" : "Not enough materials"; d.append(hp); }
        // Task 25: the variants grid is always mounted (hidden when the piece has no variants) so the tint row
        // below it keeps a stable position — morph reconciles children positionally, and a variants grid that
        // appears/disappears above the tint row used to replace the focused tint-0 button with a variant button.
        const vg = grid(); vg.dataset["role"] = "build-variants"; if (sel.variants.length <= 1) vg.style.display = "none";
        sel.variants.forEach((n, i) => vg.append(btn(n, `variant-${i}`, () => { buildSel.variant = i; src.onBuildSelect?.({ ...buildSel }); kit.rerender(); }, { pressed: i === buildSel.variant, alt: i !== buildSel.variant }))); d.append(vg);
        // Task 25: tint row for paintable AND tiered pieces (tiers.length > 1 ⟺ p.tiered, which the server paints);
        // all clan palettes, probed until the registry runs out (16 today), with real primary/secondary swatches.
        if (sel.paintable || sel.tiers.length > 1) { const pg = grid(); pg.dataset["role"] = "build-tints";
          pg.append(btn("Clan / none", "tint-0", () => { buildSel.paint = 0; src.onBuildSelect?.({ ...buildSel }); kit.rerender(); }, { pressed: buildSel.paint === 0, alt: buildSel.paint !== 0 }));
          for (let i = 1; i <= 32; i++) { const c1 = src.clanTint?.(i); if (c1 === undefined) break; const c2 = src.clanTint2?.(i);
            const b = btn(`Tint ${i}`, `tint-${i}`, () => { buildSel.paint = i; src.onBuildSelect?.({ ...buildSel }); kit.rerender(); }, { pressed: buildSel.paint === i, alt: buildSel.paint !== i, data: { swatch: hex6(c1) } });
            b.style.setProperty("--cz-sw", hex6(c1)); b.style.setProperty("--cz-sw2", c2 !== undefined ? hex6(c2) : "#F6EAD2"); pg.append(b); }
          const tgt = paintTarget(c); const dv = dyeView(c);
          // Task 25: painting costs one dye and needs a paint brush in the hotbar (clearing to Clan/none is free).
          const canPaint = tgt !== undefined && (buildSel.paint === 0 || (dv.brush && dv.dye > 0));
          const paintHint = tgt === undefined ? "No paintable piece nearby" : buildSel.paint === 0 ? "Clearing paint is free" : !dv.brush ? "Needs a paint brush in your hotbar" : dv.dye <= 0 ? "Needs dye — craft from 3 berries" : "";
          pg.append(btn("Paint nearest", "paint-apply", () => { if (tgt !== undefined) send(paintIntent(tgt, buildSel.paint), "Painted."); }, { disabled: !canPaint, ...(paintHint ? { title: paintHint } : {}) })); d.append(pg);
          if (paintHint) { const pp = document.createElement("p"); pp.dataset["role"] = "build-paint-hint"; pp.textContent = paintHint; d.append(pp); } }
        out.push(d);
      }
      return out;
    }
    case "character": {
      const out: Node[] = [];
      // Task 23: live character sheet — body temperature, vitals, diseases, experience,
      // insulation and shelter. The panel refreshes 4x/s while open, so these numbers track the player.
      const sheet = characterSheetView(c);
      if (sheet) {
        const unit = loadTempUnit();
        const row = (label: string, text: string, role: string): HTMLElement => { const p = kit.para(`${label}: ${text}`); p.dataset["role"] = role; return p; };
        out.push(heading(`Character sheet — ${sheet.name || "Survivor"}`));
        out.push(row("Body temperature", formatBodyTemp(sheet.bodyTempC, unit), "sheet-body-temp"));
        out.push(row("Health", `${Math.round(sheet.health)}/${Math.round(sheet.maxHealth)}`, "sheet-health"));
        out.push(row("Food", `${Math.round(sheet.hunger)}/100`, "sheet-hunger"));
        out.push(row("Water", `${Math.round(sheet.thirst)}/100`, "sheet-thirst"));
        out.push(row("Energy", `${Math.round(sheet.stamina)}/${Math.round(sheet.maxStamina)}`, "sheet-stamina"));
        out.push(row("Experience", `Level ${sheet.level} · ${sheet.xp}/${sheet.xpNext} XP`, "sheet-xp"));
        const disRow = row("Diseases", sheet.diseases.length ? sheet.diseases.map((d) => d.name).join(", ") : "Healthy", "sheet-diseases");
        if (sheet.diseases.length) { // Task 31: one custom sprite per disease, in front of its name
          disRow.textContent = "Diseases: ";
          for (const d of sheet.diseases) { disRow.append(conditionIconImg(d.icon, 14, d.name)); disRow.append(` ${d.name} `); }
        }
        out.push(disRow);
        // Task 31: wet clothing insulates less — the sheet shows the effective total while wet
        out.push(row("Insulation", sheet.wetness > 0.05
          ? `Base ${formatTempDelta(sheet.insulationBase, unit)} + clothing ${formatTempDelta(sheet.insulationClothing, unit)} (${formatTempDelta(sheet.insulationWet, unit)} while wet)`
          : `Base ${formatTempDelta(sheet.insulationBase, unit)} + clothing ${formatTempDelta(sheet.insulationClothing, unit)}`, "sheet-insulation"));
        // Task 31: how long until dry (only while wet), and how long until the care cure (only while sick)
        const stage = wetnessStage(sheet.wetness);
        if (stage) {
          const wetRow = row(stage[0]!.toUpperCase() + stage.slice(1), sheet.drySeconds !== undefined
            ? `${Math.round(sheet.wetness * 100)}% · dry in ~${fmtDur(sheet.drySeconds)}${sheet.dryByFire ? " by the fire" : ""}`
            : `${Math.round(sheet.wetness * 100)}% · get out of the rain to dry`, "sheet-wetness");
          wetRow.prepend(conditionIconImg(stage, 14, stage)); out.push(wetRow);
        }
        if (sheet.careSecondsLeft !== undefined) {
          const careRow = row("Cure", `in ~${fmtDur(sheet.careSecondsLeft)}${sheet.careMissing.length ? ` — still needs: ${sheet.careMissing.map((m) => CARE_NEED_LABEL[m] ?? m).join(", ")}` : " — keep it up"}`, "sheet-care");
          const first = sheet.diseases[0]; if (first) careRow.prepend(conditionIconImg(first.icon, 14, first.name));
          out.push(careRow);
        }
        if (sheet.worn.length) for (const it of sheet.worn) out.push(row(it.slot, `${it.name} · +${formatTempDelta(it.insulation, unit)}`, "sheet-worn"));
        else out.push(row("Worn", "Nothing — craft clothing to stay warm and dry", "sheet-worn"));
        out.push(row(sheet.enclosed ? "Indoors" : sheet.sheltered ? "Sheltered" : "Outside",
          `${formatTemp(sheet.indoorC, unit)}${sheet.sheltered ? ` (outside ${formatTemp(sheet.ambientC, unit)})` : ""} · ${sheet.seasonName}`, "sheet-shelter"));
      }
      return out;
    }
    case "wardrobe": {
      // Task 31: the wardrobe lives in its own panel now — the Character panel is details only (sheet above).
      const v = wardrobeView(c); const out: Node[] = [];
      out.push(kit.para(v.canEdit ? (v.created ? "At a wardrobe: change your look." : "Create your character.") : "Stand near a wardrobe to change your look."));
      const sg = grid(); for (const s of v.slots) sg.append(btn(`${s.key}${s.equipped ? "" : " (none)"}`, `wslot-${s.slot}`, () => { wardrobeSlot = s.slot; kit.rerender(); }, { pressed: s.slot === wardrobeSlot, alt: s.slot !== wardrobeSlot }));
      out.push(heading("Slot"), sg);
      const cur = v.slots[wardrobeSlot]!; const cg = grid();
      const cat = c.catalog; const slotKey = cur.key as WearableSlot;
      // eyes offer the creator's curated eye list (clothingColors indices); other slots the whole slot palette
      const choices = cat ? colorChoices(cat, slotKey) : Array.from({ length: cur.key === "hair" || cur.key === "face" ? v.palettes.hair : v.palettes.clothing }, (_, i) => i);
      cg.append(btn("Remove", "unequip", () => send(equipCosmeticIntent(cur.slot, 0), "Removed."), { alt: true, disabled: !v.canEdit || !cur.equipped }));
      for (const i of choices) cg.append(btn(`Colour ${i + 1}`, `color-${i}`, () => send(equipCosmeticIntent(cur.slot, cur.equipped, i, cur.secondary), "Colour set."), { disabled: !v.canEdit || !cur.equipped, pressed: cur.primary === i }));
      out.push(heading(`${cur.key}: colour`), cg);
      const w2 = cur.equipped && cat ? cat.wearable(cur.equipped) : undefined; // G (secondary) row only when the worn piece tints G (tintChannels 2)
      if (w2 && (w2.tintChannels >= 2 || (w2.layers ?? []).some((l) => l.tintChannels >= 2))) {
        const pal2 = SLOT_PALETTE[slotKey] === "hairColors" ? cat!.hairColors : cat!.clothingColors; const g2 = grid();
        pal2.forEach((pc, i) => { const b = btn(`Secondary ${i + 1}`, `color2-${i}`, () => send(equipCosmeticIntent(cur.slot, cur.equipped, cur.primary, i), "Colour set."), { disabled: !v.canEdit, pressed: cur.secondary === i, alt: cur.secondary !== i, data: { swatch: `#${(pc.color & 0xffffff).toString(16).padStart(6, "0")}` } }); b.style.setProperty("--cz-sw", b.dataset["swatch"]!); g2.append(b); });
        out.push(heading(`${cur.key}: secondary colour`), g2);
      }
      // skin keeps the current body type (a hard-coded male body made female looks fail validation / swap body)
      if (v.palettes.skin) { const kg = grid(); for (let i = 0; i < v.palettes.skin; i++) { const t = c.catalog?.skinTones[i]; const sw = swatchColor(t); // ADR-245: tone name + ramp.base swatch
        const sb = btn(t ? t.key.replace(/_/g, " ") : `Skin ${i + 1}`, `skin-${i}`, () => { const a = v.slots; send(setAppearanceIntent({ bodyType: v.bodyType, skinTone: i, parts: a.map((s) => s.equipped), primary: a.map((s) => s.primary), secondary: a.map((s) => s.secondary) }), "Look saved."); }, { disabled: !v.canEdit, pressed: v.skinTone === i, ...(sw !== undefined ? { data: { swatch: `#${(sw & 0xffffff).toString(16).padStart(6, "0")}` } } : {}) });
        if (sw !== undefined) sb.style.setProperty("--cz-sw", sb.dataset["swatch"]!); kg.append(sb); } out.push(heading("Skin tone"), kg); }
      out.push(heading("Dye"));
      const dv = dyeView(c);
      const dstatus = kit.para(dv.brush ? (dv.dye > 0 ? `Paint brush ready · ${dv.dye} dye` : "Paint brush ready · no dye — craft dye from 3 berries") : "You need a paint brush in your hotbar to dye anything.");
      dstatus.dataset["role"] = "dye-status"; out.push(dstatus);
      const dyeGrid = (pal: { index: number; key: string; color: number }[], kind: number, slot: number, palette: number, cur: number | undefined, can: boolean): HTMLElement => {
        const g = grid();
        pal.forEach((pc, i) => { const b = btn(`Dye ${i + 1}`, `dye-${kind}-${slot}-${i}`, () => send(dyeIntent(kind, slot, palette, i), "Dyed."), { disabled: !can, pressed: cur === i, data: { swatch: `#${(pc.color & 0xffffff).toString(16).padStart(6, "0")}` } }); b.style.setProperty("--cz-sw", b.dataset["swatch"]!); g.append(b); });
        return g;
      };
      const canDye = dv.brush && dv.dye > 0;
      if (dv.hair) {
        out.push(heading("Hair dye"));
        if (!dv.hair.equipped) out.push(kit.para("Equip a hairstyle first."));
        else out.push(dyeGrid(dv.hairPalette, dv.hair.kind, dv.hair.slot, dv.hair.palette, dv.hair.primary, canDye));
      }
      for (const t of dv.worn) {
        out.push(heading(`${t.key} dye`));
        out.push(dyeGrid(t.palette === 0 ? dv.hairPalette : dv.clothingPalette, t.kind, t.slot, t.palette, t.primary, canDye));
      }
      if (dv.held) {
        out.push(heading(`Held: ${dv.held.name} dye`));
        const hg = grid();
        dv.clothingPalette.forEach((pc, i) => { const b = btn(`Dye ${i + 1}`, `dye-2-${dv.held!.slot}-${i}`, () => send(dyeIntent(2, dv.held!.slot, 1, i), "Dyed."), { disabled: !canDye, pressed: dv.held!.color !== 0 && dv.held!.color === pc.color, data: { swatch: `#${(pc.color & 0xffffff).toString(16).padStart(6, "0")}` } }); b.style.setProperty("--cz-sw", b.dataset["swatch"]!); hg.append(b); });
        out.push(hg);
      } else out.push(kit.para("Hold a tool or weapon to dye it."));
      out.push(heading("Unlocks")); const ug = el("div", { "data-role": "unlocks" });
      for (const u of v.unlocks) { const p = kit.para(u.tag.replace(/_/g, " ")); p.dataset["role"] = "unlock"; p.dataset["key"] = u.tag; if (u.unlocked) p.dataset["unlocked"] = ""; ug.append(p); }
      out.push(ug);
      const eg = grid(); eg.append(btn("Edit character (next start)", "edit-character", () => { requestCharacterEdit(); kit.status("The character creator opens next time you enter a world."); }, { alt: true })); out.push(eg);
      return out;
    }
    case "skills": {
      const v = progressionView(c.world, c.player); if (!v) return [kit.para("No skills for this character.")];
      const out: Node[] = [];
      // ADR-209: each tree has its own level / XP / points; the summary + bar below show the selected tab's tree
      const cats = v.categories; const ci = Math.max(0, cats.findIndex((c) => c.key === skillUi.cat)); const cat = cats[ci]!; skillUi.cat = cat.key;
      const head = kit.para(`${cat.name} · Level ${cat.level} · ${cat.maxed ? "max level" : `XP ${cat.xp}/${cat.next}`} · ${cat.points} point${cat.points === 1 ? "" : "s"} to spend here`);
      head.dataset["role"] = "skill-summary"; head.dataset["category"] = cat.key; out.push(head);
      const bar = el("div", { "data-role": "skill-xpbar", role: "progressbar", "aria-label": `${cat.name} XP`, "aria-valuemin": "0", "aria-valuemax": String(cat.next), "aria-valuenow": String(cat.xp) });
      const pct = cat.maxed ? 100 : Math.min(100, (100 * cat.xp) / Math.max(1, cat.next)); const fill = el("div"); fill.setAttribute("style", `height:100%;width:${pct.toFixed(1)}%;background:#5A9A4A;border-radius:6px`);
      bar.setAttribute("style", "height:10px;margin:2px 0 6px;border:2px solid #74432C;border-radius:8px;background:#EAD9B8;overflow:hidden"); bar.append(fill); out.push(bar);
      const tools = grid();
      tools.append(btn("Zoom −", "skill-zoom-out", () => { zoomSkills(-SKILL_ZOOM.step); kit.rerender(); }, { alt: true }), btn("Zoom +", "skill-zoom-in", () => { zoomSkills(SKILL_ZOOM.step); kit.rerender(); }, { alt: true }));
      tools.append(btn(`Respec (${v.respecCost} coin)`, "skill-respec", () => send(respecSkillsIntent(), "Skills reset."), { alt: true, disabled: v.canRespec !== undefined, title: v.canRespec ? SKILL_REJECT_TEXT[v.canRespec] : "Refund all skill points" }));
      tools.append(btn("Back", "skill-back", () => kit.close(), { alt: true }));
      out.push(tools);
      // ADR-132/206 category tabs: one tree per tab with its own level + unspent points. Buttons = touch / keyboard (Tab/Enter) / gamepad (focus+A).
      const go = (d: number): void => { pageSkillCategory(d); kit.rerender(); };
      const tabs = el("div", { class: "gm-grid", "data-role": "skill-tabs", role: "tablist" });
      tabs.append(btn("◀", "skill-tab-prev", () => go(-1), { alt: true, title: "Previous tree (PgUp / LB)" }));
      for (const c of cats) { const t = btn(`${treeShortName(treeIndex(c.key))} · Lv ${c.level}${c.points ? ` · ${c.points} pt${c.points === 1 ? "" : "s"}` : ""}`, `skill-tab-${c.key}`, () => { selectSkillCategory(c.key); kit.rerender(); }, { alt: c.key !== cat.key, pressed: c.key === cat.key, title: `${c.name}: ${c.owned}/${c.nodes.length} learned`, data: { icon: c.icon, category: c.key, level: String(c.level), points: String(c.points) } }); t.setAttribute("role", "tab"); t.setAttribute("aria-selected", String(c.key === cat.key)); t.style.minHeight = "44px"; tabs.append(t); }
      tabs.append(btn("▶", "skill-tab-next", () => go(1), { alt: true, title: "Next tree (PgDn / RB)" }));
      tabs.setAttribute("style", "display:flex;flex-wrap:nowrap;overflow-x:auto;gap:6px;-webkit-overflow-scrolling:touch;touch-action:pan-x");
      for (const t of Array.from(tabs.children) as HTMLElement[]) t.style.flex = "0 0 auto";
      out.push(tabs); queueMicrotask(() => (tabs.querySelector("[aria-selected=true]") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
      const z = skillUi.zoom; const vp = el("div", { "data-role": "skill-tree", class: "skill-tree", "data-category": cat.key });
      vp.setAttribute("style", "position:relative;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;height:clamp(150px,calc(100dvh - 470px),420px);border:2px solid #74432C;border-radius:10px;background:#EAD9B8");
      const inner = el("div"); inner.setAttribute("style", `position:relative;width:${Math.ceil(cat.width * z)}px;height:${Math.ceil(cat.height * z)}px`);
      const ns = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(ns, "svg"); svg.setAttribute("width", String(Math.ceil(cat.width * z))); svg.setAttribute("height", String(Math.ceil(cat.height * z)));
      svg.setAttribute("style", "position:absolute;left:0;top:0;pointer-events:none"); const W = 150, H = 56;
      const shown = cat.nodes.map((i) => v.nodes[i]!);
      for (const n of shown) for (const r of n.requires) { const p = v.nodes[r]!; const l = document.createElementNS(ns, "line");
        l.setAttribute("x1", String((p.cx + W / 2) * z)); l.setAttribute("y1", String((p.cy + H) * z)); l.setAttribute("x2", String((n.cx + W / 2) * z)); l.setAttribute("y2", String(n.cy * z));
        l.setAttribute("stroke", n.state === "owned" ? "#5A9A4A" : "#9C7A5A"); l.setAttribute("stroke-width", "2"); svg.append(l); }
      inner.append(svg);
      // ADR-219: one description panel (above the tree, never inside its clipped viewport) shows the focused / hovered /
      // selected skill: generated effect lines with values, rank, cost and state. Updates in place on focus (D-pad, Tab),
      // hover and tap, wraps freely and has no fixed height, so nothing is cut off at any resolution.
      const descEl = el("div", { "data-role": "skill-desc", id: "skill-desc", role: "region", "aria-live": "polite", "aria-label": "Skill description" });
      descEl.setAttribute("style", "box-sizing:border-box;min-height:6.2em;margin:0 0 6px;padding:6px 10px;border:2px solid #74432C;border-radius:10px;background:#F6ECD6;color:#432C24;font-size:14px;line-height:1.3;white-space:normal;overflow-wrap:anywhere;word-break:normal;overflow:visible");
      // Handlers are property handlers (morph copies them onto reused elements) and resolve the live panel from the DOM,
      // because a re-render morphs into the existing tree and keeps the first-built elements.
      const liveDesc = (from: Element | null): HTMLElement => from?.closest("[data-role=skill-view]")?.querySelector<HTMLElement>("[data-role=skill-desc]") ?? descEl;
      const showDesc = (n: typeof shown[number] | undefined, desc: HTMLElement = descEl): void => {
        desc.replaceChildren(); desc.dataset["key"] = n?.key ?? "";
        if (!n) { const h = el("p", {}, "Move to a skill (D-pad / Tab / hover / tap) to see what it does."); h.setAttribute("style", "margin:0"); desc.append(h); return; }
        const t = el("p", { "data-role": "skill-desc-title" }, `${n.name} · cost ${n.cost}${n.info.rank ? ` · Rank ${n.info.rank.n}/${n.info.rank.of}` : ""}`); t.setAttribute("style", "margin:0 0 2px;font-weight:700");
        const ul = el("ul", { "data-role": "skill-desc-effects" }); ul.setAttribute("style", "margin:0;padding-left:1.1em");
        for (const line of n.info.effects) ul.append(el("li", {}, line));
        if (n.info.rank && n.info.rank.n > 1 && n.info.rank.text.includes("total")) ul.append(el("li", { "data-role": "skill-desc-rank" }, n.info.rank.text.replace(/^Rank \d+ of \d+ · /, "")));
        if (n.info.note) ul.append(el("li", { "data-role": "skill-desc-note" }, n.info.note));
        const st = el("p", { "data-role": "skill-detail" }, n.state === "owned" ? "Learned." : n.why ? SKILL_REJECT_TEXT[n.why] : skillUi.sel === n.index ? "Press A / tap again to learn." : "Press A / tap to select, again to learn.");
        st.setAttribute("style", `margin:2px 0 0;font-weight:600;color:${n.state === "owned" ? "#3F7A32" : n.why ? "#9A3B2A" : "#432C24"}`);
        desc.append(t, ul, st);
      };
      for (const n of shown) {
        const b = btn(`${n.name} (${n.cost})`, `skill-${n.key}`, () => {
          if (skillUi.sel !== n.index) { skillUi.sel = n.index; kit.rerender(); return; } // first tap/A selects (shows details), second learns
          if (n.state === "owned") return; if (n.why) { kit.status(SKILL_REJECT_TEXT[n.why]); kit.rerender(); return; }
          send(unlockSkillIntent(n.index), `Learned ${n.name}.`);
        }, { role: "skill-node", alt: n.state !== "owned", disabled: false, pressed: skillUi.sel === n.index, data: { icon: n.icon, branch: n.branch, category: n.category, state: n.state, tier: String(n.tier) } });
        b.setAttribute("aria-describedby", "skill-desc"); b.setAttribute("aria-label", `${n.name}, cost ${n.cost}. ${n.info.text}`);
        b.setAttribute("style", `position:absolute;left:${Math.round(n.cx * z)}px;top:${Math.round(n.cy * z)}px;width:${Math.round(W * z)}px;min-height:44px;font-size:${Math.max(11, Math.round(14 * z))}px;line-height:1.15;padding:2px 4px;white-space:normal;overflow-wrap:anywhere;${n.state === "locked" ? "opacity:.55;" : ""}`);
        b.onmouseenter = (ev) => { skillUi.peek = n.index; showDesc(n, liveDesc(ev.currentTarget as Element)); };
        b.onfocus = (ev) => { const t = ev.currentTarget as HTMLElement; skillUi.peek = n.index; showDesc(n, liveDesc(t)); queueMicrotask(() => {
          const tv = t.closest<HTMLElement>("[data-role=skill-tree]"); if (tv) revealIn(tv, t); t.closest("[data-role=skill-view]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); revealAboveFooter(t); }); };
        inner.append(b);
      }
      vp.append(inner);
      vp.addEventListener("wheel", (ev) => { if (!ev.ctrlKey) return; ev.preventDefault(); zoomSkills(ev.deltaY < 0 ? SKILL_ZOOM.step : -SKILL_ZOOM.step); kit.rerender(); }, { passive: false });
      vp.onmouseleave = (ev) => { const k = (document.activeElement as HTMLElement | null)?.dataset?.["key"]; const f2 = shown.find((n) => `skill-${n.key}` === k); skillUi.peek = f2?.index ?? -1; showDesc(f2 ?? v.nodes[skillUi.sel], liveDesc(ev.currentTarget as Element)); };
      const inCat = (i: number) => v.nodes[i]?.category === cat.key ? v.nodes[i] : undefined; showDesc(inCat(skillUi.peek) ?? inCat(skillUi.sel));
      const wrap = el("div", { "data-role": "skill-view" }); wrap.append(descEl, vp); out.push(wrap);
      out.push(kit.para("Pick a tree tab (◀ ▶, PgUp/PgDn or LB/RB) · scroll or drag to pan · Ctrl+wheel or Zoom ± to zoom · select a skill, then select again to learn. Each tree levels from its own activities and its points only buy skills in that tree."));
      return out;
    }
    case "party": {
      const v = partyView(c); const out: Node[] = [];
      if (v.invite) { const inv = v.invite; out.push(kit.para(`${inv.fromName} invited you (${inv.secondsLeft}s).`)); const g = grid(); g.append(btn("Accept", "party-accept", () => send(partyAcceptIntent(inv.party), "Joined party.")), btn("Decline", "party-decline", () => send(partyDeclineIntent(inv.party), "Declined."), { alt: true })); out.push(g); }
      out.push(heading(v.party ? `Party (${v.members.length}/${v.maxSize})` : "Not in a party"));
      if (v.party) { const g = grid(); for (const m of v.members) g.append(m.entity === c.player ? kit.para(`${m.name} (you)`) : !v.canKick(m) ? kit.para(m.name) : btn(`Kick ${m.name}`, `kick-${m.playerId}`, () => send(partyKickIntent(m.entity), `Kicked ${m.name}.`), { alt: true, role: "member", data: { rank: "member" } })); out.push(g); const l = grid(); l.append(btn("Leave party", "party-leave", () => send(partyLeaveIntent(), "Left party."), { alt: true })); out.push(l); }
      if (!v.canInvite) return out; // only leaders/officers may invite (PARTY_RULES; ADR-141)
      const pc = onlineTargets(c, src.social, new Set(v.members.map((m) => m.playerId)));
      out.push(heading("Invite")); if (!pc.length) out.push(kit.para("Nobody online nearby."));
      const ig = grid(); for (const p of pc.slice(0, 16)) { const e = p.entity; ig.append(btn(`Invite ${p.name}`, `invite-${p.playerId}`, () => { if (e !== undefined) send(partyInviteIntent(e), `Invited ${p.name}.`); }, { disabled: e === undefined, title: p.distance !== undefined ? `${Math.round(p.distance)} m` : "online, not nearby" })); } out.push(ig);
      return out;
    }
    case "clan": {
      const v = clanView(c); const out: Node[] = [];
      if (v.invite && !dismissedClan.has(v.invite.clan)) { const inv = v.invite; out.push(kit.para(`${inv.fromName} invited you to a clan (${inv.secondsLeft}s).`)); const g = grid(); g.append(btn("Accept", "clan-accept", () => send(clanAcceptIntent(inv.clan), "Joined clan.")), btn("Dismiss", "clan-dismiss", () => { dismissedClan.add(inv.clan); send(clanDeclineIntent(inv.clan), "Declined."); }, { alt: true })); out.push(g); }
      if (!v.clan) { const g = grid(); g.append(btn("Create clan", "clan-create", () => send(clanCreateIntent(), "Clan created."))); out.push(kit.para("Not in a clan."), g); return out; }
      const lead = v.role === GroupRole.Leader; const permOn = (perm: string): boolean => lead || !!v.perms.find((r) => r.role === v.role)?.perms.find((p) => p.perm === perm)?.on; const kickPerm = permOn("kick");
      out.push(kit.para(`${v.roleName} · goal: ${v.goalName} · your contribution: ${v.contrib}`));
      out.push(heading("Goal")); const gg = grid(); v.goals.forEach((n, i) => gg.append(btn(n, `goal-${i}`, () => { const t = c.world.get(c.player, Transform); send(clanSetGoalIntent(i, t?.x ?? 0, t?.y ?? 0), `Goal: ${n}.`); }, { pressed: i === v.goal, alt: i !== v.goal, disabled: !permOn("goal"), title: "Goal point = where you stand" }))); out.push(gg);
      out.push(heading("Members")); const mg = grid();
      const roster = clanRosterRows(c, src.social, v.clan); const myPid = c.world.getField(c.player, PlayerId, "id") ?? 0;
      if (roster) for (const m of roster) { if (m.playerId === myPid) continue; const e = m.entity; const r = el("div", { "data-role": "member", "data-key": String(m.playerId), "data-rank": rankOf(m.role) }); r.append(kit.para(`${m.online ? "●" : "○"} ${m.name} · ${m.roleName}`));
        const far = e === undefined ? " (not nearby)" : "";
        const act = clanMemberActions(v.role, m.role, kickPerm);
        if (act.promote) r.append(btn("Promote", `promote-${m.playerId}`, () => { if (e !== undefined) send(clanPromoteIntent(e), `Promoted ${m.name}.`); }, { disabled: e === undefined, title: far }));
        if (act.demote) r.append(btn("Demote", `demote-${m.playerId}`, () => { if (e !== undefined) send(clanDemoteIntent(e), `Demoted ${m.name}.`); }, { alt: true, disabled: e === undefined, title: far }));
        if (act.kick) r.append(btn("Kick", `ckick-${m.playerId}`, () => { if (e !== undefined) send(clanKickIntent(e), `Kicked ${m.name}.`); }, { alt: true, disabled: e === undefined, title: far })); mg.append(r); }
      else for (const m of v.members) { if (m.entity === c.player) continue; const r = el("div", { "data-role": "member", "data-key": String(m.playerId), "data-rank": rankOf(m.role) }); r.append(kit.para(`${m.name} · ${m.role === 3 ? "Leader" : m.role === 2 ? "Officer" : "Member"}`));
        const act = clanMemberActions(v.role, m.role, kickPerm);
        if (act.promote) r.append(btn("Promote", `promote-${m.playerId}`, () => send(clanPromoteIntent(m.entity), `Promoted ${m.name}.`)));
        if (act.demote) r.append(btn("Demote", `demote-${m.playerId}`, () => send(clanDemoteIntent(m.entity), `Demoted ${m.name}.`), { alt: true }));
        if (act.kick) r.append(btn("Kick", `ckick-${m.playerId}`, () => send(clanKickIntent(m.entity), `Kicked ${m.name}.`), { alt: true })); mg.append(r); }
      out.push(mg);
      const cc = onlineTargets(c, src.social, new Set([...(roster ?? []).map((m) => m.playerId), ...v.members.map((m) => m.playerId)]));
      if (permOn("invite")) { out.push(heading("Invite")); const ig = grid(); for (const p of cc.slice(0, 16)) { const e = p.entity; ig.append(btn(`Invite ${p.name}`, `cinvite-${p.playerId}`, () => { if (e !== undefined) send(clanInviteIntent(e), `Invited ${p.name}.`); }, { disabled: e === undefined, title: e === undefined ? "online, not nearby" : "" })); } out.push(ig); }
      out.push(heading("Rank permissions"));
      for (const r of v.perms) { const pg = grid(); pg.dataset["role"] = "perm"; pg.dataset["key"] = String(r.role); for (const p of r.perms) pg.append(btn(`${r.roleName}: ${p.perm} ${p.on ? "✓" : "✕"}`, `perm-${r.role}-${p.perm}`, () => send(clanSetRankPermsIntent(r.role, togglePermMask(r.mask, p.perm)), "Permissions updated."), { pressed: p.on, alt: !p.on, disabled: !lead })); out.push(pg); }
      const a = grid(); a.append(btn("Leave clan", "clan-leave", () => send(clanLeaveIntent(), "Left clan."), { alt: true }));
      if (lead) a.append(btn("Disband clan", "clan-disband", () => send(clanDisbandIntent(), "Clan disbanded."), { alt: true }));
      out.push(a); return out;
    }
    case "trade": {
      const s = src.stall?.() ?? nearestStall(c); const v = s !== undefined ? stallView(c, s) : undefined; if (!v) return [kit.para("Walk up to a trade stall to browse it.")];
      const out: Node[] = [kit.para(`${v.name || "Trade stall"} · ${v.open ? "open" : "closed"}`)]; const g = grid();
      for (const l of v.listings) { if (!l.stockItem && !v.mine) continue; const label = l.stockItem ? `${l.stockName} ×${l.qty || 1} — ${l.priceCount} ${l.priceName} (stock ${l.stock})` : `Empty listing ${l.slot + 1}`;
        g.append(btn(label, `listing-${l.slot}`, () => send(buyFromStallIntent(v, l, 1), `Bought ${l.stockName}.`), { role: "listing", disabled: v.mine || !v.open || !l.enabled || !l.stockItem || l.stock < Math.max(1, l.qty), alt: !l.canAfford, title: l.canAfford ? "Buy" : `Need ${l.priceCount} ${l.priceName}` })); }
      out.push(g);
      if (v.mine) {
        out.push(heading(`Till: ${v.till.map((t) => `${t.name} ×${t.count}`).join(", ") || "empty"}`));
        const name = el("input", { "data-role": "stall-name", maxlength: "24", "aria-label": "Stall name", placeholder: "Stall name" }); name.value = v.name;
        const a = grid(); a.append(btn("Collect till", "collect", () => send(collectTillIntent(v.stall), "Collected."), { disabled: !v.till.length }),
          btn(v.open ? "Close stall" : "Open stall", "open", () => send(setStallOpenIntent(v.stall, !v.open), v.open ? "Closed." : "Opened."), { alt: true }),
          btn("Rename", "rename", () => { const live = document.querySelector<HTMLInputElement>("[data-role=stall-name]") ?? name; send(setStallNameIntent(v.stall, live.value), "Renamed."); }));
        out.push(name, a);
        // ---- stock + price a listing: pick listing, pick an inventory slot, set price / qty / count, List it ----
        const inv = inventoryView(c); const prices = priceItemChoices(c);
        if (draft.listing >= v.listings.length) draft.listing = 0;
        if (!prices.some((p) => p.item === draft.priceItem)) draft.priceItem = prices[0]?.item ?? 0;
        const slot = inv.find((x) => x.slot === draft.invSlot); if (!slot) draft.invSlot = -1; draft.count = Math.max(1, Math.min(draft.count, slot?.count ?? 1));
        const cur = v.listings[draft.listing];
        out.push(heading("Stock & price"));
        const lg = grid(); for (const l of v.listings) lg.append(btn(`Listing ${l.slot + 1}${l.stockItem ? `: ${l.stockName}` : ""}`, `draft-listing-${l.slot}`, () => { draft.listing = l.slot; if (l.priceItem) { draft.priceItem = l.priceItem; draft.priceCount = l.priceCount; draft.qty = Math.max(1, l.qty); } kit.rerender(); }, { pressed: l.slot === draft.listing, alt: l.slot !== draft.listing }));
        out.push(lg, kit.para("Item to stock:"));
        const ig = grid(); for (const x of inv) ig.append(btn(`${x.name} ×${x.count}`, `draft-slot-${x.slot}`, () => { draft.invSlot = x.slot; draft.count = x.count; kit.rerender(); }, { pressed: x.slot === draft.invSlot, alt: x.slot !== draft.invSlot, title: x.tooltip }));
        if (!inv.length) out.push(kit.para("Nothing in your pack to stock.")); else out.push(ig);
        const priceName = prices.find((p) => p.item === draft.priceItem)?.name ?? "—";
        const step = (k: "count" | "priceCount" | "qty", d: number, max = 9999): void => { draft[k] = Math.max(1, Math.min(max, draft[k] + d)); kit.rerender(); };
        const fg = grid();
        fg.append(btn(`Price in: ${priceName}`, "draft-price-item", () => { const i = prices.findIndex((p) => p.item === draft.priceItem); draft.priceItem = prices[(i + 1) % Math.max(1, prices.length)]?.item ?? 0; kit.rerender(); }, { disabled: prices.length < 2, title: "Cycle currency" }),
          btn("Price −", "draft-price-dec", () => step("priceCount", -1)), btn(`Price ${draft.priceCount}`, "draft-price", () => step("priceCount", 10), { alt: true, title: "+10" }), btn("Price +", "draft-price-inc", () => step("priceCount", 1)),
          btn("Per sale −", "draft-qty-dec", () => step("qty", -1)), btn(`Per sale ${draft.qty}`, "draft-qty", () => step("qty", 1), { alt: true }), btn("Per sale +", "draft-qty-inc", () => step("qty", 1)),
          btn("Stock −", "draft-count-dec", () => step("count", -1, slot?.count ?? 1), { disabled: !slot }), btn(`Stock ${slot ? draft.count : 0}`, "draft-count", () => { draft.count = slot?.count ?? 1; kit.rerender(); }, { alt: true, disabled: !slot, title: "All" }), btn("Stock +", "draft-count-inc", () => step("count", 1, slot?.count ?? 1), { disabled: !slot }));
        out.push(fg);
        const lgo = grid();
        lgo.append(btn(slot ? `List ${draft.count} ${slot.name} for ${draft.priceCount} ${priceName} / ${draft.qty}` : `Update price: ${draft.priceCount} ${priceName} / ${draft.qty}`, "draft-list", () => { let ok = true; for (const i of listItemIntents(v.stall, draft)) ok = src.send(i) && ok; draft.invSlot = -1; kit.status(ok ? "Listed." : "Not connected."); kit.rerender(); }, { disabled: !draft.priceItem || (!slot && !cur?.stockItem) }),
          btn("Unstock listing", "draft-unstock", () => send(unstockStallIntent(v.stall, draft.listing, cur?.stock ?? 0), "Unstocked."), { alt: true, disabled: !cur?.stock }));
        out.push(lgo);
      }
      return out;
    }
    case "pet": return petBody(c, src, kit, btn, send);
    case "worker": return workerBody(c, src, kit, btn, send);
    case "mount": return mountBody(c, src, kit, btn, send);
    case "camper": {
      const ve = src.camper?.(); const v = ve === undefined ? undefined : camperStationView(c, ve);
      if (!v) return [kit.para("Open a camper's station (interact inside a parked camper).")];
      const slotData = (s: { item: number; icon: string; count: number } | undefined): Record<string, string> => s && s.item ? { item: String(s.item), icon: s.icon, count: String(s.count) } : {};
      const fuel = el("section", { "data-role": "station-fuel" }); const fi = v.fuelItem;
      const need = Math.max(1, Math.ceil(v.fuel.capacity - v.fuel.liters));
      fuel.append(btn(fi ? `${fi.name} ×${fi.count}` : "No fuel", "fuel-slot", () => { if (fi) send(vehicleRefuelIntent(v.vehicle, fi.slot, Math.min(255, fi.count, need)), `Added ${fi.name}.`); },
        { role: "slot", disabled: !fi || !v.fuel.uses || v.fuel.fraction >= 1, title: fi ? `${fi.name} ×${fi.count} · Y to add` : v.fuel.uses ? "Carry fuel that fits this tank" : "No fuel tank", data: { ...slotData(fi), pad: "Y" } }));
      const pct = Math.round(v.fuel.fraction * 100);
      const gauge = el("div", { "data-role": "fuel-gauge", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), style: `--p:${v.fuel.fraction.toFixed(3)}` }); if (v.fuel.low) gauge.setAttribute("data-low", "");
      const secs = Math.round(v.fuel.seconds); fuel.append(gauge, el("p", { "data-role": "fuel-time" }, v.fuel.uses ? `${pct}% · ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` : "No fuel tank"));
      const tabs = el("nav", { "data-role": "station-tabs", "data-tabs": "tab" });
      tabs.append(btn("Craft", "tab-craft", () => { camperSel.tab = "craft"; kit.rerender(); }, { pressed: camperSel.tab === "craft", data: { pad: "LB" } }), btn("Cook", "tab-cook", () => { camperSel.tab = "cook"; kit.rerender(); }, { pressed: camperSel.tab === "cook", data: { pad: "RB" } }));
      const tip = (r: CamperRecipeView): string => `${r.output.name}${r.output.count > 1 ? ` ×${r.output.count}` : ""} · ${r.ingredients.map((i) => `${i.count} ${i.name}`).join(" + ")}${r.reason ? ` · ${r.reason.replace(/_/g, " ")}` : ""}`;
      const jobBtn = (j: { slot: number; name: string; count: number; progress: number; secondsLeft: number; icon: string; recipe: number }, key: string): HTMLButtonElement => btn(`${j.name} · ${Math.ceil(j.secondsLeft)}s`, key, () => send(cancelQueuedCraftIntent(j.slot), `Cancelled ${j.name}.`),
        { role: "job", p: j.progress, title: `${j.name} ×${j.count} · ${Math.ceil(j.secondsLeft)}s left · cancel refunds unfinished units`, data: { item: String(gameplayDefs(c.world).recipes.get(j.recipe)?.output.item ?? 0), icon: j.icon } });
      const craft = el("section", { "data-role": "station-craft" }); const cg = grid();
      for (const r of v.craft) { const b = btn(r.output.name, `recipe-${r.key}`, () => send(queueCraftIntent(r.id, 1), `Queued ${r.output.name}.`), { role: "recipe", alt: !!r.reason, title: tip(r), data: { item: String(r.output.item), icon: r.icon } }); cg.append(b); }
      if (!v.craft.length) cg.append(kit.para("No crafting station in this camper."));
      craft.append(cg); for (const j of v.craftJobs) craft.append(jobBtn(j, `job-${j.slot}`));
      const cook = el("section", { "data-role": "station-cook" });
      const sel = v.cook.find((r) => r.id === camperSel.cook) ?? v.cook[0];
      const row = el("div", { "data-role": "cook-row" }); const ins = el("div", { "data-role": "cook-inputs" });
      for (let i = 0; i < 3; i++) { const ing = sel?.ingredients[i]; const icon = ing ? gameplayDefsIcon(c, ing.item) : "";
        ins.append(btn(ing ? `${ing.name} ${ing.have}/${ing.count}` : "—", `cook-in-${i}`, () => kit.status(ing ? `${ing.name}: have ${ing.have}, need ${ing.count}` : "Empty input"), { role: "slot", title: ing ? `${ing.name} · have ${ing.have} / need ${ing.count}` : "Empty input", data: ing ? { item: String(ing.item), icon, count: String(ing.have) } : {} })); }
      const cj = v.cookJobs[0];
      const cookJob = cj ? jobBtn(cj, "cook-job") : btn(sel ? `Cook ${sel.output.name}` : "Nothing to cook", "cook-job", () => { if (sel) send(queueCraftIntent(sel.id, 1), `Cooking ${sel.output.name}.`); }, { role: "job", p: 0, disabled: !sel, title: sel ? tip(sel) : "No cooking station", data: sel ? { item: String(sel.output.item), icon: sel.icon } : {} });
      row.append(ins, cookJob, btn(sel ? `${sel.output.name} ×${sel.output.count}` : "—", "cook-out", () => kit.status(sel ? tip(sel) : ""), { role: "slot", title: sel ? tip(sel) : "Output", data: sel ? { item: String(sel.output.item), icon: sel.icon, count: String(sel.output.count) } : {} }));
      const kg = grid(); for (const r of v.cook) kg.append(btn(r.output.name, `cook-${r.key}`, () => { if (sel?.id !== r.id) { camperSel.cook = r.id; kit.rerender(); } else send(queueCraftIntent(r.id, 1), `Cooking ${r.output.name}.`); },
        { role: "recipe", alt: !!r.reason, pressed: sel?.id === r.id, title: `${tip(r)} · select, then A again to cook`, data: { item: String(r.output.item), icon: r.icon } }));
      if (!v.cook.length) kg.append(kit.para("No campfire in this camper."));
      cook.append(row, kg);
      if (camperSel.tab === "craft") cook.hidden = true; else craft.hidden = true; // CSS hides it too; `hidden` keeps UINav/Tab off the inactive tab
      const inv = el("section", { "data-role": "station-inv" }); inv.append(el("p", { "data-role": "section" }, `Camper storage ${v.storage.used}/${v.storage.total}`));
      const ig = grid(); for (const s of v.storage.slots) ig.append("name" in s ? btn(`${s.name} ×${s.count}`, `inv-${s.slot}`, () => send(withdrawIntent(v.vehicle, s.item, s.count), `Took ${s.name} ×${s.count}.`), { role: "slot", title: `${s.name} ×${s.count} · A to take`, data: slotData(s) })
        : btn("", `inv-${s.slot}`, () => kit.status("Empty slot"), { role: "slot", title: "Empty slot" }));
      inv.append(ig);
      return [fuel, tabs, craft, cook, inv];
    }
  }
}

// ---- ADR-145 pet panel -----------------------------------------------------------------------------------
type Btn = (label: string, key: string, fn: () => void, opts?: { alt?: boolean; disabled?: boolean; title?: string; role?: string; pressed?: boolean; data?: Record<string, string>; p?: number }) => HTMLButtonElement;
const PREF_TEXT: Record<string, string> = { love: "loves it", like: "likes it", ok: "will try it", hate: "hates it", food: "food" };
const bar = (label: string, v: number, max: number, role: string): HTMLElement => {
  const p = el("p", { "data-role": role }, `${label} ${Math.round(v)}/${Math.round(max)}`); p.setAttribute("style", `--p:${Math.max(0, Math.min(1, max ? v / max : 0)).toFixed(3)}`); return p;
};
// ---- Task 15: animal skill tree section (pet + livestock panels) ---------------------------------------
function skillNodes(c: MenuCtx, kit: PanelKit, btn: Btn, send: (i: MenuIntent, ok: string) => void, v: { entity: Entity; name: string }): Node[] {
  const out: Node[] = []; const sk = animalSkillView(c.world, v.entity);
  if (!sk) return out;
  out.push(heading(`Skills · Lv ${sk.level} · ${sk.points} point${sk.points === 1 ? "" : "s"}`));
  const g = grid(); g.dataset["role"] = "animal-skills";
  for (const n of sk.nodes) {
    if (n.owned) g.append(btn(`${n.name} — ${n.desc}`, `skill-${n.index}`, () => kit.status(`${n.name} already learned.`), { pressed: true, role: "toggle", title: "Learned" }));
    else if (n.available) g.append(btn(`${n.name} — ${n.desc} (${n.cost} pt)`, `skill-${n.index}`, () => send(animalSkillIntent(v.entity, n.index), `${v.name} learned ${n.name}.`), { title: "Spend a skill point" }));
    else {
      const req = n.requires ? sk.nodes.find((o) => o.key === n.requires) : undefined;
      const why = n.requires && !req?.owned ? `Requires ${req?.name ?? n.requires}` : `Needs ${n.cost} point${n.cost === 1 ? "" : "s"} (have ${sk.points})`;
      g.append(btn(`${n.name} — ${n.desc}`, `skill-${n.index}`, () => kit.status(why), { disabled: true, title: why }));
    }
  }
  out.push(g);
  return out;
}
function petBody(c: MenuCtx, src: GameplaySource, kit: PanelKit, btn: Btn, send: (i: MenuIntent, ok: string) => void): Node[] {
  const w = c.world; const me = w.getField(c.player, PlayerId, "id") ?? 0; const out: Node[] = [];
  const target = src.pet?.(); const v = target !== undefined ? petView(w, c.player, target) : undefined;
  const mine = petsOf(w, me);
  if (mine.length > 1 || (mine.length && !v)) {
    const g = grid(); g.dataset["role"] = "pet-list";
    for (const e of mine) { const sp = petSpecies(w.getField(e, Pet, "species") ?? 0); g.append(btn(`${petName(w, e)} · Lv ${w.getField(e, Pet, "level") ?? 1}`, `pet-${e}`, () => { src.selectPet?.(e); kit.rerender(); }, { pressed: e === target, role: "pet", title: sp?.name ?? "Pet" })); }
    out.push(heading("Your pets"), g);
  }
  if (!v) {
    if (!mine.length) out.push(kit.para("You have no pets yet."));
    out.push(heading("How pets work"), ...PET_HELP.map((t) => kit.para(t)));
    return out;
  }
  const head = el("section", { "data-role": "pet-status", "data-species": petSpecies(v.species)?.key ?? "" });
  head.append(el("p", { "data-role": "pet-name" }, petTitle(v)));
  if (!v.wild) head.append(el("p", { "data-role": "pet-doing" }, `Doing: ${petStatusLabel(v.status)}${v.guard ? ` · ${v.guard}` : ""}`));
  head.append(bar("HP", v.hp, v.maxHp, "pet-hp"));
  if (!v.wild) head.append(bar("Fed", v.fullness, 100, "pet-fullness"), bar("Trust", v.loyalty, 100, "pet-loyalty"), bar("XP", v.xp, v.xpNext, "pet-xp"));
  // Task 34: favourite treat(s) from the taming data (pets.json `love` entries) — name + icon; nothing when the species loves none.
  if (v.favorites.length) {
    const fav = el("p", { "data-role": "pet-favorite" });
    fav.append(`Favorite treat${v.favorites.length > 1 ? "s" : ""}: `);
    for (const [i, f] of v.favorites.entries()) { if (i) fav.append(", "); fav.append(el("span", { "data-role": "ic", "data-icon": f.key, "aria-hidden": "true" }), ` ${f.name}`); }
    head.append(fav);
  }
  out.push(head);
  if (!v.wild && !v.owned) { out.push(kit.para(`Someone else's ${v.speciesName.toLowerCase()}.`)); return out; }
  if (v.livestock) {
    // Task 15: farm animals get only status + skills (Follow/Stay/Guard/bag are pet-only).
    out.push(...skillNodes(c, kit, btn, send, v));
    // ADR-351: lead it home on a rope (rope equipped), or release the rope when leading it.
    if (v.lead.leadable || v.lead.ledByMe) {
      const lg = grid(); lg.dataset["role"] = "pet-lead";
      if (v.lead.ledByMe) lg.append(btn("Release rope", "pet-release", () => send(ropeLeadIntent(0), `${v.name} released.`), { alt: true, title: "Let go of the rope — it stays here" }));
      else lg.append(btn("Lead with rope", "pet-lead", () => send(ropeLeadIntent(v.entity), `Leading ${v.name} home.`), { disabled: !ropeEquipped(w, c.player), title: ropeEquipped(w, c.player) ? "Walk it back to your fenced-in area" : "Equip rope in your hotbar first" }));
      out.push(lg);
    }
    out.push(kit.para("Feed with animal feed to keep it producing. Farm animals earn skill XP when they produce and when fed."));
    return out;
  }
  if (v.owned) {
    const g = grid(); g.dataset["role"] = "pet-commands";
    g.append(btn("Follow", "pet-follow", () => send(petCommandIntent(v.entity, 0), `${v.name} follows you.`), { pressed: v.cmd === 0, role: "toggle", title: "Follow, defend you, fetch dropped items" }));
    g.append(btn("Stay", "pet-stay", () => send(petCommandIntent(v.entity, 1), `${v.name} stays here.`), { pressed: v.cmd === 1, role: "toggle", title: "Guard this spot, your buildings and pets" }));
    g.append(btn("Rename", "pet-rename", () => src.renamePet?.(v.entity, v.name), { alt: true, title: "Give your pet a name" }));
    out.push(g);
    // Task 14: guard assignment — this spot, the player, or a nearby guardable target
    const gg = grid(); gg.dataset["role"] = "pet-guard";
    const me = w.get(c.player, Transform);
    if (me) gg.append(btn("Guard here", "pet-guard-here", () => send(petGuardIntent(v.entity, 1, v.entity, me.x, me.y), `${v.name} guards this spot.`), { pressed: v.cmd === 2 && (v.guard ?? "").startsWith("Location"), role: "toggle", title: "Stay near this spot and fight threats to it" }));
    gg.append(btn("Guard me", "pet-guard-me", () => send(petGuardIntent(v.entity, 2, c.player, 0, 0), `${v.name} guards you.`), { pressed: v.cmd === 2 && v.guard === "Player", role: "toggle", title: "Stay near you and fight anything that threatens you" }));
    if (me) {
      const defs = gameplayDefs(w); const near: { e: Entity; label: string; d: number }[] = [];
      for (const e of w.query([Transform])) {
        if (e === v.entity || e === c.player) continue;
        const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d > 12) continue;
        if (w.has(e, Pet)) { if (w.getField(e, Pet, "owner") === w.getField(c.player, PlayerId, "id")) near.push({ e, label: petName(w, e), d }); }
        else if (w.has(e, PlayerId)) near.push({ e, label: "Player", d });
        else if (w.has(e, BuildPiece)) { const def = defs.pieces.get(w.getField(e, BuildPiece, "type") ?? 0); if (def) near.push({ e, label: def.key.replace(/_/g, " "), d }); }
        else if (w.has(e, Animal) && w.has(e, Tamed)) near.push({ e, label: "Farm animal", d });
      }
      near.sort((a, b) => a.d - b.d);
      for (const t of near.slice(0, 12)) gg.append(btn(`Guard ${t.label}`, `pet-guard-${t.e}`, () => send(petGuardIntent(v.entity, 2, t.e, 0, 0), `${v.name} guards ${t.label}.`), { pressed: v.cmd === 2 && v.guard === t.label, role: "toggle", title: `Stay near ${t.label} and fight threats to it` }));
    }
    out.push(heading("Guard"), gg);
  }
  if (v.owned) out.push(...skillNodes(c, kit, btn, send, v));
  // treats / food offers (tame chance for wild animals)
  const og = grid(); og.dataset["role"] = "pet-offers";
  for (const o of v.offers) {
    const label = v.wild ? `Offer ${o.name} (${o.pref === "hate" ? "refuses" : Math.round(o.chance * 100) + "%"})` : `Feed ${o.name} ×${o.count}`;
    og.append(btn(label, `offer-${o.item}`, () => send(petOfferIntent(v.entity, o.item), v.wild ? `Offered ${o.name}…` : `Fed ${o.name}.`), { role: "offer", disabled: v.wild && o.chance <= 0, title: `${petSpecies(v.species)?.name}: ${PREF_TEXT[o.pref]}${o.fullness ? ` · +${o.fullness} fed` : ""}`, data: { item: String(o.item), icon: o.key, pref: o.pref } }));
    og.lastElementChild?.prepend(el("span", { "data-role": "ic", "data-icon": o.key, "aria-hidden": "true" })); // treat icon (::before is the tooltip)
  }
  out.push(heading(v.wild ? "Tame with a treat" : "Feed"));
  if (og.childElementCount) out.push(og);
  else out.push(kit.para(v.wild ? `No treat it accepts. ${PET_HELP[0]}` : "Nothing it can eat in your pack."));
  if (v.owned) {
    const inv = inventoryView(c); const cv = containerView(c, v.entity, 0);
    if (cv) {
      out.push(heading(`${v.name}'s bag · ${cv.slotCount} slots`));
      const g = grid(); g.dataset["role"] = "container-grid";
      for (const s of cv.slots) g.append(s.item
        ? btn(`${s.name} ×${s.count}`, `cslot-${s.slot}`, () => send(withdrawIntent(v.entity, s.item, s.count), `Took ${s.name} ×${s.count}.`), { title: `${s.tooltip}\nTake`, role: "cslot", data: { item: String(s.item), icon: s.icon, slot: String(s.slot) } })
        : btn("·", `cslot-${s.slot}`, () => kit.status("Empty slot"), { alt: true, title: "Empty", role: "cslot", data: { item: "0", slot: String(s.slot) } }));
      out.push(g);
      out.push(heading("Give from your pack"));
      const pg = grid(); for (const s of inv) if (!s.equipped) pg.append(btn(`${s.name} ×${s.count}`, `slot-${s.slot}`, () => send(depositIntent(v.entity, s.item, s.count), `Gave ${s.name} ×${s.count}.`), { title: `${s.tooltip}\nPut in ${v.name}'s bag`, role: "slot", data: { item: String(s.item), icon: s.icon } }));
      out.push(pg.childElementCount ? pg : kit.para("Your pack is empty."));
    } else { src.selectPet?.(v.entity); out.push(kit.para("Opening the bag…")); } // (re)sends the open; throttled in selectPet
  }
  return out;
}

/** Task 22 worker panel: hire an AI human for their wanted item, or manage a hired worker's job. */
function workerBody(c: MenuCtx, src: GameplaySource, kit: PanelKit, btn: Btn, send: (i: MenuIntent, ok: string) => void): Node[] {
  const w = c.world; const out: Node[] = [];
  const target = src.worker?.(); const v = target !== undefined ? workerView(w, c.player, target, c.names) : undefined;
  if (!v) {
    out.push(kit.para("Walk up to an AI human and press Interact to talk about work."));
    out.push(heading("How hiring works"), ...WORKER_HELP.map((t) => kit.para(t)));
    return out;
  }
  const head = el("section", { "data-role": "worker-status" });
  head.append(el("p", { "data-role": "worker-name" }, v.name));
  if (!v.aiHumans) out.push(kit.para("AI humans are off in this world: no new hires."));
  if (!v.hired) {
    head.append(el("p", { "data-role": "worker-want" }, `Wants: ${v.wantedName || "—"}${v.hasCount ? ` · you have ${v.hasCount}` : ""}`));
    out.push(head);
    const g = grid(); g.dataset["role"] = "worker-hire";
    const hireBtn = btn(`Hire for ${v.wantedName || "?"}`, "worker-hire", () => send(hireWorkerIntent(v.entity), `${v.name} hired!`), { disabled: !v.aiHumans || !v.hasWanted, title: v.hasWanted ? "The item is taken from your pack as the hire completes" : `You need ${v.wantedName || "the wanted item"} in your pack to hire them`, data: { item: String(v.wantedItem), icon: v.wantedKey } });
    g.append(hireBtn);
    out.push(g);
    out.push(kit.para(v.hasWanted ? "The item is taken from your pack as the hire completes." : `You need ${v.wantedName || "the wanted item"} in your pack to hire them.`));
    out.push(heading("How hiring works"), ...WORKER_HELP.map((t) => kit.para(t)));
    return out;
  }
  if (v.owned) {
    head.append(el("p", { "data-role": "worker-job" }, `Job: ${WORKER_JOB_LABELS[v.job] ?? "—"}`), kit.para(v.assignment));
    const details = workerJobMenu(c, src, kit, btn, v);
    if (details) return [head, ...details];
    out.push(head);
    const g = grid(); g.dataset["role"] = "worker-jobs";
    for (const job of WORKER_JOBS) g.append(btn(WORKER_JOB_LABELS[job]!, `worker-job-${job}`, () => { beginWorkerJob(c.world, workerView(c.world, c.player, v.entity, c.names) ?? v, job); kit.rerender(); focusKey("worker-detail-back"); }, { pressed: v.job === job, role: "toggle", title: WORKER_JOB_HELP[job] ?? "" }));
    out.push(heading("Job"), g);
    const rg = grid(); rg.dataset["role"] = "worker-release";
    rg.append(btn("Release", "worker-dismiss", () => send(dismissWorkerIntent(v.entity), `${v.name} released.`), { alt: true, title: "Stop working for you" }));
    out.push(rg);
    out.push(kit.para("They work around your base. Workers still eat, drink and sleep like any survivor."));
    return out;
  }
  head.append(el("p", { "data-role": "worker-owner" }, `Works for Player ${v.owner}.`));
  out.push(head);
  return out;
}

// ---- ADR-319 / ADR-320 mount panel ------------------------------------------------------------------------
const MOUNT_PREF: Record<string, string> = { love: "loves it", like: "likes it", ok: "will eat it" };
function mountBody(c: MenuCtx, src: GameplaySource, kit: PanelKit, btn: Btn, send: (i: MenuIntent, ok: string) => void): Node[] {
  const m = src.mount?.(); const v = m !== undefined ? mountView(c.world, c.player, m) : undefined;
  if (!v) return [kit.para("Walk up to a horse, donkey, deer, elk, moose, buffalo or yak and press Mount (U / pad LB+X)."), kit.para(`Rideable: ${MOUNT_SPECIES.map((s) => s.name).join(", ")}.`)];
  const out: Node[] = [];
  const head = el("section", { "data-role": "mount-status", "data-species": MOUNT_SPECIES[v.species - 1]?.key ?? "" });
  head.append(el("p", { "data-role": "mount-name" }, v.wild ? `Wild ${v.speciesName}` : v.name === v.speciesName ? v.speciesName : `${v.name} (${v.speciesName})`));
  head.append(el("p", { "data-role": "mount-speed" }, `Walk ${v.walk.toFixed(1)} · Gallop ${v.gallop.toFixed(1)} tiles/s`));
  head.append(bar("HP", v.hp, v.maxHp, "mount-hp"));
  if (v.wild) head.append(bar("Tame", v.tame, 100, "mount-tame"));
  if (v.saddle) head.append(bar(`${v.saddle.name} · +${v.saddle.defense} armor · ${v.saddle.used}/${v.saddle.slots} slots`, v.saddle.dur, v.saddle.max, "mount-saddle"));
  if (v.harness) head.append(el("p", { "data-role": "mount-harness" }, `Harness on${v.towing ? ` · towing ${v.towing.name}` : " · ready to pull"}`));
  out.push(head);
  if (!v.wild && !v.mayUse) { out.push(kit.para("Someone else's mount.")); return out; }
  if (v.wild) {
    if (!v.canTame) { out.push(kit.para(`Learn ${v.tameNeeds ?? "Horsemanship"} in the skill tree to tame it.`)); return out; }
    out.push(heading("Tame with food"));
    const og = grid(); og.dataset["role"] = "mount-feed";
    for (const f of v.foods) og.append(btn(`Feed ${f.name} ×${f.count}`, `mount-feed-${f.item}`, () => send(mountFeedIntent(v.entity, f.item), `Offered ${f.name}…`), { role: "offer", title: `${v.speciesName} ${MOUNT_PREF[f.pref]}`, data: { item: String(f.item), icon: f.key } }));
    if (og.childElementCount) out.push(og); else out.push(kit.para("Carry food it likes (hay, apples, carrots, wheat or berries) and hold it so it stays calm."));
    // ADR-351: a wild mount can be led home on a rope too (no taming needed to move it).
    if (v.lead.leadable || v.lead.ledByMe) {
      const lg = grid(); lg.dataset["role"] = "mount-lead";
      if (v.lead.ledByMe) lg.append(btn("Release rope", "mount-release", () => send(ropeLeadIntent(0), "Released."), { alt: true, title: "Let go of the rope — it stays here" }));
      else lg.append(btn("Lead with rope", "mount-lead", () => send(ropeLeadIntent(v.entity), `Leading the ${v.speciesName} home.`), { disabled: !ropeEquipped(c.world, c.player), title: ropeEquipped(c.world, c.player) ? "Walk it back to your fenced-in area" : "Equip rope in your hotbar first" }));
      out.push(lg);
    }
    return out;
  }
  const g = grid(); g.dataset["role"] = "mount-actions";
  if (v.riding) g.append(btn("Dismount", "mount-dismount", () => send(mountDismountIntent(), "You got off."), { title: "Get off (Use)" }));
  else g.append(btn("Ride", "mount-ride", () => { send(mountRideIntent(v.entity), "Mounted."); kit.close(); }, { disabled: v.taken, title: v.taken ? "Someone is riding it" : "Get on (Use)" }));
  if (v.saddle) g.append(btn(`Saddlebag (${v.saddle.used}/${v.saddle.slots})`, "mount-bag", () => src.openSaddlebag?.(v.entity), { title: "Open the saddlebag" }));
  g.append(btn("Rename", "mount-rename", () => src.renameMount?.(v.entity, v.name), { alt: true, title: "Give your mount a name" }));
  if (v.lead.leadable || v.lead.ledByMe) {
    if (v.lead.ledByMe) g.append(btn("Release rope", "mount-release", () => send(ropeLeadIntent(0), "Released."), { alt: true, title: "Let go of the rope — it stays here" }));
    else g.append(btn("Lead with rope", "mount-lead", () => send(ropeLeadIntent(v.entity), `Leading ${v.name} home.`), { disabled: !ropeEquipped(c.world, c.player), title: ropeEquipped(c.world, c.player) ? "Walk it back to your fenced-in area" : "Equip rope in your hotbar first" }));
  }
  out.push(g);
  out.push(heading("Saddle"));
  const sg = grid(); sg.dataset["role"] = "mount-saddles";
  for (const s of v.saddles) sg.append(btn(`Put on ${s.name} (${s.slots} slots, +${s.defense})`, `mount-saddle-${s.slot}`, () => send(mountSaddleIntent(v.entity, s.slot), `${s.name} on.`), { data: { item: String(s.item) } }));
  if (v.saddle) {
    sg.append(btn("Remove saddle", "mount-unsaddle", () => send(mountUnsaddleIntent(v.entity), "Saddle off."), { alt: true, disabled: v.saddle.used > 0, title: v.saddle.used > 0 ? "Empty the saddlebag first" : "Take the saddle off" }));
    if (v.repair.length) { const ok = v.repair.every((r) => r.have >= r.count); sg.append(btn(`Repair (${v.repair.map((r) => `${r.count} ${r.name}`).join(", ")})`, "mount-repair", () => send(mountRepairIntent(v.entity), "Repaired."), { disabled: !ok, title: ok ? "Restore durability" : "Missing materials" })); }
  }
  if (sg.childElementCount) out.push(sg); else out.push(kit.para("Bareback: no armor, no saddlebag. Craft a saddle at a workbench (Saddlery, Husbandry tree)."));
  // ADR-359: harness + hook up / detach. The panel is the same shell-button list on keyboard, gamepad and touch
  // (Mount menu: U / LB+X / "Mount"), so hook/detach needs no separate input path.
  out.push(heading("Harness"));
  const hg = grid(); hg.dataset["role"] = "mount-harness";
  for (const h of v.harnesses) hg.append(btn(`Put on ${h.name}`, `mount-harness-${h.slot}`, () => send(mountHarnessIntent(v.entity, h.slot), `${h.name} on.`), { data: { item: String(h.item) } }));
  if (v.harness) hg.append(btn("Remove harness", "mount-unharness", () => send(mountUnharnessIntent(v.entity), "Harness off."), { alt: true, disabled: !!v.towing, title: v.towing ? "Detach the wagon first" : "Take the harness off" }));
  if (v.towing) hg.append(btn(`Detach ${v.towing.name}`, "mount-unhitch", () => send(mountUnhitchIntent(v.towing!.id), `${v.towing!.name} detached.`), { alt: true, title: "The wagon stays parked where it is" }));
  else for (const d of v.drawn) hg.append(btn(`Hook up ${d.name}`, `mount-hitch-${d.id}`, () => send(mountHitchIntent(v.entity, d.id), `Hooked up the ${d.name}.`), { disabled: !v.harness, title: v.harness ? "Hitch it behind the mount" : "Put a harness on first" }));
  if (hg.childElementCount) out.push(hg);
  else out.push(kit.para(v.harness ? "No wagon, cart, carriage or chariot parked nearby to hook up." : "No harness in your pack. Craft one at a workbench (leather, rope, iron) to pull a wagon, cart, carriage or chariot."));
  if (v.foods.length && v.hp < v.maxHp - 0.5) {
    out.push(heading("Feed (heals)")); const fg = grid(); fg.dataset["role"] = "mount-feed";
    for (const f of v.foods) fg.append(btn(`Feed ${f.name} ×${f.count}`, `mount-feed-${f.item}`, () => send(mountFeedIntent(v.entity, f.item), `Fed ${f.name}.`), { role: "offer", data: { item: String(f.item), icon: f.key } }));
    out.push(fg);
  }
  return out;
}
