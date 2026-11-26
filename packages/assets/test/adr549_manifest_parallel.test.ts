// ADR-549: manifest fragments load concurrently (cap 6) and merge in list order (first wins),
// with the same registry hash as a sequential merge.
import { describe, expect, it } from "vitest";
import { loadMergedManifestWith, MANIFEST_LOAD_CONCURRENCY, type ManifestFragmentRef } from "../src/manifest-index.js";
import { mergeManifests, type ManifestFragment } from "../src/merge.js";
import { loadManifest, type ManifestJson } from "../src/manifest.js";

const ART = "https://x/art/";
const ATLAS = (key: string, image: string): Record<string, unknown> =>
  ({ key, image, frameW: 16, frameH: 16, columns: 1, rows: 1 });
const FRAG = (name: string, atlases: Record<string, unknown>[] = []): Record<string, unknown> =>
  ({ version: 1, name, atlases, sprites: [] });

describe("ADR-549 parallel manifest loads", () => {
  it("fetches ≥6 fragments concurrently (cap 6), not one at a time", async () => {
    const names = ["pack", "a", "b", "c", "d", "e", "f", "g"];
    const list: ManifestFragmentRef[] = names.map((n, i) => ({ name: n, url: `pack/${n}/manifest.json`, optional: i > 0 }));
    let inFlight = 0, maxInFlight = 0;
    const get = async (u: string): Promise<unknown> => {
      if (u.endsWith("ids.lock.json")) return undefined;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return FRAG("x");
    };
    const { fragments } = await loadMergedManifestWith(list, { get, artUrl: ART });
    expect(maxInFlight).toBeGreaterThanOrEqual(6);
    expect(maxInFlight).toBeLessThanOrEqual(MANIFEST_LOAD_CONCURRENCY);
    expect(fragments).toEqual(names);
  });

  it("merges in list order (first wins) with the same registry hash as a sequential merge", async () => {
    const a = FRAG("a", [ATLAS("shared", "a.png"), ATLAS("only_a", "a2.png")]);
    const b = FRAG("b", [ATLAS("shared", "b.png"), ATLAS("only_b", "b2.png")]);
    const list: ManifestFragmentRef[] = [
      { name: "a", url: "pack/a/manifest.json", optional: true },
      { name: "b", url: "pack/b/manifest.json", optional: true },
    ];
    const byUrl = new Map([["https://x/art/pack/a/manifest.json", a], ["https://x/art/pack/b/manifest.json", b]]);
    const get = async (u: string): Promise<unknown> => byUrl.get(u);
    // Identity image resolution, so the expected merge needs no resolve step either.
    const { result, collisions } = await loadMergedManifestWith(list, { get, artUrl: ART, resolveImage: (p) => p });
    expect(collisions).toContainEqual({ section: "atlases", key: "shared", fragments: ["a", "b"] });
    expect(result.registry.atlases.get("shared")?.pages[0]?.image).toBe("a.png");
    expect(result.registry.atlases.get("only_b")?.pages[0]?.image).toBe("b2.png");
    // Same fragments merged sequentially (list order) give the identical registry hash.
    const frags: ManifestFragment[] = [{ name: "a", manifest: a as unknown as ManifestJson }, { name: "b", manifest: b as unknown as ManifestJson }];
    const expected = loadManifest(mergeManifests(frags).manifest);
    expect(result.registry.hash).toBe(expected.registry.hash);
  });

  it("first error in list order wins when several required fragments fail", async () => {
    const list: ManifestFragmentRef[] = [
      { name: "a", url: "pack/a/manifest.json" },
      { name: "b", url: "pack/b/manifest.json" },
    ];
    const get = async (u: string): Promise<unknown> => {
      await new Promise((r) => setTimeout(r, u.includes("/a/") ? 20 : 0));
      throw new Error(`boom: ${u}`);
    };
    await expect(loadMergedManifestWith(list, { get, artUrl: ART }))
      .rejects.toThrow("boom: https://x/art/pack/a/manifest.json");
  });

  it("a v2 shard index still expands under the parallel loop", async () => {
    const index = { version: 2, name: "customization", shards: [{ category: "top", file: "manifest.customization.top.json", bytes: 0, sha: "" }] };
    const shard = FRAG("top", [ATLAS("shard_atlas", "top.png")]);
    const list: ManifestFragmentRef[] = [{ name: "customization", url: "pack/customization/manifest.customization.json", optional: true }];
    const get = async (u: string): Promise<unknown> => {
      if (u.endsWith("manifest.customization.json")) return index;
      if (u.endsWith("manifest.customization.top.json")) return shard;
      return undefined;
    };
    const { fragments, result } = await loadMergedManifestWith(list, { get, getRequired: get, artUrl: ART });
    expect(fragments).toEqual(["customization"]);
    // Default image resolution absolutizes the shard atlas image against its fragment dir.
    expect(result.registry.atlases.get("shard_atlas")?.pages[0]?.image).toBe("/art/pack/customization/top.png");
  });
});
