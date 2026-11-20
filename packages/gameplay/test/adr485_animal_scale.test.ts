/**
 * ADR-485: animals draw at realistic readable sizes. Fallback scales in sprite_fallbacks.json are
 * corrected from the live pack's measured per-sprite drawn heights (base art: boar 23 px, deer 42 px,
 * wolf 30 px, rabbit 26 px, chicken 22 px); the 13 species with no own art and no fallback entry get a
 * safety-net entry so a missing art key degrades to a similar animal instead of the 0.55x bare-player
 * fallback; and the live-art draw table (data/animal_scales.json) scales the large species whose own
 * art draws too small, anchored on deer at 42 px. Small animals stay at 1 (readability band).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { animalDefs, animalDrawScale, animalScale, ANIMAL_SCALES, resolveSprite } from "../src/index.js";

const pack = JSON.parse(readFileSync(new URL("../../assets/pack/manifest.json", import.meta.url), "utf8")) as { sprites: Record<string, unknown> | { key: string }[] };
const nature = JSON.parse(readFileSync(new URL("../../assets/pack/nature/manifest.nature.json", import.meta.url), "utf8")) as { sprites: { key: string }[] };
const task34 = JSON.parse(readFileSync(new URL("../../assets/pack/task34/manifest.task34.json", import.meta.url), "utf8")) as { sprites: { key: string }[] };
const PACK = new Set([...(Array.isArray(pack.sprites) ? pack.sprites.map((s) => s.key) : Object.keys(pack.sprites)), ...nature.sprites.map((s) => s.key), ...task34.sprites.map((s) => s.key)]);
const has = (k: string): boolean => PACK.has(k);
/** `has` with `keys` treated as missing art (drives the fallback path). */
const without = (...keys: string[]) => (k: string): boolean => !keys.includes(k) && has(k);

/** Fallback scale corrections: species -> [target art, scale]. Measured base art: boar 23, deer 42, wolf 30, rabbit 26, chicken 22 px. */
const CORRECTED: [string, string, number][] = [
  ["animal_stag", "animal_deer", 0.95], ["animal_red_deer", "animal_deer", 0.95], ["animal_elk", "animal_deer", 1.03],
  ["animal_moose", "animal_deer", 1.41], ["animal_bear", "animal_boar", 1.93], ["animal_fox", "animal_wolf", 0.4],
  ["animal_hare", "animal_rabbit", 0.34], ["animal_squirrel", "animal_rabbit", 0.28], ["animal_turkey", "animal_chicken", 1.21],
  ["animal_duck", "animal_chicken", 0.47], ["animal_goose", "animal_chicken", 0.95], ["animal_goat", "animal_deer", 0.57],
  ["animal_sheep", "animal_boar", 1.16], ["animal_cow", "animal_boar", 1.87], ["animal_bison", "animal_boar", 2.33],
  ["animal_deer", "animal_boar", 1.74], ["animal_wolf", "animal_boar", 1.1], ["animal_turtle", "animal_boar", 0.26],
  ["animal_pig", "animal_boar", 1.16], ["animal_alpaca", "animal_deer", 0.71],
];
/** Safety net: species with no own art and no fallback entry before ADR-485 -> [target art, scale]. */
const SAFETY_NET: [string, string, number][] = [
  ["animal_dog_dachshund", "animal_wolf", 0.25], ["animal_dog_beagle", "animal_wolf", 0.4],
  ["animal_dog_lab", "animal_wolf", 0.59], ["animal_dog_husky", "animal_wolf", 0.59],
  ["animal_dog_shepherd", "animal_wolf", 0.59], ["animal_cat_tabby", "animal_fox", 0.62],
  ["animal_cat_black", "animal_fox", 0.62], ["animal_cat_siamese", "animal_fox", 0.62],
  ["animal_parrot", "animal_crow", 0.5], ["animal_crow", "animal_owl", 0.31],
  ["animal_ferret", "animal_squirrel", 0.35], ["animal_owl", "animal_crow", 0.7], ["animal_bee", "animal_crow", 0.1],
];

