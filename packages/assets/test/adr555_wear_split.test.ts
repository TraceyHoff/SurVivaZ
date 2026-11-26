// ADR-555: wear shards out of the boot manifest (wear-split, not pre-merge).
// Direction evidence (VM, node JSON.parse on the on-disk shards): the 9 wear shards are 74.5 MB
// on disk / 35.6 MB minified — 88% of parsed manifest bytes — and 388 ms of 441 ms total parse
// time, while base + every other fragment parse in 53 ms. Parse dominates the manifest phase, so
// excluding the wear shards from boot is the right split; a pre-merged manifest would keep the
// whole 388 ms parse on the boot path.
import { describe, expect, it } from "vitest";
import { cosmeticsHashes, defaultAppearance, resolveLayers, validateAppearance } from "@engine/core";
import { ART_DIRS, loadMergedPackManifest, readArtJson } from "../src/node.js";
import { loadMergedManifestWith, loadWearShard, MANIFEST_INDEX } from "../src/manifest-index.js";
import { WEAR_SHARD_CATEGORIES } from "../src/shards.js";

const ART_URL = "http://art.invalid/";
/** The dedicated server's disk loader, replayed through loadMergedManifestWith so fetches are observable. */
const nodeGet = async (url: string): Promise<unknown> =>
  url.startsWith(ART_URL) ? readArtJson(decodeURIComponent(url.slice(ART_URL.length)), ART_DIRS) : undefined;

