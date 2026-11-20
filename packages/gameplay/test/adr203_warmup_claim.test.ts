// ADR-203 gate fix (2026-11-20): a soaked bot holding campfire materials but with NO Claim
// Flag must not enter warm_up — the campfire it would build needs a claim covering the
// spot (ADR-310), so warmRun's build fails NeedClaim and the bot stands still retrying a
// doomed build (1,760 ticks in the adr203 scenario) instead of gathering for its totem.
// warmOption's campfire-materials clause therefore requires a claim covering the build
// spot; without one warm_up scores 0 and the bot keeps gathering / building its totem.
import { describe, expect, it } from "vitest";
import { installPermissions, scoreBehavior, type AgentContext, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);

function soakedCtx(w: World, p: Entity, x: number, y: number) {
  installPermissions(w); steps(w, 1);
  G.addItem(w, p, iid("wood"), 7);
  G.addItem(w, p, iid("stone"), 10);
  w.set(p, G.Exposure, { wetness: 1.0, feltTemp: 20 });
  w.set(p, G.Survival, { bodyTemp: 37 });
  const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
  G.bindAgentWorld(a, w);
  const v = G.buildAgentView(w, p, a, { x, y })!;
  const ctx = { self: v.self, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a, world: v.world } as AgentContext<never>;
  return ctx;
}
const warmUp = () => G.baseBehaviors().find((b) => b.name === "warm_up")!;
const inputOf = (name: string, c: AgentContext<never>) =>
  warmUp().considerations.find((x) => x.name === name)!.input(c as never);

describe("ADR-203 gate fix: warm_up needs a claim for its campfire materials", () => {
  it("a soaked bot with campfire materials but no claim scores warm_up 0 (canWarm 0)", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 20, y: 20, maxWeight: 0, clientId: 1 });
    const c = soakedCtx(w, p, 20, 20);
    expect(inputOf("chilled", c)).toBe(1); // the bot IS chilled (soaked) — the fix is about canWarm
    expect(inputOf("canWarm", c)).toBe(0); // no claim: the campfire cannot be built
    expect(scoreBehavior(warmUp(), c, undefined, [])).toBe(0);
  });
  it("the same bot scores warm_up once its Claim Flag covers the build spot", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 20, y: 20, maxWeight: 0, clientId: 1 });
    plantClaim(w, p, 20, 20);
    const c = soakedCtx(w, p, 20, 20);
    expect(inputOf("chilled", c)).toBe(1);
    expect(inputOf("canWarm", c)).toBe(1); // claim covers the campfire spot: a real warm option
    expect(scoreBehavior(warmUp(), c, undefined, [])).toBeGreaterThan(0);
  });
});
