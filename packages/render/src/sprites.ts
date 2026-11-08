/**
 * Sprite pipeline: gathers drawables from the ECS (Sprite+Transform, BuildPiece+Transform, optional
 * AnimState), resolves frames through the AtlasManager (one texture array -> one draw call),
 * interpolates PrevTransform->Transform, culls, and writes instances.
 *
 * - Dynamic sprites (characters, zombies, items, resources, ghosts, cut-away pieces): sorted back-to-
 *   front each frame (packed u32 key sort), one instanced draw.
 * - Static build pieces: per-chunk cached instance buffers, rebuilt only when a chunk's checksum
 *   changes; one instanced draw per visible chunk.
 * - Depth: per-vertex iso depth (billboards as vertical planes, Flat pieces on the ground plane) into
 *   the depth buffer, so terrain cliffs, walls and sprites interleave correctly. Multi-tile pieces are
 *   split into per-column slices, each keyed by its front-most footprint tile.
 */
import { fireAnimTime } from "./fire-anim.js";
import { SEASON_SPRITE_GLSL, SEASON_FOLIAGE, SEASON_SNOWCAP, SEASON_GROUND, SUMMER_VISUAL, SeasonArt, type SeasonVisual } from "./season.js";
import { AnimState as CoreAnimState, entityIndex, lerpAngle, PrevTransform, Transform, type ComponentDef, type World } from "@engine/core";
import { CHUNK_SIZE, VIEW_COS, VIEW_SIN, viewRect, chunkKey, floorToTerrainZ, terrainZToFloor, type BuildingGrid, type ChunkedSpatialIndex, type IsoConfig } from "@engine/world";
import { createProgram, GLSL_COMMON, type FrameStats, type Program } from "./gl/util.js";
import { Sprite, Shadow, Occluder, SpriteFlag, LightSource, TintSecondary, SpriteAlpha } from "./components.js";
import { newResolved, STREAM_MARGIN_PX, STREAM_MARGIN_ANIMAL_PX, STREAM_KEEP_FACTOR, type AtlasManager, type ResolvedFrame, type HandAnchor } from "./assets/atlasManager.js";
import { offHandAnchor, offHandBehind } from "./character/offhand.js";
import { CARRY_SOCKET, SEAT_SOCKET } from "./character/animChain.js";
/** ADR-244 (c): a sleeper shares the bed's footprint centre (same depth key); this nudge draws it after the bed. */
export const BED_SORT_EPS = 0.02;
/** ADR-241: carried sprite ids ride emitHeld's item slot as id + 1 (item 0 = none). */
const carriedId = (n: number): number => n - 1;
import type { Rect } from "./camera.js";
import type { StyleConfig } from "./style.js";
import type { TransformSource } from "./transformSource.js";
import type { VfxLayer } from "./vfx.js";
import { LayerCache, activeExpression, readAppearanceSlot, type AppearanceBinding, type CachedLayer } from "./character/layers.js";
import { nearestCutoff } from "./gl/fallback.js";
import { PRIO_NEAR } from "./gl/vram.js";
import { DeckNeighbors, rotSideMask, deckTopPx, pieceTieBreak, exactTieBreak, vertexPostGlBias, DECK_EDGE_EPS, DECK_SEAM_BAND, DECK_SEAM_SHIFT } from "./building/deckFaces.js";
import { crackAnim, lCornerArmPivots, PieceCoverIndex, pieceHiddenByStory, pieceShouldCutaway, ROT_EXACT_PIVOT, ROT_NO_OCCLUDE, ROT_DECK_LIFT, ROT_VERTEX_POST } from "./building/modular.js";
import { InteriorRoute, inInteriorRegion, interiorOrder, type InteriorRegion } from "./vehicles/interiorPass.js";

export const INSTANCE_FLOATS = 40;
/**
 * ADR-195: Flat (deck) pieces take ground-plane depth, so two same-level neighbours have EXACTLY equal depth on
 * every pixel they share (an edge strip / thickness face of one over the other's top) and z-fight. Each Flat instance
 * adds (pivotKey - keyMin) * FLAT_TIE_BREAK, so the piece further front always wins a shared pixel (<= ~0.05 key
 * over a whole screen: no effect on interleaving with characters, ~20x the 24-bit depth step).
 */
export const FLAT_TIE_BREAK = 2e-4;
/** CPU mirror of the vertex shader's Flat depth key (tests). */
export function flatDepthKey(pivotKey: number, hpPx: number, hh: number, keyMin: number): number {
  return pivotKey + 0.01 - hpPx / hh + (pivotKey - keyMin) * FLAT_TIE_BREAK;
}
/** Depth offset of held items vs the body (must exceed depth-key precision; < the next tile row). */
export const HELD_BIAS = 0.05;
/**
 * ADR-188: where a paper-doll layer's frame comes from this frame. `complete` = every layer the character should draw is
 * resident. Complete -> the current frame. Otherwise the character holds its last fully-composited look: a slot shows its
 * last good frame (`held`) unless the same piece is resident (keeps animating); a character never composited yet draws
 * what is resident (`partial`, first sight only). Never a mix of old and new outfit pieces, never a dropped slot that
 * has a held frame.
 */
export function layerSource(complete: boolean, rdy: boolean, heldSprite: number, heldReady: boolean, sprite: number): "current" | "held" | "partial" | "skip" {
  if (complete) return "current";
  if (rdy && heldSprite === sprite) return "current";
  if (heldSprite >= 0 && heldReady) return "held";
  if (rdy) return heldSprite >= 0 ? "current" : "partial";
  return "skip";
}
/** ADR-188: characters within this many px outside the draw margin prefetch their wardrobe/hair pages. */
export const PREFETCH_RING_PX = 768;
const PREFETCH_EVERY = 8;
/** ring requests rank just behind on-screen characters at the same distance */
const PREFETCH_PRIO_PAD = 64;
const OPEN = 1e5;
/** Swim fallback (ADR-107): fraction of the pivot height hidden below the waterline, and the bob amplitude in sprite px. */
const SWIM_CLIP = 0.45, SWIM_BOB_PX = 1.5;
/** ADR-242: body cold (0..1) above which characters puff fx_breath_puff even before they shiver (breath shows in cold air). */
export const COLD_BREATH = 0.4;
/** Depth-key step between a character's paper-doll layers (10 layers < HELD_BIAS; far below one tile = 1.0). */
export const LAYER_BIAS = 0.001;
/** Frame px of slack below the body cell for wear cells / outline that reach lower than the body (see paper-doll depth). */
const CHAR_DEPTH_MARGIN = 24;
/**
 * Paper-doll depth for a dressed character: footDy (sliceFootDy, o[15]) lifts every vertex above the below-pivot extent
 * so the shader's per-vertex max(hp + footDy, 0) never clamps (body / trimmed wear / held quads share one depth slope),
 * and the drawn key drops by footDy x zPerPx so the depth at and above the pivot equals the unlifted max(hp, 0) one.
 */
export function paperDollDepth(key: number, frameH: number, anchorY: number, scale: number, zPerPx: number): { footDy: number; key: number } {
  const footDy = (Math.max(0, frameH - anchorY) + CHAR_DEPTH_MARGIN) * scale; return { footDy, key: key - footDy * zPerPx };
}
/**
 * Depth key of the behind-wall silhouette (drawn with depth GREATER): in front of every paper-doll layer of its own
 * character (layers draw at key + j * LAYER_BIAS, nearer than the body), so it only passes where a real occluder wrote
 * depth nearer than the whole doll - never against the character's own wear/face/hair.
 */
export function silhouetteKey(bodyKey: number, layerCount: number): number { return bodyKey + (layerCount + 2) * LAYER_BIAS; }
/**
 * Task 21: final alpha of an explicit Occluder at smoothed occlusion amount `occT` (0 = clear, 1 = fully
 * covering the focus). It interpolates from opaque to the Occluder's own `fade` value — it does NOT divide by
 * (1 - styleAlpha): the old formula `1 - (1 - fade) * occT / (1 - styleAlpha)` evaluated to 0 at full occlusion
 * for the standard tree setup (fade 0.35, style alpha 0.35), so trees went fully invisible behind the player
 * instead of translucent. The shader's own mix(1, uOccAlpha, vOcc) does not apply here: explicit occluders
 * zero occT after this computation, so this value IS the final alpha. `fade` 1 (never-fade props) stays opaque.
 */
export function occluderFade(fade: number, occT: number): number {
  const t = Math.max(0, Math.min(1, occT)); return 1 - (1 - fade) * t;
}
/** Render-internal instance flag (above the u8 SpriteFlag range): draw only the outline ring of this frame. */
export const OUTLINE_ONLY = 256;
/** ADR-269: default character-only silhouette outline (union of body + worn layers): 1 atlas texel of dark plum, a
 *  little darker / more defined than the baked line art alone. Independent of the global StyleConfig.outline (off). */
export const CHARACTER_OUTLINE = { widthPx: 1, color: [0.08, 0.05, 0.09, 0.72] as const };
/** Render-internal instance flag: face/eyes paper-doll layer (mip bias, small contrast lift, partial darkness bypass; see characterOpts.face*). */
export const FACE_LAYER = 512;
/** Render-internal instance flag (ADR-145): crisp pixel-art sampling (sharp bilinear: texel-snapped UVs, 1 device px AA seam) when magnified. */
export const CRISP = 1024;
/** Paper-doll slots that carry the character's face: never crowd-LOD'd or dress-capped, drawn with FACE_LAYER. */
export const FACE_SLOTS: readonly string[] = ["face", "eyes"];

/** Gameplay-owned components the renderer reads (schemas as agreed with Survival Systems). */
export type BuildPieceDefT = ComponentDef<{ visualId: "u16"; variant: "u8"; tint: "u32"; damageStage: "u8"; rotation: "u8"; level: "u8"; layer: "u8"; ghost: "u8" }>;
export type AnimStateDefT = ComponentDef<{ state: "u8"; startTick: "u32" }>;
export type WetnessDefT = ComponentDef<{ level: "u8" }>;
export type BodyTempDefT = ComponentDef<{ cold: "u8"; heat: "u8"; shivering: "u8" }>;
/** Gameplay-owned components the renderer reads (injected; render does not depend on gameplay). Emitter/lit come from core. */
export interface GameplayBindings {
  buildPiece?: BuildPieceDefT; animState?: AnimStateDefT;
  /** Per-entity anim playback rate for an AnimState state (ADR-125 character walk vs. ground speed); undefined = 1. */
  animRate?: (entity: number, state: number) => number | undefined;
  /** ADR-241: per-entity anim chain for an AnimState state (character/animChain.ts animChainFor: weapon class, moving,
   *  driver, bed) given `elapsed` seconds in the state; undefined = the state's default chain (STATE_ANIMS). */
  animChain?: (entity: number, state: number, elapsed: number) => readonly string[] | undefined;
  /** ADR-241: sprite id carried in both arms (Carry state), drawn at the body frame's `carry` socket; undefined = none. */
  carriedSprite?: (entity: number) => number | undefined;
  /** ADR-244 (c): a sleeper's bed fit (sample.v2.json sleepLie.bedFits[piece][spot][rot], 1x px): the sleep_lie /
   *  sleep_lie_under frame's pivot lands on the bed footprint centre + (x, y), drawn just after (in front of) the bed. */
  bedFit?: (entity: number) => { x: number; y: number } | undefined;
  /** Wetness {level u8 0..255} (art's 0-3 intensity maps onto 0..255). */
  wetness?: WetnessDefT;
  /** BodyTemp {cold, heat u8; shivering 0/1}: shivering gates the shiver, cold scales it and drives the frost rim, heat drives flush. */
  bodyTemp?: BodyTempDefT;
  /** gameplay Burning {lit, intensity 0-255, startTick} on build pieces: fire/ember/smoke VFX (see burning.ts). */
  burning?: ComponentDef<{ lit: "u8"; intensity: "u8"; startTick: "u32" }>;
  /** gameplay Equipment {mainHandItem u16 (0 = empty)}: the item is drawn at the character frame's hand anchor (frameMeta handR via AssetRegistry.anchorPoint; legacy hands.json fallback). */
  equipment?: ComponentDef<{ mainHandItem: "u16"; mainHandSlot: { type: "u8"; default: number } }>;
  /** Item id -> held sprite id (`held_<item key>` in the `held` atlas); undefined = draw nothing. */
  heldSprite?: (itemId: number) => number | undefined;
  /** Task 25: per-entity dye colour (packed 0xRRGGBB) of the item in an inventory slot; undefined = undyed. The main-hand held sprite is multiplied by it (whole-sprite tint — held sprites have no tintmask). */
  heldDye?: (entity: number, slot: number) => number | undefined;
  /** ADR-135 replicated off-hand worn slot {offHandItem u16 (0 = empty)}: drawn at the frame's handL anchor (handR mirrored while Art lacks handL). */
  offHand?: ComponentDef<{ offHandItem: "u16" }>;
  /** Item id -> off-hand sprite id (`offhand_<key>`, falling back to `held_<key>`; see character/offhand.ts); undefined = draw nothing. */
  offHandSprite?: (itemId: number) => number | undefined;
  /** Exhaustion {level u8 0..255}: drives the `exhausted` status tint (SpriteDef.tints / render_tuning). */
  exhausted?: ComponentDef<{ level: "u8" }>;
  /** core Emitter {kind, radius, strength, falloff} (kinds mapped by the emitter table). */
  emitter?: ComponentDef;
  /** Fuel/Burning {lit}: an Emitter on an entity with this component only shows while lit != 0. */
  lit?: ComponentDef;
  /** Night-only emissive art (stall lanterns): atlas-emissive pixels of these sprites are multiplied by `gate` (StallLayer: 0 by day, flicker at night). */
  nightEmissive?: { readonly sprites: ReadonlySet<number>; gate: number };
  /** Per build-piece [primary, secondary] RGBA8 tint override (clan palette for tintmask R/G); undefined = BuildPiece.tint, no secondary. */
  pieceTints?: (entity: number) => readonly [number, number] | undefined;
  /** Per build-piece state index override (e.g. stall closed/open from StallHeader.open); undefined = BuildPiece.state. */
  pieceState?: (entity: number) => number | undefined;
  /** ADR-218 fired pieces: FireState (0 out, 1 lit, 2 lit hearth with embers/smoke); undefined = not a fired piece. Lit pieces whose
   *  sprite has a looping multi-frame `idle` anim animate it on the render clock (drawn dynamically, never baked into a static
   *  chunk); out pieces show the sprite's `unlit` anim frame when the building has no own unlit state. */
  pieceLit?: (entity: number) => number | undefined;
  /** ADR-227: per build-piece uniform draw scale about its pivot (sprite_fallbacks `scale`, e.g. campfire = bonfire art x0.55); undefined = 1. */
  pieceScale?: (entity: number) => number | undefined;
  /** ADR-218: every lit fired piece (view entity -> FireState) for hearth embers/smoke; read once per frame. */
  litPieces?: () => ReadonlyMap<number, number>;
  /** core Appearance + resolveLayers (character customization): entities with Appearance draw their resolved layers. */
  appearance?: AppearanceBinding;
  /** Hit flash 0..1 per entity (white flash on the body and all its layers); undefined/0 = none. */
  hitFlash?: (entity: number) => number;
  /** ADR-134 flinch tilt in radians about the sprite's foot (Canvas2D only; WebGL shows flash + scale pulse). */
  hitTilt?: (entity: number) => number;
  /** ADR-256: gameplay GrazedTile {tx, ty, regrowTick} — depleted grass tiles drawn as gt_grass_grazed. */
  grazedTile?: ComponentDef<{ tx: "i32"; ty: "i32"; regrowTick: "u32" }>;
}

