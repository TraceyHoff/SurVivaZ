// ADR-417: Canvas2D indoor cutaway + Occluder fading (console browser).
//
// Root cause: the Xbox Edge browser lands on Canvas2DRenderer whenever WebGL2 cannot be created
// (chooseRenderer: "Xbox Edge after GPU reset"), and that renderer never ran the indoor occlusion pass at
// all — no cutaway region, no Occluder fade, and `focus` was literally `void`ed in render(). So every ceiling,
// roof, upper floor and front wall drew opaque over the player indoors, while WebGL2 (SpriteBatch.prepare)
// hides other-level pieces in the cutaway region, fades same-level roofs / front walls to the cutaway alpha,
// and fades tall sprites in front of the player toward their Occluder.fade.
//
// These tests drive the Canvas2D path the way the console browser sees it (chooseRenderer -> canvas2d) and pin
// the WebGL2 behaviour: one-frame cover lag, other-level pieces hidden, same-level roofs faded to 0.10, front
// walls faded toward 0.35, tall sprites in front of the player faded (explicit Occluder.fade wins over the
// style alpha), nothing faded with no focus / outdoors / behind the player.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, PrevTransform, defineComponent } from "@engine/core";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { Canvas2DRenderer } from "../src/canvas2d.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { Sprite, Occluder } from "../src/components.js";

const ROOT = join(__dirname, "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as T;
const base = json<ManifestJson>("packages/assets/pack/manifest.json");
const bld = json<ManifestJson>("packages/assets/pack/building/manifest.building.json");
const { registry: reg } = loadManifest(mergeManifests([{ name: "base", manifest: base }, { name: "building", manifest: bld }]).manifest);
const WALL = reg.id("bld_wall_t1"), ROOF = reg.id("bld_roof_flat_t1"), FLOOR = reg.id("bld_floor_t1"), TREE = reg.id("tree");

/** View-side build piece (mirrors apps/client/src/view.ts VPiece). */
const VP = defineComponent("ViewBuildPieceT417", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });

type C2D = Canvas2DRenderer & {
  bindGameplay(b: unknown): void;
  image(k: string): unknown;
  gatherPieces(w: unknown, reg: unknown, t: number): { e: number; alpha: number }[];
};

function makeRenderer(): C2D {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const r = new Canvas2DRenderer(canvas, {} as unknown as CanvasRenderingContext2D) as unknown as C2D;
  r.image = () => ({} as unknown as HTMLImageElement);
  return r;
}

/** A 3x3 room (tiles 0..2): floors level 0, walls level 0, roofs level 1, player at the centre. */
function roomWorld() {
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Occluder); w.register(VP);
  const addPiece = (x: number, y: number, visualId: number, level: number, layer: number): number => {
    const e = w.create();
    w.add(e, Transform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    w.add(e, PrevTransform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    w.add(e, VP, { visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level, layer, ghost: 0 });
    return e;
  };
  const byEntity = new Map<number, string>();
  const track = (e: number, name: string): number => { byEntity.set(e, name); return e; };
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) track(addPiece(x, y, FLOOR, 0, 0), `floor${x},${y}`);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) track(addPiece(x, y, ROOF, 1, 0), `roof${x},${y}`);
  for (let x = 0; x < 3; x++) { track(addPiece(x, 0, WALL, 0, 1), `wallN${x}`); track(addPiece(x, 2, WALL, 0, 1), `wallS${x}`); }
  track(addPiece(0, 1, WALL, 0, 1), "wallW1"); track(addPiece(2, 1, WALL, 0, 1), "wallE1");
  track(addPiece(1, 1, ROOF, 0, 0), "roofL0"); // same-level roof: fades, is not hidden (WebGL: roof on the walls' own level)
  track(addPiece(10, 10, ROOF, 1, 0), "roofFar"); // outside the room: never in the region
  const player = w.create();
  w.add(player, Transform, { x: 1.5, y: 1.5, z: 0, facing: 0 });
  w.add(player, PrevTransform, { x: 1.5, y: 1.5, z: 0, facing: 0 });
  w.add(player, Sprite, { spriteId: TREE, frameId: 0, flags: 0, scale: 1, tint: 0 });
  return { w, byEntity, player };
}

const alphaOf = (pieces: { e: number; alpha: number }[], byEntity: Map<number, string>, name: string): number | undefined =>
  pieces.find((p) => byEntity.get(p.e) === name)?.alpha;

