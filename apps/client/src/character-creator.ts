/**
 * ADR-114 character creator: shown after the main-menu mode choice and before entering the world.
 * Fields: name (with a Roll button for a random name matching the body type — Task 27), body, skin, hair (+colour), face / beard, eyes (+colour); a rotating
 * preview (auto-turn + ⟲/⟳) and Randomize. Task 23: clothing is NOT offered here — a new survivor starts
 * with no clothes and must craft clothing in game. The result is stored per save (mode + slot) and sent on join as the
 * normal SetAppearance command, so the server's checkAppearance (catalog + unlock + first-join gate) validates it.
 * A stored character skips the screen (Edit character on the main-menu flow / ?editchar=1 re-opens it).
 * Input: touch / mouse (buttons, ≥44px), keyboard (Tab / arrows, Enter, Esc = Back), gamepad (d-pad / stick, A, B = Back).
 * Preview: the real paper-doll (body + wear sprites, idle anim, 8 facings, live) through @engine/render's WebGL2
 * createCharacterPreview (same layer resolve / anchors / tint as in-game), else the Canvas2D compositor from the PNG sheets
 * (CharacterPreview2D; force with ?creator=2d), else the sketch below when no art registry is loaded. Drag to turn (touch /
 * mouse), ⟲/⟳, LB/RB on a gamepad. Rendered at the device DPR (integer pixel scale in 2D: no blur).
 * The panel scrolls (overflow:auto, touch pan) and fits fullscreen phones (dvh units).
 */
import { navPad, PadEdges, padKeyEdge, traceAction, type PadControl } from "./pad-input.js";
import { installKeyboardViewport } from "./keyboard-viewport.js";
import { bindTypingFullscreenExit, exitFullscreenForTyping } from "./fullscreen.js";
import { markNavFocus } from "./back-history.js";
import type { AssetRegistry } from "@engine/assets";
import { buildSignEditor } from "./sign-editor.js";
import { iconUrl } from "./game-icons.js";
import { randomName } from "./random-names.js";
import { UINav } from "./ui-nav.js";
import { CharacterPreview2D, coreAppearanceBinding, createCharacterPreview, parseCharArt, withCharArt, type AtlasSource, type CharacterPreview } from "@engine/render";
import { BODY_TYPES, SLOT_COUNT, WEARABLE_SLOTS, defaultAppearance, mapLegacySkinTone, slotIndex, SKIN_TONE_SCHEME, swatchColor, type AppearanceValue, type CosmeticCatalogLike, type WearableDef, type WearableSlot } from "@engine/core";

export type CharacterSaveKind = "singleplayer" | "hosted" | "remote";
/** `skinScheme` (ADR-245): palette of appearance.skinTone; absent / < SKIN_TONE_SCHEME = the legacy 12-tone palette. */
export interface StoredCharacter { v: 1; name: string; appearance: AppearanceValue; skinScheme?: number }
export const characterKey = (kind: CharacterSaveKind, slot: string): string => `survivaz.character.${kind}.${slot}`;
export const NAME_MAX = 20;
export const EDIT_CHAR_KEY = "survivaz.editchar";
/** Character panel → "Edit character": the creator opens on the next world entry (name always applies; a look change
 * on an already-created character is still subject to the server's wardrobe gate). */
export function requestCharacterEdit(): void { try { sessionStorage.setItem(EDIT_CHAR_KEY, "1"); } catch { /* ignore */ } }
/** Same rule the server applies to hello names (printable, trimmed, ≤ NAME_MAX). */
export function cleanName(s: string): string { return s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX); }

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defStore = (): Store | undefined => { try { return localStorage; } catch { return undefined; } };
export function loadCharacter(kind: CharacterSaveKind, slot: string, st: Store | undefined = defStore()): StoredCharacter | undefined {
  try { const r = JSON.parse(st?.getItem(characterKey(kind, slot)) ?? "null") as StoredCharacter | null;
    if (!(r && r.v === 1 && typeof r.name === "string" && Array.isArray(r.appearance?.parts) && r.appearance.parts.length === SLOT_COUNT)) return undefined;
    return migrateStoredSkin(r, (c) => saveCharacter(kind, slot, c, st)); } catch { return undefined; }
}
/** ADR-245: a stored character from before the 18-tone palette gets its skinTone remapped (idempotent; `resave` persists it). */
export function migrateStoredSkin(c: StoredCharacter, resave?: (c: StoredCharacter) => void): StoredCharacter {
  if ((c.skinScheme ?? 0) >= SKIN_TONE_SCHEME) return c;
  const out: StoredCharacter = { ...c, appearance: { ...c.appearance, skinTone: mapLegacySkinTone(c.appearance.skinTone) }, skinScheme: SKIN_TONE_SCHEME };
  resave?.(out); return out;
}
export function saveCharacter(kind: CharacterSaveKind, slot: string, c: StoredCharacter, st: Store | undefined = defStore()): void { try { st?.setItem(characterKey(kind, slot), JSON.stringify({ ...c, skinScheme: SKIN_TONE_SCHEME })); } catch { /* private mode */ } }
export function deleteCharacter(kind: CharacterSaveKind, slot: string, st: Store | undefined = defStore()): void { try { st?.removeItem(characterKey(kind, slot)); } catch { /* ignore */ } }

/** Creator-visible slots (hat/accessory are wardrobe unlocks, not starter choices; Task 23: clothing — top /
 * bottom / shoes — is not offered here at all, so a new survivor starts with no clothes to craft in game). */
export const CREATOR_SLOTS: readonly WearableSlot[] = ["hair", "face", "eyes"];
const OPTIONAL: ReadonlySet<WearableSlot> = new Set(["hair", "face"]); // bald / clean-shaven allowed
/** Starter wearables per slot for a body: compatible and not unlock-gated (the server would reject those).
 * Task 23: only creator slots (hair / face / eyes) are ever offered — clothing is never a starter choice. */
export function creatorOptions(cat: CosmeticCatalogLike, bodyType: number): Record<WearableSlot, WearableDef[]> {
  const body = BODY_TYPES[bodyType] ?? "male"; const out = Object.fromEntries(WEARABLE_SLOTS.map((s) => [s, [] as WearableDef[]])) as Record<WearableSlot, WearableDef[]>;
  for (let id = 1, miss = 0; miss < 256; id++) { const w = cat.wearable(id); if (!w) { miss++; continue; } miss = 0; if (!CREATOR_SLOTS.includes(w.slot)) continue; if (w.bodies[body] && !w.unlockTags.length) out[w.slot].push(w); }
  return out;
}
export interface CreatorPalettes { skin: number; hair: number; clothing: number }
const pal = (cat: CosmeticCatalogLike): CreatorPalettes => ({ skin: Math.max(1, cat.skinTones.length), hair: Math.max(1, cat.hairColors.length), clothing: Math.max(1, cat.clothingColors.length) });
const isHairish = (s: WearableSlot): boolean => s === "hair" || s === "face";
/** Curated clothingColors keys offered for eyes (the eyes slot tints from clothingColors, so the server's range check is
 * unchanged); natural browns / hazels / greens / blues / greys first, then a few fun ones. Missing keys are skipped. */
