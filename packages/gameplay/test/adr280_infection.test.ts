import { describe, expect, it } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

describe("ADR-280 progressive wound infection", () => {
  it.each([false,true])("Infected → Festering → Septic, HP damage only at tier three (AI human %s)", ai => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});if(ai)G.setAiHumanPredicate(w,e=>e===p);
    expect(G.contractDisease(w,p,"wound_infection")).toBe(true);
    for(const [seconds,tier] of [[0,"infected"],[179.95,"infected"],[180,"festering"],[359.95,"festering"],[360,"septic"]] as const){
      w.tick=Math.round(seconds*20);w.set(p,G.Health,{hp:100});expect(G.infectionTier(w,p)).toBe(tier);
      G.diseaseSystem(w,0.05);expect(w.getField(p,G.Health,"hp")).toBeCloseTo(tier==="septic"?99.96:100,4);
    }
    expect(w.getField(p,G.VitalsState,"lastDamageCause")).toBe(G.DamageCause.Disease);
  });
  it.each([10,20,30])("starts at tier one and progresses in seconds at %sHz", hz => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});G.contractDisease(w,p,"wound_infection",1/hz);
    expect(G.infectionTier(w,p)).toBe("infected");w.tick=180*hz;expect(G.infectionTier(w,p)).toBe("festering");
    w.tick=360*hz;expect(G.infectionTier(w,p)).toBe("septic");G.treatWoundInfection(w,p);expect(G.infectionTier(w,p)).toBe("festering");
  });
  it("a fresh wound and a brief wait cannot jump to a damaging tier; another bite cannot reset progression", () => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});G.contractDisease(w,p,"wound_infection");
    w.tick=60*20;G.diseaseSystem(w,.05);expect(G.infectionTier(w,p)).toBe("infected");expect(w.getField(p,G.Health,"hp")).toBe(100);
    w.tick=200*20;G.contractDisease(w,p,"wound_infection");expect(G.infectionTier(w,p)).toBe("festering");
    w.tick=360*20;expect(G.infectionTier(w,p)).toBe("septic");
  });
  it("plain bandages rewind 60s of infection and medicated bandages cure the whole track", () => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});const defs=G.gameplayDefs(w);G.contractDisease(w,p,"wound_infection");w.tick=380*20;
    G.addItem(w,p,defs.itemId("bandage"),1);G.setIntent(w,p,{action:G.IntentAction.Use,slot:0});G.consumeSystem(w);
    expect(G.infectionTier(w,p)).toBe("festering");w.tick+=60*20;expect(G.infectionTier(w,p)).toBe("septic");
    G.addItem(w,p,defs.itemId("medicated_bandage"),1);G.consumeSystem(w);
    expect(G.infectionTier(w,p)).toBeUndefined();expect(G.hasDisease(w,p,"wound_infection")).toBe(false);
  });
  it("infection timing survives component copying and expires through the existing 900s clock", () => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});G.contractDisease(w,p,"wound_infection");w.tick=360*20;
    const copy=G.spawnPlayer(w,{x:10,y:0});w.add(copy,G.Diseases,w.get(p,G.Diseases)!);expect(G.infectionTier(w,copy)).toBe("septic");
    w.tick=900*20;G.diseaseSystem(w,.05);expect(G.infectionTier(w,p)).toBeUndefined();expect(G.infectionTier(w,copy)).toBeUndefined();
  });
  it("zombies do not contract this human infection track", () => {
    const w=makeWorld(),z=G.spawnZombie(w,"zombie_walker",0,0);expect(G.contractDisease(w,z,"wound_infection")).toBe(false);
    expect(G.infectionTier(w,z)).toBeUndefined();
  });
  it("wound cure identity remains stable, and art uses dedicated atlas status keys", () => {
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0}),defs=G.gameplayDefs(w);G.contractDisease(w,p,"wound_infection");
    for(const [seconds,tier] of [[0,"infected"],[180,"festering"],[360,"septic"]] as const){w.tick=seconds*20;expect(G.diseasePresentation(w,p,defs.diseases[defs.diseaseIndex("wound_infection")]!)).toMatchObject({short:tier[0]!.toUpperCase()+tier.slice(1),icon:tier});}
    expect(defs.items.get(defs.itemId("medicated_bandage"))!.cures).toContain("wound_infection");expect(G.diseaseIcon("wound_infection")).toBe("infected");
  });
});
