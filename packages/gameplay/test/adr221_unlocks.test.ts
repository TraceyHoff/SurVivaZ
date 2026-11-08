/**
 * ADR-221: crafting stations and building material tiers are learned in the skill trees. A fresh character starts with
 * the twig tier only; placement, upgrade, crafting and queueing are enforced on the authority; legacy characters keep
 * everything (free unlock grant, tver 2); respec keeps unlocks; AI learns its base-plan unlocks first.
 */
import { describe, expect, it } from "vitest";
import { type Entity, type World } from "@engine/core";
import xp from "../data/xp.json";
import * as G from "../src/index.js";
import { BuildFail, BuildPiece, CraftFail, PlayerIntent, defaultDefs, pieceCost, addItem, snapPlacement, spawnPlayer, tryPlace, type PieceDef } from "../src/index.js";
import { makeWorld, plantClaim, steps, spawnLearned } from "./helpers.js";
import { walk } from "./progression212.test.js";

const d = defaultDefs();
const node = (k: string): number => G.skillNodeIndex(k);
const tierKey = (t: number): string => d.tiers.find((x) => x.id === t)!.key;
const pieceKey = (p: PieceDef): string => (p as { key?: string }).key!;
function give(w: World, e: Entity, key: string, tier: number): void { for (const c of pieceCost(d, d.pieces.get(d.pieceId(key))!, tier)) addItem(w, e, c.item, c.count); }
const place = (w: World, e: Entity, key: string, x: number, tier: number, y = 0) => tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier, variant: 0 });
function fresh(): { w: World; p: Entity } { const w = makeWorld(); G.installCraftQueue(w); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1); plantClaim(w, p, 4, 4); return { w, p }; }
const learn = (w: World, p: Entity, key: string): void => { const n = node(key); G.grantTreePoints(w, p, G.TREE_KEYS[G.SKILL_NODE_TREE[n]!]!, G.skillNode(n)!.cost); expect(G.unlockSkill(w, p, n)).toBeUndefined(); };

describe("ADR-221 unlock data", () => {
  const stationPieces = [...d.pieces.values()].filter((p) => p.station);
  it("every station piece and every non-twig building tier has exactly one unlock node; twig and ordinary pieces are free", () => {
    expect(stationPieces.length).toBeGreaterThanOrEqual(9);
    for (const p of stationPieces) expect(G.UNLOCK_NODE.has(`piece:${pieceKey(p)}`), pieceKey(p)).toBe(true);
    for (const t of d.tiers) expect(G.UNLOCK_NODE.has(`tier:${t.key}`), t.key).toBe(t.id !== 0);
    expect(G.UNLOCK_NODE.has("piece:storage_box")).toBe(false);
    const tokens = G.SKILLS.nodes.flatMap((n) => n.effects.unlock ?? []); expect(new Set(tokens).size).toBe(tokens.length);
  });
  it("unlock nodes only require unlock nodes, chains are acyclic, and every tree they live in earns XP before any unlock", () => {
    const pre = new Set(["gather", "chop", "mine", "craft", "build", "walk"]); // bare hands, hand recipes, twig pieces
    const treesWithXp = new Set(Object.entries(xp.trees as Record<string, string>).filter(([s]) => pre.has(s)).map(([, t]) => t));
    for (let i = 0; i < G.SKILLS.nodes.length; i++) {
      if (!G.isUnlockNode(i)) continue; const n = G.SKILLS.nodes[i]!;
      for (const r of G.SKILL_REQS[i]!) expect(G.isUnlockNode(r), `${n.key} <- ${G.SKILLS.nodes[r]!.key}`).toBe(true);
      let depth = 0; for (let j = i; G.SKILL_REQS[j]!.length; j = G.SKILL_REQS[j]![0]!) expect(++depth).toBeLessThan(10);
      const cat = G.skillCategoryOf(i)!;
      // homestead (cooking stoves) earns XP by cooking at the campfire, which the survival tree unlocks
      expect(treesWithXp.has(cat) || (cat === "homestead" && G.skillCategoryOf(node("firecraft")) === "survival"), `${n.key} in ${cat}`).toBe(true);
    }
    expect(G.skillCategoryOf(node("firecraft"))).toBe("survival"); // never in cooking: cooking XP needs a fire (deadlock)
  });
  it("progression stays reachable: the ADR-212 walk still reaches every station with the unlock nodes in place", () => {
    const r = walk(d); for (const p of stationPieces) expect(r.stations.has(p.station), pieceKey(p)).toBe(true);
  });
  it("generated descriptions name the unlock", () => {
    expect(G.skillDescription(node("firecraft")).effects.join(" ")).toMatch(/Campfire/i);
    expect(G.skillDescription(node("stonework")).effects.join(" ")).toMatch(/stone tier/i);
  });
});

