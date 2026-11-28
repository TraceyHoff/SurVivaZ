/** Cheap seed survey: the exact generator's tile and height samplers, never full chunks/entities.
 * North-up, 1536 x 1536 tiles around the four starter areas (ADR-423: was 512 x 512); not a promise
 * that it shows the entire streamed world. Stride 12 keeps the sample count at 128 x 128 = 16,384 —
 * the same SVG path count and menu-render cost as before, at 3x coarser ground per pixel.
 * ADR-585: the survey is zoomable — the same fixed 128 x 128 sample grid is taken at a ladder of
 * strides centred on the spawn area, so zooming out surveys more of the (endless) world at coarser
 * detail and zooming in surveys less of it finer, at exactly the same sampling cost per render. */
import { northUpToWorld, worldToNorthUp } from "./geography.js";
import { ProceduralGenerator } from "./generator.js";
import { terrainLevel } from "./waterDepth.js";
/** Origin and stride are geographic east/south tile units, not world-grid axes.
 * The square covers the previous 384x256 world-grid footprint after rotation, at the same sample density. */
export const PREVIEW = { width: 128, height: 128, stride: 12, x: -768, y: -768 } as const;
/** ADR-585: survey strides (tiles per sample) for the world-generation map, finest to widest.
 * Extent across = PREVIEW.width x stride: 384 / 768 / 1536 / 3072 / 6144 tiles. The ladder stops
 * at 48: past that the generator's per-tile feature derivation (river networks, massifs,
 * canyons — memoised per region with a cap of 16 regions) makes even the 16,384-sample relief
 * sweep take seconds, and the ruin enumeration minutes-scale sweeps; a wider survey wants a
 * chunk-amortised sampler the generator does not have yet. */
export const SURVEY_STRIDES: readonly number[] = [3, 6, 12, 24, 48];
export interface WorldPreview { seed: number; tiles: Uint16Array; heights: Int16Array; /** ADR-585: tiles per sample (default PREVIEW.stride). */ stride?: number; /** ADR-585: geographic origin of sample (0,0) (default PREVIEW.x / PREVIEW.y). */ x?: number; y?: number }
/** World tile sampled by a thumbnail pixel; also the inverse/picking contract for preview consumers. */
export function previewWorldAt(x: number, y: number): { x: number; y: number } {
  const w = northUpToWorld(PREVIEW.x + x * PREVIEW.stride, PREVIEW.y + y * PREVIEW.stride);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}
/** ADR-585: world tile sampled by a survey pixel of `p` (stride/origin-aware previewWorldAt). */
export function surveyWorldAt(p: WorldPreview, x: number, y: number): { x: number; y: number } {
  const w = northUpToWorld((p.x ?? PREVIEW.x) + x * (p.stride ?? PREVIEW.stride), (p.y ?? PREVIEW.y) + y * (p.stride ?? PREVIEW.stride));
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}
/** ADR-585: survey pixel of a world tile (inverse of surveyWorldAt, unfloored so markers can sit
 * between pixels). Pixels outside [0, PREVIEW.width) x [0, PREVIEW.height) are off the survey. */
export function worldToSurveyPixel(p: WorldPreview, wx: number, wy: number): { px: number; py: number } {
  const s = p.stride ?? PREVIEW.stride, g = worldToNorthUp(wx, wy);
  return { px: (g.x - (p.x ?? PREVIEW.x)) / s, py: (g.y - (p.y ?? PREVIEW.y)) / s };
}
export function sampleWorldPreview(seed: number): WorldPreview {
  const g = new ProceduralGenerator({ seed }); const tiles = new Uint16Array(PREVIEW.width * PREVIEW.height), heights = new Int16Array(tiles.length);
  for (let y = 0; y < PREVIEW.height; y++) for (let x = 0; x < PREVIEW.width; x++) {
    const i = y * PREVIEW.width + x, { x: tx, y: ty } = previewWorldAt(x, y);
    const sample = g.sampleAt(tx, ty); tiles[i] = sample.tile; heights[i] = sample.height;
  }
  return { seed, tiles, heights };
}
/** ADR-585: sample the 128 x 128 survey grid at `stride` tiles per sample, centred on the spawn
 * area (geographic origin = -extent/2 on both axes, so the origin — and the four spawn points
 * around it — stay centred at every zoom). Accepts a seed or a live generator (the menu reuses
 * one generator across zooms and for the spawn-point computation). Same 16,384 samples as
 * sampleWorldPreview at any stride. */
export function sampleWorldSurvey(source: number | ProceduralGenerator, stride: number): WorldPreview {
  const g = typeof source === "number" ? new ProceduralGenerator({ seed: source }) : source;
  const seed = typeof source === "number" ? source : g.opts.seed;
  const origin = -(PREVIEW.width * stride) / 2;
  const tiles = new Uint16Array(PREVIEW.width * PREVIEW.height), heights = new Int16Array(tiles.length);
  const p: WorldPreview = { seed, tiles, heights, stride, x: origin, y: origin };
  for (let y = 0; y < PREVIEW.height; y++) for (let x = 0; x < PREVIEW.width; x++) {
    const i = y * PREVIEW.width + x, { x: tx, y: ty } = surveyWorldAt(p, x, y);
    const sample = g.sampleAt(tx, ty); tiles[i] = sample.tile; heights[i] = sample.height;
  }
  return p;
}
/** ADR-585: map markers in survey pixels (see worldToSurveyPixel). Spawns = the seed's spawn
 * points; ruins = abandoned-structure sites (ADR-586). Drawn over the relief.
 * ADR-589: selectedSpawn = index into spawns of the player's chosen start; it is overdrawn
 * in yellow so the choice reads at a glance. Absent = no selection shown (legacy output). */
