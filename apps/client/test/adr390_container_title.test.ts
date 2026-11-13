// @vitest-environment jsdom
/**
 * ADR-390: the inventory window title (h2 + aria-label) is the open container's display name,
 * the section heading uses the same name, and a long title ellipsizes instead of overflowing.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { GameMenus } from "../src/game-menus.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/game-menus.ts"), "utf8");
const d = G.defaultDefs();
const q = (sel: string): HTMLElement => { const e = document.querySelector<HTMLElement>(sel); if (!e) throw new Error(`missing ${sel}`); return e; };

function setup(box: (w: World, me: Entity) => Entity) {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
  w.add(me, PlayerId, { id: 7 }).add(me, Membership, { partyId: 0, clanId: 0 });
  const target = box(w, me);
  const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, getGamepads: () => [], gameplay: { ctx: () => ({ world: w, player: me }), send: () => true } });
  return { w, me, target, menus };
}

beforeEach(() => {
  document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear();
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false });
});

describe("ADR-390 container window title", () => {
  test("header CSS ellipsizes a long title on narrow / phone-portrait layouts", () => {
    expect(css).toMatch(/\.gm-panel header\{[^}]*min-width:0/);
    expect(css).toMatch(/\.gm-panel h2\{[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.gm-panel h2\{[^}]*white-space:nowrap/);
    expect(css).toMatch(/\.gm-panel h2\{[^}]*overflow:hidden/);
    expect(css).toMatch(/\.gm-panel header \[data-role=close\]\{flex-shrink:0\}/);
  });

  test("a crate / chest / store / loot bag / nameless box shows its name as the window title and section heading", () => {
    const cases: { name: string; build: (w: World, me: Entity) => Entity }[] = [
      { name: "Log Store", build: (w, me) => {
        const type = d.pieceId("log_store"); const pc = w.create();
        w.add(pc, Transform, { x: 1, y: 0 }).add(pc, G.BuildPiece, { type }).add(pc, G.Container, { slotCount: 12 });
        return pc;
      } },
      { name: "Large Chest", build: (w) => {
        const type = d.pieceId("large_chest"); const pc = w.create();
        w.add(pc, Transform, { x: 1, y: 0 }).add(pc, G.BuildPiece, { type }).add(pc, G.Container, { slotCount: 24 });
        return pc;
      } },
      { name: "Supply Crate", build: (w) => {
        const b = w.create();
        w.add(b, Transform, { x: 1, y: 0 }).add(b, G.Container, { slotCount: 8 }).add(b, G.ContainerViewers)
          .add(b, G.LootBag, { owner: 0, despawnAtTick: 0xffffffff, kind: G.LootSource.Crate });
        G.tagLootSource(w, b, G.LootSource.Crate);
        return b;
      } },
      { name: "Death Bag", build: (w) => {
        const b = w.create();
        w.add(b, Transform, { x: 1, y: 0 }).add(b, G.Container, { slotCount: 8 }).add(b, G.ContainerViewers)
          .add(b, G.LootBag, { owner: 99, despawnAtTick: 0xffffffff, kind: G.LootSource.Death });
        G.tagLootSource(w, b, G.LootSource.Death);
        return b;
      } },
      { name: "Saddlebag", build: (w) => {
        const m = w.create();
        w.add(m, Transform, { x: 1, y: 0 }).add(m, G.Mount, { species: 1, owner: 7 }).add(m, G.Container, { slotCount: 6 });
        return m;
      } },
      { name: "Wagon Medium", build: (w) => G.spawnVehicle(w, "wagon_medium", 1, 0, 0) },
      { name: "Storage", build: (w) => {
        const b = w.create(); w.add(b, Transform, { x: 1, y: 0 }).add(b, G.Container, { slotCount: 4 });
        return b;
      } },
    ];
    for (const c of cases) {
      document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`;
      const { menus } = setup(c.build);
      menus.open("inventory");
      const h2 = q('[data-menu="inventory"] .gm-panel header h2');
      expect(h2.textContent, c.name).toBe(c.name);
      expect(q('[data-menu="inventory"] .gm-panel').getAttribute("aria-label")).toBe(c.name);
      expect(q('[data-role=container-side]').getAttribute("aria-label")).toBe(c.name);
      expect(q('[data-role=container-side] [data-role=section]').textContent ?? "").toContain(c.name);
      menus.destroy();
    }
  });

  test("refresh updates the title when the open container changes", () => {
    const { w, me, menus } = setup((world) => {
      const b = world.create(); world.add(b, Transform, { x: 1, y: 0 }).add(b, G.Container, { slotCount: 4 });
      return b;
    });
    menus.open("inventory");
    expect(q('[data-menu="inventory"] .gm-panel header h2').textContent).toBe("Storage");
    // Replace the nameless box with a named chest at the same spot.
    for (const e of [...w.query([G.Container, Transform])]) if (e !== me) w.destroy(e);
    const type = d.pieceId("large_chest"); const pc = w.create();
    w.add(pc, Transform, { x: 1, y: 0 }).add(pc, G.BuildPiece, { type }).add(pc, G.Container, { slotCount: 24 });
    menus.refresh();
    expect(q('[data-menu="inventory"] .gm-panel header h2').textContent).toBe("Large Chest");
    menus.destroy();
  });
});
