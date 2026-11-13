/**
 * Textured terrain: Art & Assets' tile atlas (64x48 cells = 64x32 top diamond + 16 px camera-facing skirt) drawn as
 * chunk-cached instanced sprites on top of the vertex-colour terrain mesh (which still provides cliff faces for
 * drops > 1 level and fills AA seams). Animated tiles (water, shore) animate by frame offset in the shader.
 * Shore tiles are chosen from the 4/8-neighbourhood (TERRAIN rules below). Ground-plane depth like flat decals.
 * Surface overlays (wet ground, puddles, snow cover) are applied on top in the same shader.
 * ADR-246: with the `gt_` ground set resident (groundArt.ts) each cell is several instances in draw order (base variant,
 * blob-47 edge overlays by priority, shore/bank, water or winter ice, fall leaves) sharing the cell's ground depth
 * (LEQUAL: later instances win); 68x52 cells anchored at (34, 18). The legacy tile_* path draws until the season's
 * pages are resident (no hole while streaming).
 * ADR-253 view rotation: instances are built in view space (cell (X, Y) of the rotated grid; neighbourhood rules, skirts,
 * shore/edge blob masks and corner tints all see view-space neighbours, so the screen-relative art stays correct), one
 * cached instance buffer per view quarter; vWorld is rotated back to world space for the surface noise / shimmer.
 * ADR-256: `grazedAt(tx,ty)` swaps grass bases for `gt_grass_grazed` (+ seasonal twin) when a GrazedTile is present.
 */
import { CHUNK_SIZE, VIEW_COS, VIEW_SIN, viewRect, renderTileHeight, waterShoreTint, waterCornerTint, type TileMap, type Chunk, type IsoConfig } from "@engine/world";
import { SEASON_GROUND_GLSL } from "./season.js";
import { terrainDropEdges, DROP_EDGE_GLSL } from "./dropEdges.js";
import { createProgram, GLSL_COMMON, type FrameStats, type Program } from "./gl/util.js";
import { WATERFALL_MIN_DROP } from "./tilemap.js";
import type { AtlasManager } from "./assets/atlasManager.js";
import type { Rect } from "./camera.js";
import { TileId, TERRAIN_SPRITES, isWaterTile } from "./ids.js";
import { GroundArt, GroundLayerKind, groundHash, groundLayers, groundMaterial, groundSideKey, groundSideLevels, type GroundLayer } from "./groundArt.js";
import type { SurfaceState, SurfaceProvider } from "./tilemap.js";

