/** ADR-508: the view sync skips identical Transform / PrevTransform writes but still applies every real change. */
import { describe, expect, it } from "vitest";
import { PrevTransform, Transform, World } from "@engine/core";
import { writeXform } from "../src/view.js";

describe("ADR-508 writeXform", () => {
  it("skips a write when every stored f32 field already matches, writes on any change", () => {
    const w = new World({ seed: 1, maxEntities: 16 }); const e = w.create();
    w.add(e, Transform, { x: 1.1, y: 2.2, z: 0.3, facing: 0.7 }); w.add(e, PrevTransform, { x: 0, y: 0, z: 0, facing: 0 });
    const calls: string[] = []; const set = w.set.bind(w);
    (w as unknown as { set: typeof w.set }).set = ((...a: Parameters<typeof w.set>) => { calls.push(a[1].name); return set(...a); }) as typeof w.set;
    writeXform(w, e, Transform, 1.1, 2.2, 0.3, 0.7); // doubles that round to the stored f32 values
    expect(calls).toEqual([]);
    writeXform(w, e, Transform, 1.1, 2.2, 0.35, 0.7); expect(calls).toEqual([Transform.name]);
    expect(w.get(e, Transform)!.z).toBeCloseTo(0.35, 5);
    writeXform(w, e, PrevTransform, 0, 0, 0, Math.PI); expect(calls.length).toBe(2); expect(w.get(e, PrevTransform)!.facing).toBeCloseTo(Math.PI, 5);
    writeXform(w, e, Transform, NaN, 2.2, 0.35, 0.7); expect(calls.length).toBe(3); // NaN never compares equal: written, as before
  });
  it("a missing component still throws, like World.set", () => {
    const w = new World({ seed: 1, maxEntities: 16 }); const e = w.create(); w.add(e, Transform, { x: 0, y: 0, z: 0, facing: 0 });
    expect(() => writeXform(w, e, PrevTransform, 1, 1, 1, 1)).toThrow();
  });
});
