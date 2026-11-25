/**
 * ADR-524: interaction targeting — Interact only picks a target the player/bot is right in front of.
 * A window/door closer in raw distance must not steal the tap from a storage box (or pet, stall, …)
 * the player faces, and a bot must face a shut door before toggling it open. The bot container gate
 * (part C) was CUT: gating copen on facing deadlocks live bots (see the containerSeq test below).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, idleOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";
import { bindAgentWorld, containerSeq, goTo } from "../src/ai/base_behaviors.js";
import { storageDepositActions } from "../src/ai/storage_api.js";
import { scanBase } from "../src/ai/planner.js";


const d = G.defaultDefs();
const EAST = 0, NORTH = -Math.PI / 2, SOUTH = Math.PI / 2, WEST = Math.PI;
const face = (w: World, e: Entity, facing: number): void => { w.set(e, Transform, { facing }); };
function place(w: World, builder: Entity, key: string, x: number, y: number, tier = 1): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, builder, sn, { pay: false });
}
/** Foundation + N wall_doorway + hung door_wood; player stands at the hut centre (10.5, 10.5). */
function doorHut(w: World, p: Entity): Entity {
  place(w, p, "foundation", 10.5, 10.5);
  place(w, p, "wall_doorway", 10.5, 10);
  return place(w, p, "door_wood", 10.5, 10);
}
/** Foundation + N wall_window + shutters; player stands at the hut centre (10.5, 10.5). */
function windowHut(w: World, p: Entity): Entity {
  place(w, p, "foundation", 10.5, 10.5);
  place(w, p, "wall_window", 10.5, 10);
  return place(w, p, "window_shutters", 10.5, 10);
}
const chestAt = (w: World, p: Entity, x: number, y: number): Entity => place(w, p, "basic_storage_box", x, y, 0);

