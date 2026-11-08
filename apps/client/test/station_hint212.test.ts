// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transform, World, type Entity } from "@engine/core";
import { CraftingStation } from "@engine/gameplay";
import { DOOR_HINT_KIND, holdStation, mountStationHint, STATION_HINT, stationPrompt, type HintHold, type InteractPick } from "../src/station-hint.js";

const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: () => ({ x: 0, y: 0 }) };
let raf: FrameRequestCallback[] = [];
const frame = (t: number): void => { const q = raf; raf = []; q.forEach((f) => f(t)); };
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("ADR-212 station hand symbol", () => {
  it("device hint text: keyboard key, gamepad button, touch Tap", () => {
    expect(stationPrompt("keyboardMouse", "E")).toBe("[E]");
    expect(stationPrompt("gamepad", "X")).toBe("[X]");
    expect(stationPrompt("touch", "E")).toBe("Tap");
  });
  it("hysteresis: no blink at the range edge, hides at once for another Interact target", () => {
    const st = 7 as Entity; let h: HintHold = { kind: 0, lostAt: 0 }; let nearOk = true; const near = (): boolean => nearOk;
    h = holdStation(h, { station: st, kind: 2 }, near, 0); expect(h.station).toBe(st);
    // target flickers in/out every scan (prediction jitter around `range`): stays shown the whole time
    for (let t = 100; t < 3000; t += 100) { const pick: InteractPick = (t / 100) % 2 ? undefined : { station: st, kind: 2 }; h = holdStation(h, pick, near, t); expect(h.station, `t=${t}`).toBe(st); }
    // target gone for longer than the grace: hides
    let t = 3000; while (t < 3000 + STATION_HINT.graceMs + 200) { h = holdStation(h, undefined, near, t); t += 100; }
    expect(h.station).toBeUndefined();
    // walked away past range + slack: hides at once
    h = holdStation(h, { station: st, kind: 2 }, near, 5000); nearOk = false; h = holdStation(h, undefined, near, 5100); expect(h.station).toBeUndefined();
    // a loot bag / pet / stall is the Interact target: hides at once
    nearOk = true; h = holdStation(h, { station: st, kind: 2 }, near, 6000); h = holdStation(h, "other", near, 6100); expect(h.station).toBeUndefined();
  });
  it("mounts over the station with the device hint, touch tap opens, no per-frame DOM churn", () => {
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { raf.push(f); return raf.length; }); vi.stubGlobal("cancelAnimationFrame", () => undefined);
    (HTMLCanvasElement.prototype as { getContext: unknown }).getContext = () => new Proxy({}, { get: () => () => undefined, set: () => true });
    const w = new World(); if (!w.isRegistered(CraftingStation)) w.register(CraftingStation);
    const me = w.create(); w.add(me, Transform, { x: 0, y: 0, z: 0 }); const bench = w.create(); w.add(bench, Transform, { x: 1, y: 0, z: 0.75 }); w.add(bench, CraftingStation, { kind: 2, range: 2.5 });
    let dev: "keyboardMouse" | "gamepad" | "touch" = "keyboardMouse"; let pick: InteractPick = { station: bench, kind: 2 }; const opened: number[] = [];
    const h = mountStationHint(document.body, { world: () => w, player: () => me, camera: () => cam, hidden: () => false, device: () => dev, key: () => (dev === "gamepad" ? "X" : "E"), pick: () => pick, open: (_s, k) => opened.push(k) });
    frame(1000); const el = document.getElementById("station-hint")!;
    expect(el.dataset).toMatchObject({ show: "true", kind: "2", device: "keyboardMouse" }); expect(el.textContent).toBe("[E]"); expect(el.getAttribute("aria-label")).toBe("[E] Workbench");
    const tf = el.style.transform; expect(tf).toMatch(/translate\(\d+px,\d+px\)/);
    let muts = 0; const mo = new MutationObserver((l) => { muts += l.length; }); mo.observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
    for (let t = 1016; t < 3000; t += 16) frame(t);
    expect(el.style.transform).toBe(tf); expect(el.dataset["show"]).toBe("true");
    dev = "gamepad"; frame(3100); expect(el.textContent).toBe("[X]");
    dev = "touch"; frame(3300); expect(el.textContent).toBe("Tap"); expect(el.dataset["device"]).toBe("touch"); el.click(); expect(opened).toEqual([2]);
    pick = "other"; frame(3500); expect(el.dataset["show"]).toBe("false");
    muts += mo.takeRecords().length; mo.disconnect(); expect(muts).toBeLessThan(20);
    h.destroy(); expect(document.getElementById("station-hint")).toBeNull();
  });
  it("ADR-303: a door pick shows the hand on that door", () => {
    const door = 99 as Entity;
    let h: HintHold = { kind: 0, lostAt: 0 };
    h = holdStation(h, { door }, () => true, 0);
    expect(h.station).toBe(door);
    expect(h.kind).toBe(DOOR_HINT_KIND);
  });
});
