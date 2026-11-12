import { describe, expect, it } from "vitest";
import {
  WARMUP_MAX_PAGES, WARMUP_PRIO, WARMUP_WINDOW_MS, isWarmupCandidate, sortWarmupKeys,
  warmupAtlasTier, warmupPageBudget, type WarmupResult,
} from "../src/assets/warmup.js";
import { collectPrefetchUrls, collectWarmupPrefetchUrls } from "../src/assets/asset-fetch.js";
import { AtlasManager, COLD_ATLAS_RE, HOT_ATLAS_RE, VISIBLE_PIN_RE } from "../src/assets/atlasManager.js";

/** Tier derived independently from the AtlasManager's own regexes (same rule, second implementation). */
const tierFromAtlasManager = (k: string): number => {
  if (!k) return 4;
  if (VISIBLE_PIN_RE.test(k)) return 1;
  if (/^cz_ride_/.test(k) || COLD_ATLAS_RE.test(k)) return 4;
  if (HOT_ATLAS_RE.test(k)) return 2;
  return 3;
};

describe("ADR-370 warm-up ordering (pure)", () => {
  it("tiers first-view, then visible-pin, then hot, then other, then cold/ride last", () => {
    expect(warmupAtlasTier("gt_grass")).toBe(1);
    expect(warmupAtlasTier("furniture_chair")).toBe(1);
    expect(warmupAtlasTier("buildings_cabin")).toBe(1);
    expect(warmupAtlasTier("building_wall")).toBe(1);
    expect(warmupAtlasTier("openings_door")).toBe(1);
    expect(warmupAtlasTier("defenses_spikes")).toBe(1);
    expect(warmupAtlasTier("characters")).toBe(2);
    expect(warmupAtlasTier("body_male")).toBe(2);
    expect(warmupAtlasTier("animals_wolf")).toBe(2);
    expect(warmupAtlasTier("tiles_grass")).toBe(2);
    expect(warmupAtlasTier("crops")).toBe(3);
    expect(warmupAtlasTier("veh_cart")).toBe(3);
    expect(warmupAtlasTier("hair_long")).toBe(4);
    expect(warmupAtlasTier("tops_tee")).toBe(4);
    expect(warmupAtlasTier("cz_ride_0_0")).toBe(4);
    expect(warmupAtlasTier("fx_snowflake")).toBe(4);
    expect(warmupAtlasTier("death_bag")).toBe(4);
    expect(warmupAtlasTier("")).toBe(4);
    // First-view beats everything, visible-pin beats cold.
    expect(warmupAtlasTier("crops", new Set(["crops"]))).toBe(0);
    expect(warmupAtlasTier("hair_long", new Set(["hair_long"]))).toBe(0);
    expect(warmupAtlasTier("furniture_far")).toBe(1);
    // Building tiers are visible-pin by key: they join the warm-up set (blurry-wall complaint).
    expect(warmupAtlasTier("building_t2")).toBe(1);
  });

  it("agrees with the AtlasManager's tier regexes on a representative key list", () => {
    const keys = ["gt_grass", "furniture_chair", "buildings_cabin", "building_wall", "building_t2",
      "openings_door", "defenses_spikes", "characters", "body_male", "animals_wolf", "tiles_grass",
      "ui_icons", "sdf_text", "crops", "veh_cart", "nature_crops", "hair_long", "tops_tee",
      "cz_ride_0_0", "fx_snowflake", "death_bag", "furniture_far", ""];
    for (const k of keys) expect(warmupAtlasTier(k), k).toBe(tierFromAtlasManager(k));
  });

  it("isWarmupCandidate is tiers 0-1 only", () => {
    expect(isWarmupCandidate("furniture_chair")).toBe(true);
    expect(isWarmupCandidate("crops", new Set(["crops"]))).toBe(true);
    expect(isWarmupCandidate("characters")).toBe(false);
    expect(isWarmupCandidate("crops")).toBe(false);
    expect(isWarmupCandidate("hair_long")).toBe(false);
  });

  it("sortWarmupKeys is a stable tier sort and honours the first-view set", () => {
    const keys = ["crops", "furniture_chair", "characters", "hair_long", "gt_grass", "body_male"];
    expect(sortWarmupKeys(keys)).toEqual(["furniture_chair", "gt_grass", "characters", "body_male", "crops", "hair_long"]);
    expect(sortWarmupKeys(keys, new Set(["crops"]))).toEqual(["crops", "furniture_chair", "gt_grass", "characters", "body_male", "hair_long"]);
    expect(sortWarmupKeys([])).toEqual([]);
  });

  it("warmupPageBudget clamps to the pool and never goes negative", () => {
    expect(warmupPageBudget()).toBe(WARMUP_MAX_PAGES);
    expect(warmupPageBudget(24)).toBe(24);
    expect(warmupPageBudget(12)).toBe(12);
    expect(warmupPageBudget(0)).toBe(0);
    expect(warmupPageBudget(100, 10)).toBe(10);
    expect(warmupPageBudget(8, -4)).toBe(0);
  });

  it("constants: near-player priority, bounded window", () => {
    expect(WARMUP_PRIO).toBe(1); // <= PRIO_NEAR (16) so it is budget-exempt like near art, != 0 so it still queues behind the local player and through the 2-uploads/frame turn
    expect(WARMUP_MAX_PAGES).toBe(24);
    expect(WARMUP_WINDOW_MS).toBe(1500);
  });
});