const VS = /* glsl */ `#version 300 es
precision highp float; precision highp int;
layout(location=0) in vec4 aA; // sx, sy, key, scale
layout(location=1) in vec4 aB; // entry, flags, seed, alpha
layout(location=2) in vec4 aC; // ax, ay, sliceL, sliceR
layout(location=3) in vec4 aD; // tint rgb, sliceFootDy
layout(location=4) in vec4 aE; // shadowAlpha, ghost, damageOverlay, shadowWidth
layout(location=5) in vec4 aF; // wet 0..1, cold 0..1, shivering 0/1, heat 0..1
layout(location=6) in vec4 aG; // sway amp (px), freq (Hz), stiffness, occlusion 0..1
layout(location=7) in vec4 aH; // secondary tint rgb (tintmask G; 0 = none), exhausted 0..1
layout(location=8) in vec4 aI; // rotation (radians, screen, around the pivot; held items), unused x3
layout(location=9) in vec4 aJ; // ADR-107 swim fallback: hidden sprite px above the pivot (lower body clip), bob amp px; ADR-197 deck: closed-side mask | fw<<4 | fh<<8, top px
${GLSL_COMMON}
uniform highp sampler2D uFrames;
uniform float uZPerPx, uHH, uHW, uTime, uWind, uOutline;
uniform int uShadowPass, uShadowMode;
uniform vec2 uShadowDir; uniform float uBlobAspect; uniform vec2 uWindVec; // screen-x wind direction, strength 0..1
out vec4 vFx; out vec3 vUvRaw; flat out int vLayer; out float vAlpha; flat out int vFlags; flat out vec4 vRect; out vec3 vTint; flat out vec3 vMisc; out vec2 vLocal; out vec2 vScr; flat out float vOcc; flat out ivec2 vFB; flat out vec4 vTint2; flat out float vSwayPx; flat out vec4 vLT; out vec2 vDeck; flat out ivec2 vDeckM; flat out float vSeed;
uniform vec2 uViewPx; // drawing-buffer size (device px): sprite pivots snap to whole device pixels (no shimmer / half-texel blur)
vec2 snapPivot(vec2 p) {
  if (uViewPx.x <= 0.0) return p;
  vec2 k = uView.zw * uViewPx * 0.5; // iso px -> device px
  return uView.xy + floor((p - uView.xy) * k + 0.5) / k;
}
void main() {
  int entry = int(aB.x + 0.5); int flags = int(aB.y + 0.5);
  ivec2 tc = ivec2((entry % 1024) * 2, entry / 1024);
  vec4 uvr = texelFetch(uFrames, tc, 0);
  vec4 dim = texelFetch(uFrames, tc + ivec2(1, 0), 0); // w, h, layer, hasEmissive
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float s = aA.w;
  vFx = aF; vFlags = flags; vRect = uvr; vTint = aD.rgb; int fw = int(dim.w + 0.5); vFB = ivec2(fw & 15, fw >> 4); vMisc = vec3(aE.y, aE.z, float(fw & 1)); vAlpha = aB.w;
  vTint2 = aH; vSwayPx = 0.0; vLT = aI; vSeed = aB.z;
  vLocal = c * 2.0 - 1.0; vOcc = aG.w; vScr = aA.xy; vDeck = vec2(0.0); vDeckM = ivec2(0);
  if (uShadowPass == 1) {
    if (aE.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vAlpha = aE.x;
    vec2 iso; float key = aA.z + 0.004;
    if (uShadowMode == 0) { // blob
      float hw = dim.x * s * aE.w * 0.5;
      iso = aA.xy + uShadowDir * 6.0 + vLocal * vec2(hw, hw * uBlobAspect);
      vUvRaw = vec3(0.0, 0.0, dim.z); vLayer = int(dim.z + 0.5);
    } else { // projected silhouette
      float x = c.x * dim.x, y = c.y * dim.y; float flip = (flags & 1) != 0 ? -1.0 : 1.0;
      float px = (x - aC.x) * s * flip, hp = (aC.y - y) * s;
      iso = aA.xy + vec2(px, 0.0) + uShadowDir * hp;
      vUvRaw = vec3(mix(uvr.xy, uvr.zw, vec2(x / dim.x, y / dim.y)), dim.z); vLayer = int(dim.z + 0.5);
    }
    gl_Position = vec4(isoToClip(iso), keyToNdc(key), 1.0);
    return;
  }
  float ow = (flags & 16) != 0 ? 0.0 : uOutline;
  // slice bounds are screen-relative to the pivot; for mirrored sprites map them back into frame space
  vec2 sl = (flags & 1) != 0 ? vec2(-aC.w, -aC.z) : aC.zw;
  bool maskSway = (vFB.x & 4) != 0 && aG.x > 0.0; float m = maskSway ? aG.x + 1.0 : 0.0; // sway mask: per-pixel UV shift, quad grows by amp
  float x0 = max(-ow - m, aC.x + sl.x), x1 = min(dim.x + ow + m, aC.x + sl.y);
  float x = mix(x0, x1, c.x), y = mix(-ow, aJ.x > 0.0 ? min(dim.y + ow, aC.y - aJ.x) : dim.y + ow, c.y); // swim: lower body clipped
  float flip = (flags & 1) != 0 ? -1.0 : 1.0;
  float px = (x - aC.x) * s * flip;
  float hp = (aC.y - y) * s;
  if (maskSway) vSwayPx = uWindVec.x * uWindVec.y * aG.x * (0.65 + 0.35 * sin(uTime * aG.y * 6.283 + aB.z * 6.283)) * flip * (uvr.z - uvr.x) / dim.x;
  else if (aG.x > 0.0) { // wind sway: weight from height above the pivot, global wind + per-instance phase
    float wgt = pow(clamp(hp / max(1.0, aC.y * s), 0.0, 1.0), 1.0 + 2.0 * clamp(aG.z, 0.0, 1.0)); // stiffness 0..1, higher = stiffer
    px += uWindVec.x * uWindVec.y * aG.x * s * wgt * (0.65 + 0.35 * sin(uTime * aG.y * 6.283 + aB.z * 6.283));
  } else if ((flags & 4) != 0) px += sin(uTime * 1.6 + aB.z * 6.283) * uWind * max(hp, 0.0) * 0.05;
  if (aF.z > 0.5) px += sin(uTime * 52.0 + aB.z * 40.0) * (0.4 + 1.4 * aF.y) * s; // shiver
  vUvRaw = vec3(mix(uvr.xy, uvr.zw, vec2(x / dim.x, y / dim.y)), dim.z); vLayer = int(dim.z + 0.5);
  vec2 off = vec2(px, -hp);
  if (aJ.x > 0.0) off.y += (aJ.x + sin(uTime * 3.0 + aB.z * 6.283) * aJ.y) * s; // swim: sink the upper body to the waterline + bob
  if (aI.x != 0.0) { float cr = cos(aI.x), sr = sin(aI.x); off = vec2(cr * off.x - sr * off.y, sr * off.x + cr * off.y); }
  vec2 iso = snapPivot(aA.xy) + off; vScr = iso;
  int dm = int(aJ.z + 0.5); vDeckM = ivec2(dm & 15, dm >> 4); // ADR-197: tile offset of this pixel on the deck top plane
  if ((flags & 8) != 0 && (dm & 15) != 0) { float dy = off.y + aJ.w; vDeck = vec2(off.x / uHW + dy / uHH, dy / uHH - off.x / uHW) * 0.5; } else { vDeckM.x = 0; vDeck = vec2(0.0); }
  float hpd = hp + aD.w; // Footprint (128): pixels below the pivot are ground-level box faces nearer the camera
  float key = (flags & 8) != 0 ? aA.z + 0.01 - hp / uHH + (aA.z - uDepth.x) * ${FLAT_TIE_BREAK.toFixed(6)} // ADR-195 seam tie-break
    : (flags & 192) == 192 ? aA.z + 0.62 + max(-hpd, 0.0) / uHH // Footprint|Cutaway: open interior, no height term (low walls/floor never out-rank occupants drawn upright)
    : aA.z + 0.02 + max(hpd, 0.0) * uZPerPx + ((flags & 128) != 0 ? max(-hpd, 0.0) / uHH + 0.6 : 0.0); // Footprint: near walls beat terrain skirts
  gl_Position = vec4(isoToClip(iso), keyToNdc(key), 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float; precision highp int;
in vec4 vFx; in vec3 vUvRaw; flat in int vLayer; in float vAlpha; flat in int vFlags; flat in vec4 vRect; in vec3 vTint; flat in vec3 vMisc; in vec2 vLocal; in vec2 vScr; flat in float vOcc; flat in ivec2 vFB; flat in vec4 vTint2; flat in float vSwayPx; flat in vec4 vLT; in vec2 vDeck; flat in ivec2 vDeckM; flat in float vSeed;
uniform vec3 uSeason; // ADR-239: fall, winter, snow cap
uniform highp sampler2DArray uAtlas, uPoolTex, uEmis, uSheenM, uSwayM, uTintM; uniform highp sampler2D uTints;
#define vUv vec3(vUvRaw.xy, float(vLayer)) // flat int array layer (no interpolated layer index)
uniform int uShadowPass, uShadowMode;
uniform float uShadowAlpha, uOutline, uTexel, uTime, uEmisStrength, uAlphaMul, uNightGate, uFaceBias, uFaceContrast, uFaceUnlit;
uniform vec4 uOutlineColor, uCharOutlineColor; uniform float uCharOutline; uniform vec3 uShadowColor, uFrostColor, uFlushTint; uniform float uWetDarken, uWetSheen;
uniform int uOccMode, uSilhouette; uniform float uOccAlpha, uOccRadius; uniform vec2 uFocusScr; uniform vec4 uSilColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oEmissive;
float inRect(vec2 uv) { return step(vRect.x, uv.x) * step(uv.x, vRect.z) * step(vRect.y, uv.y) * step(uv.y, vRect.w); }
uniform int uPoolFirst;
vec4 atlasAt(vec3 uv) { int l = int(uv.z + 0.5); return l >= uPoolFirst ? texture(uPoolTex, vec3(uv.xy, float(l - uPoolFirst))) : texture(uAtlas, uv); }
// face/eyes layers: negative LOD bias so 1-3 px pupils/lashes are not averaged away in the minified mips
vec4 atlasAtBias(vec3 uv, float b) { int l = int(uv.z + 0.5); return l >= uPoolFirst ? texture(uPoolTex, vec3(uv.xy, float(l - uPoolFirst)), b) : texture(uAtlas, uv, b); }
// ADR-145 sharp bilinear: inside a texel sample its centre, blend only across a ~1 device px seam (crisp at any
// non-integer magnification, no shimmer); minified (>= 1 texel per px) it is left to the mips.
vec3 crispUv(vec3 uv, vec2 w) {
  int l = int(uv.z + 0.5); vec2 sz = vec2(l >= uPoolFirst ? textureSize(uPoolTex, 0).xy : textureSize(uAtlas, 0).xy);
  vec2 p = uv.xy * sz, d = w * sz; if (max(d.x, d.y) >= 1.0) return uv;
  vec2 f = fract(p) - 0.5; p = floor(p) + 0.5 + clamp(f / max(d, vec2(1e-4)), -0.5, 0.5); return vec3(p / sz, uv.z);
}
// ADR-251 bleed fix: sample inside the frame rect inset by half a texel of the sampled footprint (>= half a base texel), so
// bilinear / mip taps never reach a neighbouring slot or frame (the magenta fringes); inRect still masks the unclamped uv.
vec2 rectClamp(vec2 uv, int l, vec2 fw) {
  vec2 sz = vec2(l >= uPoolFirst ? textureSize(uPoolTex, 0).xy : textureSize(uAtlas, 0).xy);
  vec2 h = min(max(0.5 / sz, 0.5 * fw), 0.5 * max(vRect.zw - vRect.xy, vec2(0.0)));
  return clamp(uv, vRect.xy + h, vRect.zw - h);
}
vec3 inUv(vec3 uv, vec2 fw) { return vec3(rectClamp(uv.xy, int(uv.z + 0.5), fw), uv.z); }
float alphaAt(vec2 uv) { return atlasAt(vec3(rectClamp(uv, int(vUv.z + 0.5), vec2(0.0)), vUv.z)).a * inRect(uv); }
${SEASON_SPRITE_GLSL}
// status tint row (AtlasManager tint table: per sprite SpriteDef.tints, row 0 = render_tuning globals)
vec3 statusTint(vec3 c, int idx, float amount) {
  if (amount <= 0.003) return c;
  vec4 a = texelFetch(uTints, ivec2(idx * 2, vFB.y), 0), b = texelFetch(uTints, ivec2(idx * 2 + 1, vFB.y), 0);
  float l = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(vec3(l), c, mix(1.0, b.y, amount));
  float k = a.w * amount; int mode = int(b.x + 0.5);
  vec3 r = mode == 0 ? c * a.rgb : mode == 1 ? c + a.rgb : mode == 2 ? 1.0 - (1.0 - c) * (1.0 - a.rgb) : a.rgb;
  return mix(c, r, k);
}
// character layer tint (resolveLayers, ADR-082 pinned contract). tc arrives pre-divided by tintNeutral for multiply/lerp
// (CPU side), so multiply is exactly out = base * mix(1, color / tintNeutral, strength * mask): a tintNeutral grey pixel
// becomes color at full strength. No pre-saturation; tintSaturation adjusts the tinted result afterwards.
vec3 layerTint(vec3 c, vec3 tc, int mode, float k, float sat) {
  if (k <= 0.003) return c;
  vec3 r = mode == 0 ? c * mix(vec3(1.0), tc, k) : mode == 1 ? mix(c, c + tc, k) : mode == 2 ? mix(c, 1.0 - (1.0 - c) * (1.0 - tc), k)
    : mix(c, tc * dot(c, vec3(0.299, 0.587, 0.114)), k);
  r = clamp(r, 0.0, 1.0);
  return sat == 1.0 ? r : clamp(mix(vec3(dot(r, vec3(0.299, 0.587, 0.114))), r, mix(1.0, sat, k)), 0.0, 1.0);
}
float ringW(vec2 uv, float w) {
  float o = 0.0; vec2 d = vec2(w * uTexel);
  o = max(o, alphaAt(uv + vec2(d.x, 0.0))); o = max(o, alphaAt(uv - vec2(d.x, 0.0)));
  o = max(o, alphaAt(uv + vec2(0.0, d.y))); o = max(o, alphaAt(uv - vec2(0.0, d.y)));
  o = max(o, alphaAt(uv + d * 0.7071)); o = max(o, alphaAt(uv - d * 0.7071));
  o = max(o, alphaAt(uv + vec2(d.x, -d.y) * 0.7071)); o = max(o, alphaAt(uv + vec2(-d.x, d.y) * 0.7071));
  return o;
}
float ringAt(vec2 uv) { return ringW(uv, uOutline); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cw = fwidth(vUvRaw.xy); // uniform control flow: crispUv's footprint (ADR-145)
  mat2 deckJu = mat2(dFdx(vUvRaw.xy), dFdy(vUvRaw.xy)), deckJd = mat2(dFdx(vDeck), dFdy(vDeck)); // ADR-210 seam remap Jacobians
  if (vDeckM.x != 0) { // ADR-197: a side face/rim is drawn only toward an open side (no deck neighbour there)
    float ha = float(vDeckM.y & 15) * 0.5 + ${DECK_EDGE_EPS}, hb = float((vDeckM.y >> 4) & 15) * 0.5 + ${DECK_EDGE_EPS};
    float ea = abs(vDeck.x) - ha, eb = abs(vDeck.y) - hb; int sd = (ea > 0.0 && ea >= eb) ? (vDeck.x > 0.0 ? 1 : 4) : (eb > 0.0 ? (vDeck.y > 0.0 ? 2 : 8) : 0); // ADR-210 owning face
    if ((vDeckM.x & sd) != 0) discard;
  }
  if (uShadowPass == 1) {
    float a;
    if (uShadowMode == 0) { float d = length(vLocal); a = 1.0 - smoothstep(0.35, 1.0, d); }
    else a = step(0.3, alphaAt(vUv.xy));
    if (a <= 0.01) discard;
    oColor = vec4(uShadowColor, a * uShadowAlpha * vAlpha);
    oEmissive = vec4(0.0);
    return;
  }
  vec3 uv = vUv;
  if ((vFB.x & 4) != 0 && vSwayPx != 0.0) { // sway mask (R = weight): sample the source shifted against the wind
    float w = texture(uSwayM, vUv).r; uv.x -= vSwayPx * w; // vSwayPx is in uv units
  }
  if (vDeckM.x != 0) { // ADR-210 connected top: the border band toward a CLOSED side samples the interior instead
    float ia = float(vDeckM.y & 15) * 0.5 - ${DECK_SEAM_BAND}, ib = float((vDeckM.y >> 4) & 15) * 0.5 - ${DECK_SEAM_BAND};
    vec2 sh = vec2(((vDeckM.x & 1) != 0 && vDeck.x > ia) ? -${DECK_SEAM_SHIFT} : ((vDeckM.x & 4) != 0 && vDeck.x < -ia) ? ${DECK_SEAM_SHIFT} : 0.0,
                   ((vDeckM.x & 2) != 0 && vDeck.y > ib) ? -${DECK_SEAM_SHIFT} : ((vDeckM.x & 8) != 0 && vDeck.y < -ib) ? ${DECK_SEAM_SHIFT} : 0.0);
    float det = determinant(deckJd);
    if ((sh.x != 0.0 || sh.y != 0.0) && abs(det) > 1e-12) uv.xy += deckJu * (inverse(deckJd) * sh);
  }
  if ((vFlags & 1024) != 0) uv = crispUv(uv, cw);
  vec3 su = inUv(uv, cw); vec4 t = ((vFlags & 512) != 0 ? atlasAtBias(su, uFaceBias) : atlasAt(su)) * inRect(uv.xy);
  if (uSilhouette == 1) { // focus drawn through occluders (depth GREATER)
    if (t.a < 0.35) discard;
    oColor = uSilColor; oEmissive = vec4(0.8, 0.0, 0.0, uSilColor.a); return;
  }
  if ((vFlags & 256) != 0) { // outline-only pass of a character layer (drawn just behind the body: union silhouette outline)
    // ADR-269: the character-only outline (characterOpts.outline*) when the global sprite outline is off
    bool gOut = uOutline > 0.0; float ow2 = gOut ? uOutline : uCharOutline; vec4 oc4 = gOut ? uOutlineColor : uCharOutlineColor;
    if (t.a >= 0.5 || ow2 <= 0.0 || ringW(vUv.xy, ow2) <= 0.5) discard;
    float oa = oc4.a * vAlpha * uAlphaMul * (uOccMode == 0 ? mix(1.0, uOccAlpha, vOcc) : 1.0);
    oColor = vec4(oc4.rgb, oa); oEmissive = vec4(0.0, 0.0, 0.0, oa); return;
  }
  vec3 col; float a = t.a;
  if (vLT.y > 0.5) { // character layer: tintmask R <- primary (vTint), G <- secondary (vTint2); no mask = whole frame primary
    vec4 tm = (vFB.x & 8) != 0 ? texture(uTintM, su) : vec4(1.0, 0.0, 0.0, 1.0); int mode = int(vLT.y - 0.5);
    col = layerTint(t.rgb, vTint, mode, vLT.z * tm.r, vLT.w);
    if (dot(vTint2.rgb, vec3(1.0)) > 0.0) col = layerTint(col, vTint2.rgb, mode, vLT.z * tm.g, vLT.w);
  } else if ((vFB.x & 8) != 0) { // two-tone tint mask: R = primary (Sprite.tint), G = secondary (aH rgb)
    vec4 tm = texture(uTintM, su); vec3 t2 = dot(vTint2.rgb, vec3(1.0)) > 0.0 ? vTint2.rgb : vTint;
    col = t.rgb * mix(vec3(1.0), vTint, tm.r) * mix(vec3(1.0), t2, tm.g);
  } else col = t.rgb * vTint;
  if (a < 0.5 && uOutline > 0.0 && (vFlags & 16) == 0) {
    if (ringAt(vUv.xy) > 0.5) { col = uOutlineColor.rgb; a = uOutlineColor.a; }
  }
  if (a < 0.35) discard;
  if ((vFlags & ${SEASON_FOLIAGE | SEASON_SNOWCAP | SEASON_GROUND}) != 0 && t.a >= 0.5) col = seasonSprite(col, vFlags, uv.xy, vSeed, vUv.xy / uTexel); // ADR-239
  if (vOcc > 0.001 && uOccMode == 1) { // dithered circle cut around the focus
    float d = length((vScr - uFocusScr) * vec2(1.0, 1.15)) / uOccRadius;
    ivec2 p = ivec2(gl_FragCoord.xy) & 3;
    if ((1.0 - smoothstep(0.6, 1.0, d)) * vOcc * 1.02 > (BAYER[p.y * 4 + p.x] + 0.5) / 16.0) discard;
  }
  // procedural crack overlay when the atlas has no damage-stage frames
  float dmg = vMisc.y;
  if (dmg > 0.5) {
    vec2 g = vUv.xy / uTexel / 3.0; float n = h21(floor(g));
    float crack = step(1.0 - 0.06 * dmg, n) + step(0.985 - 0.01 * dmg, h21(floor(g * 0.5) + 7.0));
    col *= 1.0 - min(1.0, crack) * 0.55 - 0.08 * dmg;
  }
  // survival FX: wetness (darken + sheen + drips), frost rim (cold), flush (heat)
  if (vFx.x > 0.003) {
    vec4 sm = (vFB.x & 2) != 0 ? texture(uSheenM, su) : vec4(-1.0); // sheen mask: R sheen, G darken, B drip
    col *= mix(1.0, uWetDarken, vFx.x * (sm.g >= 0.0 ? sm.g : 1.0));
    float sheen = sm.r >= 0.0 ? sm.r : pow(max(0.0, 1.0 - length((vLocal - vec2(-0.35, -0.45)) * vec2(1.2, 0.9))), 3.0);
    vec2 px = vUv.xy / uTexel;
    float drip = step(0.94, h21(vec2(floor(px.x / 2.0), floor((px.y - uTime * 24.0) / 5.0)))) * (sm.b >= 0.0 ? step(0.5, sm.b) : 1.0);
    col += vec3(0.75, 0.85, 1.0) * vFx.x * uWetSheen * (sheen + drip * 0.6) * t.a;
  }
  if (vFx.y > 0.25) {
    float d = uTexel * 1.5; float m = min(min(alphaAt(vUv.xy + vec2(d, 0.0)), alphaAt(vUv.xy - vec2(d, 0.0))), min(alphaAt(vUv.xy + vec2(0.0, d)), alphaAt(vUv.xy - vec2(0.0, d))));
    float f = smoothstep(0.25, 1.0, vFx.y);
    col = mix(col, uFrostColor, f * (1.0 - m) * 0.85 + f * 0.12);
  }
  if (vFx.w > 0.003) col = mix(col, col * uFlushTint, vFx.w);
  // typed status tints (wet, frost, flush, exhausted) with mode + saturation, scaled by the status amount
  col = statusTint(col, 0, vFx.x); col = statusTint(col, 1, vFx.y); col = statusTint(col, 2, vFx.w); col = statusTint(col, 3, vTint2.w);
  if (dmg < -0.001) col = mix(col, vec3(1.0), -dmg); // hit flash (dynamic sprites store -flash in the damage slot)
  float alpha = smoothstep(0.35, 0.75, a) * vAlpha * uAlphaMul;
  if (uOccMode == 0) alpha *= mix(1.0, uOccAlpha, vOcc);
  int ghost = int(vMisc.x + 0.5);
  if (ghost > 0) {
    vec3 gc = ghost == 1 ? vec3(0.3, 1.0, 0.4) : vec3(1.0, 0.22, 0.22);
    col = mix(col, gc, 0.68); alpha *= 0.62 + 0.08 * sin(uTime * 4.0); // ADR-196: clearer green/red, ~0.6 alpha, subtle pulse
  }
  if ((vFlags & 512) != 0) col = clamp((col - 0.5) * uFaceContrast + 0.5, 0.0, 1.0); // face/eyes: small contrast lift (after tint + status)
  float e = (vFlags & 2) != 0 ? 1.0 : 0.0;
  if (vMisc.z > 0.5) { vec4 em = texture(uEmis, vUv); e = max(e, max(em.r, max(em.g, em.b)) * em.a * ((vFlags & 64) != 0 ? uNightGate : 1.0)); } // 64: night-only emissive
  oColor = vec4(col, alpha);
  // r: darkness bypass (emissive); g: bloom source (emissive pixels + light-source sprites)
  // ghosts (build preview) bypass the lightmap (r) so they stay readable at night, but never feed bloom (g)
  // face/eyes: partial darkness bypass (r only, never bloom) so eyes stay readable at night / in fog
  oEmissive = vec4(ghost > 0 ? 1.0 : e * uEmisStrength, (vFlags & 32) != 0 ? max(e, 0.6) : e, 0.0, alpha);
  if ((vFlags & 512) != 0) oEmissive.r = max(oEmissive.r, uFaceUnlit);
}`;

