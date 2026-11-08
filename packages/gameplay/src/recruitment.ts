/**
 * Task 22 AI-human recruitment: wandering AI survivors (bots) can be hired by a player to work for them.
 *
 * A bot that can be hired carries the `Worker` component (networked + persistent, on the bot's player entity):
 *   wantedItem — the one item the bot asks for (1 unit), picked once from WANTED_ITEM_KEYS as a tick-independent
 *     fnv1a hash of the bot's stable PlayerId (same account -> same want on every peer and every session) and
 *     never re-rolled; a bot from an old save gets one from `recruitmentSystem` on first sight. (world.rngFor is
 *     tick-seeded and would re-roll every tick, so it is NOT used here.)
 *   owner      — the hiring player's PlayerId (0 = for hire).
 *   job        — the assigned WorkerJob (Gather / Farm / Defend / Craft / Maintain / Follow; None while for hire).
 *   homeX/Y    — where the bot was hired: the work anchor when the owner has no claim (see workerAnchor).
 *
 * Hire is server-authoritative: `hireWorker` re-checks owner === 0 and removes the wanted item *before* setting
 * the owner, so a race between two players hires at most one of them and never consumes an item without hiring.
 * The bot's Tribe is set to the owner's tribe at hire so it can use the owner's claimed base (containers, repair,
 * farming all gate on `hasPrivilege`, which reads the actor's Tribe); dismissed workers get that Tribe cleared
 * again when it is still the owner's tribe. Unclaimed land needs no tribe (no zones -> every() is true).
 *
 * The multiplayer toggle lives in WorldRules.aiHumans (see hordes.ts setWorldRules/worldRules): when off, bots do
 * not spawn in multiplayer (gameModeConfig) and hires/new assignments are refused (AiHumansOff). Existing bots and workers keep
 * working when it is flipped — removing them would destroy player-paid hires. Singleplayer is unaffected by the
 * toggle in the sense that it is on by default there too; the same setting covers both modes.
 */
import { defineCommand, fnv1a, PlayerId, Transform, type CommandDef, type CommandHandlers, type Entity, type World } from "@engine/core";
import { AttachKind, BotHome, BuildPiece, Crop, Health, ResourceNode, Pet, Tamed, WorkerOrder, WorkerTarget, WORKER_SELECTION_MAX, Container, ContainerViewers, Dead, LootBag, PieceOwner, PrivilegeZone, Tribe, Worker, WorkerJob, WorldRules } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { addItem, countItem, readSlots, removeItem } from "./inventory.js";
import { DestroyCause, emit, ev } from "./events.js";
import { isAiHuman } from "./skills/xp.js";
import { hasPrivilege, pieceCost, placePiece, snapPlacement, tribeOf, validatePlacement } from "./building/place.js";
import { destroyPiece } from "./building/integrity.js";
import { resolveAttachment } from "./building/links.js";
import { claimBaseSite, pickBaseSite } from "./ai/planner.js";
import { structures } from "./building/structure.js";
import { lootBagInit } from "./loot_despawn.js";
import { LootSource } from "./loot_labels.js";
import { indexEntity } from "./spawn.js";
import { meetsSkill } from "./systems/crafting.js";
import { StationKind } from "./defs.js";
import type { PieceDef } from "./defs.js";
import type { NameLookup } from "./economy/provenance.js";

/** Local read of the WorldRules.aiHumans toggle (same value as hordes.ts worldRules().aiHumans, duplicated here
 * deliberately: hordes.ts imports systems/movement.js -> input.js, which cycles back through WORKER_COMMANDS —
 * see the playerEntity note below). Default on when the component is absent. */
const aiHumansOn = (world: World): boolean => {
  if (!world.isRegistered(WorldRules)) return true;
  const r = world.get(world.environment, WorldRules);
  return r ? r.aiHumans === 1 : true;
};
const pidOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
/** Local player-entity lookup (same logic as pets.ts playerEntity, duplicated here deliberately: importing pets.ts
 * would pull systems/movement.js -> input.js into this module's graph and cycle back through WORKER_COMMANDS,
 * which input.ts reads at module top level — see esm_import_order.test.ts). */
const playerEntity = (world: World, id: number): Entity | undefined => {
  if (!id || !world.isRegistered(PlayerId)) return undefined;
  for (const e of world.query([PlayerId, Transform], [Dead])) if (world.getField(e, PlayerId, "id") === id) return e;
  return undefined;
};
const near = (world: World, a: Entity, b: Entity, r: number): boolean => { const p = world.get(a, Transform), q = world.get(b, Transform); return !!p && !!q && Math.hypot(p.x - q.x, p.y - q.y) <= r; };

