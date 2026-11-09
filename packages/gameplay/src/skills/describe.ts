/**
 * ADR-219: skill descriptions generated from the effect data (skills.json effects + recipes.json skill gates + the
 * gameplay constants the perks use), so the text in the skill tree can never drift from what a skill actually does.
 * Per-rank chains (training -> expert -> mastery, smithing 1 -> 2 -> 3, ...) also show the rank and the running total.
 */
import recipesRaw from "../../data/recipes.json";
import itemsRaw from "../../data/items.json";
import { SKILLS, SKILL_REQS, XP_SHARE_RADIUS, type SkillNodeDef } from "./tree.js";
import { FIRE_TENDER_RADIUS } from "../systems/fuel.js";
import { IRON_STOMACH_HP } from "../systems/vitals.js";

export interface SkillDescription {
  /** One line per effect, e.g. "+10% gathering yield". */
  effects: string[];
  /** Rank in a chain of same-effect skills: "Rank 2 of 3 · total +25% blade damage". */
  rank?: { n: number; of: number; text: string } | undefined;
  /** Extra authored context kept from skills.json `desc` when it adds facts the effects cannot express. */
  note?: string | undefined;
  /** Effects + rank + note joined, for aria / tooltips. */
  text: string;
}

const pct = (v: number): string => `${v >= 0 ? "+" : "-"}${Math.round(Math.abs(v) * 100)}%`;
const human = (k: string): string => k.replace(/_/g, " ");
const list = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Label per additive mod (what a +x% means in play). Every mod key in skills.json must be here (tested). */
export const SKILL_MOD_LABEL: Readonly<Record<string, string>> = {
  gather: "gathering yield", cropYield: "harvest yield of crops, fruit trees and berry bushes", carry: "carry weight",
  fuel: `burn time of fuel in fires you tend (within ${FIRE_TENDER_RADIUS} tiles)`, vfuel: "liters per fuel item when refueling vehicles",
  repair: "vehicle repair per kit", nutrition: "nutrition from food", heal: "healing from food and medicine",
  produce: "animal produce speed (eggs, milk, wool)", tame: "taming chance", xp: "XP from all activities", noise: "noise you make (how far zombies can hear you)",
};
const DMG_NAME: Readonly<Record<string, string>> = { unarmed: "unarmed", blade: "blade", blunt: "blunt", axe: "axe", spear: "spear", bow: "bow", crossbow: "crossbow", firearm: "firearm" };
const weapons = (cls: string): string => { const p = SKILLS.weaponClasses[cls]; return p?.length ? ` (${p.map(human).join(", ")})` : ""; };

/** Perk text from the constants the perk code uses. Every perk in skills.json must be here (tested). */
export const SKILL_PERK_TEXT: Readonly<Record<string, () => string>> = {
  iron_stomach: () => `Eat spoiled or rotten food without getting sick; each such meal costs ${IRON_STOMACH_HP} health`,
  breeding: () => `Two fed, tamed animals of the same kind at a feeding trough can breed (about every ${Math.round(SKILLS.husbandry.breedSeconds / 60)} min, up to ${SKILLS.husbandry.maxPerTrough} per trough)`,
};

interface RecipeRow { key: string; output?: { item: string }; skill?: { key: string; level: number } }
const RECIPES = (recipesRaw as unknown as { recipes: RecipeRow[] }).recipes;
const ITEM_NAME = new Map((itemsRaw as unknown as { items: { key: string; name: string }[] }).items.map((i) => [i.key, i.name]));
/** Recipe names gated at exactly `level` of skill `key` (recipes.json `skill`). */
export function recipesUnlockedAt(key: string, level: number): string[] {
  return RECIPES.filter((r) => r.skill?.key === key && r.skill.level === level).map((r) => ITEM_NAME.get(r.output?.item ?? r.key) ?? human(r.key));
}

/** ADR-221 unlock token -> player text ("Build the Campfire" / "Build and upgrade to the stone tier"). */
export function unlockText(token: string): string {
  const [kind, key = ""] = token.split(":");
  if (kind === "tier") return `Build and upgrade to the ${human(key)} tier`;
  if (kind === "mount") return "Tame and ride horses, donkeys, deer, elk, moose, buffalo and yaks"; // ADR-319
  if (kind === "item") return `Craft and repair the ${key.startsWith("saddle_") ? `${cap(human(key.slice(7)))} Saddle` : cap(human(key))}`; // ADR-320 (saddles)
  const name = cap(human(key)); const station = STATION_PIECES.has(key);
  return station ? `Build the ${name} (and craft its recipes)` : `Build the ${name}`;
}
const STATION_PIECES = new Set(["campfire", "workbench", "furnace", "anvil", "garage"]);
export const unlockLines = (tokens: readonly string[]): string[] => tokens.map(unlockText);
/** Effect lines for a mod map; dmg_* mods with the same value merge ("+20% blade, blunt and axe damage"). */
export function modLines(mods: Partial<Record<string, number>>, compact = false): string[] {
  const out: string[] = []; const dmg = new Map<number, string[]>();
  for (const [k, v] of Object.entries(mods)) {
    if (v === undefined || v === 0) continue;
    if (k.startsWith("dmg_")) { const l = dmg.get(v) ?? []; l.push(k.slice(4)); dmg.set(v, l); continue; }
    if (k === "share") { out.push(compact ? `${Math.round(v * 100)}% XP shared with party/clan` : `Party and clan members within ${XP_SHARE_RADIUS} tiles also get ${Math.round(v * 100)}% of the XP you earn`); continue; }
    out.push(`${pct(v)} ${SKILL_MOD_LABEL[k] ?? human(k)}`);
  }
  for (const [v, cls] of dmg) out.unshift(`${pct(v)} ${list(cls.map((c) => DMG_NAME[c] ?? human(c)))} damage${cls.length === 1 && !compact ? weapons(cls[0]!) : ""}`);
  return out;
}

