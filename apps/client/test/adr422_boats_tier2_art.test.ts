// @vitest-environment jsdom
// ADR-422: dedicated tier-2 motorboat art — painted at runtime (apps/client/src/task421-art.ts),
// declared in the pack/task422 fragment. Verified numerically like ADR-421 (pixel checks, not
// eyeballs): three distinct non-empty atlases, throttle phases and directions differ, the dark-plum
// outline is present, full throttle holds the widest prop wash, and the kit menu icons are
// non-blank. The merged registry half (resolveVehicleArt binding by def id, `wake` cycle) lives in
// adr421_boats_registry.test.ts (node environment). The user is the final visual check (no GL in the VM).
import { describe, expect, it } from "vitest";
import {
  boatFrame, boatFrameSize, installMotorboatMenuIcons, paintMotorboatMenuIconPixels, paintTask422Atlases,
  BOAT_ATLAS_COLS, BOAT_ATLAS_ROWS, MOTORBOAT_IDS, BOAT_PHASES, TASK422_ATLAS_KEYS, MOTORBOAT_ART,
} from "../src/task421-art.js";
import rawVehicles from "../../../packages/gameplay/data/vehicles.json";

/** "opaque:meanR:meanG:meanB" signature of one frame cell, plus outline- and wake-pixel counts. */
function cellSig(atlas: { width: number; height: number; pixels: Uint8ClampedArray }, col: number, row: number, fw: number, fh: number): { sig: string; opaque: number; outline: number; wake: number } {
  const ox = col * fw, oy = row * fh;
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0, wake = 0;
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const i = ((oy + y) * atlas.width + (ox + x)) * 4;
    const a = atlas.pixels[i + 3]!;
    if (a > 16) {
      opaque++; r += atlas.pixels[i]!; g += atlas.pixels[i + 1]!; b += atlas.pixels[i + 2]!;
      if (atlas.pixels[i] === 40 && atlas.pixels[i + 1] === 30 && atlas.pixels[i + 2] === 50) outline++;
      if (atlas.pixels[i] === 120 && atlas.pixels[i + 1] === 180 && atlas.pixels[i + 2] === 210) wake++;
    }
  }
  expect(opaque).toBeGreaterThan(40);
  return { sig: `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`, opaque, outline, wake };
}

