/**
 * ADR-234: skill-tree audit. For EVERY node (135), build two otherwise identical players (same prerequisites owned), one
 * also owning the node, run the real server system the node's effect feeds, and assert the observed difference matches the
 * ADR-219 description value (mods are additive fractions summed over owned nodes: expected ratio (1+with)/(1+without)).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string): number => d.itemId(k);
const NODES = G.SKILLS.nodes;
const MODS = new Set(["gather", "cropYield", "carry", "fuel", "vfuel", "repair", "nutrition", "heal", "produce", "tame", "share", "xp", "noise"]);
const PERKS = new Set(["iron_stomach", "breeding"]);

const closure = (i: number, out = new Set<number>()): Set<number> => { for (const r of G.SKILL_REQS[i]!) if (!out.has(r)) { out.add(r); closure(r, out); } return out; };
/** Prerequisites first (skills.json order is append-only, so a prereq can come later in the file). */
const order = (s: Set<number>): number[] => { const out: number[] = []; const seen = new Set<number>(); const v = (i: number): void => { if (seen.has(i)) return; seen.add(i); for (const r of G.SKILL_REQS[i]!) v(r); out.push(i); }; for (const i of [...s].sort((a, b) => a - b)) v(i); return out; };
const total = (owned: Iterable<number>, mod: string): number => { let t = 0; for (const i of owned) t += NODES[i]!.effects.mods?.[mod] ?? 0; return t; };

let pid = 100;
function world(): World { const w = makeWorld(); installPermissions(w); return w; }
function player(w: World, x = 0, y = 0, maxWeight = 0): Entity {
  const p = G.spawnPlayer(w, { x, y, clientId: ++pid, maxWeight }); w.add(p, PlayerId, { id: pid }); w.add(p, NetId, { id: 90000 + pid }); return p;
}
function own(w: World, p: Entity, nodes: number[]): void {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  for (const n of nodes) { const why = G.unlockSkill(w, p, n); if (why) throw new Error(`unlock ${NODES[n]!.key}: ${why}`); }
}
/** Two worlds: [without node, with node]; `make` builds the scene and returns the measured value for the owner. */
function pair<T>(node: number, make: (w: World, p: Entity) => T): { owned: [Set<number>, Set<number>]; v: [T, T] } {
  const base = closure(node); const withN = new Set([...base, node]);
  const run = (s: Set<number>): T => { const w = world(); const p = player(w, 0, 0, 200); own(w, p, order(s)); return make(w, p); };
  return { owned: [base, withN], v: [run(base), run(withN)] };
}

