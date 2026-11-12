/**
 * ADR-113 minimal domestication: Use animal_feed next to a passive farm animal (skill husbandry >= 1) -> chance to tame
 * (Tamed persists, despawn skipped, threat scan off, leashed wander). Feeding keeps it "fed"; fed tamed animals within
 * troughRange of a feeding_trough produce eggs/milk/wool into the trough container; with the breeding perk two fed animals
 * of one kind at a trough breed (cap maxPerTrough). Fences + trough = pen. Animal/AnimState are re-added after a load.
 * Task 28: hay in a trough feeds hungry animals (1 hay = the usual fedSeconds); with no food at all a hungry animal
 * grazes the grass tile it stands on — 20s of grazing feeds it and depletes the tile (bare 180s, then grass regrows).
 */
import { DEFAULT_TICK_HZ, entityIndex, PlayerId, Transform, type Entity, type World } from "@engine/core";
import { Animal, AnimState, AttachKind, BuildPiece, Dead, Equipment, GrazedTile, Grazing, IntentAction, PieceOwner, PlayerIntent, Tamed, AnimalSkills, Tribe, TroughOwner, Worker } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { emit, ev } from "../events.js";
import { addItem, canAddItem, countItem, removeItem, slotItem, takeFromSlot } from "../inventory.js";
import { animalDefs, spawnAnimal } from "../population.js";
import { awardXp } from "./progression.js";
import { animalSkillMods, awardAnimalXp, ensureAnimalSkills } from "../animal_skills.js";
import { hasPerk, SKILLS, skillLevelOf, skillMod } from "./tree.js";
import { pieceOf, resolveAttachment } from "../building/links.js";
import { StructureIndexRes } from "../building/structure.js";
import { tamedOwnerTribe } from "../territory.js";
import { indexEntity } from "../spawn.js";
import { TerrainRes } from "../world.js";

const H = SKILLS.husbandry;
export const AnimalTamed = ev<{ entity: Entity; animal: Entity }>("gameplay.AnimalTamed");
export const AnimalBred = ev<{ owner: Entity; baby: Entity }>("gameplay.AnimalBred");
export const enum TameFail { None = 0, NoAnimal = 1, NotDomestic = 2, NeedsSkill = 3, Failed = 4, NotYours = 5 }
export const TAME_FAIL_TEXT: Readonly<Record<number, string>> = {
  [TameFail.NoAnimal]: "No animal close enough", [TameFail.NotDomestic]: "This animal can't be domesticated",
  [TameFail.NeedsSkill]: "Needs Animal Husbandry skill", [TameFail.Failed]: "It shied away — try again", [TameFail.NotYours]: "Someone else's animal",
};
const domestic = (kind: number): boolean => { const k = animalDefs()[kind]?.key; return !!k && k in H.animals; };
/** Task 28: a live domestic (farm) animal — cow, goat, sheep, chicken, duck, goose, turkey. */
export const isDomesticAnimal = (world: World, e: Entity): boolean => { const k = world.getField(e, Animal, "kind"); return k !== undefined && domestic(k); };
const sec = (s: number): number => Math.round(s * DEFAULT_TICK_HZ);

/** Nearest live animal within reach of e (deterministic tie-break by id). */
export function animalNear(world: World, e: Entity, r = H.reach): Entity | undefined {
  const t = world.get(e, Transform); if (!t) return undefined; let best: Entity | undefined, bd = r * r;
  for (const a of world.query([Animal, Transform], [Dead])) { const at = world.get(a, Transform)!; const d = (at.x - t.x) ** 2 + (at.y - t.y) ** 2; if (d <= bd && (best === undefined || d < bd || a < best)) { bd = d; best = a; } }
  return best;
}
/** ADR-234: taming chance for e (base x (1 + "tame" mod), capped at 95%). */
export const livestockTameChance = (world: World, e: Entity): number => Math.min(0.95, H.tameBase * (1 + skillMod(world, e, "tame")));
/** ADR-234: Husbandry 2 ("pens"): an owner's tamed animals settle, produce and breed at feeding troughs. Owners without
 *  Progression (NPCs, legacy) or offline owners (no live entity to read) are not gated. */