describe("ADR-417 Canvas2D indoor cutaway (gatherPieces)", () => {
  it("frame 1: no cutaway yet (one-frame cover lag, as WebGL2); frame 2: level-1 roofs over the player are hidden, the same-level roof fades to the cutaway alpha, the far roof and floors stay opaque", () => {
    const { w, byEntity, player } = roomWorld();
    const r = makeRenderer();
    r.bindGameplay({ buildPiece: VP });
    r.setFocusEntity(player);
    const f1 = r.gatherPieces(w, reg, 0);
    expect(r.indoor).toBe(false);
    // frame 1 has no cut yet (cover lag) so the roof is NOT hidden — but it still fades to the style alpha
    // through the piece-occlusion path, exactly as WebGL2 fades it before the first cutaway region exists
    expect(alphaOf(f1, byEntity, "roof1,1")).toBeCloseTo(DEFAULT_STYLE.occlusion.alpha, 5);
    expect(alphaOf(f1, byEntity, "roofL0")).toBeCloseTo(DEFAULT_STYLE.occlusion.alpha, 5);
    const f2 = r.gatherPieces(w, reg, 1);
    expect(r.indoor).toBe(true);
    expect(alphaOf(f2, byEntity, "roof1,1")).toBeUndefined(); // hidden outright (WebGL pieceHiddenByStory)
    expect(alphaOf(f2, byEntity, "roof0,0")).toBeUndefined();
    expect(alphaOf(f2, byEntity, "roof2,2")).toBeUndefined();
    expect(alphaOf(f2, byEntity, "roofL0")).toBeCloseTo(DEFAULT_STYLE.cutawayAlpha, 5);
    expect(alphaOf(f2, byEntity, "roofFar")).toBe(1);
    expect(alphaOf(f2, byEntity, "floor1,1")).toBe(1);
  });

  it("front walls at q=0 fade toward the style alpha (piece occlusion); walls behind the player stay opaque", () => {
    const { w, byEntity, player } = roomWorld();
    const r = makeRenderer();
    r.bindGameplay({ buildPiece: VP });
    r.setFocusEntity(player);
    r.gatherPieces(w, reg, 0);
    const f2 = r.gatherPieces(w, reg, 1);
    expect(alphaOf(f2, byEntity, "wallS2")).toBeCloseTo(DEFAULT_STYLE.occlusion.alpha, 5); // south wall, in front of the player
    expect(alphaOf(f2, byEntity, "wallS0")).toBeCloseTo(DEFAULT_STYLE.occlusion.alpha, 5);
    expect(alphaOf(f2, byEntity, "wallE1")).toBeCloseTo(DEFAULT_STYLE.occlusion.alpha, 5);
    expect(alphaOf(f2, byEntity, "wallN0")).toBe(1); // north wall, behind the player
    expect(alphaOf(f2, byEntity, "wallW1")).toBe(1);
  });

  it("at q=2 the enclosure wall now in front cuts away to the cutaway alpha; the wall behind stays opaque", () => {
    const { w, byEntity, player } = roomWorld();
    const r = makeRenderer();
    r.bindGameplay({ buildPiece: VP });
    r.setFocusEntity(player);
    r.setViewRotation(2);
    r.gatherPieces(w, reg, 0);
    const f2 = r.gatherPieces(w, reg, 1);
    expect(r.indoor).toBe(true);
    expect(alphaOf(f2, byEntity, "wallN0")).toBeCloseTo(DEFAULT_STYLE.cutawayAlpha, 5);
    expect(alphaOf(f2, byEntity, "wallS2")).toBe(1);
  });

  it("player walks outside: the cutaway clears and the roofs come back opaque; no focus: nothing fades", () => {
    const { w, byEntity, player } = roomWorld();
    const r = makeRenderer();
    r.bindGameplay({ buildPiece: VP });
    r.setFocusEntity(player);
    r.gatherPieces(w, reg, 0); r.gatherPieces(w, reg, 1);
    expect(r.indoor).toBe(true);
    w.set(player, Transform, { x: 20.5, y: 20.5, z: 0, facing: 0 });
    w.set(player, PrevTransform, { x: 20.5, y: 20.5, z: 0, facing: 0 });
    const out = r.gatherPieces(w, reg, 2);
    expect(r.indoor).toBe(false);
    expect(alphaOf(out, byEntity, "roof1,1")).toBe(1);
    expect(alphaOf(out, byEntity, "roofL0")).toBe(1);
    expect(alphaOf(out, byEntity, "wallS2")).toBe(1);
    r.setFocusEntity(-1);
    const noFocus = r.gatherPieces(w, reg, 3);
    expect(r.indoor).toBe(false);
    expect(alphaOf(noFocus, byEntity, "roofL0")).toBe(1);
  });
});

