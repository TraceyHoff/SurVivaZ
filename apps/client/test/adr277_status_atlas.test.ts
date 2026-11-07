// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { ICON_DATA } from "../src/game-icons-data.js";
const keys = ["chilly", "cold", "freezing", "hot", "sweltering", "overheating", "damp", "wet", "soaked", "infected", "festering", "septic"] as const;
const atlas = vi.hoisted(() => ({ url: vi.fn((key: string) => `data:image/png;base64,${key}`), frame: () => undefined }));
vi.mock("../src/ui-atlas.js", () => ({ uiSprites: async () => atlas }));
import { mountHud } from "../src/hud.js";
const ui = JSON.parse(readFileSync(join(__dirname, "../../../assets/ui/atlas/ui_atlas.json"), "utf8"));
const ui2 = JSON.parse(readFileSync(join(__dirname, "../../../assets/ui/atlas/ui_atlas@2x.json"), "utf8"));
const positions = [[732,62],[324,70],[360,70],[396,70],[432,70],[468,70],[504,70],[540,70],[576,98],[612,98],[648,98],[684,98]];
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });
describe("ADR-277/278 dedicated exposure art", () => {
  it.each(keys)("%s has the exact dedicated 1x and 2x rectangles, never an embedded fallback", key => {
    const [x,y] = positions[keys.indexOf(key)]!;
    expect(ui.frames[key].frame).toEqual({ x, y, w:32, h:32 });
    expect(ui2.frames[key].frame).toEqual({ x:x!*2, y:y!*2, w:64, h:64 });
    expect(ICON_DATA[key]).toBeUndefined(); expect(ICON_DATA[`${key}.png`]).toBeUndefined();
  });
  it("actual HUD resolves all nine stage keys through ui.url, and clears recovered chips", async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<div id="game-root"></div>';
    const w = new World({ seed:1, maxEntities:4096 }); G.installGameplay(w, {}); const p = G.spawnPlayer(w, { x:0,y:0 });
    const hud = mountHud(() => w, () => p); await Promise.resolve(); await Promise.resolve();
    for (const [key,body,wet] of [["chilly",36.4,0],["cold",35.5,0],["freezing",34.5,0],["hot",37.6,0],["sweltering",38.5,0],["overheating",39.5,0],["damp",37,.2],["wet",37,.5],["soaked",37,.9]] as const) {
      w.set(p,G.Survival,{bodyTemp:body});w.set(p,G.Exposure,{wetness:wet});vi.advanceTimersByTime(250);await Promise.resolve();
      const chip=document.querySelector(`[data-status="${key}"]`)!;expect(chip).not.toBeNull();expect(chip.hasAttribute("data-disease")).toBe(false);
      expect(atlas.url).toHaveBeenCalledWith(key);expect(chip.querySelector("img")?.dataset["uiIcon"]).toBe(key);expect(chip.querySelector("img")?.src).toBe(`data:image/png;base64,${key}`);
    }
    w.set(p,G.Survival,{bodyTemp:37});w.set(p,G.Exposure,{wetness:0});vi.advanceTimersByTime(250);expect(document.querySelectorAll("[data-status]")).toHaveLength(0);hud.destroy();
  });
  it("infection stages resolve their dedicated keys through the real HUD and vanish on treatment", async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<div id="game-root"></div>';
    const w = new World({ seed:1, maxEntities:4096 }); G.installGameplay(w, {}); const p = G.spawnPlayer(w, {x:0,y:0});
    G.contractDisease(w,p,"wound_infection"); const hud=mountHud(()=>w,()=>p);await Promise.resolve();await Promise.resolve();
    for(const [seconds,key] of [[0,"infected"],[180,"festering"],[360,"septic"]] as const){
      w.tick=seconds*20;vi.advanceTimersByTime(250);await Promise.resolve();
      const chip=document.querySelector(`[data-status="${key}"]`)!;expect(chip).not.toBeNull();expect(chip.getAttribute("data-disease")).toBe("wound_infection");
      expect(atlas.url).toHaveBeenCalledWith(key);expect(chip.querySelector("img")?.src).toBe(`data:image/png;base64,${key}`);
      expect(chip.textContent).toContain(key[0]!.toUpperCase()+key.slice(1));
    }
    expect(atlas.url).not.toHaveBeenCalledWith("st_infected"); G.cureDisease(w,p,"wound_infection");vi.advanceTimersByTime(250);expect(document.querySelector('[data-disease="wound_infection"]')).toBeNull();hud.destroy();
  });

});
