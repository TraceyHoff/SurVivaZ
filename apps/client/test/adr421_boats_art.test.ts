// @vitest-environment jsdom
// ADR-421: dedicated tier-1 boat art — painted at runtime (apps/client/src/task421-art.ts),
// declared in the pack/task421 fragment. Verified numerically like Task 34 / ADR-356 / ADR-361
// (pixel checks, not eyeballs): three distinct non-empty atlases, paddle phases and directions
// differ, the dark-plum outline is present, and the kit menu icons are non-blank. The merged
// registry half (resolveVehicleArt binding by def id, plus the ADR-420 task420 fragment) lives
// in adr421_boats_registry.test.ts (node environment — the node-only manifest loader cannot run
// under jsdom). The user is the final visual check (no GL in the VM).
import { describe, expect, it } from "vitest";
import {
  boatFrame, boatFrameSize, installBoatMenuIcons, paintBoatMenuIconPixels, paintTask421Atlases,
  BOAT_ATLAS_COLS, BOAT_ATLAS_ROWS, BOAT_IDS, BOAT_PHASES, TASK421_ATLAS_KEYS, BOAT_ART,
} from "../src/task421-art.js";
import rawVehicles from "../../../packages/gameplay/data/vehicles.json";

/** "opaque:meanR:meanG:meanB" signature of one frame cell, plus its outline- and wake-pixel counts. */
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

describe("ADR-421 task421 art", () => {
  it("paints three atlases (4 cols x 6 rows) with distinct non-empty cells; geometry matches vehicles.json", () => {
    expect(TASK421_ATLAS_KEYS).toEqual(["veh_art_raft", "veh_art_canoe", "veh_art_rowboat"]);
    expect(BOAT_IDS).toEqual(["raft", "canoe", "rowboat"]);
    expect(BOAT_PHASES).toBe(3); expect(BOAT_ATLAS_COLS).toBe(4); expect(BOAT_ATLAS_ROWS).toBe(6);
    expect(boatFrame(0, 0)).toBe(0); expect(boatFrame(1, 0)).toBe(8); expect(boatFrame(2, 7)).toBe(23);
    const defs = (rawVehicles as { vehicles: { id: string; footprint: { length: number; width: number } }[] }).vehicles;
    for (const id of BOAT_IDS) {
      const json = defs.find((v) => v.id === id)!;
      expect(BOAT_ART[id].length).toBe(json.footprint.length);
      expect(BOAT_ART[id].width).toBe(json.footprint.width);
    }
    const atlases = paintTask421Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK421_ATLAS_KEYS]);
    const whole = new Set<string>();
    for (const a of atlases) {
      const f = boatFrameSize(BOAT_ART[a.key.replace("veh_art_", "") as (typeof BOAT_IDS)[number]]);
      expect(a.width).toBe(f.w * BOAT_ATLAS_COLS); expect(a.height).toBe(f.h * BOAT_ATLAS_ROWS);
      expect(a.width).toBeLessThanOrEqual(2048); expect(a.height).toBeLessThanOrEqual(2048); // mobile texture cap
      let opaque = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) { opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!; }
      const sig = `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`;
      expect(whole.has(sig)).toBe(false); whole.add(sig);
    }
    expect(whole.size).toBe(3);
  });

  it("paddle phases and directions differ, with the 1px dark outline; mid-stroke holds the wake", () => {
    for (const a of paintTask421Atlases()) {
      const d = BOAT_ART[a.key.replace("veh_art_", "") as (typeof BOAT_IDS)[number]];
      const f = boatFrameSize(d);
      // Phase rows: raised (row 0) vs mid-stroke (row 2) vs recovery (row 4), same direction (col 0).
      const raised = cellSig(a, 0, 0, f.w, f.h), stroke = cellSig(a, 0, 2, f.w, f.h), recovery = cellSig(a, 0, 4, f.w, f.h);
      expect(raised.sig).not.toBe(stroke.sig);
      expect(stroke.sig).not.toBe(recovery.sig);
      expect(raised.sig).not.toBe(recovery.sig);
      // Directions differ (E vs S = col 0 row 2 vs col 2 row 2).
      expect(stroke.sig).not.toBe(cellSig(a, 2, 2, f.w, f.h).sig);
      expect(stroke.outline).toBeGreaterThan(0);
      // Mid-stroke paints the longest wake: blade ring + trail, so more wake-coloured pixels than raised.
      expect(stroke.wake).toBeGreaterThan(raised.wake);
    }
    // No two boats share a silhouette: in the same mid-stroke cell, the wide raft and rowboat both
    // hold more pixels than the narrow canoe. (Counts are dominated by the water shadow, so the
    // ordering only separates the narrow hull from the wide ones — the whole-atlas signatures in
    // the first test prove all three differ.)
    const [raft, canoe, rowboat] = paintTask421Atlases();
    const cell = (a: { width: number; height: number; pixels: Uint8ClampedArray }, id: (typeof BOAT_IDS)[number]): number => {
      const f = boatFrameSize(BOAT_ART[id]);
      return cellSig(a, 0, 2, f.w, f.h).opaque;
    };
    expect(cell(raft!, "raft")).toBeGreaterThan(cell(canoe!, "canoe"));
    expect(cell(rowboat!, "rowboat")).toBeGreaterThan(cell(canoe!, "canoe"));
  });

  it("kit menu icons are non-blank and install idempotently from supplied URLs", () => {
    for (const key of ["item_vehicle_kit_raft", "item_vehicle_kit_canoe", "item_vehicle_kit_rowboat"] as const) {
      const icon = paintBoatMenuIconPixels(key);
      expect(icon.width).toBe(128); expect(icon.height).toBe(128);
      let opaque = 0;
      for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i]! > 16) opaque++;
      expect(opaque).toBeGreaterThan(40);
    }
    const urls = new Map([
      ["item_vehicle_kit_raft", "data:image/png;base64,raft"],
      ["item_vehicle_kit_canoe", "data:image/png;base64,canoe"],
      ["item_vehicle_kit_rowboat", "data:image/png;base64,rowboat"],
    ]);
    expect(installBoatMenuIcons(document, urls)).toBe(true);
    expect(installBoatMenuIcons(document, urls)).toBe(true);
    expect(document.querySelectorAll("#task421-menu-icons").length).toBe(1);
    const style = document.getElementById("task421-menu-icons") as HTMLStyleElement;
    for (const key of ["item_vehicle_kit_raft", "item_vehicle_kit_canoe", "item_vehicle_kit_rowboat"]) {
      expect(style.textContent).toContain(`[data-icon="${key}"]`);
    }
  });

});