describe("ADR-555 wear shards out of the boot manifest", () => {
  it("boot manifest excludes the wear shards: no wear fetch, core ids identical to the full merge", async () => {
    const fetched: string[] = [];
    const recordingGet = async (url: string): Promise<unknown> => { fetched.push(url); return nodeGet(url); };
    const boot = await loadMergedManifestWith(MANIFEST_INDEX, { get: recordingGet, artUrl: ART_URL, excludeWearShards: true });
    const full = await loadMergedPackManifest();
    // The 9 wear shards are never fetched at boot (only the base shard, via the index expansion).
    expect(fetched.filter((u) => /manifest\.customization\.(hair|hat|top|bottom|shoes|accessory|face|eyes|hands)\.json/.test(u))).toEqual([]);
    expect(fetched.some((u) => u.endsWith("manifest.customization.base.json"))).toBe(true);
    expect(boot.deferredWearShards.map((s) => s.category)).toEqual([...WEAR_SHARD_CATEGORIES]);
    expect(boot.fragments).toContain("customization");
    // Core sprite ids are the full merge's ids (same ids.lock.json, same assign): every boot sprite
    // resolves to the same numeric id in the full registry, and the wear sprites are absent.
    const bootReg = boot.result.registry, fullReg = full.result.registry;
    expect(bootReg.ids.sprites.tryId("cz_top_tee_male")).toBeUndefined();
    expect(bootReg.ids.sprites.tryId("cz_face_smile_male")).toBeUndefined();
    expect(bootReg.size).toBe(fullReg.size - 428);
    for (const s of bootReg.allSprites()) expect(fullReg.ids.sprites.tryId(s.key)).toBe(s.id);
    expect(bootReg.ids.sprites.tryId("body_male")).toBe(fullReg.ids.sprites.tryId("body_male"));
    expect(bootReg.ids.sprites.tryId("body_female")).toBe(fullReg.ids.sprites.tryId("body_female"));
    // Boot cosmetics: body art + palettes present (character creation can show bodies), no wearables yet.
    const cat = bootReg.cosmetics!;
    expect(cat.skinTones.length).toBe(18); expect(cat.hairColors.length).toBe(20); expect(cat.clothingColors.length).toBe(26);
    expect(cat.size).toBe(0);
    expect(cat.bodySprite("male")).toBeDefined(); expect(cat.bodySprite("female")).toBeDefined();
    // The boot registry is a partial state by design: its hash differs from the full merge's, but a
    // second boot load is deterministic.
    expect(bootReg.hash).not.toBe(fullReg.hash);
    const boot2 = await loadMergedPackManifest({ excludeWearShards: true });
    expect(boot2.result.registry.hash).toBe(bootReg.hash);
  });

  it("lazy loadWearShard('top') yields the full merge's ids, and all nine converge to the full registry", async () => {
    const boot = await loadMergedPackManifest({ excludeWearShards: true });
    const full = await loadMergedPackManifest();
    const io = { get: nodeGet, artUrl: ART_URL, lock: boot.result.lock };
    const top = await loadWearShard(boot.result.registry, "top", io);
    expect(top).toMatchObject({ category: "top", sprites: 108, atlases: 35, wearables: 28 });
    const bootReg = boot.result.registry, fullReg = full.result.registry;
    expect(bootReg.ids.sprites.tryId("cz_top_tee_male")).toBe(fullReg.ids.sprites.tryId("cz_top_tee_male"));
    expect(bootReg.cosmetics!.size).toBe(28);
    expect(bootReg.cosmetics!.byKey("top_tee")).toBeDefined();
    // The remaining eight shards converge exactly: every sprite id, the cosmetics catalog
    // (size + hash) and the registry hash all equal the full merge.
    for (const c of WEAR_SHARD_CATEGORIES.filter((x) => x !== "top")) await loadWearShard(bootReg, c, io);
    expect(bootReg.size).toBe(fullReg.size);
    for (const s of fullReg.allSprites()) expect(bootReg.ids.sprites.tryId(s.key)).toBe(s.id);
    expect(bootReg.cosmetics!.size).toBe(fullReg.cosmetics!.size);
    expect(bootReg.cosmetics!.size).toBe(170);
    expect(cosmeticsHashes(bootReg.cosmetics)).toEqual(cosmeticsHashes(fullReg.cosmetics));
    expect(bootReg.hash).toBe(fullReg.hash);
    // Wear atlas images resolve exactly as the full merge resolves them (absolute pathnames).
    expect(bootReg.atlases.get("cz_wr_top_cardigan")?.image).toBe(fullReg.atlases.get("cz_wr_top_cardigan")?.image);
    expect(bootReg.atlases.get("cz_wr_top_tee")?.image).toBe(fullReg.atlases.get("cz_wr_top_tee")?.image);
  });

  it("lazy load rejects a second merge, the base category, and a full-merge registry", async () => {
    const boot = await loadMergedPackManifest({ excludeWearShards: true });
    const full = await loadMergedPackManifest();
    const io = { get: nodeGet, artUrl: ART_URL, lock: boot.result.lock };
    await loadWearShard(boot.result.registry, "top", io);
    await expect(loadWearShard(boot.result.registry, "top", io)).rejects.toThrow(/already merged/);
    await expect(loadWearShard(boot.result.registry, "base", io)).rejects.toThrow(/not a wear shard category/);
    await expect(loadWearShard(boot.result.registry, "nope", io)).rejects.toThrow(/not a wear shard category/);
    await expect(loadWearShard(full.result.registry, "top", io)).rejects.toThrow(/deferWear/);
  });

  it("boot-time wear consumers tolerate absent wear sprites (body only, no throw)", async () => {
    const boot = await loadMergedPackManifest({ excludeWearShards: true });
    const full = await loadMergedPackManifest();
    const bootCat = boot.result.registry.cosmetics!, fullCat = full.result.registry.cosmetics!;
    // A stored look that wears hair + face + top resolves to body-only layers on the boot catalog…
    const look = defaultAppearance(fullCat, 0);
    expect(look.parts.some((p) => p !== 0)).toBe(true);
    const layers = resolveLayers(bootCat, look, 0);
    expect(layers.map((l) => l.slot)).toEqual(["body"]);
    // …and the same look on the converged catalog draws its wear layers.
    for (const c of WEAR_SHARD_CATEGORIES) await loadWearShard(boot.result.registry, c, { get: nodeGet, artUrl: ART_URL, lock: boot.result.lock });
    const convergedCat = boot.result.registry.cosmetics!;
    expect(resolveLayers(convergedCat, look, 0).map((l) => l.slot)).toEqual(expect.arrayContaining(["body", "hair", "face", "eyes"]));
    // validateAppearance clamps the unknown parts to 0 instead of throwing (boot catalog, clamp mode).
    const boot2 = await loadMergedPackManifest({ excludeWearShards: true });
    const repaired = validateAppearance(boot2.result.registry.cosmetics!, look);
    expect(repaired.value).toBeDefined();
    expect(repaired.value!.parts.every((p) => p === 0)).toBe(true);
    expect(repaired.issues.length).toBeGreaterThan(0);
    // defaultAppearance on the boot catalog is body-only by construction (no defaults resolve yet).
    expect(defaultAppearance(bootCat, 0).parts.every((p) => p === 0)).toBe(true);
  });
});