const signature = (n: SkillNodeDef): string => n.effects.unlock ? `unlock:${n.key}` : n.effects.skill ? `skill:${n.effects.skill.key}` : n.effects.perk ? `perk:${n.effects.perk}` : `mods:${Object.keys(n.effects.mods ?? {}).sort().join(",")}`;
/** Same-effect predecessor (rank chain) of node i, or -1. */
function chainPred(i: number): number {
  const n = SKILLS.nodes[i]!; const s = signature(n);
  for (const r of SKILL_REQS[i]!) { const p = SKILLS.nodes[r]!; if (!p.retired && p.branch === n.branch && signature(p) === s) return r; }
  return -1;
}
const PRED: readonly number[] = SKILLS.nodes.map((_, i) => chainPred(i));
const rankOf = (i: number): number => { let n = 1; for (let p = PRED[i]!; p >= 0; p = PRED[p]!) n++; return n; };
const rootOf = (i: number): number => { let r = i; while (PRED[r]! >= 0) r = PRED[r]!; return r; };
const CHAIN_LEN = new Map<number, number>(); SKILLS.nodes.forEach((_, i) => { const r = rootOf(i); CHAIN_LEN.set(r, Math.max(CHAIN_LEN.get(r) ?? 1, rankOf(i))); });

const cache = new Map<number, SkillDescription>();
/** Generated description of skill node `i` (see SkillDescription). */
export function skillDescription(i: number): SkillDescription {
  const hit = cache.get(i); if (hit) return hit;
  const n = SKILLS.nodes[i]; if (!n) return { effects: [], text: "" };
  const effects: string[] = []; let note: string | undefined;
  const sk = n.effects.skill;
  if (sk) {
    const name = cap(human(sk.key)); const got = recipesUnlockedAt(sk.key, sk.level);
    const maxLv = Math.max(sk.level, ...SKILLS.nodes.map((m) => m.effects.skill?.key === sk.key ? m.effects.skill.level : 0));
    effects.push(`${name} skill level ${sk.level}`);
    if (got.length) effects.push(`Unlocks recipes: ${got.slice(0, 5).join(", ")}${got.length > 5 ? ` and ${got.length - 5} more` : ""}`);
    else if (sk.level < maxLv) effects.push(`Needed for ${name} ${sk.level + 1}`);
    // keep authored context ("Tamed animals settle at your feeding troughs") unless it only repeats the numbers
    const extra = n.desc.replace(/^[A-Z][a-z]+ \d+[.:]?\s*/, "").trim().replace(/\.$/, "");
    if (extra && !/^[+-]\d/.test(extra) && (!got.length || extra.length > 30)) note = cap(extra);
  }
  if (n.effects.unlock?.length) effects.push(...unlockLines(n.effects.unlock)); // ADR-221
  if (n.effects.perk) { const f = SKILL_PERK_TEXT[n.effects.perk]; effects.push(f ? f() : n.desc.replace(/\.$/, "")); }
  effects.push(...modLines(n.effects.mods ?? {}));
  if (!effects.length && n.desc.trim()) effects.push(n.desc.replace(/\.$/, ""));
  let rank: SkillDescription["rank"];
  const of = CHAIN_LEN.get(rootOf(i)) ?? 1;
  if (of > 1) {
    const r = rankOf(i); let text = `Rank ${r} of ${of}`;
    if (r > 1 && n.effects.mods && Object.keys(n.effects.mods).length) { const tot: Record<string, number> = {}; for (let p = i; p >= 0; p = PRED[p]!) for (const [k, v] of Object.entries(SKILLS.nodes[p]!.effects.mods ?? {})) tot[k] = (tot[k] ?? 0) + (v ?? 0); text += ` · total with earlier ranks: ${modLines(tot, true).join(", ")}`; }
    rank = { n: r, of, text };
  }
  const text = [...effects, ...(rank ? [rank.text] : []), ...(note ? [note] : [])].join(". ") + ".";
  const d: SkillDescription = { effects, rank, note, text }; cache.set(i, d); return d;
}
