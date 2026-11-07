// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { InputSystem, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { TUTORIAL_STEPS, TutorialProgress, tutorialKey, LEGACY_ORDER, TIP_GAP_MS, type Probe } from "../src/tutorial/steps.js";
import { TutorialProber, type ProbeSample } from "../src/tutorial/probe.js";
import { mountTutorial } from "../src/tutorial/overlay.js";
import { GameMenus } from "../src/game-menus.js";
import type { BindingSource } from "../src/tutorial/labels.js";

const input = (): InputSystem => new InputSystem({ now: () => 0 } as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
const mem = (): { data: Record<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } });
const fresh = (): TutorialProgress => { const p = new TutorialProgress(TUTORIAL_STEPS, mem(), "k", { gapMs: 0 }); p.start(); return p; };
/** Show-and-dismiss every lesson that `probe` triggers; returns their ids in order. */
const drain = (p: TutorialProgress, probe: Probe): string[] => { const out: string[] = []; while (!p.gated(probe)) { out.push(p.step.id); p.next(); } return out; };

describe("ADR-275 contextual tips", () => {
  test("the start is minimal: only the Walk tip shows at spawn, nothing else is queued", () => {
    const p = fresh(); expect(drain(p, {})).toEqual(["move"]);
    expect(TUTORIAL_STEPS.filter((s) => !s.when).map((s) => s.id)).toEqual(["move"]);
    expect(TUTORIAL_STEPS.some((s) => s.id === "welcome" || s.id === "done")).toBe(false);
  });
  const cases: [string, Probe, string][] = [
    ["first time near a gatherable", { nearNode: 1 }, "gather"], ["first item picked up", { gain: 1 }, "inventory"],
    ["opened the bag", { "menu:inventory": 1 }, "bag-info"], ["getting hungry", { hungry: 1 }, "hunger"], ["getting thirsty", { thirsty: 1 }, "thirst"],
    ["a few materials", { gain: 4 }, "craft"], ["first craft", { craft: 1 }, "equip"], ["holding a tool", { hadTool: 1 }, "chop"],
    ["first log", { gainLog: 1 }, "build"], ["opened build menu", { "menu:build": 1 }, "ghost"], ["first piece placed", { place: 1 }, "roads"],
    ["first station", { stationBuilt: 1 }, "craft-station"], ["first campfire", { campfire: 1 }, "station"],
    ["first skill point", { skillPoint: 1 }, "skills"], ["opened skills", { "menu:skills": 1 }, "skills-info"], ["learned a skill", { skillNode: 1 }, "skill-unlock"],
    ["hurt", { hurt: 1 }, "health"], ["low stamina", { tired: 1 }, "stamina"], ["dusk", { dusk: 1 }, "daynight"],
    ["zombie seen", { zombieNear: 1 }, "zombies"], ["zombie close", { zombieClose: 1 }, "fight"], ["day 2", { day: 2 }, "hordes"],
    ["near a loot bag", { nearBag: 1 }, "carry"], ["near a bed", { nearBed: 1 }, "sleep"], ["respawned", { respawned: 1 }, "death"],
    ["opened pause", { "menu:pause": 1 }, "save"], ["opened chat", { "menu:chat": 1 }, "chat"], ["opened party", { "menu:party": 1 }, "party"],
    ["opened clan", { "menu:clan": 1 }, "clan"], ["opened trade", { "menu:trade": 1 }, "trade"], ["opened settings", { "menu:settings": 1 }, "settings"],
    ["broke a leg", { brokenLeg: 1 }, "broken-leg"],
  ];
  for (const [name, probe, id] of cases) test(`${name} → ${id}`, () => {
    const p = fresh(); p.seen.add("move");
    expect(p.pending({}).map((s) => s.id)).not.toContain(id);
    expect(drain(p, probe)).toContain(id);
  });
  test("every old guide topic is still taught by some trigger", () => {
    const ids = new Set(TUTORIAL_STEPS.map((s) => s.id));
    for (const old of LEGACY_ORDER) if (old !== "welcome" && old !== "done") expect(ids.has(old), old).toBe(true);
    for (const s of TUTORIAL_STEPS) if (s.id !== "move") expect(typeof s.when, s.id).toBe("function");
  });
  test("one tip at a time, with a quiet gap between tips", () => {
    let t = 0; const p = new TutorialProgress(TUTORIAL_STEPS, mem(), "k", { now: () => t }); p.start(); p.seen.add("move");
    const z: Probe = { zombieNear: 1, zombieClose: 1, night: 1 };
    expect(p.gated(z)).toBe(false); expect(p.step.id).toBe("zombies"); p.next();
    expect(p.gated(z)).toBe(true); t += TIP_GAP_MS - 1; expect(p.gated(z)).toBe(true);
    t += 1; expect(p.gated(z)).toBe(false); expect(p.step.id).toBe("fight");
  });
  test("a dismissed tip never repeats, also after reload", () => {
    const st = mem(); const p = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 }); p.start(); p.seen.add("move");
    expect(drain(p, { brokenLeg: 1 })).toEqual(["broken-leg"]); expect(drain(p, { brokenLeg: 1 })).toEqual([]);
    const q = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 });
    expect(q.active).toBe(true); expect(drain(q, { brokenLeg: 1 })).toEqual([]);
  });
  test("a save that finished or skipped the old guide gets no tip flood", () => {
    for (const status of ["done", "skipped"]) {
      const st = mem(); st.setItem(tutorialKey("1"), JSON.stringify({ status, step: "settings", v: 1 }));
      const p = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 });
      expect(p.shouldAutoStart(true)).toBe(false); expect(p.seen.size).toBe(TUTORIAL_STEPS.length);
      const everything = Object.fromEntries(["nearNode", "gain", "gainLog", "hungry", "zombieNear", "brokenLeg", "menu:inventory", "skillPoint"].map((k) => [k, 9]));
      expect(p.gated(everything)).toBe(true);
    }
  });
  test("a half-finished old guide resumes as tips with the earlier topics marked seen", () => {
    const st = mem(); st.setItem(tutorialKey("1"), JSON.stringify({ status: "active", step: "build", v: 1 }));
    const p = new TutorialProgress(TUTORIAL_STEPS, st, tutorialKey("1"), { gapMs: 0 });
    expect(p.active).toBe(true); expect(p.seen.has("chop")).toBe(true); expect(p.seen.has("build")).toBe(false);
    expect(drain(p, { gain: 9, gainLog: 1 })).toEqual(["build"]);
  });
  test("old worlds with no guide save and not a new character stay quiet", () => {
    expect(new TutorialProgress(TUTORIAL_STEPS, mem(), "k").shouldAutoStart(false)).toBe(false);
  });
  test("gamepad: A dismisses an info tip; hold Y skips an action tip; pause menu lets pad users dismiss or turn tips off", () => {
    document.body.innerHTML = `<div id="game-root" style="width:390px;height:844px"></div>`; const root = document.getElementById("game-root")!;
    const p = fresh(); p.seen.add("move"); let probe: Probe = { hungry: 1 };
    const ui = mountTutorial({ root, progress: p, bindings: input() as unknown as BindingSource, device: () => "gamepad", probe: () => probe, hidden: () => false });
    ui.update(); expect(ui.el.hidden).toBe(false); expect(ui.el.dataset["step"]).toBe("hunger"); expect(ui.el.textContent).toContain("Got it");
    ui.frame({ pressed: (a: string) => a === "Jump", down: () => false }, false);
    expect(p.seen.has("hunger")).toBe(true); expect(ui.el.dataset["step"]).toBe("eat"); // next one-topic tip, never the old one again
    const t0 = 1000; let t = t0; const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
    const held = { pressed: () => false, down: (a: string) => a === "Reload" };
    ui.frame(held, false); t += 1100; ui.frame(held, false); spy.mockRestore();
    expect(p.seen.has("eat")).toBe(true); probe = {}; ui.update(); expect(ui.el.hidden).toBe(true);
    ui.destroy();
    let next = 0, skip = 0;
    const m = new GameMenus({ root, onQuit: () => {}, pollGamepads: false, tutorial: { active: () => true, replay: () => {}, next: () => { next++; }, skip: () => { skip++; } } });
    m.open("pause"); const btn = (re: RegExp) => Array.from(document.querySelectorAll("button")).find((x) => re.test(x.textContent ?? ""))!;
    btn(/Dismiss this tip/).click(); expect(next).toBe(1);
    m.open("pause"); btn(/Turn off tips/).click(); expect(skip).toBe(1);
  });
  test("prober latches the new triggers", () => {
    const b = new TutorialProber(); const base: ProbeSample = { sprinting: false, aiming: false, menuOpen: false, toolKind: 0, buildActive: false, buildRot: 0 };
    b.sample({ ...base, hunger: 90, thirst: 90, hp: 100, hpMax: 100, stamina: 100, hours: 12, day: 0.5, zombieDist: 30, skillPoints: 0, skillNodes: 0 });
    const p0 = b.probe(); for (const k of ["hungry", "thirsty", "hurt", "tired", "dusk", "night", "zombieNear", "skillPoint", "brokenLeg", "respawned"]) expect(p0[k], k).toBeUndefined();
    b.sample({ ...base, hunger: 50, thirst: 50, hp: 80, hpMax: 100, stamina: 30, hours: 21, day: 2.1, zombieDist: 4, skillPoints: 1, skillNodes: 1, brokenLeg: true, nearBed: true, nearBag: true, nearNode: true });
    b.sample({ ...base, dead: true });
    b.sample({ ...base, dead: false, hunger: 90 });
    const p = b.probe(); for (const k of ["hungry", "thirsty", "hurt", "tired", "dusk", "night", "zombieNear", "zombieClose", "skillPoint", "skillNode", "brokenLeg", "nearBed", "nearBag", "nearNode", "respawned"]) expect(p[k], k).toBe(1);
    expect(p["day"]).toBe(2);
  });
});

test("ADR-289 teaches real auto-sprint and direct hotbar taps, never removed controls", () => {
  const run = TUTORIAL_STEPS.find(s => s.id === "sprint")!;
  expect(JSON.stringify(run.text)).toContain("Keep moving in one direction"); expect(JSON.stringify(run.text)).toContain("turn while running");
  expect(JSON.stringify(run.text)).not.toContain("{A:Sprint}"); expect(run.target?.("touch")).toBe("#hud [data-stat=stamina]");
  expect(run.when?.({ moved: 24 })).toBe(false); expect(run.when?.({ moved: 25 })).toBe(true);
  expect(run.done?.({ sprint: 2 }, { sprint: 0 })).toBe(false); expect(run.done?.({ sprint: 3 }, { sprint: 0 })).toBe(true);
  const equip = TUTORIAL_STEPS.find(s => s.id === "equip")!;
  expect(JSON.stringify(equip.text)).toContain("Double-tap a slot to use an item or equip a tool"); expect(equip.target?.("touch")).toBe("#hotbar");
  expect(JSON.stringify(TUTORIAL_STEPS)).not.toMatch(/data-touch=(sprint|hotbar)/);
});
