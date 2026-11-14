// ADR-394: gzipped manifests decode to the same JSON through DecompressionStream and through the
// pure-TS inflate fallback (Safari < 16.4); plain bodies still parse; repeat boots read the cached plain JSON.
import { afterEach, describe, expect, it, vi } from "vitest";
import { constants, deflateRawSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { gunzipSync, inflateRaw } from "../src/assets/inflate.js";
import { gunzipText, isGzip, responseJson } from "../src/assets/gzip-json.js";
import { assetJsonGz, resetAssetFetchForTests } from "../src/assets/asset-fetch.js";

const rand = (n: number, seed: number, alphabet = 256): Uint8Array => { const b = new Uint8Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = (s >>> 24) % alphabet; } return b; };
const MANIFEST = new URL("../../assets/pack/nature/manifest.nature.json", import.meta.url);

describe("ADR-394 inflate fallback", () => {
  it("matches zlib for stored, fixed, dynamic and long-match streams", () => {
    const cases: Uint8Array[] = [new Uint8Array(0), rand(1, 1), rand(70_000, 2), rand(200_000, 3, 4), new Uint8Array(300_000).fill(65),
      new TextEncoder().encode(JSON.stringify({ a: Array.from({ length: 5000 }, (_, i) => ({ k: `key_${i % 37}`, v: i })) })), readFileSync(MANIFEST)];
    for (const data of cases) for (const opts of [{ level: 0 }, { level: 1 }, { level: 6 }, { level: 9 }, { level: 9, strategy: constants.Z_FIXED }, { level: 9, strategy: constants.Z_HUFFMAN_ONLY }, { level: 9, strategy: constants.Z_RLE }]) {
      expect(Buffer.from(inflateRaw(deflateRawSync(data, opts))).equals(Buffer.from(data))).toBe(true);
      expect(Buffer.from(gunzipSync(gzipSync(data, opts))).equals(Buffer.from(data))).toBe(true);
    }
  });
  it("rejects truncated and non-gzip input", () => {
    const gz = gzipSync(rand(10_000, 5));
    expect(() => gunzipSync(gz.subarray(0, gz.length >> 1))).toThrow();
    expect(() => gunzipSync(new TextEncoder().encode('{"a":1}'))).toThrow();
  });
});

describe("ADR-394 gzip JSON bodies", () => {
  const json = JSON.parse(readFileSync(MANIFEST, "utf8")) as unknown; const text = JSON.stringify(json);
  it("DecompressionStream path and fallback agree", async () => {
    const gz = new Uint8Array(gzipSync(text, { level: 9 })); expect(isGzip(gz)).toBe(true);
    expect(JSON.parse(await gunzipText(gz))).toEqual(json);
    const DS = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    try { (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined; expect(JSON.parse(await gunzipText(gz))).toEqual(json); }
    finally { (globalThis as { DecompressionStream?: unknown }).DecompressionStream = DS; }
  });
  it("responseJson reads gzip and plain (already-decoded) bodies", async () => {
    expect(await responseJson(new Response(gzipSync(text)))).toEqual(json);
    expect(await responseJson(new Response(text))).toEqual(json);
  });
});

describe("ADR-394 assetJsonGz", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetAssetFetchForTests(); });
  const stubCache = (): Map<string, Response> => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", { open: async () => ({ match: async (u: string) => store.get(u)?.clone(), put: async (u: string, r: Response) => { store.set(String(u), r); } }), keys: async () => [], delete: async () => true });
    return store;
  };
  it("first boot fetches <url>.gz once (joined by concurrent readers) and caches the decoded JSON under <url>", async () => {
    const store = stubCache(); const seen: string[] = []; const json = { atlases: [{ key: "a", image: "atlases/a.png" }] };
    vi.stubGlobal("fetch", async (u: string) => { seen.push(u); return new Response(gzipSync(JSON.stringify(json))); });
    const [a, b] = await Promise.all([assetJsonGz("https://x/art/pack/manifest.json"), assetJsonGz("https://x/art/pack/manifest.json")]);
    expect(a).toEqual(json); expect(b).toEqual(json); expect(a).not.toBe(b); // each caller gets its own copy
    expect(seen).toEqual(["https://x/art/pack/manifest.json.gz"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get("https://x/art/pack/manifest.json")!.clone().json()).toEqual(json);
  });
  it("repeat boot reads the cached plain JSON without fetching or decompressing", async () => {
    const store = stubCache(); store.set("https://x/art/pack/ids.lock.json", new Response('{"v":1}'));
    vi.stubGlobal("fetch", async () => { throw new Error("no network on a warm boot"); });
    expect(await assetJsonGz("https://x/art/pack/ids.lock.json")).toEqual({ v: 1 });
  });
  it("missing optional fragment -> undefined; a host-decoded (plain) body still parses", async () => {
    stubCache();
    vi.stubGlobal("fetch", async (u: string) => (u.includes("missing") ? new Response("", { status: 404 }) : new Response('{"ok":true}')));
    expect(await assetJsonGz("https://x/art/missing.json")).toBeUndefined();
    expect(await assetJsonGz("https://x/art/plain.json")).toEqual({ ok: true });
  });
});
