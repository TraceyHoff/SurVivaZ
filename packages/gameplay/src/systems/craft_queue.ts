/**
 * Slice 5: queued crafting on core JobQueues (server-authoritative). Single timed crafts (CraftCmd/Crafter, which the
 * client predicts) are unchanged. Recipes still come from gameplay's own loader (gameplayDefs(world).recipes).
 *  - CraftQueue = defineJobQueue("gameplay.CraftQueue", CRAFT_QUEUE_SLOTS): networked + persistent so the UI shows progress.
 *  - enqueueCraft validates the recipe, station and count, then consumes ingredients x count in ONE core transaction().
 *    It enqueues only if that commits. Cancel refunds the unfinished units in one transaction (all or nothing).
 *  - Completion adds the output in a transaction with crafterId provenance. The station system (every tick) pauses the head
 *    when the station is out of range or the next output won't fit, and resumes it when that clears.
 *    If an add still fails at completion, the output goes into the persistent CraftOwed component (8 merged entries) and is
 *    delivered once there's space; it survives restarts, and saves from before it existed load with nothing owed.
 *  - Commands go through core installCommandHandlers: QueueCraftCmd {recipe, count}, CancelQueuedCraftCmd {slot}.
 */
import { defineCommand, defineResource, installScheduler, JobQueues, JobState, transaction, type CommandHandlers, type Entity, type JobInfo, type World } from "@engine/core";
import { CRAFT_OWED_SLOTS, CraftOwed, CraftQueue, Dead, Inventory } from "../components.js";
export { CraftOwed, CraftQueue };
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks } from "../defs.js";
import { CraftCompleted, CraftFail, CraftFailed, CraftStarted, emit } from "../events.js";
import { crafterIdFor } from "../economy/provenance.js";
import { meetsSkill, recipeOutputUnlocked, recipeStationOk, stationInRange, stationUnlocked, torchCraftable } from "./crafting.js";
import { recordRecentCraft } from "../recent.js";

export const CRAFT_QUEUE_SLOTS = 4;
export const MAX_CRAFT_COUNT = 50;
export const QueueCraftCmd = defineCommand("gameplay.queueCraft", { recipe: "u16", count: "u8" });
export const CancelQueuedCraftCmd = defineCommand("gameplay.cancelQueuedCraft", { slot: "u8" });
export const CRAFT_QUEUE_COMMANDS = [QueueCraftCmd, CancelQueuedCraftCmd] as const;

interface Owed { item: number; count: number; crafterId: number }
export const CraftQueuesRes = defineResource<JobQueues>("gameplay.CraftQueues");
/** Owed outputs of e (from the persistent CraftOwed component). */
export function owedOf(w: World, e: Entity): Owed[] {
  const c = w.get(e, CraftOwed); if (!c) return [];
  const out: Owed[] = []; for (let i = 0; i < CRAFT_OWED_SLOTS; i++) if (c.item[i] && c.count[i]) out.push({ item: c.item[i]!, count: c.count[i]!, crafterId: c.crafterId[i]! });
  return out;
}
function writeOwed(w: World, e: Entity, l: Owed[]): void {
  if (l.length === 0) { if (w.has(e, CraftOwed)) w.remove(e, CraftOwed); return; }
  const z = (f: (o: Owed) => number) => Array.from({ length: CRAFT_OWED_SLOTS }, (_, i) => (l[i] ? f(l[i]!) : 0));
  const v = { item: z((o) => o.item), count: z((o) => o.count), crafterId: z((o) => o.crafterId) };
  if (w.has(e, CraftOwed)) w.set(e, CraftOwed, v); else w.add(e, CraftOwed, v);
}
/** Append an owed output (merging same item + crafter). Returns false if all slots are taken (caller emits InventoryFull). */
export function oweCraftOutput(w: World, e: Entity, o: Owed): boolean {
  const l = owedOf(w, e); const m = l.find((x) => x.item === o.item && x.crafterId === o.crafterId && x.count + o.count <= 0xffff);
  if (m) m.count += o.count; else if (l.length < CRAFT_OWED_SLOTS) l.push({ ...o }); else return false;
  writeOwed(w, e, l); return true;
}
const DT = 1 / 20;

const recipeOf = (w: World, id: number) => gameplayDefs(w).recipes.get(id);
function addOutput(w: World, e: Entity, o: Owed): boolean {
  return transaction(w, (tx) => tx.add(e, o.item, o.count, { crafterId: o.crafterId }), e).ok;
}
function outputFor(w: World, e: Entity, recipe: number): Owed | undefined {
  const r = recipeOf(w, recipe); return r && { item: r.output.item, count: r.output.count, crafterId: crafterIdFor(w, e, r.output.item) };
}

