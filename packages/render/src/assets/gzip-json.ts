/**
 * ADR-394: the build ships the merged-manifest JSON as `<name>.json.gz`; read a fetched body as JSON whether
 * it is gzip (magic 1f 8b: DecompressionStream, else the pure-TS inflate for Safari < 16.4) or plain text (a
 * host that served it with Content-Encoding: gzip already decoded it; the dev server serves plain JSON).
 */
import { gunzipSync } from "./inflate.js";

export const isGzip = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** gzip bytes -> UTF-8 text. */
export async function gunzipText(bytes: Uint8Array): Promise<string> {
  const DS = (globalThis as { DecompressionStream?: new (f: "gzip") => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (typeof DS === "function" && typeof Blob === "function" && typeof Response === "function") {
    try { return await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DS("gzip"))).text(); } catch { /* fall through to inflate */ }
  }
  return new TextDecoder().decode(gunzipSync(bytes));
}

/** Response body -> parsed JSON (gzip or plain). */
export async function responseJson(r: Response): Promise<unknown> {
  const b = new Uint8Array(await r.arrayBuffer());
  return JSON.parse(isGzip(b) ? await gunzipText(b) : new TextDecoder().decode(b));
}