export interface PreviewMarkers { spawns?: readonly { px: number; py: number }[]; ruins?: readonly { px: number; py: number }[]; selectedSpawn?: number }
/** Compact SVG relief image; dedicated data visualization, no borrowed item/terrain sprites or external assets. */
export function worldPreviewSvg(p: WorldPreview, markers?: PreviewMarkers): string {
  const palette: Record<number, readonly [number, number, number]> = { 1: [36, 102, 149], 2: [201, 180, 117], 3: [106, 147, 69], 4: [85, 114, 58], 5: [137, 137, 130], 6: [220, 229, 230], 7: [50, 89, 53], 8: [67, 153, 177], 9: [116, 99, 65] };
  const paths = new Map<string, string[]>();
  // ADR-383: shade by terrain level, not the stored height — elevated-lake water stores the ADR-263/411
  // flow encoding of its surface (raw 1000+, ADR-297 legacy raw 80+), which would otherwise paint a white halo on the shore pixels.
  const level = (i: number): number => terrainLevel(p.tiles[i]!, p.heights[i]!);
  for (let y = 0; y < PREVIEW.height; y++) for (let x = 0; x < PREVIEW.width; x++) {
    const i = y * PREVIEW.width + x, h = level(i), tile = p.tiles[i]!;
    const slope = h - level(y * PREVIEW.width + Math.max(0, x - 1)) + h - level(Math.max(0, y - 1) * PREVIEW.width + x);
    // ADR-530: relief light rescaled for the [-100, 100] range. The old height term (h x 0.018)
    // saturated at h >= 31 (light pinned at the 1.42 clamp, so all high ground washed out white);
    // h x 0.0038 puts a 100-level peak at 1.24 and a -100 floor at exactly the 0.48 floor, so the
    // height term alone never pins. The slope term is rescaled likewise (0.065 -> 0.008): 12-tile
    // preview steps are steeper on the new relief, and at 0.015 ~8% of land pixels still pinned
    // at a clamp; at 0.008 it is ~2%.
    const light = tile === 1 || tile === 8 ? 1 : Math.max(.48, Math.min(1.42, .86 + h * .0038 - slope * .008));
    const color = (palette[tile] ?? palette[3]!).map(c => Math.round(Math.min(255, c * light))).join(",");
    let path = paths.get(color); if (!path) paths.set(color, (path = [])); path.push(`M${x} ${y}h1v1h-1z`);
  }
  const relief = [...paths].map(([c, d]) => `<path fill="rgb(${c})" d="${d.join("")}"/>`).join("");
  if (!markers) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PREVIEW.width} ${PREVIEW.height}" shape-rendering="crispEdges">${relief}<path d="M${PREVIEW.width / 2} ${PREVIEW.height / 2 - 2}v4m-2-2h4" stroke="#fff8d5" stroke-width=".5"/></svg>`;
  // ADR-585/586 markers: amber diamonds for abandoned structures, ringed dots for spawn points.
  // Coordinates are rounded to 0.1 px so the data URI stays compact; off-survey markers are dropped.
  const on = (m: { px: number; py: number }): boolean => m.px >= -4 && m.px <= PREVIEW.width + 4 && m.py >= -4 && m.py <= PREVIEW.height + 4;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const ruins = (markers.ruins ?? []).filter(on);
  const ruinPath = ruins.map((m) => `M${r1(m.px)} ${r1(m.py - 2.6)}L${r1(m.px + 2.6)} ${r1(m.py)}L${r1(m.px)} ${r1(m.py + 2.6)}L${r1(m.px - 2.6)} ${r1(m.py)}Z`).join("");
  const spawns = (markers.spawns ?? []).filter(on);
  const rings = spawns.map((m) => `<circle cx="${r1(m.px)}" cy="${r1(m.py)}" r="3.4"/>`).join("");
  const dots = spawns.map((m) => `<circle cx="${r1(m.px)}" cy="${r1(m.py)}" r="1.1"/>`).join("");
  const selRaw = markers.selectedSpawn !== undefined ? (markers.spawns ?? [])[markers.selectedSpawn] : undefined;
  const sel = selRaw && on(selRaw) ? selRaw : undefined;
  const selRing = sel ? `<circle cx="${r1(sel.px)}" cy="${r1(sel.py)}" r="3.4"/>` : "";
  const selDot = sel ? `<circle cx="${r1(sel.px)}" cy="${r1(sel.py)}" r="1.1"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PREVIEW.width} ${PREVIEW.height}" shape-rendering="crispEdges">${relief}`
    + (ruinPath ? `<path fill="#ffb347" stroke="rgba(20,16,8,.6)" stroke-width=".3" d="${ruinPath}"/>` : "")
    + (rings ? `<g fill="none" stroke="rgba(20,16,8,.75)" stroke-width="1.1">${rings}</g><g fill="none" stroke="#fff8d5" stroke-width=".7">${rings}</g>` : "")
    + (dots ? `<g fill="#fff8d5">${dots}</g>` : "")
    + (sel ? `<g fill="none" stroke="#ffd23e" stroke-width="1.1">${selRing}</g><g fill="#ffd23e">${selDot}</g>` : "")
    + `</svg>`;
}
