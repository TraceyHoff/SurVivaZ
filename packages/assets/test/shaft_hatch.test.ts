import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "building/manifest.building.json", "utf8"));
const items = JSON.parse(readFileSync(root + "items/manifest.items.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");

describe("dedicated Shaft Hatch art", () => {
  it("ships bare + four tier keys with unique directional closed trapdoors and baked damage", () => {
    for (const t of [1, 2, 3, 4]) {
      const s = man.sprites.find((s: { key: string }) => s.key === `bld_shaft_hatch_t${t}`);
      expect(s.building).toEqual({ piece: `shaft_hatch@tier${t}`, footprint: { w: 1, h: 1 }, layer: 0,
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
    const t1 = man.sprites.find((s: { key: string }) => s.key === "bld_shaft_hatch_t1");
    expect(bare.building.piece).toBe("shaft_hatch");
    expect(bare.building.frames).toEqual(t1.building.frames);
    expect(bare.atlas).toBe(t1.atlas);
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
