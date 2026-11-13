import { describe, it, expect } from "vitest";
import { loadManifest, mergeManifests, type AssetRegistry } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { AnimState, ANIM_STATE_NAMES } from "@engine/core";
import { AtlasManager, STATE_ANIMS, newResolved } from "../src/assets/atlasManager.js";
import { animChainFor, attackClassOf, BOW_DRAW_S, CARRY_SOCKET, SEAT_SOCKET, type AnimChainCtx } from "../src/character/animChain.js";

/** ADR-241: Block/Aim/Crouch/Carry/Sleep states, the per-entity attack_<class> / vehicle / bed chain, carry + seat sockets. */
const json = (p: string) => readManifestJson(PACK_DIR + p);
let regCache: AssetRegistry | undefined;
const reg = (): AssetRegistry => regCache ??= loadManifest(mergeManifests([
  { name: "pack", manifest: json("manifest.json") }, { name: "customization", manifest: json("customization/manifest.customization.json") },
  { name: "customization_v2_sample", manifest: json("customization_v2_sample/manifest.customization_v2_sample.json") },
] as never).manifest).registry;
/** AtlasManager without GL: just the sprite anim tables chainAnim / sharedChainAnim / handOf read. */
function tables(r: AssetRegistry): AtlasManager {
  const am = Object.create(AtlasManager.prototype) as any; am.sprites = []; am.registry = r; am.handByEntry = new Map();
  for (const s of r.allSprites()) { const names = s.animList.map((a) => a.name); const stateAnim = new Int16Array(ANIM_STATE_NAMES.length);
    STATE_ANIMS.forEach((c, st) => { stateAnim[st] = Math.max(0, c.map((n) => names.indexOf(n)).find((x) => x >= 0) ?? 0); });
    am.sprites[s.id] = { anims: s.animList, stateAnim }; }
  return am as AtlasManager;
}
const id = (r: AssetRegistry, key: string) => r.id(key);
const V1 = new Set(["idle", "walk", "run", "attack", "punch", "hit", "hurt", "death", "die", "sit", "swim", "gather", "build", "eat"]);
const CTXS: AnimChainCtx[] = [{}, { moving: true }, { driver: true }, { bed: "lie" }, { bed: "under" }, { elapsed: 1 },
  ...["unarmed", "blade", "blunt", "axe", "spear", "bow", "crossbow", "firearm"].map((weaponClass) => ({ weaponClass })), { itemKey: "throwing_knife", weaponClass: "blade" }, { itemKey: "sling", weaponClass: "bow" }];

