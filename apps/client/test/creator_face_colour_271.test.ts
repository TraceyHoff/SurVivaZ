// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { slotIndex, type CosmeticCatalogLike, type WearableDef } from "@engine/core";
import { readManifestJson } from "@engine/assets/read-manifest";
import { FACE_NATURAL_COLOR_KEYS, colorChoices, randomLook, seededRandom, showCharacterCreator } from "../src/character-creator.js";

// Task 271: a rolled look got a teal beard (hidden face colour from the full hair palette, no row to see it) that read
// as the teal eye colour flooding the face.
const W = (id: number, key: string, slot: WearableDef["slot"], tc: 0 | 1 | 2): WearableDef =>
  ({ id, key, slot, bodies: { male: { sprite: 1, anim: "idle" }, female: { sprite: 1, anim: "idle" } }, hidesSlots: [], hatHair: false, unlockTags: [], layer: 0, z: 0, tintChannels: tc }) as unknown as WearableDef;
const parts = [W(1, "hair_sidepart", "hair", 2), W(2, "face_beard", "face", 1), W(8, "eyes_round", "eyes", 2)];
const man = readManifestJson("packages/assets/pack/customization/manifest.customization.json") as Record<string, { key: string; color: string }[]>;
const pal = (k: string) => man[k]!.map((c, index) => ({ index, key: c.key, color: parseInt(c.color.slice(1), 16) }));
const cat: CosmeticCatalogLike = { wearable: (id) => parts.find((p) => p.id === id), bodySprite: () => ({ sprite: 1, anim: "idle" }), skinTones: pal("skinTones"), hairColors: pal("hairColors"), clothingColors: pal("clothingColors"), defaults: { eyes: 8 } };

describe("Task 271: rolled eye colour never reaches the face", () => {
  it("randomize rolls the beard from natural hair colours only; eyes keep the curated eye list; skin from skin tones", () => {
    const fi = slotIndex("face"), ei = slotIndex("eyes"); const eyes = colorChoices(cat, "eyes");
    const natural = new Set(FACE_NATURAL_COLOR_KEYS);
    for (let seed = 1; seed <= 2000; seed++) {
      const v = randomLook(cat, seededRandom(seed));
      expect(natural.has(cat.hairColors[v.primary[fi]!]!.key), `seed ${seed}`).toBe(true);
      expect(eyes).toContain(v.primary[ei]);
      expect(v.skinTone).toBeLessThan(cat.skinTones.length);
      expect(["teal", "mint", "sky"]).not.toContain(cat.hairColors[v.primary[fi]!]!.key);
    }
  });
  // ADR-502: the Face colour row is gone — the beard colour is rolled from natural colours only (see above) and is
  // no longer choosable at creation; it stays changeable in-game at the wardrobe. The row-existence test that
  // lived here (Task 271) was deleted with the row.
  it("ADR-502: no Face colour row in the creator — and the Hair colour row stays (Tracey: leave the hair color)", async () => {
    document.body.innerHTML = "";
    void showCharacterCreator({ root: document.body, catalog: cat, pads: () => [] });
    expect(document.querySelector('[data-role="creator-face:color"]')).toBeNull();
    expect(document.querySelector('[data-action="next-face:color"]')).toBeNull();
    expect(document.querySelector('[data-action="prev-face:color"]')).toBeNull();
    expect(document.querySelector('[data-role="creator-hair:color"]')).not.toBeNull();
    expect(document.querySelector('[data-role="creator-face"]')).not.toBeNull(); // the Face / beard piece row stays
  });
});
