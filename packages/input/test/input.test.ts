import { describe, it, expect } from "vitest";
import { InputState, AimMode, inputFrameToBytes, inputFrameFromBytes, CommandRegistry, frameMove, extendActions, defineActions } from "@engine/core";
import {
  InputSystem, FakeDevice, GamepadDevice, KeyboardMouseDevice, TouchDevice, deadzoneRadial, deadzoneAxial, applyProcessors,
  DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES, DEFAULT_FRAME_MAPPING, DefaultHoldBits, DefaultEdgeBits, DEFAULT_TOUCH_LAYOUTS, DEFAULT_FOCUS_ACTIONS,
  VirtualControls, GestureRecognizer, FocusManager, promptFor, glyphFor, AimResolver, TouchGhostController, InputRecorder, InputReplayer, FrameLog,
  type Gesture, type BindingProfile,
} from "../src/index.js";

const mkClock = () => { const c = { t: 0, now: () => c.t, advance: (ms: number) => { c.t += ms; } }; return c; };
function setup() {
  const clock = mkClock(); const sys = new InputSystem(clock, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const kbm = new KeyboardMouseDevice(); const pad = new GamepadDevice(0); const touch = new TouchDevice();
  sys.addDevice(kbm); sys.addDevice(pad); sys.addDevice(touch); sys.push("Gameplay");
  const tick = (ms = 50) => { clock.advance(ms); sys.update(); };
  return { clock, sys, kbm, pad, touch, tick };
}

describe("core InputFrame v2", () => {
  it("analog move, aim mode, nudge, edges round-trip; v1 stays compatible; digital fallback", () => {
    const reg = new CommandRegistry(); const st = new InputState(); st.press(1); st.moveX = 0.5; st.moveY = -1; st.aimMode = AimMode.WorldPoint; st.aimX = 3; st.pulse(4); st.ghostNudgeX = -0.25;
    const f = st.sample(9); const back = inputFrameFromBytes(inputFrameToBytes(f, reg), reg);
    expect(back.moveX).toBeCloseTo(0.5, 1); expect(back.moveY).toBe(-1); expect(back.aimMode).toBe(AimMode.WorldPoint); expect(back.edges).toBe(4); expect(back.ghostNudgeX).toBeCloseTo(-0.25, 1);
    expect(st.sample(10).edges).toBeUndefined();
    const v1 = inputFrameFromBytes(inputFrameToBytes(f, reg, 1), reg, 1); expect(v1).toEqual({ tick: 9, actions: 1, aimX: 3, aimY: 0, commands: [] });
    expect(frameMove({ actions: 1 | 8 }, { up: 1, down: 2, left: 4, right: 8 }).x).toBeCloseTo(Math.SQRT1_2);
    const A = extendActions(defineActions(["A", "B"] as const), ["C"] as const); expect(A.C).toBe(4);
  });
});

describe("processors", () => {
  it("radial vs axial deadzone, curve, invert, normalize", () => {
    expect(deadzoneRadial([0.1, 0.1])).toEqual([0, 0]); const r = deadzoneRadial([0.5, 0]); expect(r[0]).toBeCloseTo((0.5 - 0.15) / 0.8);
    expect(deadzoneAxial([0.1, 0.9])[0]).toBe(0); expect(applyProcessors([1, 1], [{ type: "normalize" }])[0]).toBeCloseTo(Math.SQRT1_2);
    expect(applyProcessors([0.5, 0], [{ type: "curve", exponent: 2 }])[0]).toBeCloseTo(0.25); expect(applyProcessors([0.5, 0.5], [{ type: "invert", y: true }])).toEqual([-0.5, -0.5]);
  });
});

describe("bindings, composites, interactions", () => {
  it("WASD composite, gamepad stick, frame mapping into InputState", () => {
    const { sys, kbm, pad, tick } = setup(); kbm.press("key.KeyW"); kbm.press("key.KeyD"); tick();
    const [x, y] = sys.vector("Move"); expect(x).toBeCloseTo(Math.SQRT1_2); expect(y).toBeCloseTo(-Math.SQRT1_2);
    const st = new InputState(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING); const f = st.sample(1);
    expect(f.actions & DefaultHoldBits.MoveUp).toBeTruthy(); expect(f.actions & DefaultHoldBits.MoveRight).toBeTruthy(); expect(f.moveX).toBeCloseTo(Math.SQRT1_2);
    kbm.release("key.KeyW"); kbm.release("key.KeyD"); pad.set("pad.lx", 0.1); tick(); expect(sys.vector("Move")).toEqual([0, 0]); // radial deadzone 0.15
    pad.set("pad.lx", 1); tick(); expect(sys.vector("Move")[0]).toBe(1); expect(sys.activeDevice).toBe(pad);
  });
  it("tap vs long-press on one key (Interact / ContextRadial), hold Charge, edges pulse once", () => {
    const { sys, kbm, tick } = setup(); const st = new InputState();
    kbm.press("key.KeyE"); tick(); tick(); kbm.release("key.KeyE"); tick(); expect(sys.pressed("Interact")).toBe(true); expect(sys.pressed("ContextRadial")).toBe(false);
    let radial = 0; sys.on("ContextRadial", (e) => { if (e.phase === "performed") radial++; }); kbm.press("key.KeyE"); for (let i = 0; i < 12; i++) tick(); expect(radial).toBe(1);
    kbm.release("key.KeyE"); tick(); expect(sys.pressed("Interact")).toBe(false);
    kbm.press("mouse.left"); tick(); expect(sys.down("Primary")).toBe(true); expect(sys.down("Charge")).toBe(false); for (let i = 0; i < 8; i++) tick(); expect(sys.down("Charge")).toBe(true); kbm.release("mouse.left"); tick();
    kbm.press("key.Space"); tick(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING); expect(st.sample(1).edges).toBe(DefaultEdgeBits.Jump); tick(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING); expect(st.sample(2).edges).toBeUndefined();
  });
  it("modifier shadowing (Shift+click QuickTransfer vs click MoveSlot), doubleTap, toggle, repeat, chord", () => {
    const { sys, kbm, tick } = setup(); sys.push("Inventory");
    kbm.press("key.ShiftLeft"); kbm.press("mouse.left"); tick(); expect(sys.pressed("Inv.QuickTransfer")).toBe(true); expect(sys.pressed("Inv.MoveSlot")).toBe(false);
    kbm.releaseAll(); tick(); kbm.press("mouse.left"); tick(); expect(sys.pressed("Inv.MoveSlot")).toBe(true);
    const clock = mkClock(); const s2 = new InputSystem(clock, { actions: [{ name: "Dash", type: "button" }, { name: "Run", type: "button" }, { name: "More", type: "button" }, { name: "Combo", type: "button" }], contexts: [{ name: "G", priority: 0 }],
      profiles: [{ id: "t", deviceClass: "keyboardMouse", bindings: { G: [{ action: "Dash", control: "key.KeyQ", interaction: { type: "doubleTap" } }, { action: "Run", control: "key.KeyR", interaction: { type: "toggle" } },
        { action: "More", control: "key.KeyM", interaction: { type: "repeat", delayMs: 100, rateMs: 50 } }, { action: "Combo", chord: ["key.KeyA", "key.KeyB"] }] } }] });
    const d = new FakeDevice("k", "keyboardMouse"); s2.addDevice(d); s2.push("G"); const t = (ms = 50) => { clock.advance(ms); s2.update(); };
    d.press("key.KeyQ"); t(); d.release("key.KeyQ"); t(); expect(s2.pressed("Dash")).toBe(false); d.press("key.KeyQ"); t(); d.release("key.KeyQ"); t(); expect(s2.pressed("Dash")).toBe(true);
    d.press("key.KeyR"); t(); d.release("key.KeyR"); t(); expect(s2.down("Run")).toBe(true); d.press("key.KeyR"); t(); expect(s2.down("Run")).toBe(false);
    let n = 0; s2.on("More", (e) => { if (e.phase === "performed") n++; }); d.press("key.KeyM"); for (let i = 0; i < 6; i++) t(); expect(n).toBe(5); d.release("key.KeyM");
    d.press("key.KeyA"); t(); expect(s2.down("Combo")).toBe(false); d.press("key.KeyB"); t(); expect(s2.down("Combo")).toBe(true);
  });
});

describe("contexts", () => {
  it("Building keeps movement, overrides Primary; Inventory blocks movement; Chat text entry suppresses keys but passes gamepad Move", () => {
    const { sys, kbm, pad, tick } = setup(); const st = new InputState();
    sys.push("Building"); kbm.press("mouse.left"); kbm.press("key.KeyW"); tick();
    expect(sys.pressed("Build.PlaceConfirm")).toBe(true); expect(sys.down("Primary")).toBe(false); expect(sys.vector("Move")[1]).toBe(-1);
    sys.writeFrame(st, DEFAULT_FRAME_MAPPING); expect(st.sample(1).actions & DefaultHoldBits.Build).toBeTruthy();
    kbm.releaseAll(); tick(); sys.pop("Building"); sys.push("Inventory"); kbm.press("key.KeyW"); tick(); expect(sys.vector("Move")).toEqual([0, 0]);
    kbm.press("key.Escape"); tick(); expect(sys.pressed("UI.Back")).toBe(true); expect(sys.pressed("Cancel")).toBe(false); kbm.releaseAll(); tick(); sys.pop("Inventory");
    sys.push("Chat"); kbm.press("key.KeyW"); kbm.press("key.KeyE"); tick(); expect(sys.vector("Move")).toEqual([0, 0]); kbm.releaseAll(); tick(); expect(sys.pressed("Interact")).toBe(false);
    pad.set("pad.lx", 1); tick(); expect(sys.vector("Move")[0]).toBe(1); pad.set("pad.a", 1); tick(); expect(sys.pressed("Jump")).toBe(false);
    const changes: string[][] = []; sys.onContextChange((s) => changes.push([...s])); let open = true; sys.autoContext("Dialog", () => open); tick(); expect(sys.isActive("Dialog")).toBe(true); open = false; tick(); expect(sys.isActive("Dialog")).toBe(false); expect(changes.length).toBe(2);
    sys.setEnabled("Chat", false); pad.set("pad.a", 0); tick(); pad.set("pad.a", 1); tick(); expect(sys.pressed("Jump")).toBe(true);
  });
});

describe("rebinding", () => {
  it("rebind, conflict detection, swap, reset, overrides persistence, listenForNextInput", async () => {
    const { sys, kbm, tick } = setup();
    for (const cls of ["keyboardMouse", "gamepad", "touch"] as const) expect(sys.detectConflicts(cls)).toEqual([]);
    const r = sys.rebind("Jump", "keyboardMouse", { control: "key.KeyR" }); expect(r.conflicts.map((c) => c.action)).toEqual(["Reload"]);
    sys.resetBindings("keyboardMouse", "Jump"); const s = sys.rebind("Jump", "keyboardMouse", { control: "key.KeyR" }, { swap: true }); expect(s.conflicts).toEqual([]);
    kbm.press("key.Space"); tick(); expect(sys.pressed("Reload")).toBe(true); kbm.releaseAll(); tick();
    const saved = sys.serializeOverrides(); const other = setup().sys; other.loadOverrides(saved); expect(other.bindings("keyboardMouse", "Gameplay").find((b) => b.binding.action === "Jump")!.binding.control).toBe("key.KeyR");
    let store = ""; other.useStorage({ load: () => saved, save: (d) => { store = d; } }); other.resetBindings(); expect(JSON.parse(store).overrides).toEqual([]);
    const p = sys.listenForNextInput({ deviceClass: "keyboardMouse" }); kbm.press("key.KeyK"); tick(); expect(await p).toEqual({ control: "key.KeyK", deviceClass: "keyboardMouse" });
    const c = sys.listenForNextInput(); kbm.press("key.Escape"); tick(); expect(await c).toBeNull();
    sys.unbind("Reload", "keyboardMouse"); expect(sys.bindings("keyboardMouse", "Gameplay").some((b) => b.binding.action === "Reload")).toBe(false);
  });
});

describe("touch", () => {
  it("virtual joystick (floating, deadzone), button hold-cancel, radial, mirror, scaling", () => {
    const { sys, touch, tick } = setup(); const vc = new VirtualControls(DEFAULT_TOUCH_LAYOUTS.gameplay, touch); vc.resize({ w: 844, h: 390, insets: { top: 0, right: 30, bottom: 20, left: 30 } });
    expect(vc.scale).toBe(1); expect(vc.pointerDown(1, 100, 300)).toBe(true); vc.pointerMove(1, 160, 300); tick(); expect(sys.vector("Move")[0]).toBe(1);
    vc.pointerMove(1, 103, 300); tick(); expect(sys.vector("Move")).toEqual([0, 0]); vc.pointerUp(1);
    const atk = vc.geometry().find((g) => g.id === "attack")!; vc.pointerDown(2, atk.x, atk.y); tick(); expect(sys.down("Primary")).toBe(true);
    vc.pointerMove(2, atk.x - 200, atk.y); tick(); expect(sys.down("Primary")).toBe(false); vc.pointerUp(2); tick();
    const ctxBtn = vc.geometry().find((g) => g.id === "context")!; let canceled = false; sys.on("Interact", (e) => { if (e.phase === "canceled") canceled = true; });
    vc.pointerDown(3, ctxBtn.x, ctxBtn.y); tick(); vc.pointerMove(3, ctxBtn.x, ctxBtn.y - 300); tick(); vc.pointerUp(3); tick(); expect(sys.pressed("Interact")).toBe(false); expect(canceled).toBe(true);
    // Radials remain supported for custom layouts, but are no longer an on-screen gameplay control (ADR-289).
    const radial = new VirtualControls({ ...DEFAULT_TOUCH_LAYOUTS.gameplay, elements: [{ id: "hotbar", kind: "radial", anchor: { x: .6, y: .4 }, radius: 24, items: ["1","2","3","4","5","6","7","8"], control: "touch.hotbar" }] }, touch); radial.resize({ w: 844, h: 390 });
    const hb = radial.geometry()[0]!; radial.pointerDown(4, hb.x, hb.y); radial.pointerMove(4, hb.x + 50, hb.y + 5); radial.pointerUp(4); tick(); expect(sys.pressed("Hotbar3")).toBe(true);
    vc.leftHanded = true; expect(vc.geometry().find((g) => g.id === "attack")!.x).toBeLessThan(400); vc.resize({ w: 1688, h: 780 }); expect(vc.scale).toBe(1.15); vc.resize({ w: 600, h: 300 }); expect(vc.scale).toBe(1); // ADR-133 clamp
    expect(vc.geometry().some(g => g.id === "sprint" || g.id === "hotbar")).toBe(false);
  });
  it("gestures: tap, double-tap, long-press, drag, swipe, pinch, rotate; device pulses", () => {
    const got: Gesture["type"][] = []; const dev = new TouchDevice(); const g = new GestureRecognizer((x) => got.push(x.type), {}, dev);
    g.down(1, 10, 10, 0); g.up(1, 10, 10, 100); g.down(1, 11, 10, 200); g.up(1, 11, 10, 260);
    g.down(1, 50, 50, 1000); g.update(1600); g.up(1, 50, 50, 1700);
    g.down(1, 0, 0, 2000); g.move(1, 50, 0, 2050); g.move(1, 120, 0, 2100); g.up(1, 120, 0, 2120);
    g.down(1, 0, 0, 3000); g.down(2, 100, 0, 3000); g.move(2, 150, 0, 3050); g.move(2, 150, 80, 3100); g.up(2, 150, 80, 3150); g.up(1, 0, 0, 3150);
    expect(got).toEqual(expect.arrayContaining(["tap", "doubleTap", "longPress", "dragStart", "drag", "dragEnd", "swipe", "pinch", "rotate"]));
    expect(dev.snapshot()["touch.swipe.right"]).toBe(1); expect(dev.snapshot()["touch.pinch.out"]).toBeGreaterThan(0);
  });
  it("touch ghost: floats above finger, snaps, rotates, places only on confirm", () => {
    const placed: unknown[] = []; const ghost = new TouchGhostController((sx, sy) => ({ x: sx / 10, y: sy / 10 }), { ghostSnap: (_w, _a, p, r) => (r > 0 ? { x: Math.round(p.x), y: Math.round(p.y) } : undefined) });
    ghost.drag(null, 1, 104, 164, { device: "touch", activeDevice: undefined }); expect(ghost.ghost).toEqual({ x: 10, y: 10, rot: 0 });
    ghost.release(); expect(placed).toEqual([]); ghost.rotate(-1); expect(ghost.confirm()).toEqual({ x: 10, y: 10, rot: 3 }); ghost.cancel(); expect(ghost.confirm()).toBeUndefined();
  });
});

describe("aim", () => {
  it("mouse -> world point via screenToWorld; gamepad stick + aimAssist (never mouse); touch autoTarget", () => {
    const { sys, kbm, pad, touch, tick } = setup(); const calls: string[] = [];
    const aim = new AimResolver(sys, { screenToWorld: (x, y) => ({ x: x / 64, y: y / 32 }), hooks: {
      aimAssist: (_w, _a, d, c) => { calls.push(c.device); return { x: d.x, y: d.y + 0.1 }; }, autoTarget: () => ({ x: 7, y: 8 }), contextAction: (_w, _a, c) => ({ action: "Interact", label: c.device === "touch" ? "Open" : "E" }) } });
    kbm.set("mouse.x", 128); kbm.set("mouse.y", 64); kbm.press("key.KeyQ"); tick(); expect(aim.resolve(null, 1, { x: 0, y: 0 })).toEqual({ x: 2, y: 2, mode: AimMode.WorldPoint });
    pad.set("pad.rx", 1); tick(); const a = aim.resolve(null, 1, { x: 0, y: 0 }); expect(a.mode).toBe(AimMode.Direction); expect(a.y).toBeGreaterThan(0); expect(calls).toEqual(["gamepad"]);
    pad.set("pad.rx", 0); tick(); expect(aim.resolve(null, 1, { x: 0, y: 0 }).x).toBeCloseTo(a.x); // last direction kept
    touch.press("touch.btn.attack"); tick(); expect(aim.resolve(null, 1, { x: 0, y: 0 })).toEqual({ x: 7, y: 8, mode: AimMode.WorldPoint }); expect(aim.contextAction(null, 1)!.label).toBe("Open");
    const st = new InputState(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING, aim.resolve(null, 1, { x: 0, y: 0 })); expect(st.sample(1)).toMatchObject({ aimX: 7, aimY: 8, aimMode: AimMode.WorldPoint });
    const seen: string[] = []; sys.onDeviceChange((c) => seen.push(c)); kbm.press("key.KeyZ"); tick(); expect(seen).toEqual(["keyboardMouse"]); expect(sys.lastUsedDeviceClass).toBe("keyboardMouse");
  });
});

describe("focus navigation", () => {
  it("spatial nav, explicit neighbors, wrap, tabs, memory, modal trap, tap submit, virtual keyboard, repeat via actions", () => {
    const vk: string[] = []; const scrolled: string[] = []; const fm = new FocusManager({ requestVirtualKeyboard: (n, d) => vk.push(`${n.id}:${d}`), scrollIntoView: (n) => scrolled.push(n.id) });
    fm.pushScreen("inv"); fm.defineGroup({ id: "grid", wrap: true, order: 0 }); fm.defineGroup({ id: "side", order: 1 }); let submitted = "";
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) fm.add({ id: `s${r}${c}`, rect: { x: c * 50, y: r * 50, w: 40, h: 40 }, group: "grid", onSubmit: () => { submitted = `s${r}${c}`; } });
    fm.add({ id: "name", rect: { x: 300, y: 0, w: 100, h: 30 }, group: "side", textField: true }); fm.add({ id: "ok", rect: { x: 300, y: 50, w: 100, h: 30 }, group: "side", neighbors: { left: "s00" } });
    expect(fm.focused).toBe("s00"); fm.navigate("right"); expect(fm.focused).toBe("s01"); fm.navigate("down"); expect(fm.focused).toBe("s11");
    fm.navigate("right"); fm.navigate("right"); expect(fm.focused).toBe("s10"); // wrap within group
    fm.tab(1); expect(fm.focused).toBe("name"); fm.submit("gamepad"); expect(vk).toEqual(["name:gamepad"]); fm.navigate("down"); fm.navigate("left"); expect(fm.focused).toBe("s00");
    fm.tapAt(55, 55); expect(submitted).toBe("s11"); expect(scrolled.length).toBeGreaterThan(3);
    fm.pushScreen("confirm", true); fm.add({ id: "yes", rect: { x: 0, y: 200, w: 50, h: 20 } }); fm.add({ id: "no", rect: { x: 60, y: 200, w: 50, h: 20 } });
    fm.setFocus("yes"); fm.navigate("up"); expect(fm.focused).toBe("yes"); fm.navigate("right"); expect(fm.focused).toBe("no");
    fm.popScreen(); expect(fm.focused).toBe("s00"); fm.setFocus("s11"); fm.popScreen(); fm.pushScreen("inv");
    const { sys, pad, tick } = setup(); sys.push("Inventory"); const fm2 = new FocusManager(); fm2.pushScreen("x");
    for (let i = 0; i < 6; i++) fm2.add({ id: `n${i}`, rect: { x: 0, y: i * 40, w: 40, h: 30 } }); let backed = false;
    fm2.attach(sys, DEFAULT_FOCUS_ACTIONS, { delayMs: 300, rateMs: 100, onBack: () => { backed = true; } });
    pad.set("pad.ddown", 1); const run = (n: number) => { for (let i = 0; i < n; i++) { tick(50); fm2.tick(); } };
    run(1); expect(fm2.focused).toBe("n1"); run(5); expect(fm2.focused).toBe("n1"); run(2); expect(fm2.focused).toBe("n2"); run(2); expect(fm2.focused).toBe("n3");
    pad.set("pad.ddown", 0); pad.set("pad.b", 1); run(1); expect(backed).toBe(true);
  });
});

