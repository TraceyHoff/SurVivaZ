import { afterEach, describe, expect, it, vi } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";
const setup=(drop=5,role:"server"|"client"="server")=>{
  const w=makeWorld({role});w.setResource(G.TerrainRes,{tileAt:()=>3,heightAt:x=>x>=1?-drop:0});const p=G.spawnPlayer(w,{x:.9,y:.5});return{w,p};
};
function forceSuccess(w:ReturnType<typeof makeWorld>){
  const original=w.rngFor.bind(w);return vi.spyOn(w,"rngFor").mockImplementation((key,...rest)=>{const r=original(key,...rest);if(key==="disease.fall_wound")vi.spyOn(r,"next").mockReturnValue(0);return r;});
}
afterEach(()=>vi.restoreAllMocks());
describe("ADR-281 fracture fall infection risk",()=>{
  it("uses 2.5% wound chance: most of 400 seeded Broken Leg falls do not infect",()=>{
    const {w,p}=setup();expect(G.gameplayDefs(w).diseaseTuning.causes.woundChance).toBe(.025);let infected=0;
    for(let n=0;n<400;n++){const e=n===0?p:G.spawnPlayer(w,{x:.9,y:.5});G.applyTerrainFall(w,e,.9,.5,1.1,.5);expect(G.hasDisease(w,e,"broken_leg")).toBe(true);if(G.hasDisease(w,e,"wound_infection"))infected++;}
    expect(infected).toBeGreaterThan(0);expect(infected).toBeLessThan(40);
  });
  it.each([false,true])("a successful survivor roll starts at harmless Infected (AI human %s)",ai=>{
    const {w,p}=setup();if(ai)G.setAiHumanPredicate(w,e=>e===p);forceSuccess(w);G.applyTerrainFall(w,p,.9,.5,1.1,.5);
    expect(G.infectionTier(w,p)).toBe("infected");const afterFall=w.getField(p,G.Health,"hp")!;expect(afterFall).toBe(100-G.terrainFallDamage(5));
    G.diseaseSystem(w,.05);expect(w.getField(p,G.Health,"hp")).toBe(afterFall);
  });
  it("a successful 10Hz fall also starts at tier one, never septic",()=>{
    const {w,p}=setup();forceSuccess(w);G.applyTerrainFall(w,p,.9,.5,1.1,.5,.1);expect(G.infectionTier(w,p)).toBe("infected");
  });
  it.each([0,3,4,15])("a %s-tile non-fracture fall does not consume the infection RNG",drop=>{
    const {w,p}=setup(drop),roll=forceSuccess(w);G.applyTerrainFall(w,p,.9,.5,1.1,.5);
    expect(G.hasDisease(w,p,"broken_leg")).toBe(false);expect(G.infectionTier(w,p)).toBeUndefined();expect(roll.mock.calls.some(c=>c[0]==="disease.fall_wound")).toBe(false);
  });
  it("a lethal five-tile fall, client prediction, ladders and a generic broken-leg source never roll",()=>{
    for(const mode of ["lethal","client","ladder","generic"] as const){
      const {w,p}=setup(5,mode==="client"?"client":"server"),roll=forceSuccess(w);
      if(mode==="lethal")w.setField(p,G.Health,"hp",9);
      if(mode==="ladder"){const d=G.gameplayDefs(w);G.grantSkillUnlocks(w,p);const sn=G.snapPlacement(w,{piece:d.pieceId("ladder"),x:1,y:.5,rot:1,level:0,tier:0,variant:0});expect(typeof sn).toBe("object");if(typeof sn!=="number")G.placePiece(w,p,sn,{pay:false});}
      if(mode==="generic")G.contractDisease(w,p,"broken_leg");else G.applyTerrainFall(w,p,.9,.5,1.1,.5);
      expect(G.infectionTier(w,p)).toBeUndefined();expect(roll.mock.calls.some(c=>c[0]==="disease.fall_wound")).toBe(false);
    }
  });
  it("a successful roll cannot stack infection or reset existing progression",()=>{
    const {w,p}=setup();G.contractDisease(w,p,"wound_infection");w.tick=200*20;forceSuccess(w);G.applyTerrainFall(w,p,.9,.5,1.1,.5);
    expect(G.infectionTier(w,p)).toBe("festering");expect(G.activeDiseases(w,p).filter(d=>d.key==="wound_infection")).toHaveLength(1);
  });
});
