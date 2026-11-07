// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { InputSystem, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { actionCombos, combosText, controlChip, type BindingSource } from "../src/tutorial/labels.js";
import { TUTORIAL_STEPS, TutorialProgress, tutorialKey } from "../src/tutorial/steps.js";
import { placeCard, renderTokens, menuCombos, mountTutorial } from "../src/tutorial/overlay.js";
import { TutorialProber } from "../src/tutorial/probe.js";
import { GameMenus } from "../src/game-menus.js";

const input = (): InputSystem => new InputSystem({ now: () => 0 } as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
const mem = (): { data: Record<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });

describe("ADR-144 binding labels (from the real profiles)", () => {
  const src = input() as unknown as BindingSource;
  test("keyboard", () => {
    expect(combosText(actionCombos(src, "keyboardMouse", "Sprint"))).toContain("Shift");
    expect(combosText(actionCombos(src, "keyboardMouse", "Move"))).toMatch(/W A S D/);
    expect(combosText(actionCombos(src, "keyboardMouse", "Interact"))).toContain("E");
  });
  test("gamepad (xbox) + PlayStation layout", () => {
    expect(combosText(actionCombos(src, "gamepad", "Primary"))).toContain("RT");
    expect(controlChip("pad.rt", "playstation").text).toBe("R2");
    expect(combosText(actionCombos(src, "gamepad", "ToggleCrafting"))).toMatch(/LB ?\+ ?View/);
  });
  test("touch", () => {
    expect(actionCombos(src, "touch", "Interact").length).toBeGreaterThan(0);
    expect(menuCombos(src, "touch", "skills").text).toMatch(/Skills button \(under ⋯ More\)/);
    expect(menuCombos(src, "touch", "inventory").text).toMatch(/button/);
  });
  test("rebinding changes the text (labels are not hardcoded)", () => {
    const i = input(); i.rebind("Sprint", "keyboardMouse", { control: "key.KeyZ" } as never);
    expect(renderTokens("Hold {A:Sprint}", i as unknown as BindingSource, "keyboardMouse", false)).toContain("Z");
  });
  test("every step token resolves on every device", () => {
    const i = input() as unknown as BindingSource;
    for (const s of TUTORIAL_STEPS) for (const d of ["keyboardMouse", "gamepad", "touch"] as const) {
      const t = typeof s.text === "string" ? s.text : s.text[d] ?? s.text.all ?? "";
      expect(t.length, s.id).toBeGreaterThan(0);
      const out = renderTokens(t, i, d, false); expect(out, `${s.id}/${d}`).not.toMatch(/\{[AM]:/);
      if (!/\bnone\b/.test(out)) expect(out.includes("?") && /\{A:/.test(t) && d !== "touch" ? `${s.id}/${d}: ${out}` : "", "").toBe("");
    }
  });
});

describe("ADR-144 step progress", () => {
  test("do steps advance from a per-step baseline; info steps wait for Got it (ADR-275 lesson queue)", () => {
    const st = mem(); const p = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 });
    expect(p.shouldAutoStart(true)).toBe(true); expect(p.shouldAutoStart(false)).toBe(false);
    p.start(); expect(p.gated({})).toBe(false); expect(p.step.id).toBe("move");
    p.observe({ moved: 50 }); // baseline: walking done before this tip does not count
    expect(p.step.id).toBe("move");
    expect(p.observe({ moved: 54 })).toBe(true); expect(p.seen.has("move")).toBe(true);
    expect(p.gated({ moved: 54 })).toBe(false); expect(p.step.id).toBe("sprint"); p.next(); // walked 25+ tiles: the Run tip
    expect(p.gated({ moved: 54 })).toBe(true); // nothing else triggered yet
    expect(p.gated({ moved: 54, gain: 1 })).toBe(false); expect(p.step.id).toBe("inventory");
    // resume after reload
    const q = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 });
    expect(q.active).toBe(true); expect(q.step.id).toBe("inventory"); expect(q.seen.has("move")).toBe(true); expect(q.shouldAutoStart(false)).toBe(true);
    q.skip(); expect(new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1")).shouldAutoStart(true)).toBe(false);
    q.start(true); expect(q.seen.size).toBe(0); expect(q.gated({})).toBe(false); expect(q.step.id).toBe("move");
    for (let k = 0; k < TUTORIAL_STEPS.length; k++) { q.go(k); q.next(); } expect(q.status).toBe("done");
  });
  test("equip finishes when a tool is already in hand", () => {
    const p = new TutorialProgress(TUTORIAL_STEPS, mem(), "k"); p.start(); p.go(TUTORIAL_STEPS.findIndex((s) => s.id === "equip"));
    p.observe({ tool: 1 }); expect(p.step.id).not.toBe("equip");
  });
  test("prober counts movement, gains (not while a menu is open), build + rotate, menus", () => {
    const b = new TutorialProber(); const base = { sprinting: false, aiming: false, menuOpen: false, toolKind: 0, buildActive: false, buildRot: 0 };
    b.sample({ ...base, pos: { x: 0, y: 0 }, items: new Map() });
    b.sample({ ...base, pos: { x: 3, y: 4 }, items: new Map([["Oak Log", 2]]) });
    b.sample({ ...base, pos: { x: 3, y: 4 }, items: new Map([["Oak Log", 5]]), menuOpen: true, menuTop: "skills", buildActive: true });
    b.sample({ ...base, pos: { x: 3, y: 4 }, items: new Map([["Oak Log", 5]]), buildActive: true, buildRot: 1 });
    b.command("gameplay.queueCraft");
    const p = b.probe();
    expect(p["moved"]).toBeCloseTo(5); expect(p["gain"]).toBe(2); expect(p["gainLog"]).toBe(2);
    expect(p["menu:skills"]).toBe(1); expect(p["build"]).toBe(1); expect(p["rotate"]).toBe(1); expect(p["craft"]).toBe(1);
  });
});

