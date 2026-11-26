import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { AssetManager } from "@engine/core";
import { loadManifest, mergeManifests, type AssetRegistry } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";

/**
 * ADR-553: only the local player's body pages are eager at rebuild; the rest defer to
 * prio-0-on-first-draw (pageReady) or the ADR-544 drain, which pages first-view bodies in
 * before the overlay lifts (body-pool pages bypass the stream-pool page cap in warmupFirstView).
 *
 * Real merged manifest (pack + customization), stub GL + stubbed fetch/decode — the same harness
 * as adr548, plus a KTX2 target (setCompressed astc) so the body pages actually land in the body
 * pool: without a target, bodyKeys is empty and body sheets fall into the wear pool (where they
 * were never eager). Test sources carry a ktx2 twin for the three body pages only, so the tail
 * stays RGBA8 (no transcoder in the harness) and pageInOwn takes its PNG path.
 *
 * Real inventory (probed 2026-11-26): 3 body pages — body_male, body_female, and the shared
 * cz_block_body_0 (both sexes block with it). Swim/punch live on the same sheet, ride/crouch
 * pages stream from the wear pool and are never eager. So the deferred set at boot is exactly
 * the opposite-sex sheet: 1 page.
 */
vi.mock("../src/assets/asset-fetch.js", () => ({
  assetFetch: async (_url: string) => ({
    ok: true, status: 200,
    blob: async () => { await new Promise((r) => setTimeout(r, 2)); return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); },
  }),
  assetBytes: async (_url: string) => new ArrayBuffer(8),
  withAssetSlot: (fn: () => Promise<unknown>) => fn(),
  // ADR-553: the real predicate (ride / crouch doll pages stream, never eager) — the adr548
  // mock's `() => false` would let them into the eager set and break the per-type split.
  isLazyDollPageKey: (k: string) => /^cz_(ride|crouch)_/.test(k),
}));

import { AtlasManager, bodyAtlasKeys, bodyPagesForBodyType, defaultImageLoader, setResizeSlicing, wearableOnlyAtlases } from "../src/assets/atlasManager.js";
import { setKtx2Transcoder } from "../src/assets/ktx2.js";

const json = (p: string) => readManifestJson(PACK_DIR + p);
const reg = (): AssetRegistry => loadManifest(mergeManifests([{ name: "pack", manifest: json("manifest.json") }, { name: "customization", manifest: json("customization/manifest.customization.json") }] as never).manifest).registry;

const BODY_KEYS = ["body_male", "body_female", "cz_block_body_0"];

function stubGl(): { gl: never } {
  let tex = 0;
  const gl = {
    canvas: undefined,
    TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_2D: 0x0de1, RGBA8: 0x8058, RGBA: 0x1908, RGBA32F: 0x8814,
    UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, NO_ERROR: 0, OUT_OF_MEMORY: 0x0505,
    CLAMP_TO_EDGE: 0x812f, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST: 0x2600,
    MAX_TEXTURE_SIZE: 0x0d33, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240,
    getParameter: () => 4096, getError: () => 0, isContextLost: () => false,
    createTexture: () => ({ id: ++tex }), deleteTexture: () => {},
    bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
    texStorage3D: () => {}, texSubImage3D: () => {}, texSubImage2D: () => {}, texImage2D: () => {},
    generateMipmap: () => {},
  };
  return { gl: gl as never };
}

/** Structural view of the manager bits the tests read (a separate type, not an intersection:
 *  AtlasManager's own `atlases` is private, so `AtlasManager & { atlases: ... }` collapses). */
type Manager = {
  atlases: { key: string; lazy: { state: number } | null; layer: number }[];
  table: Float32Array;
  rebuildTimings: { bodyPages: number; bodies: number } | undefined;
  vramStats: { bodyPages: number };
};

