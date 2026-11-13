import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AssetRegistry, loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";
import { slotIndex, type AppearanceValue } from "@engine/core";
import { coreAppearanceBinding, previewLayers2D, facingAngle } from "../src/index.js";
import { readManifestJson } from "@engine/assets/node";

// ADR-128 neck: head-group layers (face/eyes/hair/hat) follow the body's per-frame `head` point; body/top/shoes do not
const json = (p: string) => readManifestJson(PACK_DIR + p);
const REF = { x: 0, y: -40 };
const headAt = (i: number) => ({ x: (i % 8) - 3, y: REF.y - 2 - (i % 2) });
function setup(neck: boolean) {
  const cz = json("customization/manifest.customization.json");
  for (const b of cz.sprites.filter((s: any) => /^body_/.test(s.key))) {
    if (!neck) continue;
    b.attach = { ...(b.attach ?? {}), head: REF };
    for (const a of Object.values<any>(b.animations)) { if (!a.dirFrames) continue; a.frameMeta ??= {}; a.dirFrames.forEach((_: unknown, i: number) => { a.frameMeta[`df:${i}`] = { anchors: { ...(a.frameMeta[`df:${i}`]?.anchors ?? {}), head: headAt(i) } }; }); }
  }
  const { registry } = loadManifest(mergeManifests([{ name: "pack", manifest: json("manifest.json") }, { name: "customization", manifest: cz }] as never).manifest);
  const cat = registry.cosmetics!; const binding = coreAppearanceBinding(cat as never);
  const pick = (slot: string) => [...(cat as any).parts.values()].find((w: any) => w.slot === slot && w.bodies?.male)?.id ?? 0;
  const parts = new Array(8).fill(0); for (const s of ["hair", "hat", "top", "bottom", "shoes", "face", "eyes"]) parts[slotIndex(s as never)] = pick(s);
  const look: AppearanceValue = { bodyType: 0, skinTone: 0, parts, primary: new Array(8).fill(0), secondary: new Array(8).fill(0) };
  return { registry, binding, look };
}
const HEAD = new Set(["hair", "hat", "face", "eyes"]);

describe("head anchor in the 2D creator / Canvas2D paper doll", () => {
  const neck = setup(true), flat = setup(false);
  for (const anim of ["idle", "walk", "sit", "swim", "crouch_idle", "crouch_walk"]) it(`${anim}: all 8 facings offset head layers by head - attach.head, others stay put`, () => {
    for (let k = 0; k < 8; k++) {
      const L = previewLayers2D(neck.registry, neck.binding, neck.look, k, 0, undefined, anim);
      const body = L.find((l) => l.layer.slot === "body")!; expect(body).toBeDefined(); expect(L.filter((l) => HEAD.has(l.layer.slot)).length).toBeGreaterThanOrEqual(3);
      const a = neck.registry.sprite(body.layer.sprite).animations.get(anim)!;
      const di = AssetRegistry.directionIndex(facingAngle(k), a.directions);
      const h = headAt(di);
      for (const l of L) {
        if (HEAD.has(l.layer.slot)) expect([l.dx, l.dy], `${anim} k${k} ${l.layer.slot}`).toEqual([h.x - REF.x, h.y - REF.y]);
        else expect([l.dx, l.dy], `${anim} k${k} ${l.layer.slot}`).toEqual([0, 0]);
      }
      // shipped art (ADR-128 neck): head-group layers lifted by the 3 px neck, the rest stay put
      for (const l of previewLayers2D(flat.registry, flat.binding, flat.look, k, 0, undefined, anim)) expect([l.dx, l.dy]).toEqual(HEAD.has(l.layer.slot) ? [0, -3] : [0, 0]);
    }
  });
  it("draw order unchanged: face/eyes above hair on E/SE/S/SW/W, hat above hair everywhere", () => {
    let front = 0;
    for (let k = 0; k < 8; k++) {
      const order = previewLayers2D(neck.registry, neck.binding, neck.look, k).map((l) => l.layer.slot);
      const flatOrder = previewLayers2D(flat.registry, flat.binding, flat.look, k).map((l) => l.layer.slot);
      expect(order).toEqual(flatOrder);
      const at = (s: string) => order.lastIndexOf(s);
      if (at("hat") >= 0 && at("hair") >= 0) expect(at("hat"), `k${k}`).toBeGreaterThan(at("hair"));
      if (at("face") > at("hair") && at("eyes") > at("hair")) front++;
    }
    expect(front).toBeGreaterThanOrEqual(5); // E, SE, S, SW, W
  });
});
