#!/usr/bin/env node
// ADR-395: dist size guard, run after `vite build` in CI and Pages. Fails when the built client grows past the
// byte budget or when an ADR-391..394 cut regresses (legacy ogg back, manifests shipped plain, an unoptimized
// PNG set, duplicate pack art bundled into assets/).
// Usage: node scripts/check-dist-size.mjs [distDir]   (default apps/client/dist)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Bytes. 2026-11-13 after ADR-391..394: 732.6 MB; the budget leaves ~67 MB for new art before review. */
export const DIST_BUDGET = 800_000_000;
const dist = process.argv[2] ?? join(new URL("..", import.meta.url).pathname, "apps/client/dist");
if (!existsSync(join(dist, "index.html"))) { console.error(`[dist-size] no build at ${dist}`); process.exit(1); }

const files = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push([relative(dist, p), statSync(p).size]); } }; walk(dist);
const total = files.reduce((t, [, s]) => t + s, 0);
const by = new Map(); for (const [f, s] of files) { const k = /\.json\.gz$/.test(f) ? ".json.gz" : (f.match(/\.[^./]+$/)?.[0] ?? ""); const e = by.get(k) ?? [0, 0]; e[0]++; e[1] += s; by.set(k, e); }
const problems = [];
if (total > DIST_BUDGET) problems.push(`dist is ${total} B, over the ${DIST_BUDGET} B budget`);
const ogg = files.filter(([f]) => f.endsWith(".ogg")); if (ogg.length) problems.push(`${ogg.length} .ogg files shipped (ADR-334 / 392), e.g. ${ogg[0][0]}`);
const idx = JSON.parse(readFileSync(join(dist, "art/manifests.index.json"), "utf8"));
if (idx.gz !== true) problems.push("manifests.index.json lacks gz: true (ADR-394)");
for (const f of idx.fragments ?? []) {
  const p = join(dist, "art", f.url);
  if (existsSync(p)) problems.push(`plain manifest shipped: art/${f.url} (ADR-394 ships .json.gz)`);
  if (!f.optional && !existsSync(p + ".gz")) problems.push(`missing art/${f.url}.gz`);
}
if (!existsSync(join(dist, "art/pack/ids.lock.json.gz"))) problems.push("missing art/pack/ids.lock.json.gz");
const packDup = files.filter(([f, s]) => /^assets\/(items|nature|vitems|pets|equipment|input_glyphs|ladder)[\w@-]*\.png$/.test(f) && s > 4096 && !/^assets\/nature_adr128_fx@2x-/.test(f));
if (packDup.length) problems.push(`pack art bundled into assets/ again (ADR-393): ${packDup.map(([f]) => f).join(", ")}`);
const lastOx = join(new URL("..", import.meta.url).pathname, ".cache/oxipng/oxipng-9.1.5-o2.last.json");
if (process.env.SURVIVAZ_OXIPNG === "required") {
  const r = existsSync(lastOx) ? JSON.parse(readFileSync(lastOx, "utf8")) : undefined;
  const pngs = files.filter(([f]) => f.endsWith(".png")).length;
  if (!r || r.files !== pngs) problems.push(`oxipng stats (${r?.files ?? "none"}) do not cover the ${pngs} dist PNGs (ADR-391)`);
}
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`[dist-size] ${files.length} files, ${total} B (${mb(total)}) of ${mb(DIST_BUDGET)}: ${[...by].sort((a, b) => b[1][1] - a[1][1]).map(([k, [n, s]]) => `${k || "(none)"} ${n} ${mb(s)}`).join(", ")}`);
if (problems.length) { for (const p of problems) console.error(`[dist-size] FAIL ${p}`); process.exit(1); }