/** Jobs a hired worker can be assigned (None = for hire / between jobs). Order is the panel order. */
export const WORKER_JOBS: readonly WorkerJob[] = [WorkerJob.Gather, WorkerJob.Farm, WorkerJob.Defend, WorkerJob.Craft, WorkerJob.Maintain, WorkerJob.Follow];
export const WORKER_JOB_LABELS: Record<number, string> = { [WorkerJob.None]: "No job", [WorkerJob.Gather]: "Gathering", [WorkerJob.Farm]: "Farming", [WorkerJob.Defend]: "Guarding", [WorkerJob.Craft]: "Crafting", [WorkerJob.Maintain]: "Maintaining", [WorkerJob.Follow]: "Following" };
/** Panel help copy (mirrors PET_HELP). */
export const WORKER_HELP = [
  "AI humans: walk up to one and interact (E / X / tap). Each wants one item — food, a tool, clothing or a resource. Hire them and the item is taken from your pack.",
  "A hired worker does one job at a time around your base: Gathering (collects and stashes), Farming (waters and harvests crops), Guarding (defends a location, player, animal or structure), Crafting (makes selected hand recipes), Maintaining (repairs damaged pieces), Following (follows and guards you). Choose a job to configure its details, then confirm.",
  "Workers keep eating, drinking and sleeping like any survivor. Release them from the panel when you no longer need them; they keep the wanted item for a future hire.",
];
/** One-line job descriptions for the panel's job buttons. */
export const WORKER_JOB_HELP: Record<number, string> = {
  [WorkerJob.Gather]: "Collect resources and bring them to your base storage",
  [WorkerJob.Farm]: "Water thirsty crops, plant seeds on tilled soil, harvest mature crops",
  [WorkerJob.Defend]: "Choose a location, player, tamed animal or structure to guard",
  [WorkerJob.Craft]: "Choose hand recipes to craft at your base and stash",
  [WorkerJob.Maintain]: "Repair damaged base pieces, fetching materials from your storage",
  [WorkerJob.Follow]: "Follow and guard you, taking breaks for food and water",
};

/**
 * Wanted-item pool: one item per bot, 1 unit. Food, tools, wear and resources the game already has — nothing
 * exotic, nothing a new player could not reasonably find or make. Verified against the item catalog by the
 * Task 22 tests (every key must resolve); an unresolvable key is skipped, never hired for.
 */
export const WANTED_ITEM_KEYS = [
  "cooked_meat", "cooked_fish", "bread", "honey", "apple", "berries", "mushroom", "carrot", "egg", "jerky", "stew_bowl", "berry_pie",
  "stone_axe", "stone_pickaxe", "stone_shovel", "stone_knife",
  "torch", "cloth_mask", "straw_hat", "linen_shirt", "padded_jacket", "fur_coat", "leather_boots",
  "coin", "salt", "charcoal", "rope", "leather", "bone", "feather", "iron_ingot",
] as const;

/** Deterministic wanted item for a bot: a tick-independent hash of the bot's stable PlayerId, so server and
 * clients agree and the want does not change tick to tick or across restarts (same account -> same want).
 * Returns the stored want when the bot already has one; 0 when the catalog has no pool item (never in practice). */
export function wantedItemFor(world: World, bot: Entity): number {
  const w = world.get(bot, Worker);
  if (w) return w.wantedItem;
  const defs = gameplayDefs(world); const ids: number[] = [];
  for (const k of WANTED_ITEM_KEYS) { try { ids.push(defs.itemId(k)); } catch { /* renamed item: skip */ } }
  if (!ids.length) return 0;
  const pid = pidOf(world, bot);
  return ids[fnv1a(`hire:${pid > 0 ? pid : bot}`) % ids.length]!;
}

/** Give a bot its Worker record if it has none (wanted item rolled once, here). Idempotent. */
export function ensureWorker(world: World, bot: Entity): void {
  if (world.has(bot, Worker)) return;
  const t = world.get(bot, Transform);
  world.add(bot, Worker, { wantedItem: wantedItemFor(world, bot), owner: 0, job: WorkerJob.None, homeX: t?.x ?? 0, homeY: t?.y ?? 0 });
}

/**
 * Authority-only backfill (installed as `gameplay.recruitment`, every 20 ticks): bots that joined before this
 * feature, or through a path that never called ensureWorker (old saves, DevBotHello), get their Worker record.
 * Never touches human players (isAiHuman) and never re-rolls an existing wanted item.
 */
export function recruitmentSystem(world: World): void {
  if (!isAuthority(world)) return;
  // Worlds without PlayerId registered have no bot player entities to backfill (most unit-test worlds).
  if (!world.isRegistered(PlayerId) || !world.isRegistered(Transform) || !world.isRegistered(Worker)) return;
  for (const e of world.query([PlayerId, Transform], [Dead])) if (isAiHuman(world, e) && !world.has(e, Worker)) ensureWorker(world, e);
}

