// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transform, World } from "@engine/core";
import { compassFacing, compassOf, moveVector } from "@engine/gameplay";
import { rotateScreenVec } from "@engine/input";
import { DEFAULT_ISO, NORTH_FACING, PREVIEW, northUpToWorld, previewWorldAt, worldToNorthUp, worldToScreen } from "@engine/world";
import { attachCameraRotate, loadView, screenDirToWorld } from "../src/camera-rotate.js";
import { compassHudText, compassScreenAngle, idleCompass, mountCompassHud } from "../src/compass-hud.js";
import { canvasToWorld, createWorldMap, mapWorldBounds, worldToCanvas } from "../src/world-map.js";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9);
};
const storage = (view?: number) => {
  let value = JSON.stringify({ zoom: 1.2, ...(view === undefined ? {} : { view }) });
  return { getItem: () => value, setItem: (_: string, v: string) => { value = v; } };
};
describe("ADR-273 one geographic north, four local camera views", () => {
  it.each([[0, "N", 0], [1, "W", 270], [2, "S", 180], [3, "E", 90]] as const)("q%i screen-up is %s (%i degrees)", (q, dir, heading) => {
    const [x, y] = rotateScreenVec([0, -1], q);
    const m = moveVector(0, { x, y }), facing = Math.atan2(m.dy, m.dx);
    expect(compassOf(facing)).toEqual({ dir, heading });
    near(screenDirToWorld(0, -1, q), { x: m.dx, y: m.dy });
    const rendered = worldToScreen(m.dx, m.dy, 0, { ...DEFAULT_ISO, view: q });
    expect(rendered.sx).toBeCloseTo(0); expect(rendered.sy).toBeLessThan(0);
    expect(compassScreenAngle(heading, q)).toBeCloseTo(0);
    const map = worldToNorthUp(m.dx, m.dy);
    expect(Math.atan2(map.x, -map.y) * 180 / Math.PI).toBeCloseTo(heading > 180 ? heading - 360 : heading);
  });
  it("all geographic headings round-trip and cardinal world vectors are shared, not view-relative", () => {
    for (let h = 0; h < 360; h += 15) expect(compassOf(compassFacing(h)).heading).toBeCloseTo(h);
    expect(compassOf(NORTH_FACING)).toEqual({ dir: "N", heading: 0 });
    near(worldToNorthUp(-1, -1), { x: 0, y: -Math.SQRT2 });
    near(worldToNorthUp(1, -1), { x: Math.SQRT2, y: 0 });
    const world = northUpToWorld(23, -71); near(worldToNorthUp(world.x, world.y), { x: 23, y: -71 });
  });
  it("keeps q0 default and restores every saved quarter without rewriting settings", () => {
    expect(loadView(storage())).toBe(0);
    for (let q = 0; q < 4; q++) {
      const st = storage(q), before = st.getItem(); let shown = 0;
      const input = { viewQuarter: 0, pressed: () => false };
      const c = attachCameraRotate({ storage: st, input, pivot: () => ({ x: 8, y: 9 }),
        target: () => ({ get viewRotation() { return shown; }, setViewRotation(v) { shown = v; } }) });
      expect(c.view).toBe(q); expect(shown).toBe(q); expect(input.viewQuarter).toBe(q);
      expect(st.getItem()).toBe(before); c.dispose();
    }
  });
  it("float32 north facing displays N 0°, never N 360°", () => {
    const f = Math.fround(NORTH_FACING); expect(compassHudText(f)).toBe("N 0°");
    const hud = mountCompassHud({ heading: () => compassOf(f) }); hud.update(true);
    expect(hud.el.textContent).toContain("N 0°"); expect(hud.el.getAttribute("aria-label")).toBe("Facing N, 0 degrees"); hud.destroy();
  });
  it("HUD north needle follows view changes even when geographic text is unchanged", () => {
    let q = 0;
    const hud = mountCompassHud({ heading: idleCompass, view: () => q });
    const needle = hud.el.querySelector<HTMLElement>(".needle")!;
    for (q = 0; q < 4; q++) {
      hud.update(true); expect(hud.el.textContent).toContain("N 0°");
      const angle = Number(needle.style.transform.match(/rotate\((.*)deg\)/)![1]);
      const expected = [0, 90, 180, -90][q]!;
      expect(Math.cos(angle * Math.PI / 180)).toBeCloseTo(Math.cos(expected * Math.PI / 180));
      expect(Math.sin(angle * Math.PI / 180)).toBeCloseTo(Math.sin(expected * Math.PI / 180));
    }
    hud.destroy();
  });
});

