import { reportRenderError } from "../report.js";
import { assetBytes } from "./asset-fetch.js";
/**
 * KTX2 (Basis Universal) transcoding. The Basis transcoder (Apache-2.0, Binomial LLC; vendored from three.js r170
 * examples/jsm/libs/basis, see vendor/basis/README.md) lives in packages/render/vendor/basis and is loaded lazily on the
 * first KTX2 request: no package.json dependency. Colour pages are ETC1S, masks UASTC; emissive is sRGB, the rest linear.
 * Transcode target by probe: ASTC 4x4 > ETC2 (RGBA8 EAC) > BPTC (BC7) > S3TC (DXT5) > PNG fallback (null).
 */
import type { CompressedTextureSupport } from "../gl/capabilities.js";

export type Ktx2Target = "astc" | "etc2" | "bptc" | "s3tc";
export interface Ktx2Image { width: number; height: number; levels: ArrayBufferView[]; internalFormat: number; target: Ktx2Target }
export type Ktx2Transcoder = (data: ArrayBuffer, target: Ktx2Target, srgb?: boolean) => Promise<Ktx2Image>;

/** basis transcoder_texture_format ids */
export const BASIS_FORMAT: Record<Ktx2Target, number> = { etc2: 1, s3tc: 3, bptc: 6, astc: 10 };
/** GL internal formats [linear, sRGB] per target */
export const GL_FORMAT: Record<Ktx2Target, [number, number]> = { astc: [0x93b0, 0x93d0], etc2: [0x9278, 0x9279], bptc: [0x8e8c, 0x8e8d], s3tc: [0x83f3, 0x8c4f] };
/** bytes per 4x4 block (all targets here are 16-byte blocks) */
export const blockBytes = (w: number, h: number): number => Math.ceil(w / 4) * Math.ceil(h / 4) * 16;

let transcoder: Ktx2Transcoder | null = null;
let enabled = false;
/** Install a transcoder (IsoRenderer installs basisTranscoder unless ?ktx2=0 / gl=safe). null disables KTX2 (PNG only). */
export function setKtx2Transcoder(t: Ktx2Transcoder | null): void { transcoder = t; enabled = t !== null; }

/** Best transcode target for this GPU, or null for the PNG fallback (disabled, or no compressed support). */
export function ktx2Target(c: CompressedTextureSupport): Ktx2Target | null {
  if (!enabled) return null;
  return c.astc ? "astc" : c.etc2 ? "etc2" : c.bptc ? "bptc" : c.s3tc ? "s3tc" : null;
}

/** URL to load for a page: its manifest `ktx2` twin (string) when usable, else `x.png -> x.ktx2` if `available`, else the PNG. */
export function pickTextureUrl(pngUrl: string, c: CompressedTextureSupport, ktx2?: string | ((url: string) => boolean)): string {
  if (!ktx2Target(c)) return pngUrl;
  if (typeof ktx2 === "string") return ktx2;
  const k = pngUrl.replace(/\.png$/i, ".ktx2");
  return k !== pngUrl && (!ktx2 || ktx2(k)) ? k : pngUrl;
}

