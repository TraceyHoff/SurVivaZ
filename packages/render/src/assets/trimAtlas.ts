/**
 * ADR-512: lossless trim-repack of resident grid atlases (base building art: openings, furniture, decor, twig walls,
 * defenses, stores). Grid sheets reserve a whole cell (128x128) per frame although the art covers ~1/3 of it: at 1x
 * openings + furniture + decor + twig + defenses + stores were ~15.5 M texels, of which ~6 M are art. Each frame is
 * cropped to the union of its colour alpha and its side images (emissive / masks) plus a transparent gutter, the crops are
 * shelf-packed on a narrower page and every frame keeps its cell offset (dx, dy) so anchors stay in cell px. Pixels are
 * copied 1:1 (no resample, no colour change): the frames draw identically from about 40% of the texels, which is the
 * room that lets these atlases stay at 1x on the 256 MB phone budget.
 */
import type { ImageLike } from "./atlasManager.js";

/** Trimmed frame: rect in the packed page and its top-left offset inside the original grid cell (1x px). */
export interface TrimFrame { x: number; y: number; w: number; h: number; dx: number; dy: number }
export interface TrimPlan { w: number; h: number; frames: TrimFrame[] }
/** Transparent gutter kept around each crop (bilinear / sharp-bilinear taps and the outline pass read 1-2 texels out). */
export const TRIM_GUTTER = 2;
/** Crop origins / sizes are multiples of this, so a page that must still be halved twice keeps whole-texel frame edges. */
export const TRIM_ALIGN = 4;
const al = (v: number): number => Math.ceil(v / TRIM_ALIGN) * TRIM_ALIGN;

/**
 * Plan the trim of a cols x rows grid of fw x fh cells. `opaque(x0, y0, x1, y1)` returns the bounding box
 * [minX, minY, maxX, maxY] (inclusive, page px) of non-empty texels inside the cell, or null. Pure (unit-tested).
 */
export function planTrim(cols: number, rows: number, fw: number, fh: number, pageW: number, opaque: (x0: number, y0: number, x1: number, y1: number) => [number, number, number, number] | null): TrimPlan {
  const n = cols * rows; const crops: { i: number; dx: number; dy: number; w: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * fw, cy = Math.floor(i / cols) * fh; const b = opaque(cx, cy, cx + fw, cy + fh);
    if (!b) { crops.push({ i, dx: 0, dy: 0, w: 0, h: 0 }); continue; }
    // gutter inside the cell when there is room (the original cell's own transparent margin), aligned down
    const x0 = Math.max(0, b[0] - cx - TRIM_GUTTER), y0 = Math.max(0, b[1] - cy - TRIM_GUTTER);
    const dx = Math.floor(x0 / TRIM_ALIGN) * TRIM_ALIGN, dy = Math.floor(y0 / TRIM_ALIGN) * TRIM_ALIGN;
    // never past the cell: the original sheet's neighbour cell starts there (frames that touch their cell edge had no gutter before either)
    const w = Math.min(fw - dx, al(b[2] - cx + 1 + TRIM_GUTTER - dx)), h = Math.min(fh - dy, al(b[3] - cy + 1 + TRIM_GUTTER - dy));
    crops.push({ i, dx, dy, w, h });
  }
  // shelf pack, tallest first (stable by index); an empty frame gets one shared transparent cell at the origin
  const frames: TrimFrame[] = new Array(n);
  const order = crops.filter((c) => c.w > 0).sort((a, b) => b.h - a.h || a.i - b.i);
  const W = al(Math.max(pageW, ...order.map((c) => c.w + TRIM_ALIGN)));
  let x = TRIM_ALIGN, y = 0, shelf = 0; // x starts after the shared empty cell (TRIM_ALIGN x TRIM_ALIGN at 0,0)
  for (const c of order) {
    if (x + c.w > W) { y += shelf; x = 0; shelf = 0; }
    frames[c.i] = { x, y, w: c.w, h: c.h, dx: c.dx, dy: c.dy }; x += c.w; shelf = Math.max(shelf, c.h);
  }
  for (const c of crops) if (c.w === 0) frames[c.i] = { x: 0, y: 0, w: TRIM_ALIGN, h: TRIM_ALIGN, dx: 0, dy: 0 };
  return { w: W, h: al(Math.max(TRIM_ALIGN, y + shelf)), frames };
}

