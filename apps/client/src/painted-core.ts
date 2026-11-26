/**
 * ADR-551: one-group painted orchestration — cache-first paint + parallel
 * encode/store. This is a LEAF module by design: it imports only
 * `painted-cache.ts` (itself a leaf) and types. It deliberately imports
 * NOTHING from any art module, so the art modules can delegate their
 * `*AtlasSources` to it without closing an import cycle: the group def
 * carries its own `paint` function (the module's own painter), so this file
 * never needs to resolve a group name to a painter. (The name -> painter
 * registry for the Worker lives in `painted-groups.ts`, which the art
 * modules never import. An earlier draft put this orchestrator in a module
 * that imported the art modules, and the cycle broke module evaluation —
 * `task256-art.ts`'s top-level spec const reads `Px` from `task34-art.ts`
 * before that module has initialised when entry is via an art module.
 * Do not reintroduce an art-module import here.)
 */
import type { AtlasSource } from "@engine/render";
import {
  encodePaintedBlob, hashPaintedSpec, lookupPaintedBlobURL, paintedObjectURL, storePaintedBlob,
  type PaintedAtlasInput, type PaintedCacheEnv,
} from "./painted-cache.js";

/** One painter group: its ADR-550 spec map + how its variant URLs become sources. */
export interface PaintedGroupDef {
  name: string;
  /** Content-hash inputs per variant key (the ADR-550 spec strings). */
  specs: () => Map<string, string>;
  /** Paint the group's variants (pure: no DOM, no cache, no encode). */
  paint: () => PaintedAtlasInput[];
  /** Variants sharing a group live/die together (task410: `k` + `k@2x`). Default: identity. */
  groupOf?: (variantKey: string) => string;
  /** Build the group's `AtlasSource` map from the variant URLs (hits + fresh). */
  assemble: (specKeys: readonly string[], urls: ReadonlyMap<string, { url: string; bytes: number }>) => Map<string, AtlasSource>;
}

/** Default assembly: one source per variant key, `{ url, emissiveUrl: null }`. */
export const defaultAssemble: PaintedGroupDef["assemble"] = (specKeys, urls) => {
  const out = new Map<string, AtlasSource>();
  for (const key of specKeys) {
    const hit = urls.get(key);
    if (hit) out.set(key, { url: hit.url, emissiveUrl: null });
  }
  return out;
};

/** A pool of paint Workers: `paint(group)` paints one group off the main thread. */
export interface PaintWorkerPool {
  readonly size: number;
  paint(group: string): Promise<PaintedAtlasInput[]>;
  terminate(): void;
}

/**
 * Paint one group, cache-first: batch-lookup every variant in parallel; all hit
 * → return without painting; any miss → paint the group (worker pool, else the
 * main thread via `def.paint`), encode + store the missed variants in parallel,
 * assemble. Never throws for a worker failure — that path falls back to
 * main-thread paint.
 */
export async function paintPaintedGroup(
  def: PaintedGroupDef,
  env: PaintedCacheEnv = {},
  pool?: PaintWorkerPool | undefined,
): Promise<Map<string, AtlasSource>> {
  const specs = def.specs();
  const specKeys = [...specs.keys()];
  // (1) Cache lookup first, per variant, in parallel — a hit skips paint (ADR-550).
  const looked = await Promise.all(specKeys.map(async (key) => {
    const hit = await lookupPaintedBlobURL(key, hashPaintedSpec(specs.get(key) ?? key), env);
    return { key, hit };
  }));
  const urls = new Map<string, { url: string; bytes: number }>();
  const missed: string[] = [];
  for (const { key, hit } of looked) {
    if (hit) urls.set(key, hit);
    else missed.push(key);
  }
  if (missed.length === 0) return def.assemble(specKeys, urls);
  // (2) Paint the misses in a worker; any worker failure → main-thread paint.
  let variants: PaintedAtlasInput[];
  try {
    variants = pool ? await pool.paint(def.name) : def.paint();
  } catch {
    variants = def.paint();
  }
  const byKey = new Map(variants.map((v) => [v.key, v] as const));
  // (3) Encode the missed variants in parallel, then store only the survivors.
  const encode = env.encode ?? encodePaintedBlob;
  const groupOf = def.groupOf ?? ((k: string): string => k);
  const encoded = await Promise.all(missed.map(async (key) => {
    const v = byKey.get(key);
    const blob = v ? await encode(v.width, v.height, v.pixels) : undefined;
    return { key, blob };
  }));
  const blobByKey = new Map<string, Blob>();
  for (const { key, blob } of encoded) if (blob) blobByKey.set(key, blob);
  const missedByGroup = new Map<string, string[]>();
  for (const key of missed) {
    const g = groupOf(key);
    const list = missedByGroup.get(g);
    if (list) list.push(key);
    else missedByGroup.set(g, [key]);
  }
  await Promise.all([...missedByGroup.entries()].map(async ([g, keys]) => {
    // The group's main variant must exist — cache hit or fresh encode — or the
    // whole atlas is dropped (never store a @2x without its 1x).
    if (!urls.has(g) && !blobByKey.has(g)) return;
    await Promise.all(keys.map(async (key) => {
      const blob = blobByKey.get(key);
      if (!blob) return;
      await storePaintedBlob(key, hashPaintedSpec(specs.get(key) ?? key), blob, env);
      urls.set(key, { url: paintedObjectURL(blob, env), bytes: blob.size });
    }));
  }));
  return def.assemble(specKeys, urls);
}
