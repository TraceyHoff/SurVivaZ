// @vitest-environment jsdom
// ADR-580: Creative mode setting. Off by default (opt-in); the settings checkbox writes
// `creative` into engine-settings, newWorldRules() carries it into world creation, and the
// server persists it in the save meta so a reload keeps the world's mode — while a save
// written before the rule existed (no creative key in its meta) loads with Creative OFF,
// never silently turning a survival world creative.
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorldStore } from "@engine/persist";
import { worldRules } from "@engine/gameplay";
import { loadSettings, newWorldRules, saveSettings } from "../src/menu.js";
import { createLocalServer } from "../src/local.js";

const KEY = "engine-settings";
beforeEach(() => { localStorage.clear(); });

describe("ADR-580 creative setting", () => {
  it("off by default; the stored setting round-trips through newWorldRules", () => {
    expect(loadSettings().creative).toBe(false);
    expect(newWorldRules().creative).toBe(false);
    // What the settings screen's Save writes when the "Creative mode (new worlds)" box is ticked.
    localStorage.setItem(KEY, JSON.stringify({ creative: true }));
    expect(loadSettings().creative).toBe(true);
    expect(newWorldRules().creative).toBe(true);
    saveSettings({ ...loadSettings(), creative: false });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").creative).toBe(false);
    expect(newWorldRules().creative).toBe(false);
  });
});

describe("ADR-580 creative save meta", () => {
  it("a creative world persists creative 1 in its meta and reloads as creative", async () => {
    const store = new MemoryWorldStore();
    const on = newWorldRules({ ...loadSettings(), creative: true });
    expect(on.creative).toBe(true);
    const l = await createLocalServer({ mode: "multiplayer", store, worldRules: on, population: false });
    try { expect(worldRules(l.game.world).creative).toBe(true); } finally { await l.stop(); }
    expect(store.readMeta()?.creative).toBe(1);
    const l2 = await createLocalServer({ mode: "multiplayer", store, population: false });
    try { expect(worldRules(l2.game.world).creative).toBe(true); } finally { await l2.stop(); }
  });
  it("an old save whose meta has no creative key loads with creative off", async () => {
    const store = new MemoryWorldStore();
    await store.write({ meta: { seed: 5, tick: 0, schemaHash: 0 } });
    const l = await createLocalServer({ mode: "multiplayer", store, population: false });
    try { expect(worldRules(l.game.world).creative).toBe(false); } finally { await l.stop(); }
  });
});
