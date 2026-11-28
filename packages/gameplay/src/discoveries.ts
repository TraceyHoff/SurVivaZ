/**
 * ADR-498: first-visit discoveries + the Guide journal.
 *
 * A discovery is recorded the first time a player receives a chunk (the TileSync hook in
 * packages/net/src/tiles.ts fires on a first Full send; the server wires it to
 * recordChunkDiscoveries). Each chunk yields at most one discovery per kind: a ruin (the planned
 * kind for the chunk), a lake (any lake-family tile: lake / great lake / pond), a river (any river
 * tile). Waterfalls are a follow-up, not v1 — there is no runtime waterfall lookup, and the scope
 * settles ruins/lakes/rivers first. Journal only in v1 (no discovery XP).
 *
 * Cost: the lake/river scan is 1,024 `waterFeatureAt` lookups per chunk, once per chunk per player,
 * at first-send time — never per tick, never per frame. The store is one entry per discovery,
 * capped at DISCOVERY_MAX (64, well above the Recent* cap of 8), most recent first, deduped by
 * (kind, chunk). Re-visits (a chunk re-sent after its cache entry was evicted) are deduped by the
 * store, so the journal only ever grows on a genuinely new chunk.
 *
 * The store lives on the player entity in the Discoveries component (networked + persistent, same
 * class as RecentCrafts), so the journal reads the owner's list on every peer and survives
 * save/reconnect; old saves simply lack the component = an empty journal.
 */
import { entityIndex, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, REGION_HALF, REGION_SIZE, waterFeatureAt, type WaterFeatureLayout } from "@engine/world";
import { DISCOVERY_MAX, Discoveries } from "./components.js";
import { ABANDONED_KIND_KEYS, planAbandonedChunk, settlementSiteInChunk } from "./building/abandoned.js";
import { layoutForRegion } from "./river_current.js";

/** Discovery kinds: 1 = a lake, 2 = a river, 3 + AbandonedKindId = a ruin of that kind. */
export const DiscoveryKind = { Lake: 1, River: 2, RuinBase: 3 } as const;
export interface Discovery { kind: number; cx: number; cy: number }

/** The journal label for a discovery kind ("Chapel ruins", "Fisher hut ruins", "A lake", "A river"). */
export function discoveryLabel(kind: number): string {
  if (kind === DiscoveryKind.Lake) return "A lake";
  if (kind === DiscoveryKind.River) return "A river";
  const key = ABANDONED_KIND_KEYS[kind - DiscoveryKind.RuinBase];
  if (!key) return "Ruins";
  return `${key.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")} ruins`;
}

/** The chunk's discoveries: a ruin (planned kind), a lake, a river — each at most one per chunk. */
export function chunkDiscoveries(world: World, cx: number, cy: number): Discovery[] {
  const out: Discovery[] = [];
  const plan = planAbandonedChunk(world.seed, cx, cy);
  if (plan) out.push({ kind: DiscoveryKind.RuinBase + plan.kind, cx, cy });
  else { const k = settlementSiteInChunk(world, cx, cy); if (k !== undefined) out.push({ kind: DiscoveryKind.RuinBase + k, cx, cy }); } // ADR-595
  // Lake/river: scan the chunk's tiles against the region layout (1,024 lookups, once per chunk per
  // player, at first-send time). A chunk can straddle a region boundary (1 in 48), so the region
  // is resolved per tile and cached while it stays the same.
  let lake = false, river = false;
  let cur: { rx: number; ry: number; layout: WaterFeatureLayout; seed: number } | undefined;
  for (let ty = cy * CHUNK_SIZE; ty < (cy + 1) * CHUNK_SIZE && !(lake && river); ty++) {
    for (let tx = cx * CHUNK_SIZE; tx < (cx + 1) * CHUNK_SIZE && !(lake && river); tx++) {
      const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
      if (!cur || cur.rx !== rx || cur.ry !== ry) { const r = layoutForRegion(world, rx, ry); cur = { rx, ry, layout: r.layout, seed: r.seed }; }
      const lx = rx === 0 && ry === 0 ? tx : tx - rx * REGION_SIZE;
      const ly = rx === 0 && ry === 0 ? ty : ty - ry * REGION_SIZE;
      const f = waterFeatureAt(cur.seed, lx, ly, cur.layout);
      if (f === "lake" || f === "greatLake" || f === "pond") lake = true;
      else if (f === "river") river = true;
    }
  }
  if (lake) out.push({ kind: DiscoveryKind.Lake, cx, cy });
  if (river) out.push({ kind: DiscoveryKind.River, cx, cy });
  return out;
}

/**
 * Record a chunk's discoveries for a player (the TileSync first-receipt hook's target). Returns
 * the newly recorded discoveries (empty when the chunk holds nothing new — a re-visit, or a chunk
 * with no ruin, lake or river). Most recent first; the oldest fall off past DISCOVERY_MAX.
 */
export function recordChunkDiscoveries(world: World, e: Entity, cx: number, cy: number): Discovery[] {
  if (!world.isRegistered(Discoveries)) return [];
  const found = chunkDiscoveries(world, cx, cy);
  if (!found.length) return [];
  if (!world.has(e, Discoveries)) world.add(e, Discoveries, {});
  const st = world.store(Discoveries); const s = st.slot(entityIndex(e)); if (s < 0) return [];
  const data = st.data as unknown as Record<string, number[]>;
  const kinds = data.kind!, cxs = data.cx!, cys = data.cy!;
  const n = data.count![s]!;
  const have = new Set<string>();
  for (let i = 0; i < n; i++) have.add(`${kinds[s * DISCOVERY_MAX + i]}:${cxs[s * DISCOVERY_MAX + i]}:${cys[s * DISCOVERY_MAX + i]}`);
  const list: Discovery[] = [];
  for (const d of found) { const k = `${d.kind}:${d.cx}:${d.cy}`; if (!have.has(k)) { list.push(d); have.add(k); } }
  if (!list.length) return [];
  const all: Discovery[] = [...list];
  for (let i = 0; i < n && all.length < DISCOVERY_MAX; i++) all.push({ kind: kinds[s * DISCOVERY_MAX + i]!, cx: cxs[s * DISCOVERY_MAX + i]!, cy: cys[s * DISCOVERY_MAX + i]! });
  for (let i = 0; i < DISCOVERY_MAX; i++) {
    kinds[s * DISCOVERY_MAX + i] = all[i]?.kind ?? 0;
    cxs[s * DISCOVERY_MAX + i] = all[i]?.cx ?? 0;
    cys[s * DISCOVERY_MAX + i] = all[i]?.cy ?? 0;
  }
  data.count![s] = all.length;
  st.markChanged(entityIndex(e));
  return list;
}

/** A player's discoveries, most recent first (or [] when none / no component). */
export function discoveriesOf(world: World, e: Entity): Discovery[] {
  const c = world.get(e, Discoveries); if (!c) return [];
  const out: Discovery[] = [];
  for (let i = 0; i < Math.min(c.count, DISCOVERY_MAX); i++) out.push({ kind: c.kind[i]!, cx: c.cx[i]!, cy: c.cy[i]! });
  return out;
}
