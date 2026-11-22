/** ADR-515: mount permission was checked only when getting on. A dismissed hired worker kept riding (and could keep)
 *  its former employer's mount, and its saddlebag stayed open to it. */
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

function rig() {
  const w = makeWorld(); installPermissions(w);
  const P = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); w.add(P, PlayerId, { id: 1 }).add(P, NetId, { id: 901 });
  const W = spawnLearned(w, { x: 1, y: 0, maxWeight: 0, clientId: 2 }); w.add(W, PlayerId, { id: 50 }).add(W, NetId, { id: 902 });
  w.add(W, G.Worker, { owner: 1, job: G.WorkerJob.Gather } as never);
  const m = G.makeMount(w, "animal_elk", 1.2, 0, P); w.add(m, NetId, { id: 903 }); steps(w, 1);
  return { w, P, W, m };
}
describe("ADR-515 mount permission holds while riding", () => {
  it("a dismissed worker is put off its former employer's mount", () => {
    const { w, P, W, m } = rig();
    expect(G.rideMount(w, W, m)).toBe(true); steps(w, 2); expect(G.isRiding(w, W)).toBe(true);
    expect(G.dismissWorker(w, P, W)).toBe(G.WorkerFail.None); steps(w, 2);
    expect(G.isRiding(w, W)).toBe(false); expect(G.liveRider(w, m)).toBeUndefined();
    expect(G.checkRide(w, W, m)).toBe("not_owner");
  });
  it("the owner keeps riding; the saddlebag closes for a viewer who lost access", () => {
    const { w, P, W, m } = rig();
    w.set(m, G.Mount, { saddle: 1, saddleItem: 0, saddleDur: 10 }); steps(w, 1);
    w.set(W, G.PlayerIntent, { action: G.IntentAction.OpenContainer, target: m }); steps(w, 1); w.set(W, G.PlayerIntent, { action: G.IntentAction.None });
    expect(w.getField(W, G.Viewing, "container")).toBe(m);
    G.dismissWorker(w, P, W); steps(w, 2); expect(w.has(W, G.Viewing)).toBe(false);
    expect(G.rideMount(w, P, m)).toBe(true); steps(w, 20); expect(G.isRiding(w, P)).toBe(true);
  });
});
