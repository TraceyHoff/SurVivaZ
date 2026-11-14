// ADR-405: Canvas2DRenderer's decoded-image cache was unbounded (every atlas ever touched stayed decoded
// for the session). It is now an LRU capped at CANVAS2D_IMAGES_MAX loaded images; in-flight loads are
// never evicted, and a hit refreshes recency.
import { describe, expect, it } from "vitest";
import { Canvas2DRenderer, CANVAS2D_IMAGES_MAX } from "../src/canvas2d.js";
import type { AtlasSource } from "../src/assets/atlasManager.js";

const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const fakeImage = (url: string): unknown => ({ url });

describe("ADR-405 Canvas2D images LRU", () => {
  const make = async (keys: string[]): Promise<{ r: Canvas2DRenderer; loaded: (key: string) => boolean }> => {
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, {} as unknown as CanvasRenderingContext2D);
    r.loadImage = async (url: string) => fakeImage(url) as never;
    const sources = new Map<string, AtlasSource>(keys.map((k) => [k, { url: `atlases/${k}.png` } as unknown as AtlasSource]));
    await r.atlas.setRegistry({} as never, sources);
    return { r, loaded: (key: string) => r.image(key) !== null };
  };
  const diag = (r: Canvas2DRenderer): string => r.diagReport();

  it(`holds at most ${CANVAS2D_IMAGES_MAX} loaded images and evicts the oldest first`, async () => {
    const keys = Array.from({ length: CANVAS2D_IMAGES_MAX + 44 }, (_, i) => `k${i}`);
    const { r, loaded } = await make(keys);
    for (const k of keys) r.image(k);
    await tick();
    expect(diag(r)).toMatch(new RegExp(`images ${CANVAS2D_IMAGES_MAX}\\/${CANVAS2D_IMAGES_MAX}`));
    expect(loaded("k0")).toBe(false); // oldest evicted
    expect(loaded("k43")).toBe(false);
    expect(loaded("k44")).toBe(true); // first survivor
    expect(loaded(`k${keys.length - 1}`)).toBe(true); // newest survives
  });

  it("a hit refreshes recency: a recently used image survives the next evictions", async () => {
    const keys = Array.from({ length: CANVAS2D_IMAGES_MAX + 4 }, (_, i) => `k${i}`);
    const extra = Array.from({ length: 10 }, (_, i) => `x${i}`);
    const { r, loaded } = await make([...keys, ...extra]); // sources include the extra keys up front
    for (const k of keys) r.image(k);
    await tick();
    expect(loaded("k4")).toBe(true); // first survivor after the first 4 evictions
    expect(loaded("k4")).toBe(true); // touch it again: refreshes recency
    for (const k of extra) r.image(k);
    await tick();
    expect(loaded("k4")).toBe(true); // touched recently: survives while older untouched keys evict
    expect(loaded("k5")).toBe(false); // untouched and older than the refresh: evicted
  });

  it("in-flight (null) placeholders are never evicted, even past the cap", async () => {
    const keys = Array.from({ length: CANVAS2D_IMAGES_MAX + 44 }, (_, i) => `k${i}`);
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, {} as unknown as CanvasRenderingContext2D);
    const resolvers: Array<() => void> = [];
    r.loadImage = (url: string) => new Promise<HTMLImageElement | ImageBitmap>((res) => { resolvers.push(() => res(fakeImage(url) as never)); });
    const sources = new Map<string, AtlasSource>(keys.map((k) => [k, { url: `atlases/${k}.png` } as unknown as AtlasSource]));
    await r.atlas.setRegistry({} as never, sources);
    for (const k of keys) r.image(k);
    await tick();
    expect(diag(r)).toMatch(new RegExp(`images 0\\/${keys.length}`)); // nothing loaded yet, nothing evicted
    for (const resolve of resolvers) resolve();
    await tick();
    expect(diag(r)).toMatch(new RegExp(`images ${CANVAS2D_IMAGES_MAX}\\/${CANVAS2D_IMAGES_MAX}`));
  });
});
