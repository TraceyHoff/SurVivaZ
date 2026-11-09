import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "building/manifest.building.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const bank = JSON.parse(readFileSync("apps/client/src/audio/bank.json", "utf8"));

type Sprite = { key: string; atlas: string; rotationArt?: string; building?: { piece: string; frames: number[][]; states?: Record<string, number[][]> };
  animations: Record<string, { frames: number[]; fps?: number; loop?: boolean; rotations?: number[][] }> };
const sprite = (k: string): Sprite => man.sprites.find((s: Sprite) => s.key === k);
const atlas = (k: string) => man.atlases.find((a: { key: string }) => a.key === k);

// [sprite, atlas, first index, unique rows, cells per (step,row), fps]
const SWING: [string, string, number, number, number, number][] = [
  ["door_wood_swing", "door_swing_openings", 0, 4, 4, 16],
  ["door_metal_swing", "door_swing_openings", 64, 4, 4, 16],
  ["hatch_wood_swing", "door_swing_openings", 128, 4, 4, 16],
  ["window_shutters_swing", "door_swing_openings", 192, 2, 4, 16],
  ["dec_garden_gate_swing", "door_swing_yard", 0, 2, 1, 16],
  ["dec_garden_gate__picket_swing", "door_swing_yard", 0, 2, 1, 16],
  ["dec_garden_gate__iron_swing", "door_swing_yard", 8, 2, 1, 16],
  ["dec_garden_gate__rustic_swing", "door_swing_yard", 16, 2, 1, 16],
  ["gate_clan_swing", "door_swing_clan", 0, 2, 4, 11],
  ["clan_hall_door_swing", "door_swing_clan", 32, 2, 4, 11],
];

describe("door / gate swing in-betweens", () => {
  it("ships four unique swing steps per rotation and damage stage on add-only atlases", () => {
    for (const [key, at, s0, R, D, fps] of SWING) {
      const s = sprite(key);
      expect(s, key).toBeTruthy();
      expect(s.atlas).toBe(at);
      expect(s.rotationArt).toBe("unique4");
      expect(Object.keys(s.building!.states!)).toEqual(["swing1", "swing2", "swing3", "swing4"]);
      const cell = (k: number, rot: number, d: number) => s0 + (k * R + (rot % R)) * D + (D === 4 ? d : 0);
      for (let k = 0; k < 4; k++)
        expect(s.building!.states![`swing${k + 1}`]).toEqual([0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((d) => cell(k, r, d))));
      expect(s.building!.frames).toEqual(s.building!.states!.swing1);
      const sw = s.animations.swing!;
      expect(sw.fps).toBe(fps);
      expect(sw.loop).toBe(false);
      expect(sw.rotations).toEqual([0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((k) => cell(k, r, 0))));
      expect(sw.frames).toEqual(sw.rotations![0]);
      expect(lock.sprites[key]).toBeTypeOf("number");
      const a = atlas(at);
      expect(a.columns * a.frameW).toBeLessThanOrEqual(2048);
      expect(a.rows * a.frameH).toBeLessThanOrEqual(2048);
      expect(a.ktx2).toBeTruthy();
    }
    const used = new Map<string, Set<number>>();
    for (const [key, at] of SWING) {
      if (key === "dec_garden_gate_swing") continue; // bare key aliases the picket variant
      const set = used.get(at) ?? new Set<number>();
      for (const rows of Object.values(sprite(key).building!.states!)) for (const row of rows) for (const i of row) set.add(i);
      used.set(at, set);
    }
    expect(used.get("door_swing_openings")!.size).toBe(224);
    expect(used.get("door_swing_yard")!.size).toBe(24);
    expect(used.get("door_swing_clan")!.size).toBe(64);
  });

  it("adds open endpoints for hall door and garden gates without moving shipped frames", () => {
    const hall = sprite("clan_hall_door");
    const pair = (a: number) => [[a, a + 2, a + 4, a + 6], [a + 1, a + 3, a + 5, a + 7], [a, a + 2, a + 4, a + 6], [a + 1, a + 3, a + 5, a + 7]];
    expect(hall.building!.frames).toEqual(pair(0));
    expect(hall.building!.states).toEqual({ closed: pair(0), open: pair(16) });
    expect(hall.animations.idle!.frames).toEqual([0]);
    expect(hall.animations.open!.frames).toEqual([16]);
    expect(atlas("clan_structures_large").rows).toBe(4);
    const flat = (a: number) => [[a, a, a, a], [a + 1, a + 1, a + 1, a + 1], [a, a, a, a], [a + 1, a + 1, a + 1, a + 1]];
    for (const [k, open] of [["dec_garden_gate", 20], ["dec_garden_gate__picket", 20], ["dec_garden_gate__iron", 22], ["dec_garden_gate__rustic", 24]] as const) {
      const s = sprite(k);
      expect(s.atlas).toBe("decor_yard_t");
      expect(s.building!.states!.open).toEqual(flat(open));
      expect(s.building!.states!.closed).toEqual(s.building!.frames);
      expect(s.animations.idle!.frames).toEqual([s.building!.frames[0]![0]]);
    }
    expect(atlas("decor_yard_t").rows).toBe(2);
    // shipped door endpoints keep their indices
    const gate = sprite("gate_clan");
    expect(gate.building!.states!.closed).toEqual(pair(0));
    expect(gate.building!.states!.open).toEqual(pair(8));
  });

  it("registers procedural creak / thud SFX in the audio bank", () => {
    for (const k of ["door.open.swing", "door.close.swing", "door.open.gate", "door.close.gate"]) {
      const e = bank[k] ?? bank.sounds?.[k] ?? bank.keys?.[k];
      expect(e, k).toBeTruthy();
      expect(JSON.stringify(e)).toMatch(new RegExp(k.replace(/\./g, "_") + "_1"));
    }
  });
});