// ---- hire / job / dismiss ---------------------------------------------------------------------------
export const enum WorkerFail { None = 0, NotFound = 1, TooFar = 2, AlreadyHired = 3, NoItem = 4, AiHumansOff = 5, NotOwner = 6, BadJob = 7, NotWorker = 8, BadDetails = 9 }
export const WORKER_FAIL_REASONS = ["", "not_found", "too_far", "already_hired", "no_item", "ai_humans_off", "not_owner", "bad_job", "not_worker", "bad_worker_details"] as const;
export const enum WorkerResult { Hired = 1, JobSet = 2, Released = 3, Relocated = 4 }
export const WorkerEvent = ev<{ entity: Entity; worker: Entity; result: WorkerResult; value: number }>("gameplay.WorkerEvent");
/** Toast copy for a WorkerEvent (client: main.ts). `value` is the wanted item id on hire, the job on JobSet. */
export function workerEventText(world: World, worker: Entity, result: WorkerResult, value: number): string | undefined {
  const name = `AI Human ${pidOf(world, worker) || ""}`.trim();
  if (result === WorkerResult.Hired) return `${name} hired! They will work for you now.`;
  if (result === WorkerResult.JobSet) return `${name} is now ${WORKER_JOB_LABELS[value]?.toLowerCase() ?? "working"}.`;
  if (result === WorkerResult.Released) return `${name} is no longer working for you.`;
  if (result === WorkerResult.Relocated) return `${name} moved their home near yours — everything they owned came with them.`;
  return undefined;
}

/** Pure hire validation (no side effects; used by the command handler's validate step). */
export function hireWorkerValidate(world: World, actor: Entity, target: Entity): WorkerFail {
  if (!aiHumansOn(world)) return WorkerFail.AiHumansOff;
  if (!world.isAlive(target) || world.has(target, Dead)) return WorkerFail.NotFound;
  if (!world.has(target, Worker)) return WorkerFail.NotWorker;
  const w = world.get(target, Worker)!;
  if (w.owner !== 0) return WorkerFail.AlreadyHired;
  if (!near(world, actor, target, 40)) return WorkerFail.TooFar;
  if (!w.wantedItem || countItem(world, actor, w.wantedItem) < 1) return WorkerFail.NoItem;
  return WorkerFail.None;
}

/**
 * Hire `target` for `actor`: the wanted item is taken first, and only then is the owner set — a hire that cannot
 * pay, or that loses the race to another player, consumes nothing and changes nothing. On success the worker's
 * job starts at Gather, its anchor becomes the actor's position, and its Tribe becomes the actor's tribe so it
 * can work inside the actor's claim.
 */
export function hireWorker(world: World, actor: Entity, target: Entity): WorkerFail {
  const fail = hireWorkerValidate(world, actor, target); if (fail) return fail;
  const w = world.get(target, Worker)!;
  // Re-check the owner immediately before taking payment: two hires in the same tick are processed sequentially,
  // so the second sees owner !== 0 here and walks away with its item intact.
  if (w.owner !== 0) return WorkerFail.AlreadyHired;
  if (!removeItem(world, actor, w.wantedItem, 1)) return WorkerFail.NoItem;
  const me = world.get(actor, Transform); const tribe = tribeOf(world, actor);
  world.set(target, Worker, { owner: pidOf(world, actor), job: WorkerJob.Gather, homeX: me?.x ?? w.homeX, homeY: me?.y ?? w.homeY });
  if (tribe !== 0) { if (world.has(target, Tribe)) world.set(target, Tribe, { id: tribe }); else world.add(target, Tribe, { id: tribe }); }
  emit(world, WorkerEvent, { entity: actor, worker: target, result: WorkerResult.Hired, value: w.wantedItem });
  // Task 28: a hired bot with its own base moves it near the player's home (never fails the hire: a relocation
  // that cannot find a site, or throws, keeps the old base and the bot).
  if (relocateWorkerBase(world, target, actor)) emit(world, WorkerEvent, { entity: actor, worker: target, result: WorkerResult.Relocated, value: 0 });
  return WorkerFail.None;
}

/**
 * Task 28: hire relocation — demolish a hired bot's own base and rebuild it near the player's home, moving every
 * stored resource with it. Server-authoritative; runs on the hire path after payment is taken; returns false
 * (old base kept, hire unaffected) when the bot owns nothing or no new site is found, and never throws.
 *
 * What transfers: every item in every old storage container, plus a FULL (100%) salvage refund of every owned
 * piece's tier cost — not the 50% demolish refund, because the player paid for the hire and the bot should not
 * lose its home's materials. Placed furniture / stations / beds are rebuilt in the same layout when the new site
 * fits; any piece that cannot be placed there (terrain, occupied slot, missing skill) is salvaged into the
 * manifest instead, so its materials still arrive. What is deliberately lost: nothing of value — only the old
 * base's position. Deposit order: each piece's stored contents back into a rebuilt piece of the same type
 * (then any new storage); salvage into the bot's pack, then the owner's pack, then new storage; anything still
 * left over lands in a Dropped loot bag at the new base (stall lifetime). Radius: the new site is 5-9 tiles
 * from the player's claim centre (hire spot when the owner has no claim); pickBaseSite already refuses water
 * and any BuildPiece within 9 tiles.
 */
