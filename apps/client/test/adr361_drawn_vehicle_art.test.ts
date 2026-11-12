// ADR-361: dedicated drawn-vehicle + harness art — painted at runtime (apps/client/src/task361-art.ts),
// declared in the pack/task361 fragment, world sprites keyed by def id, the harness overlay on harnessed
// mounts, and menu/kit icons painted from the world art. Verified numerically like Task 34 / ADR-356 /
// ADR-357 (pixel checks, not eyeballs): distinct non-empty cells in all 8 directions, covered wagons show
// canvas where open wagons show cargo, sizes order with the footprints, the merged registry resolves every
// def to its dedicated art, the harness appears exactly when MountHarness is present, and every kit icon
// is a non-blank pixel picture whose override rule the panels actually route through.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { loadMergedPackManifest } from "@engine/assets/node";
import { modelZScale, resolveVehicleArt, type VehicleRenderDef } from "@engine/render";
import { Px } from "../src/task34-art.js";
import { harnessOverlayKey } from "../src/mount-render.js";
import {
  DRAWN_VEHICLE_ART,
  DRAWN_VEHICLE_IDS,
  HARNESS_CELL,
  TASK361_ATLAS_KEYS,
  TASK361_HARNESS_ARTS,
  VEHICLE_MENU_ICON_KEYS,
  drawnVehicleAtlasCols,
  drawnVehicleAtlasRows,
  drawnVehicleFrame,
  kitDefOfIcon,
  paintDrawnVehicleCell,
  paintTask361Atlases,
  paintVehicleMenuIconPixels,
  vehicleMenuIconsCss,
} from "../src/task361-art.js";

const OUTLINE: [number, number, number] = [40, 30, 50];
const CANVAS: [number, number, number] = [232, 222, 196];
const GLASS: [number, number, number] = [58, 84, 104];
const TYRE: [number, number, number] = [38, 36, 40];
const LEATHER: [number, number, number] = [150, 102, 62];
const ROPE: [number, number, number] = [196, 164, 104];

const VEHICLES_JSON = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/gameplay/data/vehicles.json"), "utf8")) as {
  vehicles: VehicleRenderDef[];
};
const RENDER_DEF = (id: string): VehicleRenderDef => VEHICLES_JSON.vehicles.find((d) => d.id === id)!;
const FRAGMENT = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task361/manifest.task361.json"), "utf8")) as {
  atlases: { key: string; image: string; ktx2: string; frameW: number; frameH: number; columns: number; rows: number }[];
  sprites: { key: string; atlas: string; anchor?: { x: number; y: number }; animations?: Record<string, { frames: number[]; directions?: number; dirStride?: number }> }[];
};

/** Signature of a pixel block: opaque count + mean RGB + dark-plum outline count. */
function sig(pixels: Uint8ClampedArray): { opaque: number; outline: number; sig: string } {
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! > 16) {
      opaque++; r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!;
      if (pixels[i] === OUTLINE[0] && pixels[i + 1] === OUTLINE[1] && pixels[i + 2] === OUTLINE[2]) outline++;
    }
  }
  return { opaque, outline, sig: `${opaque}:${Math.round(r / Math.max(1, opaque))}:${Math.round(g / Math.max(1, opaque))}:${Math.round(b / Math.max(1, opaque))}` };
}
/** One direction cell of a painted atlas. */
function cell(atlas: { width: number; pixels: Uint8ClampedArray }, col: number, row: number, cw: number, ch: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = ((row * ch + y) * atlas.width + (col * cw + x)) * 4, di = (y * cw + x) * 4;
    out[di] = atlas.pixels[si]!; out[di + 1] = atlas.pixels[si + 1]!; out[di + 2] = atlas.pixels[si + 2]!; out[di + 3] = atlas.pixels[si + 3]!;
  }
  return out;
}
function countColor(pixels: Uint8ClampedArray, c: readonly [number, number, number]): number {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === c[0] && pixels[i + 1] === c[1] && pixels[i + 2] === c[2] && pixels[i + 3]! > 16) n++;
  return n;
}
/** Opaque bounding box of a pixel block. */
function bbox(pixels: Uint8ClampedArray, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (pixels[(y * w + x) * 4 + 3]! > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, y0, x1, y1 };
}

