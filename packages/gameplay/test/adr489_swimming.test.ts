/**
 * ADR-489: swimming costs stamina; deep water can drown you. A swimmer drains 4 stamina/s in deep
 * water (treading water counts); at zero stamina the swimmer crawls at half swim speed and drowns
 * at 1 HP/s. No stamina regen mid-lake: the swim branch holds the regen delay even at zero stamina
 * (unlike sprinting, a swimmer cannot stop). Shallow water and land cost nothing; frozen water reads
 * as land. Players and AI-human bots both flow through vitalsSystem (bots spawn via spawnPlayer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

// lake (ADR-181): water for 0 <= x < 20, grass elsewhere. Shallow x 0..1 and 18..19; deep x 2..17.
const lake = (tx: number): number => (tx >= 0 && tx < 20 ? 1 : 3);
function world() {
  const w = makeWorld();
  w.setResource(G.TerrainRes, { tileAt: (tx: number) => lake(tx), heightAt: () => 0 });
  return w;
}
const staminaOf = (w: ReturnType<typeof makeWorld>, p: number): number =>
  w.getField(p, G.Survival, "stamina")!;
const hpOf = (w: ReturnType<typeof makeWorld>, p: number): number =>
  w.getField(p, G.Health, "hp")!;
const R = G.GameplayActions.MoveDown | G.GameplayActions.MoveRight;

describe("ADR-489 swimming costs stamina; deep water can drown you", () => {
  it("data: swim drain 4/s, drowning 1 HP/s, exhausted crawl is half swim speed", () => {
    const w = makeWorld();
    const vt = G.gameplayDefs(w).vitals;
    expect(vt.swimStaminaDrainPerSec).toBe(4);
    expect(vt.drownDps).toBe(1);
    expect(G.defaultDefs().movement.exhaustedSwimMul).toBe(0.5);
  });

  it("deep water drains 4 stamina/s; shallow water and land cost nothing", () => {
    const w = world();
    const deep = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    const shallow = G.spawnPlayer(w, { x: 0.5, y: 5.5 });
    const land = G.spawnPlayer(w, { x: -5.5, y: 5.5 });
    steps(w, 20); // 1 s
    expect(staminaOf(w, deep)).toBeCloseTo(96, 1);
    expect(staminaOf(w, shallow)).toBe(100);
    expect(staminaOf(w, land)).toBe(100);
  });

  it("no mid-lake regen: stamina hits zero and stays zero while swimming", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    w.setField(p, G.Survival, "stamina", 10);
    steps(w, 100); // 5 s: 2.5 s to drain, then 2.5 s at zero
    expect(staminaOf(w, p)).toBe(0);
    expect(hpOf(w, p)).toBeLessThan(99); // drowning while exhausted
  });

  it("an exhausted swimmer drowns at 1 HP/s with cause Drowning", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    w.setField(p, G.Survival, "stamina", 0);
    steps(w, 20); // 1 s
    expect(hpOf(w, p)).toBeCloseTo(99, 1);
    expect(w.getField(p, G.VitalsState, "lastDamageCause")).toBe(G.DamageCause.Drowning);
  });

  it("an exhausted swimmer with 5 HP drowns to death in deep water", () => {
    const w = world();
    const p = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    w.setField(p, G.Survival, "stamina", 0);
    w.set(p, G.Health, { hp: 5 });
    steps(w, 200); // 10 s: 5 HP at 1/s
    expect(w.has(p, G.Dead)).toBe(true);
    expect(w.getField(p, G.Dead, "cause")).toBe(G.DamageCause.Drowning);
  });

  it("an exhausted swimmer crawls at half swim speed", () => {
    const w = world();
    const fresh = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    const tired = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    w.setField(tired, G.Survival, "stamina", 0);
    const dx = (p: number): number => {
      const a = w.get(p, Transform)!.x;
      G.applyMovementInput(w, p, R, 0.05);
      const d = w.get(p, Transform)!.x - a;
      w.set(p, Transform, { x: 10.5, y: 5.5 });
      return d;
    };
    expect(dx(tired) / dx(fresh)).toBeCloseTo(0.5, 2);
  });

  it("AI-human bots drain too (they spawn via spawnPlayer, so they flow through vitalsSystem)", () => {
    const w = world();
    const bot = G.spawnPlayer(w, { x: 10.5, y: 5.5 });
    G.setAiHumanPredicate(w, (e) => e === bot);
    steps(w, 20);
    expect(staminaOf(w, bot)).toBeCloseTo(96, 1);
  });

  it("Guide warns about swimming stamina and drowning", () => {
    const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../data/guide.json"), "utf8"));
    const sec = raw.sections.find((s: { id: string }) => s.id === "seasons-weather");
    expect(sec.items.some((i: { text?: string }) => (i.text ?? "").includes("Swimming drains stamina"))).toBe(true);
  });
});
