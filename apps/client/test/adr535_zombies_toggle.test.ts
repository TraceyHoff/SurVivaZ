// @vitest-environment jsdom
// ADR-535: zombies on/off setting. The settings checkbox writes `zombies` into engine-settings,
// newWorldRules() carries it into world creation, and the server persists it in the save meta so a
// reload keeps the world's rule — while a save written before the toggle (no zombies key in its
// meta) loads with zombies ON, never silently changing its difficulty.
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorldStore } from "@engine/persist";
import { worldRules } from "@engine/gameplay";
import { loadSettings, newWorldRules, saveSettings } from "../src/menu.js";
import { createLocalServer } from "../src/local.js";

const KEY = "engine-settings";
beforeEach(() => { localStorage.clear(); });

describe("ADR-535 zombies toggle: settings", () => {
  it("on by default; the stored setting round-trips through newWorldRules", () => {
    expect(loadSettings().zombies).toBe(true);
    expect(newWorldRules().zombies).toBe(true);
    // What the settings screen's Save writes when the "Zombies (new worlds)" box is unchecked.
    localStorage.setItem(KEY, JSON.stringify({ zombies: false }));
    expect(loadSettings().zombies).toBe(false);
    expect(newWorldRules().zombies).toBe(false);
    saveSettings({ ...loadSettings(), zombies: true });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").zombies).toBe(true);
    expect(newWorldRules().zombies).toBe(true);
  });
});

describe("ADR-535 zombies toggle: save meta", () => {
  it("a zombies-off world persists zombies 0 in its meta and reloads with zombies off", async () => {
    const store = new MemoryWorldStore();
    const off = newWorldRules({ ...loadSettings(), zombies: false });
    expect(off.zombies).toBe(false);
    const l = await createLocalServer({ mode: "multiplayer", store, worldRules: off, population: false });
    try { expect(worldRules(l.game.world).zombies).toBe(false); } finally { await l.stop(); }
    expect(store.readMeta()?.zombies).toBe(0);
    const l2 = await createLocalServer({ mode: "multiplayer", store, population: false });
    try { expect(worldRules(l2.game.world).zombies).toBe(false); } finally { await l2.stop(); }
  });
  it("an old save whose meta has no zombies key loads with zombies on", async () => {
    const store = new MemoryWorldStore();
    await store.write({ meta: { seed: 5, tick: 0, schemaHash: 0 } });
    const l = await createLocalServer({ mode: "multiplayer", store, population: false });
    try { expect(worldRules(l.game.world).zombies).toBe(true); } finally { await l.stop(); }
  });
});
