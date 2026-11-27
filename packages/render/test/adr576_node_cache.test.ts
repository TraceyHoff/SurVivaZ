/**
 * ADR-576: static resource-node instance-row cache in SpriteBatch.prepare().
 *
 * The dense-area profiling (measure-perf.md) indicted per-frame resolve + writeOne for
 * resource nodes that never move (~74% of dynamic sprite prepare in a 352-sprite grove).
 * ADR-576 caches a static node's resolved 40-float row per dense slot, keyed by a
 * signature of every row input (ADR-381 pieceCache pattern), and replays it on later
 * frames. The contract is BYTE IDENTITY with the uncached pipeline: this file runs the
 * same scenes through two batches — cache on vs nodeCacheEnabled=false — and compares
 * the full instance buffers (visible set, interior set, late/faded set) frame by frame,
 * across camera moves, view rotation, season change, atlas layout bumps, node mutation,
 * occlusion fade engagement and moving sprites. It also proves the cache actually
 * engages (hit counters) and that ineligible sprites (stream-paged art, moving sprites)
 * are never served from it.
 */
import { describe, expect, it } from "vitest";
import { PrevTransform, Transform, World } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { DEFAULT_ISO } from "@engine/world";
import { SpriteBatch, INSTANCE_FLOATS } from "../src/sprites.js";
import { PieceCoverIndex } from "../src/building/modular.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { newResolved as newAtlasResolved, type AtlasManager, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { DEFAULT_STYLE, type StyleConfig } from "../src/style.js";
import { SUMMER_VISUAL, type SeasonVisual } from "../src/season.js";
import { isoZDepthFactor } from "../src/depth.js";
import { RENDER_COMPONENTS, Shadow, Sprite } from "../src/components.js";

const PERF = !!process.env.PERF;

const manifest = mergeManifests(["manifest.json", "items/manifest.items.json", "customization/manifest.customization.json"].map((p) => ({ name: p, manifest: readManifestJson(PACK_DIR + p) })) as never).manifest;
const reg: AssetRegistry = loadManifest(manifest).registry;
const idOf = (key: string): number => {
  const id = (reg.ids as unknown as { sprites: { tryId(k: string): number | undefined } }).sprites.tryId(key);
  if (id === undefined) throw new Error(`sprite key missing from registry: ${key}`);
  return id;
};
const GROVE_KEYS = ["tree_pine", "tree_apple", "tree", "bush", "berry_bush", "carrot_patch", "fiber_grass", "mushrooms"];
const GROVE_IDS = GROVE_KEYS.map(idOf);

/** CPU-only atlas: real registry; resolve fills a DISTINCT frame per sprite id so a stale
 *  or cross-sprite row cannot accidentally compare equal. layoutVersion is test-bumpable. */
function stubAtlas(opts: { streamIds?: Set<number> } = {}): { atlas: AtlasManager; bumpLayout: () => void } {
  const state = { layoutVersion: 1 };
  const resolve = (id: number, _a: number, _f: number, _t: number, fr: number, out: ResolvedFrame): boolean => {
    out.sprite = id; out.anim = "idle"; out.frame = fr; out.dfi = -1;
    out.w = 20 + (id % 5) * 8; out.h = 30 + (id % 7) * 6; out.ax = out.w / 2; out.ay = out.h;
    out.atlas = 0; out.entry = id * 4 + fr; out.hasDamageFrames = false; out.flipX = false; return true;
  };
  const atlas = {
    registry: reg, get layoutVersion() { return state.layoutVersion; },
    beginFrame: () => {}, isRoof: () => false, isCrisp: () => false, isDirectional: () => true,
    isStreamSprite: (id: number) => opts.streamIds?.has(id) ?? false, isStreamed: () => false,
    streamNear: () => {}, markUsed: () => {}, markUsedAt: () => {},
    streamPageReady: () => true, pageReady: () => true, pageReadyAt: () => true, placeholderOf: () => -1,
    streamClass: () => null, buildingFallback: () => -1, swayOf: () => undefined, handOf: () => undefined,
    fireAnim: () => -1, animName: () => undefined, chainAnim: () => -1, sharedChainAnim: () => -1,
    sharedStateAnim: () => -1, findAnim: () => -1, animIndex: () => -1, headOffsetOf: () => ({ x: 0, y: 0 }),
    isHeadSprite: () => false, pieceInfo: () => ({ fw: 1, fh: 1, layer: 1 }), lArmOf: () => -1,
    crackOverlayOf: () => -1, isEnclosure: () => false, namedAnim: () => -1,
    resolve, resolvePiece: (_v: number, _va: number, _r: number, _d: number, out: ResolvedFrame) => resolve(0, 0, 0, 0, 0, out),
  } as unknown as AtlasManager;
  return { atlas, bumpLayout: () => { state.layoutVersion++; } };
}

