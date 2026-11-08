import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "building/manifest.building.json", "utf8"));
const items = JSON.parse(readFileSync(root + "items/manifest.items.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");

const grid = (s: number) => [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((d) => s + r * 4 + d));

describe("dedicated Shaft Hatch art", () => {
  it("ships bare + four tier keys with unique directional closed trapdoors and baked damage", () => {
    for (const t of [1, 2, 3, 4]) {
      const s = man.sprites.find((s: { key: string }) => s.key === `bld_shaft_hatch_t${t}`);
      expect({ ...s.building, states: undefined }).toEqual({ states: undefined, piece: `shaft_hatch@tier${t}`, footprint: { w: 1, h: 1 }, layer: 0,
        frames: [[352, 353, 354, 355], [356, 357, 358, 359], [360, 361, 362, 363], [364, 365, 366, 367]], crackOverlay: "bld_crack" });
      expect(s.atlas).toBe(`building_t${t}`);
      expect(s.anchor).toEqual({ x: 0.5, y: 0.75 });
      expect(s.rotationArt).toBe("unique4");
      expect(s.animations.idle.frames).toEqual([352]);
      expect(lock.sprites[s.key]).toBeTypeOf("number");
      const icon = `build_shaft_hatch_t${t}`;
      expect(items.sprites.find((s: { key: string }) => s.key === icon)?.atlas).toBe("items_build");
      expect(css).toContain(`[data-icon="${icon}"]`);
      expect(lock.sprites[icon]).toBeTypeOf("number");
    }
    const bare = man.sprites.find((s: { key: string }) => s.key === "bld_shaft_hatch");
    expect(bare.building.piece).toBe("shaft_hatch");
    expect(bare.atlas).toBe("building_tw");
    expect(bare.building.frames).toEqual(grid(48));
    expect(bare.building.states).toEqual({ closed: grid(48), open: grid(64) });
    expect(bare.animations.idle.frames).toEqual([48]);
    expect(bare.animations.open.frames).toEqual([64]);
    expect(man.sprites.some((s: { building?: { piece: string } }) => s.building?.piece === "shaft_hatch@tier0")).toBe(false);
  });

  it("adds open-lid states without moving closed frames, plus pit-floor landings and icons", () => {
    for (const t of [1, 2, 3, 4]) {
      const s = man.sprites.find((s: { key: string }) => s.key === `bld_shaft_hatch_t${t}`);
      expect(s.building.states).toEqual({ closed: grid(352), open: grid(368) });
      expect(s.animations.idle.frames).toEqual([352]);
      expect(s.animations.closed.frames).toEqual([352]);
      expect(s.animations.open.frames).toEqual([368]);
      const a = man.atlases.find((a: { key: string }) => a.key === `building_t${t}`);
      expect(a.rows * a.frameH).toBeLessThanOrEqual(2048);
    }
    for (const t of [0, 1, 2, 3, 4]) {
      const key = t ? `bld_shaft_hatch_bottom_t${t}` : "bld_shaft_hatch_bottom";
      const s = man.sprites.find((s: { key: string }) => s.key === key);
      expect(s.atlas).toBe(t ? `building_t${t}` : "building_tw");
      expect(s.building).toEqual({ piece: t ? `shaft_hatch_bottom@tier${t}` : "shaft_hatch_bottom",
        footprint: { w: 1, h: 1 }, layer: 0, frames: grid(t ? 384 : 80), crackOverlay: "bld_crack" });
      expect(s.rotationArt).toBe("unique4");
      expect(lock.sprites[key]).toBeTypeOf("number");
      const icon = `build_shaft_hatch_bottom_t${t}`;
      expect(items.sprites.find((s: { key: string }) => s.key === icon)?.atlas).toBe("items_build");
      expect(css).toContain(`[data-icon="${icon}"]`);
      expect(lock.sprites[icon]).toBeTypeOf("number");
    }
    expect(items.sprites.find((s: { key: string }) => s.key === "build_shaft_hatch_t0")?.animations.idle.frames).toEqual([291]);
    expect(css).toContain(`[data-icon="build_shaft_hatch_t0"]`);
    const tw = man.atlases.find((a: { key: string }) => a.key === "building_tw");
    expect(tw.rows).toBe(6);
    for (const k of ["wall_corner_outer", "wall_corner_inner", "wall_corner_angled"])
      expect(man.sprites.find((s: { building?: { piece: string } }) => s.building?.piece === k).atlas).toBe("building_tw");
  });

  it("preserves foundation and floor hatch shipped frame indices", () => {
    for (const t of [1, 2, 3, 4]) {
      expect(man.sprites.find((s: { key: string }) => s.key === `bld_foundation_t${t}`).building.frames)
        .toEqual([[0, 1, 2, 3], [256, 257, 258, 259], [260, 261, 262, 263], [264, 265, 266, 267]]);
      expect(man.sprites.find((s: { key: string }) => s.key === `bld_floor_hatch_frame_t${t}`).building.frames)
        .toEqual([[108, 109, 110, 111], [292, 293, 294, 295], [296, 297, 298, 299], [300, 301, 302, 303]]);
    }
  });
});