describe("ADR-422 task422 art", () => {
  it("paints three atlases (4 cols x 6 rows) with distinct non-empty cells; geometry matches vehicles.json", () => {
    expect(TASK422_ATLAS_KEYS).toEqual(["veh_art_motorboat", "veh_art_pontoon", "veh_art_speedboat"]);
    expect(MOTORBOAT_IDS).toEqual(["motorboat", "pontoon", "speedboat"]);
    expect(BOAT_PHASES).toBe(3); expect(BOAT_ATLAS_COLS).toBe(4); expect(BOAT_ATLAS_ROWS).toBe(6);
    expect(boatFrame(0, 0)).toBe(0); expect(boatFrame(1, 0)).toBe(8); expect(boatFrame(2, 7)).toBe(23);
    const defs = (rawVehicles as { vehicles: { id: string; footprint: { length: number; width: number } }[] }).vehicles;
    for (const id of MOTORBOAT_IDS) {
      const json = defs.find((v) => v.id === id)!;
      expect(MOTORBOAT_ART[id].length).toBe(json.footprint.length);
      expect(MOTORBOAT_ART[id].width).toBe(json.footprint.width);
      expect(MOTORBOAT_ART[id].propulsion).toBe("motor");
      expect(MOTORBOAT_ART[id].paddles).toEqual([]); // no paddles on a motorboat
    }
    const atlases = paintTask422Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK422_ATLAS_KEYS]);
    const whole = new Set<string>();
    for (const a of atlases) {
      const f = boatFrameSize(MOTORBOAT_ART[a.key.replace("veh_art_", "") as (typeof MOTORBOAT_IDS)[number]]);
      expect(a.width).toBe(f.w * BOAT_ATLAS_COLS); expect(a.height).toBe(f.h * BOAT_ATLAS_ROWS);
      expect(a.width).toBeLessThanOrEqual(2048); expect(a.height).toBeLessThanOrEqual(2048); // mobile texture cap
      let opaque = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) { opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!; }
      const sig = `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`;
      expect(whole.has(sig)).toBe(false); whole.add(sig);
    }
    expect(whole.size).toBe(3);
  });

  it("throttle phases and directions differ, with the 1px dark outline; full throttle holds the widest wash", () => {
    for (const a of paintTask422Atlases()) {
      const d = MOTORBOAT_ART[a.key.replace("veh_art_", "") as (typeof MOTORBOAT_IDS)[number]];
      const f = boatFrameSize(d);
      // Phase rows: idle (row 0) vs full throttle (row 2) vs cruise (row 4), same direction (col 0).
      const idle = cellSig(a, 0, 0, f.w, f.h), full = cellSig(a, 0, 2, f.w, f.h), cruise = cellSig(a, 0, 4, f.w, f.h);
      expect(idle.sig).not.toBe(full.sig);
      expect(full.sig).not.toBe(cruise.sig);
      expect(idle.sig).not.toBe(cruise.sig);
      // Directions differ (E vs S = col 0 row 2 vs col 2 row 2).
      expect(full.sig).not.toBe(cellSig(a, 2, 2, f.w, f.h).sig);
      expect(full.outline).toBeGreaterThan(0);
      // Full throttle paints the widest prop wash, so more wake-coloured pixels than idle.
      expect(full.wake).toBeGreaterThan(idle.wake);
    }
    // No two motorboats share a silhouette: the long pontoon holds more pixels than the motorboat,
    // and the red speedboat hull paints distinctly red pixels the white motorboat never has.
    const [motorboat, pontoon, speedboat] = paintTask422Atlases();
    const cell = (a: { width: number; height: number; pixels: Uint8ClampedArray }, id: (typeof MOTORBOAT_IDS)[number]): { sig: string; opaque: number } => {
      const f = boatFrameSize(MOTORBOAT_ART[id]);
      return cellSig(a, 0, 2, f.w, f.h);
    };
    expect(cell(pontoon!, "pontoon").opaque).toBeGreaterThan(cell(motorboat!, "motorboat").opaque);
    const redHull = (a: { width: number; height: number; pixels: Uint8ClampedArray }, id: (typeof MOTORBOAT_IDS)[number]): number => {
      const f = boatFrameSize(MOTORBOAT_ART[id]);
      let n = 0;
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        const i = ((2 * f.h + y) * a.width + x) * 4;
        const r = a.pixels[i]!, g = a.pixels[i + 1]!, b = a.pixels[i + 2]!;
        if (a.pixels[i + 3]! > 16 && r > 140 && r - g > 60 && r - b > 60) n++;
      }
      return n;
    };
    expect(redHull(speedboat!, "speedboat")).toBeGreaterThan(40);
    expect(redHull(motorboat!, "motorboat")).toBe(0);
  });

  it("kit menu icons are non-blank and install idempotently from supplied URLs", () => {
    for (const key of ["item_vehicle_kit_motorboat", "item_vehicle_kit_pontoon", "item_vehicle_kit_speedboat"] as const) {
      const icon = paintMotorboatMenuIconPixels(key);
      expect(icon.width).toBe(128); expect(icon.height).toBe(128);
      let opaque = 0;
      for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i]! > 16) opaque++;
      expect(opaque).toBeGreaterThan(40);
    }
    const urls = new Map([
      ["item_vehicle_kit_motorboat", "data:image/png;base64,motorboat"],
      ["item_vehicle_kit_pontoon", "data:image/png;base64,pontoon"],
      ["item_vehicle_kit_speedboat", "data:image/png;base64,speedboat"],
    ]);
    expect(installMotorboatMenuIcons(document, urls)).toBe(true);
    expect(installMotorboatMenuIcons(document, urls)).toBe(true);
    expect(document.querySelectorAll("#task422-menu-icons").length).toBe(1);
    const style = document.getElementById("task422-menu-icons") as HTMLStyleElement;
    for (const key of ["item_vehicle_kit_motorboat", "item_vehicle_kit_pontoon", "item_vehicle_kit_speedboat"]) {
      expect(style.textContent).toContain(`[data-icon="${key}"]`);
    }
  });
});