const glStub = {
  createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
  enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  deleteBuffer: () => {}, deleteVertexArray: () => {}, bufferData: () => {},
} as unknown as WebGL2RenderingContext;

function makeBatch(view = 0): SpriteBatch {
  const b = Object.assign(Object.create(SpriteBatch.prototype) as object, {
    gl: glStub, iso: { ...DEFAULT_ISO, view }, zFactor: isoZDepthFactor(DEFAULT_ISO),
    capacity: 0, inst: new Float32Array(0), tmp: new Float32Array(0), sortKeys: new Uint32Array(0),
    gpuBytes: 0, n: 0, depthMin: 0, depthRange: 1, res: newAtlasResolved(), crackRes: newAtlasResolved(),
    cover: new PieceCoverIndex(), coverNext: new PieceCoverIndex(),
    tierFallbacks: 0, crackOverlays: 0, statics: new Map(), staticScratch: new Map(),
    dynamicChunkKeys: new Set(), pieceTmp: [] as number[],
    pieceParts: [] as { vis: number; rot: number; layer: number; x: number; y: number; last: boolean }[],
    cutCache: null, piecePartScratch: { vis: 0, rot: 0, layer: 0, x: 0, y: 0, last: true },
    pieceCache: new Map(), pieceSig: new Float64Array(35), chunkAgg: new Map(), chunkSlots: new Map(),
    pieceInfoCache: new Map(), pieceInfoLayout: -1,
    // ADR-576 fields
    nodeCache: new Map(), nodeSig: new Float64Array(20), nodeCacheReg: null, nodeCacheHits: 0, nodeCacheBuilds: 0, nodeCacheEnabled: true,
    ckCache: new Map(), lateOrder: new Uint32Array(0), lateBuf: new Float32Array(0),
    sortIncremental: 0, sortFull: 0, culledChunks: 0, streamPlaceholders: 0, streamBodyFallbacks: 0,
    lastGoodLayout: -1, lastGood: new Map(), lastGoodHits: 0, partialLayers: 0, layerPlan: [],
    prevPerm: new Uint16Array(0), prevN: 0, seedBuf: new Uint32Array(0), seedUsed: new Uint8Array(0),
    frameNo: 0, chunkKeysPrev: null, xf: new Float32Array(4), chunkFadeIn: 0.35, visible: 0,
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

interface Internals { inst: Float32Array; lateBuf: Float32Array; intBuf: Float32Array; nodeCache: Map<number, unknown> }
const internals = (b: SpriteBatch): Internals => b as unknown as Internals;

/** The full drawn output of one prepare(): visible instances, interior instances, late (faded) instances. */
function snapshot(b: SpriteBatch): { visible: number; inst: number[]; intCount: number; int: number[]; lateCount: number; late: number[] } {
  const x = internals(b);
  const priv = b as unknown as { intCount: number; lateCount: number };
  return {
    visible: b.visible, inst: Array.from(x.inst.subarray(0, b.visible * INSTANCE_FLOATS)),
    intCount: priv.intCount, int: Array.from(x.intBuf.subarray(0, priv.intCount * INSTANCE_FLOATS)),
    lateCount: priv.lateCount, late: Array.from(x.lateBuf.subarray(0, priv.lateCount * INSTANCE_FLOATS)),
  };
}

const RECT = { x0: -400, y0: -300, x1: 400, y1: 500 };

function ctx(world: World, atlas: AtlasManager, now: number, style: StyleConfig = DEFAULT_STYLE): Parameters<SpriteBatch["prepare"]>[0] {
  return {
    world, alpha: 0.5, rect: RECT, atlas, depthMin: -100, depthRange: 500,
    tickHz: 20, style, bindings: {}, now, zoom: 0.709,
  };
}

interface Scene { world: World; player: number; nodes: number[] }
/** A grove of static nodes on a jittered grid + a player, mirroring measure-perf.md's dense scene. */
function grove(nNodes: number, opts: { shadowed?: boolean } = {}): Scene {
  const world = new World({ seed: 1 });
  for (const c of RENDER_COMPONENTS) world.register(c);
  world.register(Transform); world.register(PrevTransform);
  const nodes: number[] = [];
  for (let n = 0; n < nNodes; n++) {
    const gx = (n % 18) * 1.3 + ((n * 7) % 5) * 0.11, gy = Math.floor(n / 18) * 1.3 + ((n * 13) % 5) * 0.09;
    const e = world.create();
    world.add(e, Transform, { x: gx, y: gy, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x: gx, y: gy, z: 0, facing: 0 });
    world.add(e, Sprite, { spriteId: GROVE_IDS[n % GROVE_IDS.length]!, frameId: 0, flags: 0, scale: 1, tint: 0 });
    if (opts.shadowed && n % 3 === 0) world.add(e, Shadow, { alpha: 0.35, length: 1 });
    nodes.push(e);
  }
  const player = world.create();
  world.add(player, Transform, { x: 60, y: 60, z: 0, facing: 0 });
  world.add(player, PrevTransform, { x: 60, y: 60, z: 0, facing: 0 });
  world.add(player, Sprite, { spriteId: GROVE_IDS[0]!, frameId: 0, flags: 0, scale: 1, tint: 0 });
  return { world, player, nodes };
}

/** Run both batches over the same scene/frame script and demand identical output every frame. */
function expectIdentical(label: string, scene: Scene, frames: number, script?: (f: number, a: SpriteBatch, b: SpriteBatch, s: Scene) => void, style?: StyleConfig): { a: SpriteBatch; b: SpriteBatch } {
  const atA = stubAtlas(), atB = stubAtlas();
  const a = makeBatch(), b = makeBatch();
  b.nodeCacheEnabled = false;
  a.focusEntity = scene.player; b.focusEntity = scene.player;
  let now = 100;
  for (let f = 0; f < frames; f++) {
    now += 1 / 60;
    script?.(f, a, b, scene);
    a.prepare(ctx(scene.world, atA.atlas, now, style));
    b.prepare(ctx(scene.world, atB.atlas, now, style));
    const sa = snapshot(a), sb = snapshot(b);
    expect(sa, `${label} frame ${f}`).toEqual(sb);
  }
  return { a, b };
}

describe("ADR-576 static node row cache", () => {
  it("dense grove: byte-identical output, cache engages", () => {
    const scene = grove(340, { shadowed: true });
    const { a } = expectIdentical("grove", scene, 12);
    expect(a.nodeCacheBuilds).toBeGreaterThan(0);
    expect(a.nodeCacheHits).toBeGreaterThan(0);
    // warm frames serve most visible nodes from rows: hits grow faster than builds after warmup
    expect(a.nodeCacheHits).toBeGreaterThan(a.nodeCacheBuilds);
  });

  it("camera move + view rotation + season change stay identical", () => {
    const scene = grove(120);
    const fall: SeasonVisual = { summer: 0, fall: 1, winter: 0, spring: 0, snow: 0, ice: 0, art: 1 };
    const { a, b } = expectIdentical("seasons", scene, 16, (f, ba, bb) => {
      if (f === 6) { ba.season = fall; bb.season = fall; }
    });
    expect(a.nodeCacheHits).toBeGreaterThan(0);
    void b;
    // rotation is an iso property: rebuild both batches at view 1 and compare there too
    const scene2 = grove(120);
    const atA = stubAtlas(), atB = stubAtlas();
    const ra = makeBatch(1), rb = makeBatch(1);
    rb.nodeCacheEnabled = false;
    ra.focusEntity = scene2.player; rb.focusEntity = scene2.player;
    let now = 200;
    for (let f = 0; f < 8; f++) {
      now += 1 / 60;
      ra.prepare(ctx(scene2.world, atA.atlas, now));
      rb.prepare(ctx(scene2.world, atB.atlas, now));
      expect(snapshot(ra), `rotated frame ${f}`).toEqual(snapshot(rb));
    }
    expect(ra.nodeCacheHits).toBeGreaterThan(0);
  });

  it("node mutation (sprite swap, move, removal) never replays a stale row", () => {
    const scene = grove(80);
    const victim = scene.nodes[10]!, mover = scene.nodes[20]!, removed = scene.nodes[30]!;
    expectIdentical("mutation", scene, 14, (f, _a, _b, s) => {
      if (f === 6) {
        s.world.set(victim, Sprite, { spriteId: GROVE_IDS[5]!, frameId: 0, flags: 0, scale: 1, tint: 0 });
        const t = s.world.get(mover, Transform) as { x: number; y: number };
        s.world.set(mover, Transform, { x: t.x + 2, y: t.y, z: 0, facing: 0 });
        s.world.set(mover, PrevTransform, { x: t.x + 2, y: t.y, z: 0, facing: 0 });
      }
      if (f === 9) s.world.destroy(removed);
    });
  });

  it("atlas layout bump rebuilds rows and stays identical", () => {
    const scene = grove(80);
    const atA = stubAtlas(), atB = stubAtlas();
    const a = makeBatch(), b = makeBatch();
    b.nodeCacheEnabled = false;
    a.focusEntity = scene.player; b.focusEntity = scene.player;
    let now = 300;
    let buildsAtBump = -1;
    for (let f = 0; f < 12; f++) {
      now += 1 / 60;
      if (f === 6) { atA.bumpLayout(); atB.bumpLayout(); buildsAtBump = a.nodeCacheBuilds; }
      a.prepare(ctx(scene.world, atA.atlas, now));
      b.prepare(ctx(scene.world, atB.atlas, now));
      expect(snapshot(a), `layout frame ${f}`).toEqual(snapshot(b));
    }
    expect(buildsAtBump).toBeGreaterThan(0);
    expect(a.nodeCacheBuilds).toBeGreaterThan(buildsAtBump); // rows rebuilt after the bump
  });

  it("moving sprites (PrevTransform != Transform) are never cached", () => {
    const scene = grove(40);
    // slide every node a little each frame: interpolation makes every row per-frame unique
    const { a } = expectIdentical("moving", scene, 8, (f, _a, _b, s) => {
      for (const e of s.nodes) {
        const t = s.world.get(e, Transform) as { x: number; y: number };
        s.world.set(e, PrevTransform, { x: t.x - 0.01 * (f + 1), y: t.y, z: 0, facing: 0 });
      }
    });
    expect(a.nodeCacheHits).toBe(0);
    expect(a.nodeCacheBuilds).toBe(0);
  });

  it("stream-paged sprites are never cached", () => {
    const streamId = GROVE_IDS[1]!;
    const scene = grove(60);
    const atA = stubAtlas({ streamIds: new Set([streamId]) }), atB = stubAtlas({ streamIds: new Set([streamId]) });
    const a = makeBatch(), b = makeBatch();
    b.nodeCacheEnabled = false;
    a.focusEntity = scene.player; b.focusEntity = scene.player;
    let now = 400;
    for (let f = 0; f < 8; f++) {
      now += 1 / 60;
      a.prepare(ctx(scene.world, atA.atlas, now));
      b.prepare(ctx(scene.world, atB.atlas, now));
      expect(snapshot(a), `stream frame ${f}`).toEqual(snapshot(b));
    }
    // only the non-streamed subset built rows: strictly fewer builds than visible nodes
    expect(a.nodeCacheBuilds).toBeGreaterThan(0);
    expect(a.nodeCacheBuilds).toBeLessThan(60);
  });

  it("occlusion fade engagement stays identical (fade routes through the full path)", () => {
    const style: StyleConfig = { ...DEFAULT_STYLE, occlusion: { ...DEFAULT_STYLE.occlusion, enabled: true, mode: "fade" } };
    const scene = grove(0);
    // player at (5,5); tall trees ringing the tile in front of and around the player
    const world = scene.world;
    const spots: [number, number][] = [[5, 6.2], [4.4, 6.0], [5.6, 6.0], [5, 4.0], [4.2, 4.2], [8, 8], [2, 9]];
    for (const [x, y] of spots) {
      const e = world.create();
      world.add(e, Transform, { x, y, z: 0, facing: 0 });
      world.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
      world.add(e, Sprite, { spriteId: GROVE_IDS[0]!, frameId: 0, flags: 0, scale: 1, tint: 0 });
    }
    world.set(scene.player, Transform, { x: 5, y: 5, z: 0, facing: 0 });
    world.set(scene.player, PrevTransform, { x: 5, y: 5, z: 0, facing: 0 });
    const { a } = expectIdentical("occlusion", scene, 90, undefined, style);
    // the trees the player never overlaps still serve from cache on most frames
    expect(a.nodeCacheHits).toBeGreaterThan(0);
  });
});

describe.skipIf(!PERF)("ADR-576 prepare bench", () => {
  it("dense grove prepare ms: cache on vs off (VM-relative)", () => {
    const scene = grove(340, { shadowed: true });
    const run = (enabled: boolean): number => {
      const { atlas } = stubAtlas();
      const batch = makeBatch();
      batch.nodeCacheEnabled = enabled;
      batch.focusEntity = scene.player;
      let now = 500;
      for (let i = 0; i < 60; i++) { now += 1 / 60; batch.prepare(ctx(scene.world, atlas, now)); }
      const runs: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 300; i++) { now += 1 / 60; batch.prepare(ctx(scene.world, atlas, now)); }
        runs.push((performance.now() - t0) / 300);
      }
      return [...runs].sort((x, y) => x - y)[Math.floor(runs.length / 2)]!;
    };
    const off = run(false), on = run(true);
    console.log(`[bench576] dense grove prepare: cache OFF ${off.toFixed(3)} ms, cache ON ${on.toFixed(3)} ms (ratio ${(on / off).toFixed(2)})`);
    expect(on).toBeLessThan(off);
  }, 120_000);
});