describe("prompts", () => {
  it("glyph ids per device class and layout", () => {
    const { sys } = setup();
    expect(promptFor(sys, "Interact", "keyboardMouse")).toEqual({ glyphs: ["kbm.key.e"], interaction: "tap", modifiers: [] });
    expect(promptFor(sys, "Jump", "gamepad")!.glyphs).toEqual(["gamepad.xbox.a"]); expect(promptFor(sys, "Jump", "gamepad", "playstation")!.glyphs).toEqual(["gamepad.playstation.cross"]);
    expect(promptFor(sys, "Jump", "gamepad", "switch")!.glyphs).toEqual(["gamepad.switch.b"]); expect(promptFor(sys, "Move", "gamepad")!.glyphs).toEqual(["gamepad.xbox.ls"]);
    expect(promptFor(sys, "Inv.QuickTransfer", "keyboardMouse")).toEqual({ glyphs: ["kbm.mouse.left"], interaction: "press", modifiers: ["kbm.key.shift"] });
    expect(promptFor(sys, "Primary", "touch")!.glyphs).toEqual(["touch.button.attack"]); expect(glyphFor("touch.move.x")).toBe("touch.joystick"); expect(glyphFor("key.Digit3")).toBe("kbm.key.3");
    expect(promptFor(sys, "Nope", "touch")).toBeUndefined();
  });
});

