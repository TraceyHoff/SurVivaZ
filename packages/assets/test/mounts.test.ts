import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/index.js";
import { PACK_DIR, readManifestJson } from "../src/node.js";

// Rideable mounts art pass (docs/ART_KEYS_MOUNTS.md): true-scale mount sprites + fore layer + 4 saddle tiers per species,
// seat anchors (frameMeta + packages/assets/pack/nature/mount_anchors.json), v1 doll ride_* anims, saddle icons, mount SFX.
const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "nature/manifest.nature.json", "utf8"));
const anchors = JSON.parse(readFileSync(root + "nature/mount_anchors.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const bank = JSON.parse(readFileSync("apps/client/src/audio/bank.json", "utf8")).sounds;
const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");

type Rect = { x: number; y: number; w: number; h: number };
type DF = { atlas: string; rect: Rect; anchor: { x: number; y: number } };
type Anim = { frames: number[]; fps: number; directions: number; dirStride: number; loop: boolean; dirFrames: DF[]; frameMeta?: Record<string, { anchors: Record<string, { x: number; y: number }> }> };
type Sprite = { key: string; category: string; atlas: string; animations: Record<string, Anim> };
const sprite = (k: string): Sprite => man.sprites.find((s: Sprite) => s.key === k);
const atlas = (k: string) => man.atlases.find((a: { key: string }) => a.key === k);

const SPECIES: Record<string, number> = { horse: 1.6, donkey: 1.2, moose: 2.0, deer: 1.35, elk: 1.45, bison: 1.8, yak: 1.55 };
const ANIMS: [string, number, number][] = [["idle", 4, 4], ["walk", 6, 8], ["gallop", 6, 12]];
const TIERS = ["leather", "reinforced", "iron", "steel"];
const PX_PER_M = 52 / 1.75;

describe("rideable mounts", () => {
  it("ships mount, fore and four saddle-tier sprites per species with 8-facing idle/walk/gallop dirFrames", () => {
    for (const sp of Object.keys(SPECIES)) {
      const keys = [`mount_${sp}`, `mount_${sp}_fore`, ...TIERS.map((t) => `mount_saddle_${sp}_${t}`)];
      for (const key of keys) {
        const s = sprite(key);
        expect(s, key).toBeTruthy();
        expect(s.category).toBe(key.includes("saddle") ? "equipment" : "critter");
        expect(lock.sprites[key], key).toBeTypeOf("number");
        for (const [an, n, fps] of ANIMS) {
          const a = s.animations[an]!;
          expect(a, `${key}.${an}`).toBeTruthy();
          expect(a.frames).toHaveLength(n); expect(a.fps).toBe(fps); expect(a.loop).toBe(true);
          expect(a.directions).toBe(8); expect(a.dirFrames).toHaveLength(n * 8);
          for (const df of a.dirFrames) {
            const at = atlas(df.atlas);
            expect(at, df.atlas).toBeTruthy();
            expect(df.atlas.startsWith(key.includes("saddle") ? `nature_mount_saddles_${sp}_` : `nature_mounts_${sp}_`)).toBe(true);
            expect(df.rect.x + df.rect.w).toBeLessThanOrEqual(at.frameW); expect(df.rect.y + df.rect.h).toBeLessThanOrEqual(at.frameH);
          }
        }
      }
      // the base body is never blank; every frame of every facing is its own cell
      const rects = new Set<string>();
      for (const [an] of ANIMS) for (const df of sprite(`mount_${sp}`).animations[an]!.dirFrames) { expect(df.rect.w).toBeGreaterThan(8); rects.add(`${df.atlas}/${df.rect.x},${df.rect.y}`); }
      expect(rects.size).toBe(16 * 8);
    }
  });

  it("packs onto new streamed pages (<=1024 @1x, <=2048 @2x, KTX2) without touching shipped nature sprites", () => {
    const pages = man.atlases.filter((a: { key: string }) => /^nature_mounts?_/.test(a.key) || a.key.startsWith("nature_mount_saddles_"));
    expect(pages.length).toBeGreaterThanOrEqual(14);
    for (const a of pages) {
      expect(Math.max(a.frameW, a.frameH)).toBeLessThanOrEqual(1024);
      expect(a.columns).toBe(1); expect(a.rows).toBe(1);
      expect(a.ktx2).toBeTruthy(); expect(a.pages[0].scale).toBe(2); expect(a.pages[0].ktx2).toBeTruthy();
    }
    // no two non-blank mount / saddle cells share a rect (pixel uniqueness is asserted by the generator's sha1 pass)
    const seen = new Map<string, string>();
    for (const s of man.sprites as Sprite[]) {
      if (!s.key.startsWith("mount_")) continue;
      for (const [an, a] of Object.entries(s.animations)) a.dirFrames.forEach((df, i) => {
        if (df.rect.w === 4 && df.rect.h === 4) return; // shared blank (layer fully hidden in this facing)
        const id = `${df.atlas}/${df.rect.x},${df.rect.y},${df.rect.w},${df.rect.h}`;
        expect(seen.get(id), `${s.key}.${an}[${i}] reuses ${seen.get(id)}`).toBeUndefined();
        seen.set(id, `${s.key}.${an}[${i}]`);
      });
    }
  });

  it("records per-frame, per-facing seat anchors consistent with the anchor table at the player's px/m", () => {
    expect(anchors.pxPerMetre).toBeCloseTo(PX_PER_M, 3);
    expect(anchors.tiers).toEqual(TIERS);
    expect(anchors.drawOrder).toHaveLength(4);
    for (const [an, n, fps] of ANIMS) expect(anchors.anims[an]).toMatchObject({ frames: n, fps, loop: true });
    for (const [sp, h] of Object.entries(SPECIES)) {
      const e = anchors.species[sp];
      expect(e.sprite).toBe(`mount_${sp}`); expect(e.fore).toBe(`mount_${sp}_fore`);
      expect(e.heightM).toBe(h); expect(e.heightPx).toBeCloseTo(h * PX_PER_M, 0);
      for (const t of TIERS) expect(e.saddles[t]).toBe(`mount_saddle_${sp}_${t}`);
      const s = sprite(`mount_${sp}`);
      for (const [an, n] of ANIMS) for (let fi = 0; fi < n; fi++) for (let d = 0; d < 8; d++) {
        const seat = e.seat[an][fi][d], rs = anchors.riderSeat.male[`ride_${an}`][fi][d];
        expect(s.animations[an]!.frameMeta![`df:${fi * 8 + d}`]!.anchors.seat).toEqual(seat);
        expect(e.riderOffset[an][fi][d].x).toBeCloseTo(seat.x - rs.x, 1);
        expect(e.riderOffset[an][fi][d].y).toBeCloseTo(seat.y - rs.y, 1);
        expect(anchors.riderSeat.female[`ride_${an}`][fi][d]).toEqual(rs);
        // the seat sits on the back: above the pivot, below the withers top + a little saddle
        expect(-seat.y).toBeGreaterThan(h * PX_PER_M * 0.6); expect(-seat.y).toBeLessThan(h * PX_PER_M * 1.25);
      }
      // the seat bobs with the gait
      const ys = new Set(e.seat.gallop.map((f: { y: number }[]) => f[0]!.y));
      expect(ys.size).toBeGreaterThan(1);
    }
    expect(anchors.species.moose.heightPx).toBeGreaterThan(anchors.playerHeightPx);
    expect(anchors.species.donkey.heightPx).toBeLessThan(anchors.species.horse.heightPx);
  });

  it("gives every live v1 doll layer seated ride_idle/ride_walk/ride_gallop dirFrames matching the mount timing", () => {
    const manifest = readManifestJson(PACK_DIR + "customization/manifest.customization.json");
    const { registry } = loadManifest(manifest);
    const keys = new Set<string>();
    const collect = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(collect);
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
        if (k === "sprite" && typeof v === "string") keys.add(v);
        else collect(v);
      }
    };
    collect(manifest.bodyTypes); collect(manifest.wearables);
    expect(keys.size).toBeGreaterThanOrEqual(430);
    for (const key of keys) for (const [an, n, fps] of ANIMS) {
      const sp = registry.sprite(registry.id(key));
      const a = sp.animations.get(`ride_${an}`)!;
      expect(a, `${key}.ride_${an}`).toBeDefined();
      expect(a.frames).toHaveLength(n); expect(a.fps).toBe(fps); expect(a.loop).toBe(true); expect(a.directions).toBe(8);
      expect(a.dirFrames).toHaveLength(n * 8);
      for (const df of a.dirFrames!) expect(df.atlas.key).toMatch(/^cz_ride_/);
    }
    for (const bt of ["body_male", "body_female"]) {
      const sp = registry.sprite(registry.id(bt));
      for (const [an, n] of ANIMS) for (let fi = 0; fi < n; fi++) for (let d = 0; d < 8; d++) {
        expect(registry.dirFrameAnchors(sp.id, `ride_${an}`, fi * 8 + d)?.seat, `${bt} ride_${an} ${fi}/${d}`).toMatchObject(anchors.riderSeat.male[`ride_${an}`][fi][d]);
      }
    }
  });

  it("adds hit / death / graze (all species) and moose swim to the mount, fore and every saddle tier on their own pages", () => {
    const ACTS: [string, number, number, boolean][] = [["hit", 3, 10, true], ["death", 6, 8, false], ["graze", 4, 4, true]];
    const seen = new Map<string, string>();
    for (const sp of Object.keys(SPECIES)) {
      const acts = sp === "moose" ? [...ACTS, ["swim", 6, 8, true] as [string, number, number, boolean]] : ACTS;
      for (const key of [`mount_${sp}`, `mount_${sp}_fore`, ...TIERS.map((t) => `mount_saddle_${sp}_${t}`)]) {
        const s = sprite(key);
        if (sp !== "moose") expect(s.animations.swim, key).toBeUndefined();
        for (const [an, n, fps, loop] of acts) {
          const a = s.animations[an]!;
          expect(a, `${key}.${an}`).toBeTruthy();
          expect(a.frames).toHaveLength(n); expect(a.fps).toBe(fps); expect(a.loop).toBe(loop);
          expect(a.directions).toBe(8); expect(a.dirStride).toBe(n); expect(a.dirFrames).toHaveLength(n * 8);
          a.dirFrames.forEach((df, i) => {
            expect(df.atlas.startsWith(key.includes("saddle") ? `nature_mount_saddle_acts_${sp}_` : `nature_mount_acts_${sp}_`), df.atlas).toBe(true);
            const at = atlas(df.atlas); expect(Math.max(at.frameW, at.frameH)).toBeLessThanOrEqual(1024); expect(at.ktx2).toBeTruthy();
            if (key === `mount_${sp}`) {
              expect(df.rect.w).toBeGreaterThan(8);
              const seat = a.frameMeta![`df:${i}`]!.anchors.seat;
              expect(seat).toEqual(anchors.species[sp].actSeat[an][Math.floor(i / 8)][i % 8]);
              if (an === "swim") expect(a.frameMeta![`df:${i}`]!.anchors.water.y).toBe(anchors.species[sp].swimWaterY[Math.floor(i / 8)][i % 8]);
            }
            if (df.rect.w === 4 && df.rect.h === 4) return;
            const id = `${df.atlas}/${df.rect.x},${df.rect.y},${df.rect.w},${df.rect.h}`;
            expect(seen.get(id), `${key}.${an}[${i}]`).toBeUndefined(); seen.set(id, `${key}.${an}[${i}]`);
          });
        }
      }
    }
    expect(anchors.acts.anims.death).toMatchObject({ frames: 6, fps: 8, loop: false });
    expect(anchors.acts.anims.swim.species).toEqual(["moose"]);
    expect(anchors.acts.riderAnim.death).toBeNull();
  });

  it("adds four saddle tier icons in the nature icon sheet with ids and CSS", () => {
    for (const [i, t] of TIERS.entries()) {
      const s = man.sprites.find((x: Sprite) => x.key === `saddle_${t}`);
      expect(s.category).toBe("item"); expect(s.atlas).toBe("nature_icons");
      expect(s.animations.idle.frames).toEqual([124 + i]);
      expect(lock.sprites[`saddle_${t}`]).toBeTypeOf("number");
      expect(css).toContain(`[data-icon="saddle_${t}"]`);
    }
    const ic = atlas("nature_icons");
    expect(ic.frameW).toBe(32); expect(ic.columns * ic.rows).toBeGreaterThanOrEqual(128);
  });

  it("registers mount SFX: hoof steps per footstep ground type, gallop loop, mount/dismount", () => {
    const grounds = Object.keys(bank).filter((k) => /^footstep\.(grass|sand|wood|stone|dirt|water)$/.test(k)).map((k) => k.split(".")[1]);
    expect(grounds.length).toBe(6);
    for (const g of [null, ...grounds]) {
      const b = bank[g ? `mount.hoof.${g}` : "mount.hoof"];
      expect(b, String(g)).toBeTruthy(); expect(b.files).toHaveLength(4); expect(b.loop).toBe(false);
    }
    expect(bank["mount.gallop"].loop).toBe(true); expect(bank["mount.gallop"].files).toHaveLength(1);
    for (const k of ["mount.mount", "mount.dismount"]) { expect(bank[k].files).toHaveLength(2); expect(bank[k].loop).toBe(false); }
  });
});
