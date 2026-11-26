// ADR-550: painted PNG cache — a warm boot must return the cached PNG without painting,
// a one-byte spec change must invalidate, any Cache Storage failure must fall back to
// painting, stale hashes must be pruned, and ADR-526 "Delete everything" must clear the
// bucket while per-category deletes leave it alone. No canvas in this VM, so the encode
// step is injected (Blob from the painted pixels) — the cache-first / invalidation /
// fallback logic under test is the real painted-cache.ts, and task540AtlasSources is the
// real wired module (its painter is pure, so it runs here).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped relative path into persist's dev dependency (same as adr526_fresh_start.test.ts)
import { IDBFactory } from "../../../packages/persist/node_modules/fake-indexeddb/build/esm/index.js";
import {
  PAINTED_CACHE_NAME, PAINTED_CACHE_MAX_PRUNE_PER_BOOT,
  deletePaintedCache, hashPaintedSpec, lookupPaintedBlobURLs, paintedAtlasURL, paintedCacheKey,
  prunePaintedCache, storePaintedBlob,
  type PaintedCacheEnv,
} from "../src/painted-cache.js";
import { COUGAR_SPEC, task540AtlasSources } from "../src/task540-art.js";
import { deleteLocalProgress, localDbName } from "../src/delete-progress.js";

/** Fake Cache Storage: real Cache Storage returns a fresh Response per match, so match/put clone. */
class FakeCache {
  entries = new Map<string, Response>();
  puts = 0;
  throwOnPut = false;
  async match(req: string): Promise<Response | undefined> { return this.entries.get(req)?.clone(); }
  async put(req: string, res: Response): Promise<void> {
    if (this.throwOnPut) throw new Error("quota exceeded");
    this.puts++;
    this.entries.set(req, res.clone());
  }
  async delete(req: string): Promise<boolean> { return this.entries.delete(req); }
  async keys(): Promise<{ url: string }[]> { return [...this.entries.keys()].map((url) => ({ url })); }
}
class FakeCaches {
  buckets = new Map<string, FakeCache>();
  throwOnOpen = false;
  async open(name: string): Promise<FakeCache> {
    if (this.throwOnOpen) throw new Error("Cache Storage unavailable");
    let b = this.buckets.get(name);
    if (!b) { b = new FakeCache(); this.buckets.set(name, b); }
    return b;
  }
  async delete(name: string): Promise<boolean> { return this.buckets.delete(name); }
  async keys(): Promise<string[]> { return [...this.buckets.keys()]; }
  painted(): FakeCache { return this.buckets.get(PAINTED_CACHE_NAME)!; }
}

