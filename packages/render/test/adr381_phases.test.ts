/**
 * ADR-381 regression tests (run in normal CI — NOT PERF-gated):
 *  - PhaseTimer splits with synthetic timestamps (deterministic).
 *  - PieceCoverIndex.region returns packed numeric tile keys; its fingerprint
 *    changes on add and resets on clear (the cache-invalidation signal).
 *  - prepare() on an unchanged world: identical visible output, no extra static
 *    chunk rebuilds (the per-part static cache holds).
 *  - Moving one piece within its chunk triggers exactly one static rebuild.
 *  - The cutaway cache returns the same Set for a stationary player and
 *    recomputes when the player moves a tile or a piece moves (fingerprint).
 *
 * Headless (stub atlas + stub GL); small world, a handful of frames.
 */
import { describe, expect, it } from "vitest";
import { defineComponent, PrevTransform, Transform, World } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { DEFAULT_ISO } from "@engine/world";
import { SpriteBatch, INSTANCE_FLOATS, type PrepareContext } from "../src/sprites.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { PieceCoverIndex, tileKey } from "../src/building/modular.js";
import { newResolved as newAtlasResolved, type AtlasManager, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { SUMMER_VISUAL } from "../src/season.js";
import { isoZDepthFactor } from "../src/depth.js";
import { RENDER_COMPONENTS, Sprite } from "../src/components.js";
import { PhaseTimer, newPhaseMs } from "../src/gl/util.js";

/** View-side build piece (mirrors apps/client/src/view.ts VPiece). */
const VPiece = defineComponent("ViewBuildPiece", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });

const manifest = mergeManifests(["manifest.json", "items/manifest.items.json", "customization/manifest.customization.json"].map((p) => ({ name: p, manifest: readManifestJson(PACK_DIR + p) })) as never).manifest;
const reg: AssetRegistry = loadManifest(manifest).registry;
const allSprites = [...reg.allSprites()];
const pickId = (i: number): number => allSprites[i % allSprites.length]!.id;
const PROP_ID = pickId(3);
const WALL_ID = pickId(5);
const FLOOR_ID = pickId(7);
const ROOF_ID = pickId(11);

function stubAtlas(): AtlasManager {
  const fixed = (out: ResolvedFrame): boolean => {
    out.sprite = 0; out.anim = "idle"; out.frame = 0; out.dfi = -1; out.w = 32; out.h = 48; out.ax = 16; out.ay = 48;
    out.atlas = 0; out.entry = 0; out.hasDamageFrames = false; out.flipX = false; return true;
  };
  return {
    registry: reg, layoutVersion: 1,
    beginFrame: () => {}, isRoof: (id: number) => id === ROOF_ID, isCrisp: () => false, isDirectional: () => true,
    isStreamSprite: () => false, isStreamed: () => false, streamNear: () => {}, markUsed: () => {}, markUsedAt: () => {},
    streamPageReady: () => true, pageReady: () => true, pageReadyAt: () => true, placeholderOf: () => -1,
    streamClass: () => null, buildingFallback: () => -1, swayOf: () => undefined, handOf: () => undefined,
    fireAnim: () => -1, animName: () => undefined, chainAnim: () => -1, sharedChainAnim: () => -1,
    sharedStateAnim: () => -1, findAnim: () => -1, animIndex: () => -1, headOffsetOf: () => ({ x: 0, y: 0 }),
    isHeadSprite: () => false, pieceInfo: () => ({ fw: 1, fh: 1, layer: 1 }), lArmOf: () => -1,
    crackOverlayOf: () => -1, isEnclosure: () => false, namedAnim: () => -1,
    resolve: (_id: number, _a: number, _f: number, _t: number, _fr: number, out: ResolvedFrame) => fixed(out),
    resolvePiece: (_v: number, _va: number, _r: number, _d: number, out: ResolvedFrame, _s: number) => fixed(out),
  } as unknown as AtlasManager;
}

const glStub = {
  createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
  enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  deleteBuffer: () => {}, deleteVertexArray: () => {}, bufferData: () => {},
} as unknown as WebGL2RenderingContext;

