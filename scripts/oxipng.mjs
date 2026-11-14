// ADR-391: lossless PNG recompression of the built dist with a pinned oxipng, cached by source-file hash.
// oxipng re-encodes the zlib stream / colour type only; decoded RGBA (transparent texels included, no --alpha)
// and ancillary chunks (no --strip) are unchanged. Env SURVIVAZ_OXIPNG: "off" (copy verbatim), "required"
// (CI / Pages: fail when the pinned binary is unavailable), default auto (warn and skip when unavailable).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

export const OXIPNG_VERSION = "9.1.5";
export const OXIPNG_LEVEL = "2";
const RELEASE = {
  "linux-x64": { url: `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "571e69fcb06a3675fe247998d845619075631b01ac2246e8a88206c723a472e2", dir: `oxipng-${OXIPNG_VERSION}-x86_64-unknown-linux-musl` },
};
/** Cache key prefix: a different binary or level never reuses another's output. */
export const OXIPNG_TAG = `oxipng-${OXIPNG_VERSION}-o${OXIPNG_LEVEL}`;

const versionOf = (bin) => { try { return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(); } catch { return ""; } };

/** Path of the pinned oxipng binary (downloaded + checksum-verified into `toolDir` once), or undefined. */
export function ensureOxipng(toolDir) {
  const want = `oxipng ${OXIPNG_VERSION}`;
  if (process.env.OXIPNG_BIN && versionOf(process.env.OXIPNG_BIN) === want) return process.env.OXIPNG_BIN;
  const rel = RELEASE[`${platform()}-${arch()}`];
  if (rel) {
    const bin = join(toolDir, rel.dir, "oxipng");
    if (existsSync(bin) && versionOf(bin) === want) return bin;
    try {
      mkdirSync(toolDir, { recursive: true });
      const tgz = join(toolDir, `${rel.dir}.tar.gz`);
      execFileSync("curl", ["-sSLf", "--retry", "3", "-o", tgz, rel.url]);
      const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
      if (got !== rel.sha256) { rmSync(tgz, { force: true }); throw new Error(`oxipng checksum mismatch ${got}`); }
      execFileSync("tar", ["xzf", tgz, "-C", toolDir]); rmSync(tgz, { force: true }); chmodSync(bin, 0o755);
      if (versionOf(bin) === want) return bin;
    } catch (e) { console.warn(`[oxipng] download failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // other platforms: an oxipng of the pinned version on PATH
  return versionOf("oxipng") === want ? "oxipng" : undefined;
}

function walkPng(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walkPng(p, out); else if (e.name.endsWith(".png")) out.push(p); }
  return out;
}

/**
 * Recompress every PNG under `distDir` in place. Each file's bytes are looked up in `cacheDir` by
 * sha256(tag + bytes); misses are optimized in batches (oxipng runs its own thread pool) and stored.
 * Entries not used by this build are pruned so the cache tracks the current art set.
 */
export function optimizeDistPngs(distDir, { cacheDir, toolDir, mode = process.env.SURVIVAZ_OXIPNG ?? "auto", log = console.log } = {}) {
  if (mode === "off") { log("[oxipng] off (SURVIVAZ_OXIPNG=off): PNGs copied verbatim"); return { files: 0, before: 0, after: 0, hits: 0, misses: 0, ms: 0 }; }
  const t0 = Date.now();
  const bin = ensureOxipng(toolDir);
  if (!bin) { if (mode === "required") throw new Error(`[oxipng] pinned oxipng ${OXIPNG_VERSION} unavailable (SURVIVAZ_OXIPNG=required)`); log(`[oxipng] oxipng ${OXIPNG_VERSION} unavailable: PNGs copied verbatim`); return { files: 0, before: 0, after: 0, hits: 0, misses: 0, ms: 0 }; }
  mkdirSync(cacheDir, { recursive: true });
  const files = walkPng(distDir); const keyOf = new Map(); const miss = new Map(); let before = 0;
  for (const f of files) { const b = readFileSync(f); before += b.length; const k = createHash("sha256").update(OXIPNG_TAG).update(b).digest("hex"); keyOf.set(f, k); if (!existsSync(join(cacheDir, `${k}.png`)) && !miss.has(k)) miss.set(k, f); }
  const work = join(tmpdir(), `survivaz-oxipng-${process.pid}`); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  const todo = [...miss].map(([k, f]) => { const w = join(work, `${k}.png`); copyFileSync(f, w); return w; });
  for (let i = 0; i < todo.length; i += 256) execFileSync(bin, ["-o", OXIPNG_LEVEL, "-q", ...todo.slice(i, i + 256)], { stdio: ["ignore", "inherit", "inherit"] });
  for (const w of todo) renameSync(w, join(cacheDir, w.slice(work.length + 1)));
  rmSync(work, { recursive: true, force: true });
  let after = 0;
  for (const f of files) { const c = join(cacheDir, `${keyOf.get(f)}.png`); if (statSync(c).size < statSync(f).size) copyFileSync(c, f); after += statSync(f).size; }
  const used = new Set([...keyOf.values()].map((k) => `${k}.png`));
  for (const n of readdirSync(cacheDir)) if (!used.has(n)) rmSync(join(cacheDir, n), { force: true });
  const r = { files: files.length, before, after, hits: files.length - todo.length, misses: todo.length, ms: Date.now() - t0 };
  log(`[oxipng] ${r.files} PNGs ${before} -> ${after} B (-${before - after}); cache ${r.hits} hit / ${r.misses} new; ${(r.ms / 1000).toFixed(1)} s`);
  writeFileSync(join(cacheDir, "..", `${OXIPNG_TAG}.last.json`), JSON.stringify(r));
  return r;
}
