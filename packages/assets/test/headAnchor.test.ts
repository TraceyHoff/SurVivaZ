import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AssetRegistry, HEAD_RECT_SLACK_PX, defaultGroupOf, loadManifest } from "../src/index.js";
import { PACK_DIR } from "../src/node.js";
import { mergeManifests } from "../src/merge.js";
import { readManifestJson } from "../src/node.js";

// ADR-128 neck: body frameMeta `head` (top of the neck) moves head-group layers by head - attach.head (reference)
const pack = () => JSON.parse(readFileSync(PACK_DIR + "manifest.json", "utf8"));
const cz = () => readManifestJson(PACK_DIR + "customization/manifest.customization.json");
const load = (m: any) => loadManifest(mergeManifests([{ name: "pack", manifest: pack() }, { name: "customization", manifest: m }] as never).manifest).registry;
const ANIMS = ["idle", "walk", "sit", "swim", "crouch_idle", "crouch_walk"] as const;
const REF = { x: 0, y: -40 };
// a distinct head point per dirFrames entry: neck 2-3 px higher, x wobbles with the facing
const headAt = (i: number) => ({ x: REF.x + (i % 8) - 3, y: REF.y - 2 - (i % 2) });

function neckBody(): any {
  const m = cz(); const b = m.sprites.find((s: any) => s.key === "body_male");
  b.attach = { ...(b.attach ?? {}), head: REF };
  for (const an of ANIMS) { const a = b.animations[an]; a.frameMeta ??= {}; a.dirFrames.forEach((_: unknown, i: number) => { a.frameMeta[`df:${i}`] = { anchors: { ...(a.frameMeta[`df:${i}`]?.anchors ?? {}), head: headAt(i) } }; }); }
  return m;
}

describe("head anchor (ADR-128 neck)", () => {
  it("shipped art: 3 px neck lifts head layers on every body, anim and facing; bandana is head-group, scarf is not", () => {
    const r = load(cz());
    for (const bt of ["body_male", "body_female"]) { const id = r.id(bt);
      for (const an of ["idle", "walk", "run", "gather", "attack", "hit", "death", "sit", "swim", "punch", "crouch_idle", "crouch_walk"]) for (let d = 0; d < 8; d++) {
        const o = AssetRegistry.headOffset(r.dirFrame(id, an, (d / 8) * Math.PI * 2, 0)); expect([o.x, o.y]).toEqual([0, -3]);
      } }
    const m = cz(); const k = (re: RegExp) => r.id(m.sprites.find((s: any) => re.test(s.key)).key);
    expect(r.isHeadGroup(k(/^cz_acc_bandana/))).toBe(true); expect(r.isHeadGroup(k(/^cz_acc_scarf/))).toBe(false);
  });
  it("every facing of idle/walk/sit/swim/crouch: offset = df:<i> head - attach.head (unmirrored), handR untouched", () => {
    const r = load(neckBody()); const id = r.id("body_male"); let n = 0;
    for (const an of ANIMS) { const a = r.sprite(id).animations.get(an)!;
      for (let f = 0; f < a.frames.length; f++) for (let d = 0; d < 8; d++) {
        const ref = r.dirFrame(id, an, (d / 8) * Math.PI * 2, (f + 0.01) / a.fps);
        const di = f * a.directions + AssetRegistry.directionIndex((d / 8) * Math.PI * 2, a.directions);
        const o = AssetRegistry.headOffset(ref); const h = headAt(di);
        expect([o.x, o.y]).toEqual([h.x - REF.x, h.y - REF.y]); expect(o.y).toBeLessThan(0); // neck lifts the head
        if (an === "idle" && di === 0) expect(ref.anchors?.handR).toBeDefined();
        n++;
      } }
    expect(n).toBeGreaterThanOrEqual(ANIMS.length * 8);
  });
  it("rect key and legacy frame key resolve the head like handR (df -> rect -> frame)", () => {
    const m = neckBody(); const b = m.sprites.find((s: any) => s.key === "body_male"); const a = b.animations.sit; const d0 = a.dirFrames[0];
    delete a.frameMeta["df:0"]; // a df entry wins as a whole (same as handR)
    a.frameMeta[`rect:${d0.atlas}/${d0.rect.x},${d0.rect.y},${d0.rect.w},${d0.rect.h}`] = { anchors: { head: { x: 1, y: -43 } } };
    const r = load(m); const id = r.id("body_male");
    const di0 = AssetRegistry.directionIndex(0, a.directions); // facing 0 -> entry di0 of frame 0
    const ref = r.dirFrame(id, "sit", 0, 0); const o = AssetRegistry.headOffset(ref);
    if (di0 === 0) expect([o.x, o.y]).toEqual([1, -3]); else expect([o.x, o.y]).toEqual([headAt(di0).x - REF.x, headAt(di0).y - REF.y]);
  });
  it("group: explicit tag, else head for face_/eyes_/hair_/hat_/headwear_ and head-worn accessories", () => {
    for (const k of ["cz_face_smile_male", "cz_eyes_wide_female", "cz_hair_bob_female", "cz_hat_beanie_male", "headwear_cap", "cz_acc_round_glasses_male", "cz_acc_earrings_female"]) expect(defaultGroupOf(k)).toBe("head");
    for (const k of ["body_male", "cz_top_tee_male", "cz_shoes_boots_female", "cz_acc_backpack_male", "cz_acc_scarf_male"]) expect(defaultGroupOf(k)).toBeUndefined();
    const m = cz(); const sc = m.sprites.find((s: any) => /^cz_acc_scarf/.test(s.key)); sc.group = "head"; const tee = m.sprites.find((s: any) => /^cz_top_/.test(s.key)); tee.group = "torso";
    const r = load(m); expect(r.isHeadGroup(r.id(sc.key))).toBe(true); expect(r.isHeadGroup(r.id(tee.key))).toBe(false);
    expect(r.isHeadGroup(r.id(m.sprites.find((s: any) => /^cz_hair_/.test(s.key)).key))).toBe(true);
    sc.group = "Head!"; expect(() => load(m)).toThrow(/group must be/);
  });
  it("validator: head must be finite and within the slack of its frame rect", () => {
    const m = neckBody(); const a = m.sprites.find((s: any) => s.key === "body_male").animations.swim;
    a.frameMeta["df:0"].anchors.head = { x: 0, y: -400 }; expect(() => load(m)).toThrow(/anchors.head: must lie within/);
    a.frameMeta["df:0"].anchors.head = { x: Number.NaN, y: -40 }; expect(() => load(m)).toThrow(/finite/);
    const r = a.dirFrames[0].rect; a.frameMeta["df:0"].anchors.head = { x: 0, y: -a.dirFrames[0].anchor.y * r.h - HEAD_RECT_SLACK_PX + 1 }; expect(() => load(m)).not.toThrow(); // just above the rect: ok
  });
});