function makeBatch(): SpriteBatch {
  const b = Object.assign(Object.create(SpriteBatch.prototype) as object, {
    gl: glStub, iso: { ...DEFAULT_ISO }, zFactor: isoZDepthFactor(DEFAULT_ISO),
    capacity: 0, inst: new Float32Array(0), tmp: new Float32Array(0), sortKeys: new Uint32Array(0),
    gpuBytes: 0, n: 0, depthMin: 0, depthRange: 1, res: newAtlasResolved(), crackRes: newAtlasResolved(),
    cover: new PieceCoverIndex(), coverNext: new PieceCoverIndex(),
    tierFallbacks: 0, crackOverlays: 0, statics: new Map(), staticScratch: new Map(),
    dynamicChunkKeys: new Set(), pieceTmp: [] as number[],
    pieceParts: [] as { vis: number; rot: number; layer: number; x: number; y: number; last: boolean }[],
    // ADR-381: class-field initializers never run on Object.create(Prototype) stubs — assign the new fields here.
    cutCache: null, piecePartScratch: { vis: 0, rot: 0, layer: 0, x: 0, y: 0, last: true },
    pieceCache: new Map(), pieceSig: new Float64Array(32), chunkAgg: new Map(), chunkSlots: new Map(),
    pieceInfoCache: new Map(), pieceInfoLayout: -1,
    ckCache: new Map(), lateOrder: new Uint32Array(0), lateBuf: new Float32Array(0),
    sortIncremental: 0, sortFull: 0, culledChunks: 0, streamPlaceholders: 0, streamBodyFallbacks: 0,
    lastGoodLayout: -1, lastGood: new Map(), lastGoodHits: 0, partialLayers: 0, layerPlan: [],
    prevPerm: new Uint16Array(0), prevN: 0, seedBuf: new Uint32Array(0), seedUsed: new Uint8Array(0),
    frameNo: 0, xf: new Float32Array(4), chunkFadeIn: 0.35, visible: 0,
    staticInstances: 0, staticChunksDrawn: 0, staticRebuilds: 0, streamFallbacks: 0,
    focusEntity: -1, season: SUMMER_VISUAL, seasonSnowCap: 0, seasonArt: null, seasonArtReg: null,
    occT: new Float32Array(1024), occLast: -1, silInst: new Float32Array(INSTANCE_FLOATS), silOn: false,
    focusScr: [0, 0] as [number, number],
    occ: { occAmount: () => 0, peek: () => 0, overlapsFocus: () => false, occOn: false, fk: 0 },
    layerCache: null,
    characterOpts: { outline: "union", minorLayerMinZoom: 0.75, outlineWidthPx: 0, outlineColor: [0, 0, 0, 0], faceMipBias: -0.75, faceContrast: 1.12, faceUnlit: 0.3 },
    characters: 0, layerInstances: 0,
    nearInfo: Array.from({ length: 8 }, () => ({ e: -1, d: 0, layers: 0, resident: 0, drawn: 0, scale: 1, missing: [] as string[] })),
    nearN: 0, maxDressed: Infinity, dressFaces: true, dressCapped: 0,
    dressD2: new Float32Array(64), dressN: 0, dressCut: Infinity, dressDrawn: 0,
    layerRes: newAtlasResolved(), cutawayActive: false, nightGate: 1,
    route: new Uint8Array(0), curRoute: 0, intBuf: new Float32Array(0), intCount: 0,
    intVbo: null, intVao: null, intKeys: [] as number[], intRoutes: [] as number[], intIdx: [] as number[],
    late: [] as number[], lateVbo: null, lateVao: null, lateCount: 0,
    windVec: new Float32Array([1, 0]), shadowColor: new Float32Array(3),
    one: new Float32Array(INSTANCE_FLOATS), layerBase: new Float32Array(INSTANCE_FLOATS),
    heldRes: newAtlasResolved(), heldStats: [0, 0, 0] as [number, number, number],
    offHandStats: [0, 0, 0, 0] as [number, number, number, number],
    decks: new DeckNeighbors(), deckTops: new Map(), interiorRegions: [], interiorFloorIds: new Set<number>(),
    interiorWallSprite: -1, interiorCut: false,
  }) as unknown as SpriteBatch;
  return b;
}

