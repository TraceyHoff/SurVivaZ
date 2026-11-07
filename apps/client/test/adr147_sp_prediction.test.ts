import { describe, it, expect } from "vitest";
import { MemoryWorldStore } from "@engine/persist";
import { createGameLoop, Transform } from "@engine/core";
import { readyIntent, Survival } from "@engine/gameplay";
import { Act, gameplayNet } from "@engine/server/protocol";
import { createLocalServer } from "../src/local.js";
import { ClientSession, type KeyValue } from "../src/session.js";

class S implements KeyValue { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }

/**
 * ADR-147: singleplayer (in-process server on its own clock, like the Web Worker) must show no prediction
 * corrections while walking and sprinting through stamina depletion and regen. Before ADR-147 the replica never
 * predicted stamina (no VitalsState / PlayerIntent on the client), so every sprint end/restart corrected ~0.08..0.15 tiles.
 */
async function runSp(jitter: boolean): Promise<{ corrections: number; max: number; moved: number; staminaMin: number }> {
  let r = 7; const rng = (): number => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const local = await createLocalServer({ store: new MemoryWorldStore(), seed: 5, bots: 0, maxBots: 0, rng, population: false });
  let buttons = 0;
  const session = new ClientSession({ storage: new S(), slot: "1", sampleInput: () => ({ buttons, aimX: 0, aimY: 0 }) });
  const c = session.connect("local", "T", local.createTransport());
  let world; for (let i = 0; i < 50 && !world; i++) { local.pump(5); world = await Promise.race([c, Promise.resolve(undefined)]); }
  world ??= await c;
  // Task 14: a real client sends gameplay.ready once its loading screen dismisses; without it the server
  // freezes the joining player's vitals (stamina would never drain). The harness models that lifecycle.
  session.client!.sendCommand(gameplayNet(readyIntent().cmd), {});
  for (let i = 0; i < 5; i++) local.pump(5);
  const loop = createGameLoop(world);
  let tc = 0, ts = 0, corrections = 0, max = 0, x0 = 0, staminaMin = 100;
  for (let f = 0; f < 1100; f++) {
    if (f === 100) { buttons = Act.MoveRight; x0 = world.get(session.player!, Transform)!.x; }
    if (f === 700) buttons = Act.MoveUp; if (f === 1000) buttons = 0;
    const fdt = jitter ? 16.7 + (rng() - 0.5) * 8 + (f % 97 === 0 ? 60 : 0) : 1000 / 60;
    tc += fdt;
    while (ts + 8 <= tc) { const sdt = 8 + (jitter ? (rng() - 0.5) * 6 + (rng() < 0.01 ? 150 : 0) : 0); ts += sdt; local.pump(sdt); }
    session.client!.stats.maxCorrection = 0;
    loop.advance(fdt); session.poll(); await Promise.resolve();
    const m = session.client!.stats.maxCorrection; if (f > 100 && m > 2e-3) corrections++; max = Math.max(max, f > 100 ? m : 0);
    const p = session.player; if (p !== undefined) staminaMin = Math.min(staminaMin, world.getField(p, Survival, "stamina") ?? 100);
  }
  const moved = Math.abs(world.get(session.player!, Transform)!.x - x0);
  session.disconnect(); await local.stop();
  return { corrections, max, moved, staminaMin };
}

describe("ADR-147 singleplayer prediction", () => {
  for (const jitter of [false, true]) it(`sprint to empty stamina and back: no visible corrections (${jitter ? "jittery worker clock" : "steady clock"})`, async () => {
    const res = await runSp(jitter);
    expect(res.staminaMin).toBe(0); // the run really drained stamina (sprint end + regen + re-sprint happened)
    expect(res.moved).toBeGreaterThan(10);
    expect(res.corrections).toBe(0);
    expect(res.max).toBeLessThan(2e-3);
  }, 60000);
});
