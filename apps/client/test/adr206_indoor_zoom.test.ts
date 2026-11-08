import { describe, it, expect } from "vitest";
import { ADR175_ZOOM, DESKTOP_ZOOM, INDOOR_GAIN, USER_ZOOM_MAX, USER_ZOOM_MIN, attachZoom, defaultZoom, indoorStep, padZoomStep } from "../src/camera-zoom.js";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const el = () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {}; (globalThis as { removeEventListener?: unknown }).removeEventListener ??= () => {};

describe("ADR-206 zoom: closer default + max, indoor ease", () => {
  it("default ~10% closer, max zoom-in closer, farthest view unchanged, phones still match PC span", () => {
    expect(DESKTOP_ZOOM / ADR175_ZOOM).toBeCloseTo(1.1, 6);
    expect(DESKTOP_ZOOM * USER_ZOOM_MAX).toBeGreaterThan(ADR175_ZOOM * 1.6 * 1.15);
    expect(DESKTOP_ZOOM * USER_ZOOM_MIN).toBeCloseTo(ADR175_ZOOM * 0.75, 1);
    // landscape phone: same vertical world span as PC
    expect(844 / 390 > 1920 / 1080 ? 390 / defaultZoom(844, 390) : 0).toBeCloseTo(1080 / DESKTOP_ZOOM, 3);
  });
  it("indoor easing is smooth (no frame step > 4%), frame-rate independent, and returns to exactly 1", () => {
    let a = 1, b = 1; for (let i = 0; i < 60; i++) a = indoorStep(a, true, 16.67); for (let i = 0; i < 120; i++) b = indoorStep(b, true, 8.333);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
    let z = 1, maxStep = 0; for (let i = 0; i < 200; i++) { const n = indoorStep(z, true, 16.67); maxStep = Math.max(maxStep, n / z - 1); z = n; }
    expect(z).toBe(INDOOR_GAIN); expect(maxStep).toBeLessThan(0.04);
    for (let i = 0; i < 300; i++) z = indoorStep(z, false, 16.67); expect(z).toBe(1);
  });
  it("indoor is a relative offset on top of the user zoom; debounced door flicker never moves the camera", () => {
    const cam = { zoom: 0 }; const zc = attachZoom(cam, el(), { storage: mem(), viewport: () => ({ w: 1920, h: 1080 }) });
    zc.setUser(1.3); const base = cam.zoom; expect(base).toBeCloseTo(DESKTOP_ZOOM * 1.3);
    for (let i = 0; i < 20; i++) zc.setIndoor(i % 4 < 2, 16); expect(cam.zoom).toBe(base); // flicker at a doorway
    for (let i = 0; i < 200; i++) zc.setIndoor(true, 16); expect(cam.zoom).toBeCloseTo(base * INDOOR_GAIN, 4);
    zc.setUser(1); expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM * INDOOR_GAIN, 4); // user zoom still applies while indoors
    for (let i = 0; i < 300; i++) zc.setIndoor(false, 16); expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM, 6);
    zc.dispose();
  });
  it("gamepad-only: RB + D-pad reaches the new max and min", () => {
    let z = 1; for (let i = 0; i < 300; i++) z = padZoomStep(z, 1, 16); expect(z).toBe(USER_ZOOM_MAX);
    for (let i = 0; i < 300; i++) z = padZoomStep(z, -1, 16); expect(z).toBe(USER_ZOOM_MIN);
  });
  it("ADR-304: indoor zoom pulls in much closer than the old x1.15", () => {
    expect(INDOOR_GAIN).toBeCloseTo(1.55);
    expect(INDOOR_GAIN).toBeGreaterThan(1.4);
    const cam = { zoom: 0 }; const zc = attachZoom(cam, el(), { storage: mem(), viewport: () => ({ w: 1920, h: 1080 }) });
    for (let i = 0; i < 200; i++) zc.setIndoor(true, 16);
    expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM * INDOOR_GAIN, 4);
    zc.dispose();
  });
});