describe("ADR-361 task361 world art", () => {
  it("paints nine vehicle atlases + seven harness atlases, every direction cell non-blank and outlined, distinct per def", () => {
    expect(TASK361_ATLAS_KEYS).toEqual([
      "veh_art_wagon_small", "veh_art_wagon_small_covered", "veh_art_wagon_medium", "veh_art_wagon_medium_covered",
      "veh_art_wagon_large", "veh_art_wagon_large_covered", "veh_art_cart", "veh_art_carriage", "veh_art_chariot",
      "veh_art_harness_horse", "veh_art_harness_donkey", "veh_art_harness_deer", "veh_art_harness_elk",
      "veh_art_harness_moose", "veh_art_harness_bison", "veh_art_harness_yak",
    ]);
    const atlases = paintTask361Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK361_ATLAS_KEYS]);
    const whole = new Set<string>();
    for (const id of DRAWN_VEHICLE_IDS) {
      const d = DRAWN_VEHICLE_ART[id], f = drawnVehicleFrame(d);
      const a = atlases.find((x) => x.key === `veh_art_${id}`)!;
      expect(a.width).toBe(f.w * drawnVehicleAtlasCols(d));
      expect(a.height).toBe(f.h * drawnVehicleAtlasRows(d));
      expect(a.width).toBeLessThanOrEqual(2048); expect(a.height).toBeLessThanOrEqual(2048); // mobile texture cap
      for (let dir = 0; dir < 8; dir++) {
        const s = sig(cell(a, dir % drawnVehicleAtlasCols(d), Math.floor(dir / drawnVehicleAtlasCols(d)), f.w, f.h));
        expect(s.opaque, `${id} dir ${dir}`).toBeGreaterThan(40); // a real picture, not a blank tile
        expect(s.outline, `${id} dir ${dir}`).toBeGreaterThan(0); // the 1px dark-plum outline survives
      }
      const w = sig(a.pixels);
      expect(whole.has(w.sig)).toBe(false); whole.add(w.sig); // no two vehicles share pixels
    }
    expect(whole.size).toBe(9);
    for (const art of TASK361_HARNESS_ARTS) {
      const a = atlases.find((x) => x.key === `veh_art_harness_${art}`)!;
      expect(a.width).toBe(1024); expect(a.height).toBe(HARNESS_CELL);
      for (let dir = 0; dir < 8; dir++) {
        const c = cell(a, dir, 0, HARNESS_CELL, HARNESS_CELL), s = sig(c);
        expect(s.opaque, `harness ${art} dir ${dir}`).toBeGreaterThan(40);
        expect(s.outline, `harness ${art} dir ${dir}`).toBeGreaterThan(0);
        expect(countColor(c, LEATHER), `harness ${art} dir ${dir} straps`).toBeGreaterThan(0);
        expect(countColor(c, ROPE), `harness ${art} dir ${dir} traces`).toBeGreaterThan(0);
      }
    }
  });

  it("covered wagons show the canvas cover; open wagons show cargo instead", () => {
    const atlases = paintTask361Atlases();
    for (const [open, covered] of [["wagon_small", "wagon_small_covered"], ["wagon_medium", "wagon_medium_covered"], ["wagon_large", "wagon_large_covered"]] as const) {
      const o = atlases.find((x) => x.key === `veh_art_${open}`)!, c = atlases.find((x) => x.key === `veh_art_${covered}`)!;
      expect(sig(o.pixels).sig).not.toBe(sig(c.pixels).sig);
      for (let dir = 0; dir < 8; dir++) {
        const oc = cell(o, dir % drawnVehicleAtlasCols(DRAWN_VEHICLE_ART[open]), Math.floor(dir / drawnVehicleAtlasCols(DRAWN_VEHICLE_ART[open])), drawnVehicleFrame(DRAWN_VEHICLE_ART[open]).w, drawnVehicleFrame(DRAWN_VEHICLE_ART[open]).h);
        const cc = cell(c, dir % drawnVehicleAtlasCols(DRAWN_VEHICLE_ART[covered]), Math.floor(dir / drawnVehicleAtlasCols(DRAWN_VEHICLE_ART[covered])), drawnVehicleFrame(DRAWN_VEHICLE_ART[covered]).w, drawnVehicleFrame(DRAWN_VEHICLE_ART[covered]).h);
        expect(countColor(cc, CANVAS), `${covered} dir ${dir} canvas`).toBeGreaterThan(100);
        expect(countColor(oc, CANVAS), `${open} dir ${dir} canvas`).toBe(0);
      }
    }
  });

  it("sizes order with the footprints: wagon_small < wagon_medium < wagon_large, chariot smallest", () => {
    expect(drawnVehicleFrame(DRAWN_VEHICLE_ART.wagon_small).w).toBeLessThan(drawnVehicleFrame(DRAWN_VEHICLE_ART.wagon_medium).w);
    expect(drawnVehicleFrame(DRAWN_VEHICLE_ART.wagon_medium).w).toBeLessThan(drawnVehicleFrame(DRAWN_VEHICLE_ART.wagon_large).w);
    expect(drawnVehicleFrame(DRAWN_VEHICLE_ART.chariot).w).toBeLessThan(drawnVehicleFrame(DRAWN_VEHICLE_ART.cart).w);
    expect(drawnVehicleFrame(DRAWN_VEHICLE_ART.cart).w).toBeLessThan(drawnVehicleFrame(DRAWN_VEHICLE_ART.wagon_small).w);
    // The painted opaque width orders the same way (not just the frame box).
    const atlases = paintTask361Atlases();
    const wOf = (id: (typeof DRAWN_VEHICLE_IDS)[number]): number => {
      const d = DRAWN_VEHICLE_ART[id], f = drawnVehicleFrame(d);
      const a = atlases.find((x) => x.key === `veh_art_${id}`)!;
      const b = bbox(cell(a, 1 % drawnVehicleAtlasCols(d), Math.floor(1 / drawnVehicleAtlasCols(d)), f.w, f.h), f.w, f.h);
      return b.x1 - b.x0;
    };
    expect(wOf("wagon_small")).toBeLessThan(wOf("wagon_medium"));
    expect(wOf("wagon_medium")).toBeLessThan(wOf("wagon_large"));
    expect(wOf("chariot")).toBeLessThan(wOf("cart"));
  });

  it("the carriage has glass windows and the chariot has big spoked wheels", () => {
    const atlases = paintTask361Atlases();
    const se = (id: (typeof DRAWN_VEHICLE_IDS)[number]): Uint8ClampedArray => {
      const d = DRAWN_VEHICLE_ART[id], f = drawnVehicleFrame(d);
      const a = atlases.find((x) => x.key === `veh_art_${id}`)!;
      return cell(a, 1 % drawnVehicleAtlasCols(d), Math.floor(1 / drawnVehicleAtlasCols(d)), f.w, f.h);
    };
    expect(countColor(se("carriage"), GLASS)).toBeGreaterThan(0); // cab windows
    expect(countColor(se("wagon_small"), GLASS)).toBe(0); // open wagons have no glass
    expect(countColor(se("chariot"), TYRE)).toBeGreaterThan(countColor(se("cart"), TYRE)); // one axle each, chariot wheels bigger (r 0.8 vs 0.62)
  });

  it("the merged registry resolves every drawn def to its dedicated art, native scale, 8 directions", async () => {
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => (TASK361_ATLAS_KEYS as readonly string[]).includes(c.key))).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const id of DRAWN_VEHICLE_IDS) {
      expect(result.registry.atlases.has(`veh_art_${id}`), id).toBe(true);
      const s = result.registry.byKey(id);
      expect(s.key, id).toBe(id);
      expect(s.atlas.key, id).toBe(`veh_art_${id}`);
      expect(s.anchor.y, id).toBeCloseTo(drawnVehicleFrame(DRAWN_VEHICLE_ART[id]).py / drawnVehicleFrame(DRAWN_VEHICLE_ART[id]).h, 3);
      expect(s.animList[0]!.directions, id).toBe(8);
      expect(s.animList[0]!.frames, id).toEqual([0]); // one frame per direction: the renderer never animates vehicle wheels
      const b = resolveVehicleArt(result.registry, RENDER_DEF(id));
      expect(b, id).not.toBeNull();
      expect(b!.key, id).toBe(id);
      expect(b!.atlas, id).toBe(`veh_art_${id}`);
      expect(b!.scale, id).toBe(1); // native: drawn at true target size
      expect(b!.facingOffset, id).toBe(Math.PI / 4);
    }
    for (const art of TASK361_HARNESS_ARTS) {
      const s = result.registry.byKey(`mount_harness_${art}`);
      expect(s.atlas.key, art).toBe(`veh_art_harness_${art}`);
      expect(s.anchor.y, art).toBe(0.9);
      expect([...s.animations.keys()].sort(), art).toEqual(["gallop", "idle", "walk"]);
      expect(s.animations.get("idle")!.directions, art).toBe(8);
      expect(s.animations.get("walk")!.frames, art).toEqual([0, 0, 0, 0, 0, 0]); // one cell per direction, shared by every gait frame
    }
  });

  it("the fragment layout matches the painter and names real files; no key collides with other fragments", () => {
    const fragDir = resolve(__dirname, "../../../packages/assets/pack/task361");
    for (const a of FRAGMENT.atlases) {
      if (a.key.startsWith("veh_art_harness_")) {
        expect(a.frameW).toBe(HARNESS_CELL); expect(a.frameH).toBe(HARNESS_CELL); expect(a.columns).toBe(8); expect(a.rows).toBe(1);
      } else {
        const d = DRAWN_VEHICLE_ART[a.key.slice("veh_art_".length) as (typeof DRAWN_VEHICLE_IDS)[number]];
        const f = drawnVehicleFrame(d);
        expect(a.frameW).toBe(f.w); expect(a.frameH).toBe(f.h);
        expect(a.columns).toBe(drawnVehicleAtlasCols(d)); expect(a.rows).toBe(drawnVehicleAtlasRows(d));
      }
      // The image/ktx2 are never fetched at runtime (blob URLs override them), but the pack test requires
      // every manifest atlas to name a PNG + KTX2 twin that exist on disk.
      expect(existsSync(join(fragDir, a.image)), a.key).toBe(true);
      expect(existsSync(join(fragDir, a.ktx2)), a.key).toBe(true);
    }
    expect(FRAGMENT.sprites.map((s) => s.key).sort()).toEqual([...DRAWN_VEHICLE_IDS, ...TASK361_HARNESS_ARTS.map((a) => `mount_harness_${a}`)].sort());
    const other = ["pack/vehicles/manifest.vehicles.json", "pack/nature/manifest.nature.json", "pack/items/manifest.items.json", "pack/task34/manifest.task34.json", "pack/task355/manifest.task355.json"];
    for (const rel of other) {
      const m = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets", rel), "utf8")) as { atlases: { key: string }[]; sprites: { key: string }[] };
      for (const k of [...FRAGMENT.atlases.map((a) => a.key), ...FRAGMENT.sprites.map((s) => s.key)]) {
        expect(m.atlases.some((a) => a.key === k), `${rel} atlas ${k}`).toBe(false);
        expect(m.sprites.some((s) => s.key === k), `${rel} sprite ${k}`).toBe(false);
      }
    }
  });

  it("the geometry table matches vehicles.json and the bench height matches the renderer's seat scale", () => {
    for (const id of DRAWN_VEHICLE_IDS) {
      const d = DRAWN_VEHICLE_ART[id], r = RENDER_DEF(id);
      expect(d.length).toBe(r.footprint.length);
      expect(d.width).toBe(r.footprint.width);
      expect(d.seatX).toBe(r.seatAnchors![0]!.x);
      expect(d.hitchX).toBe(r.hitches.find((h) => h.at === "front")!.offset);
      expect(d.covered).toBe((r as { covered?: boolean }).covered ?? false);
      // The bench top the driver sits on: seatZ stretched by the renderer's modelZScale, in px (16 px/tile).
      expect(d.seatZPx).toBe(Math.round(modelZScale(r) * r.seatAnchors![0]!.z * 16));
    }
  });
});

