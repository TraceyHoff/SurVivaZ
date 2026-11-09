// ADR-314: doors draw their replicated open state, swing through Art's <sprite>_swing frames on the render clock
// (reverse on close, 16 fps doors / 11 fps clan pieces), snap on first sight, keep a breached gate open, and play the
// swing / gate SFX read from the Door attachment.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { readManifestJson } from "@engine/assets/node";
import { DoorSwingTracker, doorSwingStep, doorSwingSeconds } from "@engine/render";
import { PlayerId, Transform } from "@engine/core";
import * as G from "@engine/gameplay";
import { MANIFEST_INDEX } from "../src/manifest-index.js";
import { DoorView, doorArt, doorStateIndex } from "../src/door-view.js";
import { AudioDirector, doorSfxKey } from "../src/audio/events.js";
import { snapshotWorld } from "../src/audio/snapshot.js";
import { makeWorld, plantClaim, spawnLearned } from "../../../packages/gameplay/test/helpers.js";

const root = resolve(__dirname, "../../..");
const repoPath = (url: string) => resolve(root, url.startsWith("pack/") ? "packages/assets/" + url : "assets/" + url);
const served = MANIFEST_INDEX.filter((f) => existsSync(repoPath(f.url))).map((f) => ({ name: f.name, manifest: readManifestJson<ManifestJson>(repoPath(f.url)) }));
const { registry } = loadManifest(mergeManifests(served).manifest, { lock: JSON.parse(readFileSync(resolve(root, "packages/assets/pack/ids.lock.json"), "utf8")) });
const defs = G.defaultDefs();
const art = (key: string, variant?: string, rot = 0) => {
  const def = defs.pieces.get(defs.pieceId(key))!;
  return doorArt(registry, key, { type: def.id, rot, tint: 0, paint: 0 }, { pieceKey: () => key, ...(variant ? { variant } : {}) });
};
const DOORS: [string, string | undefined, string, number][] = [
  ["door_wood", undefined, "door_wood_swing", 16], ["door_metal", undefined, "door_metal_swing", 16], ["hatch_wood", undefined, "hatch_wood_swing", 16],
  ["window_shutters", undefined, "window_shutters_swing", 16], ["garden_gate", undefined, "dec_garden_gate_swing", 16],
  ["garden_gate", "picket", "dec_garden_gate__picket_swing", 16], ["garden_gate", "iron", "dec_garden_gate__iron_swing", 16],
  ["garden_gate", "rustic", "dec_garden_gate__rustic_swing", 16], ["gate_clan", undefined, "gate_clan_swing", 11], ["clan_hall_door", undefined, "clan_hall_door_swing", 11],
];

describe("ADR-314 door art", () => {
  it("every door: true piece has closed / open state art and a 4-step swing sprite (variant-matched) at its class rate", () => {
    const doorKeys = [...defs.pieces.values()].filter((p) => p.door).map((p) => p.key).sort();
    expect(doorKeys).toEqual([...new Set(DOORS.map((d) => d[0]))].sort());
    for (const [key, variant, swingKey, fps] of DOORS) {
      const a = art(key, variant);
      expect(a.closed, key).toBeGreaterThanOrEqual(0); expect(a.open, key).toBeGreaterThanOrEqual(0); expect(a.open).not.toBe(a.closed);
      expect(registry.sprite(a.swingVis!).key, `${key}@${variant}`).toBe(swingKey);
      expect(a.swing.map((i) => registry.sprite(a.swingVis!).building!.stateNames[i])).toEqual(["swing1", "swing2", "swing3", "swing4"]);
      expect(a.fps, key).toBe(fps);
      expect(doorStateIndex(a, 0)).toBe(a.closed); expect(doorStateIndex(a, 1)).toBe(a.open);
    }
    const gate = art("gate_clan"); expect(registry.sprite(gate.visualId).building!.stateNames[doorStateIndex(gate, 2)]).toBe("breached");
    const wood = art("door_wood"); expect(doorStateIndex(wood, 2)).toBe(wood.open); // no breached art: stays open
  });
  it("the open state draws a different frame than closed for every rotation (the bug: toggled doors kept the closed frame)", () => {
    for (const [key, variant] of DOORS) for (const rot of [0, 1, 2, 3]) {
      const a = art(key, variant, rot);
      const c = registry.buildingFrame(a.visualId, rot, 0, a.closed), o = registry.buildingFrame(a.visualId, rot, 0, a.open);
      expect([o.atlas.key, o.x, o.y], `${key} r${rot}`).not.toEqual([c.atlas.key, c.x, c.y]);
    }
  });
});

