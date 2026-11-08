import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, Membership, Transform, type Entity } from "@engine/core";
import { TileMap, WATER_TILE } from "@engine/world";
import * as G from "../src/index.js";
import { nextTerrainWork, planTerrainBase } from "../src/ai/terrain_base.js";
import { aiMemoryOf, makePlan, scanBase } from "../src/ai/planner.js";
import { fillHireSensors } from "../src/ai/hire_behaviors.js";
import { fillGoalSensors } from "../src/ai/autonomy.js";
import { baseBehaviors, fillPlanSensors, goTo, lowFire } from "../src/ai/base_behaviors.js";
import { walkerWaypoint } from "../src/systems/creature_nav.js";
import { type AgentWorldView } from "../src/agents.js";
import { makeWorld, ensureClaim } from "./helpers.js";

function setup() {
  const w = makeWorld(), map = new TileMap();
  for (let y = -10; y < 20; y++) for (let x = -10; x < 20; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = G.spawnPlayer(w, { x: .5, y: 2.5, maxWeight: 0 }); w.add(p, G.Worker, {} as never);
  G.grantSkillUnlocks(w,p);
  const d = G.gameplayDefs(w); G.addItem(w, p, d.itemId("stone_shovel"), 1);
  for (const k of ["wood", "sticks", "stone", "fiber"]) G.addItem(w, p, d.itemId(k), 50);
  ensureClaim(w, p, 6, -4);
  return { w, map, p, d };
}
const req = (d: G.GameDefs, x = .5, y = 2) => ({ piece: d.pieceId("ladder"), x, y, level: 0, rot: 0, tier: 0, variant: 0 });

describe("ADR-265 full-height face-mounted ladders", () => {
  it("places on a pit face with no deck/socket; players and pathfinders traverse in both directions, any depth", () => {
    const { w, p, d } = setup();
    for (const [x,y] of [[0,0],[1,0],[0,1],[1,1]]) G.setTerrainDig(w, x!, y!, -25);
    expect(G.movementBlocked(w, .5, 1.5, .5, 2.5, 0)).toBe(true); // uphill needs a ladder; downhill now falls
    const r = G.tryPlace(w, p, req(d)); expect(r.ok).toBe(true);
    expect(G.structures(w).ladder(0, 2, G.EdgeSide.North)).toBe(r.ok ? r.piece : 0);
    expect(G.movementBlocked(w, .5, 2.5, .5, 1.5, 0)).toBe(false);
    expect(G.movementBlocked(w, .5, 1.5, .5, 2.5, 0)).toBe(false);
    expect(G.bodyAxisMove(w, .5, 2.05, 1.95, 1, 0, false)).toBe(1.95);
    expect(G.findPath(w, 0, 2, 1, 0, () => 9999)?.tiles.at(-1)).toEqual([1,0]);
    expect(G.findPath(w, 1, 0, 0, 2, () => 9999)?.tiles.at(-1)).toEqual([0,2]);
    expect(G.candidateStability(w, G.snapPlacement(w, req(d)) as G.Snapped)).toBeGreaterThan(0);
    G.structures(w).removePiece(r.ok ? r.piece : 0 as Entity);
    expect(G.movementBlocked(w, .5, 1.5, .5, 2.5, 0)).toBe(true);
  });
  it.each([[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]])("base-navigation direction %s,%s round-trips through player isometric input without rotating the ladder approach",(x,y)=>{
    const {w,p}=setup();installPermissions(w);const a=G.makeAgent(G.makeAgentIdentity(1,1),1),v=G.buildAgentView(w,p,a,{x:0,y:0})!;
    const c={...v,world:{...v.world,base:{x:0,y:0}},bb:a.bb,memory:a.memory,traits:a.identity.traits,rng:a.rng,agent:a},out=idleOutput();
    goTo(c,out,v.self.x+x,v.self.y+y);const f=G.agentOutputFrame(out,0,G.registerGameplayCommands()),d=Math.hypot(x,y);
    const digital=G.moveVector(f.actions),analog=G.moveVector(f.actions,{x:f.moveX,y:f.moveY});
    expect(digital.dx).toBeCloseTo(x/d);expect(digital.dy).toBeCloseTo(y/d);expect(analog.dx).toBeCloseTo(x/d);expect(analog.dy).toBeCloseTo(y/d);
    expect(f.aimX).toBeCloseTo(x/d);expect(f.aimY).toBeCloseTo(y/d);
  });
  it("AI human input follows the ladder route out of and back into a pit without teleporting",()=>{
    const {w,p,d}=setup();installPermissions(w);for(let y=0;y<2;y++)for(let x=0;x<2;x++)G.setTerrainDig(w,x,y,-25);
    expect(G.tryPlace(w,p,req(d)).ok).toBe(true);w.set(p,Transform,{x:1.05,y:1.9});
    const a=G.makeAgent(G.makeAgentIdentity(1,1),1),v=G.buildAgentView(w,p,a,{x:0,y:0})!,reg=G.registerGameplayCommands();
    for(const goal of [{x:3.5,y:1.5},{x:.5,y:.5}]){
      for(let n=0;n<300;n++){
        const t=w.get(p,Transform)!;if(Math.hypot(t.x-goal.x,t.y-goal.y)<.6)break;
        const c={...v,self:{...v.self,x:t.x,y:t.y,tick:w.tick},world:{...v.world,base:{x:0,y:0}},bb:a.bb,memory:a.memory,traits:a.identity.traits,rng:a.rng,agent:a},out=idleOutput();
        goTo(c,out,goal.x,goal.y);const frame=G.agentOutputFrame(out,w.tick,reg);G.applyMovementInput(w,p,frame.actions,.05);w.tick++;
      }
      const t=w.get(p,Transform)!;expect(Math.hypot(t.x-goal.x,t.y-goal.y),JSON.stringify({goal,t,wp:walkerWaypoint(w,p,t.x,t.y,goal.x,goal.y)})).toBeLessThan(.6);
    }
  });
  it("rejects flat land, duplicate faces, water, foreign claims and blocked landings", () => {
    const { w, p, d, map } = setup();
    expect(G.tryPlace(w, p, req(d))).toEqual({ok:false,reason:G.BuildFail.NoTerrainFace});
    G.setTerrainDig(w, 0, 1, -3); expect(G.tryPlace(w,p,req(d)).ok).toBe(true);
    expect(G.tryPlace(w,p,req(d))).toEqual({ok:false,reason:G.BuildFail.Occupied});
    G.setTerrainDig(w, 1, 1, -3); map.setTile(1,2,WATER_TILE);
    expect(G.tryPlace(w,p,req(d,1.5))).toEqual({ok:false,reason:G.BuildFail.Terrain});
    map.setTile(1,2,3);
    const zone=w.create(); w.add(zone,Transform,{x:1.5,y:1.5}).add(zone,G.PrivilegeZone,{radius:1,tribe:99}); G.indexEntity(w,zone);
    expect(G.tryPlace(w,p,req(d,1.5))).toEqual({ok:false,reason:G.BuildFail.NoPrivilege});
  });
  it("allows three-tile natural and edited steps, but AI routes around dangerous unladdered drops",()=>{
    const {w,p}=setup();w.resource(G.TerrainRes).setRawHeight!(0,1,-3);
    expect(G.movementBlocked(w,.5,1.5,.5,2.5,0)).toBe(false);
    w.resource(G.TerrainRes).setRawHeight!(0,1,0);G.setTerrainDig(w,0,1,-4);
    expect(G.movementBlocked(w,.5,1.5,.5,2.5,0)).toBe(true);
    expect(G.movementBlocked(w,.5,2.5,.5,1.5,0)).toBe(false); // player may choose to drop
    const next=walkerWaypoint(w,p,.5,2.5,.5,.5);expect(next).toBeDefined();
    expect(next).not.toMatchObject({x:.5,y:.5});
  });
  it("rejects a solid landing and abandons a newly claimed entrance instead of endlessly retrying it",()=>{
    const {w,p,d}=setup();G.setTerrainDig(w,0,1,-3);
    const sn=G.snapPlacement(w,{...req(d,.5,1.5),piece:d.pieceId("workbench")});if(typeof sn!=="number")G.placePiece(w,p,sn,{pay:false});
    expect(G.tryPlace(w,p,req(d))).toEqual({ok:false,reason:G.BuildFail.Blocked});
    const fresh=setup();const plan=planTerrainBase(fresh.w,fresh.p,{x:0,y:0},"pit")!;G.setTerrainDig(fresh.w,0,1,-1);
    const zone=fresh.w.create();fresh.w.add(zone,Transform,{x:.5,y:2.5}).add(zone,G.PrivilegeZone,{radius:1,tribe:99});G.indexEntity(fresh.w,zone);
    expect(nextTerrainWork(fresh.w,fresh.p,plan)).toBeUndefined();expect(plan.abandoned).toBe(true);
  });

});

describe("ADR-266 finite autonomous terrain bases", () => {
  it.each(["pad", "pit"] as const)("plans and finishes a %s, conserves Soil and installs its entrance ladder and underground light", (kind) => {
    const { w,p,d }=setup(); const plan=planTerrainBase(w,p,{x:0,y:0},kind)!; expect(plan).toBeDefined();
    const soil=d.itemId("soil"); let digs=0,raises=0, ladder=false, lit=false;
    // Execute the exact command-sized work chosen by the planner, not a scripted per-cell edit.
    for(let n=0;n<100&&!plan.done&&!plan.abandoned;n++) {
      const step=nextTerrainWork(w,p,plan); if(!step) break;
      if(step.k==="terrain") {
        w.set(p,Transform,step.stand); const old=G.countItem(w,p,soil);
        expect(G.editTerrain(w,p,step.x,step.y,step.dir,true)).toBe(G.TerrainFail.None);
        expect(G.countItem(w,p,soil)).toBe(old);
        expect(G.editTerrain(w,p,step.x,step.y,step.dir)).toBe(G.TerrainFail.None);
        expect(G.countItem(w,p,soil)).toBe(old-step.dir); if(step.dir<0)digs++;else raises++;
      } else if(step.k==="ladder"||step.k==="light") {
        w.set(p,Transform,{x:.5,y:2.5});
        const result=G.tryPlace(w,p,{...req(d,step.x,step.y),piece:d.pieceId(step.k==="ladder"?"ladder":"campfire")});
        expect(result.ok,JSON.stringify({step,result})).toBe(true); if(step.k==="ladder")ladder=true;
      } else {
        // Exercise the same authoritative open / deposit / toggle commands as the AI, not a Fuel-state shortcut.
        w.set(p,Transform,{x:.5,y:1.5});
        G.setIntent(w,p,{action:G.IntentAction.OpenContainer,target:step.piece});G.containerSystem(w);
        G.setIntent(w,p,{action:G.IntentAction.Deposit,target:step.piece,item:d.itemId("wood"),count:4});G.containerSystem(w);
        const a=G.makeAgent(G.makeAgentIdentity(1,1),1),view:AgentWorldView={seen:[],home:{x:0,y:0},playerName:"owner"};
        fillPlanSensors(w,p,view,a,d,G.readSlots(w,p));expect(view.panel).toBeUndefined(); // a fire is NOT a carcass to loot
        G.setIntent(w,p,{action:G.IntentAction.ToggleFire,target:step.piece});G.fuelSystem(w,.05);
        expect(w.getField(step.piece,G.Fuel,"lit")).toBe(1);G.closeContainer(w,p);lit=true;
      }
      w.tick++;
    }
    expect(plan.abandoned).not.toBe(true); expect(plan.done).toBe(true); expect(ladder).toBe(true);
    expect(G.countItem(w,p,soil)).toBe(digs-raises);
    expect(kind==="pit"?digs:raises).toBe(kind==="pit"?12:8); if(kind==="pit")expect(lit).toBe(true);
    for(let y=0;y<2;y++)for(let x=0;x<2;x++){expect(w.resource(G.TerrainRes).heightAt(x,y)).toBe(plan.height);if(kind==="pit")expect(G.isUnderground(w,x,y)).toBe(true);}
    const before=G.countItem(w,p,soil);for(let n=0;n<20;n++)expect(nextTerrainWork(w,p,plan)).toBeUndefined();expect(G.countItem(w,p,soil)).toBe(before);
  });
  it("lights already-deposited underground fuel without withdrawing another wood stack or toggling it back off",()=>{
    const {w,p,d}=setup();installPermissions(w);const earth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    for(let y=0;y<2;y++)for(let x=0;x<2;x++)G.setTerrainDig(w,x,y,-3);
    expect(G.tryPlace(w,p,req(d)).ok).toBe(true);
    const placed=G.tryPlace(w,p,{...req(d,1.5,.5),piece:d.pieceId("campfire")});expect(placed.ok).toBe(true);if(!placed.ok)return;
    const fire=G.resolveAttachment(w,placed.piece,G.AttachKind.Fire)!;G.addItem(w,fire,d.itemId("wood"),4);G.removeItem(w,p,d.itemId("wood"),50);
    const plan=makePlan({world:w,self:p,defs:d,base:{x:0,y:0},bs:scanBase(w,d,{x:0,y:0}),fails:{},earth,terrainOnly:true});
    expect(plan.step).toEqual({k:"light",piece:fire});expect(plan.leaves).toHaveLength(0);
    w.set(p,Transform,{x:.5,y:1.5});const a=G.makeAgent(G.makeAgentIdentity(1,1),1),v=G.buildAgentView(w,p,a,{x:0,y:0})!;
    const c={...v,world:{...v.world,plan},bb:a.bb,memory:a.memory,traits:a.identity.traits,rng:a.rng,agent:a};
    const behavior=baseBehaviors().find(b=>b.name==="base_work")!,out=idleOutput();behavior.run!(c,out);
    expect(out.actions).toEqual([`fire:${fire}`]);G.setIntent(w,p,{action:G.IntentAction.ToggleFire,target:fire});G.fuelSystem(w,.05);
    expect(w.getField(fire,G.Fuel,"lit")).toBe(1);const next=idleOutput();behavior.run!(c,next);expect(next.actions).toEqual([]);
    expect(nextTerrainWork(w,p,earth)).toBeUndefined();expect(earth.done).toBe(true);
    G.removeItem(w,fire,d.itemId("wood"),G.countItem(w,fire,d.itemId("wood")));w.setField(fire,G.Fuel,"burnUntilTick",w.tick+100);w.tick+=80; // low, still-lit fire; expire the base-scan cache
    const maintenance={...c,self:{...c.self,phase:"day" as const},world:{...c.world,base:{x:0,y:0},bs:scanBase(w,d,{x:0,y:0}),cold:false,winter:false}};
    expect(lowFire(maintenance)?.id).toBe(placed.piece); // keep underground light fueled at noon, not only at night
    expect(lowFire({...maintenance,world:{...maintenance.world,base:{x:5,y:5}}})).toBeUndefined();
  });
  it("reacquires the south ladder doorway instead of following a stale crossing phase through a pit's west wall",()=>{
    const {w,p,d}=setup();installPermissions(w);for(let y=0;y<2;y++)for(let x=0;x<2;x++)G.setTerrainDig(w,x,y,-3);
    expect(G.tryPlace(w,p,req(d)).ok).toBe(true);w.set(p,Transform,{x:-.3,y:.8});
    const a=G.makeAgent(G.makeAgentIdentity(1,1),1),v=G.buildAgentView(w,p,a,{x:0,y:0})!,bs=scanBase(w,d,{x:0,y:0});
    bs.door={id:1,x:.5,y:2,open:true};a.bb.set("doorPhase",1);
    const c={...v,world:{...v.world,base:{x:0,y:0},bs},bb:a.bb,memory:a.memory,traits:a.identity.traits,rng:a.rng,agent:a},out=idleOutput();
    goTo(c,out,.5,1.25);expect(a.bb.num("doorPhase")).toBe(0);expect(out.moveY).toBeGreaterThan(0);expect(out.moveX).toBeLessThanOrEqual(0);
  });
  it("does not leave a half-raised shelter footprint when its finite quarry cannot supply enough Soil",()=>{
    const {w,p,d}=setup();const plan=planTerrainBase(w,p,{x:0,y:0},"pad")!;
    G.addItem(w,p,d.itemId("soil"),1);
    for(const q of plan.quarry)q.bottom=w.resource(G.TerrainRes).heightAt(q.x,q.y);
    expect(nextTerrainWork(w,p,plan)).toBeUndefined();expect(plan.abandoned).toBe(true);
    for(let y=0;y<2;y++)for(let x=0;x<2;x++)expect(w.resource(G.TerrainRes).heightAt(x,y)).toBe(0);
    expect(G.countItem(w,p,d.itemId("soil"))).toBe(1);
  });
  it("chooses terrain commands through the real plan and net command pipeline",()=>{
    const {w,p,d}=setup();const earth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    const plan=makePlan({world:w,self:p,defs:d,base:{x:0,y:0},bs:scanBase(w,d,{x:0,y:0}),fails:{},earth,terrainOnly:true});
    expect(plan.step?.k).toBe("terrain");
    expect(G.actionCommand("terrain:0:1:-1")).toEqual({type:G.TerrainCmd.name,payload:{x:0,y:1,dir:-1}});
  });
  it("refuses claims, no shovel, no Soil raising, occupied/player foundations, and full inventories",()=>{
    const {w,p,d}=setup();
    const earth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    const zone=w.create();w.add(zone,Transform,{x:.5,y:.5}).add(zone,G.PrivilegeZone,{radius:3,tribe:99});G.indexEntity(w,zone);
    expect(planTerrainBase(w,p,{x:0,y:0},"pit")).toBeUndefined();expect(nextTerrainWork(w,p,earth)).toBeUndefined();expect(earth.abandoned).toBe(true);
    w.destroy(zone);w.resource(G.TerrainRes).heightAt(0,0);
    expect(G.editTerrain(w,p,1,1,1)).toBe(G.TerrainFail.NoSoil);
    const f=G.snapPlacement(w,{...req(d,.5,.5),piece:d.pieceId("foundation")});if(typeof f!=="number")G.placePiece(w,p,f,{pay:false});
    expect(planTerrainBase(w,p,{x:0,y:0},"pad")).toBeUndefined();
  });
  it("unhired survivors select a persisted base plan, and hired Maintain workers choose bounded owner earthworks without tile orders",()=>{
    const {w,p,d}=setup(); const a=G.makeAgent(G.makeAgentIdentity(1,1),1); aiMemoryOf(a).base={x:0,y:0};
    const view: AgentWorldView={seen:[],home:{x:0,y:0},playerName:"owner"};
    fillPlanSensors(w,p,view,a,d,G.readSlots(w,p));expect(aiMemoryOf(a).earth).toMatchObject({x:0,y:0});
    const own=aiMemoryOf(a).earth;fillPlanSensors(w,p,view,a,d,G.readSlots(w,p));expect(aiMemoryOf(a).earth).toBe(own);
    w.set(p,G.Worker,{owner:77,job:G.WorkerJob.Maintain,homeX:0,homeY:0});
    fillHireSensors(w,p,view,a);expect(aiMemoryOf(a).hireEarth).toMatchObject({x:0,y:0});
    expect(view.plan?.goal).toBe("earthworks");expect(view.plan?.step?.k).toBe("terrain");
    // Changing jobs must NOT issue terrain work.
    w.setField(p,G.Worker,"job",G.WorkerJob.Follow);fillHireSensors(w,p,view,a);expect(view.plan).toBeUndefined();
  });
  it("pauses a finite plan on full bag/no shovel, refuses a foreign quarry, and protects BOTH tiles supporting an edge",()=>{
    const {w,p,d}=setup();const plan=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    w.set(p,G.Inventory,{maxWeight:.1});expect(nextTerrainWork(w,p,plan)).toBeUndefined();expect(plan.abandoned).not.toBe(true);
    w.set(p,G.Inventory,{maxWeight:0});expect(nextTerrainWork(w,p,plan)?.k).toBe("terrain");
    expect(G.terrainDigAt(w,0,1)).toBe(0);expect(G.countItem(w,p,d.itemId("soil"))).toBe(0);
    const {w:w2,p:p2,d:d2}=setup();const plan2=planTerrainBase(w2,p2,{x:0,y:0},"pad")!;
    w2.set(p2,Transform,{x:-.5,y:2.5});
    const zone=w2.create();w2.add(zone,Transform,{x:-3,y:3}).add(zone,G.PrivilegeZone,{radius:1.5,tribe:99});G.indexEntity(w2,zone);
    expect(nextTerrainWork(w2,p2,plan2)).toBeUndefined();expect(plan2.abandoned).toBe(true);
    const sn=G.snapPlacement(w2,{...req(d2,.5,2),piece:d2.pieceId("wall")});
    if(typeof sn!=="number")G.placePiece(w2,p2,sn,{pay:false});
    expect(G.editTerrain(w2,p2,0,1,-1)).toBe(G.TerrainFail.Occupied);
    expect(G.editTerrain(w2,p2,0,2,-1)).toBe(G.TerrainFail.Occupied);
    G.removeItem(w2,p2,d2.itemId("stone_shovel"),1);expect(G.editTerrain(w2,p2,1,1,-1)).toBe(G.TerrainFail.NoShovel);
  });

  it("retains Soil even when a capacity-blocked earthworks plan has no action step",()=>{
    const {w,p,d}=setup();const earth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    G.mapSlots(w,p,v=>{for(let i=0;i<v.addLimit;i++){const item=i===0?d.itemId("soil"):i===1?d.itemId("stone_shovel"):d.itemId("wood");v.put(i,item,d.items.get(item)!.maxStack,w.tick,d.items.get(item)!.maxDurability,0);}return true;});
    const plan=makePlan({world:w,self:p,defs:d,base:{x:0,y:0},bs:scanBase(w,d,{x:0,y:0}),fails:{},earth,terrainOnly:true});
    expect(plan.goal).toBe("earthworks");expect(plan.step).toBeUndefined();expect(plan.keep.has(d.itemId("soil"))).toBe(true);expect(earth.abandoned).not.toBe(true);
  });
  it("full pack with an empty hotbar pauses digging and invokes existing junk cleanup to free an actual Soil slot",()=>{
    const {w,p,d}=setup();const a=G.makeAgent(G.makeAgentIdentity(1,1),1);aiMemoryOf(a).base={x:0,y:0};aiMemoryOf(a).earth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    G.mapSlots(w,p,v=>{for(let i=0;i<v.addLimit;i++){const item=i===0?d.itemId("dye"):i===1?d.itemId("stone_shovel"):d.itemId("wood");v.put(i,item,d.items.get(item)!.maxStack,w.tick,d.items.get(item)!.maxDurability,0);}return true;});
    const plan=aiMemoryOf(a).earth!;expect(nextTerrainWork(w,p,plan)).toBeUndefined();expect(plan.abandoned).not.toBe(true);
    const view:AgentWorldView={seen:[],home:{x:0,y:0},playerName:"owner"};w.register(Membership);G.fillAgentSensors(w,p,view);expect(view.invSpaceFree).toBe(0);fillPlanSensors(w,p,view,a,d,G.readSlots(w,p));expect(view.junk?.item).toBe(d.itemId("dye"));
    G.removeItem(w,p,view.junk!.item,view.junk!.count);expect(nextTerrainWork(w,p,plan)?.k).toBe("terrain");expect(G.countItem(w,p,d.itemId("soil"))).toBe(0);
  });
  it("hired Maintain can stash excess wood while a full-pack earthworks plan retains Soil",()=>{
    const {w,p,d}=setup(),a=G.makeAgent(G.makeAgentIdentity(1,1),1);
    w.set(p,G.Worker,{owner:77,job:G.WorkerJob.Maintain,homeX:0,homeY:0});
    const sn=G.snapPlacement(w,{piece:d.pieceId("basic_storage_box"),x:3.5,y:3.5,level:0,rot:0,tier:0,variant:0});
    expect(typeof sn).toBe("object");if(typeof sn!=="number")G.placePiece(w,p,sn,{pay:false});
    aiMemoryOf(a).hireEarth=planTerrainBase(w,p,{x:0,y:0},"pit")!;
    G.mapSlots(w,p,v=>{for(let i=0;i<v.addLimit;i++){const item=i===0?d.itemId("soil"):i===1?d.itemId("stone_shovel"):d.itemId("wood");v.put(i,item,d.items.get(item)!.maxStack,w.tick,d.items.get(item)!.maxDurability,0);}return true;});
    const view:AgentWorldView={seen:[],home:{x:0,y:0},playerName:"owner"};fillHireSensors(w,p,view,a);
    expect(view.plan?.goal).toBe("earthworks");expect(view.plan?.step).toBeUndefined();
    expect(view.plan?.keep.has(d.itemId("soil"))).toBe(true);expect(view.surplus?.some(s=>s.item===d.itemId("soil"))).not.toBe(true);
    expect(view.surplus?.some(s=>s.item===d.itemId("wood")&&s.count>0)).toBe(true);expect(aiMemoryOf(a).hireEarth?.abandoned).not.toBe(true);
  });
  it("hired Maintain gathers its OWNER plan's missing ladder materials, not a personal-base goal",()=>{
    const {w,p,d}=setup();const a=G.makeAgent(G.makeAgentIdentity(1,1),1);
    w.set(p,G.Worker,{owner:77,job:G.WorkerJob.Maintain,homeX:0,homeY:0});
    aiMemoryOf(a).hireEarth=planTerrainBase(w,p,{x:0,y:0},"pit")!;G.setTerrainDig(w,0,1,-1);
    G.removeItem(w,p,d.itemId("wood"),50);G.removeItem(w,p,d.itemId("sticks"),50);
    const node=G.spawnResourceNode(w,"fallen_branches",-1.5,2.5);a.memory.see({id:node,kind:"node",x:-1.5,y:2.5,tick:w.tick});
    const view:AgentWorldView={seen:[],home:{x:0,y:0},playerName:"owner"};fillGoalSensors(w,p,view,a);
    expect(view.plan?.goal).toBe("earthworks");expect(view.plan?.leaves.length).toBeGreaterThan(0);
    expect(view.gatherNode).toMatchObject({id:node,wanted:true});
  });

  it("neighbouring survivor identities choose both underground rooms and elevated pads",()=>{
    const kinds=new Set<string>();
    for(const id of ["survivor-a","survivor-b"]){const {w,p,d}=setup();const a=G.makeAgent({...G.makeAgentIdentity(1,1),id},1);aiMemoryOf(a).base={x:0,y:0};
      fillPlanSensors(w,p,{seen:[],home:{x:0,y:0},playerName:"owner"},a,d,G.readSlots(w,p));kinds.add(aiMemoryOf(a).earth!.kind);}
    expect(kinds).toEqual(new Set(["pad","pit"]));
  });

});
