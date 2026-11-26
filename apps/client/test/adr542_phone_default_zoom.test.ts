// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { DESKTOP_ZOOM, INDOOR_GAIN, PHONE_CLOSER, PHONE_ZOOM, USER_ZOOM_MIN, ZOOM_RESET_KEY, attachZoom, defaultZoom, isPhoneDevice, loadUserZoom, migrateStoredZoom, saveUserZoom } from "../src/camera-zoom.js";

/** ADR-542: the default zoom is much closer on phones only (0.557 → 0.709, option B), desktop keeps its exact
 * current default, and a one-time migration drops any pre-change stored zoom so existing players feel it too.
 * Detection reuses the coarse-pointer test main.ts uses for the virtual touch layout. */

const mem = () => { const m = new Map<string, string>(); let writes = 0;
  return { st: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { writes++; m.set(k, v); } }, writes: () => writes, raw: () => Object.fromEntries(m) }; };
const el = () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;

// Stub the pointer media query the way a phone (coarse) / desktop (fine) browser answers it.
const origMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
const setPointer = (coarse: boolean): void => {
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", media: q, addEventListener: () => {}, removeEventListener: () => {} });
};
afterEach(() => { (globalThis as { matchMedia?: unknown }).matchMedia = origMatchMedia; });

const disposables: { dispose(): void }[] = [];
afterEach(() => { for (const d of disposables.splice(0)) d.dispose(); });

describe("ADR-542 phone-only closer default zoom", () => {
  it("phone default ≈ 0.709 (option B) portrait and landscape, symmetric; desktop unchanged at 1.543", () => {
    expect(PHONE_CLOSER).toBeCloseTo(1.4, 6);
    expect(defaultZoom(390, 844, true)).toBeCloseTo(0.709, 3);
    expect(defaultZoom(844, 390, true)).toBeCloseTo(0.709, 3);
    expect(defaultZoom(390, 844, true)).toBeCloseTo(defaultZoom(844, 390, true), 9); // symmetry kept on phones
    expect(defaultZoom(390, 844, false)).toBeCloseTo(0.557, 3);
    expect(defaultZoom(1920, 1080, false)).toBeCloseTo(DESKTOP_ZOOM, 6);
    expect(defaultZoom(1920, 1080, false)).toBeCloseTo(1.5436, 3);
    expect(defaultZoom(0, 0, true)).toBe(PHONE_ZOOM);
    expect(defaultZoom(0, 0, false)).toBe(DESKTOP_ZOOM);
  });
  it("runtime detection: coarse pointer takes the phone branch, fine pointer the desktop branch", () => {
    setPointer(true); expect(isPhoneDevice()).toBe(true); expect(defaultZoom(390, 844)).toBeCloseTo(0.709, 3);
    setPointer(false); expect(isPhoneDevice()).toBe(false); expect(defaultZoom(390, 844)).toBeCloseTo(0.557, 3);
  });
  it("attachZoom applies the phone default on a coarse-pointer phone viewport, desktop default on PC", () => {
    setPointer(true);
    const cam = { zoom: 0 }; const zc = attachZoom(cam, el(), { storage: mem().st, viewport: () => ({ w: 390, h: 844 }) });
    disposables.push(zc); expect(cam.zoom).toBeCloseTo(0.709, 3);
    setPointer(false);
    const cam2 = { zoom: 0 }; const zc2 = attachZoom(cam2, el(), { storage: mem().st, viewport: () => ({ w: 1920, h: 1080 }) });
    disposables.push(zc2); expect(cam2.zoom).toBeCloseTo(DESKTOP_ZOOM, 6);
  });
  it("indoor absolute on phone is 0.709 × 1.55 ≈ 1.10 — INDOOR_GAIN and USER_ZOOM_MIN unchanged", () => {
    expect(INDOOR_GAIN).toBe(1.55); expect(USER_ZOOM_MIN).toBe(0.68);
    setPointer(true);
    const cam = { zoom: 0 }; const zc = attachZoom(cam, el(), { storage: mem().st, viewport: () => ({ w: 390, h: 844 }) });
    disposables.push(zc);
    for (let i = 0; i < 200; i++) zc.setIndoor(true, 16);
    expect(cam.zoom).toBeCloseTo(0.709 * INDOOR_GAIN, 2); // ≈ 1.10
  });
});

describe("ADR-542 one-time stored-zoom reset", () => {
  it("a stored old multiplier migrates to the new default on first load; other settings survive", () => {
    const { st } = mem();
    st.setItem("engine-settings", JSON.stringify({ bots: 5, zoom: 1.4 }));
    expect(migrateStoredZoom(st)).toBe(true);
    expect(JSON.parse(st.getItem("engine-settings")!)).toEqual({ bots: 5 }); // zoom dropped, bots kept
    expect(st.getItem(ZOOM_RESET_KEY)).toBe("542");
    expect(loadUserZoom(st)).toBe(1); // fresh default multiplier
    expect(migrateStoredZoom(st)).toBe(false); // marker prevents a second reset
  });
  it("attachZoom migrates on construction, then a zoom set after the change survives the next load", async () => {
    const { st } = mem();
    st.setItem("engine-settings", JSON.stringify({ zoom: 0.8 }));
    const cam = { zoom: 0 };
    const zc = attachZoom(cam, el(), { storage: st, viewport: () => ({ w: 390, h: 844 }) });
    disposables.push(zc);
    expect(zc.user).toBe(1); // old 0.8 dropped
    zc.setUser(1.2); await new Promise((r) => setTimeout(r, 350)); // past the debounced save
    expect(loadUserZoom(st)).toBe(1.2);
    const cam2 = { zoom: 0 };
    const zc2 = attachZoom(cam2, el(), { storage: st, viewport: () => ({ w: 390, h: 844 }) });
    disposables.push(zc2);
    expect(zc2.user).toBe(1.2); // marker: no second reset
  });
  it("a fresh profile gets the new default and the first load writes nothing", () => {
    const { st, writes } = mem();
    setPointer(true);
    const cam = { zoom: 0 }; const zc = attachZoom(cam, el(), { storage: st, viewport: () => ({ w: 390, h: 844 }) });
    disposables.push(zc);
    expect(cam.zoom).toBeCloseTo(0.709, 3);
    expect(writes()).toBe(0); // no stored zoom to drop, so no marker write yet (ADR-541 no-persistence invariant)
    expect(st.getItem(ZOOM_RESET_KEY)).toBeNull();
  });
  it("saveUserZoom marks the reset, so a zoom saved after the change is never reset later", async () => {
    const { st } = mem();
    saveUserZoom(1.25, st);
    expect(st.getItem(ZOOM_RESET_KEY)).toBe("542");
    expect(migrateStoredZoom(st)).toBe(false); // marker present: the 1.25 just saved is safe
    expect(loadUserZoom(st)).toBe(1.25);
  });
  it("corrupt engine-settings does not throw and does not mark the migration done", () => {
    const { st } = mem();
    st.setItem("engine-settings", "{not json");
    expect(migrateStoredZoom(st)).toBe(false);
    expect(st.getItem(ZOOM_RESET_KEY)).toBeNull(); // retried on the next load
    expect(loadUserZoom(st)).toBe(1);
  });
});
