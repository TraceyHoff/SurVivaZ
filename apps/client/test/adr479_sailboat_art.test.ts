// @vitest-environment jsdom
// ADR-479: dedicated sailboat art — painted at runtime (apps/client/src/task421-art.ts),
// declared in the pack/task479 fragment. Verified numerically like ADR-421/422 (pixel checks, not
// eyeballs): one non-empty atlas, sail phases and directions differ, the dark-plum outline is
// present, the sail cloth is present, and the kit menu icon is non-blank. The merged registry half
// (resolveVehicleArt binding by def id) lives in adr421_boats_registry.test.ts (node environment —
// the node-only manifest loader cannot run under jsdom). The user is the final visual check
// (no GL in the VM).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  boatFrame, boatFrameSize, installSailboatMenuIcons, paintSailboatMenuIconPixels,
  paintTask479Atlases, paintTask421Atlases, BOAT_ATLAS_COLS, BOAT_ATLAS_ROWS, BOAT_PHASES,
  TASK479_ATLAS_KEYS, SAILBOAT_ART, SAILBOAT_ID, BOAT_ART,
} from "../src/task421-art.js";
import rawVehicles from "../../../packages/gameplay/data/vehicles.json";

/** "opaque:meanR:meanG:meanB" signature of one frame cell, plus its outline- and sail-pixel counts. */
function cellSig(atlas: { width: number; height: number; pixels: Uint8ClampedArray }, col: number, row: number, fw: number, fh: number): { sig: string; opaque: number; outline: number; sail: number } {
  const ox = col * fw, oy = row * fh;
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0, sail = 0;
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const i = ((oy + y) * atlas.width + (ox + x)) * 4;
    const a = atlas.pixels[i + 3]!;
    if (a > 16) {
      opaque++; r += atlas.pixels[i]!; g += atlas.pixels[i + 1]!; b += atlas.pixels[i + 2]!;
      if (atlas.pixels[i] === 40 && atlas.pixels[i + 1] === 30 && atlas.pixels[i + 2] === 50) outline++;
      if ((atlas.pixels[i] === 238 && atlas.pixels[i + 1] === 228 && atlas.pixels[i + 2] === 200) ||
        (atlas.pixels[i] === 214 && atlas.pixels[i + 1] === 200 && atlas.pixels[i + 2] === 168)) sail++;
    }
  }
  expect(opaque).toBeGreaterThan(40);
  return { sig: `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`, opaque, outline, sail };
}

