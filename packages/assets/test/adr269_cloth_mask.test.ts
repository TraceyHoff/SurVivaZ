// ADR-269: the cloth mask has its own inventory icon and its own face-worn art (no bandana stand-in), on the face-feature
// layer, sitting between the chin and the eyes on every facing of both bodies.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pack = fileURLToPath(new URL("../pack/", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type M = any;
const json = (p: string): M => JSON.parse(readFileSync(pack + p, "utf8"));
const acc = json("customization/manifest.customization.accessory.json");
const base = json("customization/manifest.customization.base.json");
const nature = json("nature/manifest.nature.json");
const wc = JSON.parse(readFileSync(fileURLToPath(new URL("../../gameplay/data/wear_cosmetics.json", import.meta.url)), "utf8"));
const spr = (k: string): M => acc.sprites.find((s: M) => s.key === k);

describe("ADR-269 cloth mask art contract", () => {
  it("the item maps to its own gear wearable with dedicated per-body sprites on the face-feature layer", () => {
    expect(wc.items.cloth_mask).toBe("acc_gear_cloth_mask");
    const w = acc.wearables.find((x: M) => x.key === "acc_gear_cloth_mask");
    expect(w.slot).toBe("accessory"); expect(w.displayName).toBe("Cloth Mask"); expect(w.unlockTags).toEqual(["gear"]);
    expect(w.layer).toBeGreaterThan(34); expect(w.layer).toBeLessThan(40); // over face (32) + eyes (34), under hair (40)
    expect(w.bodies.male.sprite).toBe("cz_acc_gear_cloth_mask_male"); expect(w.bodies.female.sprite).toBe("cz_acc_gear_cloth_mask_female");
    const others = acc.wearables.filter((x: M) => x.key !== w.key).flatMap((x: M) => Object.values(x.bodies).map((b: M) => b.sprite));
    expect(others).not.toContain(w.bodies.male.sprite); expect(others).not.toContain(w.bodies.female.sprite);
  });
  it("every anim of both bodies draws from the mask's own pages (wear + sleep), never the bandana's", () => {
    const pages = new Set([...acc.atlases, ...base.atlases].map((a: M) => a.key));
    expect(pages.has("cz_wr_acc_gear_cloth_mask")).toBe(true); expect(pages.has("cz_sleep_acc_cloth_mask")).toBe(true);
    for (const bt of ["male", "female"]) {
      const s = spr(`cz_acc_gear_cloth_mask_${bt}`); const ref = spr(`cz_acc_bandana_${bt}`);
      expect(Object.keys(s.animations).sort()).toEqual(Object.keys(ref.animations).sort());
      for (const [name, an] of Object.entries<M>(s.animations)) {
        const want = name.startsWith("sleep_lie") ? "cz_sleep_acc_cloth_mask" : "cz_wr_acc_gear_cloth_mask";
        expect(an.dirFrames.length, name).toBe(an.frames.length * (an.directions ?? 1));
        for (const d of an.dirFrames) {
          if (name === "block" || name === "block_hit") {
            // New guard poses have their own cells on append-only block pages, not the old wear page.
            expect(d.atlas, name).toMatch(/^cz_block_accessory_/);
            expect(ref.animations[name].dirFrames.some((b: M) => b.atlas === d.atlas && b.frame === d.frame)).toBe(false);
          } else expect(d.atlas, name).toBe(want);
        }
      }
    }
  });
  it("worn, it covers the lower face: above the bandana's neck band, below the eyepatch's eye line, on all 8 facings", () => {
    const span = (k: string, i: number): [number, number] => { const d = spr(k).animations.idle.dirFrames[i]; const top = d.anchor.y * d.rect.h; return [top - d.rect.h, top]; };
    for (const bt of ["male", "female"]) for (let dir = 0; dir < 8; dir++) {
      const [lo, hi] = span(`cz_acc_gear_cloth_mask_${bt}`, dir); const band = span(`cz_acc_bandana_${bt}`, dir); const eye = span(`cz_acc_eyepatch_${bt}`, dir);
      expect(lo, `${bt} d${dir}`).toBeGreaterThan(band[0] + 3);   // not hanging at the neck like the bandana
      expect(hi, `${bt} d${dir}`).toBeGreaterThan(band[1] + 3);   // reaches up onto the face
      expect(hi, `${bt} d${dir}`).toBeLessThan(eye[1] + 1);       // stops under the eyes
    }
  });
  it("the inventory icon is the item's own nature_icons frame, shared with no other sprite", () => {
    const icon = nature.sprites.find((s: M) => s.key === "cloth_mask"); expect(icon.atlas).toBe("nature_icons");
    const f = icon.animations.idle.frames[0];
    const users = nature.sprites.filter((s: M) => s.atlas === "nature_icons" && Object.values<M>(s.animations).some((a) => a.frames.includes(f)));
    expect(users.map((s: M) => s.key)).toEqual(["cloth_mask"]);
  });
});
