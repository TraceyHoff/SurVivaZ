// ADR-555: the client's boot manifest excludes the wear shards, and the lazy path converges to
// the dedicated server's full registry (ADR-248 parity, extended). ADR-549's parallel fragment
// fetch keeps working under the split: fragments still load concurrently, the wear shards just
// are not in the boot list.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cosmeticsHashes } from "@engine/core";
import { loadMergedManifestWith, loadWearShard, MANIFEST_LOAD_CONCURRENCY, WEAR_SHARD_CATEGORIES } from "@engine/assets";
import { loadMergedPackManifest } from "@engine/assets/node";
import { artFile, artServed } from "../vite.config.js";
import { servedManifestIndex } from "../src/manifest-index.js";

const ART = "http://client.test/art/";
/** The client's fetch, replayed against what the dev server serves (vite.config MOUNTS + manifests.index.json). */
const clientGet = async (url: string): Promise<unknown> => {
  if (!url.startsWith(ART)) return undefined;
  const rel = decodeURIComponent(url.slice(ART.length));
  if (rel === "manifests.index.json") return servedManifestIndex(artServed);
  const f = artFile(rel); return f ? JSON.parse(readFileSync(f, "utf8")) : undefined;
};

describe("ADR-555 client boot manifest / lazy wear parity", () => {
  it("boot loads no wear shard, core ids match the server, and lazy load converges to the server registry", async () => {
    const fetched: string[] = [];
    const recordingGet = async (url: string): Promise<unknown> => { fetched.push(url); return clientGet(url); };
    const idx = await clientGet(ART + "manifests.index.json") as ReturnType<typeof servedManifestIndex>;
    const boot = await loadMergedManifestWith(idx.fragments, { get: recordingGet, artUrl: ART, excludeWearShards: true });
    const server = await loadMergedPackManifest();
    expect(fetched.filter((u) => /manifest\.customization\.(hair|hat|top|bottom|shoes|accessory|face|eyes|hands)\.json/.test(u))).toEqual([]);
    expect(boot.deferredWearShards.map((s) => s.category)).toEqual([...WEAR_SHARD_CATEGORIES]);
    expect(boot.fragments).toEqual(server.fragments);
    const bootReg = boot.result.registry, serverReg = server.result.registry;
    expect(bootReg.ids.sprites.tryId("cz_top_tee_male")).toBeUndefined();
    for (const s of bootReg.allSprites()) expect(serverReg.ids.sprites.tryId(s.key)).toBe(s.id);
    expect(bootReg.cosmetics!.size).toBe(0);
    expect(bootReg.cosmetics!.skinTones.length).toBe(18);
    // Lazy-load every deferred shard through the client's own fetch: ids, cosmetics and hash
    // converge to the server's full registry.
    const io = { get: clientGet, artUrl: ART, lock: boot.result.lock };
    for (const c of WEAR_SHARD_CATEGORIES) await loadWearShard(bootReg, c, io);
    expect(bootReg.size).toBe(serverReg.size);
    for (const s of serverReg.allSprites()) expect(bootReg.ids.sprites.tryId(s.key)).toBe(s.id);
    expect(bootReg.cosmetics!.size).toBe(serverReg.cosmetics!.size);
    expect(cosmeticsHashes(bootReg.cosmetics)).toEqual(cosmeticsHashes(serverReg.cosmetics));
    expect(bootReg.hash).toBe(serverReg.hash);
  });

  it("fragments still fetch in parallel with the wear shards excluded (ADR-549 preserved)", async () => {
    const idx = await clientGet(ART + "manifests.index.json") as ReturnType<typeof servedManifestIndex>;
    let inFlight = 0, maxInFlight = 0;
    const delayedGet = async (url: string): Promise<unknown> => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try { return await clientGet(url); } finally { inFlight--; }
    };
    const boot = await loadMergedManifestWith(idx.fragments, { get: delayedGet, artUrl: ART, excludeWearShards: true });
    expect(maxInFlight).toBeGreaterThanOrEqual(6);
    expect(maxInFlight).toBeLessThanOrEqual(MANIFEST_LOAD_CONCURRENCY);
    expect(boot.deferredWearShards).toHaveLength(9);
  });

  it("IsoView boots with a wear-less catalog and loads wear on demand (source pins)", async () => {
    const viewSrc = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
    // Boot excludes the wear shards; the view owns the lazy load and its trigger.
    expect(viewSrc).toContain("excludeWearShards: true");
    expect(viewSrc).toContain("ensureWearShards()");
    expect(viewSrc).toContain("loadWearShard(this.registry, c, io)");
    // Appearance stays registered on a size-0 boot catalog (body-only until the shards land),
    // instead of the old size gate that would have dropped replicated Appearance entirely.
    expect(viewSrc).toContain("if (cat) this.view.register(Appearance)");
    expect(viewSrc).not.toContain("if (cat?.size) this.view.register(Appearance)");
    const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    // The character creator loads the wear shards before it reads the catalog (both entry points).
    expect(mainSrc.match(/await iso\?\.ensureWearShards\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
