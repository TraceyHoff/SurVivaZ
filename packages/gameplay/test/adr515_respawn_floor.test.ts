/** ADR-515: respawn set x / y only, so a player who died upstairs came back at the bed / spawn point still at the
 *  upper floor's height: floating (no deck there keeps the level's base z) and colliding on that floor's walls. */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs(); const LH = d.building.levelHeight;
const mk = (w: World, id: number, x = 0) => { const p = G.spawnPlayer(w, { x, y: 0, clientId: id }); w.add(p, PlayerId, { id }); return p; };
const kill = (w: World, p: Entity) => { G.applyDamage(w, p, 1e6, p); steps(w, 1); };
const respawn = (w: World, p: Entity) => { steps(w, 20 * G.PVP.respawnSeconds); expect(G.respawnPlayer(w, p)).toBeUndefined(); steps(w, 40); };

describe("ADR-515 respawn lands on the respawn point's floor", () => {
  it("dying on a 2nd floor respawns on the ground at a world spawn point", () => {
    const w = makeWorld(); installPermissions(w); const a = mk(w, 1, 30);
    w.set(a, Transform, { z: 2 * LH + 0.3125 }); kill(w, a); respawn(w, a);
    expect(w.get(a, Transform)!.z).toBeCloseTo(0, 6);
  });
  it("a bed on the 1st floor respawns its owner on that floor", () => {
    const w = makeWorld(); installPermissions(w); G.installBedRespawn(w); const a = mk(w, 1, 0);
    const sn = (key: string, x: number, y: number, level: number) => { const s = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level, rot: 0, tier: 1, variant: 0 }); if (typeof s === "number") throw new Error(`${key} ${s}`); return G.placePiece(w, a, s, { pay: false }); };
    sn("claim_totem", 0.5, 8.5, 0);
    const bedKey = [...d.pieces.values()].find((p) => G.isBedKey(p.key))!.key;
    const bed = sn(bedKey, 3.5, 3.5, 0); w.set(bed, Transform, { z: LH }); // only the bed's floor matters to the locator
    w.set(a, Transform, { x: 20, y: 20, z: 2 * LH + 0.3125 }); kill(w, a); respawn(w, a);
    const t = w.get(a, Transform)!; expect(Math.round(t.z / LH)).toBe(1);
  });
});

describe("ADR-515 loaded rounds drop in the death bag", () => {
  it("a revolver's magazine goes into the bag; the respawned body gets none back", () => {
    const w = makeWorld(); installPermissions(w); const a = mk(w, 1, 30); const id = (k: string) => d.itemId(k);
    G.addItem(w, a, id("revolver"), 1); let s = 0; while (G.slotItem(w, a, s).item !== id("revolver")) s++;
    w.set(a, G.Equipment, { mainHandSlot: s, mainHandItem: id("revolver") }); G.addItem(w, a, id("pistol_round"), 10); steps(w, 1);
    G.setIntent(w, a, { action: G.IntentAction.Reload }); steps(w, 1); G.setIntent(w, a, { action: G.IntentAction.None }); steps(w, 75);
    expect(w.getField(a, G.WeaponState, "loaded")).toBe(6);
    const drops: { bag: Entity }[] = []; w.events.on(G.DeathBagDropped as never, (p: { bag: Entity }) => drops.push(p));
    kill(w, a); expect(drops.length).toBe(1);
    expect(G.countItem(w, drops[0]!.bag, id("pistol_round"))).toBe(10);
    respawn(w, a); expect(G.countItem(w, a, id("pistol_round"))).toBe(0);
  });
});
