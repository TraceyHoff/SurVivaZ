/**
 * ADR-492: bleeding wounds — a heavy hit (post-armor >= 15 damage, ~25% chance, Combat/Contact/
 * Fall only) can leave a survivor bleeding. Bleeding drains 0.4 HP/s and never expires on its
 * own (durationSeconds 0); a medicated bandage cures it outright, a plain bandage staunches it
 * for a minute (drain paused, then resumes). Zombies and animals cannot bleed (Survival guard);
 * damage from disease or starvation never causes bleeding; a rider hit rolls once (the mount
 * takes no roll — it has no Survival in any case).
 *
 * Guide: bleeding has a cure line only, following the exhaustion precedent for duration-0
 * diseases — a duration fact would render "0 s", which is wrong for a wound that never heals
 * on its own. The Guide text line explains the staunch.
 */
import { describe, it, expect } from "vitest";
import { DamageCause } from "../src/components.js";
import * as G from "../src/index.js";
import { resolveGuideFact } from "../src/guide.js";
import { makeWorld, steps } from "./helpers.js";

const bleed = (w: ReturnType<typeof makeWorld>) => G.gameplayDefs(w).diseases.find((d) => d.key === "bleeding")!;

const hit = (w: ReturnType<typeof makeWorld>, p: number, z: number, amount: number, cause: DamageCause) => {
  G.applyDamage(w, p, amount, z, cause);
  w.set(p, G.Health, { hp: 100 });
};

describe("ADR-492 bleeding wounds", () => {
  it("bleeding is data: hpDps 0.4, never expires on its own, cured by medicated bandage", () => {
    const w = makeWorld();
    const def = bleed(w);
    expect(def.hpDps).toBe(0.4);
    expect(def.durationSeconds).toBe(0);
    expect(def.cure).toBe("medicated_bandage");
    const bleedTun = G.gameplayDefs(w).diseaseTuning.bleed;
    expect(bleedTun.chance).toBe(0.25);
    expect(bleedTun.minDamage).toBe(15);
    const med = G.defaultDefs().items.get(G.defaultDefs().itemId("medicated_bandage"))!;
    expect(med.cures).toContain("bleeding");
  });

  it("heavy hits can bleed: 40 hits of 20 damage leave the player bleeding", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 1, 0);
    for (let i = 0; i < 40; i++) hit(w, p, z, 20, DamageCause.Combat);
    expect(G.hasDisease(w, p, "bleeding")).toBe(true);
  });

  it("light hits never bleed: 40 hits of 10 damage leave the player clean", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 1, 0);
    for (let i = 0; i < 40; i++) hit(w, p, z, 10, DamageCause.Combat);
    expect(G.hasDisease(w, p, "bleeding")).toBe(false);
  });

  it("starvation and fire damage never bleed, however heavy", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 1, 0);
    for (let i = 0; i < 40; i++) hit(w, p, z, 20, DamageCause.Starvation);
    for (let i = 0; i < 40; i++) hit(w, p, z, 20, DamageCause.Fire);
    expect(G.hasDisease(w, p, "bleeding")).toBe(false);
  });

  it("zombies cannot bleed: contractDisease refuses and heavy hits leave them clean", () => {
    const w = makeWorld();
    const z = G.spawnZombie(w, "zombie_walker", 1, 0);
    expect(G.contractDisease(w, z, "bleeding")).toBe(false);
    const z2 = G.spawnZombie(w, "zombie_walker", 2, 0);
    for (let i = 0; i < 40; i++) { G.applyDamage(w, z2, 20, z, DamageCause.Combat); w.set(z2, G.Health, { hp: 100 }); }
    expect(G.hasDisease(w, z2, "bleeding")).toBe(false);
  });

  it("bleeding drains 0.4 HP/s and never expires on its own", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "bleeding")).toBe(true);
    w.set(p, G.Health, { hp: 100 });
    for (let i = 0; i < 100; i++) G.diseaseSystem(w, 0.05);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(98, 2);
    expect(G.hasDisease(w, p, "bleeding")).toBe(true);
  });

  it("a plain bandage staunches the drain for a minute, then it resumes", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const bandage = G.defaultDefs().itemId("bandage");
    expect(G.contractDisease(w, p, "bleeding")).toBe(true);
    w.set(p, G.Health, { hp: 100 });
    G.cureDiseasesForItem(w, p, bandage);
    expect(G.isBleedingStaunched(w, p)).toBe(true);
    expect(G.hasDisease(w, p, "bleeding")).toBe(true);
    for (let i = 0; i < 100; i++) G.diseaseSystem(w, 0.05);
    expect(w.getField(p, G.Health, "hp")).toBeCloseTo(100, 4);
    // 61 s later the staunch has worn off and the drain resumes.
    w.tick += 61 * 20;
    for (let i = 0; i < 100; i++) G.diseaseSystem(w, 0.05);
    expect(G.isBleedingStaunched(w, p)).toBe(false);
    expect(G.hasDisease(w, p, "bleeding")).toBe(true);
    expect(w.getField(p, G.Health, "hp")!).toBeLessThan(99.5);
  });

  it("a medicated bandage cures bleeding outright", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const med = G.defaultDefs().itemId("medicated_bandage");
    expect(G.contractDisease(w, p, "bleeding")).toBe(true);
    const cured = G.cureDiseasesForItem(w, p, med);
    expect(cured).toContain("bleeding");
    expect(G.hasDisease(w, p, "bleeding")).toBe(false);
  });

  it("Guide names the medicated bandage as the bleeding cure", () => {
    expect(resolveGuideFact("diseases.bleeding.cure", "item")).toBe("Medicated Bandage");
    expect(resolveGuideFact("diseases.count", "count")).toBe("9");
  });

  it("steps() runs the bleed drain in a live world", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.contractDisease(w, p, "bleeding")).toBe(true);
    w.set(p, G.Health, { hp: 100 });
    steps(w, 100);
    expect(w.getField(p, G.Health, "hp")!).toBeLessThan(100);
  });
});
