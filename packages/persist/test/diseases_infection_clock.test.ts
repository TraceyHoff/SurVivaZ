import { describe, expect, it } from "vitest";
import { defineComponent, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { decodePlayerInto, encodePlayer } from "../src/index.js";
import { oldSchemaOf } from "../src/migrate.js";

describe("ADR-280 infection clock persistence",()=>{
  it.each([false,true])("legacy Diseases before infectionHz (also before careTicks=%s) retains disease and clock",beforeCare=>{
    const missing=beforeCare?["careTicks","infectionHz"]:["infectionHz"];
    const Old=defineComponent("Diseases",oldSchemaOf(G.Diseases.schema,missing),{networked:true,persistent:true});
    const a=new World();a.register(Old);const p=a.create(),defs=G.defaultDefs(),slot=defs.diseaseIndex("wound_infection")+1;
    a.add(p,Old,{disease:[slot,0,0,0,0,0,0,0],untilTick:[18000,0,0,0,0,0,0,0],...(beforeCare?{}:{careTicks:25})} as never);
    const bytes=encodePlayer(a,p),b=new World();G.installGameplay(b,{});const q=G.spawnPlayer(b,{x:0,y:0});
    const decoded=decodePlayerInto(b,q,bytes);expect(decoded.migrated).toContain("Diseases");expect(G.hasDisease(b,q,"wound_infection")).toBe(true);
    expect(b.getField(q,G.Diseases,"careTicks")).toBe(beforeCare?0:25);expect(G.infectionTier(b,q)).toBe("infected");
    b.tick=180*20;expect(G.infectionTier(b,q)).toBe("festering");b.tick=360*20;expect(G.infectionTier(b,q)).toBe("septic");
  });
  it("a 10Hz infection keeps its stage and rate through the real player codec",()=>{
    const a=new World();G.installGameplay(a,{});const p=G.spawnPlayer(a,{x:0,y:0});G.contractDisease(a,p,"wound_infection",.1);a.tick=200*10;
    const bytes=encodePlayer(a,p),b=new World();G.installGameplay(b,{});const q=G.spawnPlayer(b,{x:0,y:0});b.tick=a.tick;decodePlayerInto(b,q,bytes);
    expect(b.getField(q,G.Diseases,"infectionHz")).toBe(10);expect(G.infectionTier(b,q)).toBe("festering");
    b.tick=360*10;expect(G.infectionTier(b,q)).toBe("septic");
  });
});