export const canUsePens = (world: World, owner: Entity): boolean => !owner || !world.isAlive(owner) || (skillLevelOf(world, owner, "husbandry") ?? 2) >= 2;
/** Dry-run (dryRun) or perform feeding/taming of the animal in front. Returns failure and whether feed should be consumed. */
export function feedAnimal(world: World, e: Entity, dryRun = false): { fail: TameFail; tame: boolean; consumed: boolean } {
  const a = animalNear(world, e); if (a === undefined) return { fail: TameFail.NoAnimal, tame: false, consumed: false };
  const tamed = world.get(a, Tamed);
  if (tamed) {
    if (tamed.owner !== e && tamed.owner !== 0) return { fail: TameFail.NotYours, tame: false, consumed: false };
    if (!dryRun) { world.set(a, Tamed, { fedUntil: world.tick + sec(H.fedSeconds) }); awardXp(world, e, "husbandry"); awardAnimalXp(world, a, gameplayDefs(world).animalSkillsTuning.xp.feedXp); }
    return { fail: TameFail.None, tame: false, consumed: true };
  }
  const kind = world.get(a, Animal)!.kind; if (!domestic(kind)) return { fail: TameFail.NotDomestic, tame: true, consumed: false };
  if ((skillLevelOf(world, e, "husbandry") ?? 1) < 1) return { fail: TameFail.NeedsSkill, tame: true, consumed: false };
  if (dryRun) return { fail: TameFail.None, tame: true, consumed: true };
  const chance = livestockTameChance(world, e);
  if (world.rngFor(`husbandry.tame.${world.tick}`, a).next() >= chance) return { fail: TameFail.Failed, tame: true, consumed: true };
  const now = world.tick; const p = H.animals[animalDefs()[kind]!.key]!;
  world.add(a, Tamed, { kind, owner: e, fedUntil: now + sec(H.fedSeconds), produceAt: now + sec(p.seconds), breedAt: now + sec(H.breedSeconds) });
  ensureAnimalSkills(world, a); // Task 15: fresh farm animal starts with its level-1 skill point
  emit(world, AnimalTamed, { entity: e, animal: a }); awardXp(world, e, "tame");
  return { fail: TameFail.None, tame: true, consumed: true };
}

/** ADR-353: feeding-trough storage attachments (the entities holding the food), exported for mountSystem's trough eating. */
export function feedingTroughs(world: World): Entity[] {
  let id: number; try { id = gameplayDefs(world).pieceId(H.trough); } catch { return []; }
  // Task 28 fix: the trough's Container lives on its storage attachment, not the piece (placePiece/spawnAttachments) —
  // the old [BuildPiece, Transform, Container] query matched NO real placed trough, so trough production never ran
  // in live play (tests used synthetic troughs with Container on the piece). resolveAttachment returns the
  // attachment for real troughs and the piece itself when it carries a Container directly, so both work; either
  // way the returned entity is the one holding the food.
  const out: Entity[] = [];
  for (const b of world.query([BuildPiece, Transform], [Dead])) {
    if (world.get(b, BuildPiece)!.type !== id) continue;
    const att = resolveAttachment(world, b, AttachKind.Storage);
    if (att !== undefined) out.push(att);
  }
  return out.sort((x, y) => x - y);
}
/** Task 34: the Apiary piece key (packages/gameplay/data/pieces.json). Bees deposit honey here instead of a trough. */
export const APIARY_PIECE = "apiary";
/** ADR-368: trough / apiary station lists, cached per StructureIndex version (pieces only change
 * when the index version bumps — the same convention as autonomy's pieceAt memo; worlds without an
 * index scan fresh, as before). Entries are re-validated with isAlive on read. */
