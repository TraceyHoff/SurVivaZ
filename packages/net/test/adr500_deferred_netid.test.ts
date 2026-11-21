// ADR-500: sunken caches defer their NetId assignment to the end of the replication pass.
// A cache created during worldgen interleaved with resource nodes shifted every subsequently created
// node's NetId, and the gather yield stream is seeded by NetId — so one new entity type silently
// re-rolled every node's yields and flipped the deterministic ADR-252 canary (berry-bush mushroom
// roll -> sensor newSlots -> trip direction -> pad never built). These tests pin the deferral at the
// NetServer level: deferred entities are assigned after every other entity in the pass, so the
// non-deferred ids stay dense and in creation order exactly as if the deferred entities did not exist.
import { describe, expect, it } from "vitest";
import { Transform, defineComponent } from "@engine/core";
import { LoopbackNetwork, NetServer } from "../src/index.js";
import { frames, makeWorld } from "./fixture.js";

/** Local marker for "cache-like" entities in this test (the production predicate is isSunkenCacheNode). */
const Deferred = defineComponent("T_Deferred500", { v: "u8" });

function rig(defer: boolean) {
  const net = new LoopbackNetwork(7);
  const w = makeWorld(); w.register(Deferred);
  const server = new NetServer({
    world: w, transport: net.createServer(), interest: false,
    ...(defer ? { deferNetId: (world, e) => world.has(e, Deferred) } : {}),
  });
  return { net, w, server };
}

describe("ADR-500 deferred NetId assignment", () => {
  it("deferred entities are assigned after every non-deferred entity in the pass", () => {
    const { net, w, server } = rig(true);
    const mk = (deferred: boolean, x: number): number => {
      const e = w.create(); w.add(e, Transform, { x, y: 0 });
      if (deferred) w.add(e, Deferred, { v: 1 });
      return e;
    };
    // Creation order interleaves deferred ("cache") entities with ordinary nodes, as worldgen does.
    const n1 = mk(false, 1); const c1 = mk(true, 2); const n2 = mk(false, 3); const c2 = mk(true, 4); const n3 = mk(false, 5);
    frames(net, [w], 1);
    const id = (e: number): number => server.netIds.netIdOf(e)!;
    // Non-deferred ids are dense and in creation order, as if the caches did not exist.
    expect(id(n2)).toBe(id(n1) + 1);
    expect(id(n3)).toBe(id(n1) + 2);
    // Deferred ids come after every non-deferred id from this pass.
    expect(id(c1)).toBeGreaterThan(id(n3));
    expect(id(c2)).toBeGreaterThan(id(n3));
    expect(id(c1)).not.toBe(id(c2));
  });

  it("without the predicate the same entities interleave (control: the old behaviour)", () => {
    const { net, w, server } = rig(false);
    const mk = (x: number): number => { const e = w.create(); w.add(e, Transform, { x, y: 0 }); return e; };
    const n1 = mk(1); const c1 = mk(2); const n2 = mk(3);
    frames(net, [w], 1);
    const id = (e: number): number => server.netIds.netIdOf(e)!;
    // Creation order, no deferral: the middle entity takes the id n2 would otherwise have had.
    expect(id(c1)).toBe(id(n1) + 1);
    expect(id(n2)).toBe(id(n1) + 2);
  });
});