describe("ADR-370 warm-up prefetch (ADR-307 extension)", () => {
  const manifest = {
    atlases: [
      { key: "furniture_chair", image: "atlases/furniture_chair.png", residency: "stream" },
      { key: "buildings_cabin", image: "atlases/buildings_cabin.png", residency: "stream", emissiveImage: "atlases/buildings_cabin_e.png" },
      { key: "building_t2", image: "atlases/building_t2.png", residency: "stream" },
      { key: "characters", image: "atlases/characters.png" },
      { key: "gt_grass", image: "atlases/gt_grass.png", residency: "stream" },
      { key: "hair_long", image: "atlases/hair_long.png", residency: "stream" },
      { key: "cz_ride_0_0", image: "atlases/cz_ride_0_0.png", residency: "stream" },
      { key: "crops", image: "atlases/crops.png", residency: "stream" },
      { key: "veh_cart", image: "atlases/veh_cart.png", residency: "stream" },
    ],
  };
  const base = "https://game.example/art/pack/manifest.json";

  it("warms visible-pin stream sheets (incl. building tiers + emissive), nothing else", () => {
    expect(collectWarmupPrefetchUrls(manifest, base)).toEqual([
      "https://game.example/art/pack/atlases/furniture_chair.png",
      "https://game.example/art/pack/atlases/buildings_cabin.png",
      "https://game.example/art/pack/atlases/buildings_cabin_e.png",
      "https://game.example/art/pack/atlases/building_t2.png",
    ]);
  });

  it("is disjoint from the resident prefetch set (no double download)", () => {
    const resident = collectPrefetchUrls(manifest, base);
    const warm = collectWarmupPrefetchUrls(manifest, base);
    expect(resident).toEqual([
      "https://game.example/art/pack/atlases/characters.png",
      "https://game.example/art/pack/atlases/gt_grass.png",
    ]);
    expect(warm.filter((u) => resident.includes(u))).toEqual([]);
  });

  it("returns [] for a manifest without atlases", () => {
    expect(collectWarmupPrefetchUrls({}, base)).toEqual([]);
    expect(collectWarmupPrefetchUrls({ atlases: "nope" }, base)).toEqual([]);
  });
});

