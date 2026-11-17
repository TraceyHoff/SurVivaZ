/**
 * ADR-416 (client half): the console browser's auto-zoom, end to end.
 *
 * The Canvas2D fallback renderer (Xbox Edge after a GPU reset — chooseRenderer picks it when
 * WebGL2 cannot be created) used to report no indoor signal at all (`indoor` was undefined), so
 * main.ts's `camZoom?.setIndoor(iso.renderer.indoor, dt)` never engaged the ADR-206 indoor zoom
 * on that path. This test drives the real Canvas2DRenderer through frames inside a roofed ruin
 * and feeds its `indoor` into the real attachZoom exactly like main.ts does, then asserts the
 * camera zoom actually rises — the indoor zoom engages on the console render path.
 */
import { describe, expect, it } from "vitest";
import { defineComponent, PrevTransform, Transform, World } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { Canvas2DRenderer } from "@engine/render";
import { sourcesFromManifest } from "@engine/render";
import { DESKTOP_ZOOM, INDOOR_GAIN, attachZoom } from "../src/camera-zoom.js";

/** View-side build piece (mirrors apps/client/src/view.ts VPiece). */
const VPiece = defineComponent("ViewBuildPiece", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });

const manifest = mergeManifests(["manifest.json", "items/manifest.items.json", "customization/manifest.customization.json"].map((p) => ({ name: p, manifest: readManifestJson(PACK_DIR + p) })) as never).manifest;
const reg: AssetRegistry = loadManifest(manifest).registry;
const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const el = () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {}; (globalThis as { removeEventListener?: unknown }).removeEventListener ??= () => {};

function stubCtx(): CanvasRenderingContext2D {
  const fn = (..._args: unknown[]): unknown => proxy;
  const proxy = new Proxy(fn, { get: () => fn, set: () => true, apply: () => proxy });
  return proxy as unknown as CanvasRenderingContext2D;
}

describe("ADR-416 console auto-zoom: Canvas2D indoor signal drives attachZoom", () => {
  it("entering a roofed ruin on the Canvas2D path zooms the camera in (main.ts wiring)", async () => {
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, stubCtx());
    r.loadImage = async (url: string) => ({ url }) as never;
    await r.atlas.setRegistry(reg, sourcesFromManifest(reg, `${PACK_DIR}manifest.json`, {}, { probeSiblings: false }));
    r.bindGameplay({ buildPiece: VPiece });
    r.resize(1920, 1080, 1);

    // Minimal roofed ruin: one foundation + one roof over the same tile, player standing on it.
    const world = new World({ seed: 1 });
    world.register(Transform); world.register(PrevTransform); world.register(VPiece);
    const addPiece = (visualId: number, level: number): void => {
      const e = world.create();
      world.add(e, Transform, { x: 10.5, y: 10.5, z: 0, facing: 0 });
      world.add(e, PrevTransform, { x: 10.5, y: 10.5, z: 0, facing: 0 });
      world.add(e, VPiece, { visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level, layer: 0, ghost: 0 });
    };
    addPiece(reg.spriteForPiece("foundation")!, 0);
    addPiece(reg.spriteForPiece("roof_flat")!, 1);
    const player = world.create();
    world.add(player, Transform, { x: 10.5, y: 10.5, z: 0, facing: 0 });
    world.add(player, PrevTransform, { x: 10.5, y: 10.5, z: 0, facing: 0 });
    r.setFocusEntity(player);

    const cam = { zoom: 0 };
    const zc = attachZoom(cam, el(), { storage: mem(), viewport: () => ({ w: 1920, h: 1080 }) });
    expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM, 6);

    // main.ts:410, once per frame: the indoor signal is read BEFORE the frame renders (one frame of lag).
    for (let i = 0; i < 3; i++) { zc.setIndoor(r.indoor, 16); r.render(world, 1); await tick(); }
    expect(r.indoor).toBe(true);
    for (let i = 0; i < 200; i++) zc.setIndoor(r.indoor, 16);
    expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM * INDOOR_GAIN, 4);
    zc.dispose();
  });
});
