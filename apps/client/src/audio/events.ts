/**
 * ADR-117 gameplay -> sound event mapping. Runs on the client against replicated state only (snapshot diffs of
 * networked components), so every peer hears the same events with no new netcode traffic. Pure: the director takes
 * plain per-frame entity snapshots (see snapshot.ts) and returns one-shot events + the set of desired loops.
 */
import type { Vec2 } from "./spatial.js";

export type EntKind = "player" | "zombie" | "animal" | "vehicle" | "piece" | "node" | "crop" | "explosive" | "fire" | "lootbag";
export interface EntSnap {
  id: number; kind: EntKind; x: number; y: number; z: number;
  /** player: weapon class of the held item; zombie: kind (walker/runner/brute/snuffer); animal: species; vehicle: class; piece: key; node: gather class. */
  sub: string;
  anim?: number; animStart?: number; hp?: number; dead?: boolean; indoors?: boolean;
  door?: number; lit?: number; material?: string;
  crop?: { kind: number; stage: number; water: number };
  reload?: number; charge?: number; ready?: number; amount?: number;
  vehicle?: { speed: number; maxSpeed: number; engineOn: boolean; seats: number; lights: boolean };
  crafting?: { recipe: number; start: number; total: number; cooking: boolean };
  hunger?: number; thirst?: number; level?: number; combatTag?: boolean; local?: boolean; surface?: string; explosiveFire?: boolean;
}
export interface SoundEvent { key: string; pos?: Vec2; indoors?: boolean; gain?: number; pitch?: number; /** ADR-214: EntSnap id of the emitter (VFX facing / attribution). */ src?: number }
export interface LoopSpec { id: string; key: string; pos?: Vec2; indoors?: boolean; gain: number; pitch?: number }

/** Anim ids (core AnimState, wire-stable). */
export const A = { Idle: 0, Walk: 1, Run: 2, Attack: 3, Hurt: 4, Die: 5, Gather: 6, Build: 7, Eat: 8, Swim: 14, Punch: 15, Harvest: 16, Chop: 17, Mine: 18, Drink: 19 } as const;
const RANGED = new Set(["bow", "crossbow", "sling", "pistol", "rifle", "autorifle", "shotgun", "musket"]);
const FAMILY_CLASS: Record<string, string> = { sword: "blade", knife: "blade", dagger: "blade", machete: "blade", bayonet: "blade", bat: "blunt", mace: "blunt", maul: "blunt",
  axe: "axe", throwing_axe: "axe", pickaxe: "pickaxe", spear: "spear", shovel: "shovel", bow: "bow", crossbow: "crossbow", sling: "sling", pistol: "pistol", rifle: "rifle", autorifle: "autorifle", shotgun: "shotgun", musket: "musket" };
/** Item family -> weapon sound class ("fists" when empty / non-weapon). */
export const weaponClass = (family: string | undefined): string => (family && FAMILY_CLASS[family]) || "fists";
export const isRanged = (cls: string): boolean => RANGED.has(cls);
/** Terrain tile id (1 water, 2 sand, 3 grass, 4 dirt/forest floor, 5 stone) -> footstep surface. */
export function surfaceOf(tile: number, floorMaterial?: string): string {
  if (floorMaterial) return floorMaterial === "stone" || floorMaterial === "metal" ? "stone" : "wood";
  return tile === 1 || tile === 8 ? "water" : tile === 2 ? "sand" : tile === 3 ? "grass" : tile === 4 || tile === 7 || tile === 9 ? "dirt" : tile === 5 ? "stone" : "grass"; // 9 = mud (ADR-246)
}
/** Tier index (twig wood stone metal reinforced) -> material. */
export const tierMaterial = (tier: number): string => (tier <= 1 ? "wood" : tier === 2 ? "stone" : "metal");
/** ADR-314: door SFX set for a piece key: garden and clan gates use the gate set; doors, hatches, shutters and hall doors the swing set. */
export const doorSfxClass = (pieceKey: string): "gate" | "swing" => (pieceKey === "gate_clan" || pieceKey.startsWith("garden_gate") ? "gate" : "swing");
/** Bank key for a door state change (bank.json door.open.swing / door.close.swing / door.open.gate / door.close.gate). */
export const doorSfxKey = (pieceKey: string, open: boolean): string => `door.${open ? "open" : "close"}.${doorSfxClass(pieceKey)}`;
export const STEP_DIST = { walk: 0.95, run: 1.35, zombie: 1.1, animal: 0.8 };