const FLOATS = 16;
const VS = /* glsl */ `#version 300 es
precision highp float; precision highp int;
layout(location=0) in vec4 aA; // x, y, z, entry
layout(location=1) in vec4 aB; // count, fps, skirtMask (1 = +x side, 2 = +y side), phase
layout(location=2) in vec4 aC; // ax, ay, water, art (ADR-246: 0 legacy tile, 1 gt land, 2 gt decal: ice / leaves / shore)
layout(location=3) in vec4 aD; // water: corner tints; land: ADR-276 drop depths (+u,+v,-u,-v), same 16-float stride
${GLSL_COMMON}
uniform highp sampler2D uFrames;
uniform vec3 uIso; uniform float uZFactor, uTime;
uniform vec2 uRot; // ADR-253 view rotation (cos, sin): instances are view-space; vWorld rotates back for the world-anchored noise
out vec2 vView;
out vec3 vUvRaw; flat out int vLayer; flat out vec4 vRect; out vec2 vLocal; out vec2 vWorld; flat out vec4 vInfo; flat out vec4 vCorn; flat out vec2 vOrg; flat out vec3 vArt; flat out float vKey; // vInfo: w, h, skirtMask, water; vArt: anchor px, art mode
void main() {
  int frames = max(1, int(aB.x + 0.5));
  int entry = int(aA.w + 0.5) + int(mod(floor(uTime * aB.y + aB.w), float(frames)));
  ivec2 tc = ivec2((entry % 1024) * 2, entry / 1024);
  vec4 uvr = texelFetch(uFrames, tc, 0); vec4 dim = texelFetch(uFrames, tc + ivec2(1, 0), 0);
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 px = c * dim.xy; // frame px
  vUvRaw = vec3(mix(uvr.xy, uvr.zw, c), dim.z); vLayer = int(dim.z + 0.5); vRect = uvr; vLocal = px; vInfo = vec4(dim.xy, aB.z, aC.z); vCorn = aD; vOrg = aA.xy - 0.5; vArt = aC.xyw;
  vec2 pivot = vec2((aA.x - aA.y) * uIso.x, (aA.x + aA.y) * uIso.y - aA.z * uIso.z); // tile centre
  vec2 iso = pivot + px - aC.xy;
  // world position (for overlays) of the ground point under this pixel
  vec2 d = (px - aC.xy) / uIso.xy; vView = vec2(aA.x, aA.y) + vec2(d.x + d.y, d.y - d.x) * 0.5;
  vWorld = vec2(uRot.x * vView.x + uRot.y * vView.y, -uRot.y * vView.x + uRot.x * vView.y);
  float hp = aC.y - px.y; // px above pivot
  float key = aA.x + aA.y + aA.z * uZFactor + 0.004 - max(hp, -uIso.y) / uIso.y; // ground plane; skirt clamped to the front corner
  vKey = aA.x + aA.y + aA.z * uZFactor + 0.004;
  gl_Position = vec4(isoToClip(iso), keyToNdc(key), 1.0);
}`;
const FS = /* glsl */ `#version 300 es
precision highp float; precision highp int;
in vec2 vView; in vec3 vUvRaw; flat in int vLayer; flat in vec4 vRect; in vec2 vLocal; in vec2 vWorld; flat in vec4 vInfo; flat in vec4 vCorn; flat in vec2 vOrg; flat in vec3 vArt; flat in float vKey;
uniform vec2 uDepth;
uniform highp sampler2DArray uAtlas;
#define vUv vec3(vUvRaw.xy, float(vLayer)) // flat int array layer (no interpolated layer index)
uniform vec3 uIso; uniform float uTime, uWet, uSnow, uPuddles, uWetDarken, uIce, uArtSnow; uniform vec3 uSkyRefl, uSeason;
layout(location=0) out vec4 oColor; layout(location=1) out vec4 oEmissive;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
${SEASON_GROUND_GLSL}
${DROP_EDGE_GLSL}
// Sharp bilinear, same as the sprite shader's crispUv (ADR-145): ground was the one world surface with no
// crisp path at all -- plain LINEAR magnification of a 68x52 cell at ~3x phone scale is the smeared ground
// in the screenshot, on every preset. Minified (>= 1 texel/px) it is a no-op, so zoomed-out ground is unchanged.
vec3 crispUv(vec3 uv, vec2 w) {
  vec2 sz = vec2(textureSize(uAtlas, 0).xy);
  vec2 p = uv.xy * sz, d = w * sz; if (max(d.x, d.y) >= 1.0) return uv;
  vec2 f = fract(p) - 0.5; p = floor(p) + 0.5 + clamp(f / max(d, vec2(1e-4)), -0.5, 0.5); return vec3(p / sz, uv.z);
}
void main() {
  vec2 uv = clamp(crispUv(vec3(vUv.xy, vUv.z), fwidth(vUv.xy)).xy, vRect.xy, vRect.zw);
  vec4 t = texture(uAtlas, vec3(uv, vUv.z));
  if (t.a < 0.5) discard;
  // ADR-249: per-pixel ground-plane depth. The clamp (skirt = front-corner key) is not linear over the frame quad, so the
  // per-vertex key interpolated to ~0.35 tile behind the true ground plane mid-diamond: the vertex-colour mesh won the
  // depth test almost everywhere (hid gt water/land art; only small triangles near the front corners showed).
  { float hp = vArt.y - vLocal.y; float key = vKey - max(hp, -uIso.y) / uIso.y;
    gl_FragDepth = 0.5 + 0.5 * (1.0 - 2.0 * clamp((key - uDepth.x) * uDepth.y, 0.0, 1.0) * 0.999); }
  // skirt pixels (below the diamond): keep only on sides whose neighbour is lower
  float tw = uIso.x * 2.0, th = uIso.y * 2.0;
  vec2 q = vLocal - vArt.xy; // diamond centre = the cell anchor (legacy 32,16; gt 34,18)
  bool inDiamond = abs(q.x) / uIso.x + abs(q.y) / uIso.y <= 1.02;
  int mask = int(vInfo.z + 0.5);
  if (!inDiamond && q.y > 0.0) { bool right = q.x > 0.0; if (right ? (mask & 1) == 0 : (mask & 2) == 0) discard; }
  vec3 c = t.rgb;
  if (vInfo.w > 0.5) { // ADR-184: smooth per-pixel shore->deep gradient (bilinear corner tints; continuous across tiles)
    vec2 f = clamp(vView - vOrg, 0.0, 1.0); // view-space cell + view-ordered corner tints
    float k = mix(mix(vCorn.x, vCorn.y, f.x), mix(vCorn.w, vCorn.z, f.x), f.y); k = smoothstep(0.0, 1.0, k);
    if (int(vArt.z + 0.5) == 1) { // ADR-251: gt_water carries its full baked colour: no tint palette, no doubled detail
      // (detail = c - lum is zeroed); shore -> deep is a brightness ramp only (deep x0.80, shallow x1.06) + slow shimmer
      float sh = 0.035 * sin(dot(vWorld, vec2(1.3, 0.9)) - uTime * 1.1) * sin(dot(vWorld, vec2(-0.6, 1.7)) * 0.8 + uTime * 0.7);
      c = clamp(c * mix(0.80, 1.06, k) + sh, 0.0, 1.0);
    } else { // legacy grey tile_water: tint palette + art detail
      float lum = dot(c, vec3(0.299, 0.587, 0.114)); vec3 detail = c - vec3(lum);
      vec3 deep = vec3(0.09, 0.27, 0.56) + detail * 0.7 + (lum - 0.45) * 0.35;
      vec3 shallow = vec3(0.36, 0.82, 0.82) + detail * 0.6 + (lum - 0.45) * 0.4;
      c = mix(deep, shallow, k);
    }
    c = seasonIce(c, vWorld, uIce, k); // ADR-239: winter ice (shallows freeze first)
  }
  if (vInfo.w < -0.5) { // ADR-249: gt_ice decal (water = -1): lift the dark diamond outline so frozen water reads as one sheet
    float rim = smoothstep(0.8, 1.0, abs(q.x) / uIso.x + abs(q.y) / uIso.y); c = mix(c, max(c, vec3(0.72, 0.85, 0.95)), rim * 0.85);
  }
  int art = int(vArt.z + 0.5);
  if (vInfo.w < 0.5 && art == 0) c = seasonGround(c, vWorld, uSeason); // ADR-239 (skirts too, so cliff faces match); gt art is seasonal already
  if (inDiamond && vInfo.w < 0.5 && art < 2) {
    float m = vnoise(vWorld * 0.9) * 0.65 + vnoise(vWorld * 3.1 + 11.0) * 0.35;
    if (uWet > 0.001) {
      c *= mix(1.0, uWetDarken, uWet);
      float pud = smoothstep(1.0 - 0.45 * uWet * uPuddles, 1.04 - 0.45 * uWet * uPuddles, m);
      float ripple = 0.5 + 0.5 * sin(length(fract(vWorld * 2.0) - 0.5) * 40.0 - uTime * 8.0);
      c = mix(c, uSkyRefl * (0.85 + 0.15 * ripple), pud * 0.65);
    }
    c = seasonSnow(c, vWorld, m, art == 1 ? uArtSnow : max(uSnow, uSeason.z)); // weather snow + ADR-239 winter snowpack (ADR-246: turned down on gt art)
  }
  // ADR-276: the old mesh lip is UNDER this opaque art. Shade the actual textured high surface,
  // after snow / puddles so the rim survives weather. vCorn is depths only on land, never water / ice.
  if (inDiamond && vInfo.w == 0.0 && any(greaterThan(vCorn, vec4(0.5)))) {
    vec2 cell = vView - vOrg;
    if (all(greaterThanEqual(cell, vec2(0.0))) && all(lessThanEqual(cell, vec2(1.0))))
      c = terrainDropRelief(c, cell, vCorn);
  }
  oColor = vec4(c, 1.0); oEmissive = vec4(0.0);
}`;

