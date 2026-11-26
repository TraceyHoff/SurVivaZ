// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { chunkKeyOf } from "@engine/world";
import { BootUI } from "../src/menu.js";
import { isWorldReady, readyFraction, waitForWorldReady, type ReadySessionLike } from "../src/ready.js";
import { TIPS, nextTip } from "../src/tips.js";

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); });

describe("Task 14: gameplay tips", () => {
  test("tips cover the systems players meet, and nextTip wraps", () => {
    const joined = TIPS.join(" ").toLowerCase();
    for (const k of ["boil", "mask", "guard", "hunger", "wall", "room", "heat", "map", "treat", "gate", "tonic"]) expect(joined).toContain(k);
    expect(nextTip(0)).toBe(1);
    expect(nextTip(TIPS.length - 1)).toBe(0);
    expect(TIPS.every((t) => t.length > 0 && t.length <= 200)).toBe(true);
  });
});

describe("Task 14: world-ready condition", () => {
  const fake = (opts: { status?: string; withPlayer?: boolean; missing?: string[] } = {}): { s: ReadySessionLike; w: World; p: Entity } => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {});
    const p = w.create(); w.add(p, Transform, { x: 0, y: 0 });
    const keys = new Set<string>();
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) keys.add(chunkKeyOf(dx * 32, dy * 32));
    for (const m of opts.missing ?? []) keys.delete(m);
    const s: ReadySessionLike = { status: opts.status ?? "connected", world: w, player: opts.withPlayer === false ? undefined : p, client: { tiles: { tiles: { getChunkByKey: (k: string) => (keys.has(k) ? {} : undefined) } } } };
    return { s, w, p };
  };
  test("ready only when connected, player spawned, and all 25 chunks present", () => {
    expect(isWorldReady(fake().s)).toBe(true);
    expect(isWorldReady(fake({ status: "connecting" }).s)).toBe(false);
    expect(isWorldReady(fake({ withPlayer: false }).s)).toBe(false);
    const missing = fake({ missing: [chunkKeyOf(32, 0)] });
    expect(isWorldReady(missing.s)).toBe(false);
    expect(readyFraction(missing.s)).toBeCloseTo(24 / 25);
    expect(readyFraction(fake({ withPlayer: false }).s)).toBe(0);
  });
  test("waitForWorldReady resolves true when chunks arrive, false on timeout", async () => {
    const { s } = fake({ missing: [chunkKeyOf(0, 0)] });
    const keys = new Set<string>(); // late arrival: the missing chunk streams in after 30 ms
    const orig = s.client!.tiles.tiles.getChunkByKey;
    s.client!.tiles.tiles.getChunkByKey = (k: string) => (keys.has(k) ? {} : orig(k));
    setTimeout(() => keys.add(chunkKeyOf(0, 0)), 30);
    await expect(waitForWorldReady(s, { pollMs: 10, timeoutMs: 1000 })).resolves.toBe(true);
    const never = fake({ missing: [chunkKeyOf(0, 0)] }).s;
    await expect(waitForWorldReady(never, { pollMs: 10, timeoutMs: 50 })).resolves.toBe(false);
    const failed = fake({ status: "error" }).s;
    await expect(waitForWorldReady(failed, { pollMs: 10, timeoutMs: 5000 })).resolves.toBe(false);
  });
});

describe("Task 14: second loading screen", () => {
  test("BootUI shows a tip on the first screen and showLoading restores the loading layout", () => {
    const ui = new BootUI("/");
    expect(ui.root.dataset["boot"]).toBe("loading");
    const tip = ui.root.querySelector<HTMLElement>("[data-role=tip]")!;
    expect(tip).toBeTruthy(); expect(tip.textContent).toBe(TIPS[0]);
    expect(tip.style.display).toBe("");
    ui.showLoading("Loading world…");
    expect(ui.root.dataset["boot"]).toBe("loading");
    expect(ui.root.querySelector(".lane")).toBeTruthy();
    expect(ui.root.querySelector(".lbl")?.textContent).toBe("Loading world…");
    expect(ui.root.querySelector("[data-role=tip]")?.textContent).toBe(TIPS[0]);
    ui.hide();
    expect(ui.root.dataset["boot"]).toBe("done");
    // re-showing before the hide removal fires cancels it and restores the screen
    ui.showLoading("Loading world…");
    expect(ui.root.isConnected).toBe(true);
    expect(ui.root.classList.contains("hide")).toBe(false);
    expect(ui.root.dataset["boot"]).toBe("loading");
    ui.hide();
  });
});
