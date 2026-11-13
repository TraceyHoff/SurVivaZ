/**
 * ADR-381 bench: ms/frame of SpriteBatch.prepare() headless (no GL), plus the cutaway
 * region flood-fills. PERF=1 only (prints numbers; loose assertions).
 * `PERF=1 pnpm vitest run packages/render/test/adr381_prepare_bench.test.ts`
 *
 * Context: Tracey's Galaxy A16 reports frame cpu 15.7 ms at only 22 draws / 228
 * sprites — IsoRenderer.render() wall time, i.e. JS render-prep, not draw calls.
 * The client never calls setSpatialIndex, so prepare() iterates EVERY Sprite
 * entity every frame, and the gridless cutaway (PieceCoverIndex.region) BFS-runs
 * every frame while the player is indoors. This bench measures that loop with a
 * stub atlas (real AssetRegistry, CPU-only resolve) and a stub GL context, so
 * patched-vs-pristine deltas are comparable on this VM. Absolute ms are NOT
 * phone ms; the split and the deltas are the evidence. Note: the direct
 * cover.region / cutawayRegion numbers at the end of this file are VM-noise
 * dominated (batches scatter ±2x run to run on this shared 1.5-CPU box — a
 * standalone 5-batch run even flipped the pristine/patched order), so they are
 * NOT claimable; the prepare() scenario medians are the evidence.
 */