describe("ADR-361 harness overlay", () => {
  it("harnessOverlayKey is mount_harness_<art> per species, empty off-sheet", () => {
    expect(["horse", "donkey", "deer", "elk", "moose", "bison", "yak"].map((_, i) => harnessOverlayKey(i + 1))).toEqual(
      ["mount_harness_horse", "mount_harness_donkey", "mount_harness_deer", "mount_harness_elk", "mount_harness_moose", "mount_harness_bison", "mount_harness_yak"],
    );
    expect(harnessOverlayKey(0)).toBe("");
    expect(harnessOverlayKey(8)).toBe("");
  });

  it("isHarnessed tracks MountHarness exactly: on when present, off when removed", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 });
    G.installGameplay(w, {});
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
    const m = G.makeMount(w, "animal_horse", 1, 0, p);
    const hid = G.gameplayDefs(w).itemId("harness");
    expect(G.isHarnessed(w, m)).toBe(false);
    expect(harnessOverlayKey(G.mountSpeciesOfKey("horse"))).toBe("mount_harness_horse");
    w.add(m, G.MountHarness, { item: hid });
    expect(G.isHarnessed(w, m)).toBe(true);
    w.remove(m, G.MountHarness);
    expect(G.isHarnessed(w, m)).toBe(false);
  });
});