describe("ADR-221 server enforcement", () => {
  it("a fresh character builds twig only; stations and higher tiers fail with SkillLocked until learned", () => {
    const { w, p } = fresh();
    give(w, p, "foundation", 0); expect(place(w, p, "foundation", 2, 0)).toMatchObject({ ok: true });
    give(w, p, "foundation", 1); expect(place(w, p, "foundation", 0, 1, 3)).toEqual({ ok: false, reason: BuildFail.SkillLocked });
    give(w, p, "campfire", 1); expect(place(w, p, "campfire", -2, 1, 2)).toEqual({ ok: false, reason: BuildFail.SkillLocked });
    learn(w, p, "firecraft"); expect(place(w, p, "campfire", -2, 1, 2).ok).toBe(true);
    learn(w, p, "wood_framing"); expect(place(w, p, "foundation", 0, 1, 3).ok).toBe(true);
    give(w, p, "workbench", 1); expect(place(w, p, "workbench", -2, 1, -2)).toEqual({ ok: false, reason: BuildFail.SkillLocked });
    // the preview uses the same check
    const sn = snapPlacement(w, { piece: d.pieceId("furnace"), x: 16, y: 0, level: 0, rot: 0, tier: 2, variant: 0 });
    expect(typeof sn).toBe("object"); expect(G.validatePlacement(w, p, sn as G.Snapped, { ignoreCost: true })).toBe(BuildFail.SkillLocked);
  });
  it("upgrade needs the target tier unlock", () => {
    const { w, p } = fresh(); give(w, p, "foundation", 0); const r = place(w, p, "foundation", 0, 0); if (!r.ok) throw new Error("place");
    const fails: number[] = []; w.events.on(G.BuildFailed, (e: { reason: number }) => fails.push(e.reason));
    const up = (tier: number) => { give(w, p, "foundation", tier); w.set(p, PlayerIntent, { action: 11 /* Upgrade */, target: r.piece, tier }); steps(w, 1); };
    up(1); expect(w.getField(r.piece, BuildPiece, "tier")).toBe(0); expect(fails).toContain(BuildFail.SkillLocked);
    learn(w, p, "wood_framing"); up(1); expect(w.getField(r.piece, BuildPiece, "tier")).toBe(1);
    up(2); expect(w.getField(r.piece, BuildPiece, "tier")).toBe(1);
    learn(w, p, "stonework"); up(2); expect(w.getField(r.piece, BuildPiece, "tier")).toBe(2);
  });
  it("station recipes are refused (queue: skill_locked; timed craft: CraftFail.Locked) until the station is learned; hand recipes never", () => {
    const { w, p } = fresh();
    const bench = [...d.recipes.values()].find((r) => r.station === 2 && !r.skill)!; const hand = [...d.recipes.values()].find((r) => r.station === 0 && !r.skill)!;
    G.spawnStation(w, 2, 1, 0); for (const i of bench.ingredients) addItem(w, p, i.item, i.count * 2); for (const i of hand.ingredients) addItem(w, p, i.item, i.count);
    expect(G.craftQueueReason(w, p, bench.id, 1)).toBe("skill_locked");
    expect(G.craftQueueReason(w, p, hand.id, 1)).toBeUndefined();
    const fails: number[] = []; w.events.on(G.CraftFailed, (e: { reason: number }) => fails.push(e.reason));
    w.set(p, PlayerIntent, { action: G.IntentAction.Craft, recipe: bench.id }); steps(w, 1); expect(fails).toContain(CraftFail.Locked);
    learn(w, p, "workbench_craft"); expect(G.craftQueueReason(w, p, bench.id, 1)).toBeUndefined();
  });
  it("entities without Progression (NPC crafters, legacy tests) are never gated", () => {
    const { w, p } = fresh(); w.remove(p, G.Progression); give(w, p, "anvil", 3); expect(place(w, p, "anvil", 3, 3)).toMatchObject({ ok: true });
  });
});