describe("ADR-479 task479 art", () => {
  it("paints one atlas (4 cols x 6 rows) with the masthead-sized frame; geometry matches vehicles.json", () => {
    expect(TASK479_ATLAS_KEYS).toEqual(["veh_art_sailboat"]);
    expect(SAILBOAT_ID).toBe("sailboat");
    expect(BOAT_PHASES).toBe(3); expect(BOAT_ATLAS_COLS).toBe(4); expect(BOAT_ATLAS_ROWS).toBe(6);
    expect(boatFrame(0, 0)).toBe(0); expect(boatFrame(1, 0)).toBe(8); expect(boatFrame(2, 7)).toBe(23);
    const defs = (rawVehicles as { vehicles: { id: string; footprint: { length: number; width: number } }[] }).vehicles;
    const json = defs.find((v) => v.id === "sailboat")!;
    expect(SAILBOAT_ART.length).toBe(json.footprint.length);
    expect(SAILBOAT_ART.width).toBe(json.footprint.width);
    expect(SAILBOAT_ART.sail).toBeDefined(); // the masthead, not the paddle, sets the frame top
    const atlases = paintTask479Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK479_ATLAS_KEYS]);
    const a = atlases[0]!;
    const f = boatFrameSize(SAILBOAT_ART);
    expect(f.w).toBe(300); expect(f.h).toBe(228); // masthead frame (rowboat is 290x175)
    expect(a.width).toBe(f.w * BOAT_ATLAS_COLS); expect(a.height).toBe(f.h * BOAT_ATLAS_ROWS);
    expect(a.width).toBeLessThanOrEqual(2048); expect(a.height).toBeLessThanOrEqual(2048); // mobile texture cap
    let opaque = 0;
    for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) opaque++;
    expect(opaque).toBeGreaterThan(10000); // hull + mast + two sails in every cell
  });

  it("all 8 direction cells differ (the rig is fore-aft asymmetric), with the 1px dark outline and sail cloth broadside", () => {
    const a = paintTask479Atlases()[0]!;
    const f = boatFrameSize(SAILBOAT_ART);
    const sigs = new Set<string>();
    for (let dir = 0; dir < 8; dir++) {
      const col = dir % BOAT_ATLAS_COLS, row = 2 + Math.floor(dir / BOAT_ATLAS_COLS); // idle phase, full sail
      const s = cellSig(a, col, row, f.w, f.h);
      expect(s.outline).toBeGreaterThan(0);
      // The sail is a triangle in the u-z plane: broadside from the beam (dirs 0 and 4) it holds
      // hundreds of cloth pixels; edge-on from bow/stern (dirs 2 and 6) it collapses to a sliver,
      // like a real sail — so the cloth count is only asserted broadside.
      if (dir === 0 || dir === 4) expect(s.sail).toBeGreaterThan(100);
      sigs.add(s.sig);
    }
    expect(sigs.size).toBe(8);
  });

  it("sail phases differ (slack vs full vs billowing)", () => {
    const a = paintTask479Atlases()[0]!;
    const f = boatFrameSize(SAILBOAT_ART);
    // Phase rows: slack (row 0) vs full (row 2) vs billowing (row 4), same direction (col 0).
    const slack = cellSig(a, 0, 0, f.w, f.h), full = cellSig(a, 0, 2, f.w, f.h), billow = cellSig(a, 0, 4, f.w, f.h);
    expect(slack.sig).not.toBe(full.sig);
    expect(full.sig).not.toBe(billow.sig);
    expect(slack.sig).not.toBe(billow.sig);
    // The full sail holds the most cloth (slack lowers the head, billow bellies leeward).
    expect(full.sail).toBeGreaterThan(slack.sail);
  });

  it("the sailboat is a distinct silhouette from the rowboat (same cell, different signature)", () => {
    const sail = paintTask479Atlases()[0]!;
    const row = paintTask421Atlases().find((x) => x.key === "veh_art_rowboat")!;
    const fs = boatFrameSize(SAILBOAT_ART), fr = boatFrameSize(BOAT_ART.rowboat);
    expect(cellSig(sail, 0, 2, fs.w, fs.h).sig).not.toBe(cellSig(row, 0, 2, fr.w, fr.h).sig);
    // The sailboat's full-sail cell holds sail cloth the rowboat never has (and the rowboat's
    // paddles + cargo give it more opaque pixels overall — the rig reads by shape, not by bulk).
    expect(cellSig(sail, 0, 2, fs.w, fs.h).sail).toBeGreaterThan(100);
    expect(cellSig(row, 0, 2, fr.w, fr.h).sail).toBe(0);
  });

  it("the fragment declares the sailboat atlas + sprite (layout only, dirStride 1, sail animation)", () => {
    const frag = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task479/manifest.task479.json"), "utf8"));
    expect(frag.atlases).toHaveLength(1);
    expect(frag.atlases[0].key).toBe("veh_art_sailboat");
    expect(frag.atlases[0].columns).toBe(4); expect(frag.atlases[0].rows).toBe(6);
    expect(frag.atlases[0].frameW).toBe(300); expect(frag.atlases[0].frameH).toBe(228);
    expect(frag.sprites).toHaveLength(1);
    expect(frag.sprites[0].key).toBe("sailboat");
    expect(frag.sprites[0].animations.idle.frames).toEqual([8]);
    expect(frag.sprites[0].animations.idle.directions).toBe(8);
    expect(frag.sprites[0].animations.idle.dirStride).toBe(1);
    expect(frag.sprites[0].animations.sail.frames).toEqual([0, 8, 16]);
    expect(frag.sprites[0].animations.sail.directions).toBe(8);
  });

  it("the kit menu icon is non-blank and installs idempotently from supplied URLs", () => {
    const icon = paintSailboatMenuIconPixels("item_vehicle_kit_sailboat");
    expect(icon.width).toBe(128); expect(icon.height).toBe(128);
    let opaque = 0;
    for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i]! > 16) opaque++;
    expect(opaque).toBeGreaterThan(40);
    const urls = new Map([["item_vehicle_kit_sailboat", "data:image/png;base64,sailboat"]]);
    expect(installSailboatMenuIcons(document, urls)).toBe(true);
    expect(installSailboatMenuIcons(document, urls)).toBe(true);
    expect(document.querySelectorAll("#task479-menu-icons").length).toBe(1);
    const style = document.getElementById("task479-menu-icons") as HTMLStyleElement;
    expect(style.textContent).toContain(`[data-icon="item_vehicle_kit_sailboat"]`);
  });
});