export const EYE_COLOR_KEYS: readonly string[] = ["cocoa", "tan", "olive", "forest", "sage", "teal", "sky", "denim", "navy", "slate", "charcoal", "lavender", "plum", "berry", "gold"];
/** Palette indices the creator cycles for a field: eyes use the curated list, hair/face the hair palette, else clothing. */
export type CreatorField = "body" | "skin" | `${WearableSlot}` | `${WearableSlot}:color` | `${WearableSlot}:color2`;
export function colorChoices(cat: CosmeticCatalogLike, s: WearableSlot): number[] {
  if (s === "eyes") { const ix = EYE_COLOR_KEYS.map((k) => cat.clothingColors.findIndex((c) => c.key === k)).filter((i) => i >= 0); if (ix.length) return ix; }
  const n = Math.max(1, (isHairish(s) ? cat.hairColors : cat.clothingColors).length); return Array.from({ length: n }, (_, i) => i);
}
/** Palette indices the creator cycles for a field: eyes use the curated list, hair/face the hair palette, else clothing. */
/** Slots with their own "<slot> secondary colour" row: shown only once a starter wearable in the slot has a G (color2) tint channel. */
export const COLOR2_ROW_SLOTS: readonly WearableSlot[] = ["hair", "eyes", "face"];
/** True when any wearable in `s` (or one of its layers) tints G from the secondary palette (tintChannels 2). */
export function slotHasColor2(cat: CosmeticCatalogLike, s: WearableSlot): boolean {
  for (let id = 1, miss = 0; miss < 256; id++) { const w = cat.wearable(id); if (!w) { miss++; continue; } miss = 0;
    if (w.slot === s && (w.tintChannels >= 2 || (w.layers ?? []).some((l) => l.tintChannels >= 2))) return true; }
  return false;
}

/** Task 271: natural hair-palette keys a random beard / brows colour is rolled from. The full hair palette has dye
 *  shades (teal, mint, sky…); a rolled teal beard covers the cheeks, mouth and chin and read as the eye colour
 *  flooding the face. ADR-502: the Face colour row is gone, so dye shades are no longer reachable at creation —
 *  they stay reachable in-game at the wardrobe (full hair palette). */