/** Secondary tint (RGBA8 packed) into instance floats 28..30 (0 = reuse primary). */
export function writeTint2(o: Float32Array, t: number): void { if (t === 0) { o[28] = o[29] = o[30] = 0; return; } o[28] = ((t >>> 24) & 255) / 255 || 1e-3; o[29] = ((t >>> 16) & 255) / 255; o[30] = ((t >>> 8) & 255) / 255; }

interface StaticChunk { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; count: number; checksum: number; cx: number; cy: number; maxZ: number; seen: number; born: number }

export interface PrepareContext {
  world: World; alpha: number; rect: Rect; atlas: AtlasManager; depthMin: number; depthRange: number;
  tickHz: number; style: StyleConfig; bindings: GameplayBindings;
  spatial?: { index: ChunkedSpatialIndex; activeKeys?: ReadonlySet<string> } | undefined;
  activeKeys?: ReadonlySet<string> | undefined;
  grid?: BuildingGrid | undefined;
  /** Terrain height under a tile (for the focus' floor index); 0 when unknown. */
  groundZAt?: ((tx: number, ty: number) => number) | undefined;
  /** Where building sprites' pivot sits on the footprint (default "center"). */
  pieceAnchor?: "center" | "front";
  transformSource?: TransformSource | undefined;
  vfx?: VfxLayer | undefined;
  /** renderer clock, seconds (static chunk fade-in, vfx) */
  now: number;
  /** Camera zoom (character crowd LOD). */
  zoom?: number;
  /** Status particle hook (drips when wet, breath when cold, sweat when hot); called per visible entity with level 0..1. */
  statusFx?: ((kind: "wet" | "cold" | "heat", x: number, y: number, z: number, level: number) => void) | undefined;
}

/** ADR-232: sprite a build piece draws this frame. Building-tier pages fall back to resident tier art; manifest stream
 *  sheets (decor: rugs, vases, ...) are requested (pageReady at near priority) and draw their placeholder, or nothing (-1),
 *  until uploaded. Before this the stream case was never requested, so streamed decor stayed invisible. */
export function pieceDrawSprite(atlas: Pick<AtlasManager, "streamClass" | "pageReady" | "buildingFallback" | "placeholderOf">, vis: number): number {
  const cls = atlas.streamClass(vis); if (cls === null || atlas.pageReady(vis, PRIO_NEAR)) return vis;
  return cls === "bld" ? atlas.buildingFallback(vis, PRIO_NEAR) : atlas.placeholderOf(vis);
}

export class SpriteBatch {
  private prog: Program;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private capacity = 0;
  private inst = new Float32Array(0);
  private tmp = new Float32Array(0);
  private sortKeys = new Uint32Array(0);
  private gpuBytes = 0;
  private n = 0;
  private depthMin = 0; private depthRange = 1;
  private res: ResolvedFrame = newResolved();
  private crackRes: ResolvedFrame = newResolved();
  /** Gridless cutaway (client has no BuildingGrid): cover of the pieces drawn last frame / being gathered this frame. */
  private cover = new PieceCoverIndex(); private coverNext = new PieceCoverIndex();
  /** Pieces drawn with streaming fallback art this frame (tier page not resident yet) / crack overlays drawn. */
  tierFallbacks = 0; crackOverlays = 0;
  private statics = new Map<string, StaticChunk>();
  private staticScratch = new Map<string, number[]>();
  // per-frame scratch reused across frames (no allocations in the gather/sort hot paths)
  private pieceChecks = new Map<string, number>(); private pieceTmp: number[] = [];
  private pieceParts: { vis: number; rot: number; layer: number; x: number; y: number; last: boolean }[] = [];
  private ckCache = new Map<number, string>();
  private lateOrder = new Uint32Array(0); private lateBuf = new Float32Array(0);
  /** Adaptive sort stats: frames where the incremental (insertion) pass sufficed vs fell back to a full sort. */
  sortIncremental = 0; sortFull = 0;
  /** Static chunks skipped by the chunk-grid cull this frame (kept cached, not re-gathered). */
  culledChunks = 0;
  /** Sprites drawn as their placeholder this frame because their stream sheet was still loading. */
  streamPlaceholders = 0;
  /** ADR-244 (b): bodies drawn on the resident core idle while their streamed v2 sheet page loads (last frame). */
  streamBodyFallbacks = 0;
  /** ADR-123: per (entity, layer slot) last resolved frame, drawn while the current one is not resident */
  /** ADR-220: atlas layout the held frames (entry/atlas indices) belong to; a rebuild renumbers both. */
  private lastGoodLayout = -1;
  private lastGood = new Map<string, { sprite: number; atlas: number; entry: number; ax: number; ay: number }>();
  lastGoodHits = 0;
  /** ADR-188: layers drawn for a character that has never been fully composited (first sight while its pages stream). */
  partialLayers = 0;
  /** ADR-188: prefetch-ring page requests/touches this session. */
  prefetches = 0;
  private layerPlan: { l: CachedLayer; j: number; faceL: boolean; rdy: boolean; atlas: number; entry: number; ax: number; ay: number }[] = [];
  /** Chunk screen bounds (any height up to 1024 px above ground) against the view rect grown by 512 px. */
  private chunkOnScreen(cx: number, cy: number, r: Rect, hw: number, hh: number): boolean {
    const vr = viewRect(cx * CHUNK_SIZE, cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, this.iso.view ?? 0); // ADR-253: view-space square
    const x0 = vr.x, y0 = vr.y, x1 = x0 + CHUNK_SIZE, y1 = y0 + CHUNK_SIZE;
    const sl = (x0 - y1) * hw, sr = (x1 - y0) * hw, st = (x0 + y0) * hh - 1024, sb = (x1 + y1) * hh;
    return sr >= r.x0 - 512 && sl <= r.x1 + 512 && sb >= r.y0 - 512 && st <= r.y1 + 512;
  }
  private prevPerm = new Uint16Array(0); private prevN = 0; private seedBuf = new Uint32Array(0); private seedUsed = new Uint8Array(0);
  private chunkKeyOf(cx: number, cy: number): string {
    const n = (cx + 32768) * 65536 + (cy + 32768); let k = this.ckCache.get(n);
    if (k === undefined) { k = chunkKey(cx, cy); if (this.ckCache.size > 65536) this.ckCache.clear(); this.ckCache.set(n, k); }
    return k;
  }
  private frameNo = 0;
  private xf = new Float32Array(4);
  /** Seconds for newly streamed static chunks to fade in (0 = pop). */
  chunkFadeIn = 0.35;
  visible = 0;
  staticInstances = 0; staticChunksDrawn = 0; staticRebuilds = 0; /** ADR-232: pieces drawn as their placeholder (or skipped) while a stream page loads */ streamFallbacks = 0;
  focusEntity = -1;
  /** ADR-239: current season visual (IsoRenderer sets it per frame) + snow-cap amount for Snowcap sprites. */
  season: SeasonVisual = SUMMER_VISUAL; seasonSnowCap = 0;
  private seasonArt: SeasonArt | null = null; private seasonArtReg: unknown = null;
  /** `<key>_<season>` art when the registry has it (no procedural pass), else the sprite + its season class flags. */
  seasonPick(atlas: AtlasManager, sid: number): { sid: number; flags: number } {
    const reg = atlas.registry; if (!reg) return { sid, flags: 0 };
    if (this.seasonArtReg !== reg) { this.seasonArt = new SeasonArt(reg); this.seasonArtReg = reg; }
    return this.seasonArt!.resolve(sid, this.season);
  }
  /** occlusion fade state per entity index (smoothed 0..1) */
  private occT = new Float32Array(1024); private occLast = -1;
  private silVbo: WebGLBuffer | null = null; private silVao: WebGLVertexArrayObject | null = null;
  private silInst = new Float32Array(INSTANCE_FLOATS); private silOn = false;
  private focusScr: [number, number] = [0, 0];
  private occ: { occAmount: (i: number, hit: boolean) => number; peek: (i: number) => number; overlapsFocus: (l: number, r: number, t: number, b: number) => boolean; occOn: boolean; fk: number } =
    { occAmount: () => 0, peek: () => 0, overlapsFocus: () => false, occOn: false, fk: 0 };
  /** Character layer cache (per entity; re-resolved on Appearance change or facing bucket change). */
  layerCache: LayerCache | null = null;
  /** Character layers: outline mode ("union" = one outline around body+layers, "body" = body only); crowd LOD zoom. */
  characterOpts = { outline: "union" as "union" | "body", minorLayerMinZoom: 0.75,
    /** ADR-269: character-only union silhouette outline (atlas texels; 0 = off) + RGBA colour, drawn even with the global
     *  sprite outline off so survivors / AI humans / zombies read a little darker and more defined against the world. */
    outlineWidthPx: CHARACTER_OUTLINE.widthPx, outlineColor: [...CHARACTER_OUTLINE.color] as [number, number, number, number],
    /** face/eyes layers (FACE_LAYER): LOD bias (negative = sharper when minified), contrast around mid-grey, darkness bypass 0..1 */
    faceMipBias: -0.75, faceContrast: 1.12, faceUnlit: 0.3 };
  /** Per-frame stats: characters with Appearance drawn, extra layer instances pushed. */
  characters = 0; layerInstances = 0;
  /** ?diag: local player + characters within PRIO_NEAR this frame (layer count, resident pages, worst pool scale). */
  readonly nearInfo: { e: number; d: number; layers: number; resident: number; drawn: number; scale: number; missing: string[] }[] = Array.from({ length: 8 }, () => ({ e: -1, d: 0, layers: 0, resident: 0, drawn: 0, scale: 1, missing: [] }));
  nearN = 0;
  /** Fallback step 2: only the nearest `maxDressed` layered characters (to the view centre) draw their wearables; the rest body-only. */
  maxDressed = Infinity;
  /** Dress-capped characters still draw their face/eyes layers (small pages; a faceless body reads as a mannequin). */
  dressFaces = true;
  /** Characters drawn body-only by the maxDressed cap last frame. */
  dressCapped = 0;
  private dressD2 = new Float32Array(64); private dressN = 0; private dressCut = Infinity; private dressDrawn = 0;
  private layerRes = newResolved();
  /** Entities whose pieces are currently cut away (debug/stat). */
  cutawayActive = false;
  /** Night-only emissive gate (GameplayBindings.nightEmissive.gate), latched in prepare. */
  nightGate = 1;

