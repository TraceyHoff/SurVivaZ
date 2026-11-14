// ADR-391: the build recompresses every shipped PNG with the pinned oxipng (-o 2), cached by file hash.
// Lossless: decoded RGBA (fully transparent texels' RGB included) and ancillary chunks are unchanged.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOxipng, optimizeDistPngs, OXIPNG_TAG, OXIPNG_VERSION } from "../../../scripts/oxipng.mjs";
import { decodeRgba, encodeRgba } from "./png-rgba.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
const TOOLS = join(ROOT, ".cache/oxipng/tools");
// no network in unit tests: only run when the pinned binary is already present (CI restores it with the cache)
const have = (existsSync(join(TOOLS, `oxipng-${OXIPNG_VERSION}-x86_64-unknown-linux-musl/oxipng`)) || !!process.env["OXIPNG_BIN"]) && ensureOxipng(TOOLS) !== undefined;

function sample(w: number, h: number, seed: number): Uint8Array {
  const px = new Uint8Array(w * h * 4); let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) >>> 0; const k = (s >>> 16) % 5; // few colours -> oxipng picks a palette
    px.set(k === 0 ? [0, 0, 0, 0] : k === 1 ? [200, 30, 40, 0] /* transparent with RGB: must survive */ : k === 2 ? [10, 120, 250, 128] : k === 3 ? [255, 255, 255, 255] : [40, 200, 90, 255], i * 4);
  }
  return px;
}

describe("ADR-391 oxipng dist pass", () => {
  it("mode off leaves files untouched", () => {
    const d = mkdtempSync(join(tmpdir(), "oxi-")); const png = encodeRgba(8, 8, sample(8, 8, 1)); writeFileSync(join(d, "a.png"), png);
    const r = optimizeDistPngs(d, { cacheDir: join(d, ".c/png"), toolDir: TOOLS, mode: "off", log: () => {} });
    expect(r.files).toBe(0); expect(readFileSync(join(d, "a.png")).equals(png)).toBe(true); rmSync(d, { recursive: true, force: true });
  });
  it.skipIf(!have)("shrinks PNGs losslessly and reuses the hash cache", () => {
    const d = mkdtempSync(join(tmpdir(), "oxi-")); const dist = join(d, "dist"); mkdirSync(join(dist, "art/x"), { recursive: true });
    const a = sample(64, 48, 7), b = sample(33, 17, 9); const pa = encodeRgba(64, 48, a), pb = encodeRgba(33, 17, b);
    writeFileSync(join(dist, "art/x/a.png"), pa); writeFileSync(join(dist, "art/x/a_copy.png"), pa); writeFileSync(join(dist, "b.png"), pb);
    const cacheDir = join(d, "cache/png"); const log = (): void => {};
    const r1 = optimizeDistPngs(dist, { cacheDir, toolDir: TOOLS, mode: "required", log });
    expect(r1.files).toBe(3); expect(r1.misses).toBe(2); expect(r1.after).toBeLessThan(r1.before);
    for (const [f, w, h, px] of [["art/x/a.png", 64, 48, a], ["art/x/a_copy.png", 64, 48, a], ["b.png", 33, 17, b]] as const) {
      const got = decodeRgba(readFileSync(join(dist, f))); expect([got.w, got.h]).toEqual([w, h]); expect(Buffer.from(got.rgba).equals(Buffer.from(px))).toBe(true);
    }
    expect(readdirSync(cacheDir).length).toBe(2);
    // second build (Vite empties outDir, so the dist holds fresh source copies): cache hits, nothing is re-run,
    // the unused entry is pruned
    writeFileSync(join(dist, "art/x/a.png"), pa); writeFileSync(join(dist, "art/x/a_copy.png"), pa); rmSync(join(dist, "b.png"));
    const r2 = optimizeDistPngs(dist, { cacheDir, toolDir: TOOLS, mode: "required", log });
    expect(r2.misses).toBe(0); expect(r2.hits).toBe(2); expect(readdirSync(cacheDir).length).toBe(1);
    expect(JSON.parse(readFileSync(join(d, "cache", `${OXIPNG_TAG}.last.json`), "utf8")).files).toBe(2);
    rmSync(d, { recursive: true, force: true });
  });
});
