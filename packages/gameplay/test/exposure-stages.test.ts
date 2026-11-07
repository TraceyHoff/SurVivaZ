import { describe, expect, it } from "vitest";
import { Weather } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

describe("ADR-277 temperature tiers", () => {
  it.each([[37, undefined], [36.5, "chilly"], [36, "cold"], [35, "freezing"], [37.5, "hot"], [38, "sweltering"], [39, "overheating"]] as const)("body %s is %s", (body, tier) => {
    expect(G.temperatureTier(body)).toBe(tier);
  });
  it.each([false, true])("last tier only deals exactly one damage rate (AI human %s)", (ai) => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    if (ai) G.setAiHumanPredicate(w, e => e === p);
    for (const body of [36.4, 35.5, 34.9, 37.6, 38.5, 39.1]) {
      w.set(p, G.Survival, { bodyTemp: body }); w.set(p, G.Exposure, { feltTemp: 20 }); w.set(p, G.Health, { hp: 100 });
      G.vitalsSystem(w, 0.05);
      const dangerous = G.damagingTemperatureTier(G.temperatureTier(body));
      expect(w.getField(p, G.Health, "hp")).toBeCloseTo(dangerous ? 99.9 : 100, 4);
    }
  });
  it("progresses and recovers in order on both sides", () => {
    for (const [felt, expected] of [[-2, ["chilly", "cold", "freezing"]], [42, ["hot", "sweltering", "overheating"]]] as const) {
      const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 }); w.set(p, G.Exposure, { feltTemp: felt });
      const seen: string[] = [];
      for (let n = 0; n < 210; n++) { G.vitalsSystem(w, 0.1); const t = G.temperatureTier(w.getField(p, G.Survival, "bodyTemp")!); if (t && seen.at(-1) !== t) seen.push(t); }
      expect(seen).toEqual(expected);
      w.set(p, G.Exposure, { feltTemp: 20 });
      for (let n = 0; n < 500; n++) G.vitalsSystem(w, 0.1);
      expect(G.temperatureTier(w.getField(p, G.Survival, "bodyTemp")!)).toBeUndefined();
    }
  });
  it("air extremes alone cannot damage non-survival creatures", () => {
    const w = makeWorld(); const zombie = G.spawnZombie(w, "zombie_walker", 0, 0); const hp = w.getField(zombie, G.Health, "hp");
    w.add(zombie, G.Exposure, { feltTemp: 50 }); Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1 });
    G.exposureSystem(w, 1); G.vitalsSystem(w, 1); expect(w.getField(zombie, G.Health, "hp")).toBe(hp);
  });
  it("keeps cold/heat disease symptoms but removes overlapping HP drains", () => {
    const defs = G.defaultDefs();
    for (const key of ["common_cold", "heatstroke"]) { const disease = defs.diseases.find(d => d.key === key)!; expect(disease.hpDps).toBe(0); expect(disease.staminaDrainPerSec).toBeGreaterThan(0); }
  });
});

describe("ADR-278 staged wetness", () => {
  it.each([[0, undefined], [0.1, "damp"], [0.3, "damp"], [0.31, "wet"], [0.7, "wet"], [0.71, "soaked"], [1, "soaked"]] as const)("classifies %s as %s", (wet, stage) => expect(G.wetnessStage(wet)).toBe(stage));
  it("full-stage dry times are 15, 55 and 115 seconds; heat triples speed", () => {
    for (const [wet, seconds] of [[0.3, 15], [0.7, 55], [1, 115]]) {
      expect(G.wetDrySeconds(wet!, 0.02)).toBeCloseTo(seconds!, 6);
      expect(G.dryWetness(wet!, seconds!, 0.02)).toBe(0);
      expect(G.dryWetness(wet!, seconds! - 0.1, 0.02)).toBeGreaterThan(0);
      expect(G.wetDrySeconds(wet!, 0.06)).toBeCloseTo(seconds! / 3, 6);
    }
  });
  it("crosses boundaries exactly regardless of tick size", () => {
    let wet = 1; for (let n = 0; n < 1000; n++) wet = G.dryWetness(wet, 0.1, 0.02);
    expect(wet).toBeCloseTo(G.dryWetness(1, 100, 0.02), 6);
    expect(G.wetnessStage(wet)).toBe("damp");
  });
  it("rain escalates through every stage for players and AI humans", () => {
    for (const ai of [false, true]) {
      const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 }); if (ai) G.setAiHumanPredicate(w, e => e === p);
      Object.assign(w.env(Weather), { kind: G.WeatherKind.Rain, intensity: 1 });
      const seen: string[] = [];
      for (let n = 0; n < 60; n++) { G.exposureSystem(w, 1); const stage = G.wetnessStage(w.getField(p, G.Exposure, "wetness")!); if (stage && seen.at(-1) !== stage) seen.push(stage); }
      expect(seen).toEqual(["damp", "wet", "soaked"]);
    }
  });
});