interface BasisKtx2File { isValid(): boolean; getWidth(): number; getHeight(): number; getLevels(): number; startTranscoding(): boolean; getImageTranscodedSizeInBytes(l: number, layer: number, face: number, f: number): number; transcodeImage(dst: Uint8Array, l: number, layer: number, face: number, f: number, flags: number, ch0: number, ch1: number): boolean; close(): void; delete(): void }
interface BasisModule { initializeBasis(): void; KTX2File: new (b: Uint8Array) => BasisKtx2File }
let basis: Promise<BasisModule> | null = null;
/** Lazily fetch + instantiate the vendored transcoder (classic emscripten script exposing `BASIS`). */
function loadBasis(): Promise<BasisModule> {
  basis ??= (async () => {
    const js = new URL("../../vendor/basis/basis_transcoder.js", import.meta.url).href;
    const wasm = new URL("../../vendor/basis/basis_transcoder.wasm", import.meta.url).href;
    const [src, bin] = await Promise.all([fetch(js).then((r) => r.text()), fetch(wasm).then((r) => r.arrayBuffer())]);
    const factory = new Function(`${src}\n;return BASIS;`)() as (o: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>;
    const m = await factory({ wasmBinary: bin }); m.initializeBasis(); return m;
  })();
  basis.catch(() => { basis = null; });
  return basis;
}

/**
 * ADR-186: Basis transcoding is CPU-heavy (tens to hundreds of ms per 2048 page) and used to run on the main thread inside
 * the atlas page-in, a long task (dropped frames / visible hitch) every time a page streamed in while walking. In browsers
 * it now runs in a small worker pool (buffers transferred, no copies); the main thread only uploads the result. Falls back
 * to in-thread transcoding when Worker/Blob URLs are unavailable (node tests, strict CSP) or a worker fails.
 */
type Job = { op: "gpu"; fmt: number } | { op: "rgba" };
interface WorkerOut { id: number; ok: boolean; error?: string; width?: number; height?: number; levels?: ArrayBuffer[] }
const WORKER_SRC = `let B=null;const load=(js,wasm)=>B??=Promise.all([fetch(js).then(r=>r.text()),fetch(wasm).then(r=>r.arrayBuffer())]).then(([s,b])=>new Function(s+"\\n;return BASIS;")()({wasmBinary:b})).then(m=>{m.initializeBasis();return m;});
onmessage=async(e)=>{const d=e.data;try{const m=await load(d.js,d.wasm);const f=new m.KTX2File(new Uint8Array(d.data));try{if(!f.isValid()||!f.startTranscoding())throw new Error("invalid KTX2");
const fmt=d.op==="rgba"?13:d.fmt;const n=d.op==="rgba"?1:f.getLevels();const lv=[];for(let l=0;l<n;l++){const dst=new Uint8Array(f.getImageTranscodedSizeInBytes(l,0,0,fmt));if(!f.transcodeImage(dst,l,0,0,fmt,0,-1,-1))throw new Error("transcode level "+l);lv.push(dst.buffer);}
postMessage({id:d.id,ok:true,width:f.getWidth(),height:f.getHeight(),levels:lv},lv);}finally{f.close();f.delete();}}catch(err){postMessage({id:d.id,ok:false,error:String(err&&err.message||err)});}};`;
interface Pool { workers: Worker[]; next: number; waiting: Map<number, (o: WorkerOut) => void>; id: number }
let pool: Pool | null | undefined;
/** Worker count: 2 (one decodes while the other finishes), 1 on <=4 logical cores. */
export function transcodeWorkerCount(cores: number | undefined): number { return (cores ?? 4) <= 4 ? 1 : 2; }
function workerPool(): Pool | null {
  if (pool !== undefined) return pool;
  pool = null;
  try {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return null;
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    const p: Pool = { workers: [], next: 0, waiting: new Map(), id: 0 };
    const n = transcodeWorkerCount(typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined);
    for (let i = 0; i < n; i++) {
      const w = new Worker(url);
      w.onmessage = (e: MessageEvent<WorkerOut>) => { const r = p.waiting.get(e.data.id); p.waiting.delete(e.data.id); r?.(e.data); };
      w.onerror = () => { pool = null; for (const r of p.waiting.values()) r({ id: -1, ok: false, error: "worker failed" }); p.waiting.clear(); };
      p.workers.push(w);
    }
    pool = p;
  } catch { pool = null; }
  return pool;
}
/** Disable (false) or re-enable (true) the worker pool; tests use this to force the in-thread path. */
export function setKtx2Workers(on: boolean): void { pool = on ? undefined : null; }
function inWorker(data: ArrayBuffer, job: Job): Promise<WorkerOut> | null {
  const p = workerPool(); if (!p) return null;
  const id = ++p.id; const w = p.workers[p.next++ % p.workers.length]!;
  const js = new URL("../../vendor/basis/basis_transcoder.js", import.meta.url).href, wasm = new URL("../../vendor/basis/basis_transcoder.wasm", import.meta.url).href;
  return new Promise((res) => { p.waiting.set(id, res); w.postMessage({ id, js, wasm, data, ...job }, [data]); });
}

/** Default transcoder: vendored Basis, all mip levels of layer 0 (worker pool when available, ADR-186). */
export const basisTranscoder: Ktx2Transcoder = async (data, target, srgb = false) => {
  const fmt = BASIS_FORMAT[target];
  const wj = inWorker(data, { op: "gpu", fmt });
  if (wj) { const o = await wj; if (!o.ok) throw new Error(o.error ?? "transcode failed"); return { width: o.width!, height: o.height!, levels: o.levels!.map((b) => new Uint8Array(b)), internalFormat: GL_FORMAT[target][srgb ? 1 : 0], target }; }
  const m = await loadBasis(); const f = new m.KTX2File(new Uint8Array(data));
  try {
    if (!f.isValid() || !f.startTranscoding()) throw new Error("invalid KTX2");
    const levels: ArrayBufferView[] = [];
    for (let l = 0; l < f.getLevels(); l++) { const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(l, 0, 0, fmt)); if (!f.transcodeImage(dst, l, 0, 0, fmt, 0, -1, -1)) throw new Error(`transcode level ${l}`); levels.push(dst); }
    return { width: f.getWidth(), height: f.getHeight(), levels, internalFormat: GL_FORMAT[target][srgb ? 1 : 0], target };
  } finally { f.close(); f.delete(); }
};

/** Load + transcode a KTX2 page; null (caller uses the PNG) when disabled, unsupported or on any failure. */
export async function loadKtx2(url: string, c: CompressedTextureSupport, srgb = false, fetcher: (u: string) => Promise<ArrayBuffer> = assetBytes): Promise<Ktx2Image | null> {
  const t = ktx2Target(c); if (!t) return null;
  try { return await (transcoder ?? basisTranscoder)(await fetcher(url), t, srgb); } catch (e) { warnOnce(url, e); return null; }
}

/** Transcode level 0 of a KTX2 (typically a UASTC mask) to straight RGBA8 pixels (basis cTFRGBA32 = 13); null on failure. */
export async function loadKtx2Rgba(url: string, fetcher: (u: string) => Promise<ArrayBuffer> = assetBytes): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  if (!enabled) return null;
  try {
    const buf = await fetcher(url);
    // only the default transcoder setup uses the worker; a test-installed transcoder keeps everything in-thread
    const wj = transcoder === basisTranscoder ? inWorker(buf, { op: "rgba" }) : null;
    if (wj) { const o = await wj; return o.ok ? { width: o.width!, height: o.height!, data: new Uint8Array(o.levels![0]!) } : null; }
    const m = await loadBasis(); const f = new m.KTX2File(new Uint8Array(buf));
    try {
      if (!f.isValid() || !f.startTranscoding()) return null;
      const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, 0, 13));
      if (!f.transcodeImage(dst, 0, 0, 0, 13, 0, -1, -1)) return null;
      return { width: f.getWidth(), height: f.getHeight(), data: dst };
    } finally { f.close(); f.delete(); }
  } catch (e) { warnOnce(url, e); return null; }
}

let warned = 0;
function warnOnce(url: string, e: unknown): void { reportRenderError(`ktx2 transcode ${url}`, e); if (warned++ < 3) console.warn(`[render] ktx2 ${url}: ${e instanceof Error ? e.message : String(e)}`); }
