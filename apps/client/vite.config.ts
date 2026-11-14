import { createLogger, defineConfig, type Plugin, type Connect } from "vite";
import { cpSync, createReadStream, existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { register as registerTsx } from "tsx/esm/api";
import { optimizeDistPngs } from "../../scripts/oxipng.mjs";
import type { ArtMount } from "./art-build.js";

// ADR-249: Vite 5 bundles this config with esbuild but leaves workspace packages external, and since ADR-248
// `@engine/assets` (TS sources, `.js` specifiers) is imported here — Node 24 cannot load it bare. Register tsx's
// loader first, then import it dynamically, so plain `vite` / `pnpm dev` work without NODE_OPTIONS="--import tsx".
registerTsx();
const { servedManifestIndex } = await import("@engine/assets");

/**
 * Art for the WebGL2 IsoRenderer, served under `<base>art/` (dev: middleware; build: copied into dist/art/):
 *   art/pack/         <- packages/assets/pack (manifest, piece_variants, atlases/*, audio/<bus>/<name>.(opus|m4a|mp3) for the ADR-117 mixer; .wav masters and the legacy .ogg excluded, ADR-392)
 *   art/survival_fx/  <- assets/survival_fx render_tuning.json + daynight_grading.json + textures/ + lut/
 *   art/ui/           <- assets/ui theme.json + fonts/** + branding/** + kit/** (Cozy Camp kit atlases 1x/2x) + screens/** + screen.schema.json + strings/en.json + input/** (glyphs/touch) + creator/** (ADR-115) + hooks/atlas
 * GitHub Pages serves the site under /<repo>/; set BASE (e.g. BASE=/SurVivaZ/) for that build.
 * ADR-392: `vite build` ships only what the client resolves (apps/client/art-build.ts planArt); the dev server
 * serves every mounted file.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const MOUNTS: [string, string, (rel: string) => boolean][] = [
  ["pack/", join(root, "packages/assets/pack"), (r) => /^(manifest\.json|piece_variants\.json|ids\.lock\.json|(?:customization\/)?(?:atlases|mirror)\/[^/]+\.(png|json|ktx2)|(?:vehicles|building|items|nature|vehicle_items|task34|task256|task355|task361)\/(?:manifest\.\w+\.json|atlases\/[^/]+\.(?:png|json|ktx2))|customization\/strings\/en\.json|customization\/manifest\.customization(?:\.[\w-]+)*\.json|audio\/(?:sfx|ambience|ui|music|voice)\/[\w-]+\.(?:opus|m4a|mp3))$/.test(r)],
  ["survival_fx/", join(root, "assets/survival_fx"), (r) => /^(render_tuning\.json|daynight_grading\.json|textures\/[^/]+\.png|lut\/[^/]+\.(png|json))$/.test(r)],
  // ADR-242: Art's top-level PvP/clan + stalls drops (fragment image paths are art-root relative: "pvp_clan/atlases/x.png")
  ["pvp_clan/", join(root, "assets/pvp_clan"), (r) => /^(manifest\.fragment\.json|atlases\/[^/]+\.(?:png|json|ktx2)|(?:world_ui_colors|clan_palettes|outline_colors|rarity_palette)\.json)$/.test(r)],
  ["stalls/", join(root, "assets/stalls"), (r) => /^(manifest\.fragment\.json|atlases\/[^/]+\.(?:png|json|ktx2)|render_tuning\.stalls\.json|strings\/en\.json)$/.test(r)],
  ["ui/", join(root, "assets/ui"), (r) => /^(theme\.json|screen\.schema\.json|fonts\/(?:sdf\/)?[^/]+\.(ttf|txt|png|json)|atlas\/ui_atlas(@2x)?\.(png|json)|(?:kit|screens|strings|branding|creator|hooks\/atlas|input|input\/atlas)\/(?:[\w-]+\/)*[^/]+\.(png|webp|svg|json))$/.test(r) && !/\/frames\//.test(r)],
];
const TYPES: Record<string, string> = { ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".ttf": "font/ttf", ".txt": "text/plain", ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ktx2": "image/ktx2" };

/** Whether `<art>/<url>` is served by MOUNTS (exists and passes the mount filter). */
export function artServed(url: string): boolean {
  for (const [p, dir, ok] of MOUNTS) if (url.startsWith(p)) { const rel = url.slice(p.length); return ok(rel) && existsSync(join(dir, rel)); }
  return false;
}
/** ADR-248: the file `<art>/<url>` is served from (undefined if not served); lets tests replay the client's manifest fetches. */
export function artFile(url: string): string | undefined {
  for (const [p, dir, ok] of MOUNTS) if (url.startsWith(p)) { const rel = url.slice(p.length); return ok(rel) && existsSync(join(dir, rel)) ? join(dir, rel) : undefined; }
  return undefined;
}
/** The art mounts as planArt (ADR-392) takes them. */
export const artMounts = (): ArtMount[] => MOUNTS.map(([prefix, dir, ok]) => ({ prefix, dir, ok }));
/** Client code scanned for literal art file names (ADR-392): files named only by code stay shipped. */
export const artCodeRoots = (): string[] => [join(root, "apps/client/src"), join(root, "apps/client/index.html"),
  ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p, "src"))];