describe("ADR-485 animal scale", () => {
  it("live-art table: the 11 large species scale up/down to readable height; everything else draws at 1", () => {
    expect(ANIMAL_SCALES.scales).toEqual({
      animal_alpaca: 0.85, animal_bear: 1.65, animal_bison: 1.85, animal_boar: 1.35, animal_cow: 1.65,
      animal_elk: 0.9, animal_moose: 1.4, animal_pig: 1.25, animal_red_deer: 1.2, animal_sheep: 1.2, animal_wolf: 0.9,
    });
    for (const [k, s] of Object.entries(ANIMAL_SCALES.scales)) { expect(animalScale(k)).toBe(s); expect(animalDrawScale(k)).toBe(s); }
    for (const k of ["animal_deer", "animal_rabbit", "animal_chicken", "animal_fox", "animal_bee", "animal_owl", "animal_horse", "animal_donkey", "animal_yak", "animal_snake", undefined]) {
      expect(animalScale(k)).toBeUndefined(); expect(animalDrawScale(k)).toBe(1);
    }
  });

  it("live-art table keys are real animals; no mounts, no bee/owl (deliberately over-scale)", () => {
    const keys = Object.keys(ANIMAL_SCALES.scales);
    expect(keys).toHaveLength(11);
    for (const k of keys) expect(animalDefs().some((a) => a.key === k)).toBe(true);
    for (const k of ["animal_horse", "animal_donkey", "animal_yak", "animal_bee", "animal_owl"]) expect(keys).not.toContain(k);
  });

  it("fallback corrections: missing-art species resolve to the measured similar animal at the corrected scale", () => {
    for (const [key, target, scale] of CORRECTED) {
      const r = resolveSprite(key, without(key))!;
      expect(r, key).toBeDefined(); expect(r.key).toBe(target); expect(r.scale).toBeCloseTo(scale, 10);
      expect(has(r.key)).toBe(true);
    }
    // snake is deliberately left at 0.6: a uniform scale cannot fix a long, low animal
    const snake = resolveSprite("animal_snake", without("animal_snake"))!;
    expect(snake.key).toBe("animal_rabbit"); expect(snake.scale).toBeCloseTo(0.6, 10);
  });

  it("safety net: the 13 species with no own art resolve to a similar animal instead of the bare-player fallback", () => {
    for (const [key, target, scale] of SAFETY_NET) {
      const r = resolveSprite(key, without(key))!;
      expect(r, key).toBeDefined(); expect(r.key).toBe(target); expect(r.scale).toBeCloseTo(scale, 10);
      expect(has(r.key)).toBe(true);
    }
    // cats carry their own tint over the fox art
    expect(resolveSprite("animal_cat_tabby", without("animal_cat_tabby"))!.tint).toBe(0xc09060ff);
    expect(resolveSprite("animal_cat_black", without("animal_cat_black"))!.tint).toBe(0x404040ff);
    expect(resolveSprite("animal_cat_siamese", without("animal_cat_siamese"))!.tint).toBe(0xd8c8b0ff);
    // chained: fox art missing too, so the cat falls through fox to wolf (scales compose)
    const chained = resolveSprite("animal_cat_tabby", without("animal_cat_tabby", "animal_fox"))!;
    expect(chained.key).toBe("animal_wolf"); expect(chained.scale).toBeCloseTo(0.62 * 0.4, 10);
  });

  it("every animal key with a fallback entry resolves when its own art is missing; boar/chicken/rabbit have none (own art only)", () => {
    const keys = animalDefs().map((a) => a.key);
    expect(keys).toHaveLength(40);
    const unresolvable: string[] = [];
    for (const k of keys) { const r = resolveSprite(k, without(k)); if (!r) unresolvable.push(k); else expect(has(r.key)).toBe(true); }
    // boar, chicken and rabbit have own art in the pack and no fallback entry: if that art ever goes
    // missing they still hit the 0.55x bare-player fallback (deliberate: nothing similar to fall back to)
    expect(unresolvable.sort()).toEqual(["animal_boar", "animal_chicken", "animal_rabbit"]);
  });

  it("live-art drawn heights come out in the right relative order (measured live px x table scale)", () => {
    // measured drawn heights (idle direction-0 frame 0) in the live pack at f40445b5
    const px: Record<string, number> = {
      animal_deer: 42, animal_bear: 28, animal_bison: 30, animal_cow: 27, animal_moose: 45, animal_boar: 23,
      animal_elk: 50, animal_wolf: 30, animal_pig: 22, animal_sheep: 23, animal_red_deer: 35, animal_alpaca: 36,
    };
    const drawn = (k: string): number => px[k]! * animalDrawScale(k);
    expect(drawn("animal_bear")).toBeGreaterThan(drawn("animal_boar")); // bear is bigger than a boar
    expect(drawn("animal_bison")).toBeGreaterThan(drawn("animal_cow")); // bison is bigger than a cow
    expect(drawn("animal_moose")).toBeGreaterThan(drawn("animal_elk")); // moose is bigger than an elk
    expect(drawn("animal_boar")).toBeGreaterThan(drawn("animal_wolf")); // boar is bigger than a wolf
    expect(drawn("animal_red_deer")).toBeCloseTo(drawn("animal_deer"), 0); // red deer ~ deer height
    expect(drawn("animal_alpaca")).toBeLessThan(drawn("animal_deer")); // alpaca is smaller than a deer
  });
});