export function installCraftQueue(world: World, handlers?: CommandHandlers): JobQueues {
  let q = world.getResource(CraftQueuesRes);
  if (!q) {
    const sched = installScheduler(world);
    q = new JobQueues(world, CraftQueue, sched, {
      duration: (w, _e, id) => Math.max(1, secondsToTicks(recipeOf(w, id)?.seconds ?? 1, DT)),
      onComplete: (w, e, job: JobInfo) => {
        const o = outputFor(w, e, job.recipeId); if (!o) return;
        if (!addOutput(w, e, o) && !oweCraftOutput(w, e, o)) { emit(w, CraftFailed, { entity: e, recipe: job.recipeId, reason: CraftFail.InventoryFull }); return; }
        recordRecentCraft(w, e, job.recipeId); // Task 33: a finished craft joins the player's Recently Crafted list
        emit(w, CraftCompleted, { entity: e, recipe: job.recipeId, item: o.item, count: o.count });
      },
      onCancel: (w, e, job: JobInfo) => {
        const r = recipeOf(w, job.recipeId); if (!r) return;
        transaction(w, (tx) => { for (const i of r.ingredients) { const a = tx.add(e, i.item, i.count * job.count); if (!a.ok) return a; } return { ok: true }; }, e);
        emit(w, CraftFailed, { entity: e, recipe: job.recipeId, reason: CraftFail.Cancelled });
      },
    });
    world.setResource(CraftQueuesRes, q);
    world.addSystem("simulation", "gameplay.craftQueue", craftQueueSystem);
  }
  if (handlers) {
    handlers.on(QueueCraftCmd, { validate: (v, c) => craftQueueReason(world, c.actor, v.recipe, v.count), handle: (v, c) => { enqueueCraft(world, c.actor, v.recipe, v.count); } });
    handlers.on(CancelQueuedCraftCmd, { validate: (v, c) => (q!.jobs(c.actor).some((j) => j.slot === v.slot) ? undefined : "no_job"), handle: (v, c) => { q!.cancel(c.actor, v.slot); } });
  }
  return q;
}

/** Why a queue request would be rejected (undefined = ok); ingredients are checked with a rolled-back dry run. */
export function craftQueueReason(world: World, e: Entity, recipe: number, count: number): string | undefined {
  const r = recipeOf(world, recipe); if (!r) return "unknown_recipe";
  if (!world.has(e, Inventory) || world.has(e, Dead)) return "no_actor";
  if (count < 1 || count > MAX_CRAFT_COUNT) return "bad_count";
  const torch = torchCraftable(world, e, r); // ADR-262: cooked meat over the held beginning torch
  if (!torch && !stationUnlocked(world, e, r.station)) return "skill_locked"; // ADR-221: before no_station (you cannot build it yet)
  if (!torch && !stationInRange(world, e, r.station)) return "no_station";
  if (!meetsSkill(world, e, r)) return "skill_too_low";
  if (!recipeOutputUnlocked(world, e, r)) return "recipe_locked"; // ADR-320: saddles need their Saddlery node
  const q = world.getResource(CraftQueuesRes); if (q && q.jobs(e).length >= CRAFT_QUEUE_SLOTS) return "queue_full";
  let have = true;
  transaction(world, (t) => { for (const i of r.ingredients) if (!t.remove(e, i.item, i.count * count).ok) { have = false; break; } return { ok: false, reason: "dry_run" }; }, e);
  return have ? undefined : "missing_ingredients";
}
/** Consume ingredients x count atomically and enqueue. Returns the slot or a reason. */
export function enqueueCraft(world: World, e: Entity, recipe: number, count = 1): number | string {
  if (!isAuthority(world) || world.isReplaying) return "not_authority";
  const why = craftQueueReason(world, e, recipe, count); if (why) return why;
  const r = recipeOf(world, recipe)!; const q = installCraftQueue(world);
  const tx = transaction(world, (t) => { for (const i of r.ingredients) { const x = t.remove(e, i.item, i.count * count); if (!x.ok) return x; } return { ok: true }; }, e);
  if (!tx.ok) return "missing_ingredients";
  const slot = q.enqueue(e, recipe, count);
  if (slot < 0) { transaction(world, (t) => { for (const i of r.ingredients) { const a = t.add(e, i.item, i.count * count); if (!a.ok) return a; } return { ok: true }; }, e); return "queue_full"; }
  emit(world, CraftStarted, { entity: e, recipe, totalTicks: Math.max(1, secondsToTicks(r.seconds, DT)) });
  return slot;
}
/** Does one unit of the recipe's output fit right now (dry-run transaction)? */
function outputFits(world: World, e: Entity, recipe: number): boolean {
  const o = outputFor(world, e, recipe); if (!o) return true;
  let fits = false; transaction(world, (tx) => { fits = tx.add(e, o.item, o.count, { crafterId: o.crafterId }).ok; return { ok: false, reason: "dry_run" }; }, e);
  return fits;
}
/** Simulation phase, after the scheduler: deliver owed outputs, pause/resume heads on station range and space. */
export function craftQueueSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  for (const e of [...world.query([CraftOwed])].sort((a, b) => a - b)) {
    const l = owedOf(world, e); let n = 0;
    while (n < l.length && addOutput(world, e, l[n]!)) n++;
    if (n > 0) writeOwed(world, e, l.slice(n));
  }
  const q = world.getResource(CraftQueuesRes); if (!q) return;
  for (const e of [...world.query([CraftQueue])].sort((a, b) => a - b)) {
    const h = q.info(e, 0); if (h.state !== JobState.Running && h.state !== JobState.Paused) continue;
    const r = recipeOf(world, h.recipeId); if (!r) continue;
    const ok = !world.has(e, Dead) && recipeStationOk(world, e, r) && !world.has(e, CraftOwed) &&
      (h.state === JobState.Paused || h.endTick > world.tick + 1 || outputFits(world, e, h.recipeId));
    if (h.state === JobState.Running && !ok) q.pause(e);
    else if (h.state === JobState.Paused && ok && outputFits(world, e, h.recipeId)) q.resume(e);
  }
}
