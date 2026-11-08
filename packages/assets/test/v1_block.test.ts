import { describe, it, expect } from "vitest";
import { loadManifest } from "../src/index.js";
import { PACK_DIR, readManifestJson } from "../src/node.js";

const manifest = readManifestJson(PACK_DIR + "customization/manifest.customization.json");

describe("dedicated v1 block art", () => {
  it("covers every live body, wear layer, and hat-hair variant with raise/hold and recoil dirFrames", () => {
    const { registry } = loadManifest(manifest);
    const keys = new Set<string>();
    const collect = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(collect);
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
        if (k === "sprite" && typeof v === "string") keys.add(v);
        else collect(v);
      }
    };
    collect(manifest.bodyTypes); collect(manifest.wearables);
    expect(keys.size).toBeGreaterThanOrEqual(430);
    for (const key of keys) for (const [name, n] of [["block", 3], ["block_hit", 2]] as const) {
      const sprite = registry.sprite(registry.id(key));
      const anim = sprite.animations.get(name)!;
      expect(anim, `${key}.${name}`).toBeDefined();
      expect(anim.frames).toHaveLength(n); expect(anim.fps).toBe(10);
      expect(anim.loop).toBe(false); expect(anim.directions).toBe(8);
      expect(anim.dirFrames).toHaveLength(n * 8);
      const cells = new Set(anim.dirFrames!.map((df) => `${df.atlas.key}/${df.frame}`));
      expect(cells.size).toBe(n * 8); // dedicated cells, not old action references
      for (let d = 0; d < 8; d++) for (let fi = 0; fi < n; fi++) {
        const ref = registry.dirFrame(sprite.id, name, d * Math.PI / 4, (fi + 0.01) / 10);
        expect(ref.atlas.key).toMatch(/^cz_block_/);
        expect(Math.max(ref.atlas.columns * ref.atlas.frameW, ref.atlas.rows * ref.atlas.frameH)).toBeLessThanOrEqual(1024);
      }
    }
  });
});
