// @vitest-environment jsdom
// ADR-588/589 UI wiring: the in-game map's Structures toggle + discovered-only filter, the
// seed page's Spawn point button / Structures toggle, the yellow selected ring in the
// survey SVG, and the MenuChoice carrying the chosen spawnIndex into world creation.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TileMap } from "@engine/world";
import { BootUI, type MenuChoice } from "../src/menu.js";
import { createWorldMap, discoveredRuins } from "../src/world-map.js";
import { loadShowStructures, saveShowStructures } from "../src/map-prefs.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; localStorage.clear(); vi.useRealTimers(); });
const click = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === name)!.click();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("ADR-588 discoveredRuins", () => {
  const sites = [
    { originX: 0, originY: 0, width: 4, height: 4 },     // centre (2, 2)
    { originX: 40, originY: 40, width: 4, height: 4 },   // centre (42, 42)
  ];
  it("keeps only sites whose centre tile the client has received", () => {
    const tiles = { getTile: (x: number, y: number) => (x === 2 && y === 2 ? 3 : 0) } as unknown as TileMap;
    expect(discoveredRuins(sites, tiles)).toEqual([sites[0]]);
    expect(discoveredRuins(sites, undefined)).toEqual([]);
    expect(discoveredRuins(sites, { getTile: () => 3 } as unknown as TileMap)).toEqual(sites);
  });

  it("the Structures preference defaults on and round-trips", () => {
    expect(loadShowStructures()).toBe(true);
    saveShowStructures(false); expect(loadShowStructures()).toBe(false);
    saveShowStructures(true); expect(loadShowStructures()).toBe(true);
  });

  it("the world map carries a Structures toggle that flips and persists", () => {
    const m = createWorldMap({ world: () => undefined, player: () => undefined, tiles: () => undefined, send: () => false, seed: () => 424242 });
    const btn = Array.from(m.el.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.dataset["key"] === "structures")!;
    expect(btn.textContent).toBe("Structures: shown");
    btn.click();
    expect(btn.textContent).toBe("Structures: hidden");
    expect(loadShowStructures()).toBe(false);
    expect(m.el.querySelector("[data-role=map-note]")!.textContent).toMatch(/discovered/i);
    m.destroy();
  });
});

describe("ADR-589 seed-page spawn choice", () => {
  const openSeedPage = async (): Promise<{ choice: Promise<MenuChoice> }> => {
    ui = new BootUI("/");
    const choice = ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "424242", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
    click("Singleplayer"); await flush();
    return { choice };
  };

  it("the Spawn point button cycles the four points and the survey paints the selection yellow", async () => {
    await openSeedPage();
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.dataset["action"] === "survey-spawn")!;
    expect(btn.textContent).toBe("Spawn point: east");
    btn.click(); expect(btn.textContent).toBe("Spawn point: south");
    btn.click(); expect(btn.textContent).toBe("Spawn point: west");
    btn.click(); expect(btn.textContent).toBe("Spawn point: north");
    btn.click(); expect(btn.textContent).toBe("Spawn point: east");
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toMatch(/yellow ○ is your spawn point/);
    const img = document.querySelector<HTMLImageElement>("[data-role=world-preview]")!;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !decodeURIComponent(img.src).includes("#ffd23e")) await new Promise((r) => setTimeout(r, 100));
    expect(decodeURIComponent(img.src)).toContain("#ffd23e");
  }, 20_000);

  it("Create world resolves with the chosen spawnIndex", async () => {
    const { choice } = await openSeedPage();
    click("Spawn point: east"); // -> south (index 1)
    click("Create world");
    await expect(choice).resolves.toMatchObject({ kind: "singleplayer", seed: 424242, spawnIndex: 1 });
  });

  it("the seed page's Structures toggle flips, persists, and is shared with the map default", async () => {
    await openSeedPage();
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.dataset["action"] === "survey-structures")!;
    expect(btn.textContent).toBe("Structures: shown");
    btn.click();
    expect(btn.textContent).toBe("Structures: hidden");
    expect(loadShowStructures()).toBe(false);
  });
});
