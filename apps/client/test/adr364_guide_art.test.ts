// @vitest-environment jsdom
// ADR-364: guide art — every picture the guide shows is the game's own art, pixel-checked.
// - All 15 section icons resolve (the two ADR-363 gaps, pet:dog_lab and mount:horse, close via the new
//   atlas-crop rules in gameplay-panels.css); the rules' --cz-isize/--cz-ipos are re-derived from the
//   nature manifest and both atlas rects are decoded from the shipped PNGs and shown non-blank.
// - Every action image in guide.json exists in the GUIDE_ACTION_IMAGES registry, every registry entry is
//   used, and every tile is non-blank by pixel check: atlas tiles are decoded from the shipped PNG at
//   exactly the cell the CSS shows; runtime tiles (store / vehicle / ghost) are checked from the painters
//   that produce them. Manifest/CSS presence alone is never proof of pixels (the ADR-357 lesson).
// - The hologram tile is the ore store's own world art in the game's ghost treatment (sprites.ts: mix
//   toward green by 0.68, alpha ~0.62), pixel-identical to the solid icon except for that treatment.
// - The panel renders every image with its tiles in order, the right join and the caption, and no <img>.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { getGuideSections, resolvedGuideSection } from "@engine/gameplay";
import { buildGuidePanel, guideIconKey } from "../src/guide-panel.js";
import { iconKeysFromCss } from "../src/gameplay-panels.js";
import { installStoreMenuIcons, paintStoreMenuIconPixels, storeMenuIconsCss, STORE_MENU_ICON_KEYS } from "../src/task355-art.js";
import { installVehicleMenuIcons, paintVehicleMenuIconPixels, vehicleMenuIconsCss, VEHICLE_MENU_ICON_KEYS } from "../src/task361-art.js";
import {
  GUIDE_ACTION_IMAGES, GUIDE_GHOST_ALPHA, GUIDE_GHOST_ICON_KEY, GUIDE_GHOST_MIX, GUIDE_GHOST_TINT, GUIDE_GHOST_STORE,
  guideActionImage, guideArtCss, guideGhostDataUrl, installGuideArt, paintGuideGhostPixels,
} from "../src/task364-art.js";

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

const ROOT = resolve(__dirname, "../../../");
const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
const itemsManifest = readJson("packages/assets/pack/items/manifest.items.json") as {
  atlases: { key: string; image: string; frameW: number; frameH: number; columns: number; rows: number }[];
  sprites: { key: string; atlas: string; animations: { idle: { frames: number[] } } }[];
};
const natureManifest = readJson("packages/assets/pack/nature/manifest.nature.json") as {
  atlases: { key: string; image: string }[];
  sprites: { key: string; atlas: string; animations: { idle: { frames: number[]; directions: number; dirFrames: { atlas: string; rect: { x: number; y: number; w: number; h: number } }[] } } }[];
};
const cssText = readFileSync(resolve(ROOT, "apps/client/src/gameplay-panels.css"), "utf8");
const shippedKeys = iconKeysFromCss([cssText]);

// ---- minimal PNG decode (8-bit RGB/RGBA, non-interlaced — the pattern from packages/assets/test/clan_palettes.test.ts)
function png(file: string): { w: number; h: number; ch: number; px: Uint8Array } {
  const b = readFileSync(file); let o = 8; let w = 0, h = 0, ch = 0; const idat: Buffer[] = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o), t = b.toString("ascii", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[12] !== 0) throw new Error(`${file}: unsupported PNG`); ch = d[9] === 6 ? 4 : d[9] === 2 ? 3 : 0; if (!ch) throw new Error(`${file}: unsupported colour type ${d[9]}`); }
    else if (t === "IDAT") idat.push(d); else if (t === "IEND") break;
    o += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)); const st = w * ch; const px = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)]!; const src = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)); const row = y * st;
    for (let x = 0; x < st; x++) {
      const a = x >= ch ? px[row + x - ch]! : 0, up = y ? px[row - st + x]! : 0, c = y && x >= ch ? px[row - st + x - ch]! : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      px[row + x] = (src[x]! + pred) & 255;
    }
  }
  return { w, h, ch, px };
}