const stationCache = new WeakMap<World, { version: number; troughs: Entity[]; apiaries: Entity[] }>();
function stationLists(world: World): { troughs: Entity[]; apiaries: Entity[] } {
  const si = world.getResource(StructureIndexRes);
  if (!si) return { troughs: feedingTroughs(world), apiaries: apiaries(world) };
  let c = stationCache.get(world);
  if (!c || c.version !== si.version) { c = { version: si.version, troughs: feedingTroughs(world), apiaries: apiaries(world) }; stationCache.set(world, c); }
  return c;
}
/** Task 34: Apiary storage attachments, same shape as troughs() (Container on the storage attachment, Task 28 lesson). */
function apiaries(world: World): Entity[] {
  let id: number; try { id = gameplayDefs(world).pieceId(APIARY_PIECE); } catch { return []; }
  const out: Entity[] = [];
  for (const b of world.query([BuildPiece, Transform], [Dead])) {
    if (world.get(b, BuildPiece)!.type !== id) continue;
    const att = resolveAttachment(world, b, AttachKind.Storage);
    if (att !== undefined) out.push(att);
  }
  return out.sort((x, y) => x - y);
}
/** Task 28: hay (the trough-feed item); 1 hay feeds one farm animal for the usual fedSeconds (600s). */
export const HAY_ITEM = "hay";
// ---- ADR-353: wider trough diets + trough ownership -------------------------------------------------------
/** A farm-animal kind's hunger diet (skills.json `husbandry.animals[].diet`) — the crops it eats from a trough when
 *  hungry. Hay stays first for grazers, so the old hay-only behaviour is the diet's head; the bee keeps hay only,
 *  which preserves exactly what it ate before (its produce still needs a fed window). */
export const farmAnimalDiet = (kindKey: string | undefined): readonly string[] => (kindKey ? H.animals[kindKey]?.diet ?? [] : []);
/** PlayerId a tamed animal belongs to (Tamed.owner is the owner entity, not a PlayerId). A hired worker's animals
 *  count as the employer's — the same rule as mountOwnerIdFor — otherwise a worker-tamed cow could never eat from
 *  its employer's trough. 0 when the owner entity is gone (offline / legacy): the animal then eats only from
 *  unowned troughs. */
export function tamedOwnerId(world: World, a: Entity): number {
  const owner = world.getField(a, Tamed, "owner"); if (owner === undefined || !world.isAlive(owner)) return 0;
  if (world.isRegistered(Worker) && world.has(owner, Worker)) { const boss = world.getField(owner, Worker, "owner") ?? 0; if (boss) return boss; }
  return world.isRegistered(PlayerId) && world.has(owner, PlayerId) ? world.getField(owner, PlayerId, "id") ?? 0 : 0;
}
/** The PlayerId that owns a trough's food: the piece's PieceOwner (set at placement), else a TroughOwner on the
 *  holder itself for synthetic / directly-containered troughs. 0 = unowned (worldgen / abandoned / test trough). */
export function troughOwnerId(world: World, holder: Entity): number {
  const piece = world.has(holder, BuildPiece) ? holder : pieceOf(world, holder);
  if (piece !== undefined) return world.getField(piece, PieceOwner, "player") ?? 0;
  return world.getField(holder, TroughOwner, "player") ?? 0;
}
/** The tribe that owns a trough (the piece's Tribe, set at placement from the builder). */
export function troughTribeId(world: World, holder: Entity): number {
  const piece = world.has(holder, BuildPiece) ? holder : pieceOf(world, holder);
  return piece !== undefined ? world.getField(piece, Tribe, "id") ?? 0 : 0;
}
/** May this animal eat from this trough? Its owner's trough, a clan-mate's (same tribe), or an unowned one —
 *  never a stranger's. An ownerless animal (owner id 0) eats only from unowned troughs. */
export function mayEatFromTrough(world: World, holder: Entity, ownerId: number, tribeId: number): boolean {
  const own = troughOwnerId(world, holder);
  if (own === 0) return true;
  if (ownerId !== 0 && own === ownerId) return true;
  return tribeId !== 0 && troughTribeId(world, holder) === tribeId;
}
/** First item in `holder` (a trough container) that is on `diet`, in diet order. 0 when the trough holds nothing
 *  the animal eats — the caller then falls back to grazing / foraging, as before. */
