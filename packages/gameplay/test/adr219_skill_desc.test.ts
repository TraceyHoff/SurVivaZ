/** ADR-219: every skill has a description generated from its effect data (values, ranks, unlocks, perks). */
import { describe, expect, test } from "vitest";
import { FIRE_TENDER_RADIUS, IRON_STOMACH_HP, modLines, recipesUnlockedAt, SKILL_MOD_LABEL, SKILL_PERK_TEXT, SKILLS, skillDescription, skillNodeIndex, XP_SHARE_RADIUS } from "../src/index.js";

const live = SKILLS.nodes.map((n, i) => ({ n, i })).filter(({ n }) => !n.retired);
const d = (key: string) => skillDescription(skillNodeIndex(key));

describe("ADR-219 skill descriptions", () => {
  test("coverage: every live skill has at least one non-empty effect line and a text", () => {
    expect(live.length).toBeGreaterThan(100);
    for (const { n, i } of live) {
      const s = skillDescription(i);
      expect(s.effects.length, n.key).toBeGreaterThan(0);
      for (const l of s.effects) expect(l.trim().length, n.key).toBeGreaterThan(3);
      expect(s.text.length, n.key).toBeGreaterThan(8);
    }
  });
  test("every mod key and perk used in skills.json has a label / generator (no raw keys leak into the UI)", () => {
    for (const { n } of live) {
      for (const k of Object.keys(n.effects.mods ?? {})) expect(k.startsWith("dmg_") ? SKILLS.weaponClasses[k.slice(4)] ?? (k === "dmg_unarmed" ? [] : undefined) : SKILL_MOD_LABEL[k] ?? (k === "share" ? "share" : undefined), `${n.key}.${k}`).toBeDefined();
      if (n.effects.perk) expect(SKILL_PERK_TEXT[n.effects.perk], n.key).toBeDefined();
    }
  });
  test("every mod value appears as a percentage in the generated lines", () => {
    for (const { n, i } of live) for (const v of Object.values(n.effects.mods ?? {})) {
      expect(skillDescription(i).effects.join(" "), n.key).toContain(`${Math.round(Math.abs(v!) * 100)}%`);
    }
  });
  test("authored desc percentages agree with the effect data (catches drift)", () => {
    for (const { n } of live) {
      const vals = new Set(Object.values(n.effects.mods ?? {}).map((v) => Math.round(Math.abs(v!) * 100)));
      for (const m of n.desc.matchAll(/(\d+)%/g)) expect(vals.has(Number(m[1])), `${n.key}: "${n.desc}"`).toBe(true);
    }
  });
  test("values, signs and context", () => {
    expect(d("forager").effects).toEqual(["+10% gathering yield", "+5% action speed (gathering, crafting and building)"]); // ADR-477: forager is a speed practice node
    expect(d("light_step").effects[0]).toMatch(/^-15% noise/);
    expect(d("firekeeper").effects[0]).toContain(`within ${FIRE_TENDER_RADIUS} tiles`);
    expect(d("rally").effects[0]).toBe(`Party and clan members within ${XP_SHARE_RADIUS} tiles also get 10% of the XP you earn`);
    expect(d("berserker").effects).toEqual(["+20% blade, blunt and axe damage", "-10% carry weight"]);
    expect(d("blade_training").effects[0]).toContain("(sword, knife");
    expect(d("iron_stomach").effects[0]).toContain(`${IRON_STOMACH_HP} health`);
    expect(d("husbandry_breeding").effects[0]).toMatch(/breed \(about every 20 min/);
    expect(modLines({ dmg_bow: 0.15, dmg_crossbow: 0.15 })).toEqual(["+15% bow and crossbow damage"]);
  });
  test("rank chains show rank n of N and the running total", () => {
    expect(d("blade_training").rank).toMatchObject({ n: 1, of: 3 });
    expect(d("blade_expert").rank!.text).toContain("total with earlier ranks: +25% blade damage");
    expect(d("blade_mastery").rank).toMatchObject({ n: 3, of: 3 }); expect(d("blade_mastery").rank!.text).toContain("+50%");
    expect(d("mechanic_4").rank!.text).toContain("+80% vehicle repair");
    expect(d("forager").rank).toBeUndefined();
  });
  test("skill nodes list the recipes their level unlocks (from recipes.json) or what they lead to", () => {
    expect(recipesUnlockedAt("gunsmithing", 2).length).toBe(4);
    expect(d("gunsmithing_2").effects.join(" ")).toMatch(/Unlocks recipes: .*Revolver/);
    expect(d("smithing_3").effects.join(" ")).toMatch(/Unlocks recipes: .* and \d+ more/);
    expect(d("smithing_1").effects).toContain("Needed for Smithing 2");
    expect(d("husbandry_1").note).toMatch(/tame passive animals/);
    expect(d("grease_monkey").note).toBeUndefined(); // "+15% vehicle repair" already generated
  });
});