  constructor(private gl: WebGL2RenderingContext, private iso: IsoConfig, private zFactor: number) {
    this.prog = createProgram(gl, VS, FS, "sprites");
    this.vbo = gl.createBuffer()!;
    this.vao = this.makeVao(this.vbo);
    this.ensure(4096);
  }

  private makeVao(vbo: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl; const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    for (let a = 0; a < 10; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, a * 16); gl.vertexAttribDivisor(a, 1); }
    gl.bindVertexArray(null);
    return vao;
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    let c = Math.max(this.capacity, 1024); while (c < n) c *= 2;
    c = Math.min(c, 65536);
    const tmp = new Float32Array(c * INSTANCE_FLOATS); tmp.set(this.tmp.subarray(0, Math.min(this.tmp.length, tmp.length)));
    const keys = new Uint32Array(c); keys.set(this.sortKeys.subarray(0, Math.min(this.sortKeys.length, c)));
    this.capacity = c; this.tmp = tmp; this.sortKeys = keys; this.inst = new Float32Array(c * INSTANCE_FLOATS);
    const rt = new Uint8Array(c); rt.set(this.route.subarray(0, Math.min(this.route.length, c))); this.route = rt;
  }

  /** Append one dynamic instance. */
  /**
   * Faded occluders (fade mode, occlusion > 0.5) go to a separate late batch drawn after the focus silhouette with
   * depth writes off, so the silhouette only shows behind occluders that are still opaque.
   */
  // ---- camper interior pass (interiorPass.ts): floor -> occupants -> cutaway walls, drawn after the world, depth test off ----
  /** Interior regions active this frame (vehicles whose cutaway is open for the local player); set by the renderer. */
  interiorRegions: InteriorRegion[] = [];
  /** Sprite ids routed as interior floor (the vehicle's _int cutaway segments). */
  interiorFloorIds = new Set<number>();
  /** Art wall piece (camper_interior_wall) placed along the long sides; -1 = none. */
  interiorWallSprite = -1;
  /** Near walls dropped instead of faded. */
  interiorCut = false;
  private route = new Uint8Array(0); private curRoute = 0;
  private intBuf = new Float32Array(0); private intCount = 0; private intVbo: WebGLBuffer | null = null; private intVao: WebGLVertexArrayObject | null = null;
  private intKeys: number[] = []; private intRoutes: number[] = []; private intIdx: number[] = [];
  private late: number[] = []; private lateVbo: WebGLBuffer | null = null; private lateVao: WebGLVertexArrayObject | null = null; private lateCount = 0;
  private pushOcc(o: Float32Array | number[], src: number, occT: number, mode: "fade" | "dither"): void {
    if (mode === "fade" && occT > 0.5) { for (let q = 0; q < INSTANCE_FLOATS; q++) this.late.push(o[src + q]!); }
    else this.push(o, src);
  }
  private push(o: Float32Array | number[], src: number): void {
    if (this.n >= this.capacity) { if (this.capacity >= 65536) return; this.ensure(this.n + 1); }
    const d = this.n * INSTANCE_FLOATS; const t = this.tmp;
    for (let q = 0; q < INSTANCE_FLOATS; q++) t[d + q] = o[src + q]!;
    const key = t[d + 2]!;
    const qd = Math.max(0, Math.min(65535, ((key - this.depthMin) / this.depthRange) * 65535)) | 0;
    this.sortKeys[this.n] = ((qd << 16) | this.n) >>> 0;
    this.route[this.n] = this.curRoute;
    this.n++;
  }

  /** screen-x wind direction (-1..1), strength 0..1; set by the renderer each frame. */
  windVec = new Float32Array([1, 0]);
  /** Shadow colour (style.shadowTint or the grading keyframe's). */
  shadowColor = new Float32Array(3);
  private one = new Float32Array(INSTANCE_FLOATS);
  private writeOne(sx: number, sy: number, key: number, scale: number, r: ResolvedFrame, flags: number, seed: number, alpha: number,
    sliceL: number, sliceR: number, tint: number, footDy: number, shadowA: number, ghost: number, dmgOverlay: number, shadowW: number): Float32Array {
    const o = this.one;
    o[0] = sx; o[1] = sy; o[2] = key; o[3] = scale;
    o[4] = r.entry; o[5] = flags; o[6] = seed; o[7] = alpha;
    o[8] = r.ax; o[9] = r.ay; o[10] = sliceL; o[11] = sliceR;
    if (tint === 0) { o[12] = 1; o[13] = 1; o[14] = 1; } else { o[12] = ((tint >>> 24) & 255) / 255; o[13] = ((tint >>> 16) & 255) / 255; o[14] = ((tint >>> 8) & 255) / 255; }
    o[15] = footDy;
    o[16] = shadowA; o[17] = ghost; o[18] = dmgOverlay; o[19] = shadowW;
    o.fill(0, 20, INSTANCE_FLOATS);
    return o;
  }

  private layerBase = new Float32Array(INSTANCE_FLOATS);
  /** Layer tint: primary -> rgb 12..14, secondary -> 28..30, mode+1 / strength / saturation -> 33..35. multiply / lerp
   *  colours are divided by the layer's tintNeutral here (see layerTint). */
  private writeLayerTint(o: Float32Array, l: CachedLayer): void {
    const t = l.tint; const d = l.mode === 0 || l.mode === 3 ? 1 / l.neutral : 1;
    if (t === 0) { o[12] = o[13] = o[14] = 1; } else { o[12] = ((t >>> 24) & 255) / 255 * d; o[13] = ((t >>> 16) & 255) / 255 * d; o[14] = ((t >>> 8) & 255) / 255 * d; }
    writeTint2(o, l.tint2);
    if (l.tint2 !== 0 && d !== 1) { o[28] = o[28]! * d; o[29] = o[29]! * d; o[30] = o[30]! * d; }
    o[33] = t === 0 && l.tint2 === 0 ? 0 : l.mode + 1; o[34] = l.strength; o[35] = l.saturation;
  }
  private heldRes = newResolved();
  /** debug: held items [with item, with hand anchor, drawn] since start */
  readonly heldStats: [number, number, number] = [0, 0, 0];
  /** debug: off-hand items [with item, with anchor, drawn, drawn on the mirrored-handR fallback (no handL art)] since start */
  readonly offHandStats: [number, number, number, number] = [0, 0, 0, 0];
  /**
   * Held item: pivot (grip) at the hand anchor of the character's current frame, rotated by the anchor angle, sorted just
   * behind / in front of the character, mirrored with the character's flipX. No anchor for the frame = not drawn.
   */
  private emitHeld(atlas: AtlasManager, heldOf: (item: number) => number | undefined, item: number, body: ResolvedFrame, sx: number, sy: number, key: number,
    scale: number, facing: number, flip: boolean, fade: number, occT: number, mode: "fade" | "dither", lift = 0, off = false, animT = 0, socket?: string, tint = 0): void {
    if (!item) return; const hid = heldOf(item); if (hid === undefined) return; const st = off ? this.offHandStats : this.heldStats; st[0]++;
    let h: HandAnchor | undefined; let behind: boolean;
    if (socket) { h = atlas.handOf(body, socket); if (!h) return; behind = h.behind; }
    else if (off) { const a = offHandAnchor((b: ResolvedFrame, n?: string) => atlas.handOf(b, n), body); if (!a) return; h = a.anchor; behind = offHandBehind(facing, h.behind); if (a.fallback) this.offHandStats[3]++; }
    else { h = atlas.handOf(body); if (!h) return; behind = h.behind; }
    st[1]++;
    const r = this.heldRes; const hfa = atlas.fireAnim(hid); if (!atlas.resolve(hid, hfa >= 0 ? hfa : 0, facing, hfa >= 0 ? animT : 0, 0, r)) return; st[2]++; // ADR-218: held torches flicker (render clock)
    // ADR-270: sprite origin is a packing pivot, not necessarily the visible handle.
    // Rebase before rotation/mirroring so the authored grip lands exactly on either hand.
    if (!socket) { const grip = atlas.handOf(r, "grip"); if (grip) { r.ax = grip.x; r.ay = grip.y; } }
    const m = flip ? -1 : 1;
    const hx = sx + (h.x - body.ax) * scale * m, hy = sy + (h.y - body.ay) * scale;
    // Task 25: dye tint is packed 0xRRGGBB; writeOne wants (r<<24)|(g<<16)|(b<<8). 0 = no tint.
    const o = this.writeOne(hx, hy, key + (behind ? -HELD_BIAS : HELD_BIAS), scale, r, (flip ? SpriteFlag.FlipX : 0) | SpriteFlag.NoOutline | (atlas.isCrisp(r.atlas) ? CRISP : 0), 0, fade, -OPEN, OPEN, tint ? (tint << 8) >>> 0 : 0, 0, 0, 0, 0, 0);
    // anchor (pivot) height above the body pivot keeps the item's depth on the body's column
    o[15] = (body.ay - h.y) * scale + lift; o[32] = (h.angle * Math.PI / 180) * m; o[27] = occT;
    this.pushOcc(o, 0, occT, mode);
  }

  /** CPU phase: gather, interpolate, resolve, cull, sort. */
  prepare(cx: PrepareContext): void {
    const { world, alpha, rect, atlas } = cx;
    this.frameNo++;
    this.n = 0; this.depthMin = cx.depthMin; this.depthRange = cx.depthRange;
    if (!atlas.registry) { this.visible = 0; return; }
    const sp = world.store(Sprite), tr = world.store(Transform), pv = world.store(PrevTransform);
    const sh = world.store(Shadow), oc = world.store(Occluder), ls = world.store(LightSource);
    const an = cx.bindings.animState ? world.store(cx.bindings.animState) : null;
    const wet = cx.bindings.wetness ? world.store(cx.bindings.wetness) : null;
    const bt = cx.bindings.bodyTemp ? world.store(cx.bindings.bodyTemp) : null;
    const exh = cx.bindings.exhausted ? world.store(cx.bindings.exhausted) : null;
    const eq = cx.bindings.equipment ? world.store(cx.bindings.equipment) : null; const heldOf = cx.bindings.heldSprite;
    const litSt = cx.bindings.lit && world.isRegistered(cx.bindings.lit) ? world.store(cx.bindings.lit) : null; const litData = litSt?.data as Record<string, ArrayLike<number>> | undefined;
    const oh = cx.bindings.offHand ? world.store(cx.bindings.offHand) : null; const offOf = cx.bindings.offHandSprite ?? heldOf;
    const t2s = world.isRegistered(TintSecondary) ? world.store(TintSecondary) : null;
    const sa = world.isRegistered(SpriteAlpha) ? world.store(SpriteAlpha) : null; // ADR-238 despawn fade
    const apB = cx.bindings.appearance; const ap0 = apB && world.isRegistered(apB.def) ? world.store(apB.def) : null; const ap = ap0 && (ap0.data as Record<string, unknown>).version ? ap0 : null;
    atlas.beginFrame();
    if (apB && (!this.layerCache || this.layerCache.binding !== apB)) {
      this.layerCache?.clear();
      const lc = (this.layerCache = new LayerCache(apB));
      // streamed wearable pages are refcounted by the cached layer sets (released on change / prune)
      lc.onLayers = (prev, next) => { if (next) for (const l of next) atlas.retainSprite(l.sprite); if (prev) for (const l of prev) atlas.releaseSprite(l.sprite); };
    }
    const apData = ap ? ap.data as Record<string, ArrayLike<number>> : null; const apLen = ap ? (ap as unknown as { lengths: Record<string, number> }).lengths : {};
    const apVer = apData?.version ?? null;
    const lodMinor = (cx.zoom ?? 1) < this.characterOpts.minorLayerMinZoom; const hitOf = cx.bindings.hitFlash;
    const outlineOn = (cx.style.outline.enabled || this.characterOpts.outlineWidthPx > 0) && this.characterOpts.outline === "union";
    this.streamPlaceholders = 0; this.streamBodyFallbacks = 0; this.characters = 0; this.layerInstances = 0; this.nearN = 0;
    // nearest-N cutoff from last frame's candidate distances (one frame lag, no per-frame sort of all sprites)
    this.dressCut = nearestCutoff(this.dressD2, this.dressN, this.maxDressed); this.dressN = 0; this.dressDrawn = 0; this.dressCapped = 0;
    if (this.layerCache && (this.frameNo & 255) === 0) this.layerCache.prune((e) => world.isAlive(e));
    const hw = this.iso.tileW / 2, hh = this.iso.tileH / 2, zs = this.iso.zStep, zf = this.zFactor;
    // ADR-253 view rotation: projections / depth keys use view coords (u, v) = R_q (x, y); art facings get + q quarter turns;
    // world coords stay for distances, interiors, streaming priority. q = 0: u = x, v = y (bit-identical to before).
    const vq = (this.iso.view ?? 0) & 3, vc = VIEW_COS[vq]!, vs = VIEW_SIN[vq]!, vFace = vq * (Math.PI / 2);
    const margin = 256;
    const r0x = rect.x0 - margin, r1x = rect.x1 + margin, r0y = rect.y0 - margin * 0.5, r1y = rect.y1 + margin * 2;
    const tx = tr.data.x, ty = tr.data.y, tz = tr.data.z, tf = tr.data.facing;
    const px = pv.data.x, py = pv.data.y, pz = pv.data.z, pf = pv.data.facing;
    const tickTime = world.tick - 1 + alpha;
    const res = this.res;
    const blobW = cx.style.blobShadow.widthFactor;
    const src = cx.transformSource; const xf = this.xf;

    // focus (local player) for occluder fading + cutaway
    let fx = 1e9, fy = 1e9, fk = -1e9, fwx = 0, fwy = 0, fwz = 0, hasFocus = false;
    if (this.focusEntity >= 0 && world.isAlive(this.focusEntity)) {
      const fi = entityIndex(this.focusEntity); const ts = tr.slot(fi);
      if (ts >= 0) {
        const ps = pv.slot(fi);
        fwx = ps >= 0 ? px[ps]! + (tx[ts]! - px[ps]!) * alpha : tx[ts]!;
        fwy = ps >= 0 ? py[ps]! + (ty[ts]! - py[ps]!) * alpha : ty[ts]!;
        fwz = ps >= 0 ? pz[ps]! + (tz[ts]! - pz[ps]!) * alpha : tz[ts]!;
        if (cx.transformSource?.entities.has(this.focusEntity) && cx.transformSource.sample(world, this.focusEntity, alpha, this.xf)) { fwx = this.xf[0]!; fwy = this.xf[1]!; fwz = this.xf[2]!; }
        const fu = vc * fwx - vs * fwy, fv = vs * fwx + vc * fwy;
        fx = (fu - fv) * hw; fy = (fu + fv) * hh - fwz * zs - 20; fk = fu + fv + fwz * zf; hasFocus = true;
      }
    }
    const playerLevel = hasFocus ? terrainZToFloor(fwz, Math.max(0, cx.groundZAt?.(Math.floor(fwx), Math.floor(fwy)) ?? 0)) : 0;
    const cut = !hasFocus ? null : cx.grid ? cutawayRegion(cx.grid, Math.floor(fwx), Math.floor(fwy), playerLevel, 600, (sid) => atlas.isRoof(sid))
      : this.cover.region(Math.floor(fwx), Math.floor(fwy), playerLevel);
    this.cutawayActive = !!cut;
    const hideOtherStory = (x: number, y: number, z: number): boolean => {
      if (!cut) return false;
      const tx = Math.floor(x), ty = Math.floor(y);
      if (!cut.has(`${tx},${ty}`)) return false;
      return terrainZToFloor(z, Math.max(0, cx.groundZAt?.(tx, ty) ?? 0)) !== playerLevel;
    };
    // focus screen rect (from its current frame; fallback 32x56) for the occlusion test
    const occ = cx.style.occlusion; const occOn = occ.enabled && hasFocus;
    let fl = 0, fr = 0, ft = 0, fb = 0;
    if (occOn) {
      const fsl = sp.slot(entityIndex(this.focusEntity));
      const ok = fsl >= 0 && atlas.resolve(sp.data.spriteId[fsl]!, -1, 0, 0, sp.data.frameId[fsl]!, res);
      const sc = fsl >= 0 ? sp.data.scale[fsl]! || 1 : 1;
      const w = ok ? res.w * sc : 32, h = ok ? res.h * sc : 56, ax = ok ? res.ax * sc : 16, ay = ok ? res.ay * sc : 56;
      const fu = vc * fwx - vs * fwy, fv = vs * fwx + vc * fwy; const sx0 = (fu - fv) * hw, sy0 = (fu + fv) * hh - fwz * zs;
      fl = sx0 - ax + w * 0.2; fr = sx0 - ax + w * 0.8; ft = sy0 - ay + h * 0.1; fb = sy0 - ay + h * 0.95;
      this.focusScr = [sx0, sy0 - Math.min(ay, h) * 0.5];
    }
    const dtOcc = this.occLast < 0 ? 1 : Math.min(0.25, Math.max(0, cx.now - this.occLast)); this.occLast = cx.now;
    const occStep = Math.min(1, dtOcc * occ.fadeSpeed);
    /** Smoothed occlusion amount for entity index i given whether it occludes this frame. */
    const occAmount = (i: number, hit: boolean): number => {
      if (i >= this.occT.length) { const n = new Float32Array(Math.max(i + 1, this.occT.length * 2)); n.set(this.occT); this.occT = n; }
      const v = this.occT[i]! + ((hit ? 1 : 0) - this.occT[i]!) * occStep;
      this.occT[i] = v < 0.004 ? 0 : v; return this.occT[i]!;
    };
    /** Screen rect [l, r] x [t, b] of a sprite overlaps the focus rect. */
    const overlapsFocus = (l: number, r: number, t: number, b: number): boolean => occOn && r > fl && l < fr && b > ft && t < fb;
    this.silOn = false; this.late.length = 0;
    this.occ = { occAmount, peek: (i: number): number => this.occT[i] ?? 0, overlapsFocus, occOn, fk };

    // ---- dynamic Sprite entities ----
    const emitSprite = (k: number): void => {
      const e = sp.dense[k]!; const i = entityIndex(e);
      const ts = tr.slot(i); if (ts < 0) return;
      const ps = pv.slot(i);
      let x = tx[ts]!, y = ty[ts]!, z = tz[ts]!, f = tf[ts]!;
      if (src && src.entities.has(e) && src.sample(world, e, alpha, xf)) { x = xf[0]!; y = xf[1]!; z = xf[2]!; f = xf[3]!; }
      else if (ps >= 0) { x = px[ps]! + (x - px[ps]!) * alpha; y = py[ps]! + (y - py[ps]!) * alpha; z = pz[ps]! + (z - pz[ps]!) * alpha; f = lerpAngle(pf[ps]!, f, alpha); }
      if (e !== this.focusEntity && hideOtherStory(x, y, z)) return;
      const vu = vc * x - vs * y, vv = vs * x + vc * y; f += vFace; // ADR-253: view position + art facing
      const sx = (vu - vv) * hw, sy = (vu + vv) * hh - z * zs;
      let sid = sp.data.spriteId[k]!;
      const spk = this.seasonPick(atlas, sid); const seasonGr = spk.sid === sid && this.season.fall + this.season.winter > 0.002 ? SEASON_GROUND : 0; sid = spk.sid; const seasonFl = spk.flags; // ADR-239 (ADR-246: flat decals w/o season art get the ground pass)
      // manifest "stream" sheets: page in inside view + margin (animals: wider, they walk into view), keep resident inside
      // margin x STREAM_KEEP_FACTOR (hysteresis); outside both the page times out (AtlasManager.unloadIdleStream)
      const sprio = hasFocus ? (x - fwx) * (x - fwx) + (y - fwy) * (y - fwy) : Infinity;
      if (atlas.isStreamSprite(sid)) {
        const m = an && an.slot(i) >= 0 ? STREAM_MARGIN_ANIMAL_PX : STREAM_MARGIN_PX; const km = m * STREAM_KEEP_FACTOR;
        if (sx >= rect.x0 - km && sx <= rect.x1 + km && sy >= rect.y0 - km && sy <= rect.y1 + km)
          atlas.streamNear(sid, sx >= rect.x0 - m && sx <= rect.x1 + m && sy >= rect.y0 - m && sy <= rect.y1 + m, sprio);
      }
      if (sx < r0x || sx > r1x || sy < r0y || sy > r1y) {
        // ADR-188: wardrobe/hair prefetch ring: a character walking toward the view requests its layer pages before it is
        // drawn, so it enters fully dressed (staggered: each entity every PREFETCH_EVERY frames)
        const pm = PREFETCH_RING_PX; const aps0 = ap ? ap.slot(i) : -1;
        if (aps0 >= 0 && this.layerCache && ((this.frameNo + i) % PREFETCH_EVERY) === 0 && sx >= r0x - pm && sx <= r1x + pm && sy >= r0y - pm && sy <= r1y + pm) {
          const ov = this.layerCache.binding.override?.(world, e) ?? null;
          const read = () => { const v = readAppearanceSlot(apData!, apLen, aps0); if (ov) { const parts = Array.from(v.parts); for (const [s2, w] of ov.parts) if (s2 >= 0 && s2 < parts.length) parts[s2] = w; return { ...v, parts }; } return v; };
          for (const l of this.layerCache.get(i, e, apVer![aps0]! + (ov ? ov.salt * 65536 : 0), f, read, {})) if (atlas.isStreamed(l.sprite)) { atlas.pageReady(l.sprite, sprio + PREFETCH_PRIO_PAD); this.prefetches++; }
        }
        return;
      }
      this.curRoute = 0;
      for (const rg of this.interiorRegions) if (inInteriorRegion(rg, x, y)) { this.curRoute = this.interiorFloorIds.has(sid) ? InteriorRoute.Floor : InteriorRoute.Occupant; break; }
      atlas.markUsed(sid); // hot/cold tiers: drawn-near-camera atlases stay (or are re-tiered) full res
      // character customization: resolved paper-doll layers (cached); the "body" layer replaces Sprite.spriteId
      let layers: CachedLayer[] | null = null; let bodyL: CachedLayer | null = null;
      let ch0: readonly string[] | undefined; let chSt = -1; // ADR-241 per-entity anim chain (+ the state it was picked for)
      const aps = ap ? ap.slot(i) : -1;
      if (aps >= 0 && this.layerCache) {
        // key (entity, Appearance.version, facing4); version wraps (u16) so the cache compares it for equality only
        // resolveLayers gets the body's current anim name (face/eyes expressions via faceAnims, ADR-082): the AnimState
        // anim resolved on the body sprite (re-resolved once when the body sprite's anim name differs from the guess)
        const as0 = an ? an.slot(i) : -1; const st0 = as0 >= 0 && an ? an.data.state[as0]! : -1;
        const ov = this.layerCache.binding.override?.(world, e) ?? null;
        const read = () => { const v = readAppearanceSlot(apData!, apLen, aps); if (ov) { const parts = Array.from(v.parts); for (const [s, w] of ov.parts) if (s >= 0 && s < parts.length) parts[s] = w; return { ...v, parts }; } return v; };
        const ver = apVer![aps]! + (ov ? ov.salt * 65536 : 0); // equality-only cache key (u16 version + gear salt)
        const expr = activeExpression(world as never, e, this.layerCache.binding);
        const ro = (anim: string | undefined) => ({ ...(anim !== undefined ? { anim } : {}), ...(expr !== undefined ? { expression: expr } : {}) });
        chSt = st0; ch0 = st0 >= 0 && cx.bindings.animChain ? cx.bindings.animChain(e, st0, (tickTime - an!.data.startTick[as0]!) / cx.tickHz) : undefined; // ADR-241
        let animName = st0 >= 0 ? atlas.animName(sid, atlas.chainAnim(sid, ch0, st0)) : undefined;
        layers = this.layerCache.get(i, e, ver, f, read, ro(animName));
        for (const l of layers) if (l.slot === "body") { bodyL = l; sid = l.sprite; break; }
        if (bodyL && st0 >= 0) { const nm = atlas.animName(sid, atlas.chainAnim(sid, ch0, st0)); if (nm !== animName) { animName = nm;
          layers = this.layerCache.get(i, e, ver, f, read, ro(nm)); bodyL = null;
          for (const l of layers) if (l.slot === "body") { bodyL = l; sid = l.sprite; break; } } }
        else if (bodyL && st0 < 0 && bodyL.animName) { layers = this.layerCache.get(i, e, ver, f, read, ro(bodyL.animName)); bodyL = null;
          for (const l of layers) if (l.slot === "body") { bodyL = l; sid = l.sprite; break; } }
      }
      if (bodyL && atlas.isStreamed(sid)) atlas.pageReady(sid, 0); // ADR-240: request a streamed (v2) body page at top priority (v1 body pages are paged in eagerly)
      if (bodyL) atlas.markUsed(sid); // the paper-doll body sheet is visible art too: keep it in the hot (full-res) tier
      let ok: boolean;
      const as = an ? an.slot(i) : -1;
      let st = -1, t = 0; let dollAnim = "";
      if (as >= 0 && an) {
        st = an.data.state[as]!; t = (tickTime - an.data.startTick[as]!) / cx.tickHz * (cx.bindings.animRate?.(e, st) ?? 1);
        // paper doll: body + wear play one shared anim (frame-aligned across multi-page sheets, e.g. swim/punch pages)
        if (st !== chSt) ch0 = cx.bindings.animChain?.(e, st, (tickTime - an.data.startTick[as]!) / cx.tickHz);
        const bai = bodyL && layers ? (ch0 ? atlas.sharedChainAnim(sid, layers, ch0, st) : atlas.sharedStateAnim(sid, layers, st)) : atlas.chainAnim(sid, ch0, st);
        ok = atlas.resolve(sid, bai, f, t, 0, res);
        // ADR-244 (b): a v2 combat/ranged/pose/sleep sheet streams; until its page is in, the doll plays the resident core
        // idle (body + every layer follow dollAnim), never a missing/placeholder body
        if (bodyL && ok && res.atlas >= 0 && !atlas.streamPageReady(res.atlas, sprio)) { const ia = atlas.animIndex(sid, "idle"); if (ia >= 0 && atlas.resolve(sid, ia, f, t, 0, res)) this.streamBodyFallbacks++; }
        if (bodyL) { dollAnim = res.anim; if (ok && res.atlas >= 0) atlas.markUsedAt(res.atlas); }
      } else {
        // ADR-218: a lit fire sprite (station bonfire: Fuel.lit, frame 0 = idle) loops its idle anim on the render clock
        const ls = litSt && !bodyL && sp.data.frameId[k]! === 0 ? litSt.slot(i) : -1; const fa = ls >= 0 && litData!.lit?.[ls] ? atlas.fireAnim(sid) : -1;
        ok = fa >= 0 ? atlas.resolve(sid, fa, f, fireAnimTime(cx.now, i), 0, res) : atlas.resolve(sid, bodyL ? atlas.animIndex(sid, bodyL.animName) : -1, f, 0, sp.data.frameId[k]!, res);
      }
      // stream sheet still loading: its placeholder (resident sprout/stub) or nothing
      if (ok && !bodyL && res.atlas >= 0 && !atlas.streamPageReady(res.atlas, sprio)) {
        const ph = atlas.placeholderOf(sid); if (ph < 0) return;
        sid = ph; ok = atlas.resolve(ph, -1, f, 0, 0, res); this.streamPlaceholders++;
      }
      if (!ok) return;
      // ADR-241 seat socket: a v2 sit/vehicle frame's `seat` anchor (pelvis contact) lands on the entity position (the
      // vehicle seat socket) instead of the feet pivot; body + layers shift together. v1 frames have no seat: unchanged.
      let seatDx = 0, seatDy = 0;
      if (bodyL && (res.anim === "vehicle" || res.anim === "sit")) { const sa = atlas.handOf(res, SEAT_SOCKET); if (sa) { seatDx = sa.x - res.ax; seatDy = sa.y - res.ay; res.ax += seatDx; res.ay += seatDy; } }
      // ADR-244 (c): sleep_lie* frames sit on the bed (pivot = bed footprint centre + bedFits offset) and sort after it
      let bedBias = 0;
      if (bodyL && res.anim.startsWith("sleep_lie")) { const bf = cx.bindings.bedFit?.(e); if (bf) { res.ax -= bf.x; res.ay -= bf.y; seatDx -= bf.x; seatDy -= bf.y; bedBias = BED_SORT_EPS; } }
      const scale = sp.data.scale[k]! || 1;
      const key = vu + vv + z * zf + bedBias;
      // occlusion: tall sprites (or explicit Occluders) in front of the focus whose rect overlaps it
      let occT = 0, fade = 1;
      if (occOn && e !== this.focusEntity) {
        const os = oc.slot(i); const hgt = res.ay * scale;
        // characters / animated actors never auto-occlude (only tall static props); an explicit Occluder still opts in
        const actor = aps >= 0 || as >= 0;
        let hit = false;
        if ((os >= 0 || (hgt >= occ.minHeightPx && !actor && !(sp.data.flags[k]! & SpriteFlag.Footprint))) && key > fk + 0.05) { // Footprint (vehicles) only via explicit Occluder
          const left = sx - res.ax * scale, top = sy - res.ay * scale;
          hit = overlapsFocus(left, left + res.w * scale, top, sy);
        }
        // actors without an explicit Occluder never fade: also reset the smoothed state (entity indices are reused, e.g.
        // a character spawned on a destroyed tree's slot inherited its fade -> semi-transparent character in chars_lineup)
        if (actor && os < 0) { if (i < this.occT.length) this.occT[i] = 0; occT = 0; } else occT = occAmount(i, hit);
        // explicit Occluder.fade overrides the style alpha (fade mode); see occluderFade (Task 21)
        if (os >= 0 && occT > 0 && occ.mode === "fade") { fade = occluderFade(oc.data.fade[os]!, occT); occT = 0; }
      }
      const ss = sh.slot(i); const crisp = atlas.isCrisp(res.atlas); if (crisp) atlas.markUsedAt(res.atlas);
      else if (occOn && oc.slot(i) >= 0 && oc.data.fade[oc.slot(i)]! >= 1) atlas.markUsedAt(res.atlas); // ADR-152: never-fade props (campfire) keep their atlas hot
      let sAl = 1; if (sa) { const s2 = sa.slot(i); if (s2 >= 0) { sAl = Math.max(0, Math.min(1, sa.data.alpha[s2]!)); fade *= sAl; } } // ADR-238: whole-sprite fade
      // ADR-253 fallback: non-directional art (props, decor) mirrors on odd view quarters (no art for the other facings)
      const mir = (vq & 1) && !atlas.isDirectional(sid) ? SpriteFlag.FlipX : 0;
      const o0 = this.writeOne(sx, sy, key, scale, res, (sp.data.flags[k]! ^ mir) | (ls.slot(i) >= 0 ? SpriteFlag.BloomSource : 0) | (crisp ? CRISP : 0) | ((sp.data.flags[k]! & SpriteFlag.Flat) ? seasonGr : seasonFl), (i * 0.618034) % 1, fade, -OPEN, OPEN, sp.data.tint[k]! >>> 0, 0,
        ss >= 0 ? sh.data.alpha[ss]! * sAl : 0, 0, 0, ss >= 0 ? blobW * (sh.data.length[ss]! || 1) : 0);
      if (wet) { const s2 = wet.slot(i); if (s2 >= 0) { o0[20] = wet.data.level[s2]! / 255; if (o0[20] > 0.3) cx.statusFx?.("wet", x, y, z, o0[20]); } }
      if (bt) { const s2 = bt.slot(i); if (s2 >= 0) { o0[21] = bt.data.cold[s2]! / 255; o0[22] = bt.data.shivering[s2]! ? 1 : 0; o0[23] = (bt.data.heat[s2]! / 255) * cx.style.fx.flushStrength;
        if (o0[22] || o0[21] > COLD_BREATH) cx.statusFx?.("cold", x, y, z, Math.max(o0[21], o0[22] * 0.5)); else if (bt.data.heat[s2]! > 150) cx.statusFx?.("heat", x, y, z, bt.data.heat[s2]! / 255); } }
      if (exh) { const s2 = exh.slot(i); if (s2 >= 0) o0[31] = exh.data.level[s2]! / 255; }
      if (t2s) { const s2 = t2s.slot(i); if (s2 >= 0) writeTint2(o0, t2s.data.tint[s2]! >>> 0); }
      const sw = atlas.swayOf(sid);
      if (sw) { o0[24] = sw[0]!; o0[25] = sw[1]!; o0[26] = sw[2]!; }
      o0[27] = occT;
      if (hitOf) { const hf = hitOf(e); if (hf > 0) o0[18] = -Math.min(1, hf); }
      // ADR-107 swim fallback: no "swim" frames on this sprite -> walk frames, lower body clipped at the waterline + bob
      if (st === CoreAnimState.Swim && res.anim !== "swim") { o0[36] = res.ay * SWIM_CLIP; o0[37] = SWIM_BOB_PX; }
      if (bodyL) this.writeLayerTint(o0, bodyL);
      // paper-doll depth: the vertex shader clamps the height term per vertex (max(hp, 0)), so a quad reaching below the
      // pivot gets a flatter interpolated depth slope than one that doesn't. Body and wear quads have different extents
      // (trimmed wear cells), so their slopes crossed and the body won below a straight line through the hat. Lift the whole
      // character by its below-pivot extent (same sliceFootDy channel held items use) so no vertex clamps: identical slope.
      // ...and the drawn key drops by the same lift x uZPerPx (paperDollDepth): pivot depth unchanged, so dressed characters
      // do not sort ahead of walls/props they stand behind. `key` (occlusion tests) is not changed.
      let dkey = key; if (bodyL) { const pd = paperDollDepth(key, res.h, res.ay, scale, this.zFactor / this.iso.zStep); o0[15] = pd.footDy; o0[2] = dkey = pd.key; }
      if (e === this.focusEntity && occ.silhouette) { this.silInst.set(o0.subarray(0, INSTANCE_FLOATS)); this.silInst[27] = 0; this.silInst[2] = silhouetteKey(dkey, layers?.length ?? 0); this.silOn = true; }
      this.pushOcc(o0, 0, occT, occ.mode);
      let dress = true;
      // page priority: 0 = local player, else squared tile distance to them; near characters (<= PRIO_NEAR) are
      // exempt from the dress cap and the ladder's wearable eviction and win pool slots over farther ones
      const cdx = x - fwx, cdy = y - fwy; const prio = e === this.focusEntity ? 0 : hasFocus ? cdx * cdx + cdy * cdy : Infinity;
      const nearC = prio <= PRIO_NEAR;
      if (layers && layers.length && Number.isFinite(this.maxDressed) && !nearC) {
        const dx = sx - (r0x + r1x) * 0.5, dy = sy - (r0y + r1y) * 0.5, d2 = dx * dx + dy * dy;
        if (this.dressN >= this.dressD2.length) { const g = new Float32Array(this.dressD2.length * 2); g.set(this.dressD2); this.dressD2 = g; }
        this.dressD2[this.dressN++] = d2;
        dress = d2 <= this.dressCut && this.dressDrawn < this.maxDressed; if (dress) this.dressDrawn++; else this.dressCapped++;
      }
      if (layers && layers.length && (dress || this.dressFaces)) {
        if (dress) this.characters++;
        if (nearC && this.nearN < this.nearInfo.length) { const ni = this.nearInfo[this.nearN]!; ni.e = e; ni.d = Math.sqrt(prio); ni.layers = 0; ni.resident = 0; ni.drawn = 0; ni.scale = 1; ni.missing.length = 0; }
        // copy the body instance (pivot, flip, seed -> same shiver, status fx, occlusion, flash) and swap frame + tint;
        // keys step by LAYER_BIAS in resolveLayers order so a character's layers stay contiguous; outline-only copies
        // sit just behind the body so only the ring outside the union silhouette survives
        const base = this.layerBase; base.set(o0.subarray(0, INSTANCE_FLOATS));
        const lr = this.layerRes; let j = 0;
        // ADR-128 neck: head-group layers (face, eyes, hair, headwear) follow the body frame's head anchor
        const ho = atlas.headOffsetOf(res); const hoOn = ho.x !== 0 || ho.y !== 0;
        // ADR-188: plan every layer first, draw after. When any layer that should draw is not resident, the character keeps
        // its previous fully-composited look (each slot's last good frame) instead of drawing a partial set (pale body-only
        // flash, hair dropping out and back); the composite is only refreshed (lastGood) when every layer is resident.
        // ADR-220: held entries are frame-table / atlas indices of the layout they were recorded in; after a rebuild they
        // point at other frames (a stranger's sleeve on the torso, a shifted UV rect) - never replay them across layouts
        if (this.lastGoodLayout !== atlas.layoutVersion) { this.lastGood.clear(); this.lastGoodLayout = atlas.layoutVersion; }
        const plan = this.layerPlan; let pn = 0; let complete = true;
        for (const l of layers) {
          if (l === bodyL) continue; j++;
          const faceL = FACE_SLOTS.includes(l.slot);
          if (!dress && !faceL) continue; // dress-capped: body + face only (eyes keep the character readable)
          if (lodMinor && l.minor && !nearC && !faceL) continue;
          // the body's shared anim when this layer has it (same frame index + facing -> aligned, whichever page holds it),
          // else the layer's own state anim (face/eyes expression layers)
          const lai = st >= 0 ? (dollAnim ? atlas.findAnim(l.sprite, dollAnim) : -1) : -1;
          const okL = st >= 0 ? atlas.resolve(l.sprite, lai >= 0 ? lai : atlas.chainAnim(l.sprite, ch0, st), f, t, 0, lr) : atlas.resolve(l.sprite, atlas.animIndex(l.sprite, l.animName), f, 0, sp.data.frameId[k]!, lr);
          // readiness of the page this frame actually lives on (a swim/punch wear page streams on its own)
          // face/eyes pages request at 1/4 of the character's distance priority: they win pool slots over farther clothing
          const lp = faceL ? prio * 0.25 : prio; const rdy = okL && (lr.atlas >= 0 ? atlas.pageReadyAt(lr.atlas, lp) : atlas.pageReady(l.sprite, lp));
          // hot/cold tiers: a drawn layer's page is visible art like the body sheet; unmarked, hair/face/wear pages could be
          // re-tiered to the cold (downscaled) size under a full-res body (soft hair edge -> scalp shows at the hairline)
          if (rdy && lr.atlas >= 0) atlas.markUsedAt(lr.atlas);
          if (nearC && this.nearN < this.nearInfo.length) { const ni = this.nearInfo[this.nearN]!; if (ni.e === e) { ni.layers++; if (rdy) ni.resident++; else ni.missing.push(l.slot); const pi = atlas.pageInfo(l.sprite); ni.scale = Math.min(ni.scale, pi.scale); } }
          if (pn >= plan.length) plan.push({ l, j: 0, faceL: false, rdy: false, atlas: -1, entry: 0, ax: 0, ay: 0 });
          const q = plan[pn++]!; q.l = l; q.j = j; q.faceL = faceL; q.rdy = rdy; q.atlas = lr.atlas; q.entry = lr.entry; q.ax = lr.ax; q.ay = lr.ay;
          if (!rdy) complete = false;
        }
        for (let pi = 0; pi < pn; pi++) {
          const q = plan[pi]!; const l = q.l; const faceL = q.faceL; const lp = faceL ? prio * 0.25 : prio;
          const lgk = `${e}|${l.slot}`; const g = this.lastGood.get(lgk);
          const gr = !!g && (g.atlas >= 0 ? atlas.pageReadyAt(g.atlas, lp) : atlas.pageReady(g.sprite, lp));
          const lsrc = layerSource(complete, q.rdy, g ? g.sprite : -1, gr, l.sprite);
          if (lsrc === "skip") continue;
          if (complete) {
            if (g) { g.sprite = l.sprite; g.atlas = q.atlas; g.entry = q.entry; g.ax = q.ax; g.ay = q.ay; }
            else { if (this.lastGood.size > 8192) this.lastGood.clear(); this.lastGood.set(lgk, { sprite: l.sprite, atlas: q.atlas, entry: q.entry, ax: q.ax, ay: q.ay }); }
          }
          if (lsrc === "held") { lr.entry = g!.entry; lr.ax = g!.ax; lr.ay = g!.ay; this.lastGoodHits++; }
          else { lr.entry = q.entry; lr.ax = q.ax; lr.ay = q.ay; if (lsrc === "partial") this.partialLayers++; }
          const j = q.j;
          o0.set(base); o0[4] = lr.entry; o0[8] = lr.ax + seatDx; o0[9] = lr.ay + seatDy; o0[16] = 0;
          if (hoOn && atlas.isHeadSprite(l.sprite)) { o0[8] = lr.ax + seatDx - ho.x; o0[9] = lr.ay + seatDy - ho.y; }
          if (outlineOn && l.outline && !(sp.data.flags[k]! & SpriteFlag.NoOutline)) {
            o0[2] = dkey - LAYER_BIAS * 0.5; o0[5] = (base[5]! & ~SpriteFlag.NoOutline) | OUTLINE_ONLY;
            this.pushOcc(o0, 0, occT, occ.mode); this.layerInstances++;
          }
          if (nearC && this.nearN < this.nearInfo.length && this.nearInfo[this.nearN]!.e === e) this.nearInfo[this.nearN]!.drawn++;
          o0[2] = dkey + j * LAYER_BIAS; o0[5] = base[5]! | SpriteFlag.NoOutline | (faceL ? FACE_LAYER : 0);
          this.writeLayerTint(o0, l);
          this.pushOcc(o0, 0, occT, occ.mode); this.layerInstances++;
        }
        o0.set(base);
        if (nearC && this.nearN < this.nearInfo.length) this.nearN++;
      }
      // ADR-249: no held / carried / off-hand items while sleeping (sleep, sleep_lie, sleep_lie_under): hands are empty in bed
      const asleep = res.anim.startsWith("sleep");
      if (eq && heldOf && !asleep) { const s2 = eq.slot(i); if (s2 >= 0) { const hs = eq.data.mainHandSlot[s2]!; const dye = hs !== 255 ? (cx.bindings.heldDye?.(e, hs) ?? 0) : 0; this.emitHeld(atlas, heldOf, eq.data.mainHandItem[s2]!, res, sx, sy, dkey, scale, f, (sp.data.flags[k]! & SpriteFlag.FlipX) !== 0, fade, occT, occ.mode, bodyL ? o0[15]! : 0, false, fireAnimTime(cx.now, i), undefined, dye); } }
      const cs = cx.bindings.carriedSprite?.(e); // ADR-241 carry socket
      if (cs !== undefined && bodyL && !asleep) this.emitHeld(atlas, carriedId, cs + 1, res, sx, sy, dkey, scale, f, (sp.data.flags[k]! & SpriteFlag.FlipX) !== 0, fade, occT, occ.mode, o0[15]!, false, 0, CARRY_SOCKET);
      if (oh && offOf && !asleep) { const s3 = oh.slot(i); if (s3 >= 0) this.emitHeld(atlas, offOf, oh.data.offHandItem[s3]!, res, sx, sy, dkey, scale, f, (sp.data.flags[k]! & SpriteFlag.FlipX) !== 0, fade, occT, occ.mode, bodyL ? o0[15]! : 0, true, fireAnimTime(cx.now, i)); }
    };
    if (cx.spatial) {
      // chunk-level culling through the shared spatial index
      // culled with the sprite margin too: a character standing just past a chunk's diamond edge was dropped with its chunk
      const keys = visibleChunkKeys({ x0: r0x, y0: r0y, x1: r1x, y1: r1y }, hw, hh, zs, 16, vq);
      for (const ck of keys) {
        if (cx.spatial.activeKeys && !cx.spatial.activeKeys.has(ck)) continue;
        for (const e of cx.spatial.index.entitiesInChunk(ck)) { const s = sp.slot(entityIndex(e)); if (s >= 0) emitSprite(s); }
      }
    } else for (let k = 0; k < sp.size; k++) emitSprite(k);
    this.curRoute = 0;
    // interior cutaway walls: Art wall pieces along both long sides of each open interior
    if (this.interiorWallSprite >= 0 && this.interiorRegions.length && atlas.resolve(this.interiorWallSprite, -1, 0, 0, 0, res)) {
      this.curRoute = InteriorRoute.Wall;
      for (const rg of this.interiorRegions) {
        const c = Math.cos(rg.heading), sn = Math.sin(rg.heading), nSeg = Math.max(1, Math.round(rg.length));
        for (const side of [-1, 1]) for (let j = 0; j < nSeg; j++) {
          const u = -rg.length / 2 + (j + 0.5) * (rg.length / nSeg), v = side * rg.width / 2;
          const x = rg.cx + u * c - v * sn, y = rg.cy + u * sn + v * c;
          const wu = vc * x - vs * y, wv = vs * x + vc * y;
          this.push(this.writeOne((wu - wv) * hw, (wu + wv) * hh, wu + wv, 1, res, SpriteFlag.NoOutline | (side > 0 ? SpriteFlag.FlipX : 0), 0, 1, -OPEN, OPEN, 0, 0, 0, 0, 0, 0), 0);
        }
      }
      this.curRoute = 0;
    }

    // ---- VFX (render-side, short-lived) ----
    if (cx.vfx) for (const v of cx.vfx.active) {
      if (hideOtherStory(v.x, v.y, v.z)) continue;
      const xu = vc * v.x - vs * v.y, xv = vs * v.x + vc * v.y;
      const sx = (xu - xv) * hw, sy = (xu + xv) * hh - v.z * zs;
      if (sx < r0x || sx > r1x || sy < r0y || sy > r1y) continue;
      if (!atlas.resolve(v.spriteId, v.anim, v.facing + vFace, cx.now - v.born, 0, res)) continue;
      const life = Math.min(1, (cx.now - v.born) / Math.max(1e-3, v.lifetime));
      const fadeOut = (v.fade ? 1 - life : Math.min(1, (v.lifetime - (cx.now - v.born)) / 0.15)) * v.alpha;
      this.push(this.writeOne(sx, sy, xu + xv + v.z * zf + 0.05, v.scale * (v.s0 + (v.s1 - v.s0) * life), res, (v.emissive ? SpriteFlag.Emissive : 0) | SpriteFlag.NoOutline, 0, fadeOut, -OPEN, OPEN, 0, 0, 0, 0, 0, 0), 0);
    }

    // ---- build pieces ----
    this.staticInstances = 0;
    const bpDef = cx.bindings.buildPiece;
    if (bpDef) this.gatherPieces(cx, world.store(bpDef), hasFocus, fwx, fwy, playerLevel, cut);

    // ---- sort ----
    const n = this.n; const sorted = this.sortKeys.subarray(0, n);
    { // incremental: seed with last frame's sorted slot order (gather order is stable), then a budgeted insertion pass
      const keys = this.sortKeys, P = this.prevPerm, pn = this.prevN; let w = 0;
      if (this.seedBuf.length < keys.length) this.seedBuf = new Uint32Array(keys.length);
      const S = this.seedBuf, used = this.seedUsed.length < n ? (this.seedUsed = new Uint8Array(keys.length)) : this.seedUsed; used.fill(0, 0, n);
      for (let j = 0; j < pn; j++) { const sl = P[j]!; if (sl < n) { S[w++] = keys[sl]!; used[sl] = 1; } }
      for (let sl = 0; sl < n; sl++) if (!used[sl]) S[w++] = keys[sl]!;
      sorted.set(S.subarray(0, n));
      if (insertionSortBudget(sorted, n * 4 + 64)) this.sortIncremental++; else { sorted.sort(); this.sortFull++; }
      if (P.length < n) this.prevPerm = new Uint16Array(keys.length);
      for (let j = 0; j < n; j++) this.prevPerm[j] = sorted[j]! & 0xffff;
      this.prevN = n;
    }
    const inst = this.inst, tmp = this.tmp, route = this.route;
    const ik = this.intKeys, ir = this.intRoutes, ix = this.intIdx; ik.length = ir.length = ix.length = 0;
    let m = 0;
    for (let j = 0; j < n; j++) {
      const si = sorted[j]! & 0xffff, src = si * INSTANCE_FLOATS;
      if (route[si]) { ix.push(si); ik.push(tmp[src + 2]!); ir.push(route[si]!); continue; }
      const dst = m * INSTANCE_FLOATS; m++;
      for (let q = 0; q < INSTANCE_FLOATS; q++) inst[dst + q] = tmp[src + q]!;
    }
    this.visible = m;
    // interior pass: floor -> occupants -> walls (near walls faded/cut), drawn after the world so terrain never clips the floor
    this.intCount = 0;
    if (ix.length) {
      const rg = this.interiorRegions[0]; const centre = rg ? rg.cx + rg.cy : -Infinity;
      const { order, alpha } = interiorOrder(ir, ik, ix.length, this.interiorCut, centre);
      if (this.intBuf.length < order.length * INSTANCE_FLOATS) this.intBuf = new Float32Array(Math.max(1024, order.length * 2) * INSTANCE_FLOATS);
      const B = this.intBuf;
      for (let o = 0; o < order.length; o++) {
        const k2 = order[o]!, src = ix[k2]! * INSTANCE_FLOATS, dst = o * INSTANCE_FLOATS;
        for (let q = 0; q < INSTANCE_FLOATS; q++) B[dst + q] = tmp[src + q]!;
        B[dst + 7] = B[dst + 7]! * alpha[k2]!;
      }
      this.intCount = order.length;
    }
    // late (faded) batch: back-to-front by key
    const L = this.late, lc = L.length / INSTANCE_FLOATS; this.lateCount = lc;
    if (lc > 0) {
      if (this.lateOrder.length < lc) { this.lateOrder = new Uint32Array(lc * 2); this.lateBuf = new Float32Array(lc * 2 * INSTANCE_FLOATS); }
      const order = this.lateOrder; for (let j = 0; j < lc; j++) order[j] = j;
      for (let a = 1; a < lc; a++) { const v = order[a]!, kv = L[v * INSTANCE_FLOATS + 2]!; let b = a - 1; while (b >= 0 && L[order[b]! * INSTANCE_FLOATS + 2]! > kv) { order[b + 1] = order[b]!; b--; } order[b + 1] = v; }
      const buf = this.lateBuf.subarray(0, L.length);
      for (let o = 0; o < lc; o++) { const j = order[o]!; for (let q = 0; q < INSTANCE_FLOATS; q++) buf[o * INSTANCE_FLOATS + q] = L[j * INSTANCE_FLOATS + q]!; }
      const gl = this.gl;
      if (!this.lateVbo) { this.lateVbo = gl.createBuffer()!; this.lateVao = this.makeVao(this.lateVbo); }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lateVbo); gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    }
  }

  private decks = new DeckNeighbors(); private deckTops = new Map<number, number | undefined>();
  private deckTop(atlas: AtlasManager, vis: number): number | undefined {
    if (this.deckTops.has(vis)) return this.deckTops.get(vis);
    let key: string | undefined; try { key = atlas.registry?.sprite(vis).key; } catch { key = undefined; }
    const t = deckTopPx(key); if (atlas.registry) this.deckTops.set(vis, t); return t;
  }
  private gatherPieces(cx: PrepareContext, bp: ReturnType<World["store"]>, hasFocus: boolean, fwx: number, fwy: number, playerLevel: number, cut: Set<string> | null): void {
    const { world, atlas, rect } = cx; const tr = world.store(Transform);
    const pieceLit = cx.bindings.pieceLit, pieceScale = cx.bindings.pieceScale;
    const d = bp.data as Record<string, ArrayLike<number>>;
    const hw = this.iso.tileW / 2, hh = this.iso.tileH / 2, zs = this.iso.zStep, zf = this.zFactor;
    // ADR-253: footprints / cover / cutaway / decks stay in world tiles; screen pivot, occlusion rect, column slices and depth
    // keys use the view footprint (viewRect) and pivot; art resolves at rotation (rot + q) & 3 (+ mirror fallback)
    const vq = (this.iso.view ?? 0) & 3, vc = VIEW_COS[vq]!, vs = VIEW_SIN[vq]!;
    const res = this.res;
    this.coverNext.clear(); this.tierFallbacks = 0; this.streamFallbacks = 0; this.crackOverlays = 0;
    const focusFront = hasFocus ? (() => { const pr = viewRect(Math.floor(fwx), Math.floor(fwy), 1, 1, vq); return pr.x + pr.y + pr.w + pr.h; })() : 0;
    const scratch = this.staticScratch; for (const v of scratch.values()) v.length = 0;
    const checksums = this.pieceChecks; checksums.clear(); let lastCx = NaN, lastCy = NaN, lastVis = true; this.culledChunks = 0;
    // ADR-197: deck neighbour map (every non-ghost deck, not chunk-culled: a visible piece's neighbour may be off screen)
    const decks = this.decks; decks.clear();
    for (let k = 0; k < bp.size; k++) {
      if (d.ghost![k]! || !flatLayer(d.layer![k]!, false)) continue; const vis0 = d.visualId![k]!; if (atlas.isRoof(vis0)) continue;
      const top0 = this.deckTop(atlas, vis0); if (top0 === undefined) continue;
      const ts0 = tr.slot(entityIndex(bp.dense[k]!)); if (ts0 < 0) continue; const inf = atlas.pieceInfo(vis0); const r0 = d.rotation![k]! & 3;
      const w0 = inf ? (r0 & 1 ? inf.fh : inf.fw) : 1, h0 = inf ? (r0 & 1 ? inf.fw : inf.fh) : 1;
      decks.add(Math.floor(tr.data.x[ts0]!), Math.floor(tr.data.y[ts0]!), w0, h0, d.level![k]!, top0);
    }
    const tmp = this.pieceTmp; const nightSet = cx.bindings.nightEmissive?.sprites; this.nightGate = cx.bindings.nightEmissive?.gate ?? 1;
    for (let k = 0; k < bp.size; k++) {
      const e = bp.dense[k]!; const i = entityIndex(e); const ts = tr.slot(i); if (ts < 0) continue;
      { // chunk-grid cull: pieces in chunks well off screen keep their cached static buffer and skip resolve/write entirely
        const gcx = Math.floor(tr.data.x[ts]! / CHUNK_SIZE), gcy = Math.floor(tr.data.y[ts]! / CHUNK_SIZE);
        if (gcx !== lastCx || gcy !== lastCy) { lastCx = gcx; lastCy = gcy; lastVis = this.chunkOnScreen(gcx, gcy, rect, hw, hh); }
        if (!lastVis) continue;
      }
      // ADR-211: an L corner draws its two arm walls (same tier straight wall at the arm edge pivots) then its post art
      const parts = this.pieceParts; parts.length = 0;
      { const v0 = d.visualId![k]!, r0 = d.rotation![k]!, arm = atlas.lArmOf(v0);
        if (arm >= 0) for (const a of lCornerArmPivots(tr.data.x[ts]!, tr.data.y[ts]!, r0)) parts.push({ vis: arm, rot: a.rot | ROT_EXACT_PIVOT | ROT_DECK_LIFT, layer: 1, x: a.x, y: a.y, last: false });
        parts.push({ vis: v0, rot: r0, layer: d.layer![k]!, x: tr.data.x[ts]!, y: tr.data.y[ts]!, last: true }); }
      let anyHit = false;
      for (const part of parts) {
        const vis = part.vis; const rotRaw = part.rot; const rot = rotRaw & 3; const exact = (rotRaw & ROT_EXACT_PIVOT) !== 0; const level = d.level![k]!; const layer = part.layer;
        const ghost = d.ghost![k]!; const dmg = d.damageStage![k]!; const tints = cx.bindings.pieceTints?.(e); const tint = tints ? tints[0] : d.tint![k]! >>> 0;
        // tier page streaming in: draw the bare-key / other resident tier / family default art instead of nothing
        const spk = ghost > 0 ? { sid: vis, flags: 0 } : this.seasonPick(atlas, vis); // ADR-239: <key>_<season> piece art, else procedural
        const drawVis = pieceDrawSprite(atlas, spk.sid); if (drawVis < 0) continue;
        if (drawVis !== spk.sid) { if (atlas.streamClass(vis) === "bld") this.tierFallbacks++; else this.streamFallbacks++; }
        const pst = cx.bindings.pieceState?.(e) ?? (d.state ? d.state[k]! - 1 : -1);
        if (!atlas.resolvePiece(drawVis, d.variant![k]!, (rot + vq) & 3, dmg, res, pst)) continue;
        if ((vq & 1) && !atlas.isDirectional(drawVis)) res.flipX = !res.flipX; // ADR-253 fallback: no facing art -> mirror
        // ADR-218: lit fires animate their idle loop on the render clock (per-entity phase); out fires show their unlit frame
        let animated = false;
        const fire = pieceLit ? pieceLit(e) : undefined;
        const psc = pieceScale ? pieceScale(e) ?? 1 : 1; // ADR-227
        if (fire !== undefined && dmg === 0 && ghost === 0) {
          const flip = res.flipX, hd = res.hasDamageFrames;
          if (fire > 0) { const fa = atlas.fireAnim(drawVis); if (fa >= 0 && atlas.resolve(drawVis, fa, 0, fireAnimTime(cx.now, i), 0, res)) { animated = true; res.flipX = flip; res.hasDamageFrames = hd; } }
          else if (pst < 0) { const ua = atlas.namedAnim(drawVis, "unlit"); if (ua >= 0 && atlas.resolve(drawVis, ua, 0, 0, 0, res)) { res.flipX = flip; res.hasDamageFrames = hd; } }
        }
        const info = atlas.pieceInfo(vis); const sway = atlas.swayOf(vis);
        if (res.atlas >= 0) atlas.markUsedAt(res.atlas); // drawn building art counts as recently used: without this, fitBudget's idle demotion could cold-shrink walls/foundations/ceilings while characters stayed pinned at 1x
        const fw = info ? (rot & 1 ? info.fh : info.fw) : 1, fh = info ? (rot & 1 ? info.fw : info.fh) : 1;
        const ax = Math.floor(part.x), ay = Math.floor(part.y);
        const vr = viewRect(ax, ay, fw, fh, vq); const vax = vr.x, vay = vr.y, vfw = vr.w, vfh = vr.h; // view footprint
        const roof = atlas.isRoof(vis);
        this.coverNext.add(ax, ay, fw, fh, level, layer === PIECE_LAYER_DECK, roof);
        // roofs are deck-layer (0) pieces placed on the level above the walls and drawn from that level's floor (= wall top)
        const z = floorToTerrainZ(level, tr.data.z[ts]!);
        const inCut = !!cut && footprintHits(cut, ax, ay, fw, fh);
        if (pieceHiddenByStory(inCut, level, playerLevel)) continue;
        const cutaway = pieceShouldCutaway(inCut, level, playerLevel, roof, atlas.isEnclosure(vis), (rot + vq) & 3, vax + vay + vfw + vfh, focusFront);
        // occlusion (walls etc. not in cutaway): a hit, or a still-fading piece, is drawn dynamically this frame
        let occT = 0;
        if (!cutaway && !flatLayer(layer, roof) && !(rotRaw & ROT_NO_OCCLUDE) && this.occ.occOn) {
          const bottom = (vax + vay + vfw + vfh) * hh - z * zs; // front footprint corner
          const pivotY = cx.pieceAnchor === "front" ? bottom : (vax + vay + (vfw + vfh) / 2) * hh - z * zs;
          const top = pivotY - res.ay; const left = (vax - (vay + vfh)) * hw, right = (vax + vfw - vay) * hw;
          const front = vax + vfw + vay + vfh - 2 + 1.95 + z * zf;
          const hit = res.ay >= cx.style.occlusion.minHeightPx && front > this.occ.fk + 0.05 && this.occ.overlapsFocus(left, right, top, bottom);
          anyHit ||= hit; occT = part.last ? this.occ.occAmount(i, anyHit) : this.occ.peek(i); // ADR-211: an L fades as one piece (arms read the smoothed value, the post steps it)
        }
        const dynamic = ghost > 0 || cutaway || occT > 0 || animated;
        const alpha = cutaway ? cx.style.cutawayAlpha : 1;
        // footprint far corner (fx, fy); sprite pivot = footprint centre on the ground (art guide / sample manifest)
        // or the front-most footprint corner (cx.pieceAnchor === "front")
        const fx = vax + vfw, fy = vay + vfh; // view space
        // exact pivot (triangle centroid / vertex-snapped corner): the Transform position itself (world pvx/pvy; view pu/pv)
        const pvx = exact ? part.x : ax + fw / 2, pvy = exact ? part.y : ay + fh / 2;
        const pu = exact ? vc * part.x - vs * part.y : cx.pieceAnchor === "front" ? fx : vax + vfw / 2, pv = exact ? vs * part.x + vc * part.y : cx.pieceAnchor === "front" ? fy : vay + vfh / 2;
        // ADR-210: uprights on a deck stand on its top, not the ground under it
        const lift = rotRaw & ROT_DECK_LIFT ? (exact ? decks.topNear(pvx, pvy, level) : decks.topOver(ax, ay, fw, fh, level)) : 0;
        const sx = (pu - pv) * hw, sy = (pu + pv) * hh - z * zs - lift;
        const flat = flatLayer(layer, roof); // deck pieces (floors/foundations), never roofs
        // Build pieces were never crisp-sampled (only the character doll path set CRISP, and only for creatures):
        // walls at ~3x phone magnification were plain LINEAR, i.e. blurry on every preset. Same flag as the doll path.
        const flags = (flat ? SpriteFlag.Flat : 0) | (res.flipX ? SpriteFlag.FlipX : 0) | (nightSet?.has(vis) ? 64 : 0) | (flat || cutaway ? 0 : spk.flags) | (atlas.isCrisp(res.atlas) ? CRISP : 0);
        // damage 1-3: Art's crack overlay sprite (building.crackOverlay = bld_crack, anim stage<N>) on top of the (baked)
        // damage frame. Where bld_crack covers the stage, no procedural shader crack at all (a not-yet-resident page just
        // shows the bare damage frame for a moment); the procedural crack is kept only for sets with no overlay declared
        const crackSid = dmg > 0 ? atlas.crackOverlayOf(drawVis) : -1; const ca = crackAnim(dmg);
        const crackCovered = crackSid >= 0 && ca !== undefined;
        const crack = crackCovered && atlas.pageReady(crackSid, PRIO_NEAR) && atlas.resolve(crackSid, atlas.animIndex(crackSid, ca), 0, 0, 0, this.crackRes);
        const dmgOverlay = dmg > 0 && !res.hasDamageFrames && !crackCovered ? dmg : 0;
        const bias = (roof ? 0.05 : layer * 0.01) + (exact ? exactTieBreak(pu, pv, ghost > 0) : pieceTieBreak(vax, vay, ghost > 0)) + (rotRaw & ROT_VERTEX_POST ? vertexPostGlBias(hh, zf / zs) : 0) + (zs > 0 ? (lift / zs) * zf : 0); // roofs above every other layer of the cell; ADR-197 unique tie-break
        const deckTop = flat && !exact && cx.pieceAnchor !== "front" ? this.deckTop(atlas, vis) : undefined;
        const deckMask = deckTop === undefined ? 0 : rotSideMask(decks.mask(ax, ay, fw, fh, level, deckTop), vq); // view sides
        tmp.length = 0;
        // per-column slices: columns c = x - y over the footprint
        const cMin = vax - (fy - 1), cMax = (fx - 1) - vay;
        const single = flat || exact || cMin === cMax;
        for (let c = cMin; c <= cMax; c++) {
          // front-most tile in column c: maximise x+y with x-y=c inside footprint
          let best = -1e9;
          for (let tyy = vay; tyy < fy; tyy++) { const txx = c + tyy; if (txx >= vax && txx < fx) best = Math.max(best, txx + tyy); }
          // depth anchor: the front-most tile's centre (front-corner pivot) or its front corner (centre pivot, whose
          // pixels extend down to that corner and must not be clipped by the terrain in front of the pivot)
          const front = cx.pieceAnchor === "front" ? 1 : 1.95;
          const key = (exact ? pu + pv - 1 + front : single ? fx + fy - 2 + front : best + front) + z * zf + bias;
          const colCenter = c * hw - sx; // relative to pivot (px)
          const sliceL = single || c === cMin ? -OPEN : colCenter - hw / 2;
          const sliceR = single || c === cMax ? OPEN : colCenter + hw / 2;
          // slice foot = screen y of the front corner of its front-most tile, relative to pivot
          const footDy = single ? 0 : (best + 2) * hh - z * zs - sy;
          const o = this.writeOne(sx, sy, key, psc, res, flags, (i * 0.618034) % 1, alpha, sliceL, sliceR, tint, footDy, 0, ghost, dmgOverlay, 0);
          o[27] = occT;
          if (deckMask) { o[38] = deckMask | (vfw << 4) | (vfh << 8); o[39] = deckTop!; }
          if (sway) { o[24] = sway[0]!; o[25] = sway[1]!; o[26] = sway[2]!; } // SpriteDef.sway (+ masks.sway weights in the shader)
          if (tints?.[1]) writeTint2(o, tints[1]);
          for (let q = 0; q < INSTANCE_FLOATS; q++) tmp.push(o[q]!);
          if (single) break;
        }
        if (crack) {
          const r = this.crackRes; const ck0 = tmp[2]!; // on top of the piece (its first instance's key + epsilon)
          const o = this.writeOne(sx, sy, ck0 + 0.002, 1, r, flags, 0, alpha, -OPEN, OPEN, 0, 0, 0, 0, 0, 0);
          o[27] = occT; for (let q = 0; q < INSTANCE_FLOATS; q++) tmp.push(o[q]!); this.crackOverlays++;
        }
        if (dynamic) {
          if (sx < rect.x0 - 512 || sx > rect.x1 + 512 || sy < rect.y0 - 256 || sy > rect.y1 + 1024) continue;
          for (let j = 0; j < tmp.length; j += INSTANCE_FLOATS) this.pushOcc(tmp, j, occT, cx.style.occlusion.mode);
        } else {
          const ck = this.chunkKeyOf(Math.floor(ax / CHUNK_SIZE), Math.floor(ay / CHUNK_SIZE));
          let list = scratch.get(ck); if (!list) scratch.set(ck, (list = []));
          for (let j = 0; j < tmp.length; j++) list.push(tmp[j]!);
          let h = checksums.get(ck) ?? 0x811c9dc5;
          for (let j = 0; j < tmp.length; j++) h = Math.imul(h ^ Math.round(tmp[j]! * 64), 16777619) >>> 0;
          checksums.set(ck, h);
        }
      }
    }
    { const t = this.cover; this.cover = this.coverNext; this.coverNext = t; }
    // rebuild changed static chunks, drop empty ones
    for (const [ck, list] of scratch) {
      const sum = (checksums.get(ck) ?? 0) ^ list.length;
      let sc = this.statics.get(ck);
      if (list.length === 0) { if (sc) { this.gl.deleteBuffer(sc.vbo); this.gl.deleteVertexArray(sc.vao); this.statics.delete(ck); } scratch.delete(ck); continue; }
      if (!sc || sc.checksum !== sum) {
        const gl = this.gl;
        if (!sc) { const vbo = gl.createBuffer()!; const [cxs, cys] = ck.split(",").map(Number) as [number, number]; sc = { vbo, vao: this.makeVao(vbo), count: 0, checksum: 0, cx: cxs, cy: cys, maxZ: 0, seen: 0, born: cx.now }; this.statics.set(ck, sc); }
        // sort within chunk back-to-front for nicer edge blending
        const cnt = list.length / INSTANCE_FLOATS; const F = INSTANCE_FLOATS; const order = Array.from({ length: cnt }, (_, j) => j).sort((a, b) => (list[a * F + 2]! - list[b * F + 2]!) || (list[a * F + 1]! - list[b * F + 1]!) || (list[a * F]! - list[b * F]!) || (list[a * F + 4]! - list[b * F + 4]!)); // ADR-197: total order
        const buf = new Float32Array(list.length); let maxZ = 0;
        order.forEach((j, o) => { for (let q = 0; q < INSTANCE_FLOATS; q++) buf[o * INSTANCE_FLOATS + q] = list[j * INSTANCE_FLOATS + q]!; });
        for (let j = 0; j < cnt; j++) maxZ = Math.max(maxZ, -(buf[j * INSTANCE_FLOATS + 1]! - 0));
        gl.bindBuffer(gl.ARRAY_BUFFER, sc.vbo); gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
        sc.count = cnt; sc.checksum = sum; sc.maxZ = maxZ; this.staticRebuilds++;
      }
      sc.seen = this.frameNo;
      this.staticInstances += sc.count;
    }
    for (const sc of this.statics.values()) if (sc.seen !== this.frameNo && !this.chunkOnScreen(sc.cx, sc.cy, rect, hw, hh)) { sc.seen = this.frameNo; this.culledChunks++; }
    for (const [ck, sc] of this.statics) if (sc.seen !== this.frameNo) { this.gl.deleteBuffer(sc.vbo); this.gl.deleteVertexArray(sc.vao); this.statics.delete(ck); }
  }

  upload(): void {
    if (this.intCount > 0) {
      const gl = this.gl;
      if (!this.intVbo) { this.intVbo = gl.createBuffer()!; this.intVao = this.makeVao(this.intVbo); }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.intVbo); gl.bufferData(gl.ARRAY_BUFFER, this.intBuf.subarray(0, this.intCount * INSTANCE_FLOATS), gl.DYNAMIC_DRAW);
    }
    if (this.visible === 0) return;
    const gl = this.gl; const bytes = this.visible * INSTANCE_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (bytes > this.gpuBytes) { this.gpuBytes = this.capacity * INSTANCE_FLOATS * 4; gl.bufferData(gl.ARRAY_BUFFER, this.gpuBytes, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, this.visible * INSTANCE_FLOATS);
  }

  private setupFrame = -1; private setupTex: WebGLTexture | null = null;
  private static readonly ZERO2: readonly [number, number] = [0, 0];
  private setup(pass: "shadow" | "sprite", u: Program["u"], view: Float32Array, depth: Float32Array, atlas: AtlasManager, time: number, wind: number,
    shadowDir: readonly [number, number], shadowAlpha: number, style: StyleConfig): void {
    const gl = this.gl;
    gl.useProgram(this.prog.prog);
    // first sprite pass of the frame uploads everything; later passes (shadow / sprite / silhouette / late) only the
    // per-pass uniforms: textures + frame constants stay bound (nothing else draws in between). ~110 fewer GL calls/frame.
    if (this.setupFrame === this.frameNo && this.setupTex === atlas.tex) {
      gl.uniform1f(u.uWind!, wind); gl.uniform1i(u.uShadowPass!, pass === "shadow" ? 1 : 0);
      gl.uniform2f(u.uShadowDir!, shadowDir[0], shadowDir[1]); gl.uniform1f(u.uShadowAlpha!, shadowAlpha);
      gl.uniform1i(u.uSilhouette!, 0); gl.uniform1f(u.uAlphaMul!, 1); gl.uniform1f(u.uOutline!, style.outline.enabled ? style.outline.widthPx : 0);
      return;
    }
    this.setupFrame = this.frameNo; this.setupTex = atlas.tex;
    gl.uniform4fv(u.uView!, view); gl.uniform2fv(u.uDepth!, depth); gl.uniform2f(u.uViewPx!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform3f(u.uSeason ?? null, this.season.fall, this.season.winter, this.seasonSnowCap);
    gl.uniform1f(u.uZPerPx!, this.zFactor / this.iso.zStep); gl.uniform1f(u.uHH!, this.iso.tileH / 2); gl.uniform1f(u.uHW ?? null, this.iso.tileW / 2);
    gl.uniform1f(u.uTime!, time); gl.uniform1f(u.uWind!, wind);
    gl.uniform2fv(u.uWindVec!, this.windVec); gl.uniform3fv(u.uShadowColor!, this.shadowColor);
    gl.uniform3fv(u.uFrostColor!, style.fx.frostColor); gl.uniform3fv(u.uFlushTint!, style.fx.flushTint);
    gl.uniform1f(u.uWetDarken!, style.fx.wetDarken); gl.uniform1f(u.uWetSheen!, style.fx.wetSheen);
    gl.uniform1i(u.uShadowPass!, pass === "shadow" ? 1 : 0);
    gl.uniform1i(u.uShadowMode!, style.shadowMode === "blob" ? 0 : 1);
    gl.uniform1f(u.uBlobAspect!, style.blobShadow.aspect);
    gl.uniform2f(u.uShadowDir!, shadowDir[0], shadowDir[1]); gl.uniform1f(u.uShadowAlpha!, shadowAlpha);
    gl.uniform1f(u.uOutline!, style.outline.enabled ? style.outline.widthPx : 0);
    gl.uniform4fv(u.uOutlineColor!, style.outline.color);
    gl.uniform1f(u.uCharOutline ?? null, this.characterOpts.outlineWidthPx); gl.uniform4fv(u.uCharOutlineColor ?? null, this.characterOpts.outlineColor);
    const oc = style.occlusion;
    gl.uniform1i(u.uOccMode!, oc.mode === "dither" ? 1 : 0); gl.uniform1f(u.uOccAlpha!, oc.alpha); gl.uniform1f(u.uOccRadius!, oc.radiusPx);
    gl.uniform2f(u.uFocusScr!, this.focusScr[0], this.focusScr[1]); gl.uniform1i(u.uSilhouette!, 0); gl.uniform4fv(u.uSilColor!, oc.silhouetteColor);
    gl.uniform1f(u.uAlphaMul!, 1); gl.uniform1f(u.uTexel!, 1 / atlas.layerSize); gl.uniform1f(u.uEmisStrength!, style.emissiveStrength); gl.uniform1f(u.uNightGate!, this.nightGate);
    gl.uniform1f(u.uFaceBias!, this.characterOpts.faceMipBias); gl.uniform1f(u.uFaceContrast!, this.characterOpts.faceContrast); gl.uniform1f(u.uFaceUnlit!, this.characterOpts.faceUnlit);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.tex); gl.uniform1i(u.uAtlas!, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlas.frameTex); gl.uniform1i(u.uFrames!, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.emisTex); gl.uniform1i(u.uEmis!, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.sheenTex); gl.uniform1i(u.uSheenM!, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.swayTex); gl.uniform1i(u.uSwayM!, 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.tintMaskTex); gl.uniform1i(u.uTintM!, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, atlas.tintTex); gl.uniform1i(u.uTints!, 6);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas.poolTex); if (u.uPoolTex) gl.uniform1i(u.uPoolTex, 7); if (u.uPoolFirst) gl.uniform1i(u.uPoolFirst, atlas.poolFirst);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Static (cached) build-piece chunks: opaque, depth-written, one draw per visible chunk. */
  drawStatic(view: Float32Array, depth: Float32Array, atlas: AtlasManager, time: number, now: number, rect: Rect, activeKeys: ReadonlySet<string> | undefined, style: StyleConfig, stats: FrameStats): void {
    if (!atlas.tex || this.statics.size === 0) { this.staticChunksDrawn = 0; return; }
    const gl = this.gl; const { u } = this.prog;
    this.setup("sprite", u, view, depth, atlas, time, 0, SpriteBatch.ZERO2, 0, style);
    const hw = this.iso.tileW / 2, hh = this.iso.tileH / 2, S = CHUNK_SIZE; let drawn = 0;
    for (const [ck, sc] of this.statics) {
      if (activeKeys && !activeKeys.has(ck)) continue;
      const vr = viewRect(sc.cx * S, sc.cy * S, S, S, this.iso.view ?? 0); const x0 = vr.x, y0 = vr.y; // ADR-253
      const sxMin = (x0 - (y0 + S)) * hw - 128, sxMax = (x0 + S - y0) * hw + 128;
      const syMin = (x0 + y0) * hh - 1024, syMax = (x0 + y0 + 2 * S) * hh + 64;
      if (sxMax < rect.x0 || sxMin > rect.x1 || syMax < rect.y0 || syMin > rect.y1) continue;
      gl.uniform1f(u.uAlphaMul!, this.chunkFadeIn > 0 ? Math.min(1, (now - sc.born) / this.chunkFadeIn) : 1);
      gl.bindVertexArray(sc.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sc.count);
      stats.drawCalls++; drawn++;
    }
    gl.bindVertexArray(null);
    gl.uniform1f(u.uAlphaMul!, 1);
    this.staticChunksDrawn = drawn;
  }

  draw(pass: "shadow" | "sprite", view: Float32Array, depth: Float32Array, atlas: AtlasManager, time: number, wind: number,
    shadowDir: readonly [number, number], shadowAlpha: number, style: StyleConfig, stats: FrameStats): void {
    if ((this.visible === 0 && this.intCount === 0) || !atlas.tex) return;
    if (pass === "shadow" && (shadowAlpha <= 0 || style.shadowMode === "none")) return;
    const gl = this.gl; const { u } = this.prog;
    this.setup(pass, u, view, depth, atlas, time, wind, shadowDir, shadowAlpha, style);
    if (this.visible > 0) {
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.visible);
      stats.drawCalls++;
    }
    if (this.intCount > 0 && this.intVao) {
      // interior pass in painter's order (floor, occupants, cutaway walls): no depth test so the floor is never clipped
      const dt = gl.isEnabled(gl.DEPTH_TEST); if (pass === "sprite") gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.intVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.intCount);
      if (dt) gl.enable(gl.DEPTH_TEST); stats.drawCalls++;
    }
    gl.bindVertexArray(null);
    if (pass === "sprite") stats.sprites = this.visible + this.intCount + this.staticInstances;
  }

  /** Faded occluders (late batch): depth-tested, no depth write. Call after drawSilhouette. */
  drawLate(view: Float32Array, depth: Float32Array, atlas: AtlasManager, time: number, wind: number, style: StyleConfig, stats: FrameStats): void {
    if (this.lateCount === 0 || !atlas.tex || !this.lateVao) return;
    const gl = this.gl; const { u } = this.prog;
    this.setup("sprite", u, view, depth, atlas, time, wind, SpriteBatch.ZERO2, 0, style);
    gl.depthMask(false);
    gl.bindVertexArray(this.lateVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.lateCount); gl.bindVertexArray(null);
    gl.depthMask(true);
    stats.drawCalls++; stats.sprites += this.lateCount;
  }

  /** Focus (local player) silhouette through occluders: one instance, depth GREATER, no depth write. Call after draw("sprite"). */
  drawSilhouette(view: Float32Array, depth: Float32Array, atlas: AtlasManager, time: number, wind: number, style: StyleConfig, stats: FrameStats): void {
    if (!this.silOn || !style.occlusion.enabled || !style.occlusion.silhouette || !atlas.tex) return;
    const gl = this.gl; const { u } = this.prog;
    if (!this.silVbo) { this.silVbo = gl.createBuffer()!; this.silVao = this.makeVao(this.silVbo); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.silVbo); gl.bufferData(gl.ARRAY_BUFFER, this.silInst, gl.DYNAMIC_DRAW);
    this.setup("sprite", u, view, depth, atlas, time, wind, SpriteBatch.ZERO2, 0, style);
    gl.uniform1i(u.uSilhouette!, 1); gl.uniform1f(u.uOutline!, 0);
    gl.depthFunc(gl.GREATER); gl.depthMask(false);
    gl.bindVertexArray(this.silVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1); gl.bindVertexArray(null);
    gl.depthMask(true); gl.depthFunc(gl.LESS); gl.uniform1i(u.uSilhouette!, 0);
    stats.drawCalls++;
  }
}

