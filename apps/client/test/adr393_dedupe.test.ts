// ADR-393: no art ships twice. Byte-identical customization tint masks share one file (manifest paths point
// at the canonical copy; colour pages stay unique), and CSS / TS pack art is fetched from the shipped
// art/ copy instead of a second Vite-bundled copy in assets/.
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { artCodeRoots, artFile, artMounts, rewritePackCssUrls } from "../vite.config.js";
import { planArt, TINT_ALIAS_RE, type ArtPlan } from "../art-build.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
let plan: ArtPlan;
beforeAll(async () => { plan = await planArt(artMounts(), { codeRoots: artCodeRoots(), brandingBg: "parallax" }); }, 120_000);
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

describe("ADR-393 tint mask aliases", () => {
  it("aliases only byte-identical customization tint masks, onto a shipped canonical in the same directory", () => {
    expect(plan.aliases.size).toBeGreaterThan(0);
    const shipped = new Set(plan.files.map((f) => f.url));
    for (const [dup, canon] of plan.aliases) {
      expect(dup).toMatch(TINT_ALIAS_RE); expect(canon).toMatch(TINT_ALIAS_RE);
      expect(dup.replace(/[^/]*$/, "")).toBe(canon.replace(/[^/]*$/, ""));
      expect(sha(artFile(dup)!)).toBe(sha(artFile(canon)!));
      expect(shipped.has(dup)).toBe(false); expect(shipped.has(canon)).toBe(true);
    }
  });
  it("no shipped manifest names a dropped duplicate; colour pages are never aliased", () => {
    const dups = new Set([...plan.aliases.keys()].map((u) => u.replace(/^.*\//, "")));
    for (const f of plan.files) if (f.json !== undefined) { const t = JSON.stringify(f.json); for (const d of dups) expect(t.includes(d), `${f.url} names ${d}`).toBe(false); }
    for (const u of plan.aliases.keys()) expect(u).toMatch(/\.tintmask(@2x)?\.(png|ktx2)$/);
  });
});

describe("ADR-393 runtime art urls", () => {
  const css = join(ROOT, "apps/client/src/gameplay-panels.css"); const src = readFileSync(css, "utf8");
  it("CSS pack urls above the inline limit go to <base>art/pack/, small ones stay for Vite to inline", () => {
    const out = rewritePackCssUrls(src, css, "/SurVivaZ/");
    const urls = [...src.matchAll(/url\("((?:\.\.\/)+packages\/assets\/pack\/([^"]+))"\)/g)];
    expect(urls.length).toBeGreaterThan(0);
    const shipped = new Set(plan.files.map((f) => f.url));
    for (const [, path, rel] of urls) {
      const big = statSync(join(ROOT, "apps/client/src", path!)).size > 4096;
      expect(out.includes(`url("/SurVivaZ/art/pack/${rel}")`), rel).toBe(big);
      if (big) expect(shipped.has(`pack/${rel}`), `pack/${rel} ships`).toBe(true);
    }
    expect(out.includes("ui/kit/css")).toBe(src.includes("ui/kit/css")); // kit frames stay Vite-bundled
  });
  it("the tutorial glyph atlas loads from the shipped art/ui copy", () => {
    const t = readFileSync(join(ROOT, "apps/client/src/tutorial/overlay.ts"), "utf8");
    expect(t).toContain("art/ui/input/atlas/input_glyphs.png"); expect(t).not.toMatch(/new URL\([^)]*input_glyphs\.png/);
    expect(plan.files.some((f) => f.url === "ui/input/atlas/input_glyphs.png") || !artFile("ui/input/atlas/input_glyphs.png")).toBe(true);
  });
});