interface Mem { stepAcc: number; lastX: number; lastY: number; nextVocal: number; lastChase: number; lastAttackAt: number }
export interface DirectorCtx { now: number; listener: Vec2; hearing?: number; rng?: () => number }

export class AudioDirector {
  private prev = new Map<number, EntSnap>();
  private mem = new Map<number, Mem>();
  private startedAt: number | undefined;
  /** Seconds after the first frame during which spawns/despawns (initial interest load) are silent. */
  settleSec = 2;
  private m(e: EntSnap, now: number, rng: () => number): Mem { let r = this.mem.get(e.id); if (!r) { r = { stepAcc: 0, lastX: e.x, lastY: e.y, nextVocal: now + 3 + rng() * 10, lastChase: -99, lastAttackAt: -99 }; this.mem.set(e.id, r); } return r; }

  step(cur: readonly EntSnap[], c: DirectorCtx): { events: SoundEvent[]; loops: LoopSpec[] } {
    const rng = c.rng ?? Math.random; const now = c.now; this.startedAt ??= now; const hear = c.hearing ?? 22;
    const settled = now - this.startedAt >= this.settleSec;
    const out: SoundEvent[] = []; const loops: LoopSpec[] = [];
    const curMap = new Map(cur.map((e) => [e.id, e]));
    const near = (e: { x: number; y: number }, r = hear): boolean => Math.hypot(e.x - c.listener.x, e.y - c.listener.y) <= r;
    const at = (e: EntSnap, key: string, extra: Partial<SoundEvent> = {}): void => { out.push({ key, pos: { x: e.x, y: e.y }, indoors: !!e.indoors, src: e.id, ...extra }); };
    const vocalKey = (e: EntSnap, what: string): string | undefined => e.kind === "player" ? `player.${what}` : e.kind === "zombie" ? `zombie.${e.sub}.${what}` : e.kind === "animal" ? `animal.${e.sub}.${what}` : undefined;
    // recent attackers (for per-class hit sounds)
    const attackers: EntSnap[] = [];
    let spawnCount = 0; for (const e of cur) if (!this.prev.has(e.id)) spawnCount++;
    const bulkSpawn = spawnCount > 6;

    for (const e of cur) {
      const p = this.prev.get(e.id); const mem = this.m(e, now, rng); const audible = near(e);
      const animStarted = p !== undefined && e.anim !== undefined && (e.anim !== p.anim || e.animStart !== p.animStart);
      const fresh = !p && settled && !bulkSpawn && near(e, 12);
      // ---- footsteps (distance travelled; players by surface, zombies shuffle, animals light) ----
      if (e.kind === "player" || e.kind === "zombie" || e.kind === "animal") {
        const d = Math.hypot(e.x - mem.lastX, e.y - mem.lastY); mem.lastX = e.x; mem.lastY = e.y;
        if (d < 3 && !e.dead && audible) {
          mem.stepAcc += d;
          const swim = e.anim === A.Swim; const run = e.anim === A.Run;
          const stride = swim ? 1.6 : e.kind === "zombie" ? STEP_DIST.zombie : e.kind === "animal" ? STEP_DIST.animal : run ? STEP_DIST.run : STEP_DIST.walk;
          if (mem.stepAcc >= stride) { mem.stepAcc = 0;
            const key = swim ? "footstep.swim" : e.kind === "zombie" ? "footstep.zombie" : e.kind === "animal" ? "footstep.animal" : `footstep.${e.surface ?? "grass"}`;
            if (e.kind !== "animal" || near(e, 8)) at(e, key, { gain: run ? 1.15 : 1 }); }
        } else if (d >= 3) mem.stepAcc = 0;
      }
      // ---- attacks ----
      if (animStarted && (e.anim === A.Attack || e.anim === A.Punch)) {
        mem.lastAttackAt = now; attackers.push(e);
        if (audible) {
          if (e.kind === "player") { const cls = e.anim === A.Punch ? "fists" : e.sub; at(e, isRanged(cls) ? `weapon.fire.${cls}` : `combat.swing.${cls}`); }
          else if (e.kind === "zombie") at(e, `zombie.${e.sub}.attack`);
          else if (e.kind === "animal") at(e, "animal.attack");
        }
      } else if (now - mem.lastAttackAt < 0.7) attackers.push(e);
      if (!audible) { continue; }
      // ---- gather / build / eat anims ----
      if (animStarted && (e.anim === A.Gather || e.anim === A.Harvest || e.anim === A.Chop || e.anim === A.Mine)) { const node = nearest(cur, e, "node", 2.5); at(e, node ? `gather.${node.sub}` : "gather.harvest"); }
      if (animStarted && e.anim === A.Eat && e.kind === "player" && !e.local) at(e, "consume.eat");
      if (animStarted && e.anim === A.Drink && e.kind === "player" && !e.local) at(e, "consume.drink");
      if (e.local && p) {
        if (e.hunger !== undefined && p.hunger !== undefined && e.hunger - p.hunger >= 2) at(e, "consume.eat");
        if (e.thirst !== undefined && p.thirst !== undefined && e.thirst - p.thirst >= 2) at(e, "consume.drink");
        if (e.level !== undefined && p.level !== undefined && e.level > p.level) out.push({ key: "ui.levelup" });
      }
      // ---- weapons: reload / bow draw ----
      if (e.kind === "player" && p) {
        if ((e.reload ?? 0) > (p.reload ?? 0)) at(e, `weapon.reload.${e.sub}`);
        if ((e.charge ?? 0) > (p.charge ?? 0) && (e.sub === "bow" || e.sub === "crossbow")) at(e, "weapon.draw.bow");
      }
      // ---- crafting / cooking ----
      if (e.crafting) {
        if (!p?.crafting || p.crafting.start !== e.crafting.start) at(e, e.crafting.cooking ? "fire.ignite" : "craft.start", e.crafting.cooking ? { gain: 0.3 } : {});
        loops.push({ id: `craft:${e.id}`, key: e.crafting.cooking ? "cook.sizzle" : "craft.loop", pos: { x: e.x, y: e.y }, indoors: !!e.indoors, gain: 1 });
      } else if (p?.crafting) at(e, p.crafting.cooking ? "cook.complete" : "craft.complete");
      // ---- damage / death ----
      if (p && e.hp !== undefined && p.hp !== undefined && e.hp < p.hp - 1e-3 && !e.dead) {
        if (e.kind === "piece") at(e, "combat.hit.structure");
        else { const atk = nearestOf(attackers.length ? attackers : cur.filter((o) => o.id !== e.id && (o.anim === A.Attack || o.anim === A.Punch)), e, 3, e.id);
          const cls = atk?.kind === "player" ? (atk.anim === A.Punch ? "fists" : atk.sub) : undefined;
          at(e, cls === "fists" ? "combat.punch.hit" : cls === undefined ? "combat.hit" : isRanged(cls) ? (cls === "bow" || cls === "crossbow" || cls === "sling" ? "combat.hit.arrow" : "combat.hit.bullet") : `combat.hit.${cls}`);
          const v = vocalKey(e, "hurt"); if (v) at(e, v); }
      }
      if (e.dead && p && !p.dead) { const v = vocalKey(e, "death"); if (v) at(e, v); if (e.local) out.push({ key: "music.stinger.death" }); }
      // ---- vocals: zombie groans/growls, animal calls ----
      if ((e.kind === "zombie" || e.kind === "animal") && !e.dead) {
        if (e.kind === "zombie" && e.anim === A.Run && p?.anim !== A.Run && now - mem.lastChase > 4) { mem.lastChase = now; at(e, `zombie.${e.sub}.chase`); mem.nextVocal = now + 4 + rng() * 6; }
        else if (now >= mem.nextVocal) { mem.nextVocal = now + (e.kind === "zombie" ? 5 + rng() * 10 : 10 + rng() * 20); if (e.kind === "zombie" || near(e, 12)) at(e, `${e.kind}.${e.sub}.idle`); }
      }
      // ---- doors, fire, defenses, crops, vehicles ----
      if (p && e.door !== undefined && p.door !== undefined && e.door !== p.door) at(e, doorSfxKey(e.sub, !!e.door)); // ADR-314: swing / gate sets
      if (e.lit !== undefined) {
        if (p && p.lit !== undefined && e.lit && !p.lit) at(e, "fire.ignite");
        if (p && p.lit && !e.lit) { const snuffer = cur.find((o) => o.kind === "zombie" && o.sub === "snuffer" && Math.hypot(o.x - e.x, o.y - e.y) < 3.5);
          if (snuffer) { at(snuffer, "zombie.snuffer.snuff"); at(e, "fire.snuffed"); } else at(e, "fire.extinguish"); }
        if (e.lit) loops.push({ id: `fire:${e.id}`, key: e.kind === "fire" ? "fire.burning" : "fire.crackle", pos: { x: e.x, y: e.y }, indoors: !!e.indoors, gain: 1 });
      }
      if (p && e.ready !== undefined && p.ready !== undefined && e.ready > p.ready) at(e, e.sub.includes("trap") ? (e.sub.includes("spike") ? "trap.spike" : "trap.snap") : e.sub.includes("gun") ? "turret.fire.gun" : "turret.fire");
      if (e.kind === "crop" && e.crop) {
        if (fresh) at(e, e.crop.kind === 0 ? "farm.till" : "farm.plant");
        else if (p?.crop) { if (p.crop.kind === 0 && e.crop.kind !== 0) at(e, "farm.plant"); if (e.crop.water > p.crop.water + 5) at(e, "farm.water"); if (e.crop.stage > p.crop.stage && near(e, 6)) at(e, "farm.grow"); }
      }
      if (e.kind === "node" && p && (p.amount ?? 0) > 0 && e.amount === 0) at(e, e.sub === "chop" ? "gather.tree_fall" : e.sub === "mine" ? "gather.rock_break" : "gather.harvest");
      if (e.kind === "piece" && fresh && !e.sub.includes("crop")) at(e, `build.place.${e.material ?? "wood"}`);
      if (e.kind === "explosive") loops.push({ id: `fuse:${e.id}`, key: "explosive.fuse", pos: { x: e.x, y: e.y }, gain: 1 });
      if (e.kind === "vehicle" && e.vehicle) {
        const v = e.vehicle; const ratio = v.maxSpeed > 0 ? Math.min(1, Math.abs(v.speed) / v.maxSpeed) : 0; const pos = { x: e.x, y: e.y };
        if (e.sub === "bicycle") { if (ratio > 0.05) loops.push({ id: `bike:${e.id}`, key: "vehicle.bicycle.ride", pos, gain: 0.4 + 0.6 * ratio, pitch: 0.8 + 0.6 * ratio }); }
        else if (e.sub !== "trailer") {
          if (p?.vehicle && v.engineOn !== p.vehicle.engineOn) at(e, v.engineOn ? "vehicle.engine.start" : "vehicle.engine.stop");
          if (v.engineOn) { const rpm = 0.8 + 0.8 * ratio;
            loops.push({ id: `veh:${e.id}:idle`, key: `vehicle.${e.sub}.idle`, pos, gain: Math.max(0.15, 1 - ratio), pitch: rpm });
            if (ratio > 0.05) loops.push({ id: `veh:${e.id}:rev`, key: `vehicle.${e.sub}.rev`, pos, gain: ratio, pitch: rpm }); }
          if (p?.vehicle && v.lights !== p.vehicle.lights && near(e, 6)) at(e, "vehicle.headlights");
        }
        if (p?.vehicle && v.seats !== p.vehicle.seats) at(e, e.sub === "bicycle" ? "vehicle.bicycle.mount" : v.seats > p.vehicle.seats ? "vehicle.door.close" : "vehicle.door.open");
      }
    }
    // ---- despawns: explosions, broken pieces, picked-up loot ----
    let gone = 0; for (const id of this.prev.keys()) if (!curMap.has(id)) gone++;
    if (settled && gone <= 6) for (const [id, p] of this.prev) {
      if (curMap.has(id) || !near(p)) continue;
      if (p.kind === "explosive") at(p, p.explosiveFire ? "explosion.fire" : "explosion", { gain: 1 });
      else if (p.kind === "piece" && near(p, 14) && !p.sub.includes("crop")) at(p, `build.break.${p.material ?? "wood"}`);
      else if (p.kind === "lootbag" && near(p, 2.5)) at(p, "item.pickup");
    }
    for (const id of this.mem.keys()) if (!curMap.has(id)) this.mem.delete(id);
    this.prev = curMap;
    return { events: out, loops };
  }
}
function nearest(all: readonly EntSnap[], e: EntSnap, kind: EntKind, r: number): EntSnap | undefined { return nearestOf(all.filter((o) => o.kind === kind), e, r, e.id); }
function nearestOf(all: readonly EntSnap[], e: { x: number; y: number }, r: number, not: number): EntSnap | undefined {
  let best: EntSnap | undefined; let bd = r; for (const o of all) { if (o.id === not) continue; const d = Math.hypot(o.x - e.x, o.y - e.y); if (d <= bd) { bd = d; best = o; } } return best;
}