// ---- measurements in the real systems ----------------------------------------------------------------------------------
const SWINGS = 2000;
/** Sum of the first yield over SWINGS single swings at fresh nodes (NetId k pairs the base roll across both worlds). */
function gatherTotal(w: World, p: Entity, kind: string, item: string): number {
  let sum = 0; const it = id(item);
  G.setIntent(w, p, { action: G.IntentAction.Gather, target: 0 });
  for (let k = 1; k <= SWINGS; k++) {
    const n = G.spawnResourceNode(w, kind, 1, 0); w.add(n, NetId, { id: 1_000_000 + k });
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: n });
    w.setField(p, G.Gatherer, "cooldownUntilTick", 0); w.setField(p, G.Survival, "stamina", 100);
    G.gatherSystem(w, 1 / 20); w.destroy(n);
    sum += G.countItem(w, p, it);
    G.removeItem(w, p, it, G.countItem(w, p, it));
  }
  return sum;
}
const carryCap = (w: World, p: Entity): number => G.addItem(w, p, id("stone"), 100000);
function eat(w: World, p: Entity, item: string, setup: () => void): void {
  G.addItem(w, p, id(item), 1); setup();
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); w.step(1 / 20); G.setIntent(w, p, { action: G.IntentAction.None });
}
function hungerGain(w: World, p: Entity): number { eat(w, p, "berries", () => w.setField(p, G.Survival, "hunger", 10)); return w.getField(p, G.Survival, "hunger")! - 10; }
function healGain(w: World, p: Entity, item = "bandage"): number {
  eat(w, p, item, () => { w.set(p, G.Health, { hp: 1, max: 1000 }); });
  return w.getField(p, G.Health, "hp")! - 1;
}
function fireBurnTicks(w: World): number {
  const b = G.spawnPlayer(w, { x: 40, y: 40 });
  const sn = G.snapPlacement(w, { piece: d.pieceId("campfire"), x: 3, y: 3, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${sn}`);
  const fire = G.attachmentsOf(w, G.placePiece(w, b, sn, { pay: false })).find((a) => w.has(a, G.Fuel))!;
  G.addItem(w, fire, id("wood"), 2); w.set(fire, G.Fuel, { lit: 1, burnUntilTick: 0 }); steps(w, 1);
  return w.getField(fire, G.Fuel, "burnUntilTick")! - w.tick;
}
function refuelLiters(w: World, p: Entity): number {
  const car = G.spawnVehicle(w, "car_sedan", 1, 0); w.add(car, NetId, { id: 7001 }); w.setField(car, G.Vehicle, "fuel", 0);
  G.addItem(w, p, id("gasoline"), 1); return G.refuelVehicle(w, p, car, slotOf(w, p, id("gasoline")), 1) as number;
}
function repairHp(w: World, p: Entity): number {
  const car = G.spawnVehicle(w, "car_sedan", 1, 0); w.add(car, NetId, { id: 7002 }); const max = G.vehicleDefOf(w, car)!.health;
  w.setField(car, G.Vehicle, "health", max * 0.05); G.addItem(w, p, id("repair_kit"), 1);
  return (G.repairVehicle(w, p, car, slotOf(w, p, id("repair_kit"))) as number) - max * 0.05;
}
const slotOf = (w: World, p: Entity, item: number): number => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
function noiseOf(w: World, p: Entity): number { G.makeNoise(w, p, 10); return w.getField(p, G.NoiseLevel, "value")!; }
function xpTotal(w: World, p: Entity): number { let s = 0; for (let i = 0; i < 500; i++) s += G.awardXp(w, p, "gather"); return s; }
/** Owner's XP credited vs a party mate's XP (share). */
function shareRun(w: World, p: Entity): { own: number; mate: number } {
  const m = player(w, 3, 0); const party = (e: Entity): void => { if (w.has(e, Membership)) w.set(e, Membership, { partyId: 9 }); else w.add(e, Membership, { partyId: 9, clanId: 0 }); };
  party(p); party(m); const before = totalXp(w, m); let own = 0; for (let i = 0; i < 400; i++) own += G.awardXp(w, p, "gather");
  return { own, mate: totalXp(w, m) - before };
}
function totalXp(w: World, e: Entity): number { const pr = w.get(e, G.Progression)!; let t = pr.xp; for (let l = 1; l < pr.level; l++) t += G.xpToNext(l); return t; }
function weaponOf(cls: string): string | undefined {
  if (cls === "unarmed") return undefined;
  return [...d.items.values()].map((i) => (i as { key: string }).key).find((k) => G.weaponClassOf(k) === cls && /(sword|knife|machete|axe|hatchet|club|mace|hammer|spear|bow|crossbow|pistol|rifle|shotgun|gun|smg)/.test(k));
}
function hitDamage(w: World, p: Entity, cls: string): number {
  const key = weaponOf(cls); if (cls !== "unarmed" && !key) throw new Error(`no weapon for class ${cls}`);
  if (key) { G.addItem(w, p, id(key), 1); w.setField(p, G.Equipment, "mainHandSlot", slotOf(w, p, id(key))); }
  const t = G.spawnPlayer(w, { x: 1, y: 0 }); w.set(t, G.Health, { hp: 1000, max: 1000 });
  G.applyDamage(w, t, 10, p); return 1000 - w.getField(t, G.Health, "hp")!;
}
function trough(w: World): Entity {
  const tr = w.create(); w.add(tr, Transform, { x: 2, y: 0 }).add(tr, G.BuildPiece, { type: d.pieceId(G.SKILLS.husbandry.trough) }).add(tr, G.Container, { slotCount: 8 }); G.indexEntity(w, tr); return tr;
}
function tamedChicken(w: World, p: Entity, over: Partial<{ produceAt: number; breedAt: number }>): Entity {
  const a = G.spawnAnimal(w, "animal_chicken", 2, 0); const kind = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind, owner: p, fedUntil: w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: over.breedAt ?? w.tick + 100000 }); return a;
}
/** Ticks until the next egg after one is produced (0 = no production at the trough). */
function produceInterval(w: World, p: Entity): number {
  trough(w); const a = tamedChicken(w, p, { produceAt: w.tick }); G.husbandrySystem(w);
  const next = w.get(a, G.Tamed)!.produceAt; return next > w.tick ? next - w.tick : 0;
}
function bred(w: World, p: Entity): number { trough(w); tamedChicken(w, p, { breedAt: 0 }); tamedChicken(w, p, { breedAt: 0 }); G.husbandrySystem(w); return [...w.query([G.Tamed])].length - 2; }
function rottenEat(w: World, p: Entity): { eaten: boolean; hp: number } {
  G.addItem(w, p, id("berries"), 2); w.getArray(p, G.Inventory, "createdTick")![0] = 0; steps(w, 5);
  w.setField(p, G.Inventory, "spoilMul", 100000); w.step(1 / 20);
  expect(G.itemInfo(w, p, 0)!.freshnessStage).toBe(3);
  w.set(p, G.Health, { hp: 50, max: 100 }); const ate = collect(w, G.ItemConsumed);
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); w.step(1 / 20);
  return { eaten: ate.length > 0, hp: w.getField(p, G.Health, "hp")! };
}

const near = (got: number, want: number, tol: number, what: string): void => { if (!Number.isFinite(got) || !Number.isFinite(want) || Math.abs(got - want) > tol) throw new Error(`${what}: got ${got.toFixed(4)}, want ${want.toFixed(4)} (+-${tol})`); };
const ratioOf = (owned: [Set<number>, Set<number>], mod: string, inverse = false): number => {
  const r = Math.max(0.1, 1 + total(owned[1], mod)) / Math.max(0.1, 1 + total(owned[0], mod)); return inverse ? 1 / r : r;
};

/** Every mod / perk / skill / unlock of node i, measured in its system. Returns the checks done (for the coverage test). */
function audit(i: number): string[] {
  const n = NODES[i]!; const e = n.effects; const done: string[] = [];
  for (const [mod, val] of Object.entries(e.mods ?? {})) {
    expect(val, `${n.key}.${mod} is non-zero`).not.toBe(0);
    if (mod === "gather") { const r = pair(i, (w, p) => gatherTotal(w, p, "tree", "wood")); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 0.025, `${n.key} gather`); }
    else if (mod === "cropYield") {
      for (const [kind, item] of [["crop_wheat", "wheat"], ["apple_tree", "apple"], ["blueberry_bush", "blueberry"]] as const) { const r = pair(i, (w, p) => gatherTotal(w, p, kind, item)); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 0.02, `${n.key} cropYield ${kind}`); }
    } else if (mod === "carry") { const r = pair(i, carryCap); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 0.012, `${n.key} carry`); }
    else if (mod === "fuel") { const r = pair(i, (w) => fireBurnTicks(w)); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 0.01, `${n.key} fuel`); }
    else if (mod === "vfuel") { const r = pair(i, refuelLiters); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} vfuel`); }
    else if (mod === "repair") { const r = pair(i, repairHp); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} repair`); }
    else if (mod === "nutrition") {
      const r = pair(i, hungerGain); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} nutrition`);
      if (!e.mods?.heal) { const h = pair(i, healGain); near(h.v[1], h.v[0], 1e-6, `${n.key} nutrition must not change healing`); }
    } else if (mod === "heal") {
      for (const item of ["bandage", "medkit"]) { const r = pair(i, (w, p) => healGain(w, p, item)); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} heal ${item}`); }
    } else if (mod === "noise") { const r = pair(i, noiseOf); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} noise`); }
    else if (mod === "xp") { const r = pair(i, xpTotal); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 0.004, `${n.key} xp`); }
    else if (mod === "share") {
      const r = pair(i, shareRun);
      for (const s of [0, 1] as const) near(r.v[s].mate, r.v[s].own * total(r.owned[s], "share"), 1, `${n.key} share (${s ? "with" : "without"})`);
      expect(r.v[1].mate).toBeGreaterThan(r.v[0].mate);
    } else if (mod === "tame") { const r = pair(i, (w, p) => G.livestockTameChance(w, p)); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-9, `${n.key} tame`); }
    else if (mod === "produce") { const r = pair(i, produceInterval); expect(r.v[0]).toBeGreaterThan(0); near(r.v[1] / r.v[0], ratioOf(r.owned, mod, true), 0.002, `${n.key} produce`); }
    else if (mod.startsWith("dmg_")) { const r = pair(i, (w, p) => hitDamage(w, p, mod.slice(4))); near(r.v[1] / r.v[0], ratioOf(r.owned, mod), 1e-4, `${n.key} ${mod}`); }
    else throw new Error(`${n.key}: unaudited mod ${mod}`);
    done.push(mod);
  }
  if (e.perk === "breeding") { const r = pair(i, bred); expect(r.v).toEqual([0, 1]); done.push("perk"); }
  else if (e.perk === "iron_stomach") {
    const r = pair(i, rottenEat); expect(r.v[0].eaten).toBe(false); expect(r.v[1].eaten).toBe(true); expect(r.v[1].hp).toBeLessThan(50); done.push("perk");
  } else if (e.perk) throw new Error(`${n.key}: unaudited perk ${e.perk}`);
  if (e.skill) {
    const { key, level } = e.skill;
    const r = pair(i, (w, p) => G.skillLevelOf(w, p, key)!); expect(r.v[1]).toBeGreaterThanOrEqual(level); expect(r.v[0]).toBeLessThan(level);
    const recipe = [...d.recipes.values()].find((x) => x.skill?.key === key && x.skill.level === level);
    if (recipe) { const m = pair(i, (w, p) => G.meetsSkill(w, p, recipe)); expect(m.v, `${n.key} gates ${recipe.id}`).toEqual([false, true]); }
    if (key === "husbandry" && level === 1) { const t = pair(i, (w, p) => { const a = G.spawnAnimal(w, "animal_chicken", 1, 0); G.addItem(w, p, id(G.SKILLS.husbandry.feed), 1); w.setField(p, G.Equipment, "mainHandSlot", 0); void a; return G.feedAnimal(w, p, true).fail; }); expect(t.v).toEqual([G.TameFail.NeedsSkill, G.TameFail.None]); }
    if (key === "husbandry" && level === 2) { const t = pair(i, produceInterval); expect(t.v[0]).toBe(0); expect(t.v[1]).toBeGreaterThan(0); }
    done.push("skill");
  }
  for (const tok of e.unlock ?? []) {
    const r = pair(i, (w, p) => G.hasSkillUnlock(w, p, tok)); expect(r.v, `${n.key} ${tok}`).toEqual([false, true]);
    const [kind, key] = tok.split(":") as [string, string];
    if (kind === "piece") {
      const pdef = d.pieces.get(d.pieceId(key))!; const pu = pair(i, (w, p) => G.pieceUnlocked(w, p, pdef, 0)); expect(pu.v).toEqual([false, true]);
      const st = [...Array(64).keys()].find((k) => G.stationToken(k as G.StationKind) === tok);
      if (st !== undefined) { const su = pair(i, (w, p) => G.stationUnlocked(w, p, st as G.StationKind)); expect(su.v, `${n.key} station gate`).toEqual([false, true]); }
    } else if (kind === "mount") { // ADR-319: Horsemanship gates taming a wild rideable animal
      const t = pair(i, (w, p) => { const a = G.spawnAnimal(w, "animal_elk", 1, 0); G.addItem(w, p, id("apple"), 1); return G.checkFeed(w, p, a, id("apple")); });
      expect(t.v, `${n.key} taming`).toEqual(["needs_skill", undefined]);
    } else if (kind === "item") { // ADR-320: Saddlery nodes gate the saddle recipe and its repair
      const recipe = [...d.recipes.values()].find((x) => x.output.item === id(key))!;
      expect(pair(i, (w, p) => G.recipeOutputUnlocked(w, p, recipe)).v, `${n.key} recipe`).toEqual([false, true]);
      expect(pair(i, (w, p) => G.itemRepairUnlocked(w, p, id(key))).v, `${n.key} repair`).toEqual([false, true]);
    } else {
      const tier = d.tiers.findIndex((t) => t.key === key); const wall = [...d.pieces.values()].find((p) => p.tiered)!;
      const pu = pair(i, (w, p) => G.pieceUnlocked(w, p, wall, tier)); expect(pu.v, `${n.key} tier ${key}`).toEqual([false, true]);
    }
    done.push("unlock");
  }
  return done;
}

