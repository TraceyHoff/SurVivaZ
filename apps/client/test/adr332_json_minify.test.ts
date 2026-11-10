// ADR-332: JSON shipped into dist/art is minified at copy time (parse + compact JSON.stringify).
// Parsed output must equal parsed source for every served JSON; source files stay pretty-printed.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artServed, copyArtFile } from "../vite.config.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
// Mount prefix -> source dir (same pairs as vite.config MOUNTS, minus ui/ which this sparse checkout lacks).
const MOUNT_DIRS: [string, string][] = [
  ["pack/", join(ROOT, "packages/assets/pack")],
  ["survival_fx/", join(ROOT, "assets/survival_fx")],
  ["pvp_clan/", join(ROOT, "assets/pvp_clan")],
  ["stalls/", join(ROOT, "assets/stalls")],
];

function walkJson(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n), r = rel + n;
    return statSync(p).isDirectory() ? walkJson(p, r + "/") : n.endsWith(".json") ? [r] : [];
  });
}

/** Recursive `===` equality for parsed JSON: unlike vitest's toEqual it treats -0 and 0 as equal, which
 *  is what the minifier guarantees — JSON.stringify(-0) is "0", and -0 === 0 for every consumer. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ka = Object.keys(ao), kb = Object.keys(bo);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

describe("ADR-332 shipped JSON is minified at build/copy time", () => {
  it("copyArtFile compacts JSON: parsed output equals parsed source, no whitespace, smaller file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adr332-"));
    try {
      const src = join(ROOT, "packages/assets/pack/manifest.json");
      const dst = join(tmp, "manifest.json");
      copyArtFile(src, dst);
      const before = readFileSync(src, "utf8"), after = readFileSync(dst, "utf8");
      expect(jsonEqual(JSON.parse(after), JSON.parse(before))).toBe(true);
      expect(after).not.toContain("\n");
      expect(after.length).toBeLessThan(before.length);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("copyArtFile copies non-JSON files byte-identical", () => {
    const src = join(ROOT, "packages/assets/pack/atlases/adr134_hurt.png");
    expect(existsSync(src)).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), "adr332-"));
    try {
      const dst = join(tmp, "adr134_hurt.png");
      copyArtFile(src, dst);
      expect(readFileSync(dst)).toEqual(readFileSync(src));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("every JSON served by the art mounts minifies to the same parsed value", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adr332-"));
    try {
      const served: [string, string][] = [];
      for (const [prefix, dir] of MOUNT_DIRS)
        for (const rel of walkJson(dir)) if (artServed(prefix + rel)) served.push([join(dir, rel), prefix + rel]);
      expect(served.length).toBeGreaterThan(50);
      let saved = 0;
      for (const [src, url] of served) {
        const dst = join(tmp, url.replaceAll("/", "_"));
        copyArtFile(src, dst);
        const before = readFileSync(src, "utf8"), after = readFileSync(dst, "utf8");
        expect(jsonEqual(JSON.parse(after), JSON.parse(before)), url).toBe(true);
        expect(after, url).not.toContain("\n");
        saved += before.length - after.length;
      }
      expect(saved).toBeGreaterThan(10_000_000);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
