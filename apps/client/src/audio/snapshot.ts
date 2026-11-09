/** ADR-117 extracts audio-relevant entity snapshots from the replicated (net) world. Read-only; no netcode. */
import { Transform, type World, type Entity } from "@engine/core";
import { gameplayDefs, animalDefs, vehicleDef, Animal, Health, Survival, Zombie, ResourceNode, CraftingStation, Crafter, Fuel, Burning, AnimState, BuildPiece, Dead, Equipment,
  DoorState, AttachKind, resolveAttachment, Defense, Vehicle, VehicleSeats, VehicleState, WeaponState, LiveExplosive, Crop, Progression, CombatTag, LootBag } from "@engine/gameplay";
import { PlayerId } from "@engine/core";
import { weaponClass, surfaceOf, tierMaterial, type EntSnap } from "./events.js";
import type { Vec2 } from "./spatial.js";

export interface WorldAudioState { ents: EntSnap[]; listener: Vec2; indoors: boolean; threat: number; biome: { water: number; sand: number; forest: number; stone: number }; driving: boolean }
type Tiles = { getTile(x: number, y: number): number } | undefined;
const TOOL_GATHER = ["harvest", "chop", "mine", "dig", "pick"];
const ZKIND = (k: string): string => k.replace(/^zombie_/, "");

