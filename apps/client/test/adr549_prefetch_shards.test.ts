// ADR-549: prefetch-art.ts expands the customization shard index and warms the shards + ids.lock
// (fetch-only, no JSON.parse) before the resident-image warm. Wiring-only change, pinned by source
// (prefetch-art.ts runs a top-level side-effect IIFE against `location`, so it is not importable
// headlessly); the warm path itself is covered behaviourally in
// packages/render/test/adr549_manifest_prefetch.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("ADR-549 prefetch-art.ts shard wiring (source pins)", () => {
  const src = readFileSync(new URL("../src/prefetch-art.ts", import.meta.url), "utf8");
  it("expands the shard index and warms shards + ids.lock before the image warm", () => {
    expect(src).toContain("collectShardManifestUrls");
    expect(src).toContain("warmManifestGz");
    expect(src).toContain("pack/ids.lock.json");
    // Shard warming runs before the resident-image warm (the manifest phase precedes registry.fetch).
    expect(src.indexOf("warmManifestGz")).toBeLessThan(src.indexOf("warmAssetCache(urls)"));
    // Gz builds only: the dev server serves plain JSON, where the shards are local and fast.
    expect(src).toContain("if (idx?.gz) await warmManifestGz");
  });
});