describe("ADR-361 runtime-painted vehicle menu icons", () => {
  it("each icon is a non-blank, outlined, distinct 128px picture", () => {
    expect(VEHICLE_MENU_ICON_KEYS).toEqual([
      "item_vehicle_kit_wagon_small", "item_vehicle_kit_wagon_small_covered", "item_vehicle_kit_wagon_medium",
      "item_vehicle_kit_wagon_medium_covered", "item_vehicle_kit_wagon_large", "item_vehicle_kit_wagon_large_covered",
      "item_vehicle_kit_cart", "item_vehicle_kit_carriage", "item_vehicle_kit_chariot",
      "item_wooden_wheel", "item_canvas_cover", "item_wagon_frame", "harness",
    ]);
    const seen = new Set<string>();
    for (const key of VEHICLE_MENU_ICON_KEYS) {
      const icon = paintVehicleMenuIconPixels(key);
      expect(icon.width).toBe(128); expect(icon.height).toBe(128);
      const s = sig(icon.pixels);
      expect(s.opaque, key).toBeGreaterThan(40); // a real picture, not a blank tile
      expect(s.outline, key).toBeGreaterThan(0); // the 1px dark-plum outline survives
      expect(seen.has(s.sig)).toBe(false); seen.add(s.sig);
    }
    expect(seen.size).toBe(13);
  });

  it("each kit icon IS its def's world cell, painted at icon scale (SE view)", () => {
    for (const key of VEHICLE_MENU_ICON_KEYS) {
      const def = kitDefOfIcon(key);
      if (!def) continue;
      const d = DRAWN_VEHICLE_ART[def], f = drawnVehicleFrame(d);
      const s = Math.min(1, 118 / f.w, 104 / f.h);
      const px = new Px(128, 128);
      paintDrawnVehicleCell(px, 64 - f.px * s, 100 - f.py * s, d, 1, s);
      expect(paintVehicleMenuIconPixels(key).pixels).toEqual(px.data);
    }
    // The three parts + harness are dedicated small drawings, not vehicle cells.
    expect(countColor(paintVehicleMenuIconPixels("item_wooden_wheel").pixels, TYRE)).toBeGreaterThan(0);
    expect(countColor(paintVehicleMenuIconPixels("item_canvas_cover").pixels, CANVAS)).toBeGreaterThan(0);
    expect(countColor(paintVehicleMenuIconPixels("item_wagon_frame").pixels, TYRE)).toBeGreaterThan(0);
    expect(countColor(paintVehicleMenuIconPixels("harness").pixels, LEATHER)).toBeGreaterThan(0);
    expect(countColor(paintVehicleMenuIconPixels("harness").pixels, ROPE)).toBeGreaterThan(0);
  });

  it("the override stylesheet carries one centred, contained rule per icon", () => {
    const fakeUrls = new Map(VEHICLE_MENU_ICON_KEYS.map((s) => [s, `data:image/png;base64,${s}`]));
    const css = vehicleMenuIconsCss(fakeUrls);
    for (const key of VEHICLE_MENU_ICON_KEYS) {
      expect(css).toContain(`[data-icon="${key}"]{--cz-icon:url("data:image/png;base64,${key}");--cz-ipos:center;--cz-isize:contain}`);
    }
    expect(vehicleMenuIconsCss(new Map())).toBe("");
  });
});
// The install + panelIcon routing checks live in adr361_vehicle_menu_icons.test.ts (jsdom): this file runs
// in the node environment because @engine/assets/node needs file: URLs (see task355_art.test.ts).