/**
 * Deck layer (floors, foundations; gameplay building/structure.ts LAYER_DECK, world BuildingGrid layer 0). Roofs share
 * that layer but are not flat, so they are told apart by sprite (AtlasManager.isRoof), never by a layer number.
 * TODO(world): import a named layer enum once @engine/world exports one.
 */
export let PIECE_LAYER_DECK = 0;
/** Override the deck layer index (inject gameplay's LAYER_DECK). */
export function setPieceLayers(l: { deck: number }): void { PIECE_LAYER_DECK = l.deck; }
const flatLayer = (layer: number, roof: boolean): boolean => layer === PIECE_LAYER_DECK && !roof;

/** Chunk keys whose tiles may project into the iso rect (tile box from inverted rect corners). ADR-253: the box is in
 *  view space (quarter `view`); each view-space chunk cell maps back to its world chunk (chunk squares stay aligned). */
export function visibleChunkKeys(rect: Rect, hw: number, hh: number, zs: number, maxZ: number, view = 0): string[] {
  const a0 = rect.x0 / hw, a1 = rect.x1 / hw; // u - v
  const b0 = rect.y0 / hh, b1 = (rect.y1 + maxZ * zs) / hh; // u + v
  const xMin = Math.floor((a0 + b0) / 2) - 2, xMax = Math.ceil((a1 + b1) / 2) + 2;
  const yMin = Math.floor((b0 - a1) / 2) - 2, yMax = Math.ceil((b1 - a0) / 2) + 2;
  const out: string[] = []; const q = view & 3;
  for (let cy = Math.floor(yMin / CHUNK_SIZE); cy <= Math.floor(yMax / CHUNK_SIZE); cy++)
    for (let cx = Math.floor(xMin / CHUNK_SIZE); cx <= Math.floor(xMax / CHUNK_SIZE); cx++) {
      // reject chunks whose diamond misses the rect horizontally/vertically
      const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, S = CHUNK_SIZE;
      if ((x0 + S - y0) * hw < rect.x0 - hw || (x0 - y0 - S) * hw > rect.x1 + hw) continue;
      if ((x0 + y0 + 2 * S) * hh < rect.y0 || (x0 + y0) * hh - maxZ * zs > rect.y1 + hh) continue;
      // view chunk cell (cx, cy) -> world chunk (inverse of viewRect on a chunk square)
      out.push(q === 0 ? chunkKey(cx, cy) : q === 1 ? chunkKey(cy, -cx - 1) : q === 2 ? chunkKey(-cx - 1, -cy - 1) : chunkKey(-cy - 1, cx));
    }
  return out;
}

