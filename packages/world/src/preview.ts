/** Cheap seed survey: the exact generator's tile and height samplers, never full chunks/entities.
 * North-up, 512 x 512 tiles around the four starter areas; not a promise that it shows the entire streamed world. */
import { northUpToWorld } from "./geography.js";
import { ProceduralGenerator } from "./generator.js";
import { terrainLevel } from "./waterDepth.js";
/** Origin and stride are geographic east/south tile units, not world-grid axes.
 * The square covers the previous 384x256 world-grid footprint after rotation, at the same sample density. */
export const PREVIEW = { width: 128, height: 128, stride: 4, x: -256, y: -256 } as const;
export interface WorldPreview { seed: number; tiles: Uint16Array; heights: Int8Array }
/** World tile sampled by a thumbnail pixel; also the inverse/picking contract for preview consumers. */
export function previewWorldAt(x: number, y: number): { x: number; y: number } {
  const w = northUpToWorld(PREVIEW.x + x * PREVIEW.stride, PREVIEW.y + y * PREVIEW.stride);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}
export function sampleWorldPreview(seed: number): WorldPreview {
  const g = new ProceduralGenerator({ seed }); const tiles = new Uint16Array(PREVIEW.width * PREVIEW.height), heights = new Int8Array(tiles.length);
  for (let y = 0; y < PREVIEW.height; y++) for (let x = 0; x < PREVIEW.width; x++) {
    const i = y * PREVIEW.width + x, { x: tx, y: ty } = previewWorldAt(x, y);
    const sample = g.sampleAt(tx, ty); tiles[i] = sample.tile; heights[i] = sample.height;
  }
  return { seed, tiles, heights };
}
/** Compact SVG relief image; dedicated data visualization, no borrowed item/terrain sprites or external assets. */
export function worldPreviewSvg(p: WorldPreview): string {
  const palette: Record<number, readonly [number, number, number]> = { 1: [36, 102, 149], 2: [201, 180, 117], 3: [106, 147, 69], 4: [85, 114, 58], 5: [137, 137, 130], 6: [220, 229, 230], 7: [50, 89, 53], 8: [67, 153, 177], 9: [116, 99, 65] };
  const paths = new Map<string, string[]>();
  // ADR-383: shade by terrain level, not the stored height byte — elevated-lake water stores the ADR-263/297
  // flow encoding of its surface (raw 80+), which would otherwise paint a white halo on the shore pixels.
  const level = (i: number): number => terrainLevel(p.tiles[i]!, p.heights[i]!);
  for (let y = 0; y < PREVIEW.height; y++) for (let x = 0; x < PREVIEW.width; x++) {
    const i = y * PREVIEW.width + x, h = level(i), tile = p.tiles[i]!;
    const slope = h - level(y * PREVIEW.width + Math.max(0, x - 1)) + h - level(Math.max(0, y - 1) * PREVIEW.width + x);
    const light = tile === 1 || tile === 8 ? 1 : Math.max(.48, Math.min(1.42, .86 + h * .018 - slope * .065));
    const color = (palette[tile] ?? palette[3]!).map(c => Math.round(Math.min(255, c * light))).join(",");
    let path = paths.get(color); if (!path) paths.set(color, (path = [])); path.push(`M${x} ${y}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PREVIEW.width} ${PREVIEW.height}" shape-rendering="crispEdges">${[...paths].map(([c, d]) => `<path fill="rgb(${c})" d="${d.join("")}"/>`).join("")}<path d="M${PREVIEW.width / 2} ${PREVIEW.height / 2 - 2}v4m-2-2h4" stroke="#fff8d5" stroke-width=".5"/></svg>`;
}
