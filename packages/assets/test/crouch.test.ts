import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssetRegistry, loadManifest } from "../src/index.js";
import { PACK_DIR, readManifestJson } from "../src/node.js";

// Crouch art pass (docs/ART_KEYS_CROUCH.md): crouch_idle / crouch_walk on every live v1 doll layer.
const manifest = readManifestJson(PACK_DIR + "customization/manifest.customization.json");
const { registry } = loadManifest(manifest);
const lock = JSON.parse(readFileSync(PACK_DIR + "ids.lock.json", "utf8")) as { sprites: Record<string, number> };

const ANIMS: [string, number, number][] = [["crouch_idle", 2, 4], ["crouch_walk", 4, 8]];
const liveKeys = (): Set<string> => {
  const keys = new Set<string>();
  const collect = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(collect);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (k === "sprite" && typeof v === "string") keys.add(v);
      else collect(v);
    }
  };
  collect((manifest as { bodyTypes: unknown; wearables: unknown }).bodyTypes);
  collect((manifest as { bodyTypes: unknown; wearables: unknown }).wearables);
  return keys;
};

describe("v1 crouch_idle / crouch_walk", () => {
  it("covers every live doll layer, both anims, all 8 facings, on cz_crouch_* pages", () => {
    const keys = liveKeys();
    expect(keys.size).toBeGreaterThanOrEqual(430);
    for (const key of keys) {
      const sp = registry.sprite(registry.id(key));
      expect(sp, key).toBeTruthy();
      for (const [an, n, fps] of ANIMS) {
        const a = sp.animations.get(an)!;
        expect(a, `${key}.${an}`).toBeDefined();
        expect(a.frames).toHaveLength(n);
        expect(a.fps).toBe(fps);
        expect(a.loop).toBe(true);
        expect(a.directions).toBe(8);
        expect(a.dirStride).toBe(n);
        expect(a.dirFrames).toHaveLength(n * 8);
        for (const df of a.dirFrames!) {
          expect(df.atlas.key, `${key}.${an}`).toMatch(/^cz_crouch_/);
          expect(df.rect, `${key}.${an}`).toBeTruthy();
          const r = df.rect!;
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps every non-blank body crouch cell unique; wear may share identical trimmed crops", () => {
    // Body poses all differ (bob / stride). Symmetric wear (a beanie, a small eye) may reuse a cropped cell
    // when two facings or frames really paint the same pixels; that is a pack-size win, not standing-frame reuse.
    for (const key of ["body_male", "body_female"] as const) {
      const sp = registry.sprite(registry.id(key));
      const seen = new Map<string, string>();
      for (const [an] of ANIMS) {
        const a = sp.animations.get(an)!;
        a.dirFrames!.forEach((df, i) => {
          const r = df.rect!;
          if (r.w <= 1 && r.h <= 1) return;
          const id = `${df.atlas.key}/${r.x},${r.y},${r.w},${r.h}`;
          expect(seen.get(id), `${key}.${an}[${i}] shares ${seen.get(id)}`).toBeUndefined();
          seen.set(id, `${an}[${i}]`);
        });
      }
    }
  });

  it("does not reuse standing idle/walk cells: crouch dirFrames live only on cz_crouch_* atlases", () => {
    const keys = liveKeys();
    for (const key of keys) {
      const sp = registry.sprite(registry.id(key));
      for (const stand of ["idle", "walk"] as const) {
        const a = sp.animations.get(stand);
        if (!a?.dirFrames) continue;
        for (const df of a.dirFrames) expect(df.atlas.key).not.toMatch(/^cz_crouch_/);
      }
      for (const [an] of ANIMS) {
        for (const df of sp.animations.get(an)!.dirFrames!) expect(df.atlas.key).toMatch(/^cz_crouch_/);
      }
    }
  });

  it("writes head and hand anchors on both bodies; head offset is the 3 px neck lift", () => {
    for (const bt of ["body_male", "body_female"] as const) {
      const id = registry.id(bt);
      expect(lock.sprites[bt], bt).toBeTypeOf("number");
      for (const [an, n] of ANIMS) {
        const sp = registry.sprite(id);
        const a = sp.animations.get(an)!;
        expect(a.frameMeta, `${bt}.${an} frameMeta`).toBeDefined();
        for (let fi = 0; fi < n; fi++) for (let d = 0; d < 8; d++) {
          const di = fi * 8 + d;
          const anchors = registry.dirFrameAnchors(id, an, di);
          expect(anchors?.head, `${bt}.${an} ${fi}/${d} head`).toEqual({ x: 0, y: -29.65 });
          expect(anchors?.handR, `${bt}.${an} ${fi}/${d} handR`).toBeDefined();
          expect(anchors?.handL, `${bt}.${an} ${fi}/${d} handL`).toBeDefined();
          const ref = registry.dirFrame(id, an, (d / 8) * Math.PI * 2, (fi + 0.01) / a.fps);
          const o = AssetRegistry.headOffset(ref);
          expect([o.x, o.y], `${bt}.${an} ${fi}/${d}`).toEqual([0, -3]);
        }
      }
    }
  });

  it("packs cz_crouch_* pages at <=1024 px with KTX2 at 1x and @2x and a 1x tintmask", () => {
    const atlases = (manifest as { atlases: { key: string; image: string; frameW: number; frameH: number; ktx2?: string; masks?: { tintmask?: string }; pages?: { scale: number; image: string; ktx2?: string }[] }[] }).atlases;
    const crouch = atlases.filter((a) => a.key.startsWith("cz_crouch_"));
    expect(crouch.length).toBeGreaterThan(0);
    const root = PACK_DIR + "customization/";
    for (const a of crouch) {
      expect(Math.max(a.frameW, a.frameH), a.key).toBeLessThanOrEqual(1024);
      expect(a.ktx2, a.key).toBeTruthy();
      expect(a.masks?.tintmask, a.key).toBeTruthy();
      const p2 = a.pages?.find((p) => p.scale === 2);
      expect(p2?.ktx2, a.key).toBeTruthy();
      for (const rel of [a.image, a.ktx2!, a.masks!.tintmask!, p2!.image, p2!.ktx2!]) {
        const p = root + rel;
        expect(existsSync(p), p).toBe(true);
        expect(statSync(p).size, p).toBeGreaterThan(32);
      }
    }
  });
});