const RECT = { x0: -700, y0: -100, x1: 700, y1: 700 };
const DEPTH = { min: -100, range: 500 };

/** Small world: 10 sprites + a roofed 4x4 house (floors + perimeter walls + roof) at tiles 10..13. */
function buildWorld(): { world: World; player: number; floorPiece: number } {
  const world = new World({ seed: 1 });
  for (const c of RENDER_COMPONENTS) world.register(c);
  world.register(Transform); world.register(PrevTransform); world.register(VPiece);
  const addSprite = (x: number, y: number): number => {
    const e = world.create();
    world.add(e, Transform, { x, y, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
    world.add(e, Sprite, { spriteId: PROP_ID, frameId: 0, flags: 0, scale: 1, tint: 0 });
    return e;
  };
  for (let i = 0; i < 10; i++) addSprite(i + 0.5, i + 0.5);
  const player = addSprite(60, 60);
  const addPiece = (x: number, y: number, visualId: number, level: number, layer: number): number => {
    const e = world.create();
    world.add(e, Transform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, VPiece, { visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level, layer, ghost: 0 });
    return e;
  };
  let floorPiece = -1;
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) { const e = addPiece(x, y, FLOOR_ID, 0, 0); if (x === 10 && y === 10) floorPiece = e; }
  for (let x = 10; x < 14; x++) { addPiece(x, 10, WALL_ID, 0, 1); addPiece(x, 13, WALL_ID, 0, 1); }
  for (let y = 11; y < 13; y++) { addPiece(10, y, WALL_ID, 0, 1); addPiece(13, y, WALL_ID, 0, 1); }
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) addPiece(x, y, ROOF_ID, 1, 0);
  return { world, player, floorPiece };
}

function prepareCtx(world: World, atlas: AtlasManager, now: number): PrepareContext {
  return {
    world, alpha: 0.5, rect: RECT, atlas, depthMin: DEPTH.min, depthRange: DEPTH.range,
    tickHz: 20, style: DEFAULT_STYLE, bindings: { buildPiece: VPiece }, now, zoom: 1,
  };
}

const cutCacheOf = (b: SpriteBatch): { result: Set<number> | null } | null =>
  (b as unknown as { cutCache: { result: Set<number> | null } | null }).cutCache;

describe("ADR-381 PhaseTimer", () => {
  it("splits record ms between readings; zero() does not advance the clock", () => {
    const pt = new PhaseTimer();
    expect(newPhaseMs()).toEqual({ prep: 0, sprites: 0, upload: 0, lightsPrep: 0, scene: 0, light: 0, bloom: 0, composite: 0, weather: 0 });
    pt.start(1000);
    pt.split("prep", 1001.5);
    pt.zero("bloom"); // bloom off this frame: stays 0 and does not consume clock
    pt.split("sprites", 1003);
    pt.split("upload", 1003.25);
    expect(pt.ms.prep).toBeCloseTo(1.5);
    expect(pt.ms.sprites).toBeCloseTo(1.5);
    expect(pt.ms.upload).toBeCloseTo(0.25);
    expect(pt.ms.bloom).toBe(0);
    // second frame reuses the same record (no per-frame allocation)
    const ms = pt.ms;
    pt.start(2000); pt.split("prep", 2002);
    expect(pt.ms).toBe(ms);
    expect(pt.ms.prep).toBeCloseTo(2);
  });
});

describe("ADR-381 cutaway region keys + fingerprint", () => {
  it("region() returns packed numeric tile keys and the fingerprint tracks adds/clears", () => {
    const cover = new PieceCoverIndex();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { cover.add(x, y, 1, 1, 0, true, false); cover.add(x, y, 1, 1, 1, true, true); }
    const fp0 = cover.fingerprint;
    expect(fp0).not.toBe(0);
    const region = cover.region(1, 1, 0)!;
    expect(region).toBeInstanceOf(Set);
    expect(region.has(tileKey(1, 1))).toBe(true);
    expect(region.has(tileKey(3, 3))).toBe(true);
    expect(region.has(tileKey(20, 20))).toBe(false);
    expect(region.has("1,1" as unknown as number)).toBe(false); // no string keys anymore
    cover.add(20, 20, 1, 1, 0, true, false);
    expect(cover.fingerprint).not.toBe(fp0);
    cover.clear();
    expect(cover.fingerprint).toBe(0);
    expect(cover.size).toBe(0);
  });
});

