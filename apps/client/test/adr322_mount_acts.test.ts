/** ADR-322: rider poses paired with mount gaits, mount actions (hit / death / graze / moose swim) and the rider during them. */
import { describe, expect, it } from "vitest";
import { MOUNT_SPECIES } from "@engine/gameplay";
import { animChainFor } from "@engine/render";
import { AnimState } from "@engine/core";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import {
  GRAZE_CYCLE, GRAZE_ON, idleGrazing, MOUNT_GAIT_ANIM, MOUNT_SHEET_WILD, mountActOf, mountForeKey, mountSpriteKeyOf, RIDER_ACT_ANIM, RIDER_GAIT_ANIM,
  riderActPlan, riderPivotOffset, riderStartTick, saddleOverlayKey, swimClipPx,
} from "../src/mount-render.js";
import anchors from "../../../packages/assets/pack/nature/mount_anchors.json";
import manifest from "../../../packages/assets/pack/nature/manifest.nature.json";
import fallbacks from "../../../packages/gameplay/data/sprite_fallbacks.json";

type P = { x: number; y: number };
const A = anchors as unknown as {
  anims: Record<string, { frames: number; fps: number }>; riderSeat: Record<"male" | "female", Record<string, P[][]>>;
  species: Record<string, { sprite: string; wildSprite: string | null; seat: Record<string, P[][]>; riderOffset: Record<string, P[][]>; actSeat: Record<string, P[][]>; swimWaterY?: number[][] }>;
  acts: { anims: Record<string, { frames: number; fps: number; loop: boolean; species: string | string[] }>; riderAnim: Record<string, string | null> };
};
type Anim = { frames: number[]; fps: number; loop?: boolean; directions?: number; frameMeta?: Record<string, { anchors?: Record<string, P> }> };
const sprites = new Map((manifest as unknown as { sprites: { key: string; animations: Record<string, Anim> }[] }).sprites.map((s) => [s.key, s]));
const SPECIES = Object.keys(A.species);

describe("ADR-322 rider poses pair 1:1 with the mount gaits", () => {
  it("doll pivot = mount pivot + seat - rider body seat (riderOffset) for every species, gait, frame and facing, male and female", () => {
    for (const sex of ["male", "female"] as const) for (const sp of SPECIES) for (const g of MOUNT_GAIT_ANIM) {
      const seat = A.species[sp]!.seat[g]!, off = A.species[sp]!.riderOffset[g]!, rs = A.riderSeat[sex][`ride_${g}`]!;
      expect(rs.length).toBe(seat.length);
      seat.forEach((row, f) => row.forEach((s, d) => { const o = riderPivotOffset(s, rs[f]![d]!); expect(o.x).toBeCloseTo(off[f]![d]!.x, 4); expect(o.y).toBeCloseTo(off[f]![d]!.y, 4); }));
    }
  });
  it("the body sprites carry the seat anchors (frameMeta df:i) that riderSeat lists, with the gait's frame count and fps", () => {
    const cz = readManifestJson(PACK_DIR + "customization/manifest.customization.json") as { sprites: { key: string; animations: Record<string, Anim & { dirFrames?: unknown[] }> }[] };
    for (const sex of ["male", "female"] as const) {
      const body = cz.sprites.find((s) => s.key === `body_${sex}`)!;
      MOUNT_GAIT_ANIM.forEach((g, gi) => {
        const ra = body.animations[RIDER_GAIT_ANIM[gi]!]!; const m = A.anims[g]!;
        expect(ra.frames.length).toBe(m.frames); expect(ra.fps).toBe(m.fps); // rider frame fi = mount frame fi at the same fps
        const mount = sprites.get("mount_horse")!.animations[g]!; expect(mount.frames.length).toBe(m.frames); expect(mount.fps).toBe(m.fps);
        A.riderSeat[sex][RIDER_GAIT_ANIM[gi]!]!.forEach((row, f) => row.forEach((p, d) => {
          const s = ra.frameMeta?.[`df:${f * 8 + d}`]?.anchors?.["seat"]; expect(s, `${sex} ${g} ${f}/${d}`).toBeTruthy(); expect(s!.x).toBeCloseTo(p.x, 2); expect(s!.y).toBeCloseTo(p.y, 2);
        }));
      });
    }
  });
  it("on a gait the rider shares the mount clock; the seated chain is ride_* (no vehicle / sit fallback)", () => {
    expect(riderStartTick(undefined, 120, 300)).toBe(120);
    for (const r of [0, 1, 2] as const) { const ch = animChainFor(AnimState.Sit, { ride: r })!; expect(ch[0]).toBe(RIDER_GAIT_ANIM[r]); expect(ch).not.toContain("vehicle"); expect(ch).not.toContain("sit"); }
  });
});