export const FACE_NATURAL_COLOR_KEYS: readonly string[] = ["black", "espresso", "chestnut", "auburn", "ginger", "strawberry", "honey_blonde", "platinum", "ash", "silver"];
export const naturalFaceColors = (cat: CosmeticCatalogLike): number[] => FACE_NATURAL_COLOR_KEYS.map((k) => cat.hairColors.findIndex((c) => c.key === k)).filter((i) => i >= 0);
/** Uniform random starter look (Randomize); `rnd` is injectable for tests. */
export function randomLook(cat: CosmeticCatalogLike, rnd: () => number = Math.random, body?: number): AppearanceValue {
  const pick = (n: number): number => Math.min(n - 1, Math.floor(rnd() * n));
  // `body` overrides the body roll; the roll is still consumed so the rest of a seed stream keeps its place
  const rolled = pick(BODY_TYPES.length); const bodyType = body !== undefined && body >= 0 && body < BODY_TYPES.length ? body : rolled; const v = defaultAppearance(cat, bodyType); const o = creatorOptions(cat, bodyType); const p = pal(cat);
  // Task 23: a new survivor starts with no clothes, even if the catalog ships clothing defaults.
  for (const s of WEARABLE_SLOTS) if (!CREATOR_SLOTS.includes(s)) v.parts[slotIndex(s)] = 0;
  v.skinTone = pick(p.skin); const hairCol = pick(p.hair);
  for (const s of CREATOR_SLOTS) { const opts = o[s]; const i = slotIndex(s); if (!opts.length) continue;
    const none = OPTIONAL.has(s) ? 1 : 0; const k = pick(opts.length + none); v.parts[i] = k < opts.length ? opts[k]!.id : 0;
    // Task 25: the face (beard/brows) rolls its own hair-palette colour — it no longer inherits the hair colour
    // (the old shared hairCol put the hair tint on the face slot for every random look, bald or not).
    v.primary[i] = s === "hair" ? hairCol : s === "face" ? (() => { const c = naturalFaceColors(cat); return c.length ? c[pick(c.length)]! : pick(p.hair); })() : s === "eyes" ? (() => { const c = colorChoices(cat, "eyes"); return c[pick(c.length)]!; })() : pick(p.clothing);
    // Task 26: hair/face secondary follows the primary — a random look must never carry the palette-default
    // black secondary, which turns the hair's highlight regions into black bars across the face.
    if (isHairish(s)) v.secondary[i] = v.primary[i]!; }
  return v;
}
/** Deterministic PRNG (mulberry32) for the screenshot preset. */
export function seededRandom(seed: number): () => number {
  let t = seed >>> 0; return () => { t = (t + 0x6d2b79f5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
/**
 * ?creator=shot&seed=N[&facing=0..7][&body=0|1|male|female][&sex=m|f][&freeze=1][&timeout=ms]: the fixed preset look for
 * headless creator captures (same seed + pack = same look). body/sex override the seed's body roll (other rolls keep their
 * place in the seed stream). freeze=1: no auto-turn, frozen anim/shader clock, no adaptive quality, DPR 1 (pixel-stable).
 * timeout (default 20000 ms): window.__creatorReady = { ok:false, error:"timeout", stage } if not ready by then.
 */
export interface CreatorShotParams { seed: number; facing: number; body?: number; freeze: boolean; timeoutMs: number }
export function parseBodyParam(v: string | null): number | undefined {
  if (v === null || v === "") return undefined; const t = v.trim().toLowerCase();
  if (/^\d+$/.test(t)) { const n = Number(t); return n < BODY_TYPES.length ? n : undefined; }
  const k = t === "m" ? "male" : t === "f" ? "female" : t; const i = (BODY_TYPES as readonly string[]).indexOf(k); return i >= 0 ? i : undefined;
}
export function creatorShotFromQuery(q: URLSearchParams): CreatorShotParams | undefined {
  if (q.get("creator") !== "shot") return undefined; const n = (k: string, d: number): number => { const v = Number(q.get(k) ?? d); return Number.isFinite(v) ? Math.trunc(v) : d; };
  const body = parseBodyParam(q.get("body")) ?? parseBodyParam(q.get("sex"));
  return { seed: n("seed", 1), facing: ((n("facing", 1) % 8) + 8) % 8, ...(body !== undefined ? { body } : {}), freeze: /^(1|true|yes)$/i.test(q.get("freeze") ?? ""), timeoutMs: Math.max(1000, n("timeout", 20000)) };
}
export const creatorShotLook = (cat: CosmeticCatalogLike, seed: number, body?: number): AppearanceValue => randomLook(cat, seededRandom(seed), body);
/** Steps one field (cycle with wrap); returns a new value. */
export function stepLook(cat: CosmeticCatalogLike, v: AppearanceValue, field: CreatorField, d: number): AppearanceValue {
  const n: AppearanceValue = { bodyType: v.bodyType, skinTone: v.skinTone, parts: [...v.parts], primary: [...v.primary], secondary: [...v.secondary] }; const p = pal(cat);
  const wrap = (x: number, m: number): number => ((x % m) + m) % m;
  if (field === "body") { const b = wrap(v.bodyType + d, BODY_TYPES.length); const o = creatorOptions(cat, b); const def = defaultAppearance(cat, b);
    n.bodyType = b; for (const s of CREATOR_SLOTS) { const i = slotIndex(s); if (n.parts[i] && !o[s].some((w) => w.id === n.parts[i])) n.parts[i] = def.parts[i] ?? 0; } return n; }
  if (field === "skin") { n.skinTone = wrap(v.skinTone + d, p.skin); return n; }
  if (field.endsWith(":color2")) { const s = field.slice(0, -7) as WearableSlot; const i = slotIndex(s); const m = isHairish(s) ? p.hair : p.clothing; n.secondary[i] = wrap((v.secondary[i] ?? 0) + d, m); return n; }
  if (field.endsWith(":color")) { const s = field.slice(0, -6) as WearableSlot; const i = slotIndex(s); const ch = colorChoices(cat, s); const k = ch.indexOf(v.primary[i] ?? 0);
    n.primary[i] = ch[wrap((k < 0 ? (d > 0 ? -1 : 0) : k) + d, ch.length)] ?? 0;
    // Task 26: the hair/face secondary follows the primary — the old default (palette index 0 = black)
    // turned the tintmask's highlight regions into black bars across the face. The player can still
    // diverge it afterwards via the :color2 row for a deliberate two-tone look; changing the primary
    // only re-syncs the secondary, it never touches another slot (Task 25 independence preserved).
    if (isHairish(s)) n.secondary[i] = n.primary[i]!;
    return n; } // Task 25: the beard/face colour is independent — stepping hair:color no longer rewrites the face
  // slot (the old beard-follows-hair sync put the hair colour on the face even for a bald survivor, whose face
  // layer then carried the hair tint; the resolver is per-slot, so independence is safe here).
  const s = field as WearableSlot; const i = slotIndex(s); const ids = [...(OPTIONAL.has(s) ? [0] : []), ...creatorOptions(cat, v.bodyType)[s].map((w) => w.id)];
  if (ids.length) n.parts[i] = ids[wrap(ids.indexOf(v.parts[i] ?? 0) + d, ids.length)] ?? 0; return n;
}
const partName = (cat: CosmeticCatalogLike, id: number): string => { if (!id) return "None"; const w = cat.wearable(id); return w ? (w.displayName ?? w.key.replace(/^[a-z]+_/, "").replace(/_/g, " ")) : `#${id}`; };
const hex = (c: number | undefined, f: string): string => c === undefined ? f : `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;

/**
 * Preview (sprite fallback): a paper-doll drawn with Canvas2D in the chosen palette colours, turning through the four
 * facings (E,S,W,N). When the real layered character sprites ship, `drawLayers` can swap in resolveLayers output.
 */
export function drawPreview(g: CanvasRenderingContext2D, cat: CosmeticCatalogLike, v: AppearanceValue, dir: number): void {
  const W = g.canvas.width, H = g.canvas.height; g.clearRect(0, 0, W, H);
  const skin = hex(swatchColor(cat.skinTones[v.skinTone]), "#E0B08A"); const col = (s: WearableSlot, f: string): string => { const i = slotIndex(s); if (!v.parts[i]) return ""; const pc = isHairish(s) ? cat.hairColors : cat.clothingColors; return hex(pc[v.primary[i] ?? 0]?.color, f); };
  const top = col("top", "#5A7AB0") || skin, bottom = col("bottom", "#4A4A5A") || skin, shoes = col("shoes", "#3B2433") || skin, hair = col("hair", "#5A3A22"), beard = col("face", "#5A3A22");
  const side = dir === 0 || dir === 2, back = dir === 3, flip = dir === 2 ? -1 : 1, cx = W / 2, s = H / 200, fem = v.bodyType === 1;
  g.save(); g.translate(cx, 0); g.scale(flip, 1);
  const r = (x: number, y: number, w: number, h: number, c: string): void => { g.fillStyle = c; g.fillRect(x * s, y * s, w * s, h * s); };
  g.fillStyle = "rgba(0,0,0,.18)"; g.beginPath(); g.ellipse(0, 190 * s, 40 * s, 8 * s, 0, 0, Math.PI * 2); g.fill();
  const bw = side ? 26 : fem ? 40 : 46;
  r(-bw / 2, 150, bw / 2 - 2, 36, bottom); r(2, 150, bw / 2 - 2, 36, bottom); r(-bw / 2 - 2, 182, bw / 2 + 2, 8, shoes); r(0, 182, bw / 2 + 2, 8, shoes);
  r(-bw / 2, 90, bw, 64, top); if (!side) { r(-bw / 2 - 10, 94, 10, 50, top); r(bw / 2, 94, 10, 50, top); r(-bw / 2 - 10, 142, 10, 8, skin); r(bw / 2, 142, 10, 8, skin); } else r(-5, 96, 12, 48, top);
  r(-18, 46, 36, 44, skin);
  if (hair) { r(-20, 38, 40, 14, hair); if (back) r(-20, 46, 40, fem ? 40 : 26, hair); else if (side) r(-20, 46, 14, fem ? 34 : 18, hair); else if (fem) { r(-22, 46, 8, 36, hair); r(14, 46, 8, 36, hair); } }
  if (!back) { const ex = side ? [8] : [-9, 9]; const eye = v.parts[slotIndex("eyes")] ? hex(cat.clothingColors[v.primary[slotIndex("eyes")] ?? 0]?.color, "#3B2433") : "#3B2433"; for (const x of ex) r(x - 2, 62, 5, 5, eye); if (beard) r(side ? 0 : -14, 76, side ? 18 : 28, 14, beard); }
  g.restore();
}

export interface CreatorOptions {
  root: HTMLElement; catalog: CosmeticCatalogLike | undefined; initial?: StoredCharacter | undefined; title?: string;
  /** Gamepad poll (tests pass a stub); default navigator.getGamepads. */ pads?: () => readonly (Gamepad | null)[];
  /** Real sprite preview (the loaded art registry + atlas sources). mode: auto = WebGL2 then Canvas2D; "canvas2d" forces 2D. */
  preview?: CreatorPreviewSource | undefined;
  /** ADR-115: Art's creator UI folder (`<base>art/ui/creator/`): ic_randomize / ic_rotate_left / ic_rotate_right (1x + @2x). Text glyphs when absent. ADR-502: preview_bg is no longer used — the preview has no background. */
  artBase?: string | undefined;
  /** Screenshot mode (?creator=shot): no auto-turn / animation clock, fixed facing; onReady fires once the preview has drawn. */
  shot?: { facing?: number; /** pixel-stable WebGL2 frames (frozen clock, DPR 1) */ freeze?: boolean; onStage?: (stage: string) => void; onReady: (info: { renderer: PreviewDriver["kind"] }) => void } | undefined;
}
/** Glyph-only icon button art (like ic_menu_*): 40px + @2x; falls back to the text glyph on error. */
function iconInto(b: HTMLButtonElement, base: string | undefined, name: string, label: string): void {
  b.setAttribute("aria-label", label); b.title = label; if (!base) return;
  const doc = b.ownerDocument; const img = doc.createElement("img"); img.alt = ""; img.width = 40; img.height = 40; img.dataset["icon"] = name;
  img.src = `${base}${name}.png`; img.srcset = `${base}${name}.png 1x, ${base}${name}@2x.png 2x`; img.style.cssText = "width:40px;height:40px;display:block;pointer-events:none";
  const text = b.textContent; b.textContent = ""; b.append(img); img.addEventListener("error", () => { img.remove(); b.textContent = text; });
}
export interface CreatorPreviewSource { registry: AssetRegistry; sources: ReadonlyMap<string, AtlasSource>; mode?: CreatorPreviewMode;
  /** test hooks */ createGl?: typeof createCharacterPreview; create2d?: (cv: HTMLCanvasElement, o: ConstructorParameters<typeof CharacterPreview2D>[1]) => Pick<CharacterPreview2D, "setAppearance" | "setFacing" | "resize" | "renderNow" | "facing"> }
export type CreatorPreviewMode = "auto" | "webgl2" | "canvas2d";
/** ?creator=2d (or ?creator=canvas2d) forces the Canvas2D preview. */
export const previewModeFromQuery = (q: URLSearchParams): CreatorPreviewMode => (/^(2d|canvas2d)$/.test(q.get("creator") ?? "") ? "canvas2d" : "auto");
/** One preview backend: the creator only talks to this. */
export interface PreviewDriver { kind: "webgl2" | "canvas2d" | "sketch"; /** resolves when the initial look's art has loaded */ loaded?: Promise<void>; /** auto mode only: resolves when the backend upgrades from Canvas2D to WebGL2 (never resolves if WebGL2 is unavailable) */ upgraded?: Promise<void>; set(a: AppearanceValue): void; facing(k: number): void; frame(tSec: number): void; dispose(): void }
export const PREVIEW_CSS = { w: 168, h: 216 } as const;
/**
 * Task 24: the creator used to await the full WebGL2 preview before showing any doll — createCharacterPreview
 * creates a second WebGL context + IsoRenderer, rebuilds EVERY atlas in the registry (eager PNG decodes,
 * fitToPage mask/emissive resizes, fitBudget/halveSide rescales) and prefetches the look's streamed pages, so
 * the creator showed only the crude sketch for seconds. Auto mode is now 2D-first: the Canvas2D preview needs
 * only the character PNG sheets + tintmasks, so it mounts immediately, and the WebGL2 build runs in the
 * background and swaps in when ready (same final quality — the 2D doll is a stopgap, not a downgrade). Shot
 * mode (?creator=shot, freeze) and explicit webgl2 keep the old await-GL behaviour: screenshots need
 * deterministic GL frames. WebGL2 (render package) -> Canvas2D sheets -> undefined (caller keeps the sketch).
 * Mounts into `host`.
 */
export async function createPreviewDriver(host: HTMLElement, src: CreatorPreviewSource, look: AppearanceValue, facing: number, freeze = false): Promise<PreviewDriver | undefined> {
  const doc = host.ownerDocument; const dpr = freeze ? 1 : Math.min(3, doc.defaultView?.devicePixelRatio || 1); const cat = src.registry.cosmetics as unknown as CosmeticCatalogLike | undefined;
  // The WebGL2 driver. The canvas is created detached and only appended once the preview is ready, so a slow
  // (background) build never covers the 2D preview — or the sketch — with a blank canvas.
  const buildGl = async (): Promise<PreviewDriver | undefined> => {
    const cv = doc.createElement("canvas"); cv.dataset["role"] = "creator-preview"; cv.dataset["renderer"] = "webgl2"; cv.style.cssText = `width:${PREVIEW_CSS.w}px;height:${PREVIEW_CSS.h}px;border-radius:12px;display:block`;
    try {
      const pv: CharacterPreview = await (src.createGl ?? createCharacterPreview)(cv, { registry: src.registry, ...(cat && charArt() !== "v1" ? { binding: withCharArt(coreAppearanceBinding(cat), charArt(), src.registry.ids.sprites) } : {}), sources: new Map(src.sources), appearance: look, facing, anim: "idle", pollGamepad: false, ...(freeze ? { freeze: true } : {}) });
      pv.resize(PREVIEW_CSS.w, PREVIEW_CSS.h, dpr);
      host.append(cv);
      return { kind: "webgl2", set: (a) => { void pv.setAppearance(a); }, facing: (k) => pv.setFacing(k), frame: () => undefined, dispose: () => { pv.dispose(); cv.remove(); } };
    } catch (e) { cv.remove(); if (src.mode === "webgl2") return undefined; console.info("[creator] WebGL2 preview unavailable, Canvas2D:", e); return undefined; }
  };
  // The Canvas2D driver: construction is synchronous (sheet loading runs in the background via `loaded`).
  const build2d = (): PreviewDriver | undefined => {
    if (!cat) return undefined;
    const cv = doc.createElement("canvas"); cv.dataset["role"] = "creator-preview"; cv.dataset["renderer"] = "canvas2d"; cv.style.cssText = "border-radius:12px;display:block;image-rendering:pixelated;touch-action:none";
    try {
      const o = { registry: src.registry, binding: charArt() === "v1" ? coreAppearanceBinding(cat) : withCharArt(coreAppearanceBinding(cat), charArt(), src.registry.ids.sprites), appearance: look, sources: src.sources, facing };
      const pv = src.create2d ? src.create2d(cv, o) : new CharacterPreview2D(cv, o); pv.resize(PREVIEW_CSS.w, PREVIEW_CSS.h, dpr); host.append(cv);
      let cur = look; const loaded = pv.setAppearance(look);
      return { kind: "canvas2d", loaded, set: (a) => { cur = a; void pv.setAppearance(cur); }, facing: (k) => pv.setFacing(k), frame: (t) => pv.renderNow(t), dispose: () => cv.remove() };
    } catch (e) { console.warn("[creator] Canvas2D preview failed:", e); cv.remove(); return undefined; }
  };
  if (src.mode === "canvas2d") return build2d();
  // Shot mode (frozen frames) and explicit webgl2: await GL as before — no 2D-first upgrade.
  if (freeze || src.mode === "webgl2") {
    const gl = await buildGl();
    if (gl) return gl;
    if (src.mode === "webgl2") return undefined;
    return build2d();
  }
  // Auto mode: mount Canvas2D now, upgrade to WebGL2 in the background when it is ready.
  const twoD = build2d();
  if (!twoD) return buildGl(); // no 2D (no catalog / construction failed): await GL as before
  let cur: PreviewDriver = twoD; let latestLook = look; let latestFacing = facing; let disposed = false;
  let resolveUpgraded: () => void = () => undefined; const upgraded = new Promise<void>((r) => { resolveUpgraded = r; });
  // Task 29: don't start the WebGL2 build (second GL context + a full atlas rebuild on the main thread)
  // while the user is making their first choices — the 2D doll is already correct and interactive, and
  // the GL upgrade is cosmetic. Start it when the browser is idle (3s cap so it still arrives on a busy
  // main thread), or after 1.2s where requestIdleCallback is unavailable. Closing the creator first
  // cancels the start entirely instead of building a preview nobody will see.
  const win = doc.defaultView;
  const startGl = (): void => {
    void buildGl().then((gl) => {
      if (!gl) return; // WebGL2 unavailable: stay on Canvas2D (same doll, just the 2D compositor)
      if (disposed) { gl.dispose(); return; } // the creator closed while GL was building
      const prev = cur; cur = gl;
      gl.set(latestLook); gl.facing(latestFacing);
      prev.dispose(); // removes the 2D canvas (the GL canvas was appended by buildGl)
      resolveUpgraded();
    });
  };
  let cancelStart: () => void;
  if (typeof win?.requestIdleCallback === "function") {
    const h = win.requestIdleCallback(() => startGl(), { timeout: 3000 });
    cancelStart = () => win.cancelIdleCallback?.(h);
  } else {
    const h = win?.setTimeout?.(startGl, 1200) ?? 0;
    cancelStart = () => win?.clearTimeout?.(h);
  }
  return {
    get kind() { return cur.kind; },
    loaded: twoD.loaded!, // build2d always sets loaded (the 2D doll's sheet promise)
    upgraded,
    set: (a) => { latestLook = a; cur.set(a); },
    facing: (k) => { latestFacing = k; cur.facing(k); },
    frame: (t) => cur.frame(t),
    dispose: () => { disposed = true; cancelStart(); cur.dispose(); },
  };
}
/** ADR-240: the creator previews the same doll art as in-game (`charArt` setting; v2s/v2s-all = the v2 sample). */
const charArt = () => parseCharArt(new URLSearchParams(globalThis.location?.search ?? "").get("charArt"), (() => { try { return globalThis.localStorage?.getItem("charArt"); } catch { return null; } })());
/** Opens the creator; resolves with the character, or undefined on Back. */
export function showCharacterCreator(o: CreatorOptions): Promise<StoredCharacter | undefined> {
  const cat = o.catalog; const doc = o.root.ownerDocument;
  let look: AppearanceValue = o.initial?.appearance ?? (cat ? randomLook(cat) : defaultAppearance(undefined, 0));
  let name = o.initial?.name ?? ""; let dir = o.shot?.facing ?? 1, auto = !o.shot; let drv: PreviewDriver | undefined; let disposed = false;
  const wrap = doc.createElement("div"); wrap.dataset["boot"] = "creator"; wrap.className = "boot creator"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-label", "Create your character");
  wrap.setAttribute("style", "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(30,20,28,.72);padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)");
  const panel = doc.createElement("div"); panel.className = "panel ui-scroll";
  panel.setAttribute("style", "max-height:calc(100dvh - 24px - var(--kb-inset,0px));box-sizing:border-box;width:min(760px,calc(100vw - 16px));max-width:100%;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;display:flex;flex-direction:row;flex-wrap:wrap;align-content:flex-start;gap:12px;background:#FFF3DC;border:3px solid #3B2433;border-radius:16px;padding:14px");
  const h = doc.createElement("h2"); h.textContent = o.title ?? (o.initial ? "Edit character" : "Create your character"); h.style.cssText = "flex:1 1 100%;margin:0";
  const left = doc.createElement("div"); left.style.cssText = "flex:1 1 220px;min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px";
  // preview host: sketch canvas until the sprite preview (WebGL2 / Canvas2D) is up; drag on it turns the character
  // ADR-502: no background on the host — the doll sits on the panel cream (#FFF3DC). preview_bg.png/@2x are left
  // on disk unused (the snapshot push route cannot express file deletions).
  const host = doc.createElement("div"); host.dataset["role"] = "creator-preview-host"; host.style.cssText = `position:relative;width:${PREVIEW_CSS.w}px;height:${PREVIEW_CSS.h}px;border-radius:12px;touch-action:none;user-select:none`;
  const cv = doc.createElement("canvas"); cv.width = 160; cv.height = 200; cv.dataset["role"] = "creator-preview"; cv.dataset["renderer"] = "sketch"; cv.style.cssText = `width:${PREVIEW_CSS.w}px;height:${PREVIEW_CSS.h}px;border-radius:12px`; host.append(cv);
  let g: CanvasRenderingContext2D | null = null; try { g = cv.getContext("2d"); } catch { /* no 2D canvas (tests) */ }
  const t0 = Date.now(); const draw = (): void => { if (drv) { drv.facing(dir); drv.frame(o.shot ? 0 : (Date.now() - t0) / 1000); } else if (g && cat) drawPreview(g, cat, look, ([0, 1, 1, 2, 2, 3, 3, 0] as const)[dir]!); };
  const turn = (d: number): void => { dir = (dir + d + 8) % 8; draw(); };
  { let px = 0, down = false, acc = 0; host.addEventListener("pointerdown", (ev) => { down = true; px = ev.clientX; acc = 0; auto = false; host.setPointerCapture?.(ev.pointerId); });
    host.addEventListener("pointermove", (ev) => { if (!down) return; acc += ev.clientX - px; px = ev.clientX; while (Math.abs(acc) >= 32) { const s = Math.sign(acc); turn(-s); acc -= s * 32; } });
    const up = (): void => { down = false; }; host.addEventListener("pointerup", up); host.addEventListener("pointercancel", up); }
  const win0 = doc.defaultView; // rAF is paused in hidden / occluded (background headless) tabs: each wait also resolves on a 100 ms timer
  const frames = (n: number): Promise<void> => new Promise((r) => { const f = (): void => { if (n-- <= 0 || !win0?.requestAnimationFrame) { r(); return; }
    let done = false; const go = (): void => { if (!done) { done = true; f(); } }; win0.requestAnimationFrame(go); win0.setTimeout?.(go, 100); }; f(); });
  const stage = (s: string): void => { o.shot?.onStage?.(s); };
  const ready = (kind: PreviewDriver["kind"]): void => { if (!o.shot || disposed) return; stage(`frames:${kind}`); draw(); void frames(2).then(() => { if (!disposed) { draw(); wrap.dataset["ready"] = "1"; o.shot?.onReady({ renderer: kind }); } }); };
  stage("preview"); if (o.preview) void createPreviewDriver(host, o.preview, look, dir, !!o.shot?.freeze).then(async (d) => { if (!d) { ready("sketch"); return; } if (disposed) { d.dispose(); return; } drv = d; cv.remove(); wrap.dataset["preview"] = d.kind; if (d.upgraded) void d.upgraded.then(() => { if (!disposed) wrap.dataset["preview"] = d.kind; }); if (!o.shot) d.set(look); draw(); stage(`loading:${d.kind}`); await d.loaded?.catch(() => undefined); ready(d.kind); });
  else queueMicrotask(() => ready("sketch"));
  const right = doc.createElement("div"); right.style.cssText = "flex:2 1 240px;min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 8px;align-items:center";
  const mk = (t: string, act: string, fn: () => void, cls = "alt"): HTMLButtonElement => { const b = doc.createElement("button"); b.type = "button"; b.textContent = t; b.className = cls; b.dataset["action"] = act; b.style.minHeight = "44px"; b.addEventListener("click", fn); return b; };
  const rot = doc.createElement("div"); rot.style.cssText = "display:flex;gap:6px";
  const rl = mk("⟲", "rotate-left", () => { auto = false; turn(-1); }), rr = mk("⟳", "rotate-right", () => { auto = false; turn(1); });
  // Task 25: the 🎲 fallback text is plain "Random" now — iconInto swaps in the atlas ic_randomize art when it exists.
  const rnd = mk("Random", "randomize", () => { if (cat) { look = randomLook(cat); refresh(); } });
  iconInto(rl, o.artBase, "ic_rotate_left", "Rotate left"); iconInto(rr, o.artBase, "ic_rotate_right", "Rotate right"); iconInto(rnd, o.artBase, "ic_randomize", "Randomize");
  rot.append(rl, rnd, rr); left.append(host, rot);
  const nameIn = doc.createElement("input"); nameIn.type = "text"; nameIn.maxLength = NAME_MAX; nameIn.placeholder = "Survivor name"; nameIn.value = name; nameIn.dataset["role"] = "creator-name"; nameIn.setAttribute("autocomplete", "nickname"); nameIn.setAttribute("enterkeyhint", "done"); nameIn.id = "creator-name-input";
  nameIn.style.cssText = "min-height:44px;font:600 18px system-ui;padding:4px 8px;box-sizing:border-box;flex:1;min-width:0"; nameIn.addEventListener("input", () => { name = nameIn.value; });
  // Task 20: tapping the input leaves fullscreen so the phone IME can draw (see fullscreen.ts);
  // the focus handler below re-exits after any tap in this dialog (e.g. the empty-name refocus,
  // where the Enter button's pointerup may have restored fullscreen first).
  bindTypingFullscreenExit(nameIn);
  // Task 18: when the phone keyboard opens, keep the name field in view inside
  // the (now keyboard-shrunk) panel instead of letting it sit behind the IME.
  // Task 20: the wrapTouched gate keeps the programmatic focus() on open from exiting fullscreen
  // (no keyboard is open yet at open time); any later focus follows a real tap in this dialog.
  let wrapTouched = false;
  wrap.addEventListener("pointerdown", () => { wrapTouched = true; }, true);
  nameIn.addEventListener("focus", () => { if (wrapTouched) exitFullscreenForTyping(); try { nameIn.scrollIntoView?.({ block: "nearest" }); } catch { /* headless harnesses */ } });
  const nl = doc.createElement("label"); nl.textContent = "Name"; nl.htmlFor = nameIn.id;
  // Task 20: the label cell is the full 44px row height (not just the "Name" glyphs), so the whole
  // label column is a tap target; its pointerdown also leaves fullscreen for typing.
  nl.style.cssText = "min-height:44px;display:flex;align-items:center;cursor:pointer";
  nl.addEventListener("pointerdown", () => exitFullscreenForTyping());
  // Task 17: the creator opens asynchronously (after art/catalog loads), so the
  // focus() on open runs outside any tap gesture and mobile browsers will not
  // open the virtual keyboard for it. Tapping the label focuses the input inside
  // the tap handler (a real gesture), which reliably summons the keyboard; the
  // htmlFor association covers browsers with native label behaviour, and this
  // handler covers the rest. The input itself is unchanged for desktop/gamepad.
  nl.addEventListener("click", () => { nameIn.focus(); });
  // Task 27: Roll button next to the Name field — a random "First Last" from the list matching the
  // currently selected body type (Male -> male list, Female -> female list; switching Body then
  // rolling uses the new list). Synchronous inside the click gesture (same constraint as the
  // Task 17/20 keyboard-focus work: no async indirection that would break focus on mobile), and
  // it writes the same `name` the Enter-world check reads, so the name-required rule is unchanged.
  // The button is a normal focusable control, so gamepad D-pad navigation reaches it like the
  // other creator buttons; the dice art is the Task 25 custom icon, with the "Roll" text as fallback.
  const nameBox = doc.createElement("div"); nameBox.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0";
  const roll = mk("Roll", "roll-name", () => { const n = randomName(look.bodyType, Math.random, name); name = n; nameIn.value = n; msg.textContent = ""; });
  roll.setAttribute("aria-label", "Roll a random name"); roll.title = "Roll a random name"; roll.style.cssText = "min-height:44px;display:inline-flex;align-items:center;gap:6px;flex:none";
  const rollImg = doc.createElement("img"); rollImg.alt = ""; rollImg.width = 24; rollImg.height = 24; rollImg.src = iconUrl("ic_dice.png");
  rollImg.style.cssText = "width:24px;height:24px;image-rendering:pixelated;flex:none"; rollImg.addEventListener("error", () => rollImg.remove()); roll.prepend(rollImg);
  nameBox.append(nameIn, roll);
  right.append(nl, nameBox);
  // Task 20: taps landing in the Name row's dead zones (the grid gap, or the row's empty grid area)
  // must still reach the input — previously only a tap squarely on the input or the label text
  // focused it, which is what made the row feel oddly picky on phones. Clicks on any child
  // (buttons, inputs) keep their own behaviour; only clicks whose target IS the row container
  // itself — or the Name box wrapping the input + Roll button (Task 27: its 6px gap is a new
  // dead zone) — inside the name row's vertical band, are retargeted.
  const nameBand = (y: number): boolean => { const r = nameIn.getBoundingClientRect(); return y >= r.top && y <= r.bottom; };
  right.addEventListener("pointerdown", (e) => { if ((e.target === right || e.target === nameBox) && nameBand(e.clientY)) exitFullscreenForTyping(); });
  right.addEventListener("click", (e) => { if ((e.target === right || e.target === nameBox) && nameBand(e.clientY)) nameIn.focus(); });
  const vals = new Map<string, HTMLElement>();
  const row = (label: string, field: Parameters<typeof stepLook>[2]): void => {
    const l = doc.createElement("span"); l.textContent = label; const box = doc.createElement("div"); box.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0";
    const val = doc.createElement("span"); val.dataset["role"] = `creator-${field}`; val.style.cssText = "flex:1;text-align:center;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"; vals.set(field, val);
    const step = (d: number): void => { if (cat) { look = stepLook(cat, look, field, d); refresh(); } };
    box.append(mk("◀", `prev-${field}`, () => step(-1)), val, mk("▶", `next-${field}`, () => step(1))); right.append(l, box);
  };
  row("Body", "body"); row("Skin", "skin");
  // ADR-245: every skin tone as a swatch (ramp.base = the intended on-screen colour), light -> deep
  const skinChips: HTMLButtonElement[] = [];
  if (cat?.skinTones.length) { const grid = doc.createElement("div"); grid.dataset["role"] = "creator-skin-swatches"; grid.setAttribute("role", "radiogroup"); grid.setAttribute("aria-label", "Skin tone");
    grid.style.cssText = "grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;min-width:0";
    cat.skinTones.forEach((t, i) => { const b = doc.createElement("button"); b.type = "button"; b.dataset["action"] = `skin-${i}`; b.dataset["swatch"] = hex(swatchColor(t), ""); b.title = t.key.replace(/_/g, " ");
      b.setAttribute("aria-label", t.key.replace(/_/g, " ")); b.setAttribute("role", "radio");
      b.style.cssText = `width:30px;height:30px;min-height:30px;padding:0;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #0004;background:${hex(swatchColor(t), "#000")}`;
      b.addEventListener("click", () => { look = { ...look, skinTone: i }; refresh(); }); skinChips.push(b); grid.append(b); });
    right.append(grid); }
  const c2 = (s: WearableSlot, label: string): void => { if (cat && slotHasColor2(cat, s)) row(label, `${s}:color2`); };
  row("Hair", "hair"); row("Hair colour", "hair:color"); c2("hair", "Hair secondary colour"); row("Face / beard", "face"); c2("face", "Face secondary colour"); row("Eyes", "eyes");
  row("Eye colour", "eyes:color"); c2("eyes", "Eye secondary colour");
  // Task 23: no clothing rows (top / bottom / shoes) and no shared secondary-colour row — a new survivor starts
  // with no clothes and crafts them in game. Say so plainly under the options.
  const noClothes = doc.createElement("p"); noClothes.dataset["role"] = "creator-no-clothes"; noClothes.textContent = "No starting clothes — craft clothing in game to stay warm and dry.";
  noClothes.style.cssText = "grid-column:1 / -1;margin:0;font-size:14px"; right.append(noClothes);
  const msg = doc.createElement("p"); msg.dataset["role"] = "creator-msg"; msg.style.cssText = "flex:1 1 100%;margin:0;min-height:1.2em";
  const foot = doc.createElement("div"); foot.className = "sticky-footer"; foot.style.cssText = "flex:1 1 100%;display:flex;flex-wrap:wrap;gap:8px;position:sticky;bottom:-14px;margin-bottom:-14px;padding-bottom:14px;background:#FFF3DC;padding-top:6px";
  let done: (v: StoredCharacter | undefined) => void = () => undefined;
  // Gamepad (Xbox Edge has no usable system keyboard): A on the name field / Enter world with no name opens the shared
  // on-screen keyboard editor on its own UINav (the creator's pad loop pauses while it is open).
  let oskNav: UINav | undefined;
  const openNameOsk = (): void => {
    if (oskNav) return;
    const nav = new UINav({ root: wrap, history: false, ignoreBoot: true, ...(o.pads ? { getGamepads: o.pads as never } : {}) }); oskNav = nav;
    const ed = buildSignEditor({ kindName: "survivor name", saveLabel: "Use name", maxLen: NAME_MAX, initial: name, keyboard: true,
      close: () => nav.close(), onSave: (t) => { if (t) { name = t; nameIn.value = t; msg.textContent = ""; } } });
    ed.dataset["role"] = "creator-osk";
    nav.open("creator-name", ed, () => { setTimeout(() => nav.destroy(), 0); oskNav = undefined; padHold = true; (cleanName(name) ? ok : nameIn).focus(); });
  };
  let padHold = false;
  const ok = mk("Enter world", "creator-done", () => { const n = cleanName(name); if (!n) { msg.textContent = "Pick a name for your survivor."; nameIn.focus(); if (padActive) openNameOsk(); return; } done({ v: 1, name: n, appearance: look, skinScheme: SKIN_TONE_SCHEME }); }, "");
  foot.append(mk("Back", "creator-back", () => done(undefined)), ok);
  panel.append(h, left, right, msg, foot); wrap.append(panel);
  function refresh(): void {
    const label = (f: string): string => {
      if (f === "body") return (BODY_TYPES[look.bodyType] ?? "male").replace(/^./, (c) => c.toUpperCase());
      if (f === "skin") return cat?.skinTones[look.skinTone]?.key?.replace(/_/g, " ") ?? `Tone ${look.skinTone + 1}`;
      if (f.endsWith(":color2")) { const s = f.slice(0, -7) as WearableSlot; const i = look.secondary[slotIndex(s)] ?? 0; const pc = isHairish(s) ? cat?.hairColors : cat?.clothingColors; return pc?.[i]?.key?.replace(/_/g, " ") ?? `Colour ${i + 1}`; }
      if (f.endsWith(":color")) { const s = f.slice(0, -6) as WearableSlot; const i = look.primary[slotIndex(s)] ?? 0; const pc = isHairish(s) ? cat?.hairColors : cat?.clothingColors; return pc?.[i]?.key?.replace(/_/g, " ") ?? `Colour ${i + 1}`; }
      return cat ? partName(cat, look.parts[slotIndex(f as WearableSlot)] ?? 0) : "—";
    };
    const swatch = (f: string): number | undefined => { if (!cat) return undefined; if (f === "skin") return swatchColor(cat.skinTones[look.skinTone]);
      if (f.endsWith(":color2")) { const s = f.slice(0, -7) as WearableSlot; return (isHairish(s) ? cat.hairColors : cat.clothingColors)[look.secondary[slotIndex(s)] ?? 0]?.color; }
      if (f.endsWith(":color")) { const s = f.slice(0, -6) as WearableSlot; return (isHairish(s) ? cat.hairColors : cat.clothingColors)[look.primary[slotIndex(s)] ?? 0]?.color; } return undefined; };
    skinChips.forEach((b, i) => { const on = i === look.skinTone; b.setAttribute("aria-checked", on ? "true" : "false"); b.style.boxShadow = on ? "0 0 0 3px #3B2433" : "0 0 0 1px #0004"; });
    for (const [f, el] of vals) { el.textContent = label(f); const c = swatch(f); if (c !== undefined) { el.style.borderBottom = `6px solid ${hex(c, "#000")}`; el.dataset["swatch"] = hex(c, ""); } } drv?.set(look); draw();
  }
  refresh();
  // keyboard / gamepad focus navigation over the dialog's controls
  const focusables = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>("input,button:not(:disabled)"));
  const move = (d: number): void => { const f = focusables(); const i = f.indexOf(doc.activeElement as HTMLElement); const n = f[(i + d + f.length) % f.length]; n?.focus(); n?.scrollIntoView?.({ block: "nearest" }); };
  const onKey = (e: KeyboardEvent): void => {
    // ADR-213: Edge on Xbox sends the controller as keys (GamepadDPadDown / keyCode 204 / GamepadA): same actions as the pad poll
    const pk = padKeyEdge(e); if (pk !== undefined) { e.preventDefault(); padActive = true; if (pk && !oskNav) padDo(pk); return; }
    if (e.type !== "keydown") return;
    const typing = doc.activeElement === nameIn;
    if (!typing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { const bs = (doc.activeElement as HTMLElement | null)?.parentElement?.querySelectorAll<HTMLButtonElement>("button"); if (bs && bs.length === 2) { bs[e.key === "ArrowLeft" ? 0 : 1]!.click(); e.preventDefault(); return; } }
    if (e.key === "Escape") { done(undefined); e.preventDefault(); }
    else if (e.key === "ArrowDown") { move(1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { move(-1); e.preventDefault(); }
    else if (e.key === "Enter" && typing) { ok.click(); e.preventDefault(); }
  };
  doc.addEventListener("keydown", onKey); doc.addEventListener("keyup", onKey);
  const pads = o.pads ?? (() => (typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : []));
  let raf = 0, last = 0, padActive = false; const win = doc.defaultView;
  // ADR-213: all connected pads merged + mapping "" normalised (navPad); D-pad / stick repeat; shared with the pad-key path
  const edges = new PadEdges(["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "Y", "LB", "RB", "START"]);
  const padDo = (c: PadControl): void => {
    traceAction(`creator ${c}`); markNavFocus();
    if (c === "LB" || c === "RB") { auto = false; turn(c === "LB" ? -1 : 1); return; }
    if (c === "DOWN") { move(1); return; } if (c === "UP") { move(-1); return; }
    const a = doc.activeElement as HTMLElement | null; const rowBox = a?.parentElement;
    if (c === "LEFT" || c === "RIGHT") { const bs = rowBox?.querySelectorAll<HTMLButtonElement>("button"); if (bs && bs.length === 2) bs[c === "LEFT" ? 0 : 1]!.click(); return; } // ◀ ▶ row steps the value
    if (c === "A" && a) { if (a === nameIn) openNameOsk(); else a.click(); return; }
    if (c === "B") { done(undefined); return; }
    if (c === "Y" && cat) { look = randomLook(cat); refresh(); return; }
    if (c === "START") ok.click(); // TV: Start = Enter world without D-padding past ~30 rows
  };
  const tick = (t: number): void => {
    if (disposed) return; // ok.click() inside this tick resolves the dialog: never re-arm (a zombie loop kept clicking in-game menus)
    if (auto && t - last > 900) { last = t; turn(1); } else if (drv?.kind === "canvas2d") draw(); // 2D: idle anim frames
    let gp = navPad(pads as never);
    if (gp && padHold) { if (gp.buttons.some((x) => x.pressed)) gp = undefined; else padHold = false; } // buttons from the OSK editor: wait for release
    if (gp && oskNav) gp = undefined;
    if (!gp) edges.hold(navPad(pads as never));
    else { if (gp.buttons.some((x) => x.pressed)) padActive = true;
      for (const c of edges.step(gp, t)) { padDo(c); if (disposed) return; } }
    if (disposed) return;
    raf = win?.requestAnimationFrame?.(tick) ?? 0;
  };
  raf = win?.requestAnimationFrame?.(tick) ?? 0;
  o.root.append(wrap);
  // Task 18: shrink the fixed overlay + panel above the phone keyboard (the
  // --kb-inset var the panel's max-height subtracts); no-op on desktop.
  const kbWin = doc.defaultView;
  const uninstallKb = kbWin ? installKeyboardViewport(wrap, kbWin) : undefined;
  (o.initial ? ok : nameIn).focus();
  return new Promise((resolve) => { done = (v) => { disposed = true; oskNav?.destroy(); oskNav = undefined; drv?.dispose(); drv = undefined; doc.removeEventListener("keydown", onKey); doc.removeEventListener("keyup", onKey); if (raf) win?.cancelAnimationFrame?.(raf); uninstallKb?.(); wrap.remove(); resolve(v); }; });
}
