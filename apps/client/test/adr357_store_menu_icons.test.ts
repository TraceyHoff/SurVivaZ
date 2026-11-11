// @vitest-environment jsdom
// ADR-357: the five store build-menu icons are painted at runtime from the stores' own world art
// (apps/client/src/task355-art.ts) because items_build frames 297–301 are transparent in the shipped
// atlas (0 opaque pixels — the snapshot push route carries text only, so no PNG could ship the pixels).
// Verified at the pixel level, not just manifest/CSS presence: each icon IS the store's half-full front
// world cell, the override stylesheet carries all five icons, install is idempotent and a safe no-op
// without a canvas, and the build menu tiles show the painted icons.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";
import {
  installStoreMenuIcons,
  paintStoreMenuIconPixels,
  paintTask355Atlases,
  storeMenuIconsCss,
  storeMenuIconDataUrl,
  STORE_MENU_ICON_KEYS,
  task355Frame,
} from "../src/task355-art.js";

const STORES = [...STORE_MENU_ICON_KEYS] as const;
const fakeUrls = new Map(STORES.map((s) => [s, `data:image/png;base64,${s}`]));

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

/** Opaque-pixel count + dark-plum outline count for a 128×128 pixel block. */
function sig(pixels: Uint8ClampedArray): { opaque: number; outline: number; sig: string } {
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! > 16) {
      opaque++; r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!;
      if (pixels[i] === 40 && pixels[i + 1] === 30 && pixels[i + 2] === 50) outline++;
    }
  }
  return { opaque, outline, sig: `${opaque}:${Math.round(r / Math.max(1, opaque))}:${Math.round(g / Math.max(1, opaque))}:${Math.round(b / Math.max(1, opaque))}` };
}

describe("ADR-357 runtime-painted store menu icons", () => {
  it("each icon is pixel-identical to its store's half-full front world cell, non-blank, outlined, distinct", () => {
    const atlases = paintTask355Atlases();
    const seen = new Set<string>();
    for (const store of STORES) {
      const icon = paintStoreMenuIconPixels(store);
      expect(icon.width).toBe(128); expect(icon.height).toBe(128);
      const s = sig(icon.pixels);
      expect(s.opaque, store).toBeGreaterThan(40); // a real picture, not a blank tile
      expect(s.outline, store).toBeGreaterThan(0); // the 1px dark-plum outline survives
      expect(seen.has(s.sig)).toBe(false); seen.add(s.sig);
      // The half-full front cell: task355Frame(1, 0, 0) = 8 -> col 0, row 1 of the store's atlas.
      const atlas = atlases.find((a) => a.key === `decor_${store}`)!;
      const cell = (frame: number): Uint8ClampedArray => {
        const ox = (frame % 8) * 128, oy = Math.floor(frame / 8) * 128;
        const out = new Uint8ClampedArray(128 * 128 * 4);
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          const si = ((oy + y) * atlas.width + (ox + x)) * 4, di = (y * 128 + x) * 4;
          out[di] = atlas.pixels[si]!; out[di + 1] = atlas.pixels[si + 1]!; out[di + 2] = atlas.pixels[si + 2]!; out[di + 3] = atlas.pixels[si + 3]!;
        }
        return out;
      };
      expect(icon.pixels).toEqual(cell(task355Frame(1, 0, 0)));
      // And it is the half state, not the empty or full cell.
      expect(s.sig).not.toBe(sig(cell(task355Frame(0, 0, 0))).sig);
      expect(s.sig).not.toBe(sig(cell(task355Frame(2, 0, 0))).sig);
    }
    expect(seen.size).toBe(5);
  });

  it("the override stylesheet carries one centred, contained rule per store", () => {
    const css = storeMenuIconsCss(fakeUrls);
    for (const store of STORES) {
      expect(css).toContain(`[data-icon="build_${store}"]{--cz-icon:url("data:image/png;base64,${store}");--cz-ipos:center;--cz-isize:contain}`);
    }
    expect(storeMenuIconsCss(new Map())).toBe("");
  });

  it("install appends one style element, replaces it on re-install, and is a safe no-op without a canvas", () => {
    expect(installStoreMenuIcons(document, fakeUrls)).toBe(true);
    const el = document.getElementById("task355-menu-icons") as HTMLStyleElement | null;
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe("STYLE");
    for (const store of STORES) expect(el!.textContent).toContain(`[data-icon="build_${store}"]`);
    // Re-install with different URLs replaces the element in place (still exactly one).
    const other = new Map(STORES.map((s) => [s, `data:image/png;base64,other-${s}`]));
    expect(installStoreMenuIcons(document, other)).toBe(true);
    expect(document.querySelectorAll("#task355-menu-icons").length).toBe(1);
    expect((document.getElementById("task355-menu-icons") as HTMLStyleElement).textContent).toContain("other-ore_store");
    // No canvas in jsdom and no URLs supplied: nothing installed, nothing thrown.
    document.head.innerHTML = "";
    expect(storeMenuIconDataUrl("ore_store", document)).toBeUndefined();
    expect(installStoreMenuIcons(document)).toBe(false);
    expect(document.getElementById("task355-menu-icons")).toBeNull();
  });

  it("the build menu tiles for the five stores carry the painted icons", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
    const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(me, PlayerId, { id: 7 }).add(me, Membership, { partyId: 0, clanId: 3 });
    const wt = { road: () => {}, roadSurface: () => 0, placeSign: () => true, editNearestSign: () => true, surfaces: ["Dirt Path", "Gravel Road", "Paved Road"] };
    const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, getGamepads: () => [],
      gameplay: { ctx: () => ({ world: w, player: me }), send: () => true, startPlacing: () => {}, worldTools: wt, clanTint: () => undefined } as never });
    expect(installStoreMenuIcons(document, fakeUrls)).toBe(true);
    menus.open("build");
    document.querySelector<HTMLElement>("[data-key=bcat-furniture]")!.click();
    const style = document.getElementById("task355-menu-icons") as HTMLStyleElement;
    for (const store of STORES) {
      const d = G.gameplayDefs(w);
      const p = [...d.pieces.values()].find((x) => (x as { key?: string }).key === store)!;
      const tile = document.querySelector<HTMLElement>(`[data-key=piece-${p.id}]`)!;
      expect(tile.dataset["icon"], store).toBe(`build_${store}`);
      expect(tile.dataset["bicon"], store).toBe("1");
      // The installed override matches this tile's icon key, so the tile shows the painted icon.
      expect(style.textContent).toContain(`[data-icon="${tile.dataset["icon"]}"]`);
    }
  });

  it("the manifest + CSS entries for frames 297–301 stay in place (the future binary art pass's home)", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/items/manifest.items.json"), "utf8")) as {
      sprites: { key: string; atlas?: string; animations?: { idle?: { frames?: number[] } } }[];
    };
    const css = readFileSync(resolve(__dirname, "../src/gameplay-panels.css"), "utf8");
    const frames = { ore_store: 297, log_store: 298, stick_store: 299, crop_store: 300, stone_store: 301 } as const;
    for (const store of STORES) {
      const s = manifest.sprites.find((x) => x.key === `build_${store}`);
      expect(s, store).toBeDefined();
      expect(s!.atlas).toBe("items_build");
      expect(s!.animations!.idle!.frames).toEqual([frames[store]]);
      expect(css).toContain(`[data-icon="build_${store}"]`);
    }
  });
});