/** `<art>/manifests.index.json`: only fragments that ship, so the client requests no missing manifests. */
const manifestIndexJson = (): string => JSON.stringify(servedManifestIndex(artServed), null, 1);

/** ADR-332: copy one mounted art file into dist; `*.json` is re-stringified compact (parse + `JSON.stringify`
 *  with no whitespace) so shipped manifests/atlas layouts carry no pretty-print whitespace. Source files stay
 *  pretty-printed; parsed output is identical to parsed source (pinned by apps/client/test/adr332_json_minify.test.ts).
 *  A JSON that fails to parse fails the build here rather than shipping corrupt data. Non-JSON files copy verbatim. */
export function copyArtFile(src: string, dst: string): void {
  if (extname(src) === ".json") {
    const text = readFileSync(src, "utf8");
    writeFileSync(dst, JSON.stringify(JSON.parse(text)));
  } else {
    cpSync(src, dst);
  }
}

function art(): Plugin {
  let base = "/", outDir = "dist", building = false;
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = decodeURIComponent((req.url ?? "").split("?")[0]!);
    const prefix = base + "art/";
    if (!url.startsWith(prefix)) return next();
    const rest = url.slice(prefix.length);
    if (rest === "manifests.index.json") { res.setHeader("Content-Type", "application/json"); res.end(manifestIndexJson()); return; }
    for (const [p, dir, ok] of MOUNTS) {
      if (!rest.startsWith(p)) continue;
      const rel = rest.slice(p.length); const file = normalize(join(dir, rel));
      if (!ok(rel) || !file.startsWith(normalize(dir)) || !existsSync(file)) break;
      res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res); return;
    }
    res.statusCode = 404; res.end();
  };
  return {
    name: "client-art",
    // vitest resolves this config with build.outDir "dummy-non-existing-folder" and may run closeBundle: only copy art
    // for a real `vite build` (otherwise 658 MB of art landed in apps/client/dummy-non-existing-folder).
    configResolved(c) { base = c.base; outDir = resolve(c.root, c.build.outDir); building = c.command === "build" && !process.env["VITEST"] && !/dummy-non-existing-folder/.test(outDir); },
    configureServer(s) { s.middlewares.use(serve); },
    configurePreviewServer(s) { s.middlewares.use(serve); },
    async closeBundle() {
      if (!building) return;
      // ADR-392 / 393: ship what the client resolves, once; ADR-394: merged-manifest JSON as .json.gz
      const { planArt } = await import("./art-build.js");
      const plan = await planArt(artMounts(), { codeRoots: artCodeRoots(), brandingBg: BRANDING.bg, gzipManifests: true });
      let gzIn = 0, gzOut = 0;
      for (const f of plan.files) {
        const dst = join(outDir, "art", f.url); mkdirSync(join(dst, ".."), { recursive: true });
        if (f.gz) { const t = Buffer.from(JSON.stringify(f.json !== undefined ? f.json : JSON.parse(readFileSync(f.src, "utf8")))); const z = gzipSync(t, { level: 9 }); writeFileSync(dst + ".gz", z); gzIn += t.length; gzOut += z.length; }
        else if (f.json !== undefined) writeFileSync(dst, JSON.stringify(f.json)); else copyArtFile(f.src, dst);
      }
      console.log(`[art] ${plan.files.filter((f) => f.gz).length} manifests gzipped: ${gzIn} -> ${gzOut} B`);
      writeFileSync(join(outDir, "art", "manifests.index.json"), JSON.stringify(plan.index, null, 1));
      const by = new Map<string, [number, number]>(); for (const d of plan.dropped) { const e = by.get(d.why) ?? [0, 0]; e[0]++; e[1] += d.bytes; by.set(d.why, e); }
      console.log(`[art] ${plan.files.length} files shipped; ${plan.ktx2Stripped.length} resident atlases lose KTX2 fields; dropped ${[...by].map(([w, [n, b]]) => `${w}: ${n} (${b} B)`).join("; ")}`);
      // ADR-391: lossless PNG recompression of everything shipped (art/ and Vite's assets/), cached by file hash
      optimizeDistPngs(outDir, { cacheDir: join(root, ".cache/oxipng/png"), toolDir: join(root, ".cache/oxipng/tools") });
    },
  };
}