describe("ADR-370 AtlasManager warm-up window (stubbed manager, no GL)", () => {
  function fakeManager(states: Record<string, number | null>, requestImpl: (a: { key: string; lazy: { state: number } | null }) => void) {
    const am = Object.create(AtlasManager.prototype) as unknown as {
      atlases: { key: string; lazy: { state: number } | null }[];
      gen: number; queue: unknown[]; inflight: number; request(a: unknown, prio: number): void;
      warmupFirstView(keys: Iterable<string>, opts?: { maxPages?: number; timeoutMs?: number }): Promise<WarmupResult>;
      warmupDrain(timeoutMs?: number): Promise<{ pending: number; ms: number; drained: boolean }>;
      warmupKeysForSprites(ids: Iterable<number>): string[];
      pageKey(id: number): string | null;
      lastPrio: number; requestedKeys: string[];
    };
    am.atlases = Object.entries(states).map(([key, state]) => ({ key, lazy: state === null ? null : { state } }));
    am.gen = 0; am.queue = []; am.inflight = 0; am.requestedKeys = [];
    am.request = (a: { key: string; lazy: { state: number } | null }, prio: number) => { am.lastPrio = prio; am.requestedKeys.push(a.key); requestImpl(a); };
    return am;
  }

  it("requests first-view/visible-pin pages at WARMUP_PRIO, in tier order, and reports residency", async () => {
    const am = fakeManager(
      { furniture_chair: 0, buildings_cabin: 0, characters: 0, gt_grass: null },
      (a) => { if (a.lazy) a.lazy.state = 2; },
    );
    const r = await am.warmupFirstView(["characters", "furniture_chair", "buildings_cabin", "furniture_missing", "gt_grass"]);
    expect(am.requestedKeys).toEqual(["furniture_chair", "buildings_cabin"]); // tier order (stable within a tier); characters is tier 2 (not a candidate), gt_grass is already resident (no lazy page)
    expect(am.lastPrio).toBe(WARMUP_PRIO);
    expect(r.requested).toBe(2);
    expect(r.alreadyResident).toBe(1); // gt_grass
    expect(r.resident).toBe(3);
    expect(r.stillPending).toBe(0);
    expect(r.skipped).toBe(1); // furniture_missing: candidate key with no atlas
    expect(r.timedOut).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("honours the page budget (over-cap candidates are skipped, not requested)", async () => {
    const am = fakeManager(
      { furniture_chair: 0, buildings_cabin: 0 },
      (a) => { if (a.lazy) a.lazy.state = 2; },
    );
    const r = await am.warmupFirstView(["furniture_chair", "buildings_cabin"], { maxPages: 1 });
    expect(r.requested).toBe(1);
    expect(r.skipped).toBe(1);
    expect(am.requestedKeys).toEqual(["furniture_chair"]);
  });

  it("times out (bounded) when pages never land, and reports the pending count", async () => {
    const am = fakeManager({ furniture_chair: 0, buildings_cabin: 0 }, () => { /* never lands */ });
    const r = await am.warmupFirstView(["furniture_chair", "buildings_cabin"], { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.stillPending).toBe(2);
    expect(r.resident).toBe(0);
  });

  it("warmupDrain waits for the queue to empty, and times out boundedly", async () => {
    const am = fakeManager({}, () => {});
    am.queue = [{}]; am.inflight = 1;
    setTimeout(() => { am.queue = []; am.inflight = 0; }, 10);
    const drained = await am.warmupDrain(500);
    expect(drained.drained).toBe(true);
    expect(drained.pending).toBe(0);
    am.queue = [{}]; am.inflight = 1;
    const stuck = await am.warmupDrain(20);
    expect(stuck.drained).toBe(false);
    expect(stuck.pending).toBe(2);
  });

  it("warmupKeysForSprites dedupes page keys in first-seen order", () => {
    const am = fakeManager({}, () => {});
    am.pageKey = (id: number) => (id === 1 || id === 2 ? "furniture_chair" : id === 3 ? null : "buildings_cabin");
    expect(am.warmupKeysForSprites([1, 2, 3, 4])).toEqual(["furniture_chair", "buildings_cabin"]);
  });
});
