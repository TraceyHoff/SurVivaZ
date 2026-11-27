// @vitest-environment jsdom
// ADR-579: zombies "still spawning in a zombies-off world" — root cause was NOT a spawn path
// (population, legacy spawner and the horde director all check WorldRules, and the save meta
// persists the rule). It was the world-start wiring in main.ts: `const settings =
// loadSettings()` is captured once at page load, and startSingleplayer passed that snapshot
// to newWorldRules(). A zombies untick saved in the Settings screen during the same session
// — the normal way to use the toggle — never reached world creation, so the world was
// created with zombies ON and its meta locked zombies=1 in permanently.
//
// The fix re-reads the settings inside startSingleplayer (`const fresh = loadSettings()`)
// and feeds newWorldRules(fresh) to both the worker and in-tab server paths. main.ts itself
// boots the app and cannot be imported here, so this file pins (a) the wiring, by source,
// and (b) the behaviour of the exact call pattern the fixed code runs, end to end.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryWorldStore } from "@engine/persist";
import { worldRules } from "@engine/gameplay";
import { loadSettings, newWorldRules } from "../src/menu.js";
import { createLocalServer } from "../src/local.js";

const KEY = "engine-settings";
beforeEach(() => { localStorage.clear(); });

describe("ADR-579 wiring: startSingleplayer reads settings fresh", () => {
  const src = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
  const start = src.indexOf("async function startSingleplayer");
  const body = src.slice(start, src.indexOf("\nasync function", start + 1));

  it("the function body re-reads loadSettings and never feeds the stale snapshot to newWorldRules", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("const fresh = loadSettings()");
    expect(body).not.toContain("newWorldRules(settings)");
    // Both server paths (Web Worker and in-tab fallback) get the fresh rules.
    expect(body.split("newWorldRules(fresh)").length - 1).toBe(2);
  });
});

describe("ADR-579 behaviour: a same-session settings change reaches world creation", () => {
  it("untick zombies after 'page load', then create the world the way startSingleplayer now does", async () => {
    // Page load: the stored settings still say zombies on (the module snapshot's view).
    localStorage.setItem(KEY, JSON.stringify({ zombies: true }));
    expect(newWorldRules(loadSettings()).zombies).toBe(true);
    // The user opens Settings, unticks zombies, saves — localStorage is updated in-session.
    localStorage.setItem(KEY, JSON.stringify({ zombies: false }));
    // startSingleplayer (fixed): fresh read -> rules -> local server.
    const rules = newWorldRules(loadSettings());
    const store = new MemoryWorldStore();
    const l = await createLocalServer({ mode: "multiplayer", store, worldRules: rules, population: false });
    try { expect(worldRules(l.game.world).zombies).toBe(false); } finally { await l.stop(); }
    // And the save now locks in the rule the user actually chose.
    expect(store.readMeta()?.zombies).toBe(0);
  });
});