describe("ADR-278 wetness worsens illness, never directly damages HP", () => {
  it.each([false, true])("Soaked alone cannot reduce health (AI human %s)", ai => {
    const w = makeWorld(), p = G.spawnPlayer(w, { x:0,y:0 }); if (ai) G.setAiHumanPredicate(w,e=>e===p);
    w.set(p,G.Exposure,{wetness:1,feltTemp:20});
    for(let n=0;n<120;n++){ G.vitalsSystem(w,1); G.diseaseSystem(w,1); w.tick++; }
    expect(w.getField(p,G.Health,"hp")).toBe(100); expect(G.activeDiseases(w,p)).toHaveLength(0);
  });
  it.each([false, true])("a short soaked cold spell cannot cause cold or flu (AI human %s)", ai => {
    const w = makeWorld(), p = G.spawnPlayer(w, { x:0,y:0 }); if (ai) G.setAiHumanPredicate(w,e=>e===p);
    w.set(p,G.Exposure,{wetness:1});w.set(p,G.Survival,{bodyTemp:34.5});
    for(let n=0;n<60*20;n++){G.diseaseSystem(w,0.05);w.tick++;}
    expect(G.hasDisease(w,p,"common_cold")).toBe(false);expect(G.hasDisease(w,p,"influenza")).toBe(false);
    expect(w.getField(p,G.Health,"hp")).toBe(100); // illness-only; final cold-tier HP damage is tested separately
  });
  it.each([false, true])("cold contraction takes dry 360s / Damp 342s / Wet 324s / Soaked 306s (AI human %s)", ai => {
    for(const [wet,seconds] of [[0,360],[.2,342],[.5,324],[1,306]] as const){
      const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0}); if(ai)G.setAiHumanPredicate(w,e=>e===p);
      w.set(p,G.Exposure,{wetness:wet});w.set(p,G.Survival,{bodyTemp:34.5,hunger:50});
      G.ensureDiseases(w,p); w.setField(p,G.Diseases,"coldTicks",seconds!*20-2); G.diseaseSystem(w,0.05);
      expect(G.hasDisease(w,p,"common_cold")).toBe(false);G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"common_cold")).toBe(true);
      expect(w.getField(p,G.Health,"hp")).toBe(100); // no vitals/temp channel in this illness-only test
    }
  });
  it.each([false, true])("wetness alone also requires several continuous minutes (AI human %s)", ai => {
    for(const [wet,seconds] of [[.2,342],[.5,324],[1,306]] as const){
      const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});if(ai)G.setAiHumanPredicate(w,e=>e===p);
      w.set(p,G.Exposure,{wetness:wet});G.ensureDiseases(w,p);w.setField(p,G.Diseases,"coldTicks",seconds*20-2);
      G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"common_cold")).toBe(false);G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"common_cold")).toBe(true);
      expect(w.getField(p,G.Health,"hp")).toBe(100);
    }
    const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});G.ensureDiseases(w,p);w.setField(p,G.Diseases,"coldTicks",360*20-1);
    G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"common_cold")).toBe(false);expect(w.getField(p,G.Diseases,"coldTicks")).toBe(0);
  });
  it.each([false, true])("untreated cold becomes flu faster when wetter (AI human %s)", ai => {
    for(const [wet,seconds] of [[0,300],[.2,285],[.5,270],[1,255]] as const){
      const w=makeWorld(),p=G.spawnPlayer(w,{x:0,y:0});if(ai)G.setAiHumanPredicate(w,e=>e===p);
      w.set(p,G.Exposure,{wetness:wet});w.set(p,G.Survival,{bodyTemp:37,hunger:50});G.contractDisease(w,p,"common_cold");
      w.tick=seconds!*20-1;G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"influenza")).toBe(false);
      w.tick++;G.diseaseSystem(w,0.05);expect(G.hasDisease(w,p,"influenza")).toBe(true);
      expect(w.getField(p,G.Health,"hp")).toBe(100); // progression itself has no HP hit
    }
  });
});
