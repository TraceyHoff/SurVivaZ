// ADR-580: Creative mode is a world rule (new worlds only, default OFF — opt-in, unlike zombies).
// Human players in a Creative world craft and build without resource costs and take no vitals
// drain, exposure, injury or damage (the waivers live in adr581_creative_waivers.test.ts). Here:
// the rule itself — defaults, setWorldRules merging, and the isCreativePlayer identification
// (a PlayerId carrier that is not an AI human; bots in a Creative world get NO waiver).
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

describe("ADR-580 creative world rule", () => {
  it("defaults OFF and merges through setWorldRules without touching the other rules", () => {
    const w = makeWorld();
    expect(G.worldRules(w).creative).toBe(false);
    G.setWorldRules(w, { creative: true });
    expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 3, aiHumans: true, zombies: true, creative: true });
    G.setWorldRules(w, { hordeGraceDays: 5 });
    expect(G.worldRules(w).creative).toBe(true); // an unrelated re-set keeps it
    G.setWorldRules(w, { creative: false });
    expect(G.worldRules(w).creative).toBe(false);
    const born = makeWorld({ worldRules: { creative: true } });
    expect(G.worldRules(born).creative).toBe(true);
  });

  it("isCreativePlayer: human players only, creative worlds only", () => {
    const cw = makeWorld({ worldRules: { creative: true } });
    const human = player(cw, 1);
    const bot = player(cw, 2);
    G.setAiHumanPredicate(cw, (e) => e === bot); // the server registers this from its session table
    expect(G.isCreativePlayer(cw, human)).toBe(true);
    expect(G.isCreativePlayer(cw, bot)).toBe(false); // an AI human in a Creative world plays by survival rules

    const sw = makeWorld();
    const sp = player(sw, 1);
    expect(G.isCreativePlayer(sw, sp)).toBe(false); // survival world: nobody is creative

    const noId = G.spawnPlayer(cw, { x: 5, y: 5, maxWeight: 0 }); // no PlayerId: not a session player
    expect(G.isCreativePlayer(cw, noId)).toBe(false);
  });
});