/** Opaque-pixel count + colour signature of one rect (alpha > 16 counts as opaque). */
function rectSig(img: { w: number; ch: number; px: Uint8Array }, x: number, y: number, w: number, h: number): { opaque: number; sig: string; meanR: number; meanG: number; meanB: number } {
  let opaque = 0, r = 0, g = 0, b = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * img.w + xx) * img.ch;
    const a = img.ch === 4 ? img.px[i + 3]! : 255;
    if (a > 16) { opaque++; r += img.px[i]!; g += img.px[i + 1]!; b += img.px[i + 2]!; }
  }
  return { opaque, sig: `${opaque}:${Math.round(r / Math.max(1, opaque))}:${Math.round(g / Math.max(1, opaque))}:${Math.round(b / Math.max(1, opaque))}`, meanR: r / Math.max(1, opaque), meanG: g / Math.max(1, opaque), meanB: b / Math.max(1, opaque) };
}
/** Same signature shape for a painter's RGBA buffer. */
function bufSig(pixels: Uint8ClampedArray): { opaque: number; sig: string; meanR: number; meanG: number; meanB: number } {
  let opaque = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]! > 16) { opaque++; r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!; }
  return { opaque, sig: `${opaque}:${Math.round(r / Math.max(1, opaque))}:${Math.round(g / Math.max(1, opaque))}:${Math.round(b / Math.max(1, opaque))}`, meanR: r / Math.max(1, opaque), meanG: g / Math.max(1, opaque), meanB: b / Math.max(1, opaque) };
}

/** Atlas cell rect for an items-manifest sprite key (uniform grid: frame -> col/row). */
function itemsCell(key: string): { file: string; x: number; y: number; w: number; h: number } {
  const s = itemsManifest.sprites.find((x) => x.key === key);
  expect(s, key).toBeDefined();
  const a = itemsManifest.atlases.find((x) => x.key === s!.atlas)!;
  const f = s!.animations.idle.frames[0]!;
  return { file: resolve(ROOT, "packages/assets/pack/items/", a.image), x: (f % a.columns) * a.frameW, y: Math.floor(f / a.columns) * a.frameH, w: a.frameW, h: a.frameH };
}
/** The SW (direction 3) idle frame rect for a nature sprite — frame-major dirFrames (frame * dirs + dir). */
function natureDir3(key: string): { file: string; x: number; y: number; w: number; h: number } {
  const s = natureManifest.sprites.find((x) => x.key === key);
  expect(s, key).toBeDefined();
  const dirs = s!.animations.idle.directions;
  const r = s!.animations.idle.dirFrames[3]!.rect; // frame 0, direction 3
  expect(s!.animations.idle.dirFrames.length).toBe(s!.animations.idle.frames.length * dirs);
  const a = natureManifest.atlases.find((x) => x.key === s!.atlas)!;
  return { file: resolve(ROOT, "packages/assets/pack/nature/", a.image), x: r.x, y: r.y, w: r.w, h: r.h };
}

const fakeStoreUrls = new Map(STORE_MENU_ICON_KEYS.map((s) => [`${s}`, `data:image/png;base64,store-${s}`]));
const fakeVehicleUrls = new Map(VEHICLE_MENU_ICON_KEYS.map((k) => [k, `data:image/png;base64,vehicle-${k}`]));
const fakeGuideUrls = new Map([[GUIDE_GHOST_STORE, "data:image/png;base64,ghost-ore_store"]]);
/** Every [data-icon] key the player can see: the shipped stylesheet plus the three runtime installs. */
const effectiveKeys = new Set([...shippedKeys, ...iconKeysFromCss([storeMenuIconsCss(fakeStoreUrls), vehicleMenuIconsCss(fakeVehicleUrls), guideArtCss(fakeGuideUrls)])]);