describe("ADR-144 overlay placement", () => {
  test("never covers the target; prefers free space", () => {
    const view = { w: 390, h: 844 }; const card = { w: 330, h: 160 };
    const target = { x: 300, y: 700, w: 80, h: 80 };
    const pos = placeCard(view, card, target, [{ x: 0, y: 0, w: 390, h: 50 }]);
    const r = { ...pos, ...card };
    expect(r.x < target.x + target.w && r.x + r.w > target.x && r.y < target.y + target.h && r.y + r.h > target.y).toBe(false);
    expect(r.x).toBeGreaterThanOrEqual(8); expect(r.x + r.w).toBeLessThanOrEqual(390 - 8 + 1e-6);
  });
  test("card renders, Skip this tip / ✕ buttons work, device switch re-renders labels", () => {
    document.body.innerHTML = `<div id="game-root" style="width:390px;height:844px"></div>`;
    const root = document.getElementById("game-root")!; let dev: "keyboardMouse" | "gamepad" = "keyboardMouse";
    const p = new TutorialProgress(TUTORIAL_STEPS, mem(), "k"); p.start(); p.go(TUTORIAL_STEPS.findIndex((s) => s.id === "sprint"));
    const ui = mountTutorial({ root, progress: p, bindings: input() as unknown as BindingSource, device: () => dev, probe: () => ({}), hidden: () => false });
    ui.update(); expect(ui.el.hidden).toBe(false); expect(ui.el.textContent).toContain("Keep moving in one direction"); expect(ui.el.textContent).not.toContain("Shift");
    dev = "gamepad"; ui.update(); expect(ui.el.dataset["device"]).toBe("gamepad"); expect(ui.el.textContent).not.toContain("Shift");
    expect(ui.el.querySelector(".tut-head [data-tut=next]")).not.toBeNull(); /* ADR-275 portrait: dismiss stays visible in the header */ expect(ui.el.querySelector("[data-tut=back]")).toBeNull(); expect(ui.el.textContent).not.toMatch(/\d+ of \d+/);
    (ui.el.querySelector("[data-tut=next]") as HTMLElement).click(); expect(p.seen.has("sprint")).toBe(true); expect(ui.el.hidden).toBe(true);
    p.go(TUTORIAL_STEPS.findIndex((s) => s.id === "look")); ui.update(); expect(ui.el.hidden).toBe(false);
    (ui.el.querySelector("[data-tut=skip]") as HTMLElement).click(); expect(p.status).toBe("skipped"); expect(ui.el.hidden).toBe(true);
    ui.destroy();
  });
  test("Pause + Settings offer the guide", () => {
    document.body.innerHTML = `<div id="game-root"></div>`; let replays = 0;
    const m = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, tutorial: { active: () => false, replay: () => { replays++; }, next: () => {}, skip: () => {} } });
    m.open("pause"); const b = Array.from(document.querySelectorAll("button")).find((x) => /Play the guide again/.test(x.textContent ?? ""));
    expect(b).toBeTruthy(); b!.click(); expect(replays).toBe(1);
    m.open("settings"); expect(Array.from(document.querySelectorAll("button")).some((x) => /Play the guide again/.test(x.textContent ?? ""))).toBe(true);
  });
});

