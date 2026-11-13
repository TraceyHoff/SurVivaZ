import { describe, it, expect } from "vitest";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { bodyAtlasKeys, wearableOnlyAtlases } from "../src/assets/atlasManager.js";
import { isCrouchPageKey, shouldPrefetchAtlas } from "../src/assets/asset-fetch.js";

/** Crouch doll pages stream lazily (like cz_ride_*), never in the initial load or prefetch. */
const json = (p: string) => readManifestJson(PACK_DIR + p);
const reg = () => loadManifest(mergeManifests([{ name: "pack", manifest: json("manifest.json") }, { name: "customization", manifest: json("customization/manifest.customization.json") }] as never).manifest).registry;

describe("crouch pages are lazy", () => {
  const r = reg(); const crouch = [...r.atlases.keys()].filter(isCrouchPageKey);
  it("the pack ships cz_crouch_* pages and every doll layer has crouch_idle / crouch_walk on them", () => {
    expect(crouch.length).toBeGreaterThan(5);
    const body = [...r.allSprites()].filter((s) => /^body_(male|female)$/.test(s.key));
    expect(body.length).toBe(2);
    for (const s of body) for (const a of ["crouch_idle", "crouch_walk"]) {
      const an = s.animations.get(a)!; expect(an, `${s.key}.${a}`).toBeTruthy();
      for (const d of an.dirFrames ?? []) expect(isCrouchPageKey(d.atlas.key)).toBe(true);
    }
  });
  it("no crouch page is an eager body page; all of them are lazy wear-pool pages", () => {
    const eager = bodyAtlasKeys(r), lazy = wearableOnlyAtlases(r);
    for (const k of crouch) { expect(eager.has(k), k).toBe(false); expect(lazy.has(k), k).toBe(true); }
    expect(eager.has("body_male")).toBe(true); expect(lazy.has("body_male")).toBe(false);
  });
  it("prefetch-art never warms a crouch page", () => {
    for (const k of crouch) expect(shouldPrefetchAtlas(k, `atlases/${k}.png`)).toBe(false);
    expect(isCrouchPageKey("cz_crouch_body_0")).toBe(true); expect(isCrouchPageKey("cz_body_0")).toBe(false);
    expect(isCrouchPageKey("cz_ride_body_0")).toBe(false);
  });
});