interface TileChunk { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; count: number; stamp: number; cx: number; cy: number; maxZ: number; minZ: number; atlasVersion: number; art: number }

/** ADR-253: view cell (X, Y) of quarter q -> its world tile (inverse of viewRect on a unit cell). */
export function viewCellToTile(X: number, Y: number, q: number): { x: number; y: number } {
  switch (q & 3) { case 1: return { x: Y, y: -X - 1 }; case 2: return { x: -X - 1, y: -Y - 1 }; case 3: return { x: -Y - 1, y: X }; default: return { x: X, y: Y }; }
}

/** ADR-246: procedural snow on gt_ land. Winter art already paints the snowpack, so only fresh weather snow shows
 *  (x0.35, no seasonal floor); summer/fall art keeps weather snow + the seasonal floor (fall -> winter ramp). */
export const gtSnow = (art: number, weatherSnow: number, seasonFloor: number): number => art === 3 ? weatherSnow * 0.35 : Math.max(weatherSnow, seasonFloor);

export class TileTerrain {
  private prog: Program;
  /** ADR-253: per view quarter (built lazily; the two adjacent views are prewarmed one chunk per frame). */
  private views: Map<Chunk, TileChunk>[] = [new Map(), new Map(), new Map(), new Map()];
  /** Chunk builds this frame (tests / diag). */
  builds = 0;
  /** ADR-239: fall, winter, ground snow floor, ice (seasonVisual). */
  season: [number, number, number, number] = [0, 0, 0, 0];
  /** ADR-246: dominant season art (SeasonVisual.art: 0 summer, 1 fall, 2 winter) for the gt_ ground set. */
  groundSeason = 0;
  /** ADR-246: false = always the legacy tile_* art (tests / diag). */
  groundArt = true;
  /** ADR-256: world-tile grazed lookup (tx, ty); undefined = draw ungrazed grass. */
  grazedAt: ((tx: number, ty: number) => boolean) | undefined;
  /** ADR-256: bumped when the grazed set changes so chunk caches rebuild. */
  grazedRev = 0;
  private gart: GroundArt | null = null; private gartReg: unknown = null;
  private held: readonly number[] = []; private heldSeason = -1; private pend: readonly number[] = []; private pendSeason = -1;
  /** ADR-253: build the two adjacent view quarters' chunks in idle frames (one chunk per frame without other builds). */
  prewarm = true;
  /** Ground art mode the chunks are built for: 0 legacy, 1 + season = gt (diag / tests). */
  artMode = 0;
  constructor(private gl: WebGL2RenderingContext, private iso: IsoConfig, private zFactor: number) { this.prog = createProgram(gl, VS, FS, "terrain-tiles"); }