describe("ADR-381 static piece cache", () => {
  it("an unchanged world produces identical visible output with no extra static rebuilds", () => {
    const { world, player } = buildWorld();
    const batch = makeBatch();
    const atlas = stubAtlas();
    batch.focusEntity = player;
    let now = 100;
    const step = (): void => { now += 1 / 60; batch.prepare(prepareCtx(world, atlas, now)); };
    step(); step(); // first build + one steady frame
    const rebuilds = batch.staticRebuilds;
    const visible = batch.visible;
    const instances = batch.staticInstances;
    expect(rebuilds).toBeGreaterThan(0);
    step(); step(); step();
    expect(batch.staticRebuilds).toBe(rebuilds);
    expect(batch.visible).toBe(visible);
    expect(batch.staticInstances).toBe(instances);
  });

  it("moving one piece inside its chunk triggers exactly one static rebuild", () => {
    const { world, player, floorPiece } = buildWorld();
    const batch = makeBatch();
    const atlas = stubAtlas();
    batch.focusEntity = player;
    let now = 100;
    const step = (): void => { now += 1 / 60; batch.prepare(prepareCtx(world, atlas, now)); };
    step(); step();
    const rebuilds = batch.staticRebuilds;
    // move the (10,10) floor to (14,10): same chunk, empty tile — only that part's signature changes.
    world.set(floorPiece, Transform, { x: 14.5, y: 10.5, z: 0, facing: 0 });
    world.set(floorPiece, PrevTransform, { x: 14.5, y: 10.5, z: 0, facing: 0 });
    step();
    expect(batch.staticRebuilds).toBe(rebuilds + 1);
    step();
    expect(batch.staticRebuilds).toBe(rebuilds + 1); // steady again
  });
});

describe("ADR-381 cutaway cache", () => {
  it("returns the same Set for a stationary player; recomputes when the player or a piece moves", () => {
    const { world, player, floorPiece } = buildWorld();
    const batch = makeBatch();
    const atlas = stubAtlas();
    batch.focusEntity = player;
    let now = 100;
    const step = (): void => { now += 1 / 60; batch.prepare(prepareCtx(world, atlas, now)); };
    const setPlayer = (x: number, y: number): void => {
      world.set(player, Transform, { x, y, z: 0, facing: 0 });
      world.set(player, PrevTransform, { x, y, z: 0, facing: 0 });
    };
    setPlayer(11.5, 11.5); // inside the roofed house
    step(); // first frame: the cover is still empty (gatherPieces fills it after the cut is computed)
    step();
    expect(batch.cutawayActive).toBe(true);
    const first = cutCacheOf(batch)?.result;
    expect(first).not.toBeNull();
    step(); step();
    expect(cutCacheOf(batch)?.result).toBe(first); // same Set object: no BFS re-run
    setPlayer(12.5, 11.5); // one tile over: cache key changes
    step();
    const second = cutCacheOf(batch)?.result;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    step();
    expect(cutCacheOf(batch)?.result).toBe(second);
    // Moving a piece changes the cover fingerprint: the cached region is stale and recomputes.
    // Two steps: the cut reads last frame's cover (pre-existing one-frame lag — gatherPieces
    // rebuilds the cover after the cut is computed), so the moved piece lands in the cover on
    // the first step and invalidates the cache on the second.
    world.set(floorPiece, Transform, { x: 14.5, y: 10.5, z: 0, facing: 0 });
    world.set(floorPiece, PrevTransform, { x: 14.5, y: 10.5, z: 0, facing: 0 });
    step(); step();
    expect(cutCacheOf(batch)?.result).not.toBe(second);
  });
});