describe("recording & determinism", () => {
  it("record/replay devices reproduces identical InputFrames", () => {
    const run = (replay?: InputReplayer) => {
      const { sys, kbm, pad, tick } = setup(); const rec = new InputRecorder([kbm, pad]); const log = new FrameLog(); const st = new InputState(); const r = replay ? new InputReplayer((replay as unknown as { rec: never }).rec, [kbm, pad]) : undefined;
      for (let t = 0; t < 30; t++) {
        if (r) r.apply(t); else { if (t === 2) kbm.press("key.KeyW"); if (t === 5) kbm.press("key.Space"); if (t === 6) kbm.release("key.Space"); if (t === 10) pad.set("pad.lx", -0.7); if (t === 20) { kbm.releaseAll(); pad.set("pad.lx", 0); } }
        rec.capture(t); tick(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING); log.push(st.sample(t));
      }
      return { rec, log };
    };
    const a = run(); const b = run(new InputReplayer(a.rec.recording, []));
    expect(b.log.frames).toEqual(a.log.frames); expect(a.log.frames.some((f) => f.edges === DefaultEdgeBits.Jump)).toBe(true);
    expect(JSON.parse(a.rec.toJSON()).version).toBe(1);
  });
  it("default profiles reference only defined actions; every contract action is bound on all device classes", () => {
    const names = new Set(DEFAULT_ACTIONS.map((a) => a.name));
    for (const p of DEFAULT_PROFILES as BindingProfile[]) for (const list of Object.values(p.bindings)) for (const b of list) expect(names.has(b.action)).toBe(true);
    const must = ["Move", "Sprint", "Primary", "Secondary", "Crouch", "Interact", "ContextRadial", "Charge", "Jump", "Reload", "Hotbar1", "Hotbar8", "HotbarNext", "HotbarPrev", "QuickUse", "ToggleInventory",
      "ToggleCrafting", "ToggleMap", "OpenChat", "OpenSocial", "Cancel", "Build.PlaceConfirm", "Build.Cancel", "Build.RotateCW", "Build.RotateCCW", "Build.PieceNext", "Build.TierNext", "Build.ToggleSnap",
      "Build.LevelUp", "Build.DemolishMode", "Build.UpgradeMode", "Build.RepairMode", "Inv.MoveSlot", "Inv.SplitStack", "Inv.Drop", "Inv.QuickTransfer", "Inv.Equip", "Inv.Use", "Inv.TakeAll", "Inv.Sort",
      "Craft.Craft", "Craft.Amount", "Craft.Cancel", "Trade.AddOffer", "Trade.RemoveOffer", "Trade.Lock", "Trade.Confirm", "Chat.Send", "Chat.Cancel", "Chat.SwitchChannel",
      "Social.Invite", "Social.Kick", "Social.Promote", "Social.Demote", "Social.Leave", "Social.SetPermissions", "Social.ContextMenu", "Dialog.Confirm", "Dialog.Cancel"];
    for (const p of DEFAULT_PROFILES as BindingProfile[]) { const bound = new Set(Object.values(p.bindings).flat().map((b) => b.action)); for (const m of must) expect(bound.has(m), `${p.deviceClass} ${m}`).toBe(true); }
  });
});
