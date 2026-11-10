import { describe, it, expect } from "vitest";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { bodyAtlasKeys, wearableOnlyAtlases } from "../src/assets/atlasManager.js";
import { isRidePageKey, shouldPrefetchAtlas } from "../src/assets/asset-fetch.js";

/** ADR-322: the ~111 MB of cz_ride_* rider pages stream lazily (only when someone rides), never in the initial load or prefetch. */
const json = (p: string) => readManifestJson(PACK_DIR + p);
const reg = () => loadManifest(mergeManifests([{ name: "pack", manifest: json("manifest.json") }, { name: "customization", manifest: json("customization/manifest.customization.json") }] as never).manifest).registry;

describe("ADR-322 rider pages are lazy", () => {
  const r = reg(); const ride = [...r.atlases.keys()].filter(isRidePageKey);
  it("the pack ships cz_ride_* pages and every doll layer (body + wear) has ride_idle / ride_walk / ride_gallop on them", () => {
    expect(ride.length).toBeGreaterThan(10);
    const body = [...r.allSprites()].filter((s) => /^body_(male|female)$/.test(s.key));
    expect(body.length).toBe(2);
    for (const s of body) for (const a of ["ride_idle", "ride_walk", "ride_gallop"]) {
      const an = s.animations.get(a)!; expect(an, `${s.key}.${a}`).toBeTruthy();
      for (const d of an.dirFrames ?? []) expect(isRidePageKey(d.atlas.key)).toBe(true);
    }
  });
  it("no ride page is an eager body page; all of them are lazy wear-pool pages", () => {
    const eager = bodyAtlasKeys(r), lazy = wearableOnlyAtlases(r);
    for (const k of ride) { expect(eager.has(k), k).toBe(false); expect(lazy.has(k), k).toBe(true); }
    expect(eager.has("body_male")).toBe(true); expect(lazy.has("body_male")).toBe(false); // the walking body stays eager
  });
  it("prefetch-art never warms a ride page", () => {
    for (const k of ride) expect(shouldPrefetchAtlas(k, `atlases/${k}.png`)).toBe(false);
    expect(isRidePageKey("cz_ride_body_0")).toBe(true); expect(isRidePageKey("cz_body_0")).toBe(false);
  });
});