/** Proxy ctx: every method is a no-op except drawImage, which records the globalAlpha it drew with plus the last translate (screen position) and the dest size. save()/restore() keep a real globalAlpha stack (the draw code sets alpha under save/restore, so a leak here would smear one draw's alpha onto the next). */
function stubCtx(log: { alpha: number; tx: number; ty: number; dw: number; dh: number }[]): CanvasRenderingContext2D {
  const target: Record<string, unknown> = { globalAlpha: 1, canvas: {} };
  const stack: number[] = [];
  let tx = 0, ty = 0;
  const universal = (..._a: unknown[]): unknown => proxy;
  const proxy = new Proxy(target, {
    get(t, p) {
      if (p === "save") return () => { stack.push(t.globalAlpha as number); };
      if (p === "restore") return () => { const v = stack.pop(); if (v !== undefined) t.globalAlpha = v; };
      if (p === "translate") return (x: number, y: number) => { tx = x; ty = y; };
      if (p === "drawImage") return (...a: unknown[]) => { log.push({ alpha: t.globalAlpha as number, tx, ty, dw: a[7] as number, dh: a[8] as number }); };
      if (p in t) return t[p as string];
      return universal;
    },
    set(t, p, v) { t[p as string] = v; return true; },
  });
  return proxy as unknown as CanvasRenderingContext2D;
}

/** Drive the render clock deterministically: clockAt=-1 pins the clock at the value we set. */
function setClock(r: Canvas2DRenderer, t: number): void {
  const c = r as unknown as { clock: number; clockAt: number };
  c.clock = t; c.clockAt = -1;
}

function spriteWorld() {
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Occluder);
  const addTree = (x: number, y: number, occluder?: number): number => {
    const e = w.create();
    w.add(e, Transform, { x, y, z: 0, facing: 0 });
    w.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
    w.add(e, Sprite, { spriteId: TREE, frameId: 0, flags: 0, scale: 1, tint: 0 });
    if (occluder !== undefined) w.add(e, Occluder, { fade: occluder });
    return e;
  };
  const player = addTree(10.5, 10.5);
  const back = addTree(9.5, 9.5); // behind the player: never fades
  const auto = addTree(11.5, 10.5); // in front, no Occluder: auto-occludes toward the style alpha
  const explicit = addTree(11.5, 11.5, 0.5); // in front, explicit Occluder{fade: 0.5}: fades to 0.5, not 0.35
  return { w, player, back, auto, explicit };
}

describe("ADR-417 Canvas2D sprite occlusion (render)", () => {
  it("tall sprites in front of the player fade (auto -> style alpha, explicit Occluder -> its fade); the player and sprites behind stay opaque", async () => {
    const { w, player } = spriteWorld();
    const log: { alpha: number; tx: number; ty: number; dw: number; dh: number }[] = [];
    const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, stubCtx(log)) as unknown as C2D;
    r.image = () => ({} as unknown as HTMLImageElement);
    await r.atlas.setRegistry(reg, new Map());
    r.resize(320, 240, 1);
    r.setFocusEntity(player);
    setClock(r, 0); r.render(w, 1);
    log.length = 0;
    setClock(r, 1); r.render(w, 1);
    // draw order is the depth sort: back tree, player, auto tree, explicit tree (all 96x128 frames)
    const trees = log.filter((d) => d.dw === 96 && d.dh === 128);
    expect(trees.length).toBe(4);
    expect(trees.map((d) => d.alpha)).toEqual([1, 1, DEFAULT_STYLE.occlusion.alpha, 0.5]);
  });
});

describe("ADR-417 Canvas2D hideOtherStory (render)", () => {
  it("a sprite on another level inside the cutaway region is not drawn; the player and a sprite outside the room are", async () => {
    const { w, player } = roomWorld();
    const addTree = (x: number, y: number, z: number): number => {
      const e = w.create();
      w.add(e, Transform, { x, y, z, facing: 0 });
      w.add(e, PrevTransform, { x, y, z, facing: 0 });
      w.add(e, Sprite, { spriteId: TREE, frameId: 0, flags: 0, scale: 1, tint: 0 });
      return e;
    };
    addTree(1.5, 1.5, 3); // same tile as the player, one floor up: hidden when the player is indoors below
    addTree(20.5, 20.5, 0); // outside the room: drawn
    const log: { alpha: number; tx: number; ty: number; dw: number; dh: number }[] = [];
    const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, stubCtx(log)) as unknown as C2D;
    r.image = () => ({} as unknown as HTMLImageElement);
    await r.atlas.setRegistry(reg, new Map());
    r.bindGameplay({ buildPiece: VP });
    r.resize(320, 240, 1);
    r.setFocusEntity(player);
    setClock(r, 0); r.render(w, 1);
    log.length = 0;
    setClock(r, 1); r.render(w, 1);
    expect(r.indoor).toBe(true);
    const trees = log.filter((d) => d.dw === 96 && d.dh === 128);
    expect(trees.length).toBe(2); // player + outside tree; the upstairs tree is hidden
    expect(trees.map((d) => d.alpha)).toEqual([1, 1]);
  });
});