describe("ADR-524 player pick: only what is in front", () => {
  it("storage directly in front beats a nearer door behind or to the side", () => {
    const w = makeWorld(); installPermissions(w);
    const me = spawnLearned(w, { x: 10.5, y: 10.5, clientId: 1 }); w.add(me, PlayerId, { id: 1 });
    const door = doorHut(w, me);
    const chest = chestAt(w, me, 12, 10.5); // east, 1.5 away; the door is 0.5 away to the north
    face(w, me, EAST);
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "storage", piece: chest });
    expect(door).toBeDefined();
  });

  it("a door in front beats storage behind the player", () => {
    const w = makeWorld(); installPermissions(w);
    const me = spawnLearned(w, { x: 10.5, y: 10.5, clientId: 1 }); w.add(me, PlayerId, { id: 1 });
    const door = doorHut(w, me);
    const chest = chestAt(w, me, 10.5, 12); // south, behind when facing north
    face(w, me, NORTH);
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "door", piece: door });
    expect(chest).toBeDefined();
  });

  it("a window shutter in front is still offered as a door; the same shutter behind is not", () => {
    const w = makeWorld(); installPermissions(w);
    const me = spawnLearned(w, { x: 10.5, y: 10.5, clientId: 1 }); w.add(me, PlayerId, { id: 1 });
    const shutters = windowHut(w, me);
    face(w, me, NORTH);
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "door", piece: shutters });
    face(w, me, SOUTH);
    expect(G.interactPanel({ world: w, player: me })).toBeUndefined();
  });

  it("nothing in front: Interact does nothing even with targets in range behind", () => {
    const w = makeWorld(); installPermissions(w);
    const me = spawnLearned(w, { x: 10.5, y: 10.5, clientId: 1 }); w.add(me, PlayerId, { id: 1 });
    windowHut(w, me);
    chestAt(w, me, 10.5, 9); // north of the hut, behind when facing south
    face(w, me, SOUTH);
    expect(G.interactPanel({ world: w, player: me })).toBeUndefined();
    face(w, me, NORTH); // control: the window in front is offered again
    expect(G.interactPanel({ world: w, player: me })?.panel).toBe("door");
  });

  it("a pet in front is not suppressed by a closer openable behind the player", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 });
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 1.5, 1.5);
    const crate = w.create();
    w.add(crate, Transform, { x: -0.8, y: 0 }).add(crate, G.LootBag, { owner: 0, despawnAtTick: 0xffffffff });
    const c = { world: w, player: p, names: new Map() };
    face(w, p, EAST);
    expect(G.interactPanel(c)).toEqual({ panel: "pet", pet: a });
  });

  it("a stall behind the player does not open trade; facing it does", () => {
    const w = makeWorld(); installPermissions(w);
    const me = spawnLearned(w, { x: 0, y: 0, clientId: 1 }); w.add(me, PlayerId, { id: 1 });
    const sn = G.snapPlacement(w, { piece: d.pieceId("stall_booth"), x: -1, y: 0, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap stall ${sn}`);
    const stall = G.stallOf(w, G.placePiece(w, me, sn, { pay: false }))!;
    face(w, me, EAST); // stall is behind (west)
    expect(G.interactPanel({ world: w, player: me })).toBeUndefined();
    face(w, me, WEST);
    expect(G.interactPanel({ world: w, player: me })).toEqual({ panel: "trade", stall });
  });
});

describe("ADR-524 bot door + container facing", () => {
  /** Bot inside a 2x2 base at (0,0) with a shut door at (0.5, 2); target outside. */
  const botCtx = (facing: number, doorOpen: boolean) => {
    const w = makeWorld(); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0.5, y: 1.25, maxWeight: 0 });
    face(w, p, facing);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
    const bs = scanBase(w, d, { x: 0, y: 0 });
    bs.door = { id: 1, x: 0.5, y: 2, open: doorOpen };
    const c = { ...v, world: { ...v.world, base: { x: 0, y: 0 }, bs },
      bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a };
    return { w, p, a, c };
  };

  it("a bot facing a shut door opens it when crossing; a bot not facing it does not toggle it", () => {
    const facing = botCtx(SOUTH, false);
    const out = idleOutput();
    goTo(facing.c, out, 0.5, 3.5);
    expect(out.actions).toContain("door:1");
    const away = botCtx(NORTH, false);
    const out2 = idleOutput();
    goTo(away.c, out2, 0.5, 3.5);
    expect(out2.actions).not.toContain("door:1");
  });

  it("the close-behind toggle is NOT gated on facing (the bot walks away by definition)", () => {
    const w = makeWorld(); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0.5, y: 3.5, maxWeight: 0 });
    face(w, p, SOUTH); // south of the door, facing away from it
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
    const bs = scanBase(w, d, { x: 0, y: 0 });
    bs.door = { id: 1, x: 0.5, y: 2, open: true };
    a.bb.set("doorShut", 1);
    const c = { ...v, world: { ...v.world, base: { x: 0, y: 0 }, bs },
      bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a };
    const out = idleOutput();
    goTo(c, out, 0.5, 5);
    expect(out.actions).toContain("door:1");
  });

  it("containerSeq is NOT gated on facing (ADR-524 cut — see comment)", () => {
    // CUT (2026-11-24): gating copen on facing deadlocks live bots. A bot stops walking once it is in
    // container range and then calls containerSeq every think; facing only turns while moving (ADR-305:
    // never reset on idle), and bots reach a box via pathfinder waypoints / stand points offset from it,
    // so the final facing can sit >60° off the box. A refused copen then repeats forever — the bot never
    // moves again, the withdraw never happens, and the adr252 live suite drops 8/8 -> 5/8 (bots never
    // finish the base / bed / sleep steps). With only the goTo door gate, live stays 8/8. So bots open
    // containers regardless of facing; the loot path (no copen step) was never gated either.
    const w = makeWorld(); installPermissions(w);
    const p = spawnLearned(w, { x: 10, y: 10, clientId: 1 }); w.add(p, PlayerId, { id: 1 });
    const chest = chestAt(w, p, 11, 10);
    const wood = d.itemId("wood");
    G.addItem(w, p, wood, 5);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    bindAgentWorld(a, w);
    const ctxFor = (facing: number) => {
      face(w, p, facing);
      const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
      return { ...v, world: v.world, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a };
    };
    // facing away from the chest: copen still emits (no gate)
    const toward = idleOutput();
    expect(containerSeq(ctxFor(WEST), toward, chest, storageDepositActions(chest, wood, 1))).toBe(false);
    expect(toward.actions).toEqual([`copen:${chest}`]);
    // loot path has no copen step: facing away still emits the withdraw
    w.tick += 20; // past the CONTAINER_STEP throttle the open set
    const loot = idleOutput();
    const lootSeq = [`cwithdraw:${chest}:0:0`, "cclose"];
    expect(containerSeq(ctxFor(WEST), loot, chest, lootSeq)).toBe(false);
    expect(loot.actions).toEqual([`cwithdraw:${chest}:0:0`]);
  });
});