  /** True when the registry has at least the base terrain sprites. */
  static available(atlas: AtlasManager): boolean {
    const reg = atlas.registry; if (!reg) return false;
    return reg.ids.sprites.tryId("tile_grass") !== undefined && reg.ids.sprites.tryId("tile_water") !== undefined && atlas.animEntries(reg.ids.sprites.id("tile_grass"))!.h >= 32;
  }

  private stamp(map: TileMap, c: Chunk): number {
    let s = c.version;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const n = map.getChunk(c.cx + dx, c.cy + dy); s = (Math.imul(s, 31) + (n ? n.version + 1 : 0)) | 0; }
    return (Math.imul(s, 31) + (this.grazedRev | 0)) | 0; // ADR-256: rebuild when GrazedTile set changes
  }

  /** ADR-246: the gt_ set for this atlas's registry (null = not shipped). */
  ground(atlas: AtlasManager): GroundArt | null {
    const reg = atlas.registry; if (!reg) return null;
    if (this.gartReg !== reg) { this.gartReg = reg; const g = new GroundArt(reg); this.gart = g.available ? g : null; this.held.forEach((id) => atlas.releaseSprite(id)); this.pend.forEach((id) => atlas.releaseSprite(id)); this.held = []; this.pend = []; this.heldSeason = this.pendSeason = -1; }
    return this.gart;
  }
  /** Keeps the current season's gt pages retained (requested; never idle-evicted) and returns the art mode to build
   *  with: 1 + season once every page is resident, else 0 (legacy tile_* art while streaming). */
  private groundMode(atlas: AtlasManager): number {
    const g = this.groundArt ? this.ground(atlas) : null; if (!g) return 0;
    const s = Math.max(0, Math.min(3, this.groundSeason | 0)); atlas.groundPinSeason = (["summer", "fall", "winter", "spring"] as const)[s]!; // ADR-251: pinned at 1x on the next rebuild
    if (s === this.heldSeason && this.pendSeason >= 0) { this.pend.forEach((id) => atlas.releaseSprite(id)); this.pend = []; this.pendSeason = -1; }
    if (s !== this.pendSeason && s !== this.heldSeason) { this.pend.forEach((id) => atlas.releaseSprite(id)); this.pend = g.pageSprites(s); this.pend.forEach((id) => atlas.retainSprite(id)); this.pendSeason = s; }
    const ready = (ids: readonly number[]): boolean => { let ok = true; for (const id of ids) if (atlas.pageInfo(id).state !== "resident") { atlas.streamNear(id, true); ok = false; } return ok; };
    if (this.pendSeason === s && ready(this.pend)) { // swap: the new season's pages are all resident
      this.held.forEach((id) => atlas.releaseSprite(id)); this.held = this.pend; this.heldSeason = s; this.pend = []; this.pendSeason = -1;
    }
    if (this.heldSeason >= 0 && ready(this.held)) return 1 + this.heldSeason; // previous season's art until the swap
    return 0;
  }

  private build(map: TileMap, c: Chunk, atlas: AtlasManager, old: TileChunk | undefined, art: number, q = 0): TileChunk {
    this.builds++;
    const gl = this.gl; const reg = atlas.registry!;
    const ent = new Map<string, ReturnType<AtlasManager["animEntries"]>>();
    const E = (key: string): ReturnType<AtlasManager["animEntries"]> => {
      if (!ent.has(key)) { const id = reg.ids.sprites.tryId(key); ent.set(key, id === undefined ? null : atlas.animEntries(id)); }
      return ent.get(key)!;
    };
    const eid = new Map<number, ReturnType<AtlasManager["animEntries"]>>();
    const EI = (id: number): ReturnType<AtlasManager["animEntries"]> => { if (id < 0) return null; if (!eid.has(id)) eid.set(id, atlas.animEntries(id)); return eid.get(id)!; };
    const g = art ? this.ground(atlas) : null; const L: GroundLayer[] = []; const SL: { level: number; mask: number }[] = [];
    // ADR-253: everything below sees the view-space grid of quarter q (X, Y); wx / wy map a view cell to its world tile.
    const wx = (X: number, Y: number): number => (q === 0 ? X : q === 1 ? Y : q === 2 ? -X - 1 : -Y - 1);
    const wy = (X: number, Y: number): number => (q === 0 ? Y : q === 1 ? -X - 1 : q === 2 ? -Y - 1 : X);
    const tileAt = (X: number, Y: number): number => map.getTile(wx(X, Y), wy(X, Y));
    const hAt = (X: number, Y: number): number => { const x = wx(X, Y), y = wy(X, Y); const ch = map.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)); if (!ch) return -99; const i = (((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE) * CHUNK_SIZE + (((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE); return ch.tiles[i] === 0 ? -99 : renderTileHeight(ch.tiles[i]!, ch.height[i]!) - (isWaterTile(ch.tiles[i]!) ? 0.25 : 0); };
    const tm = new Map<number, number>(); const tintAt = (x: number, y: number): number => { const k = x * 65536 + y; let v = tm.get(k); if (v === undefined) tm.set(k, (v = waterShoreTint(tileAt, x, y))); return v; };
    const cT = (x: number, y: number): number => waterCornerTint(tileAt, x, y, tintAt);
    const data: number[] = []; let minZ = 1e9, maxZ = -1e9;
    const ox = c.cx * CHUNK_SIZE, oy = c.cy * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const i = ly * CHUNK_SIZE + lx; const id = c.tiles[i]!; if (id === 0) continue;
      const tx = ox + lx, ty = oy + ly; const water = isWaterTile(id); // world tile
      const x = q === 0 ? tx : q === 1 ? -ty - 1 : q === 2 ? -tx - 1 : ty, y = q === 0 ? ty : q === 1 ? tx : q === 2 ? -ty - 1 : -tx - 1; // its view cell
      const z = renderTileHeight(id, c.height[i]!) - (water ? 0.25 : 0); // ADR-182: one flat water surface
      const pu = hAt(x + 1, y), pv = hAt(x, y + 1);
      const drops = water ? [0, 0, 0, 0] : terrainDropEdges(z, pu, pv, hAt(x - 1, y), hAt(x, y - 1));
      // ADR-386: on a waterfall face (a water tile dropping >= 2 levels to a neighbour that exists)
      // the skirt is suppressed, so the animated mesh falls face shows in full (32 px for a 2-level
      // drop); a 1-level ledge keeps its skirt (it covers the 1-level mesh face, as before), and a
      // missing neighbour keeps its skirt too (the mesh face there runs to the void, not a falls).
      const dropX = pu > -99 ? z - pu : 0, dropY = pv > -99 ? z - pv : 0;
      const mask = (pu < z && !(water && dropX >= WATERFALL_MIN_DROP) ? 1 : 0) | (pv < z && !(water && dropY >= WATERFALL_MIN_DROP) ? 2 : 0);
      if (art && g) { // ADR-246: gt_ layers (base, edges by priority, shore/bank | water or ice, leaves)
        const grazed = this.grazedAt ? (X: number, Y: number): boolean => this.grazedAt!(wx(X, Y), wy(X, Y)) : undefined;
        groundLayers(tileAt, x, y, art - 1, tintAt, L, groundHash(tx, ty), grazed); let n = 0;
        for (const l of L) {
          const e = EI(g.id(l.key)); if (!e) continue; const wl = l.kind === GroundLayerKind.Water;
          const mode = l.kind === GroundLayerKind.Ice || l.kind === GroundLayerKind.Leaves ? 2 : 1;
          data.push(x + 0.5, y + 0.5, z, e.first, e.count, e.fps, mask, 0, e.ax, e.ay, wl ? 1 : l.kind === GroundLayerKind.Ice ? -1 : 0, mode, ...(wl ? [cT(x, y), cT(x + 1, y), cT(x + 1, y + 1), cT(x, y + 1)] : l.kind === GroundLayerKind.Ice ? [0, 0, 0, 0] : drops)); n++;
        }
        // ADR-251: gt_side faces where a +x / +y neighbour is lower, one per level of drop (left half +y, right half +x;
        // the shader's skirt rule keeps the half whose mask bit is set). Drawn over the polygon-offset mesh cliff, which
        // stays the fallback (no gt_side art, void neighbours, drops deeper than GROUND_SIDE_MAX_LEVELS).
        const mat = water ? undefined : groundMaterial(id);
        if (n && mat && mat !== "water" && mask) for (const sl of groundSideLevels(z, pu, pv, SL)) {
          const e = EI(g.id(groundSideKey(mat, art - 1, sl.level))); if (!e) break;
          data.push(x + 0.5, y + 0.5, z - sl.level, e.first, e.count, e.fps, sl.mask, 0, e.ax, e.ay, 0, 1, 0, 0, 0, 0); n++;
          minZ = Math.min(minZ, z - sl.level);
        }
        if (n) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); continue; }
      }
      // Task 21: legacy path draws plain sand next to water. The old tile_shore_* sprites (like the gt_shore_*
      // overlays) paint a blue water strip over the sand cell, which is the reported "line of water on top of
      // the shore"; the mesh cliff + side faces already mark the transition, so no shore sprite is used here.
      let key: string | undefined;
      const variants = TERRAIN_SPRITES[water ? TileId.Water : id] ?? TERRAIN_SPRITES[TileId.Dirt]!; // ADR-182: all water shares one art; depth = tint
      const hsh = ((Math.imul(tx, 374761393) ^ Math.imul(ty, 668265263)) >>> 0) % 997; // world tile: variants stay put on rotation
      let e = key ? E(key) : null;
      if (!e) e = E(variants[hsh % variants.length]!) ?? E(variants[0]!);
      if (!e) continue;
      data.push(x + 0.5, y + 0.5, z, e.first, e.count, e.fps, mask, 0, e.ax, e.ay, water ? 1 : 0, 0, ...(water ? [cT(x, y), cT(x + 1, y), cT(x + 1, y + 1), cT(x, y + 1)] : drops));
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const vao = old?.vao ?? gl.createVertexArray()!; const vbo = old?.vbo ?? gl.createBuffer()!;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    for (let a = 0; a < 4; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 4, gl.FLOAT, false, FLOATS * 4, a * 16); gl.vertexAttribDivisor(a, 1); }
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / FLOATS, stamp: this.stamp(map, c), cx: c.cx, cy: c.cy, minZ, maxZ, atlasVersion: atlas.version, art };
  }

  private fresh(map: TileMap, c: Chunk, atlas: AtlasManager, t: TileChunk | undefined, art: number): t is TileChunk {
    return !!t && t.stamp === this.stamp(map, c) && t.atlasVersion === atlas.version && t.art === art;
  }

  /** ADR-267: synchronously prepare the destination quarter before any of it is presented. */
  prepareView(map: TileMap, atlas: AtlasManager, activeKeys?: ReadonlySet<string>): void {
    const q = (this.iso.view ?? 0) & 3, art = this.groundMode(atlas), cur = this.views[q]!;
    for (const c of map.loadedChunks()) {
      if (activeKeys && !activeKeys.has(c.key)) continue;
      const old = cur.get(c); if (!this.fresh(map, c, atlas, old, art)) cur.set(c, this.build(map, c, atlas, old, art, q));
    }
  }

  draw(map: TileMap, atlas: AtlasManager, view: Float32Array, depth: Float32Array, rect: Rect, time: number, stats: FrameStats,
    surface: SurfaceState, perChunk: SurfaceProvider | undefined, sstyle: { puddles: number; wetDarken: number; skyRefl: readonly number[] }, activeKeys?: ReadonlySet<string>): void {
    if (!atlas.tex || !atlas.frameTex) return;
    const gl = this.gl; const { u } = this.prog; const hw = this.iso.tileW / 2, hh = this.iso.tileH / 2, S = CHUNK_SIZE;
    gl.useProgram(this.prog.prog);
    gl.uniform4fv(u.uView ?? null, view); gl.uniform2fv(u.uDepth ?? null, depth);
    gl.uniform3f(u.uIso ?? null, hw, hh, this.iso.zStep); gl.uniform1f(u.uZFactor ?? null, this.zFactor); gl.uniform1f(u.uTime ?? null, time);
    gl.uniform3f(u.uSeason ?? null, this.season[0], this.season[1], this.season[2]); gl.uniform1f(u.uIce ?? null, this.season[3]);
    gl.uniform1f(u.uPuddles ?? null, sstyle.puddles); gl.uniform1f(u.uWetDarken ?? null, sstyle.wetDarken);
    gl.uniform3f(u.uSkyRefl ?? null, sstyle.skyRefl[0]!, sstyle.skyRefl[1]!, sstyle.skyRefl[2]!);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.tex); gl.uniform1i(u.uAtlas ?? null, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlas.frameTex); gl.uniform1i(u.uFrames ?? null, 1);
    const art = this.groundMode(atlas); this.artMode = art; this.builds = 0;
    const q = (this.iso.view ?? 0) & 3; const cur = this.views[q]!; gl.uniform2f(u.uRot ?? null, VIEW_COS[q]!, VIEW_SIN[q]!);
    let warm: Chunk | undefined; // ADR-253: one adjacent-view chunk prewarmed per frame (rotation then swaps without a build hitch)
    for (const c of map.loadedChunks()) {
      if (activeKeys && !activeKeys.has(c.key)) continue;
      const vr = viewRect(c.cx * S, c.cy * S, S, S, q); const x0 = vr.x, y0 = vr.y;
      const sxMin = (x0 - (y0 + S)) * hw - hw, sxMax = (x0 + S - y0) * hw + hw;
      const syMin = (x0 + y0) * hh - 16 * this.iso.zStep, syMax = (x0 + y0 + 2 * S) * hh + 2 * hh;
      if (sxMax < rect.x0 || sxMin > rect.x1 || syMax < rect.y0 || syMin > rect.y1) continue;
      let t = cur.get(c);
      if (!this.fresh(map, c, atlas, t, art)) { t = this.build(map, c, atlas, t, art, q); cur.set(c, t); }
      if (!warm && this.prewarm && (!this.fresh(map, c, atlas, this.views[(q + 1) & 3]!.get(c), art) || !this.fresh(map, c, atlas, this.views[(q + 3) & 3]!.get(c), art))) warm = c;
      if (!t.count) continue;
      const sf = perChunk?.(c.key) ?? surface;
      gl.uniform1f(u.uWet ?? null, sf.wet); gl.uniform1f(u.uSnow ?? null, sf.snow);
      gl.uniform1f(u.uArtSnow ?? null, gtSnow(art, sf.snow, this.season[2]));
      gl.bindVertexArray(t.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, t.count); stats.drawCalls++;
    }
    if (warm && this.builds === 0) for (const k of [(q + 1) & 3, (q + 3) & 3]) {
      const m = this.views[k]!, t = m.get(warm); if (!this.fresh(map, warm, atlas, t, art)) { m.set(warm, this.build(map, warm, atlas, t, art, k)); break; }
    }
    gl.bindVertexArray(null);
    for (const m of this.views) for (const [c, t] of m) if (map.getChunk(c.cx, c.cy) !== c) { gl.deleteBuffer(t.vbo); gl.deleteVertexArray(t.vao); m.delete(c); }
  }
}