describe("ADR-322 mount actions and the rider", () => {
  it("every mount, fore and saddle sheet has hit / death / graze (moose also swim) with the anchors' frames, fps and loop", () => {
    for (let i = 1; i <= MOUNT_SPECIES.length; i++) {
      const keys = [mountSpriteKeyOf(i), mountForeKey(i), ...[1, 2, 3, 4].map((t) => saddleOverlayKey(t, i))];
      const art = mountSpriteKeyOf(i).slice("mount_".length);
      for (const k of keys) for (const [act, d] of Object.entries(A.acts.anims)) {
        const on = d.species === "all" || (d.species as string[]).includes(art); const a = sprites.get(k)!.animations[act];
        if (!on) { expect(a, `${k}.${act}`).toBeUndefined(); continue; }
        expect(a, `${k}.${act}`).toBeTruthy(); expect(a!.frames.length).toBe(d.frames); expect(a!.fps).toBe(d.fps); expect(a!.loop !== false).toBe(d.loop);
      }
    }
  });
  it("act -> rider: hit / graze / swim play ride_idle on the rider's own clock; death dismounts (matches acts.riderAnim)", () => {
    for (const act of ["hit", "death", "graze", "swim"] as const) expect(RIDER_ACT_ANIM[act]).toBe(A.acts.riderAnim[act]);
    expect(riderActPlan("hit")).toEqual({ anim: "ride_idle", ownClock: true }); expect(riderActPlan("death").anim).toBeNull();
    expect(riderStartTick("graze", 120, 300)).toBe(300);
    // view anim states: 4 Hurt, 5 Die, 8 Eat / 9 Graze, 14 Swim (only on a sheet that has swim); gaits are no act
    expect(mountActOf(4, false)).toBe("hit"); expect(mountActOf(5, false)).toBe("death"); expect(mountActOf(8, false)).toBe("graze"); expect(mountActOf(9, true)).toBe("graze");
    expect(mountActOf(14, true)).toBe("swim"); expect(mountActOf(14, false)).toBeUndefined();
    for (const s of [0, 1, 2]) expect(mountActOf(s, true)).toBeUndefined();
  });
  it("the rider pins its seat on the act's seat anchor (actSeat = the frame's seat anchor on the mount sheet)", () => {
    for (const sp of SPECIES) for (const [act, rows] of Object.entries(A.species[sp]!.actSeat)) {
      const a = sprites.get(A.species[sp]!.sprite)!.animations[act]!;
      rows.forEach((row, f) => row.forEach((p, d) => { const s = a.frameMeta![`df:${f * 8 + d}`]!.anchors!["seat"]!; expect(s.x).toBeCloseTo(p.x, 2); expect(s.y).toBeCloseTo(p.y, 2); }));
    }
  });
  it("wild horse / donkey / yak (no wild sheet) wear the mount sheet, so they graze and get hit / die on it", () => {
    const wild = SPECIES.filter((sp) => A.species[sp]!.wildSprite === null).map((sp) => `animal_${sp}`);
    expect(new Set(wild)).toEqual(new Set(MOUNT_SHEET_WILD));
    const fb = (fallbacks as unknown as { sprites: Record<string, { to: string[] }> }).sprites;
    for (const k of wild) { expect(sprites.has(k), k).toBe(false); expect(fb[k]!.to[0]).toBe(`mount_${k.slice("animal_".length)}`); }
  });
  it("idle grazing is a deterministic per-animal duty cycle (GRAZE_ON of every GRAZE_CYCLE s)", () => {
    let on = 0; const hz = 20; for (let t = 0; t < GRAZE_CYCLE * hz; t++) if (idleGrazing(t, hz, 12345)) on++;
    expect(on / hz).toBeCloseTo(GRAZE_ON, 0); expect(idleGrazing(77, hz, 9)).toBe(idleGrazing(77, hz, 9));
  });
});

describe("ADR-322 moose swim clips the rider at the waterline", () => {
  const m = A.species["moose"]!; const swim = sprites.get("mount_moose")!.animations["swim"]!;
  it("the water anchor on every swim frame is swimWaterY, and the clip is the water row above the seat pivot", () => {
    m.swimWaterY!.forEach((row, f) => row.forEach((wy, d) => {
      const an = swim.frameMeta![`df:${f * 8 + d}`]!.anchors!; expect(an["water"]!.y).toBe(wy);
      const seat = m.actSeat["swim"]![f]![d]!; expect(an["seat"]!.y).toBeCloseTo(seat.y, 2);
      const clip = swimClipPx(seat.y, wy); expect(clip).toBeCloseTo(seat.y - wy, 6);
      expect(clip).toBeLessThan(0); // +y down: the surface is under the seat, so the doll is cut below its seat by -clip px
    }));
  });
  it("only the moose swims; other species have no swim water", () => {
    for (const sp of SPECIES) if (sp !== "moose") { expect(A.species[sp]!.swimWaterY).toBeUndefined(); expect(A.species[sp]!.actSeat["swim"]).toBeUndefined(); }
  });
});