class MapStore {
  m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

const PIXELS = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
/** Fake encode: the PNG bytes ARE the painted pixels (byte-identity is what the test proves). */
const fakeEncode = async (_w: number, _h: number, p: Uint8ClampedArray): Promise<Blob> => new Blob([new Uint8Array(p)]);

/** Fake env with a blob-URL registry so tests can read the bytes behind each returned URL. */
function fakeEnv(caches = new FakeCaches()): { env: PaintedCacheEnv; caches: FakeCaches; blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  let n = 0;
  const env: PaintedCacheEnv = {
    caches,
    createObjectURL: (b: Blob) => { const u = `blob:fake-${++n}`; blobs.set(u, b); return u; },
    revokeObjectURL: (u: string) => { blobs.delete(u); },
    encode: fakeEncode,
  };
  return { env, caches, blobs };
}
const bytesOf = async (blobs: Map<string, Blob>, url: string): Promise<number[]> =>
  [...new Uint8Array(await blobs.get(url)!.arrayBuffer())];

describe("ADR-550 paintedAtlasURL (cache-first, single atlas)", () => {
  it("(a) first call paints and puts a PNG under painted/pred_cougar/<hash>; second call with the same hash returns the cached blob without calling the painter, bytes byte-identical", async () => {
    const { env, caches, blobs } = fakeEnv();
    let paints = 0;
    const paint = (): { key: string; width: number; height: number; pixels: Uint8ClampedArray } => {
      paints++;
      return { key: "pred_cougar", width: 2, height: 2, pixels: PIXELS };
    };
    const spec = JSON.stringify({ fur: [198, 158, 104], cell: 56 });
    const first = await paintedAtlasURL({ key: "pred_cougar", spec, paint }, env);
    expect(paints).toBe(1);
    expect(first?.cached).toBe(false);
    expect(first?.bytes).toBe(16);
    expect([...caches.painted().entries.keys()]).toEqual([paintedCacheKey("pred_cougar", hashPaintedSpec(spec))]);
    expect(caches.painted().entries.keys().next().value).toBe(`painted/pred_cougar/${hashPaintedSpec(spec)}`);

    const second = await paintedAtlasURL({ key: "pred_cougar", spec, paint }, env);
    expect(paints).toBe(1); // the painter was NOT called again
    expect(second?.cached).toBe(true);
    expect(await bytesOf(blobs, second!.url)).toEqual(await bytesOf(blobs, first!.url));
    expect(await bytesOf(blobs, second!.url)).toEqual([...PIXELS]);
  });

  it("(b) changing one spec byte (cougar fur colour) changes the hash, misses, repaints, and the old entry is pruned", async () => {
    const { env, caches } = fakeEnv();
    let paints = 0;
    const paint = () => { paints++; return { key: "pred_cougar", width: 2, height: 2, pixels: PIXELS }; };
    const specV1 = JSON.stringify({ fur: [198, 158, 104], cell: 56 });
    const specV2 = JSON.stringify({ fur: [199, 158, 104], cell: 56 }); // one byte changed
    expect(hashPaintedSpec(specV2)).not.toBe(hashPaintedSpec(specV1));
    expect(hashPaintedSpec(specV1)).toBe(hashPaintedSpec(specV1)); // deterministic
    await paintedAtlasURL({ key: "pred_cougar", spec: specV1, paint }, env);
    expect(paints).toBe(1);
    const second = await paintedAtlasURL({ key: "pred_cougar", spec: specV2, paint }, env);
    expect(paints).toBe(2); // cache miss → repaint
    expect(second?.cached).toBe(false);
    const oldKey = paintedCacheKey("pred_cougar", hashPaintedSpec(specV1));
    const newKey = paintedCacheKey("pred_cougar", hashPaintedSpec(specV2));
    expect(caches.painted().entries.has(oldKey)).toBe(true); // still there until pruned
    const pruned = await prunePaintedCache(env, new Set([newKey]));
    expect(pruned.deleted).toBe(1);
    expect(caches.painted().entries.has(oldKey)).toBe(false);
    expect(caches.painted().entries.has(newKey)).toBe(true);
  });

  it("(c) Cache Storage throws / unavailable → paints normally, boot succeeds", async () => {
    // open() throws (private mode / quota): lookup + store both fail soft.
    const throwing = fakeEnv();
    throwing.caches.throwOnOpen = true;
    let paints = 0;
    const paint = () => { paints++; return { key: "pred_cougar", width: 2, height: 2, pixels: PIXELS }; };
    const r = await paintedAtlasURL({ key: "pred_cougar", spec: "s", paint }, throwing.env);
    expect(paints).toBe(1);
    expect(r?.cached).toBe(false);
    expect(r?.bytes).toBe(16);
    // put() throws: the fresh blob is still returned, the failure never surfaces.
    const quota = fakeEnv();
    (await quota.caches.open(PAINTED_CACHE_NAME)).throwOnPut = true;
    const r2 = await paintedAtlasURL({ key: "pred_cougar", spec: "s", paint: () => ({ key: "pred_cougar", width: 2, height: 2, pixels: PIXELS }) }, quota.env);
    expect(r2?.bytes).toBe(16);
    // caches entirely absent (no Cache Storage on this platform): paint, no crash.
    const absent = fakeEnv();
    const r3 = await paintedAtlasURL({ key: "pred_cougar", spec: "s", paint }, { ...absent.env, caches: null });
    expect(r3?.bytes).toBe(16);
    // …and the batch lookup also falls back (returns undefined = paint path), never throws.
    expect(await lookupPaintedBlobURLs(new Map([["pred_cougar", "s"]]), { caches: null })).toBeUndefined();
  });

  it("prune is bounded per boot and leaves non-painted entries alone", async () => {
    const { env, caches } = fakeEnv();
    const cache = await caches.open(PAINTED_CACHE_NAME);
    for (let i = 0; i < PAINTED_CACHE_MAX_PRUNE_PER_BOOT + 10; i++) {
      await cache.put(`painted/stale_atlas/${i}`, new Response(new Blob([new Uint8Array([i])])));
    }
    await cache.put("other/not-painted", new Response(new Blob([new Uint8Array([9])])));
    const live = paintedCacheKey("pred_cougar", hashPaintedSpec("live"));
    await storePaintedBlob("pred_cougar", hashPaintedSpec("live"), new Blob([new Uint8Array([1])]), env);
    const pruned = await prunePaintedCache(env, new Set([live]));
    expect(pruned.deleted).toBe(PAINTED_CACHE_MAX_PRUNE_PER_BOOT); // bounded, never unbounded
    expect(cache.entries.has(live)).toBe(true);
    expect(cache.entries.has("other/not-painted")).toBe(true); // foreign entries untouched
    expect(await prunePaintedCache({ caches: null })).toEqual({ deleted: 0 });
  });
});

describe("ADR-550 task540 wiring (the named example: pred_cougar)", () => {
  it("first call paints + stores both species; second call re-puts nothing and returns byte-identical PNGs", async () => {
    const { env, caches, blobs } = fakeEnv();
    const first = await task540AtlasSources(env);
    expect([...first.keys()].sort()).toEqual(["pred_cougar", "pred_wolverine"]);
    expect(caches.painted().puts).toBe(2);
    expect([...caches.painted().entries.keys()].every((k) => k.startsWith("painted/pred_"))).toBe(true);
    const firstBytes = new Map([...first.entries()].map(([k, s]) => [k, blobs.get(s.url)!]));
    const second = await task540AtlasSources(env);
    expect(caches.painted().puts).toBe(2); // no repaint → no re-encode → no re-put
    for (const [k, s] of second) {
      expect(await bytesOf(blobs, s.url)).toEqual([...new Uint8Array(await firstBytes.get(k)!.arrayBuffer())]);
    }
    // The cache keys are the spec-hash keys (not a deploy version): painted/<atlas>/<16 hex>.
    expect([...caches.painted().entries.keys()].sort()).toEqual([
      expect.stringMatching(/^painted\/pred_cougar\/[0-9a-f]{16}$/),
      expect.stringMatching(/^painted\/pred_wolverine\/[0-9a-f]{16}$/),
    ]);
  });

  it("the cougar spec hash is sensitive to one fur byte (the invalidation input is the real spec)", () => {
    expect(hashPaintedSpec(JSON.stringify({ ...COUGAR_SPEC, fur: [199, 158, 104] })))
      .not.toBe(hashPaintedSpec(JSON.stringify(COUGAR_SPEC)));
  });

  it("canvas-less (no Cache Storage, no canvas) still returns an empty map — the manifest debug path is kept", async () => {
    expect(await task540AtlasSources({ caches: null })).toEqual(new Map());
  });
});

describe("ADR-550 delete-everything clears the painted cache (d)", () => {
  it("everything deletes the survivaz-painted-v1 bucket and leaves other buckets alone; per-category delete does not touch it", async () => {
    const factory = new IDBFactory();
    const storage = new MapStore();
    const session = new MapStore();
    const caches = new FakeCaches();
    const painted = await caches.open(PAINTED_CACHE_NAME);
    await painted.put("painted/pred_cougar/abc", new Response(new Blob([new Uint8Array([1])])));
    const other = await caches.open("survivaz-art-v1");
    await other.put("art/manifest.json", new Response(new Blob([new Uint8Array([2])])));

    const r = await deleteLocalProgress({ slot: "1", factory, storage, session, kinds: new Set(), everything: true, blockedMs: 500, paintedCaches: caches });
    expect(r.ok).toBe(true);
    expect(await caches.keys()).toEqual(["survivaz-art-v1"]); // painted bucket gone, art bucket kept
    expect((await caches.open("survivaz-art-v1")).entries.has("art/manifest.json")).toBe(true);

    // …and per-category delete leaves the painted bucket in place.
    const paintedAgain = await caches.open(PAINTED_CACHE_NAME);
    await paintedAgain.put("painted/pred_cougar/abc", new Response(new Blob([new Uint8Array([1])])));
    const r2 = await deleteLocalProgress({ slot: "1", factory, storage, session, kinds: new Set(["settings"]), paintedCaches: caches });
    expect(r2.ok).toBe(true);
    expect(caches.buckets.has(PAINTED_CACHE_NAME)).toBe(true);
    expect((await caches.open(PAINTED_CACHE_NAME)).entries.has("painted/pred_cougar/abc")).toBe(true);
  });

  it("deletePaintedCache never throws and reports false when Cache Storage is unavailable", async () => {
    expect(await deletePaintedCache({ caches: null })).toBe(false);
    const throwing = new FakeCaches();
    throwing.throwOnOpen = true;
    expect(await deletePaintedCache({ caches: throwing })).toBe(false);
    const caches = new FakeCaches();
    await caches.open(PAINTED_CACHE_NAME);
    expect(await deletePaintedCache({ caches })).toBe(true);
    expect(await deletePaintedCache({ caches })).toBe(false); // already gone
    expect(localDbName("1")).toBe("engine-local-1"); // slot-scoped save names untouched
  });
});

describe("ADR-550 view.ts wiring (source pins — IsoView.create needs a canvas + GL)", () => {
  it("the painted phase prunes stale hashes fire-and-forget after the phase closes, and ADR-548's blob.size read still stands", () => {
    const viewSrc = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
    expect(viewSrc).toContain(`import { prunePaintedCache } from "./painted-cache.js";`);
    expect(viewSrc).toContain(`void prunePaintedCache();`);
    expect(viewSrc.indexOf(`void prunePaintedCache();`)).toBeGreaterThan(viewSrc.indexOf(`phase("painted", t0);`));
    // ADR-548: cached blobs are still blob: URLs, so the fetch(blob:) size read keeps working.
    expect(viewSrc).toContain(`paintedAtlasBytes.push({ key: k, bytes })`);
    expect(viewSrc).toContain(`view.paintedAtlasBytes = paintedAtlasBytes; view.registryNote = registryNote;`);
  });
});