/** `now` (ADR-172): server tick for server-stamped expiries (a replica's world.tick counts from its join). */
export function snapshotWorld(w: World, local: Entity | undefined, tiles: Tiles, radius = 26, now = w.tick): WorldAudioState {
  let defs: ReturnType<typeof gameplayDefs> | undefined; try { defs = gameplayDefs(w); } catch { defs = undefined; }
  const lt = local !== undefined ? w.get(local, Transform) : undefined;
  const listener = { x: lt?.x ?? 0, y: lt?.y ?? 0 }; const lz = lt?.z ?? 0; const r2 = radius * radius;
  const ents: EntSnap[] = []; const roofs: { x: number; y: number; z: number }[] = []; const floors: { x: number; y: number; m: string }[] = [];
  let threat = 0; let driving = false;
  const zDefs = defs ? [...defs.zombies.values()] : []; const aDefs = animalDefs();
  for (const e of w.query([Transform])) {
    const t = w.get(e, Transform)!; const dx = t.x - listener.x, dy = t.y - listener.y; if (dx * dx + dy * dy > r2) continue;
    const s: EntSnap = { id: e as unknown as number, kind: "piece", x: t.x, y: t.y, z: t.z ?? 0, sub: "" };
    const anim = w.get(e, AnimState); if (anim) { s.anim = anim.anim; s.animStart = anim.startTick; }
    const hp = w.getField(e, Health, "hp"); if (hp !== undefined) s.hp = hp;
    if (w.has(e, Dead)) s.dead = true;
    if (w.has(e, PlayerId)) {
      s.kind = "player"; const it = w.getField(e, Equipment, "mainHandItem") ?? 0; s.sub = weaponClass(defs?.items.get(it)?.family);
      const ws = w.get(e, WeaponState); if (ws) { s.reload = ws.reloadUntilTick; s.charge = ws.chargeStartTick; }
      if (e === local) { s.local = true; const sv = w.get(e, Survival); if (sv) { s.hunger = sv.hunger; s.thirst = sv.thirst; } const lv = w.getField(e, Progression, "level"); if (lv !== undefined) s.level = lv;
        const ct = w.getField(e, CombatTag, "untilTick"); if (ct !== undefined && ct > now) { s.combatTag = true; threat = Math.max(threat, 0.4); } }
      s.surface = surfaceOf(tiles?.getTile(Math.floor(t.x), Math.floor(t.y)) ?? 3);
    } else if (w.has(e, Zombie)) {
      s.kind = "zombie"; const k = w.getField(e, Zombie, "kind") ?? 0; s.sub = ZKIND(defs?.zombies.get(k)?.key ?? zDefs[0]?.key ?? "walker");
      if (!s.dead) { const d = Math.hypot(dx, dy); if (d < 14) threat = Math.max(threat, Math.min(1, (14 - d) / 10) * (s.anim === 2 ? 1 : 0.5)); }
    } else if (w.has(e, Animal)) {
      s.kind = "animal"; const k = w.getField(e, Animal, "kind") ?? 0; s.sub = (aDefs[k]?.key ?? "animal_deer").replace(/^animal_/, "");
      if (w.getField(e, Animal, "state") === 3 && Math.hypot(dx, dy) < 10) threat = Math.max(threat, 0.4);
    } else if (w.has(e, Vehicle)) {
      const v = w.get(e, Vehicle)!; const def = vehicleDef(v.defId); const flags = w.getField(e, VehicleState, "flags") ?? 0;
      const seats = w.get(e, VehicleSeats) as unknown as { occupant?: ArrayLike<number> } | undefined; let n = 0; if (seats?.occupant) for (let i = 0; i < seats.occupant.length; i++) if (seats.occupant[i]) n++;
      s.kind = "vehicle"; s.sub = def?.class ?? "car"; s.vehicle = { speed: v.speed, maxSpeed: def?.maxSpeed ?? 10, engineOn: (flags & 1) !== 0, lights: (flags & 2) !== 0, seats: n };
      if (Math.hypot(dx, dy) < 1.2 && n > 0) driving = true;
    } else if (w.has(e, ResourceNode)) {
      s.kind = "node"; const rn = w.get(e, ResourceNode)!; s.amount = rn.amount; s.sub = TOOL_GATHER[defs?.resources.get(rn.kind)?.requiredTool ?? 0] ?? "harvest";
      if (s.sub === "harvest" && /bush|berr|flower|mushroom|herb/.test(defs?.resources.get(rn.kind)?.key ?? "")) s.sub = "pick";
    } else if (w.has(e, Crop)) { s.kind = "crop"; const c = w.get(e, Crop)!; s.crop = { kind: c.kind, stage: c.stage, water: c.waterUntilTick }; }
    else if (w.has(e, LiveExplosive)) { s.kind = "explosive"; const it = w.getField(e, LiveExplosive, "item") ?? 0; s.explosiveFire = /fire/.test(defs?.items.get(it)?.family ?? ""); }
    else if (w.has(e, LootBag)) s.kind = "lootbag";
    else if (w.has(e, BuildPiece)) {
      const bp = w.get(e, BuildPiece)!; const pd = defs?.pieces.get(bp.type); s.sub = pd?.key ?? "piece"; s.material = tierMaterial(bp.tier);
      if (pd?.roof) roofs.push({ x: t.x, y: t.y, z: t.z ?? 0 });
      if (pd && /floor|foundation/.test(pd.key)) floors.push({ x: t.x, y: t.y, m: s.material });
      if (pd?.door) { const a = resolveAttachment(w, e, AttachKind.Door); s.door = a !== undefined ? w.getField(a, DoorState, "open") ?? 0 : 0; } // ADR-314: DoorState is on the Door attachment
      if (w.has(e, Defense)) s.ready = w.getField(e, Defense, "readyTick") ?? 0;
    } else if (!w.has(e, Burning)) continue;
    if (w.has(e, Fuel)) s.lit = w.getField(e, Fuel, "lit") ?? 0;
    if (w.has(e, Burning)) { const b = w.getField(e, Burning, "lit") ?? 0; if (s.kind === "piece" && !w.has(e, Fuel)) { s.kind = "fire"; s.lit = b; } }
    const cr = w.get(e, Crafter); if (cr && cr.totalTicks > 0) s.crafting = { recipe: cr.recipe, start: cr.startTick, total: cr.totalTicks, cooking: (w.getField(e, CraftingStation, "kind") ?? 0) === 1 || defs?.recipes.get(cr.recipe)?.station === 1 };
    ents.push(s);
  }
  const under = (x: number, y: number, z: number): boolean => roofs.some((r) => r.z > z && Math.abs(r.x - x) < 0.9 && Math.abs(r.y - y) < 0.9);
  for (const s of ents) { if (s.kind === "player" || s.kind === "zombie" || s.kind === "fire" || s.crafting || s.lit !== undefined) s.indoors = under(s.x, s.y, s.z);
    if (s.kind === "player") { const f = floors.find((p) => Math.abs(p.x - s.x) < 0.7 && Math.abs(p.y - s.y) < 0.7); if (f) s.surface = surfaceOf(0, f.m); } }
  // biome mix: sample a sparse 11x11 grid (step 2) around the listener
  const biome = { water: 0, sand: 0, forest: 0, stone: 0 }; let n = 0;
  if (tiles) for (let oy = -10; oy <= 10; oy += 2) for (let ox = -10; ox <= 10; ox += 2) { const tl = tiles.getTile(Math.floor(listener.x) + ox, Math.floor(listener.y) + oy); n++;
    if (tl === 1) biome.water++; else if (tl === 2) biome.sand++; else if (tl === 4) biome.forest++; else if (tl === 5) biome.stone++; }
  if (n) { biome.water /= n; biome.sand /= n; biome.forest /= n; biome.stone /= n; }
  return { ents, listener, indoors: lt ? under(listener.x, listener.y, lz) : false, threat, biome, driving };
}