describe("ADR-314 swing sequence", () => {
  it("opening plays swing1..4 then the open art; closing plays swing4..1 then closed, one frame each", () => {
    const at = (i: number, open: boolean) => doorSwingStep((i + 0.5) / 16, 16, open);
    expect([0, 1, 2, 3, 4, 5].map((i) => at(i, true))).toEqual([1, 2, 3, 4, 0, 0]);
    expect([0, 1, 2, 3, 4, 5].map((i) => at(i, false))).toEqual([4, 3, 2, 1, 0, 0]);
    expect(doorSwingStep(-0.01, 16, true)).toBe(0);
  });
  it("timing per piece class: 62.5 ms frames (312.5 ms) for doors, ~91 ms (~455 ms) for clan pieces", () => {
    expect(doorSwingSeconds(16)).toBeCloseTo(0.3125, 6); expect(doorSwingSeconds(11)).toBeCloseTo(0.4545, 3);
    expect(doorSwingStep(0.0624, 16, true)).toBe(1); expect(doorSwingStep(0.0626, 16, true)).toBe(2); expect(doorSwingStep(0.2499, 16, true)).toBe(4); expect(doorSwingStep(0.2501, 16, true)).toBe(0);
    expect(doorSwingStep(0.09, 11, true)).toBe(1); expect(doorSwingStep(0.092, 11, true)).toBe(2); expect(doorSwingStep(0.364, 11, true)).toBe(0);
  });
  it("tracker: first sight snaps (initial load / join), a change swings from the first rendered frame, breach and repair snap", () => {
    const t = new DoorSwingTracker();
    expect(t.observe(1, 1, 16)).toBe(false); expect(t.step(1, 10)).toBe(0); // joined with the door already open: no playback
    expect(t.observe(1, 1, 16)).toBe(false);
    expect(t.observe(1, 0, 16)).toBe(true);
    expect(t.step(1, 20)).toBe(4); expect(t.step(1, 20 + 1.5 / 16)).toBe(3); expect(t.step(1, 20 + 3.5 / 16)).toBe(1); expect(t.step(1, 20 + 4.5 / 16)).toBe(0);
    expect(t.swinging(1)).toBe(false);
    const g = new DoorSwingTracker(); g.observe(2, 0, 11);
    expect(g.observe(2, 2, 11)).toBe(false); expect(g.step(2, 5)).toBe(0); // breached: forced open, no swing
    expect(g.observe(2, 0, 11)).toBe(false); expect(g.step(2, 6)).toBe(0); // repaired shut: snaps closed
    expect(g.observe(2, 1, 11)).toBe(true); expect(g.step(2, 7)).toBe(1);
    g.forget(2); expect(g.observe(2, 0, 11)).toBe(false); // re-entering view is a first sight again
  });
  it("reversing mid-swing continues from the step on screen", () => {
    const t = new DoorSwingTracker(); t.observe(1, 0, 16); t.observe(1, 1, 16);
    expect(t.step(1, 0)).toBe(1); expect(t.step(1, 2.5 / 16)).toBe(3);
    t.observe(1, 0, 16); expect(t.step(1, 3 / 16)).toBe(3); expect(t.step(1, 4.1 / 16)).toBe(2); expect(t.step(1, 6.1 / 16)).toBe(0);
  });
  it("DoorView: static state index while idle, swing sprite + swing state during the swing, none for unknown pieces", () => {
    const v = new DoorView(); const a = art("door_wood"); const mk = () => a;
    expect(v.sync(9, 0, mk, a.visualId)).toBe(a.closed); expect(v.swing(9, 1)).toBeUndefined();
    expect(v.swingSprite(9)).toBe(a.swingVis);
    expect(v.sync(9, 1, mk, a.visualId)).toBe(a.open);
    expect(v.swing(9, 2)).toEqual({ vis: a.swingVis, state: a.swing[0] });
    expect(v.swing(9, 2 + 3.5 / 16)).toEqual({ vis: a.swingVis, state: a.swing[3] });
    expect(v.swing(9, 2 + 4.5 / 16)).toBeUndefined(); // done: the open art (pieceState) shows
    v.forget(9); expect(v.swingSprite(9)).toBeUndefined(); expect(v.swing(10, 0)).toBeUndefined();
  });
});