export function relocateWorkerBase(world: World, worker: Entity, actor: Entity): boolean {
  try {
    const defs = gameplayDefs(world);
    // 1. The bot's own pieces only (PieceOwner.player is the builder's PlayerId, not the entity) — never the
    // player's or another player's.
    const ownerPid = pidOf(world, worker);
    const owned: { e: Entity; def: PieceDef; tier: number; x: number; y: number; level: number; rot: number; variant: number }[] = [];
    const idx = structures(world);
    for (const e of world.query([BuildPiece, PieceOwner])) {
      if (world.getField(e, PieceOwner, "player") !== ownerPid) continue;
      const t = world.get(e, Transform); const type = world.getField(e, BuildPiece, "type") ?? 0;
      const def = defs.pieces.get(type); if (!def || !t) continue;
      owned.push({ e, def, tier: world.getField(e, BuildPiece, "tier") ?? 0, x: t.x, y: t.y, level: idx.info.get(e)?.slot.z ?? 0, rot: world.getField(e, BuildPiece, "rot") ?? 0, variant: world.getField(e, BuildPiece, "variant") ?? 0 });
    }
    if (!owned.length) return false;
    // 2. New site near the player's home (claim centre, else hire spot); three salts to try before giving up.
    const anchor = workerAnchor(world, worker);
    let site: { x: number; y: number } | undefined;
    for (const salt of [0.37, 1.37, 2.37]) { site = pickBaseSite(world, worker, anchor, salt); if (site) break; }
    if (!site) return false; // no room: keep the old base, keep the hire
    // 3. Withdraw every stored item (kept per piece key, so it returns to a rebuilt piece of the same type) and
    // the full salvage (100% of each piece's tier cost, not the 50% demolish refund) BEFORE demolishing
    // anything, so a stability cascade while demolishing cannot lose materials (destroyPiece also spills
    // storage — the containers are empty by then, so nothing spills twice).
    const storedByKey = new Map<string, Map<number, number>>();
    const salvage = new Map<number, number>();
    const addTo = (m: Map<number, number>, item: number, n: number): void => { if (n > 0) m.set(item, (m.get(item) ?? 0) + n); };
    for (const o of owned) {
      const att = resolveAttachment(world, o.e, AttachKind.Storage);
      if (att) { // withdraw first (all-or-nothing per item): destroyPiece spills whatever is left, so an
        // item we fail to withdraw is not lost — it lands in a loot bag at the old site instead.
        const slots = readSlots(world, att); const held = new Map<number, number>();
        for (let i = 0; i < slots.items.length; i++) if (slots.items[i] && slots.counts[i]) held.set(slots.items[i]!, (held.get(slots.items[i]!) ?? 0) + slots.counts[i]!);
        if (held.size) { const m = storedByKey.get(o.def.key) ?? new Map<number, number>(); storedByKey.set(o.def.key, m); for (const [item, n] of held) if (removeItem(world, att, item, n)) addTo(m, item, n); }
      }
      for (const c of pieceCost(defs, o.def, o.tier)) addTo(salvage, c.item, c.count);
    }
    // 4. Demolish top-down (upper levels, then roofs) so stability never cascades a piece we have not counted.
    const demolishOrder = [...owned].sort((a, b) => b.level - a.level || (a.def.key.includes("roof") ? -1 : 0) - (b.def.key.includes("roof") ? -1 : 0));
    for (const o of demolishOrder) if (world.isAlive(o.e)) destroyPiece(world, o.e, DestroyCause.Demolish);
    // 5. Rebuild the same layout at the new site (offsets from the old level-0 min corner), foundations first.
    const ground = owned.filter((o) => o.level === 0);
    const ox = Math.min(...ground.map((o) => o.x)), oy = Math.min(...ground.map((o) => o.y));
    const rebuildOrder = [...owned].sort((a, b) => a.level - b.level);
    const newStorage: Entity[] = [];
    const newStorageByKey = new Map<string, Entity[]>();
    for (const o of rebuildOrder) {
      const sn = snapPlacement(world, { piece: o.def.id, x: site.x + (o.x - ox), y: site.y + (o.y - oy), level: o.level, rot: o.rot, tier: o.tier, variant: o.variant });
      if (typeof sn === "number") continue; // cannot snap here: its salvage is already in the manifest
      if (validatePlacement(world, worker, sn, { ignoreCost: true, ignoreRange: true, ignoreClaim: true }) !== 0) continue;
      const np = placePiece(world, worker, sn, { pay: false });
      const att = resolveAttachment(world, np, AttachKind.Storage);
      if (att) { newStorage.push(att); const l = newStorageByKey.get(o.def.key) ?? []; l.push(att); newStorageByKey.set(o.def.key, l); }
    }
    // 6. Deposit: each piece's stored contents back into a rebuilt piece of the same type first (then any new
    // storage); the demolished home's salvage goes to the bot's pack (it rebuilds with it), then the owner's
    // pack, then new storage; anything still left over lands in a loot bag at the new base.
    const ownerEnt = playerEntity(world, world.get(worker, Worker)?.owner ?? 0);
    const leftovers: [number, number][] = [];
    const deposit = (item: number, n: number, targets: Entity[]): number => { let rem = n; for (const st of targets) { if (rem <= 0) break; rem -= addItem(world, st, item, rem); } return rem; };
    const spill = (item: number, rem: number): void => {
      if (rem > 0) rem -= addItem(world, worker, item, rem);
      if (rem > 0 && ownerEnt) rem -= addItem(world, ownerEnt, item, rem);
      if (rem > 0) leftovers.push([item, rem]);
    };
    for (const [key, contents] of storedByKey) {
      const targets = newStorageByKey.get(key) ?? [];
      for (const [item, n] of contents) {
        let rem = deposit(item, n, targets);
        if (rem > 0) rem = deposit(item, rem, newStorage);
        spill(item, rem);
      }
    }
    for (const [item, n] of salvage) {
      let rem = n; // salvage does not claim storage first: the bot carries its home's materials
      if (rem > 0) rem -= addItem(world, worker, item, rem);
      if (rem > 0 && ownerEnt) rem -= addItem(world, ownerEnt, item, rem);
      if (rem > 0) rem = deposit(item, rem, newStorage);
      if (rem > 0) leftovers.push([item, rem]);
    }
    if (leftovers.length) {
      const bag = world.create();
      world.add(bag, Transform, { x: site.x + 1, y: site.y + 1, z: 0 }).add(bag, Container, { slotCount: 24 }).add(bag, ContainerViewers)
        .add(bag, LootBag, lootBagInit(world, 0, "stall", LootSource.Dropped));
      for (const [item, n] of leftovers) addItem(world, bag, item, n);
      indexEntity(world, bag);
    }
    if (world.has(worker, BotHome)) world.set(worker, BotHome, { x: site.x, y: site.y }); else world.add(worker, BotHome, { x: site.x, y: site.y });
    claimBaseSite(world, worker, { x: site.x, y: site.y });
    return true;
  } catch { return false; }
}