import { describe, expect, it } from "vitest";
import { defineComponent, PrevTransform, Transform, World } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { BuildingGrid, DEFAULT_ISO, loadBuildPieces } from "@engine/world";
import { SpriteBatch, cutawayRegion, INSTANCE_FLOATS, type PrepareContext } from "../src/sprites.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { PieceCoverIndex } from "../src/building/modular.js";
import { newResolved as newAtlasResolved, type AtlasManager, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { SUMMER_VISUAL } from "../src/season.js";
import { isoZDepthFactor } from "../src/depth.js";
import { RENDER_COMPONENTS, Sprite } from "../src/components.js";

const PERF = !!process.env.PERF;

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

/** CPU-only atlas: real registry, resolve fills a fixed frame (no page/texture work). */
function stubAtlas(resolveOk = true): AtlasManager {
  const fixed = (out: ResolvedFrame): boolean => {
    out.sprite = 0; out.anim = "idle"; out.frame = 0; out.dfi = -1; out.w = 32; out.h = 48; out.ax = 16; out.ay = 48;
    out.atlas = 0; out.entry = 0; out.hasDamageFrames = false; out.flipX = false; return resolveOk;
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
    dynamicChunkKeys: new Set(), pieceChecks: new Map(), pieceTmp: [] as number[],
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

function buildWorld(withSprites: number, withPieces: number): { world: World; player: number } {
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
  // 200 in view (0..20 tiles), the rest culled far away (300..400 tiles).
  for (let i = 0; i < withSprites; i++) {
    if (i < 200) addSprite((i % 20) + (i % 3) * 0.3, Math.floor(i / 20) + (i % 5) * 0.2);
    else addSprite(300 + (i % 50), 300 + Math.floor(i / 50));
  }
  const player = addSprite(60, 60);
  // Roofed house at tiles 10..17: floors (level 0, deck layer) + perimeter walls + roof (level 1).
  const addPiece = (x: number, y: number, visualId: number, level: number, layer: number): void => {
    const e = world.create();
    world.add(e, Transform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, VPiece, { visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level, layer, ghost: 0 });
  };
  let n = 0;
  for (let y = 10; y < 18 && n < withPieces; y++) for (let x = 10; x < 18 && n < withPieces; x++) { addPiece(x, y, FLOOR_ID, 0, 0); n++; }
  for (let x = 10; x < 18 && n < withPieces; x++) { addPiece(x, 10, WALL_ID, 0, 1); n++; addPiece(x, 17, WALL_ID, 0, 1); n++; }
  for (let y = 11; y < 17 && n < withPieces; y++) { addPiece(10, y, WALL_ID, 0, 1); n++; addPiece(17, y, WALL_ID, 0, 1); n++; }
  for (let y = 10; y < 18 && n < withPieces; y++) for (let x = 10; x < 18 && n < withPieces; x++) { addPiece(x, y, ROOF_ID, 1, 0); n++; }
  // Scattered pieces across 0..25 (a cluttered base), never covering (60,60).
  let i = 0;
  while (n < withPieces) { const x = (i * 7) % 26, y = (i * 11) % 26; addPiece(x, y, WALL_ID, 0, 1); n++; i++; }
  return { world, player };
}

function prepareCtx(world: World, atlas: AtlasManager, now: number): PrepareContext {
  return {
    world, alpha: 0.5, rect: RECT, atlas, depthMin: DEPTH.min, depthRange: DEPTH.range,
    tickHz: 20, style: DEFAULT_STYLE, bindings: { buildPiece: VPiece }, now, zoom: 1,
  };
}

const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

function benchPrepare(label: string, withSprites: number, withPieces: number, indoor: boolean, opts: { resolveFalse?: boolean; seasonPickStub?: boolean; noFocus?: boolean } = {}): number {
  const { world, player } = buildWorld(withSprites, withPieces);
  const batch = makeBatch();
  const atlas = stubAtlas(!opts.resolveFalse);
  if (opts.seasonPickStub) (batch as unknown as { seasonPick: (a: AtlasManager, sid: number) => { sid: number; flags: number } }).seasonPick = () => ({ sid: 0, flags: 0 });
  if (!opts.noFocus) batch.focusEntity = player;
  const setPlayer = (x: number, y: number): void => {
    world.set(player, Transform, { x, y, z: 0, facing: 0 });
    world.set(player, PrevTransform, { x, y, z: 0, facing: 0 });
  };
  setPlayer(indoor ? 13.5 : 60, indoor ? 13.5 : 60);
  let now = 100;
  const step = (): void => { now += 1 / 60; batch.prepare(prepareCtx(world, atlas, now)); };
  for (let i = 0; i < 100; i++) step(); // warm up: static chunks built, sort seeded, cover filled, JIT settled
  const runs: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) step();
    runs.push((performance.now() - t0) / 500);
  }
  const m = med(runs);
  console.log(`[bench381] ${label}: median ${m.toFixed(3)} ms/prepare (runs ${runs.map((x) => x.toFixed(3)).join(" ")}) visible=${batch.visible} sortFull=${batch.sortFull} sortIncr=${batch.sortIncremental} cutaway=${batch.cutawayActive}`);
  return m;
}

describe.skipIf(!PERF)("ADR-381 prepare bench", () => {
  it("sprites.prepare ms/frame by scene (headless, stub atlas+GL)", () => {
    const res: Record<string, number> = {};
    res.spritesOnly = benchPrepare("sprites-only 1200 sprites, 0 pieces, outdoor", 1200, 0, false);
    res.piecesOnly = benchPrepare("pieces-only 1 sprite, 800 pieces, outdoor", 0, 800, false);
    res.mixedOutdoor = benchPrepare("mixed 1200 sprites + 800 pieces, outdoor", 1200, 800, false);
    res.mixedIndoor = benchPrepare("mixed 1200 sprites + 800 pieces, INDOOR (cutaway active)", 1200, 800, true);
    // Ablations on the mixed-outdoor scene: what is the sprite loop actually paying for?
    res.ablateResolveFalse = benchPrepare("ablate: resolve() returns false (no writeOne/sort/copy)", 1200, 800, false, { resolveFalse: true });
    res.ablateSeasonPick = benchPrepare("ablate: seasonPick stubbed (no SeasonArt.resolve)", 1200, 800, false, { seasonPickStub: true });
    res.ablateNoFocus = benchPrepare("ablate: no focus entity (no cutaway/occ setup)", 1200, 800, false, { noFocus: true });
    // Direct flood-fill cost: 600-tile building, same tile every call.
    const cover = new PieceCoverIndex();
    for (let y = 0; y < 24; y++) for (let x = 0; x < 25; x++) { cover.add(x, y, 1, 1, 0, true, false); cover.add(x, y, 1, 1, 1, true, true); }
    const t0 = performance.now(); for (let i = 0; i < 2000; i++) cover.region(12, 12, 0); const coverMs = (performance.now() - t0) / 2000;
    console.log(`[bench381] cover.region 600-tile BFS: ${coverMs.toFixed(4)} ms/call`);
    const { registry } = loadBuildPieces([{ key: "floor", footprint: { w: 1, h: 1 }, layer: 0, hp: 1 }, { key: "roof", footprint: { w: 1, h: 1 }, layer: 3, hp: 1 }]);
    const g = new BuildingGrid(registry); const f = registry.byKey("floor").id, r = registry.byKey("roof").id;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 25; x++) { g.place(f, x, y, 0); g.place(r, x, y, 1); }
    const t1 = performance.now(); for (let i = 0; i < 2000; i++) cutawayRegion(g, 12, 12, 0); const cutMs = (performance.now() - t1) / 2000;
    console.log(`[bench381] cutawayRegion 600-tile BFS: ${cutMs.toFixed(4)} ms/call`);
    res.coverRegion = coverMs; res.cutawayRegion = cutMs;
    expect(res.mixedOutdoor!).toBeLessThan(50);
    expect(res.mixedIndoor!).toBeLessThan(50);
  }, 300_000);
});