export function troughDietItem(world: World, holder: Entity, diet: readonly string[]): number {
  if (!diet.length) return 0;
  const defs = gameplayDefs(world);
  for (const key of diet) {
    let id = 0; try { id = defs.itemId(key); } catch { continue; }
    if (id && countItem(world, holder, id) > 0) return id;
  }
  return 0;
}
/** Task 28 grazing: seconds of grazing one grass tile to feed, and seconds the tile stays bare before regrowing. */
export const GRAZE_SECONDS = 20;
export const GRASS_REGROW_SECONDS = 180;
/** Task 28: grass tile id in worldgen.json (tile 3). */
export const GRASS_TILE = 3;
export const HUSBANDRY_EVERY = DEFAULT_TICK_HZ; // once per second
/** Restore Animal after load; production + breeding at troughs. */
export function husbandrySystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const defs = gameplayDefs(world); const now = world.tick;
  const lists = stationLists(world); const tr = lists.troughs.filter((e) => world.isAlive(e)); const ap = lists.apiaries.filter((e) => world.isAlive(e));
  const animals = [...world.query([Tamed, Transform], [Dead])].sort((a, b) => a - b);
  for (const a of animals) if (!world.has(a, Animal)) {
    const t = world.get(a, Transform)!; world.add(a, Animal, { kind: world.get(a, Tamed)!.kind, homeX: t.x, homeY: t.y, goalX: t.x, goalY: t.y, thinkAt: now });
    if (!world.has(a, AnimState)) world.add(a, AnimState, { anim: 0, startTick: now });
  }
  for (const a of animals) if (!world.has(a, AnimalSkills)) ensureAnimalSkills(world, a); // Task 15: legacy/loaded farm animals
  // ADR-368: each animal's station + owner lookups, computed once per pass. atTrough / atApiary used to
  // re-scan every trough / apiary (with a Transform copy per station) up to 5x per animal per pass
  // (grouping, eating, production, grazing), plus tamedOwnerId / tamedOwnerTribe / canUsePens each time.
  interface AnimalStation { trough: Entity | undefined; apiary: Entity | undefined; ownerId: number; tribeId: number; kindKey: string | undefined; pens: boolean }
  const stations = new Map<Entity, AnimalStation>();
  const stationOf = (a: Entity): AnimalStation => {
    let s = stations.get(a); if (s) return s;
    const t = world.get(a, Transform)!;
    const near = (list: readonly Entity[]): Entity | undefined => list.find((b) => { const bt = world.get(b, Transform)!; return (bt.x - t.x) ** 2 + (bt.y - t.y) ** 2 <= H.troughRange ** 2; });
    const owner = world.get(a, Tamed)!.owner;
    s = { trough: near(tr), apiary: near(ap), ownerId: tamedOwnerId(world, a), tribeId: tamedOwnerTribe(world, a), kindKey: animalDefs()[world.get(a, Tamed)!.kind]?.key, pens: canUsePens(world, owner) };
    stations.set(a, s); return s;
  };
  const perTrough = new Map<Entity, Entity[]>();
  for (const a of animals) { const b = stationOf(a).pens ? stationOf(a).trough : undefined; if (b !== undefined) { const l = perTrough.get(b) ?? []; l.push(a); perTrough.set(b, l); } }
  // Task 34: bees at an Apiary but no trough still produce (into the Apiary). Bees at a trough are already in perTrough.
  const perApiary = new Map<Entity, Entity[]>();
  for (const a of animals) {
    const stn = stationOf(a);
    if (stn.kindKey !== "animal_bee" || stn.trough !== undefined) continue;
    const b = stn.pens ? stn.apiary : undefined; if (b !== undefined) { const l = perApiary.get(b) ?? []; l.push(a); perApiary.set(b, l); }
  }
  // Task 34: one animal's production at its station (trough or Apiary). Bees deposit honey into the nearest Apiary
  // in range INSTEAD of the trough; if there is no Apiary, or it cannot fit the whole harvest, the trough is tried;
  // if neither fits, the honey is kept (produceAt stays past-due, retried next tick) — never silently lost.
  const produceOne = (a: Entity, station: Entity): void => {
    const t = world.get(a, Tamed)!; if (t.fedUntil <= now) return;
    const bt = world.get(station, Transform)!; world.set(a, Animal, { homeX: bt.x, homeY: bt.y });
    const p = H.animals[animalDefs()[t.kind]?.key ?? ""]; if (!p || t.produceAt > now) return;
    const owner = t.owner && world.isAlive(t.owner) ? t.owner : 0;
    const mods = animalSkillMods(world, a); // Task 15: production + produce-speed nodes
    const mul = (1 + (owner ? skillMod(world, owner, "produce") : 0)) * (1 + mods.produceSpeed);
    const nextAt = now + sec(p.seconds / mul);
    if (stationOf(a).kindKey !== "animal_bee") {
      world.set(a, Tamed, { produceAt: nextAt });
      try { addItem(world, station, defs.itemId(p.produce), 1 + mods.produce); awardAnimalXp(world, a, defs.animalSkillsTuning.xp.produceXp); } catch { /* unknown produce item */ }
      return;
    }
    let honeyId = 0; try { honeyId = defs.itemId(p.produce); } catch { /* unknown produce item: same as today */ }
    if (!honeyId) { world.set(a, Tamed, { produceAt: nextAt }); return; }
    const count = 1 + mods.produce;
    const stn = stationOf(a); const apiary = stn.apiary; const trough = stn.trough;
    for (const tgt of [apiary, trough]) {
      if (tgt === undefined) continue;
      if (canAddItem(world, tgt, honeyId, count) >= count) { addItem(world, tgt, honeyId, count); world.set(a, Tamed, { produceAt: nextAt }); awardAnimalXp(world, a, defs.animalSkillsTuning.xp.produceXp); return; }
    }
    // Apiary full (or no room anywhere): keep the honey, retry next husbandry tick.
  };
  // ADR-353: a hungry animal at its owner's trough eats one item off its diet (hay first for grazers — the old
  // hay-only path is the diet's head) and is fed for the usual fedSeconds. Runs before production so a
  // trough-fed animal produces the same tick. Not gated on canUsePens (that gate is for settling / production /
  // breeding); eating from a trough is feeding, like animal_feed by hand. One item per animal per tick, and a fed
  // animal never eats again until the window lapses, so there is no double-dip with grazing below.
  for (const a of animals) {
    const t = world.get(a, Tamed)!; if (t.fedUntil > now) continue;
    const stn = stationOf(a); const b = stn.trough; if (b === undefined) continue;
    if (!mayEatFromTrough(world, b, stn.ownerId, stn.tribeId)) continue;
    const item = troughDietItem(world, b, farmAnimalDiet(stn.kindKey));
    if (!item || !removeItem(world, b, item, 1)) continue;
    world.set(a, Tamed, { fedUntil: now + sec(H.fedSeconds) });
  }
  for (const [b, list] of perTrough) {
    for (const a of list) produceOne(a, b);
    if (list.length >= H.maxPerTrough) continue;
    const byKind = new Map<number, Entity[]>();
    for (const a of list) { const t = world.get(a, Tamed)!; if (t.fedUntil > now && t.breedAt <= now && t.owner && world.isAlive(t.owner) && hasPerk(world, t.owner, "breeding")) { const l = byKind.get(t.kind) ?? []; l.push(a); byKind.set(t.kind, l); } }
    for (const [kind, l] of byKind) {
      if (l.length < 2) continue; const [m, f] = l as [Entity, Entity]; const owner = world.get(m, Tamed)!.owner;
      const ft = world.get(f, Transform)!; const baby = spawnAnimal(world, kind, ft.x + 0.5, ft.y);
      world.add(baby, Tamed, { kind, owner, fedUntil: now, produceAt: now + sec(H.breedSeconds), breedAt: now + sec(H.breedSeconds * 2) });
      ensureAnimalSkills(world, baby); // Task 15: newborn starts with its level-1 skill point
      for (const x of [m, f]) { const fm = Math.min(0.9, animalSkillMods(world, x).fertility); world.set(x, Tamed, { breedAt: now + sec(H.breedSeconds * (1 - fm)) }); }
      emit(world, AnimalBred, { owner, baby }); awardXp(world, owner, "tame", 0.5);
      break;
    }
  }
  // Task 34: bees settled at an Apiary (no trough in range) produce into it; breeding still needs a trough.
  for (const [b, list] of perApiary) for (const a of list) produceOne(a, b);
  // Task 28 grazing: a hungry tamed animal with no food at a trough grazes the grass tile it stands on — GRAZE_SECONDS
  // of grazing feeds it for the usual fedSeconds, depletes the tile (bare GRASS_REGROW_SECONDS, then grass regrows).
  // Containment is emergent, not a loop proof: grazing only ever targets the tile the animal is already standing on,
  // which it reached by walking inside its enclosure. Not gated on canUsePens (that gate is for trough production).
  const terrain = world.getResource(TerrainRes);
  const grazed = new Map<string, Entity>();
  for (const g of world.query([GrazedTile])) { const v = world.get(g, GrazedTile)!; grazed.set(`${v.tx},${v.ty}`, g); }
  for (const [key, g] of grazed) if (world.get(g, GrazedTile)!.regrowTick <= now) { world.destroy(g); grazed.delete(key); }
  if (terrain) for (const a of animals) {
    const t = world.get(a, Tamed)!;
    if (t.fedUntil > now) { if (world.has(a, Grazing)) world.remove(a, Grazing); continue; }
    const at = world.get(a, Transform)!; const tx = Math.floor(at.x), ty = Math.floor(at.y); const key = `${tx},${ty}`;
    const g = world.get(a, Grazing);
    if (g) {
      if (g.tx !== tx || g.ty !== ty) { world.remove(a, Grazing); continue; } // walked off the tile — restart elsewhere
      if (g.doneTick > now) continue;
      world.remove(a, Grazing);
      world.set(a, Tamed, { fedUntil: now + sec(H.fedSeconds) });
      const old = grazed.get(key);
      if (old !== undefined) world.set(old, GrazedTile, { regrowTick: now + sec(GRASS_REGROW_SECONDS) });
      else { const e = world.create(); world.add(e, GrazedTile, { tx, ty, regrowTick: now + sec(GRASS_REGROW_SECONDS) }); indexEntity(world, e); grazed.set(key, e); }
      continue;
    }
    if (terrain.tileAt(tx, ty) !== GRASS_TILE || grazed.has(key)) continue;
    // ADR-353: food in the animal's own trough wins over grazing — the same ownership + diet check as the trough
    // meal above, so a hungry animal never starts a 20 s graze while its own trough holds something it eats.
    // A stranger's trough does not block grazing: the animal just cannot eat from it.
    const stn = stationOf(a); const b = stn.trough;
    if (b !== undefined && mayEatFromTrough(world, b, stn.ownerId, stn.tribeId) && troughDietItem(world, b, farmAnimalDiet(stn.kindKey))) continue;
    world.add(a, Grazing, { tx, ty, doneTick: now + sec(GRAZE_SECONDS) });
  }
}