/** 0 = owner's base, 1 = fixed point, 2 = live entity. Follow always uses its owner. */
export const enum WorkerTargetKind { Base = 0, Location = 1, Entity = 2 }
/** Network no-entity sentinel (gameplay does not depend on @engine/net). */
export const WORKER_NO_TARGET = 0xffffffff;
export interface WorkerJobDetails { selections?: readonly number[]; kind?: number; target?: Entity; x?: number; y?: number }
export function workerSelections(world: World, worker: Entity): number[] {
  return Array.from(world.getArray(worker, WorkerOrder, "selections") ?? []).filter((n) => n !== 0);
}
/** Hand recipes share the player's skill checks. Stations aren't offered until worker routing supports them. */
export function workerRecipes(world: World, worker: Entity) {
  return [...gameplayDefs(world).recipes.values()].filter((r) => r.station === StationKind.None && meetsSkill(world, worker, r));
}
export function workerGatherItems(world: World): number[] {
  return [...new Set([...gameplayDefs(world).resources.values()].flatMap((r) => r.yields.map((y) => y.item)))].sort((a, b) => a - b);
}
function workerTargetAllowed(world: World, actor: Entity, target: Entity, job: number): boolean {
  if (!world.isAlive(target) || world.has(target, Dead) || !world.has(target, Transform) || (world.has(target, Health) && (world.getField(target, Health, "hp") ?? 0) <= 0)) return false;
  const p = world.get(target, Transform)!;
  if ((job === WorkerJob.Farm || job === WorkerJob.Maintain) && !hasPrivilege(world, actor, p.x, p.y)) return false;
  if (world.has(target, Pet) && (world.getField(target, Pet, "hp") ?? 0) <= 0) return false;
  if (job === WorkerJob.Farm) return world.has(target, Crop) || (world.has(target, ResourceNode) && (gameplayDefs(world).resources.get(world.getField(target, ResourceNode, "kind") ?? 0)?.key.startsWith("crop_") ?? false));
  if (job === WorkerJob.Maintain) return world.has(target, BuildPiece);
  if (job !== WorkerJob.Defend) return false;
  return (pidOf(world, target) !== 0 && !isAiHuman(world, target) && !world.has(target, Worker)) || world.has(target, BuildPiece)
    || (world.has(target, Pet) && world.getField(target, Pet, "owner") === pidOf(world, actor))
    || (world.has(target, Tamed) && world.getField(target, Tamed, "owner") === pidOf(world, actor));
}
/** Guardable / tendable targets currently visible and within command range; same filter on server and replica. */
export function workerTargets(world: World, actor: Entity, job: number, names?: NameLookup): { entity: Entity; label: string }[] {
  const out: { entity: Entity; label: string }[] = [];
  for (const e of world.query([Transform], [Dead])) if (near(world, actor, e, 40) && workerTargetAllowed(world, actor, e, job)) out.push({ entity: e, label: workerTargetName(world, e, names) });
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.entity - b.entity);
}
export function workerTargetName(world: World, e: Entity, names?: NameLookup): string {
  const pid = pidOf(world, e); if (pid) return names?.get(pid) ?? `Player ${pid}`;
  const pos = world.get(e, Transform); const at = pos ? ` (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})` : "";
  if (world.has(e, Pet)) { const a = world.getArray(e, Pet, "name"), n = world.getField(e, Pet, "len") ?? 0; return (a && n ? String.fromCharCode(...Array.from(a).slice(0, n)) : "Tamed animal") + at; }
  if (world.has(e, Tamed)) return "Tamed farm animal" + at;
  if (world.has(e, BuildPiece)) return (gameplayDefs(world).pieces.get(world.getField(e, BuildPiece, "type") ?? 0)?.key.replace(/_/g, " ") ?? "Structure") + at;
  return "Farm plot" + at;
}
/** Resolve stable identities on both replicas and authority. Missing/dead/unloaded targets hold last assigned point. */
export function workerOrderTarget(world: World, worker: Entity): Entity | undefined {
  const o = world.get(worker, WorkerOrder); if (!o || o.kind !== WorkerTargetKind.Entity) return undefined;
  if (o.targetPlayer) return playerEntity(world, o.targetPlayer);
  for (const e of world.query([WorkerTarget, Transform], [Dead])) if (world.getField(e, WorkerTarget, "id") === o.targetId) return e;
  return undefined;
}
export function workerWorkAnchor(world: World, worker: Entity): { x: number; y: number } {
  const w = world.get(worker, Worker);
  if (w?.job === WorkerJob.Follow) { const owner = playerEntity(world, w.owner); const p = owner === undefined ? undefined : world.get(owner, Transform); if (p) return { x: p.x, y: p.y }; }
  const o = world.get(worker, WorkerOrder);
  if (o && o.kind !== WorkerTargetKind.Base) { const target = workerOrderTarget(world, worker); const p = target === undefined ? undefined : world.get(target, Transform); return p ? { x: p.x, y: p.y } : { x: o.x, y: o.y }; }
  return workerAnchor(world, worker);
}
function targetIdentity(world: World, target: Entity): number {
  const old = world.getField(target, WorkerTarget, "id"); if (old) return old;
  // Authority-generated random identity, not simulation randomness. No local entity handle is saved or replicated.
  const bytes = new Uint32Array(2); let id: number;
  do { globalThis.crypto.getRandomValues(bytes); id = (bytes[0]! & 0x1fffff) * 0x100000000 + bytes[1]!; }
  while (!id || [...world.query([WorkerTarget])].some((e) => world.getField(e, WorkerTarget, "id") === id));
  world.add(target, WorkerTarget, { id });
  const idx = structures(world); const info = idx.info.get(target); if (info) idx.bump(info.ck);
  return id;
}
export function setWorkerJobValidate(world: World, actor: Entity, worker: Entity, job: number, details: WorkerJobDetails = {}): WorkerFail {
  if (!aiHumansOn(world)) return WorkerFail.AiHumansOff;
  if (!world.isAlive(worker) || world.has(worker, Dead)) return WorkerFail.NotFound;
  if (!world.has(worker, Worker)) return WorkerFail.NotWorker;
  if (world.get(worker, Worker)!.owner !== pidOf(world, actor) || pidOf(world, actor) === 0) return WorkerFail.NotOwner;
  if (!WORKER_JOBS.includes(job as WorkerJob)) return WorkerFail.BadJob;
  if (!near(world, actor, worker, 40)) return WorkerFail.TooFar;
  const { selections = [], kind = 0, x = 0, y = 0 } = details;
  const target = details.target === WORKER_NO_TARGET ? 0 : details.target ?? 0;
  if (selections.length > WORKER_SELECTION_MAX || selections.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) return WorkerFail.BadDetails;
  const picked = selections.filter(Boolean);
  const valid = job === WorkerJob.Gather ? workerGatherItems(world) : job === WorkerJob.Craft ? workerRecipes(world, worker).map((r) => r.id) : [];
  if (picked.some((n) => !valid.includes(n)) || new Set(picked).size !== picked.length) return WorkerFail.BadDetails;
  if (![0, 1, 2].includes(kind) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return WorkerFail.BadDetails;
  if (![WorkerJob.Defend, WorkerJob.Farm, WorkerJob.Maintain].includes(job) && (kind !== 0 || target)) return WorkerFail.BadDetails;
  if (kind === WorkerTargetKind.Entity && (!near(world, actor, target, 40) || !workerTargetAllowed(world, actor, target, job))) return WorkerFail.BadDetails;
  if (kind !== WorkerTargetKind.Entity && target) return WorkerFail.BadDetails;
  return WorkerFail.None;
}
export function setWorkerJob(world: World, actor: Entity, worker: Entity, job: number, details: WorkerJobDetails = {}): WorkerFail {
  const fail = setWorkerJobValidate(world, actor, worker, job, details); if (fail) return fail;
  const kind = details.kind ?? 0; const target = details.target; const p = kind === WorkerTargetKind.Entity && target ? world.get(target, Transform) : undefined;
  const values = { craftCursor: 0, selections: Array.from({ length: WORKER_SELECTION_MAX }, (_, i) => details.selections?.[i] ?? 0), kind,
    targetId: kind === WorkerTargetKind.Entity && target && !pidOf(world, target) ? targetIdentity(world, target) : 0,
    targetPlayer: kind === WorkerTargetKind.Entity && target ? pidOf(world, target) : 0, x: p?.x ?? details.x ?? 0, y: p?.y ?? details.y ?? 0 };
  if (world.has(worker, WorkerOrder)) world.set(worker, WorkerOrder, values); else world.add(worker, WorkerOrder, values);
  world.setField(worker, Worker, "job", job);
  emit(world, WorkerEvent, { entity: actor, worker, result: WorkerResult.JobSet, value: job });
  return WorkerFail.None;
}

export function dismissWorkerValidate(world: World, actor: Entity, worker: Entity): WorkerFail {
  if (!world.isAlive(worker) || world.has(worker, Dead)) return WorkerFail.NotFound;
  if (!world.has(worker, Worker)) return WorkerFail.NotWorker;
  if (world.get(worker, Worker)!.owner !== pidOf(world, actor) || pidOf(world, actor) === 0) return WorkerFail.NotOwner;
  if (!near(world, actor, worker, 40)) return WorkerFail.TooFar;
  return WorkerFail.None;
}
/** Release a worker: owner and job cleared, wanted item kept (it can be hired again for the same want). The
 * hire-time Tribe is cleared only while it still matches the actor's tribe, so a clan the bot joined since is
 * left alone. */
export function dismissWorker(world: World, actor: Entity, worker: Entity): WorkerFail {
  const fail = dismissWorkerValidate(world, actor, worker); if (fail) return fail;
  const tribe = tribeOf(world, actor);
  world.set(worker, Worker, { owner: 0, job: WorkerJob.None });
  if (world.has(worker, WorkerOrder)) world.remove(worker, WorkerOrder);
  if (tribe !== 0 && world.has(worker, Tribe) && world.getField(worker, Tribe, "id") === tribe) world.remove(worker, Tribe);
  emit(world, WorkerEvent, { entity: actor, worker, result: WorkerResult.Released, value: 0 });
  return WorkerFail.None;
}

// ---- views --------------------------------------------------------------------------------------------
export interface WorkerView {
  entity: Entity; name: string; wantedItem: number; wantedKey: string; wantedName: string;
  hasWanted: boolean; hasCount: number; hired: boolean; owner: number; owned: boolean; job: number; aiHumans: boolean; assignment: string; details: WorkerJobDetails;
}
export function workerDetails(world: World, e: Entity): WorkerJobDetails {
  const o = world.get(e, WorkerOrder); if (!o) return {};
  return { selections: workerSelections(world, e), kind: o.kind, target: workerOrderTarget(world, e) ?? (0 as Entity), x: o.x, y: o.y };
}
export function workerAssignment(world: World, e: Entity, names?: NameLookup): string {
  const w = world.get(e, Worker); if (!w) return "";
  if (w.job === WorkerJob.Follow) return "Following you · guarding you; food and water breaks enabled";
  const ids = workerSelections(world, e); const defs = gameplayDefs(world);
  if (w.job === WorkerJob.Gather) return `Gathering ${ids.length ? ids.map((id) => defs.items.get(id)?.name ?? "resource").join(", ") : "any resources"}`;
  if (w.job === WorkerJob.Craft) return `Crafting ${ids.length ? ids.map((id) => defs.items.get(defs.recipes.get(id)?.output.item ?? 0)?.name ?? "recipe").join(", ") : "automatic tool progression"}`;
  const o = world.get(e, WorkerOrder); const target = workerOrderTarget(world, e);
  const place = o?.kind === WorkerTargetKind.Entity && target !== undefined ? workerTargetName(world, target, names)
    : o && o.kind !== WorkerTargetKind.Base ? `location (${o.x.toFixed(1)}, ${o.y.toFixed(1)})${o.kind === WorkerTargetKind.Entity ? " — target unavailable" : ""}` : "your base";
  return `${WORKER_JOB_LABELS[w.job] ?? "Working"}: ${place}`;
}
/** Panel view-model for one AI human (undefined when the entity is not a worker). */
export function workerView(world: World, player: Entity, e: Entity, names?: NameLookup): WorkerView | undefined {
  if (!world.has(e, Worker)) return undefined;
  const w = world.get(e, Worker)!; const defs = gameplayDefs(world);
  const d = w.wantedItem ? defs.items.get(w.wantedItem) : undefined;
  const pid = pidOf(world, e); const me = pidOf(world, player);
  return {
    entity: e, name: names?.get(pid) ?? (pid ? `AI Human ${pid}` : "AI Human"),
    wantedItem: w.wantedItem, wantedKey: d?.key ?? "", wantedName: d?.name ?? "",
    hasWanted: w.wantedItem !== 0 && countItem(world, player, w.wantedItem) > 0, hasCount: w.wantedItem ? countItem(world, player, w.wantedItem) : 0,
    hired: w.owner !== 0, owner: w.owner, owned: w.owner !== 0 && w.owner === me, job: w.job, aiHumans: aiHumansOn(world), assignment: workerAssignment(world, e, names), details: workerDetails(world, e),
  };
}
/** Nearest hireable / hired AI human within interact range (2.5 + 0.5, like nearestPet). */
export function nearestWorker(world: World, player: Entity, range = 3): { entity: Entity; d: number } | undefined {
  const p = world.get(player, Transform); if (!p) return undefined;
  let best: { entity: Entity; d: number } | undefined;
  for (const e of world.query([Worker, Transform], [Dead])) {
    const t = world.get(e, Transform)!; const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d <= range && (!best || d < best.d)) best = { entity: e, d };
  }
  return best;
}
/** Where a hired worker works: the centre of the owner's claim when the owner has one, else the hire spot. */
export function workerAnchor(world: World, worker: Entity): { x: number; y: number } {
  const w = world.get(worker, Worker);
  if (w && w.owner !== 0) {
    const owner = playerEntity(world, w.owner);
    if (owner) {
      const tribe = tribeOf(world, owner);
      if (tribe !== 0) {
        for (const z of world.query([PrivilegeZone, Transform])) {
          if (world.getField(z, PrivilegeZone, "tribe") === tribe) { const t = world.get(z, Transform)!; return { x: t.x, y: t.y }; }
        }
      }
    }
  }
  return w ? { x: w.homeX, y: w.homeY } : { x: 0, y: 0 };
}