type Canvas2D = { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };
function canvas2d(w: number, h: number): Canvas2D | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") { const c = new OffscreenCanvas(w, h); const g = c.getContext("2d", { willReadFrequently: true }); if (g) return { canvas: c, ctx: g }; }
    if (typeof document !== "undefined") { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d", { willReadFrequently: true }); if (g) return { canvas: c, ctx: g }; }
  } catch { /* no 2D canvas (workers without OffscreenCanvas, tests) */ }
  return null;
}

/** Non-empty bbox finder over the union of the images' texels (colour: alpha > 0; side images: any channel > 0). */
function unionOpaque(images: { im: ImageLike; colour: boolean }[], W: number, H: number): ((x0: number, y0: number, x1: number, y1: number) => [number, number, number, number] | null) | null {
  const datas: { d: Uint8ClampedArray; colour: boolean }[] = [];
  for (const { im, colour } of images) {
    if (im.width !== W || im.height !== H) return null;
    const c = canvas2d(W, H); if (!c) return null;
    c.ctx.drawImage(im as CanvasImageSource, 0, 0); datas.push({ d: c.ctx.getImageData(0, 0, W, H).data, colour });
  }
  return (x0, y0, x1, y1) => {
    let mx = Infinity, my = Infinity, Mx = -1, My = -1;
    for (let y = y0; y < Math.min(y1, H); y++) for (let x = x0; x < Math.min(x1, W); x++) {
      const o = (y * W + x) * 4; let on = false;
      for (const { d, colour } of datas) { if (colour ? d[o + 3]! > 0 : (d[o]! | d[o + 1]! | d[o + 2]! | d[o + 3]!) > 0) { on = true; break; } }
      if (on) { if (x < mx) mx = x; if (x > Mx) Mx = x; if (y < my) my = y; if (y > My) My = y; }
    }
    return Mx < 0 ? null : [mx, my, Mx, My];
  };
}

/** Copy each frame's crop 1:1 into a new page (no smoothing: whole-px copies are exact). */
function repack(im: ImageLike, plan: TrimPlan, cols: number, fw: number, fh: number): ImageLike | null {
  const c = canvas2d(plan.w, plan.h); if (!c) return null;
  c.ctx.imageSmoothingEnabled = false; c.ctx.clearRect(0, 0, plan.w, plan.h);
  plan.frames.forEach((f, i) => {
    const sx = (i % cols) * fw + f.dx, sy = Math.floor(i / cols) * fh + f.dy;
    const w = Math.min(f.w, im.width - sx), h = Math.min(f.h, im.height - sy);
    if (f.w === TRIM_ALIGN && f.x === 0 && f.y === 0 && f.dx === 0 && f.dy === 0) return; // shared empty cell
    if (w > 0 && h > 0) c.ctx.drawImage(im as CanvasImageSource, sx, sy, w, h, f.x, f.y, w, h);
  });
  return c.canvas as ImageLike;
}

export interface TrimResult { img: ImageLike; emis: ImageLike | null; masks: Record<string, ImageLike>; plan: TrimPlan; before: number; after: number }
const cache = new WeakMap<object, TrimResult | null>();
/**
 * Trim-repack one grid atlas and its emissive / mask images (all already the colour page's size). null when it would
 * not save texels or no 2D canvas is available. Cached per colour image object (the AssetManager keeps it across rebuilds).
 */
export function trimGridAtlas(img: ImageLike, emis: ImageLike | null, masks: Record<string, ImageLike>, cols: number, rows: number, fw: number, fh: number): TrimResult | null {
  if (cache.has(img as object)) { const r = cache.get(img as object)!; if (!r || (r.emis === null) === (emis === null)) return r; }
  let out: TrimResult | null = null;
  try {
    const W = img.width, H = img.height;
    if (W >= cols * fw && H >= rows * fh) {
      const opaque = unionOpaque([{ im: img, colour: true }, ...(emis ? [{ im: emis, colour: false }] : []), ...Object.values(masks).map((im) => ({ im, colour: false }))], W, H);
      if (opaque) {
        const plan = planTrim(cols, rows, fw, fh, Math.min(W, 2048), opaque);
        if (plan.w * plan.h < W * H * 0.9) {
          const ti = repack(img, plan, cols, fw, fh); const te = emis ? repack(emis, plan, cols, fw, fh) : null;
          const tm: Record<string, ImageLike> = {}; let ok = !!ti && (!emis || !!te);
          for (const [k, m] of Object.entries(masks)) { const r = repack(m, plan, cols, fw, fh); if (r) tm[k] = r; else ok = false; }
          if (ok) out = { img: ti!, emis: te, masks: tm, plan, before: W * H, after: plan.w * plan.h };
        }
      }
    }
  } catch { out = null; }
  cache.set(img as object, out); return out;
}
