// ADR-395: checks a *built* dist (CI and Pages run it after `vite build` with SURVIVAZ_DIST set; skipped
// otherwise). Replays the client's boot over the shipped files (decoding the .json.gz manifests with both
// zlib and the ADR-394 inflate fallback) and pins: the shipped art set is exactly the plan, every resolved
// file is there, resolved sources equal the plan's, and every non-PNG file is byte-identical to its source
// (PNGs: decode identity is ADR-391's job).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync as zlibGunzip } from "node:zlib";
import { artCodeRoots, artFile, artMounts, BRANDING } from "../vite.config.js";
import { planArt, replayClient } from "../art-build.js";
import { gunzipSync } from "@engine/render/src/assets/inflate.js";

const DIST = process.env["SURVIVAZ_DIST"] ? resolve(process.env["SURVIVAZ_DIST"]) : "";
const ART = join(DIST, "art");
const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(relative(ART, p)); } return out; };

describe.skipIf(!DIST || !existsSync(join(ART, "manifests.index.json")))("ADR-395 built dist", () => {
  it("ships exactly the planned art and the client resolves the same sources from it", async () => {
    const idx = JSON.parse(readFileSync(join(ART, "manifests.index.json"), "utf8")) as { fragments: unknown[]; gz?: boolean };
    expect(idx.gz).toBe(true);
    const shipped = new Set(walk(ART)); shipped.delete("manifests.index.json");
    const plan = await planArt(artMounts(), { codeRoots: artCodeRoots(), brandingBg: BRANDING.bg, gzipManifests: true });
    expect([...shipped].sort()).toEqual(plan.files.map((f) => (f.gz ? f.url + ".gz" : f.url)).sort());
    const read = (u: string): unknown => {
      if (shipped.has(u + ".gz")) {
        const z = readFileSync(join(ART, u + ".gz")); const a = zlibGunzip(z); const b = gunzipSync(new Uint8Array(z));
        expect(Buffer.from(b).equals(a), `inflate fallback ${u}`).toBe(true); return JSON.parse(a.toString("utf8"));
      }
      return shipped.has(u) && u.endsWith(".json") ? JSON.parse(readFileSync(join(ART, u), "utf8")) : undefined;
    };
    const got = await replayClient(read, idx);
    const want = await replayClient((u) => { const f = plan.files.find((x) => x.url === u); return f ? (f.json !== undefined ? structuredClone(f.json) : JSON.parse(readFileSync(f.src, "utf8"))) : undefined; }, plan.index);
    expect(Object.fromEntries(got.sources)).toEqual(Object.fromEntries(want.sources));
    expect([...got.refs].filter((u) => artFile(u) && !shipped.has(u))).toEqual([]);
  }, 300_000);

  it("non-PNG art is byte-identical to its source; JSON parse-identical", () => {
    let n = 0;
    for (const u of walk(ART)) {
      if (u === "manifests.index.json" || u.endsWith(".gz") || u.endsWith(".png")) continue;
      const src = artFile(u)!; expect(src, u).toBeTruthy();
      if (u.endsWith(".json")) expect(JSON.parse(readFileSync(join(ART, u), "utf8")), u).toEqual(JSON.parse(readFileSync(src, "utf8")));
      else { expect(statSync(join(ART, u)).size, u).toBe(statSync(src).size); expect(readFileSync(join(ART, u)).equals(readFileSync(src)), u).toBe(true); }
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  }, 300_000);
});
