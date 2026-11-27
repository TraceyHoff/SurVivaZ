// ADR-582: Creative start. A human player starting in a Creative world (ADR-580/581) begins at
// max character level with every skill tree at max level and enough points in each tree to learn
// ALL of its skills — proven end-to-end by actually unlocking every node. AI humans get no grant,
// a survival world is unchanged, a character with any progress keeps it (no top-ups), and the
// grant fires once (spending points afterwards is not undone by re-running the system).
import { describe, expect, it } from "vitest";
import { PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

function player(w: World, pid = 1): Entity {
  const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  w.add(p, PlayerId, { id: pid });
  return p;
}
const prog = (w: World, e: Entity) => w.get(e, G.Progression)!;

describe("ADR-582 creative start", () => {
  it("a fresh human player in a Creative world starts maxed and can learn every skill", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const p = player(w);
    G.creativeStartSystem(w);
    expect(prog(w, p).level).toBe(G.SKILLS.levels.maxLevel);
    const trees = G.treesOf(w, p)!;
    expect(trees.length).toBe(G.TREE_KEYS.length);
    for (let i = 0; i < trees.length; i++) {
      expect(trees[i]!.level, `tree ${G.TREE_KEYS[i]} level`).toBe(G.SKILLS.treeLevels.maxLevel);
      expect(trees[i]!.points, `tree ${G.TREE_KEYS[i]} points`).toBe(G.CREATIVE_TREE_POINTS[i]);
    }
    // The user's requirement, literally: learn the whole tree with the granted points.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let n = 0; n < G.SKILLS.nodes.length; n++) {
        if (G.SKILLS.nodes[n]!.retired || G.ownedNodes(w, p).includes(n)) continue;
        if (G.unlockSkill(w, p, n) === undefined) progressed = true;
      }
    }
    const learnable = G.SKILLS.nodes.filter((n) => !n.retired).length;
    expect(G.ownedNodes(w, p).length).toBe(learnable);
    // Points were exactly enough-or-more per tree: no tree went negative, none blocked on points.
    for (const t of G.treesOf(w, p)!) expect(t.points).toBeGreaterThanOrEqual(0);
  });

  it("survival world: a fresh player is untouched", () => {
    const w = makeWorld();
    const p = player(w);
    G.creativeStartSystem(w);
    expect(prog(w, p).level).toBe(1);
    for (const t of G.treesOf(w, p)!) { expect(t.level).toBe(1); expect(t.points).toBe(0); }
  });

  it("an AI human in a Creative world gets no grant", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const bot = player(w, 2);
    G.setAiHumanPredicate(w, (e) => e === bot);
    G.creativeStartSystem(w);
    expect(prog(w, bot).level).toBe(1);
    for (const t of G.treesOf(w, bot)!) { expect(t.level).toBe(1); expect(t.points).toBe(0); }
  });

  it("a character with progress keeps it (no top-up), and the grant never re-fires after spending", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const vet = player(w, 3);
    G.awardXpRaw(w, vet, "gather", 5000, false); // real progress before the system looks
    const before = { level: prog(w, vet).level, trees: G.treesOf(w, vet)!.map((t) => ({ ...t })) };
    G.creativeStartSystem(w);
    expect(prog(w, vet).level).toBe(before.level);
    expect(G.treesOf(w, vet)!.map((t) => ({ ...t }))).toEqual(before.trees);

    const p = player(w, 4);
    G.creativeStartSystem(w);
    const anyNode = G.SKILLS.nodes.findIndex((n, i) => !n.retired && (G.SKILL_REQS[i]?.length ?? 0) === 0);
    expect(anyNode).toBeGreaterThanOrEqual(0);
    expect(G.unlockSkill(w, p, anyNode)).toBe(undefined);
    const spent = G.treesOf(w, p)!.map((t) => t.points);
    G.creativeStartSystem(w); // must not refill
    expect(G.treesOf(w, p)!.map((t) => t.points)).toEqual(spent);
  });
});
