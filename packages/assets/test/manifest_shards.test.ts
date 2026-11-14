import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { isShardIndex, mergeShards, resolveManifestShards, ShardMergeError, MANIFEST_SHARD_MAX_BYTES, type ManifestJson } from "../src/index.js";
import { readManifestJson, PACK_DIR } from "../src/node.js";
import { manifestFiles } from "../scripts/manifest-files.js";

// ADR-138: manifest shards (v2 index) + the 20 MiB per-file guard.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const frag = (o: Record<string, unknown>) => ({ version: 1, name: "t", atlases: [], sprites: [], ...o }) as unknown as ManifestJson;

describe("manifest file size (ADR-138)", () => {
  const files = manifestFiles(root);
  it("finds the manifests", () => expect(files.length).toBeGreaterThan(5));
  for (const f of files) it(`${relative(root, f)} is under 20 MiB`, () => expect(statSync(f).size).toBeLessThanOrEqual(MANIFEST_SHARD_MAX_BYTES));
});

describe("customization manifest shards", () => {
  const idxPath = PACK_DIR + "customization/manifest.customization.json";
  const idx = JSON.parse(readFileSync(idxPath, "utf8"));
  it("is a v2 index whose bytes + sha match each shard", () => {
    expect(isShardIndex(idx)).toBe(true);
    for (const s of idx.shards) {
      const b = readFileSync(PACK_DIR + "customization/" + s.file);
      expect(b.length, s.file).toBe(s.bytes); expect(createHash("sha256").update(b).digest("hex"), s.file).toBe(s.sha);
    }
    expect(new Set(idx.shards.map((s: { category: string }) => s.category))).toContain("base");
  });
  it("merges to a full manifest (every wearable slot has a shard)", () => {
    const m = readManifestJson(idxPath);
    expect(m.version).toBe(1); expect(m.wearables.length).toBeGreaterThan(100); expect(m.bodyTypes.male).toBeTruthy();
    for (const slot of new Set(m.wearables.map((w: { slot: string }) => w.slot))) expect(idx.shards.some((s: { category: string }) => s.category === slot), String(slot)).toBe(true);
  });
  it("async loader fetches shards in parallel and equals the sync merge", async () => {
    let inflight = 0, peak = 0;
    const m = await resolveManifestShards(idx, async (file) => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return JSON.parse(readFileSync(PACK_DIR + "customization/" + file, "utf8")); });
    expect(peak).toBe(idx.shards.length);
    expect(m).toEqual(readManifestJson(idxPath));
  });
});

describe("mergeShards", () => {
  it("passes v1 through", async () => { const v1 = frag({ sprites: [{ key: "a" }] }); expect(await resolveManifestShards(v1, async () => { throw new Error("no fetch"); })).toBe(v1); });
  it("concatenates keyed arrays and unions records", () => {
    const m = mergeShards([{ file: "a", manifest: frag({ sprites: [{ key: "x" }], bodyTypes: { male: {} } }) }, { file: "b", manifest: frag({ sprites: [{ key: "y" }], bodyTypes: { female: {} } }) }]) as any;
    expect(m.sprites.map((s: { key: string }) => s.key)).toEqual(["x", "y"]); expect(Object.keys(m.bodyTypes)).toEqual(["male", "female"]);
  });
  it("duplicate keys across shards are an error", () => {
    expect(() => mergeShards([{ file: "a", manifest: frag({ sprites: [{ key: "x" }] }) }, { file: "b", manifest: frag({ sprites: [{ key: "x" }] }) }])).toThrow(ShardMergeError);
    expect(() => mergeShards([{ file: "a", manifest: frag({ bodyTypes: { male: {} } }) }, { file: "b", manifest: frag({ bodyTypes: { male: {} } }) }])).toThrow(/duplicate bodyTypes.male/);
    expect(() => mergeShards([{ file: "a", manifest: frag({ requiredSlots: ["face"] }) }, { file: "b", manifest: frag({ requiredSlots: ["face"] }) }])).toThrow(ShardMergeError);
  });
  it("missing shard rejects", async () => { await expect(resolveManifestShards({ version: 2, shards: [{ category: "x", file: "x.json", bytes: 0, sha: "" }] }, async () => undefined)).rejects.toThrow(/missing/); });
  // ADR-405: a loader FAILURE is not a missing shard — the real error must propagate so the boot
  // overlay names the cause (HTTP 503, gunzip, parse) instead of every failure reading as "missing".
  it("loader failure propagates with its cause, not as 'missing'", async () => {
    await expect(resolveManifestShards({ version: 2, shards: [{ category: "hat", file: "manifest.customization.hat.json", bytes: 0, sha: "" }] },
      async () => { throw new Error("manifest fetch failed: HTTP 503: manifest.customization.hat.json.gz"); })).rejects.toThrow(/HTTP 503/);
  });
});