async function setup(localType?: "male" | "female"): Promise<{ am: Manager; r: AssetRegistry; maleSid: number; femaleSid: number }> {
  vi.stubGlobal("createImageBitmap", async (_src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
    await new Promise((r) => setTimeout(r, 2));
    return { width: opts?.resizeWidth ?? 128, height: opts?.resizeHeight ?? 128, close: () => {} };
  });
  setResizeSlicing(false);
  const r = reg();
  const { gl } = stubGl();
  // A transcoder must be installed for ktx2Target() to return non-null (ktx2.ts `enabled`
  // flag) — without it the body sheets fall back to resident and the pool never exists. The
  // stub never runs: the tail stays RGBA8 (no ktx2 twin on most sources), so pageInOwn takes
  // its PNG path.
  setKtx2Transcoder(async () => ({ width: 128, height: 128, levels: [], internalFormat: 0, target: "astc" as const }));
  // 1024 MB / 2048 px layers: the body pool needs one layer per body sheet (3 slots), so a
  // phone-tight budget would plan it down to a single slot and the eager step would evict
  // itself; the deferral logic under test is budget-independent.
  const am = new AtlasManager(gl, new AssetManager(), { textureBudgetMB: 1024, layerSize: 2048, imageLoader: defaultImageLoader }) as unknown as Manager;
  (am as unknown as { setCompressed(c: unknown): void }).setCompressed({ etc2: false, astc: true, s3tc: false, bptc: false });
  const sources = new Map([...r.atlases.values()].map((a) => [a.key, {
    url: `atlases/${a.key}.png`, emissiveUrl: null,
    ...(BODY_KEYS.includes(a.key) ? { ktx2: `atlases/${a.key}.ktx2` } : {}),
  }]));
  if (localType) await (am as unknown as AtlasManager).setLocalBodyType(localType);
  await (am as unknown as AtlasManager).setRegistry(r, sources as never);
  const maleSid = (r.cosmetics as unknown as { bodySprite(b: string): { sprite: number } }).bodySprite("male").sprite;
  const femaleSid = (r.cosmetics as unknown as { bodySprite(b: string): { sprite: number } }).bodySprite("female").sprite;
  return { am, r, maleSid, femaleSid };
}

const stateOf = (am: Manager, key: string): number => am.atlases.find((a) => a.key === key)?.lazy?.state ?? -1;
/** Frame-table row of a sprite's resolved idle frame: what the shader would actually sample. */
function frameRow(am: Manager, sid: number): Float32Array {
  const res = {} as { entry: number };
  const ai = (am as unknown as AtlasManager).animIndex(sid, "idle");
  (am as unknown as AtlasManager).resolve(sid, ai, 0, 0, 0, res as never);
  return am.table.subarray(res.entry * 8, res.entry * 8 + 8);
}
async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 16)); }
  return fn();
}

afterEach(() => { vi.unstubAllGlobals(); setResizeSlicing(true); setKtx2Transcoder(null); });