describe("ADR-234 skill-tree audit: every node's effect is applied server-side at its described magnitude", () => {
  it("covers all nodes and only known effect kinds", () => {
    expect(NODES.length).toBe(140); // ADR-319 / ADR-320: + Horsemanship, Saddlery 1-4
    for (const n of NODES) {
      const e = n.effects; const kinds = [...Object.keys(e.mods ?? {}), ...(e.perk ? [e.perk] : []), ...(e.skill ? ["skill"] : []), ...(e.unlock ?? [])];
      expect(kinds.length, `${n.key} has an effect`).toBeGreaterThan(0);
      for (const m of Object.keys(e.mods ?? {})) expect(MODS.has(m) || m.startsWith("dmg_"), `${n.key}: ${m}`).toBe(true);
      if (e.perk) expect(PERKS.has(e.perk)).toBe(true);
      expect(n.desc.length).toBeGreaterThan(0);
    }
  });
  it.each(NODES.map((n, i) => [n.key, i] as const))("%s", (_key, i) => { expect(audit(i).length).toBeGreaterThan(0); }, 60000);
  it("nutrition never scales healing; poison (negative health food) is not scaled by nutrition", () => {
    const ni = G.skillNodeIndex(NODES.find((n) => n.effects.mods?.nutrition && !n.effects.mods.heal)!.key);
    const r = pair(ni, (w, p) => { eat(w, p, "raw_meat", () => w.set(p, G.Health, { hp: 50, max: 100 })); return w.getField(p, G.Health, "hp")!; });
    expect(r.v[1]).toBe(r.v[0]);
  });
});