describe("ADR-273 north-up world map and seed preview", () => {
  const c = { x: -45, y: 81 }, W = 480, H = 360;
  it("map north goes straight up, east right; every pixel is pickable and bounds include all four corners", () => {
    const n = worldToCanvas(c.x - 10, c.y - 10, W, H, c, 8);
    expect(n.px).toBeCloseTo(W / 2); expect(n.py).toBeLessThan(H / 2);
    const e = worldToCanvas(c.x + 10, c.y - 10, W, H, c, 8);
    expect(e.px).toBeGreaterThan(W / 2); expect(e.py).toBeCloseTo(H / 2);
    for (const scale of [2, 8, 32]) {
      const bounds = mapWorldBounds(W, H, c, scale);
      for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H], [123, 271]]) {
        const w = canvasToWorld(px!, py!, W, H, c, scale), p = worldToCanvas(w.x, w.y, W, H, c, scale);
        expect(p.px).toBeCloseTo(px!); expect(p.py).toBeCloseTo(py!);
        expect(w.x).toBeGreaterThan(bounds.x0); expect(w.x).toBeLessThan(bounds.x1);
        expect(w.y).toBeGreaterThan(bounds.y0); expect(w.y).toBeLessThan(bounds.y1);
      }
    }
  });
  it("thumbnail rows go south, columns east, with exact inverse world-tile sampling", () => {
    const cx = PREVIEW.width / 2, cy = PREVIEW.height / 2;
    const centre = previewWorldAt(cx, cy), n = previewWorldAt(cx, cy - 8), e = previewWorldAt(cx + 8, cy);
    near(centre, { x: 0, y: 0 });
    expect(n.x).toBeLessThan(0); expect(n.y).toBe(n.x);
    expect(e.x).toBeGreaterThan(0); expect(e.y).toBeLessThan(0);
    for (const [x, y] of [[0, 0], [PREVIEW.width - 1, PREVIEW.height - 1], [15, 45]]) {
      const w = previewWorldAt(x!, y!), map = worldToNorthUp(w.x, w.y);
      expect(Math.abs(map.x - (PREVIEW.x + x! * PREVIEW.stride))).toBeLessThan(Math.SQRT2);
      expect(Math.abs(map.y - (PREVIEW.y + y! * PREVIEW.stride))).toBeLessThan(Math.SQRT2);
    }
  });
  it("terrain transform, pad pan, pointer picking and drag use the same north-up basis", () => {
    const ctx = new Proxy({ transform: vi.fn() }, { get: (t, key) => key in t ? t[key as keyof typeof t] : vi.fn(), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const w = new World(), p = w.create(); w.add(p, Transform, { x: c.x, y: c.y, z: 0 });
    const sent: { args: { x: number; y: number } }[] = [];
    const m = createWorldMap({ world: () => w, player: () => p, tiles: () => undefined, send: i => { sent.push(i as never); return true; } });
    document.body.append(m.el); const canvas = m.el.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H, toJSON() {} });
    const submit = () => m.el.querySelector<HTMLButtonElement>('[data-role="submit"]')!.click();
    m.el.querySelector<HTMLButtonElement>('[data-key="pan-up"]')!.click();
    Array.from(m.el.querySelectorAll("button")).find(b => b.textContent === "Mark here")!.click(); submit();
    near(sent[0]!.args, { x: c.x - 4 * Math.SQRT1_2, y: c.y - 4 * Math.SQRT1_2 });
    const event = (type: string, x: number, y: number) => {
      const e = new Event(type); Object.assign(e, { pointerId: 1, clientX: x, clientY: y }); canvas.dispatchEvent(e);
    };
    event("pointerdown", 240, 100); event("pointerup", 240, 100); submit();
    const centre = sent[0]!.args, picked = canvasToWorld(240, 100, W, H, centre, 16);
    near(sent[1]!.args, picked);
    event("pointerdown", 240, 180); event("pointermove", 280, 180); event("pointerup", 280, 180);
    Array.from(m.el.querySelectorAll("button")).find(b => b.textContent === "Mark here")!.click(); submit();
    near(sent[2]!.args, { x: centre.x - 2.5 * Math.SQRT1_2, y: centre.y + 2.5 * Math.SQRT1_2 });
    const k = 16 * Math.SQRT1_2; expect(ctx.transform).toHaveBeenCalledWith(k, k, -k, k, 0, 0);
    m.destroy();
  });
});