describe("ADR-241 anim states + per-entity chains", () => {
  it("core states are appended (wire-stable) and named in step", () => {
    expect([AnimState.Block, AnimState.Aim, AnimState.Crouch, AnimState.Carry, AnimState.Sleep, AnimState.BlockHit]).toEqual([20, 21, 22, 23, 24, 25]);
    expect(ANIM_STATE_NAMES.slice(20)).toEqual(["block", "aim", "crouch", "carry", "sleep", "block_hit"]);
    for (let s = 20; s <= 25; s++) expect(STATE_ANIMS[s]!.at(-1)).toBe("idle");
  });
  it("attack picks attack_<weapon class>; throwing_* / sling throw; bows release, crossbows and guns fire", () => {
    const a = (ctx: AnimChainCtx) => animChainFor(AnimState.Attack, ctx)![0];
    expect(a({})).toBe("attack_unarmed"); expect(a({ weaponClass: "blade" })).toBe("attack_blade"); expect(a({ weaponClass: "axe" })).toBe("attack_axe");
    expect(a({ weaponClass: "blunt" })).toBe("attack_blunt"); expect(a({ weaponClass: "spear" })).toBe("attack_spear");
    expect(a({ weaponClass: "spear", itemKey: "throwing_axe" })).toBe("attack_throw"); expect(attackClassOf({ itemKey: "sling", weaponClass: "bow" })).toBe("throw");
    expect(a({ weaponClass: "bow" })).toBe("bow_release"); expect(a({ weaponClass: "crossbow" })).toBe("attack_crossbow"); expect(a({ weaponClass: "firearm" })).toBe("gun_fire");
    expect(a({ weaponClass: "tool" })).toBe("attack"); expect(animChainFor(AnimState.Punch, {})![0]).toBe("attack_unarmed");
  });
  it("aim draws then holds a bow, aims a crossbow / gun; crouch/carry walk while moving; driver sits in the vehicle pose", () => {
    expect(animChainFor(AnimState.Aim, { weaponClass: "bow", elapsed: 0 })![0]).toBe("bow_draw");
    expect(animChainFor(AnimState.Aim, { weaponClass: "bow", elapsed: BOW_DRAW_S + 0.01 })![0]).toBe("bow_hold");
    expect(animChainFor(AnimState.Aim, { weaponClass: "firearm" })![0]).toBe("gun_aim"); expect(animChainFor(AnimState.Aim, { weaponClass: "crossbow" })![0]).toBe("gun_aim");
    expect(animChainFor(AnimState.Crouch, { moving: true })![0]).toBe("crouch_walk"); expect(animChainFor(AnimState.Crouch, {})![0]).toBe("crouch_idle");
    expect(animChainFor(AnimState.Carry, { moving: true })![0]).toBe("carry_walk"); expect(animChainFor(AnimState.Carry, {})![0]).toBe("carry_idle");
    expect(animChainFor(AnimState.Sit, { driver: true })).toEqual(["vehicle", "sit", "idle"]); expect(animChainFor(AnimState.Sit, {})).toBeUndefined();
    expect(animChainFor(AnimState.Walk, { moving: true })).toBeUndefined();
  });
  it("sleep in a bed lies down (bunk lower: sleep_lie_under), falling back to the curled sleep, then sit / idle", () => {
    expect(animChainFor(AnimState.Sleep, {})).toEqual(["sleep", "sit", "idle"]);
    expect(animChainFor(AnimState.Sleep, { bed: "lie" })).toEqual(["sleep_lie", "sleep", "sit", "idle"]);
    expect(animChainFor(AnimState.Sleep, { bed: "under" })).toEqual(["sleep_lie_under", "sleep_lie", "sleep", "sit", "idle"]);
  });
  it("chains are shared frozen arrays (allocation-free per frame) ending in a v1 anim", () => {
    expect(animChainFor(AnimState.Crouch, { moving: true })).toBe(animChainFor(AnimState.Crouch, { moving: true }));
    for (let s = 0; s < ANIM_STATE_NAMES.length; s++) for (const c of CTXS) { const ch = animChainFor(s, c); if (ch) { expect(Object.isFrozen(ch)).toBe(true); expect(V1.has(ch.at(-1)!)).toBe(true); } }
  });
  it("v2 sample body resolves every new anim; v1 body falls back to its v1 anim (bed: curled sleep until sleep_lie lands)", () => {
    const r = reg(); const am = tables(r); const v2 = id(r, "v2s_body_male"), v1 = id(r, "body_male");
    const name = (sid: number, st: number, c: AnimChainCtx) => am.animName(sid, am.chainAnim(sid, animChainFor(st, c), st));
    expect(name(v2, AnimState.Attack, { weaponClass: "axe" })).toBe("attack_axe"); expect(name(v1, AnimState.Attack, { weaponClass: "axe" })).toBe("attack");
    expect(name(v2, AnimState.Crouch, { moving: true })).toBe("crouch_walk"); expect(name(v1, AnimState.Crouch, { moving: true })).toBe("crouch_walk");
    expect(name(v2, AnimState.Sit, { driver: true })).toBe("vehicle"); expect(name(v2, AnimState.Block, {})).toBe("block"); expect(name(v1, AnimState.Block, {})).toBe("block");
    expect(name(v1, AnimState.BlockHit, {})).toBe("block_hit");
    const hasLie = am.findAnim(v2, "sleep_lie") >= 0; expect(name(v2, AnimState.Sleep, { bed: "lie" })).toBe(hasLie ? "sleep_lie" : "sleep");
    for (let s = 0; s < ANIM_STATE_NAMES.length; s++) for (const c of CTXS) expect(am.animName(v1, am.chainAnim(v1, animChainFor(s, c), s))).toBeDefined();
    // paper doll: v1 now ships crouch_walk, so a v2+v1 doll stays on crouch_walk together
    expect(am.animName(v2, am.sharedChainAnim(v2, [{ sprite: v2 }, { sprite: v1 }], animChainFor(AnimState.Crouch, { moving: true })!, AnimState.Crouch))).toBe("crouch_walk");
  });
  it("fully customized v1 dolls share block rather than falling down to idle", () => {
    const r = reg(); const am = tables(r);
    for (const bt of ["male", "female"]) {
      const body = id(r, `body_${bt}`);
      const wear = ["hair_bob", "hat_cap", "face_smile", "eyes_round", "top_tee", "top_tee",
        "bottom_jeans", "shoes_sneakers", "acc_bandana", "acc_cloth_gloves"];
      const layers = wear.map((key, i) => ({ sprite: id(r, `cz_${key}_${bt}${i === 5 ? "_sleeves" : ""}`) }));
      expect(am.animName(body, am.sharedChainAnim(body, [{ sprite: body }, ...layers],
        animChainFor(AnimState.Block, {})!, AnimState.Block))).toBe("block");
      expect(am.animName(body, am.sharedChainAnim(body, [{ sprite: body }, ...layers],
        animChainFor(AnimState.BlockHit, {})!, AnimState.BlockHit))).toBe("block_hit");
    }
  });
  it("carry / seat sockets are read off the v2 frames (pivot-relative; seat above the feet)", () => {
    const r = reg(); const am = tables(r); const v2 = id(r, "v2s_body_male"); const res = newResolved();
    for (const [anim, sock] of [["carry_idle", CARRY_SOCKET], ["vehicle", SEAT_SOCKET], ["sit", SEAT_SOCKET]] as const) {
      const sp = r.sprite(v2); const an = sp.animations.get(anim)!; const d0 = an.dirFrames![0]!;
      Object.assign(res, { sprite: v2, anim, dfi: 0, frame: d0.frame, ax: 48, ay: 80 });
      const h = am.handOf(res, sock); expect(h, `${anim}.${sock}`).toBeDefined();
      if (sock === SEAT_SOCKET) expect(h!.y).toBeLessThan(80);
    }
    Object.assign(res, { sprite: v2, anim: "idle", dfi: 0, frame: r.sprite(v2).animations.get("idle")!.dirFrames![0]!.frame });
    expect(am.handOf(res, SEAT_SOCKET)).toBeUndefined();
  });
});
