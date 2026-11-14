// ADR-396: every icon path the client requests must exist. `icons/ic_sun.png` 404'd on the live site because
// the HUD built `${base}icons/<file>` URLs by hand after Task 25 moved the custom icons into embedded data
// URIs (game-icons-data.ts) and removed apps/client/public/icons/<ic_*>.png. Every icon now goes through
// iconUrl(); this test pins (1) no hand-built `icons/` URL outside iconUrl, (2) every `ic_*.png` the client or
// the guide names resolves to an embedded icon or a shipped file, and (3) with SURVIVAZ_DIST set (CI / Pages,
// after the build) every `icons/*` request that can reach the network is a real file in the built dist.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ICON_DATA } from "../src/game-icons-data.js";

const ROOT = resolve(__dirname, "../../..");
const CLIENT = join(ROOT, "apps/client");
const PUBLIC_ICONS = join(CLIENT, "public/icons");
const DIST = process.env["SURVIVAZ_DIST"] ? resolve(process.env["SURVIVAZ_DIST"]) : "";
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|html|css)$/.test(e.name)) out.push(p); }
  return out;
};
const sources = (): string[] => [...walk(join(CLIENT, "src")), join(CLIENT, "index.html"), ...walk(join(ROOT, "packages/gameplay/src"))]
  .filter((f) => !f.endsWith("game-icons-data.ts"));
const publicIcons = (): Set<string> => new Set(existsSync(PUBLIC_ICONS) ? readdirSync(PUBLIC_ICONS) : []);

/** Every `ic_*.png` / `icon_*.png` file name the client or the guide data asks for. */
function requestedIconFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of sources()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/["'`/]((?:ic|icon)_[a-z0-9_]+\.png)["'`]/g)) if (!out.has(m[1]!)) out.set(m[1]!, f.slice(ROOT.length + 1));
  }
  return out;
}

describe("ADR-396 icon paths", () => {
  it("no client code builds an icons/ URL by hand (iconUrl is the one fallback)", () => {
    const offenders: string[] = [];
    for (const f of sources()) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (!/\bicons\/\$\{|\}icons\//.test(line)) return;
        if (f.endsWith("game-icons.ts") && line.includes("export const iconUrl")) return;
        offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every ic_*.png the client or guide requests is an embedded icon or a shipped public file (ic_sun.png included)", () => {
    const pub = publicIcons(); const req = requestedIconFiles();
    expect(req.has("ic_sun.png")).toBe(true);
    expect(ICON_DATA["ic_sun.png"]).toMatch(/^data:image\/png;base64,/);
    const missing = [...req].filter(([file]) => !ICON_DATA[file] && !pub.has(file)).map(([file, at]) => `${file} (${at})`);
    expect(missing).toEqual([]);
  });

  it("the HUD season, vitals and thermometer icons resolve through iconUrl, not the network", async () => {
    const src = readFileSync(join(CLIENT, "src/hud.ts"), "utf8");
    expect(src).toContain('iconUrl(SEASON_ICON[si] ?? "ic_sun.png")');
    expect(src).toContain('iconUrl("ic_temp.png")');
    expect(src).toContain("iconUrl(STATS[i]!.icon)");
    for (const f of ["ic_sun.png", "ic_leaf.png", "ic_snowflake.png", "ic_temp.png", "ic_health.png", "ic_hunger.png", "ic_thirst.png", "ic_stamina.png"]) expect(ICON_DATA[f], f).toBeTruthy();
  });
});

describe.skipIf(!DIST || !existsSync(join(DIST, "index.html")))("ADR-396 icon paths in the built dist", () => {
  it("every icons/ file the client can fetch (index.html links + non-embedded icon names) is in dist", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    const want = new Set<string>();
    for (const m of html.matchAll(/["'(]\.?\/?(icons\/[A-Za-z0-9_.-]+\.png)/g)) want.add(m[1]!);
    for (const [file] of requestedIconFiles()) if (!ICON_DATA[file]) want.add(`icons/${file}`);
    const missing = [...want].filter((p) => !existsSync(join(DIST, p)));
    expect(missing).toEqual([]);
    expect(want.size).toBeGreaterThan(0);
  });
});