describe("ADR-221 migration, respec, AI", () => {
  it("legacy rows (tver 1, or tver 0 with progress) learn every unlock free; fresh spawns learn none; tree points are not charged", () => {
    const w = makeWorld(); const fresh1 = spawnPlayer(w, { x: 0, y: 0 }); const old1 = spawnPlayer(w, { x: 2, y: 0 }); const old0 = spawnPlayer(w, { x: 4, y: 0 });
    w.set(old1, G.Progression, { tver: 1 }); G.grantTreePoints(w, old1, "crafting", 3);
    w.set(old0, G.Progression, { xp: 50, level: 3, points: 0, tver: 0 });
    steps(w, 1);
    const all = [...G.UNLOCK_NODE.values()];
    for (const e of [fresh1, old1, old0]) expect(w.getField(e, G.Progression, "tver")).toBe(G.PROGRESSION_TVER);
    expect(all.some((i) => G.hasNode(w, fresh1, i))).toBe(false);
    for (const e of [old1, old0]) for (const i of all) expect(G.hasNode(w, e, i)).toBe(true);
    expect(G.treePoints(w, old1, "crafting")).toBe(3);
    expect(G.treesOf(w, old0)!.every((t) => t.level === 1 && t.points === 0)).toBe(true);
    // placed pieces are never removed by the migration: a legacy player can still use them (and the fresh one can not build more)
    expect(G.hasSkillUnlock(w, old1, "piece:anvil")).toBe(true); expect(G.hasSkillUnlock(w, fresh1, "piece:anvil")).toBe(false);
  });
  it("respec keeps unlock nodes and refunds only the other nodes", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0 }); steps(w, 1);
    G.grantTreePoints(w, p, "survival", 1); G.unlockSkill(w, p, node("forager"));
    addItem(w, p, d.itemId(G.SKILLS.respec.item), 500);
    const before = G.treePoints(w, p, "survival"); expect(G.respecSkills(w, p)).toBeUndefined();
    expect(G.hasNode(w, p, node("firecraft"))).toBe(true); expect(G.hasNode(w, p, node("forager"))).toBe(false);
    expect(G.treePoints(w, p, "survival")).toBe(before + Math.floor(G.skillNode(node("forager"))!.cost * G.SKILLS.respec.refundFraction));
    expect(G.canRespec(w, p)).toBe("nothing"); // only unlocks left
  });
  it("AI with points learns its base-plan unlocks first (campfire, workbench, wood tier) and only then plans those pieces", () => {
    const w = makeWorld(); const a = spawnPlayer(w, { x: 0, y: 0 }); steps(w, 1);
    const t = { bravery: 1, industriousness: 1, sociability: 0, greed: 0, chattiness: 0 };
    G.grantTreePoints(w, a, "survival", 1); expect(G.pickSkillNode(w, a, t)).toBe(node("firecraft"));
    G.grantTreePoints(w, a, "crafting", 1); G.unlockSkill(w, a, node("firecraft")); expect(G.pickSkillNode(w, a, t)).toBe(node("workbench_craft"));
  });
});

describe("ADR-221 build menu view", () => {
  it("buildView marks locked pieces/tiers with the skill requirement; learning clears it", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0 }); const v0 = G.buildView({ world: w, player: p, names: G.playerNames(w) });
    const f = v0.find((x) => x.key === "foundation")!; const cf = v0.find((x) => x.key === "campfire")!; const box = v0.find((x) => x.key === "storage_box");
    expect(f.tiers[0]!.locked).toBe(false); expect(f.tiers[1]!.locked).toBe(true);
    expect(f.tiers[1]!.requirement).toMatch(/^Requires Wood Framing \(Crafting & Building\)$/);
    expect(cf.tiers[0]!.locked).toBe(true); expect(cf.tiers[0]!.requirement).toMatch(/Firecraft \(Survival/);
    if (box) expect(box.tiers.every((t) => !t.locked)).toBe(true);
    learn(w, p, "firecraft"); learn(w, p, "wood_framing");
    const v1 = G.buildView({ world: w, player: p, names: G.playerNames(w) });
    expect(v1.find((x) => x.key === "campfire")!.tiers[0]!.locked).toBe(false);
    expect(v1.find((x) => x.key === "foundation")!.tiers[1]!).toMatchObject({ locked: false }); expect(v1.find((x) => x.key === "foundation")!.tiers[2]!.locked).toBe(true);
  });
});