// ---- commands -----------------------------------------------------------------------------------------
export const HireWorkerCmd = defineCommand("gameplay.hireWorker", { target: "u32" });
export const SetWorkerJobCmd = defineCommand("gameplay.setWorkerJob", { worker: "u32", job: "u8", selections: { type: "u16", length: WORKER_SELECTION_MAX }, kind: "u8", target: "u32", x: "f32", y: "f32" });
export const DismissWorkerCmd = defineCommand("gameplay.dismissWorker", { worker: "u32" });
export const WORKER_COMMANDS: readonly CommandDef[] = [HireWorkerCmd, SetWorkerJobCmd, DismissWorkerCmd];
export const WORKER_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [HireWorkerCmd.name]: ["target"], [SetWorkerJobCmd.name]: ["worker", "target"], [DismissWorkerCmd.name]: ["worker"] };
/** New reject reasons (not_found / too_far / no_item / not_owner already exist in COMMAND_REJECT_REASONS). */
export const WORKER_REJECT_REASONS = ["not_worker", "already_hired", "ai_humans_off", "bad_job", "bad_worker_details"] as const;
export function installWorkerCommands(world: World, handlers: CommandHandlers): void {
  const r = (f: WorkerFail): string | undefined => (f ? WORKER_FAIL_REASONS[f] : undefined);
  handlers.on(HireWorkerCmd, { validate: (v, c) => r(hireWorkerValidate(world, c.actor, v.target as Entity)), handle: (v, c) => { hireWorker(world, c.actor, v.target as Entity); } });
  handlers.on(SetWorkerJobCmd, { validate: (v, c) => r(setWorkerJobValidate(world, c.actor, v.worker as Entity, v.job, { ...v, target: v.target as Entity })), handle: (v, c) => { setWorkerJob(world, c.actor, v.worker as Entity, v.job, { ...v, target: v.target as Entity }); } });
  handlers.on(DismissWorkerCmd, { validate: (v, c) => r(dismissWorkerValidate(world, c.actor, v.worker as Entity)), handle: (v, c) => { dismissWorker(world, c.actor, v.worker as Entity); } });
}