describe("ADR-553 local-player body pages only eager", () => {
  it("bodyPagesForBodyType splits the sexes; the block page is shared; union is bodyAtlasKeys", () => {
    const r = reg();
    expect([...bodyPagesForBodyType(r, "male")].sort()).toEqual(["body_male", "cz_block_body_0"]);
    expect([...bodyPagesForBodyType(r, "female")].sort()).toEqual(["body_female", "cz_block_body_0"]);
    const union = new Set([...bodyPagesForBodyType(r, "male"), ...bodyPagesForBodyType(r, "female")]);
    expect(union).toEqual(bodyAtlasKeys(r));
    expect(bodyAtlasKeys(r).size).toBe(3);
    expect(bodyPagesForBodyType(r, "other")).toEqual(new Set());
  });

  it("rebuild with local type male: only the male pages are state 2; bodyPages = 2", async () => {
    const { am } = await setup("male");
    expect(stateOf(am, "body_male")).toBe(2);
    expect(stateOf(am, "cz_block_body_0")).toBe(2);
    expect(stateOf(am, "body_female")).toBe(0);
    expect(am.rebuildTimings?.bodyPages).toBe(2);
    expect(am.vramStats.bodyPages).toBe(2);
    console.log(`[adr553] male eager: bodies ${am.rebuildTimings?.bodies.toFixed(1)}ms, bodyPages ${am.rebuildTimings?.bodyPages}`);
  }, 60000);

  it("rebuild with no local type (boot: no appearance yet): no body page is eager; bodyPages = 0", async () => {
    const { am } = await setup();
    for (const k of BODY_KEYS) expect(stateOf(am, k), k).toBe(0);
    expect(am.rebuildTimings?.bodyPages).toBe(0);
    expect(am.vramStats.bodyPages).toBe(0);
  }, 60000);

  it("setLocalBodyType after rebuild pages the local pages in (client: appearance known at the menu)", async () => {
    const { am } = await setup();
    await (am as unknown as AtlasManager).setLocalBodyType("female");
    expect(stateOf(am, "body_female")).toBe(2);
    expect(stateOf(am, "cz_block_body_0")).toBe(2);
    expect(stateOf(am, "body_male")).toBe(0);
  }, 60000);

  it("a deferred page pages in on first draw: pageReady prio 0 requests it, then it lands", async () => {
    const { am, femaleSid } = await setup();
    expect(stateOf(am, "body_female")).toBe(0);
    expect((am as unknown as AtlasManager).pageReady(femaleSid, 0)).toBe(false);
    expect(await waitFor(() => stateOf(am, "body_female") === 2)).toBe(true);
    expect((am as unknown as AtlasManager).pageReady(femaleSid, 0)).toBe(true);
  }, 60000);

  it("first frame shows a fully dressed local player: the male idle frame has real UVs + layer, the deferred female frame is a zeroed row", async () => {
    const { am, maleSid, femaleSid } = await setup("male");
    const male = frameRow(am, maleSid);
    expect(male[6]!).toBeGreaterThanOrEqual(0); // frame-table layer (pool layer, past the resident layers)
    expect(male[2]! - male[0]!).toBeGreaterThan(0); // UV span: a real rect, not the zeroed row
    expect(male[3]! - male[1]!).toBeGreaterThan(0);
    const female = frameRow(am, femaleSid);
    expect([...female]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // deferred page: nothing to sample yet
  }, 60000);

  it("first-view bodies page in during the drain even over the stream-pool cap (maxPages 1)", async () => {
    const { am, r, femaleSid } = await setup();
    // Two non-body lazy pages (wear pool) + the deferred female body page, body last in input
    // order so that without the ADR-553 exemption it is the one skipped by the cap.
    const wear = [...wearableOnlyAtlases(r)]
      .map((k) => am.atlases.find((a) => a.key === k))
      .filter((a): a is { key: string; lazy: { state: number } | null; layer: number } => !!a?.lazy && a.lazy.state === 0)
      .slice(0, 2);
    expect(wear).toHaveLength(2);
    const keys = [wear[0]!.key, wear[1]!.key, "body_female"];
    const firstView = new Set(keys);
    expect(stateOf(am, "body_female")).toBe(0);
    const t0 = Date.now();
    const w = await (am as unknown as AtlasManager).warmupFirstView(keys, { firstView, maxPages: 1, timeoutMs: 5000 });
    const drainMs = Date.now() - t0;
    // The body page bypasses the cap (requested alongside the first wear page); the second wear
    // page is still capped out.
    expect(w.requested).toBe(2);
    expect(w.skipped).toBe(1);
    expect(stateOf(am, "body_female")).toBe(2);
    expect(stateOf(am, wear[0]!.key)).toBe(2);
    expect(stateOf(am, wear[1]!.key)).toBe(0);
    const d = await (am as unknown as AtlasManager).warmupDrain(5000);
    expect(d.drained).toBe(true);
    // The drain also resolves the female sprite's own key, as the ADR-544 caller passes it.
    expect((am as unknown as AtlasManager).warmupKeysForSprites([femaleSid])).toEqual(["body_female"]);
    console.log(`[adr553] drain: warmup ${w.ms}ms + drain ${d.ms}ms (wall ${drainMs}ms) for 1 body + 1 wear page over a maxPages-1 cap`);
  }, 60000);
});