export const TameFailed = ev<{ entity: Entity; reason: TameFail }>("gameplay.TameFailed");
/** IntentAction.Use with animal_feed in hand: tame / feed the animal in front (authority). */
export function husbandryUseSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const defs = gameplayDefs(world); const intent = world.store(PlayerIntent);
  for (const e of world.query([PlayerIntent, Transform], [Dead])) {
    const s = intent.slot(entityIndex(e)); if (intent.data.action[s] !== IntentAction.Use) continue;
    const slot = intent.data.slot[s]!; const { item, count } = slotItem(world, e, slot); if (!count || defs.items.get(item)?.key !== H.feed) continue;
    const r = feedAnimal(world, e); if (r.consumed) takeFromSlot(world, e, slot);
    if (r.fail !== TameFail.None) emit(world, TameFailed, { entity: e, reason: r.fail });
  }
}
export interface HusbandryPrompt { action: "Tame" | "Feed"; slot: number; target?: Entity | undefined; fail: TameFail; label: string }
/** Context prompt when holding animal_feed (pure dry run; shown by the client farm prompt). */
export function husbandryPrompt(world: World, e: Entity): HusbandryPrompt | undefined {
  const slot = world.get(e, Equipment)?.mainHandSlot ?? 255; if (slot === 255) return undefined;
  const { item, count } = slotItem(world, e, slot); if (!count || gameplayDefs(world).items.get(item)?.key !== H.feed) return undefined;
  const r = feedAnimal(world, e, true); const action = r.tame ? "Tame" : "Feed";
  return { action, slot, target: animalNear(world, e), fail: r.fail, label: r.fail ? `${action}: ${TAME_FAIL_TEXT[r.fail]}` : action };
}