/** ADR-393: CSS `url()`s of pack art by source path (`../../../packages/assets/pack/...`) point at the shipped
 *  `<base>art/pack/` copy instead of Vite bundling a second copy into assets/. Files Vite would inline as data
 *  URIs (<= assetsInlineLimit) stay inlined, so no request is added. */
const PACK_CSS_URL = /url\((["']?)((?:\.\.\/)+packages\/assets\/pack\/([^"')?#]+))\1\)/g;
export function rewritePackCssUrls(code: string, cssFile: string, base: string, inlineLimit = 4096): string {
  const pack = join(root, "packages/assets/pack") + "/";
  return code.replace(PACK_CSS_URL, (m, _q: string, path: string, rel: string) => {
    const f = resolve(dirname(cssFile), path);
    return f === join(pack, rel) && artServed(`pack/${rel}`) && statSync(f).size > inlineLimit ? `url("${base}art/pack/${rel}")` : m;
  });
}
function artUrls(): Plugin {
  let base = "/", limit = 4096;
  return {
    name: "client-art-urls", enforce: "pre",
    configResolved(c) { base = c.base; const l = c.build.assetsInlineLimit; limit = typeof l === "number" ? l : 4096; },
    transform(code, id) { const f = id.split("?")[0]!; return f.endsWith(".css") && f.startsWith(join(root, "apps/client/src")) ? rewritePackCssUrls(code, f, base, limit) : null; },
  };
}
/** Vite warns once per runtime-resolved url(); the ADR-393 art/pack urls are meant to resolve at runtime. */
const logger = createLogger();
const runtimeArt = (m: string): boolean => /\/art\/pack\/\S+ referenced in .* didn't resolve at build time/.test(m);
{ const warn = logger.warn.bind(logger), once = logger.warnOnce.bind(logger); logger.warn = (m, o) => { if (!runtimeArt(m)) warn(m, o); }; logger.warnOnce = (m, o) => { if (!runtimeArt(m)) once(m, o); }; }

/** Art's branding (assets/ui/branding/, branding.json title = {app.title}), resolved at build time so the client never probes missing files (no 404s). */
const BR = join(root, "assets/ui/branding");
const brandingJson = ((): { title?: string; tagline?: string } => { try { return JSON.parse(readFileSync(join(BR, "branding.json"), "utf8")) as { title?: string; tagline?: string }; } catch { return {}; } })();
/** {app.title}: the game's name. Art's logo is used only once it is drawn for this title (branding.json title matches). */
const APP_TITLE = "SurVivaZ";
export const BRANDING = {
  title: APP_TITLE, tagline: brandingJson.tagline ?? "a cozy survival camp-out",
  logo: brandingJson.title === APP_TITLE ? ["logo/logo_1024.png", "logo/logo_512.png", "logo.png"].find((f) => existsSync(join(BR, f))) ?? "" : "",
  bg: existsSync(join(BR, "background/parallax/menu_bg_sky.png")) ? "parallax" : existsSync(join(BR, "background/menu_bg_1920x1080.png")) ? "flat" : "",
  plates: existsSync(join(BR, "buttons/plates/btn_plate_singleplayer_normal.png")),
  icons: existsSync(join(BR, "buttons/icons/ic_menu_singleplayer.png")),
  loading: existsSync(join(BR, "loading/loading_frame.png")) && existsSync(join(BR, "loading/loading_fill.png")),
  loadingAnim: existsSync(join(BR, "loading/loading_zombie_walk.png")) && existsSync(join(BR, "loading/loading_campfire.png")),
};

/** ADR-198: short git hash stamped into the error log (GITHUB_SHA on CI). */
function buildHash(): string { const e = process.env["GITHUB_SHA"]; if (e) return e.slice(0, 8); try { return execSync("git rev-parse --short=8 HEAD", { cwd: root }).toString().trim(); } catch { return "unknown"; } }
export default defineConfig({
  define: { __BRANDING__: JSON.stringify(BRANDING), __BUILD_HASH__: JSON.stringify(buildHash()) },
  base: process.env["BASE"] ?? "/",
  plugins: [artUrls(), art()],
  customLogger: logger,
  build: { target: "es2022" },
});