describe("ADR-364 guide section icons", () => {
  it("all 15 sections resolve an icon against the shipped + runtime art (both ADR-363 gaps closed)", () => {
    const has = (k: string): boolean => effectiveKeys.has(k);
    const sections = getGuideSections();
    expect(sections).toHaveLength(15);
    for (const s of sections) expect(guideIconKey(s.icon, has), s.id).toBeDefined();
    expect(guideIconKey("pet:dog_lab", has)).toBe("pet_dog_lab");
    expect(guideIconKey("mount:horse", has)).toBe("mount_horse");
    expect(guideIconKey("pet:no_such_pet", has)).toBeUndefined();
    expect(guideIconKey("mount:no_such_mount", has)).toBeUndefined();
  });

  it("the pet/mount CSS rules crop the SW idle frame, and both atlas rects are non-blank", () => {
    for (const [icon, sprite] of [["pet_dog_lab", "animal_dog_lab"], ["mount_horse", "mount_horse"]] as const) {
      const cell = natureDir3(sprite);
      const img = png(cell.file);
      // The rule must point at the atlas the manifest names, at both scales.
      const atlas = sprite === "animal_dog_lab" ? "pets_dog_lab" : "nature_mounts_horse_0";
      expect(cssText).toContain(`[data-icon="${icon}"]{--cz-icon:image-set(url("../../../packages/assets/pack/nature/atlases/${atlas}.png") 1x, url("../../../packages/assets/pack/nature/atlases/${atlas}@2x.png") 2x);`);
      // --cz-isize/--cz-ipos re-derived from the manifest rect (a manifest move fails here, not in front of a player).
      // The CSS carries the generator's 4-significant-figure values, so compare against that rounding exactly.
      const g4 = (x: number): number => Number(x.toPrecision(4));
      const m = new RegExp(`\\[data-icon="${icon}"\\]\\{[^}]*--cz-isize:([\\d.]+)% ([\\d.]+)%;--cz-ipos:([\\d.]+)% ([\\d.]+)%\\}`).exec(cssText);
      expect(m, icon).not.toBeNull();
      const [, sw, sh, px, py] = m!.map(Number);
      expect(sw!).toBe(g4((img.w / cell.w) * 100));
      expect(sh!).toBe(g4((img.h / cell.h) * 100));
      expect(px!).toBe(g4((cell.x / (img.w - cell.w)) * 100));
      expect(py!).toBe(g4((cell.y / (img.h - cell.h)) * 100));
      // The rect itself: a real picture, not a blank tile — at 1x and at 2x.
      const s1 = rectSig(img, cell.x, cell.y, cell.w, cell.h);
      expect(s1.opaque, `${icon} 1x`).toBeGreaterThan(40);
      const img2 = png(cell.file.replace(/\.png$/, "@2x.png"));
      expect([img2.w, img2.h]).toEqual([img.w * 2, img.h * 2]);
      const s2 = rectSig(img2, cell.x * 2, cell.y * 2, cell.w * 2, cell.h * 2);
      expect(s2.opaque, `${icon} 2x`).toBeGreaterThan(40);
      expect(s1.sig).not.toBe(s2.sig); // different resolutions, different pixel counts — the check really ran twice
    }
  });
});

