// @vitest-environment jsdom
// ADR-229: build window tiles show Art's items_build icons (selected tier), roads/signs too, clan tint on white cloth, glyph fallback.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { installPermissions, Membership, PlayerId, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";
import { roofMenu } from "../src/roof-menu.js";
import { buildIconKey, iconKeysFromCss, isClanTintedIcon, roadIconKey, signIconKey, SIGN_TOOL_ICON } from "../src/gameplay-panels.js";

const read = (p: string): string => readFileSync(resolve(__dirname, "../../..", p), "utf8");
const manifest = JSON.parse(read("packages/assets/pack/items/manifest.items.json")) as { sprites: { key: string; atlas?: string }[] };
const ART = new Set(manifest.sprites.filter((s) => s.atlas === "items_build").map((s) => s.key));
// Original standalone art may register dedicated build icons outside the legacy items_build sheet.
const standalone = JSON.parse(read("packages/assets/pack/building/manifest.building.json")) as { sprites: { key: string }[] };
for (const s of standalone.sprites) if (s.key.startsWith("build_")) ART.add(s.key);
const CSS = iconKeysFromCss([read("apps/client/src/gameplay-panels.css")]);
const PIECES = (JSON.parse(read("packages/gameplay/data/pieces.json")) as { pieces: { key: string; tiered?: boolean; minTier?: number }[] }).pieces;
// ADR-398: cottage / gambrel / shed roofs are art-gated (roof_forms.json live:false, hidden from the build menu by
// roofMenu until their rfx_ art ships). Art's build_roof_{cottage,gambrel,shed}_tN icons land with that art; then live flips and they are checked here.
const ROOF_FORMS = JSON.parse(read("packages/gameplay/data/roof_forms.json")) as { live: boolean; kinds: Record<string, string> };
const ART_GATED = new Set(ROOF_FORMS.live ? [] : Object.values(ROOF_FORMS.kinds));
const ROADS = JSON.parse(read("packages/gameplay/data/roads.json")) as { roads: { surfaces: { key: string }[] }; signs: { key: string }[] };

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("ADR-229 build window icons", () => {
  test("every piece has an icon for every tier it can be built at (atlas + stylesheet), roads and signs too", () => {
    const has = (k: string): boolean => ART.has(k) && CSS.has(k); const missing: string[] = []; const pending: string[] = [];
    expect(PIECES.length).toBeGreaterThan(100);
    for (const p of PIECES) {
      if (ART_GATED.has(p.key) && !has(`build_${p.key}_t4`)) { expect(roofMenu(PIECES, new Set()).map((q) => q.key), p.key).not.toContain(p.key); continue; }
      if (p.tiered) for (let t = p.minTier ?? 0; t <= 4; t++) { if (buildIconKey(p.key, t, true, has) !== `build_${p.key}_t${t}`) missing.push(`${p.key}@t${t}`); }
      else if (buildIconKey(p.key, 0, false, has) !== `build_${p.key}`) {
        // ADR-250: art-pending pieces borrow a sprite_fallbacks neighbour's tile icon (never the glyph) until Art ships theirs
        const fb = (G.SPRITE_FALLBACKS.sprites as Record<string, { to: string[] }>)[p.key]?.to.map((k) => `build_${k}`) ?? [];
        if (has(`build_${p.key}`) || !fb.includes(buildIconKey(p.key, 0, false, has) ?? "")) missing.push(p.key); else pending.push(p.key);
      }
      // below minTier the nearest tier's art is used, never the glyph
      if (p.tiered) expect(buildIconKey(p.key, 0, true, has), p.key).toBeDefined();
    }
    expect(missing).toEqual([]); expect(pending).toEqual([]); // ADR-250 art shipped: build_basic_storage_box (fallback path stays for future art-pending pieces)
    expect(buildIconKey("basic_storage_box", 0, false, has)).toBe("build_basic_storage_box");
    for (const s of ROADS.roads.surfaces) expect(has(roadIconKey(s.key)), s.key).toBe(true);
    for (const s of ROADS.signs) expect(has(signIconKey(s.key)), s.key).toBe(true);
    expect(has(SIGN_TOOL_ICON)).toBe(true);
    expect(buildIconKey("no_such_piece", 2, true, has)).toBeUndefined(); // -> glyph fallback
    expect(PIECES.filter((p) => isClanTintedIcon(p.key)).map((p) => p.key).sort()).toEqual(["clan_flag", "curtains", "fence_picket", "pottery", "rug_1x1", "rug_2x1", "rug_2x2", "rug_3x2", "rug_round", "rug_runner", "tapestry", "vase"]);
  });

  test("tiles carry the selected tier's icon, cloth tiles the clan tint, road and sign tools their icons", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
    const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(me, PlayerId, { id: 7 }).add(me, Membership, { partyId: 0, clanId: 3 });
    const tints: number[] = []; const wt = { road: () => {}, roadSurface: () => 0, placeSign: () => true, editNearestSign: () => true, surfaces: ["Dirt Path", "Gravel Road", "Paved Road"] };
    const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, getGamepads: () => [],
      gameplay: { ctx: () => ({ world: w, player: me }), send: () => true, startPlacing: () => {}, worldTools: wt, clanTint: (t: number) => { tints.push(t); return t === 3 ? 0x2a6fdb : undefined; } } as never });
    menus.open("build");
    const tile = (k: string): HTMLElement => { const d = G.gameplayDefs(w); const p = [...d.pieces.values()].find((x) => (x as { key?: string }).key === k)!; return document.querySelector<HTMLElement>(`[data-key=piece-${p.id}]`)!; };
    const cat = (k: string): void => document.querySelector<HTMLElement>(`[data-key=bcat-${k}]`)!.click();
    cat("structure"); expect(tile("foundation").dataset["icon"]).toMatch(/^build_foundation_t[0-4]$/);
    document.querySelector<HTMLElement>("[data-key=tier-3]")!.click();
    expect(tile("foundation").dataset["icon"]).toBe("build_foundation_t3"); expect(tile("foundation").dataset["bicon"]).toBe("1");
    expect(tile("foundation").dataset["glyph"]).toBeTruthy(); // kept as the fallback attribute
    cat("rugs"); const rug = tile("rug_2x2");
    expect(rug.dataset["icon"]).toBe("build_rug_2x2"); expect(rug.dataset["tint"]).toBe("clan"); expect(rug.style.getPropertyValue("--bt")).toBe("#2a6fdb");
    expect(tints).toContain(G.clanTintIndex(3));
    cat("roads");
    expect(document.querySelector<HTMLElement>("[data-key=road-1]")!.dataset["icon"]).toBe("build_road_path");
    expect(document.querySelector<HTMLElement>("[data-key=road-3]")!.dataset["icon"]).toBe("build_road_paved");
    expect(document.querySelector<HTMLElement>("[data-key=sign-place]")!.dataset["icon"]).toBe(SIGN_TOOL_ICON);
    expect(document.querySelector<HTMLElement>("[data-key=sign-edit]")!.dataset["icon"]).toBe(SIGN_TOOL_ICON);
  });
});