describe("ADR-144 follow-up: touch ghost joystick, pad hold-Y skip, real placement", () => {
  const mk = (dev: "touch" | "gamepad" | "keyboardMouse") => {
    document.body.innerHTML = `<div id="game-root"></div>`; const root = document.getElementById("game-root")!;
    const p = new TutorialProgress(TUTORIAL_STEPS, mem(), "k"); p.start(true); p.go(TUTORIAL_STEPS.findIndex((s) => s.id === "move"));
    const ui = mountTutorial({ root, progress: p, bindings: input() as unknown as BindingSource, device: () => dev, probe: () => ({}), hidden: () => false });
    ui.update(); return { p, ui };
  };
  test("touch Move card shows the ghost joystick and the spotlight targets it", () => {
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) { return (this.id === "tutorial-ghost" ? { x: 30, y: 600, left: 30, top: 600, width: 116, height: 116, right: 146, bottom: 716 } : orig.call(this)) as DOMRect; };
    try {
      const { ui } = mk("touch"); const g = document.getElementById("tutorial-ghost")!; const spot = document.getElementById("tutorial-spot")!;
      expect(g.hidden).toBe(false); expect(g.textContent).toContain("Drag here"); expect(spot.hidden).toBe(false);
      expect(parseFloat(spot.style.left)).toBeLessThan(30); expect(parseFloat(spot.style.top)).toBeLessThan(600); // ring wraps the ghost
      ui.destroy();
    } finally { HTMLElement.prototype.getBoundingClientRect = orig; }
  });
  test("no ghost on keyboard", () => { const { ui } = mk("keyboardMouse"); expect(document.getElementById("tutorial-ghost")!.hidden).toBe(true); ui.destroy(); });
  test("gamepad: holding Y (Reload) for 1 s skips an action card; release needed before the next skip", () => {
    const { p, ui } = mk("gamepad"); let t = 1000; const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
    expect(ui.el.textContent).toMatch(/Hold .* to skip/);
    const held = { pressed: () => false, down: (a: string) => a === "Reload" };
    ui.frame(held, false); t += 600; ui.frame(held, false); expect(p.step.id).toBe("move");
    expect(parseInt((ui.el.querySelector(".tut-hold i") as HTMLElement).style.width)).toBeGreaterThan(50);
    t += 500; ui.frame(held, false); expect(p.seen.has("move")).toBe(true); expect(ui.el.hidden).toBe(true);
    p.go(TUTORIAL_STEPS.findIndex((s) => s.id === "sprint")); ui.update();
    t += 2000; ui.frame(held, false); expect(p.step.id).toBe("sprint"); expect(p.seen.has("sprint")).toBe(false); // still held: no chain-skip
    ui.frame({ pressed: () => false, down: () => false }, false); t += 100; ui.frame(held, false); t += 1100; ui.frame(held, false); expect(p.seen.has("sprint")).toBe(true);
    spy.mockRestore(); ui.destroy();
  });
  test("place counts only a piece that really appeared, and only in build mode", () => {
    const pr = new TutorialProber(); const base = { sprinting: false, aiming: false, menuOpen: false, toolKind: 0, buildRot: 0 };
    pr.sample({ ...base, buildActive: false, pieces: 0 }); pr.sample({ ...base, buildActive: false, pieces: 4 }); expect(pr.probe()["place"]).toBeUndefined();
    pr.command("gameplay.place"); pr.sample({ ...base, buildActive: true, pieces: 4 }); expect(pr.probe()["place"]).toBeUndefined();
    pr.sample({ ...base, buildActive: true, pieces: 5 }); expect(pr.probe()["place"]).toBe(1);
  });
});