/** Set of packed tile keys ("x,y") forming the building the focus stands in, or null when not in a roofed building. */
export function cutawayRegion(grid: BuildingGrid, tx: number, ty: number, level: number, maxTiles = 600, isRoofSprite: (spriteId: number) => boolean = () => false): Set<string> | null {
  // anything on a higher level (roofs included: deck pieces of level+1) covers the tile; isRoofSprite is kept for
  // roof pieces gameplay places on the walls' own level. ADR-309: a floor under a missing ceiling still counts if
  // this connected footprint has cover somewhere (so indoor zoom does not pop in roof holes).
  const roofAt = (x: number, y: number): boolean => {
    const id = grid.at(x, y, level, PIECE_LAYER_DECK); if (!id) return false;
    const inst = grid.get(id); if (!inst) return false; const sp = grid.pieces.get(inst.piece).sprite;
    return (sp !== undefined && isRoofSprite(sp)) || grid.pieces.get(inst.piece).key.startsWith("roof");
  };
  const covered = (x: number, y: number): boolean => {
    for (let lv = level + 1; lv < 16; lv++) if (grid.at(x, y, lv) !== 0) return true;
    return roofAt(x, y);
  };
  const inside = (x: number, y: number): boolean => covered(x, y) || grid.at(x, y, level, PIECE_LAYER_DECK) !== 0;
  if (!inside(tx, ty)) return null;
  const seen = new Set<string>(); const q: [number, number][] = [[tx, ty]]; seen.add(`${tx},${ty}`);
  let anyCover = covered(tx, ty);
  while (q.length && seen.size < maxTiles) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && inside(nx, ny)) { seen.add(k); q.push([nx, ny]); if (covered(nx, ny)) anyCover = true; }
    }
  }
  return anyCover ? seen : null;
}

function footprintHits(region: Set<string>, ax: number, ay: number, fw: number, fh: number): boolean {
  for (let y = ay - 1; y <= ay + fh; y++) for (let x = ax - 1; x <= ax + fw; x++) if (region.has(`${x},${y}`)) return true;
  return false;
}

/**
 * Incremental sort for frame-coherent keys: insertion sort that gives up after `budget` element moves (returns false; the
 * caller falls back to a full sort). Last frame's order is mostly preserved (gather order is stable and depth keys move
 * slowly), so this is ~O(n) in the steady state instead of O(n log n).
 */
export function insertionSortBudget(a: Uint32Array, budget: number): boolean {
  let moves = 0;
  for (let i = 1; i < a.length; i++) {
    const v = a[i]!; let j = i - 1;
    if (a[j]! <= v) continue;
    while (j >= 0 && a[j]! > v) { a[j + 1] = a[j]!; j--; if (++moves > budget) { a[j + 1] = v; return false; } }
    a[j + 1] = v;
  }
  return true;
}
