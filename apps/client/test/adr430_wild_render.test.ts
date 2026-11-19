// ADR-430: wild plants and fruit trees resolve to a real sprite on BOTH renderers.
//
// WebGL2 and Canvas2D share one classification: `IsoView.classify` (apps/client/src/view.ts)
// takes a `ResourceNode` to `defs.resources.get(n.kind)?.spriteKey` and then `this.rs(key)` —
// `resolveSprite` with `has = (k) => this.sid(k) !== undefined`, where `sid` is
// `registry.ids.sprites.tryId(k)` on the merged manifest registry. This test replays that
// exact path headlessly, on the real merged registry (`loadMergedPackManifest`, the same
// MANIFEST_INDEX the client boots from), for every wild-plant kind: a spawned wild node is
// drawable iff `rs` returns a real sprite id.
//
// What it pins, and what it deliberately does not:
// - Every plantable's `wild` node, `wild_garden`, and every `becomes` bush/tree node resolves
//   to a real sprite id through `resolveSprite` + the merged registry.
// - The 24 ADR-349 wild plants draw with their farmed `crop_*` art, which lives on the
//   `stream`-residency `nature_crops` atlas: the registry contains the atlas, and
//   `sourcesFromManifest` (the exact call view.ts makes at boot) includes it. ADR-438
//   loads the small plant sheets resident on >= 128 MB budgets (AtlasManager
//   RESIDENT_PLANT_RE, the ADR-156/246 precedent), so WebGL2 no longer shows
//   `placeholder_sprout` for a crop while its stream page loads — the page-in gap this
//   test used to pin is closed by that change; the user's eyes on the live build are
//   still the check that a wild plant actually looks crisp.
// - Fruit trees resolve on resident `nature_trees` (no page-in gap), classify as `tall`
//   (view.ts: the key ends with `_tree` -> tall scale + occluder + sway), and their idle
//   frame differs from the depleted frame (fruit is in the idle art). No fruit overlay /
//   scale bump is added here — that is the ADR-349 follow-up, still out of scope.
import { describe, expect, it } from "vitest";
import { loadMergedPackManifest } from "@engine/assets/node";
import { sourcesFromManifest } from "@engine/render";
import { defaultDefs, FARMING, resolveSprite } from "@engine/gameplay";

const FRUIT_TREES = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;
/** Every resource kind a wild plant can spawn as: each plantable's wild sources, the mixed garden, and the grown bush/tree nodes (which regrow into the same node they are gathered from). */
const WILD_KINDS: string[] = [...new Set([...FARMING.plantables.flatMap((p) => p.wild), "wild_garden", ...FARMING.plantables.map((p) => p.becomes)])];

/** The `view.rs` predicate, verbatim: `sid(k) !== undefined` on the merged registry. */
async function mergedHas(): Promise<{ has: (k: string) => boolean; registry: Awaited<ReturnType<typeof loadMergedPackManifest>>["result"]["registry"] }> {
  const { result, collisions } = await loadMergedPackManifest();
  expect(collisions.filter((c) => c.key.startsWith("wild_") || c.key.startsWith("crop_") || c.key.endsWith("_tree") || c.key.endsWith("_bush"))).toEqual([]);
  expect(result.warnings).toEqual([]);
  const registry = result.registry;
  return { registry, has: (k: string) => registry.ids.sprites.tryId(k) !== undefined };
}
/** The `view.rs` resolution, verbatim: `resolveSprite` + the sprite id `sid` returns for the resolved key. */
function rs(registry: Awaited<ReturnType<typeof loadMergedPackManifest>>["result"]["registry"], has: (k: string) => boolean, key: string): { id: number; key: string; atlas: string; residency: string | undefined } | undefined {
  const r = resolveSprite(key, has);
  if (!r) return undefined;
  const id = registry.ids.sprites.tryId(r.key);
  if (id === undefined) return undefined;
  const sprite = registry.sprite(id);
  return { id, key: r.key, atlas: sprite.atlas.key, residency: sprite.atlas.residency };
}

describe("ADR-430 wild plants resolve to a real sprite (shared view.classify path)", () => {
  it("every wild-plant kind resolves through resolveSprite to a real sprite id in the merged registry", async () => {
    const { registry, has } = await mergedHas();
    const defs = defaultDefs();
    const byAtlas = new Map<string, string[]>();
    for (const kind of WILD_KINDS) {
      const res = defs.resources.get(defs.resourceId(kind))!;
      expect(res, kind).toBeDefined();
      const r = rs(registry, has, res.spriteKey);
      expect(r, `${kind} (spriteKey ${res.spriteKey})`).toBeDefined();
      byAtlas.set(r!.atlas, [...(byAtlas.get(r!.atlas) ?? []), kind]);
    }
    // The ADR-349 wild plants draw with farmed art on the streamed nature_crops atlas; the
    // bushes and trees (incl. fruit trees) live on resident nature atlases.
    expect(byAtlas.get("nature_crops")?.length, "wild plants on nature_crops").toBeGreaterThanOrEqual(24);
    expect(byAtlas.get("nature_trees"), "trees on nature_trees").toContain("apple_tree");
  });

  it("nature_crops is declared stream in the manifest (ADR-438 loads it resident: no placeholder page-in gap) and sourcesFromManifest includes it", async () => {
    const { result } = await loadMergedPackManifest();
    const registry = result.registry;
    const crops = registry.atlases.get("nature_crops");
    expect(crops, "nature_crops in the merged registry").toBeDefined();
    expect(crops!.residency).toBe("stream"); // manifest declaration unchanged; the renderer overrides it (RESIDENT_PLANT_RE)
    expect(crops!.placeholder).toBe("placeholder_sprout"); // fallback if a < 128 MB budget ever streams it again
    const trees = registry.atlases.get("nature_trees");
    expect(trees!.residency ?? "resident").toBe("resident"); // fruit trees have no page-in gap
    // The exact boot call (view.ts): every registry atlas gets an image source.
    const sources = sourcesFromManifest(registry, "http://art.invalid/pack/manifest.json", {}, { probeSiblings: false });
    expect(sources.has("nature_crops")).toBe(true);
    expect(sources.has("nature_trees")).toBe(true);
    expect(sources.get("nature_crops")!.url).toContain("nature_crops.png");
  });

  it("fruit trees classify tall on both renderers and bear fruit in the idle art", async () => {
    const { registry, has } = await mergedHas();
    const defs = defaultDefs();
    for (const tree of FRUIT_TREES) {
      const res = defs.resources.get(defs.resourceId(tree))!;
      const r = rs(registry, has, res.spriteKey);
      expect(r, tree).toBeDefined();
      expect(r!.key).toBe(tree); // fruit trees keep their own art (no crop_* remap)
      expect(r!.atlas).toBe("nature_trees");
      // view.ts classify: `tall = key === "tree" || key.startsWith("tree_") || key.endsWith("_tree")`
      // — tall scale (1.1 + hash jitter) + occluder + sway. Every fruit tree must hit that branch.
      expect(res.spriteKey.endsWith("_tree"), `${tree} classifies tall`).toBe(true);
      // The idle frame differs from the bare (depleted) frame: the fruit is in the idle art.
      const sprite = registry.sprite(r!.id);
      const idle = sprite.animations.get("idle")?.frames[0];
      const depleted = sprite.animations.get("depleted")?.frames[0];
      expect(idle, `${tree} idle frame`).toBeDefined();
      expect(depleted, `${tree} depleted frame`).toBeDefined();
      expect(idle, `${tree} idle != depleted`).not.toBe(depleted);
    }
  });
});
