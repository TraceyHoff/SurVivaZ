// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installPermissions, Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { BuildMode } from "../src/build-mode.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";
import { InputSystem, KeyboardMouseDevice, AimResolver, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";

describe("ADR-268 Build confirms the visible snapped hologram",()=>{
  it.each(["keyboardMouse","gamepad","touch"] as const)("%s: stationary player, move ghost, confirm at THAT cell; report occupied cell rather than silently dropping",device=>{
    const w=new World({seed:1,maxEntities:4096});G.installGameplay(w,{});installPermissions(w);
    const p=G.spawnPlayer(w,{x:0,y:0,clientId:1,maxWeight:0}),d=G.gameplayDefs(w);
    plantClaim(w,p,-2,2);
    for(const k of ["sticks","planks","rope","stone"])G.addItem(w,p,d.itemId(k),99);
    let aim={mode:1,x:1.5,y:.5};const buttons=new Set<string>(),sent:G.MenuIntent[]=[];
    const bm=new BuildMode({input:{pressed:a=>buttons.has(a),down:a=>buttons.has(a),push:()=>{},pop:()=>{}},ctx:()=>({world:w,player:p,names:new Map()}),device:()=>device,aim:()=>aim,send:i=>{sent.push(i);return true;}});
    bm.start({piece:d.pieceId("foundation"),tier:0,variant:0,paint:0});bm.update();
    aim={mode:1,x:2.5,y:1.5}; if(device==="touch")bm.setTouchPoint(aim); else if(device==="gamepad")bm.padOffset={x:2.5,y:1.5};
    bm.update();const ghost={...bm.preview!};expect(ghost.valid).toBe(true);
    // A UI confirm / mouse press must not re-resolve the now-changed facing/aim.
    aim={mode:0,x:-1,y:0};buttons.add("Build.PlaceConfirm");const pos=w.get(p,Transform);
    bm.update();expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toMatchObject({x:ghost.request.x,y:ghost.request.y});
    const result=G.tryPlace(w,p,sent[0]!.args as unknown as G.PlaceRequest);expect(result.ok).toBe(true);
    if(result.ok)expect(w.get(result.piece,Transform)).toMatchObject({x:ghost.x,y:ghost.y});
    expect(w.get(p,Transform)).toEqual(pos);
    // Revalidate THAT same cell after the first build: no aim retarget, no silent no-op.
    expect(bm.place()).toBe(false);expect(bm.toast).toBe("Spot taken");expect(sent).toHaveLength(1);
  });
  it("mouse world aim is available before any key/button activity, not a facing-vector fallback",()=>{
    const clock={now:()=>0}; const input=new InputSystem(clock,{actions:DEFAULT_ACTIONS,contexts:DEFAULT_CONTEXTS,profiles:DEFAULT_PROFILES});
    const mouse=new KeyboardMouseDevice();input.addDevice(mouse);mouse.set("mouse.x",320);mouse.set("mouse.y",200);
    const aim=new AimResolver(input,{screenToWorld:(x,y)=>({x:x/64,y:y/32})});
    expect(aim.resolve(null,1,{x:0,y:0})).toEqual({mode:1,x:5,y:6.25});
  });
});