describe("ADR-314 door SFX", () => {
  it("swing set for doors, hatches, shutters and the hall door; gate set for garden and clan gates", () => {
    for (const k of ["door_wood", "door_metal", "hatch_wood", "window_shutters", "clan_hall_door"]) { expect(doorSfxKey(k, true)).toBe("door.open.swing"); expect(doorSfxKey(k, false)).toBe("door.close.swing"); }
    for (const k of ["garden_gate", "gate_clan"]) { expect(doorSfxKey(k, true)).toBe("door.open.gate"); expect(doorSfxKey(k, false)).toBe("door.close.gate"); }
    const bank = JSON.parse(readFileSync(resolve(root, "apps/client/src/audio/bank.json"), "utf8"));
    for (const k of ["door.open.swing", "door.close.swing", "door.open.gate", "door.close.gate"]) expect(bank[k] ?? bank.events?.[k] ?? bank.sounds?.[k], k).toBeDefined();
  });
  it("a toggled door is heard from its Door attachment (the audio snapshot used to read the piece and never changed)", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); const me = spawnLearned(w, { x: 2.5, y: 4, maxWeight: 0, clientId: 1 }); plantClaim(w, me, -4, -4);
    const put = (key: string, x: number, y: number, rot = 0) => { const sn = G.snapPlacement(w, { piece: defs.pieceId(key), x, y, level: 0, rot, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`${key} ${sn}`); return G.placePiece(w, me, sn, { pay: false }); };
    const gate = put("garden_gate", 2.5, 2.5);
    const d = new AudioDirector(); d.settleSec = 0; const L = w.get(me, Transform)!;
    const snap = () => snapshotWorld(w, me, undefined).ents;
    expect(d.step(snap(), { now: 0, listener: L }).events.map((e) => e.key)).not.toContain("door.open.gate"); // initial sync: silent
    const att = G.resolveAttachment(w, gate, G.AttachKind.Door)!; w.setField(att, G.DoorState, "open", 1);
    expect(snap().find((s) => s.sub === "garden_gate")!.door).toBe(1);
    expect(d.step(snap(), { now: 1, listener: L }).events.map((e) => e.key)).toContain("door.open.gate");
    w.setField(att, G.DoorState, "open", 0);
    expect(d.step(snap(), { now: 2, listener: L }).events.map((e) => e.key)).toContain("door.close.gate");
  });
});

describe("ADR-314 renderer wiring (Canvas2D path)", () => {
  it("a swinging door draws the swing frame; otherwise its open / closed state frame", async () => {
    const { World, defineComponent } = await import("@engine/core");
    const { Canvas2DRenderer } = await import("@engine/render");
    const VP = defineComponent("ViewBuildPieceT314", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });
    const w = new World({ seed: 1 }); w.register(Transform); w.register(VP);
    const a = art("door_wood"); const e = w.create(); w.add(e, Transform, { x: 2.5, y: 2, z: 0 }).add(e, VP, { visualId: a.visualId, layer: 1 });
    const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, {} as unknown as CanvasRenderingContext2D) as unknown as { bindGameplay(b: unknown): void; image(k: string): unknown; gatherPieces(w: unknown, reg: unknown, t: number): { f: { x: number; y: number } }[] };
    r.image = () => ({});
    let state = a.closed; const v = new DoorView(); v.sync(e, 0, () => a, a.visualId);
    r.bindGameplay({ buildPiece: VP, pieceState: () => state, pieceSwing: (x: number, now: number) => v.swing(x, now), pieceSwingSprite: (x: number) => v.swingSprite(x) });
    const at = (vis: number, st: number) => { const f = registry.buildingFrame(vis, 0, 0, st); return [f.x, f.y]; };
    const drawn = (t: number) => { const p = r.gatherPieces(w, registry, t)[0]!; return [p.f.x, p.f.y]; };
    expect(drawn(0)).toEqual(at(a.visualId, a.closed));
    state = v.sync(e, 1, () => a, a.visualId);
    expect(drawn(1)).toEqual(at(a.swingVis!, a.swing[0]!)); // the render clock starts the swing
    expect(drawn(1 + 2.5 / 16)).toEqual(at(a.swingVis!, a.swing[2]!));
    expect(drawn(1 + 4.5 / 16)).toEqual(at(a.visualId, a.open));
  });
});