describe("ADR-364 guide action images", () => {
  it("every image id in guide.json exists in the registry, and every registry entry is used", () => {
    const used = getGuideSections().flatMap((s) => resolvedGuideSection(s.id)!.items.filter((i) => i.kind === "image").map((i) => (i.kind === "image" ? i.image : "")));
    expect(used).toEqual(["cook-fire", "place-hologram", "claim-base", "tame-feed", "use-trough", "harness-mount"]);
    for (const id of used) {
      const g = guideActionImage(id);
      expect(g, id).toBeDefined();
      expect(g!.tiles.length).toBeGreaterThanOrEqual(2);
      expect(new Set(g!.tiles).size).toBe(g!.tiles.length); // no tile twice in one image
    }
    expect(GUIDE_ACTION_IMAGES.map((g) => g.id).sort()).toEqual([...used].sort()); // no dead registry entries
    expect(guideActionImage("no-such-image")).toBeUndefined();
  });

  it("every tile shows real pixels: atlas cells decoded from the shipped PNGs, runtime tiles from their painters", () => {
    const atlasKeys = ["build_claim_totem", "build_clan_flag", "build_campfire", "stew_bowl", "pet_dog_lab", "dog_biscuit", "build_feeding_trough", "animal_feed", "mount_horse"];
    const pngCache = new Map<string, ReturnType<typeof png>>();
    const img = (file: string): ReturnType<typeof png> => { let i = pngCache.get(file); if (!i) pngCache.set(file, (i = png(file))); return i; };
    for (const g of GUIDE_ACTION_IMAGES) {
      const sigs = new Set<string>();
      for (const key of g.tiles) {
        if (atlasKeys.includes(key)) {
          // The shipped CSS has the rule, and the cell it shows is non-blank.
          expect(shippedKeys.has(key), `${g.id}: ${key}`).toBe(true);
          const cell = key === "pet_dog_lab" ? natureDir3("animal_dog_lab") : key === "mount_horse" ? natureDir3("mount_horse") : itemsCell(key);
          const s = rectSig(img(cell.file), cell.x, cell.y, cell.w, cell.h);
          expect(s.opaque, `${g.id}: ${key}`).toBeGreaterThan(40);
          sigs.add(s.sig);
        } else if (key === "build_ore_store") {
          // The shipped items_build frame 297 IS blank (0 opaque) — that is why the tile's pixels come
          // from the ADR-357 runtime painter, not the atlas cell.
          const cell = itemsCell("build_ore_store");
          expect(rectSig(img(cell.file), cell.x, cell.y, cell.w, cell.h).opaque, "frame 297 stays blank in the shipped atlas").toBe(0);
          expect(shippedKeys.has(key), key).toBe(true); // the rule exists; the installed override supplies the pixels
          const s = bufSig(paintStoreMenuIconPixels("ore_store").pixels);
          expect(s.opaque, `${g.id}: ${key}`).toBeGreaterThan(40);
          sigs.add(s.sig);
        } else if (key === "harness" || key === "item_vehicle_kit_cart") {
          expect((VEHICLE_MENU_ICON_KEYS as readonly string[]).includes(key), key).toBe(true);
          const s = bufSig(paintVehicleMenuIconPixels(key as "harness" | "item_vehicle_kit_cart").pixels);
          expect(s.opaque, `${g.id}: ${key}`).toBeGreaterThan(40);
          sigs.add(s.sig);
        } else if (key === GUIDE_GHOST_ICON_KEY) {
          const s = bufSig(paintGuideGhostPixels().pixels);
          expect(s.opaque, `${g.id}: ${key}`).toBeGreaterThan(40);
          sigs.add(s.sig);
        } else {
          throw new Error(`${g.id}: tile ${key} has no pixel source — an invented tile`);
        }
      }
      expect(sigs.size, `${g.id}: every tile is a different picture`).toBe(g.tiles.length);
    }
  });

  it("the ghost is the solid store icon in the game's ghost treatment — same picture, green and faded", () => {
    const solid = paintStoreMenuIconPixels(GUIDE_GHOST_STORE);
    const ghost = paintGuideGhostPixels(GUIDE_GHOST_STORE);
    expect([ghost.width, ghost.height]).toEqual([solid.width, solid.height]);
    const smooth = (x: number): number => { const t = Math.max(0, Math.min(1, (x - 0.35) / 0.4)); return t * t * (3 - 2 * t); };
    let checked = 0, droppedShadow = 0;
    for (let i = 0; i < solid.pixels.length; i += 4) {
      const sa = solid.pixels[i + 3]!, ga = ghost.pixels[i + 3]!;
      if (sa === 0) { expect(ga).toBe(0); continue; }
      // The shader's alpha ramp drops the soft ground shadow (alpha 70) out of the ghost entirely.
      if (sa < 128) { expect(ga, `shadow pixel ${i / 4}`).toBe(0); droppedShadow++; continue; }
      checked++;
      for (let c = 0; c < 3; c++) {
        const want = Math.round(solid.pixels[i + c]! * (1 - GUIDE_GHOST_MIX) + GUIDE_GHOST_TINT[c]! * GUIDE_GHOST_MIX);
        expect(Math.abs(ghost.pixels[i + c]! - want), `channel ${c}`).toBeLessThanOrEqual(1);
      }
      // Alpha follows the shader's ramp at the steady ~0.62 (the pulse is 0.54–0.70 around it).
      expect(ga, `alpha of pixel ${i / 4}`).toBe(Math.round(255 * smooth(sa / 255) * GUIDE_GHOST_ALPHA));
    }
    expect(checked).toBeGreaterThan(40);
    expect(droppedShadow).toBeGreaterThan(0);
    const gs = bufSig(ghost.pixels);
    expect(gs.meanG).toBeGreaterThan(gs.meanR); // green-shifted, like the in-game valid ghost
  });

  it("installGuideArt appends one style element, replaces it on re-install, and is a safe no-op without a canvas", () => {
    expect(installGuideArt(document, fakeGuideUrls)).toBe(true);
    const el = document.getElementById("task364-guide-art") as HTMLStyleElement | null;
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe("STYLE");
    expect(el!.textContent).toContain(`[data-icon="${GUIDE_GHOST_ICON_KEY}"]`);
    expect(el!.textContent).toContain("data:image/png;base64,ghost-ore_store");
    const other = new Map([[GUIDE_GHOST_STORE, "data:image/png;base64,other-ghost"]]);
    expect(installGuideArt(document, other)).toBe(true);
    expect(document.querySelectorAll("#task364-guide-art").length).toBe(1);
    expect((document.getElementById("task364-guide-art") as HTMLStyleElement).textContent).toContain("other-ghost");
    expect(guideArtCss(new Map())).toBe("");
    // No canvas in jsdom and no URLs supplied: nothing installed, nothing thrown.
    document.head.innerHTML = "";
    expect(guideGhostDataUrl(GUIDE_GHOST_STORE, document)).toBeUndefined();
    expect(installGuideArt(document)).toBe(false);
    expect(document.getElementById("task364-guide-art")).toBeNull();
  });

  it("every tile key is art the game ships or paints at runtime — nothing invented", () => {
    for (const g of GUIDE_ACTION_IMAGES) {
      for (const key of g.tiles) expect(effectiveKeys.has(key), `${g.id}: ${key}`).toBe(true);
    }
  });
});

