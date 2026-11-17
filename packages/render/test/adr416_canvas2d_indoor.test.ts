/**
 * ADR-416: the Canvas2D fallback renderer never reported the indoor signal.
 *
 * Root cause (traced, see docs/DECISIONS.md): on the console browser the game runs on
 * Canvas2DRenderer — chooseRenderer picks it whenever WebGL2 cannot be created (the repo's own
 * canvas2d.test.ts names "Xbox Edge after GPU reset"), and ADR-407 documents the 1 GB UWP app
 * cap behind the context losses. But Canvas2DRenderer had no `indoor` getter at all, so
 * main.ts's `camZoom?.setIndoor(iso.renderer.indoor, dt)` read `undefined` every frame and the
 * ADR-206 indoor zoom never engaged on that path — while the WebGL2 path (the phone) zooms from
 * `IsoRenderer.indoor` = `sprites.cutawayActive`.
 *
 * The fix computes the same indoor test the WebGL2 cutaway runs (sprites.prepare): the focus
 * stands in a roofed footprint — cover above its level, or a roof on its level — from the cover
 * index the previous frame's drawn pieces built. One frame of lag, like IsoRenderer.
 *
 * Headless (real manifest registry + stub 2D context); a 4x4 roofed ruin at tiles 10..13.
 */
import { describe, expect, it } from "vitest";
import { defineComponent, PrevTransform, Transform, World } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { Canvas2DRenderer } from "../src/canvas2d.js";
import { sourcesFromManifest } from "../src/assets/atlasManager.js";

/** View-side build piece (mirrors apps/client/src/view.ts VPiece). */
const VPiece = defineComponent("ViewBuildPiece", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });

const manifest = mergeManifests(["manifest.json", "items/manifest.items.json", "customization/manifest.customization.json"].map((p) => ({ name: p, manifest: readManifestJson(PACK_DIR + p) })) as never).manifest;
const reg: AssetRegistry = loadManifest(manifest).registry;
const FOUNDATION_ID = reg.spriteForPiece("foundation")!;
const ROOF_ID = reg.spriteForPiece("roof_flat")!;
const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

/** A 2D context that absorbs every call (headless: no DOM canvas). */
function stubCtx(): CanvasRenderingContext2D {
  const fn = (..._args: unknown[]): unknown => proxy;
  const proxy = new Proxy(fn, { get: () => fn, set: () => true, apply: () => proxy });
  return proxy as unknown as CanvasRenderingContext2D;
}

async function makeRenderer(): Promise<Canvas2DRenderer> {
  const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const r = new Canvas2DRenderer(canvas, stubCtx());
  r.loadImage = async (url: string) => ({ url }) as never;
  await r.atlas.setRegistry(reg, sourcesFromManifest(reg, `${PACK_DIR}manifest.json`, {}, { probeSiblings: false }));
  r.bindGameplay({ buildPiece: VPiece });
  r.resize(800, 600, 1);
  return r;
}

interface RuinWorld { world: World; player: number }
function makeWorld(withRoof: boolean): RuinWorld {
  const world = new World({ seed: 1 });
  world.register(Transform); world.register(PrevTransform); world.register(VPiece);
  const addPiece = (visualId: number, x: number, y: number, level: number): void => {
    const e = world.create();
    world.add(e, Transform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x: x + 0.5, y: y + 0.5, z: 0, facing: 0 });
    world.add(e, VPiece, { visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level, layer: 0, ghost: 0 });
  };
  for (let y = 10; y <= 13; y++) for (let x = 10; x <= 13; x++) {
    addPiece(FOUNDATION_ID, x, y, 0);
    if (withRoof) addPiece(ROOF_ID, x, y, 1);
  }
  const player = world.create();
  world.add(player, Transform, { x: 11.5, y: 11.5, z: 0, facing: 0 });
  world.add(player, PrevTransform, { x: 11.5, y: 11.5, z: 0, facing: 0 });
  return { world, player };
}

/** Run frames the way the client does: images load async, the cover builds from drawn pieces, `indoor` lags one frame. */
async function renderFrames(r: Canvas2DRenderer, world: World, n: number): Promise<void> {
  for (let i = 0; i < n; i++) { r.render(world, 1); await tick(); }
}

function movePlayer(world: World, player: number, x: number, y: number): void {
  world.set(player, Transform, { x, y, z: 0, facing: 0 });
  world.set(player, PrevTransform, { x, y, z: 0, facing: 0 });
}

describe("ADR-416 Canvas2D indoor signal (console browser auto-zoom)", () => {
  it("indoor is false before any frame and while the roof art is still loading", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(true);
    r.setFocusEntity(player);
    expect(r.indoor).toBe(false);
    r.render(world, 1); // roof art images start loading; nothing drawn yet, no cover
    expect(r.indoor).toBe(false);
  });

  it("indoor is true once the player stands in the roofed ruin (art loaded, cover built)", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(true);
    r.setFocusEntity(player);
    await renderFrames(r, world, 2); // frame 1 loads art, frame 2 draws pieces + builds the cover
    expect(r.indoor).toBe(false); // one frame of lag, like IsoRenderer: the signal reads last frame's cover
    r.render(world, 1);
    expect(r.indoor).toBe(true);
  });

  it("indoor stays false outdoors, even with the ruin's cover built", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(true);
    movePlayer(world, player, 20.5, 20.5);
    r.setFocusEntity(player);
    await renderFrames(r, world, 3);
    expect(r.indoor).toBe(false);
  });

  it("indoor stays false in an unroofed ruin (foundations, no cover above)", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(false);
    r.setFocusEntity(player);
    await renderFrames(r, world, 3);
    expect(r.indoor).toBe(false);
  });

  it("stepping out of the ruin clears the signal on the next frame", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(true);
    r.setFocusEntity(player);
    await renderFrames(r, world, 3);
    expect(r.indoor).toBe(true);
    movePlayer(world, player, 20.5, 20.5);
    r.render(world, 1);
    expect(r.indoor).toBe(false);
  });

  it("no focus entity means not indoors", async () => {
    const r = await makeRenderer();
    const { world, player } = makeWorld(true);
    r.setFocusEntity(player);
    await renderFrames(r, world, 3);
    expect(r.indoor).toBe(true);
    r.setFocusEntity(-1);
    r.render(world, 1);
    expect(r.indoor).toBe(false);
  });
});
