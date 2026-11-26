// ADR-547: entry static burst — a fresh client streams its area of interest at a raised
// static budget for the first seconds after connecting, then the steady 8 KiB/tick applies
// again. The burst is bounded by time (100 ticks) and by total bytes (512 KiB), and must not
// disturb the separate 16 KiB snapshot budget.
import { describe, expect, it } from "vitest";
import { defineComponent, Owner, Transform, type World } from "@engine/core";
import { CHUNK_SIZE } from "@engine/world";
import { LoopbackNetwork, NetClient, NetServer } from "../src/index.js";
import { frames, join, makeWorld } from "./fixture.js";

const BuildPiece = defineComponent("BuildPiece", { type: "u16", rot: "u8", variant: "u8", tier: "u8", hp: "u16", damageStage: "u8", paint: "u8" }, { networked: true });
const mk = (): World => { const w = makeWorld(); w.register(BuildPiece); return w; };

type BurstOpt = { bytes?: number; ticks?: number; totalBytes?: number } | false;
async function setup(opts: { burst?: BurstOpt; loss?: number } = {}) {
  const net = new LoopbackNetwork(11); const sw = mk();
  let player = 0;
  const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 2, hysteresis: 0 }, staticBudgetBytes: 8 * 1024,
    ...(opts.burst !== undefined ? { entryStaticBurst: opts.burst } : {}),
    onClientJoin: (s, w) => { player = w.create(); w.add(player, Transform, { x: 112, y: 112 }).add(player, Owner, { clientId: s.clientId }); } });
  server.setReplicationClass(BuildPiece, "static");
  // 3000-piece base over 3x3 chunks (96x96 tiles) starting at tile 64 (same fixture as static.test.ts)
  const pieces: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const e = sw.create();
    sw.add(e, Transform, { x: 64 + (i % 55) * 1.75, y: 64 + Math.floor(i / 55) * 1.75 })
      .add(e, BuildPiece, { type: i % 40, rot: i % 4, variant: i % 3, tier: 1 + (i % 4), hp: 500, damageStage: 0, paint: 0 });
    pieces.push(e);
  }
  const A = new NetClient({ world: mk(), transport: net.createClient({ latencyMs: 30, jitterMs: 10, loss: opts.loss ?? 0 }), });
  await join(net, A);
  const step = (n = 1) => frames(net, [sw, A.world], n);
  const held = () => [...A.world.query([BuildPiece])].length;
  return { net, sw, A, server, pieces, step, held, player: () => player };
}

/** Ticks until the client holds all 3000 pieces (server ticks; client lags ~1 tick on loopback). */
function streamTicks(s: Awaited<ReturnType<typeof setup>>): number {
  let ticks = 0;
  while (s.held() < 3000 && ticks < 200) { s.step(); ticks++; }
  return ticks;
}

describe("entry static burst (ADR-547)", () => {
  it("streams the AOI in fewer ticks at entry, with the steady budget and snapshot budget untouched", async () => {
    const burst = await setup();
    expect(burst.server.entryBurstBytes).toBe(32 * 1024);
    expect(burst.server.entryBurstTicks).toBe(100);
    expect(burst.server.entryBurstTotalBytes).toBe(512 * 1024);
    expect(burst.server.staticBudgetBytes).toBe(8 * 1024);
    expect(burst.server.budgetBytes).toBe(16 * 1024); // snapshot budget: separate, unchanged
    expect(burst.server.entryBurst(1)?.bursting).toBe(true);
    const burstTicks = streamTicks(burst);
    console.log(JSON.stringify({ burstTicks, burstBytes: burst.server.entryBurst(1)?.bytes }));
    expect(burst.server.entryBurst(1)?.bytes).toBeGreaterThan(0);
    expect(burst.server.entryBurst(1)?.bytes).toBeLessThanOrEqual(512 * 1024);
    // snapshots never ride the burst: the static channel carries the pieces, not snapshots.
    expect(burst.server.sessions.get(1)!.lastSnapshotBytes).toBeLessThan(16 * 1024);
    expect(burst.server.sessions.get(1)!.lastSnapshotBytes).toBeLessThan(200);

    const control = await setup({ burst: false });
    const controlTicks = streamTicks(control);
    console.log(JSON.stringify({ controlTicks }));
    expect(controlTicks).toBeGreaterThanOrEqual(9); // sanity: the steady 8 KiB budget really takes ~10 ticks
    expect(burstTicks).toBeLessThan(controlTicks);
    expect(burstTicks).toBeLessThanOrEqual(5); // 68 KiB at 32 KiB/tick + ~1 tick of loopback lag
  });

  it("is time-bounded: after the window a fresh stream runs at the steady 8 KiB/tick", async () => {
    const s = await setup();
    expect(streamTicks(s)).toBeLessThanOrEqual(5);
    s.step(120); // past the 100-tick window (join was at tick 0)
    expect(s.server.entryBurst(1)?.bursting).toBe(false);
    // 2000 fresh pieces in a new area the client has never seen (tiles 512+, ~45 KiB)
    const fresh: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const e = s.sw.create();
      s.sw.add(e, Transform, { x: 512 + (i % 55) * 1.75, y: 512 + Math.floor(i / 55) * 1.75 })
        .add(e, BuildPiece, { type: i % 40, rot: i % 4, variant: i % 3, tier: 1 + (i % 4), hp: 500, damageStage: 0, paint: 0 });
      fresh.push(e);
    }
    s.sw.setField(s.player(), Transform, "x", 528); s.sw.setField(s.player(), Transform, "y", 528);
    const freshHeld = () => [...s.A.world.query([BuildPiece])].filter((e) => s.A.world.get(e, Transform)!.x > 500).length;
    let ticks = 0; let maxTickBytes = 0;
    while (freshHeld() < 2000 && ticks < 60) {
      const before = s.server.staticStats(1)!.bytes; s.step(); ticks++;
      maxTickBytes = Math.max(maxTickBytes, s.server.staticStats(1)!.bytes - before);
    }
    console.log(JSON.stringify({ restreamTicks: ticks, maxTickBytes }));
    expect(freshHeld()).toBe(2000);
    expect(ticks).toBeGreaterThan(1); // ~45 KiB at 8 KiB/tick takes several ticks, not one burst tick
    expect(maxTickBytes).toBeLessThanOrEqual(8 * 1024 + 512); // no tick exceeds the steady budget (+ header slack)
    expect(s.server.entryBurst(1)?.bursting).toBe(false);
  });

  it("is byte-bounded: a small total cap ends the burst inside the window", async () => {
    const s = await setup({ burst: { totalBytes: 32 * 1024 } });
    const ticks = streamTicks(s);
    const burstBytes = s.server.entryBurst(1)?.bytes ?? 0;
    console.log(JSON.stringify({ cappedTicks: ticks, burstBytes }));
    expect(s.held()).toBe(3000); // the stream still completes, at the steady budget after the cap
    expect(s.server.entryBurst(1)?.bursting).toBe(false); // cap tripped long before the 100-tick window
    expect(burstBytes).toBeLessThanOrEqual(32 * 1024 + 1024); // cap + at most one entity record of overshoot
    expect(ticks).toBeGreaterThan(4); // slower than a full burst (~4 ticks) ...
    expect(ticks).toBeLessThan(10); // ... but faster than no burst (~10 ticks)
  });
});