describe("ADR-364 guide panel renders the action images", () => {
  const sectionButton = (root: ParentNode, id: string): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>(`[data-guide-section="${id}"]`)!;
  it("each image shows its tiles in order with the right join and caption, and no <img> anywhere", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    // The runtime installs would supply the ghost/harness/kit pixels in production; the structure does
    // not depend on them, so assert it with the shipped + runtime key sets backing the resolver.
    expect(installStoreMenuIcons(document, fakeStoreUrls)).toBe(true);
    expect(installVehicleMenuIcons(document, fakeVehicleUrls)).toBe(true);
    expect(installGuideArt(document, fakeGuideUrls)).toBe(true);
    const withImages = getGuideSections().filter((s) => resolvedGuideSection(s.id)!.items.some((i) => i.kind === "image"));
    expect(withImages.map((s) => s.id)).toEqual(["cooking", "building", "animals", "mounts-vehicles"]);
    for (const s of withImages) {
      sectionButton(el, s.id).click();
      const detail = el.querySelector("[data-role=guide-detail]")!;
      const images = resolvedGuideSection(s.id)!.items.filter((i) => i.kind === "image");
      expect(detail.querySelectorAll("[data-role=guide-image]").length).toBe(images.length);
      for (const item of images) {
        if (item.kind !== "image") continue;
        const g = guideActionImage(item.image)!;
        const fig = detail.querySelector(`[data-role=guide-image][data-image="${item.image}"]`)!;
        expect(Array.from(fig.querySelectorAll("[data-role=guide-img-tile]")).map((t) => (t as HTMLElement).dataset["icon"])).toEqual([...g.tiles]);
        expect(Array.from(fig.querySelectorAll(".guide-img-join")).map((t) => t.textContent)).toEqual(Array(g.tiles.length - 1).fill(g.join));
        expect(fig.querySelector("figcaption")?.textContent).toBe(item.caption);
      }
    }
    // ADR-387: fact rows may contain <img> icons (condition/file kinds), but action-image tiles
    // are [data-icon] spans, never <img>s — so scope the no-<img> rule to the figures themselves.
    for (const fig of Array.from(el.querySelectorAll("[data-role=guide-image]"))) {
      expect(fig.querySelector("img")).toBeNull();
    }
  });
});
