/**
 * Gathering: IntentAction.Gather on a ResourceNode. Validates cooldown, target, range, tool, stamina;
 * then (authority only) rolls yields with world.rngFor("gather", node NetId), fills the inventory and depletes the node.
 * Order (simulation phase): gather.respawn -> gather.actions.
 *
 * Client prediction: the client runs the same validation and predicts stamina cost + cooldown and
 * emits GatherSwing for feedback, but does NOT roll yields or touch the node (RNG outcomes and shared
 * world state arrive by replication).
 */
import { entityIndex, NetId, Transform, type Entity, type World } from "@engine/core";
import { Anim, AnimState, BuildPiece, Dead, Equipment, Gatherer, IntentAction, Inventory, NO_SLOT, NodeRegrow, PieceLink, PlayerIntent, ResourceNode, Road, Survival, Crop, WorkerTarget } from "../components.js";
import { spawnResourceNode } from "../spawn.js";
import { ChunkNodes } from "../world.js";
import { populationTile, PopulationTiles } from "../population.js";
import { TerrainRes } from "../world.js";
import { gameplayDefs, isAuthority, rangeSlack } from "../config.js";
import { secondsToTicks, ToolKind, type GameDefs, type ToolDef } from "../defs.js";
import { emit, GatherFail, GatherFailed, GatherSwing, InventoryOverflow, ItemGathered, NodeDepleted, NodeRespawned } from "../events.js";
import { makeNoise } from "./noise.js";
import { addItem, slotItem } from "../inventory.js";
import { spendStamina } from "./vitals.js";
import { scaleCount, skillMul } from "../skills/tree.js";
import farmingRaw from "../../data/farming.json";
/** ADR-234: nodes a player can grow without tilling (berry bushes, saplings): their food yields are farm produce. */
const ORCHARD_NODES: ReadonlySet<string> = new Set((farmingRaw as unknown as { plantables: { type: string; becomes: string }[] }).plantables.filter((p) => p.type !== "crop").map((p) => p.becomes));
/** ADR-234: which skill mod scales a yield: "cropYield" for crop_* nodes and the food (fruit / berries) of orchard nodes, else "gather". */
export function yieldSkillMod(defs: GameDefs, nodeKey: string | undefined, item: number): "cropYield" | "gather" {
  if (!nodeKey) return "gather"; if (nodeKey.startsWith("crop_")) return "cropYield";
  return ORCHARD_NODES.has(nodeKey) && defs.items.get(item)?.food ? "cropYield" : "gather";
}

const BARE_HANDS: ToolDef = { kind: ToolKind.None, tier: 0 };

export function heldTool(world: World, e: Entity, defs: GameDefs): ToolDef {
  const slot = world.getField(e, Equipment, "mainHandSlot");
  if (slot === undefined || slot === NO_SLOT || !world.has(e, Inventory)) return BARE_HANDS;
  return defs.items.get(slotItem(world, e, slot).item)?.tool ?? BARE_HANDS;
}

/** Fists can work this tool node (resources.json bareHands, ADR-107): low tier and a listed tool kind. */
export function bareHandsCan(defs: GameDefs, def: { requiredTool: ToolKind; minTier: number }): boolean {
  return def.requiredTool === ToolKind.None || (def.minTier <= defs.bareHands.maxMinTier && defs.bareHands.tools.has(def.requiredTool));
}

/**
 * ADR-128: the swing animation for working `def` with `tool`: matching axe -> Chop, matching pickaxe -> Mine,
 * toolless nodes (bushes, crops, plants) or shovel/knife work -> Harvest (hand pick/pull), fists on a tool node -> Punch.
 */
export function gatherAnimFor(def: { requiredTool: ToolKind }, tool: ToolDef): Anim {
  if (def.requiredTool === ToolKind.None) return Anim.Harvest;
  if (tool.kind !== def.requiredTool) return Anim.Punch;
  if (def.requiredTool === ToolKind.Axe) return Anim.Chop;
  if (def.requiredTool === ToolKind.Pickaxe) return Anim.Mine;
  return Anim.Harvest;
}

function setAnimOf(world: World, e: Entity, anim: Anim): void {
  const cur = world.getField(e, AnimState, "anim");
  if (cur === undefined) world.add(e, AnimState, { anim, startTick: world.tick });
  else if (cur !== anim) world.set(e, AnimState, { anim, startTick: world.tick });
  else world.setField(e, AnimState, "startTick", world.tick); // restart the one-shot on repeated swings
}

/**
 * ADR-134 respawn: a depleted (non-crop) node is removed from the world and replaced by a NodeRegrow marker.
 * When its timer (resources.json respawnSeconds x depletion.respawnMul) runs out a fresh node spawns at a new valid
 * spot near the old one (same terrain tile = same biome; clear of structures, roads, players and other nodes), so the
 * node count per region stays stable. No valid spot -> retry later (depletion.retrySeconds), up to maxTries, then
 * fall back to the original spot. Legacy saves with amount-0 nodes are converted on sight.
 */
export function respawnSystem(world: World, dt = 1 / 20): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const defs = gameplayDefs(world); const cfg = defs.depletion; const rn = world.store(ResourceNode);
  // ADR-368: scratch for the per-tick scans (the old code spread every ResourceNode and every
  // NodeRegrow marker into fresh arrays each tick just to find the few due ones). Collection and
  // processing are separate passes, so destroying / creating during processing cannot disturb the
  // query iteration; order is the query order, as before. Single-threaded sim; never re-entrant.
  LEGACY_NODES.length = 0;
  for (const node of world.query([ResourceNode])) { // legacy amount-0 nodes (pre-ADR-134 saves)
    const s = rn.slot(entityIndex(node)); if (rn.data.amount[s] !== 0) continue;
    LEGACY_NODES.push(node);
  }
  for (const node of LEGACY_NODES) {
    const s = rn.slot(entityIndex(node)); const def = defs.resources.get(rn.data.kind[s]!); if (!def || def.oneShot) continue;
    depleteNode(world, node, def.id, Math.max(world.tick, rn.data.respawnAtTick[s]!), 0);
  }
  DUE_REGROW.length = 0;
  const rg = world.store(NodeRegrow);
  for (const g of world.query([NodeRegrow, Transform])) {
    if (world.tick < rg.data.respawnAtTick[rg.slot(entityIndex(g))]!) continue;
    DUE_REGROW.push(g);
  }
  for (const g of DUE_REGROW) {
    const r = world.get(g, NodeRegrow)!; if (world.tick < r.respawnAtTick) continue;
    const def = defs.resources.get(r.kind); if (!def) { world.destroy(g); continue; }
    const t = world.get(g, Transform)!;
    let spot = findRegrowSpot(world, t.x, t.y, world.rngFor("regrow", world.getField(g, NetId, "id") ?? g));
    if (!spot) {
      if (r.tries + 1 < cfg.maxTries) { world.set(g, NodeRegrow, { ...r, tries: r.tries + 1, respawnAtTick: world.tick + secondsToTicks(cfg.retrySeconds, dt) }); continue; }
      spot = { x: t.x, y: t.y };
    }
    const n = spawnResourceNode(world, def.id, spot.x, spot.y);
    swapChunkNode(world, g, n); world.destroy(g);
    emit(world, NodeRespawned, { node: n, kind: def.id });
  }
}

/** ADR-368: respawnSystem scratch (see there). */
const LEGACY_NODES: Entity[] = [];
const DUE_REGROW: Entity[] = [];

/** Remove a depleted node, leaving a NodeRegrow (trees: a stump for depletion.stumpSeconds). Returns the marker. */
export function depleteNode(world: World, node: Entity, kind: number, respawnAtTick: number, stumpTicks: number): Entity {
  const t = world.get(node, Transform) ?? { x: 0, y: 0 };
  const g = world.create();
  world.add(g, Transform, { x: t.x, y: t.y }).add(g, NodeRegrow, { kind, respawnAtTick, stumpUntilTick: stumpTicks > 0 ? world.tick + stumpTicks : 0, tries: 0 });
  swapChunkNode(world, node, g); world.destroy(node);
  return g;
}

/** Keep client/standalone chunk streaming lists pointing at the live entity (unload despawns it). */
function swapChunkNode(world: World, from: Entity, to: Entity): void {
  const m = world.getResource(ChunkNodes); if (!m) return;
  for (const l of m.values()) { const i = l.indexOf(from); if (i >= 0) { l[i] = to; return; } }
}

const SWIM_OR_VOID = (tile: number): boolean => tile === 0 || tile === 1 || tile === 8; // void / water / shallow water (generator tile ids; ADR-249 generates 8)

/** A valid regrow spot within depletion.min..maxRadius of (x, y), or undefined. Deterministic for a given rng. */
export function findRegrowSpot(world: World, x: number, y: number, rng: { next(): number }): { x: number; y: number } | undefined {
  const cfg = gameplayDefs(world).depletion;
  const hasTiles = !!(world.getResource(TerrainRes) || world.getResource(PopulationTiles));
  const tileOf = (px: number, py: number): number => populationTile(world, Math.floor(px), Math.floor(py));
  const biome = hasTiles ? tileOf(x, y) : -1;
  const blockers: { x: number; y: number; r: number }[] = [];
  const add = (q: Iterable<Entity>, r: number): void => { for (const e of q) { const p = world.get(e, Transform); if (p && Math.abs(p.x - x) < cfg.maxRadius + r && Math.abs(p.y - y) < cfg.maxRadius + r) blockers.push({ x: p.x, y: p.y, r }); } };
  add(world.query([BuildPiece, Transform]), cfg.clearStructures); add(world.query([PieceLink, Transform]), cfg.clearStructures);
  add(world.query([Road, Transform]), cfg.clearRoads); add(world.query([Survival, Transform], [Dead]), cfg.clearPlayers);
  add(world.query([ResourceNode, Transform]), cfg.clearNodes); add(world.query([NodeRegrow, Transform]), cfg.clearNodes);
  for (let i = 0; i < cfg.attempts; i++) {
    const a = rng.next() * Math.PI * 2; const d = cfg.minRadius + rng.next() * (cfg.maxRadius - cfg.minRadius);
    const px = Math.floor(x + Math.cos(a) * d) + 0.5, py = Math.floor(y + Math.sin(a) * d) + 0.5;
    if (hasTiles) { const tile = tileOf(px, py); if (tile !== biome || SWIM_OR_VOID(tile)) continue; }
    if (blockers.some((b) => (b.x - px) ** 2 + (b.y - py) ** 2 < b.r * b.r)) continue;
    return { x: px, y: py };
  }
  return undefined;
}

export function gatherSystem(world: World, dt: number): void {
  const defs = gameplayDefs(world); const authority = isAuthority(world);
  const intent = world.store(PlayerIntent); const tf = world.store(Transform); const rn = world.store(ResourceNode);
  for (const e of world.query([PlayerIntent, Gatherer, Inventory, Transform], [Dead])) {
    const idx = entityIndex(e); const is = intent.slot(idx);
    if (intent.data.action[is] !== IntentAction.Gather) continue;
    const node = intent.data.target[is]!;
    const fail = (reason: GatherFail): void => emit(world, GatherFailed, { entity: e, node, reason });

    if (world.tick < world.getField(e, Gatherer, "cooldownUntilTick")!) { fail(GatherFail.Cooldown); continue; }
    if (!world.has(node, ResourceNode) || !world.has(node, Transform)) { fail(GatherFail.InvalidTarget); continue; }
    const nIdx = entityIndex(node); const ns = rn.slot(nIdx);
    const def = defs.resources.get(rn.data.kind[ns]!); if (!def) { fail(GatherFail.InvalidTarget); continue; }
    if (rn.data.amount[ns] === 0) { fail(GatherFail.Depleted); continue; }
    const a = tf.slot(idx), b = tf.slot(nIdx);
    const dist = Math.hypot(tf.data.x[a]! - tf.data.x[b]!, tf.data.y[a]! - tf.data.y[b]!);
    if (dist > world.getField(e, Gatherer, "reach")! + rangeSlack(world, e)) { fail(GatherFail.OutOfRange); continue; }
    const tool = heldTool(world, e, defs);
    const bare = def.requiredTool !== ToolKind.None && (tool.kind !== def.requiredTool || tool.tier < def.minTier);
    if (bare && !bareHandsCan(defs, def)) { fail(GatherFail.WrongTool); continue; }
    if (world.has(e, Survival) && !spendStamina(world, e, def.staminaCost, dt)) { fail(GatherFail.Exhausted); continue; }

    world.setField(e, Gatherer, "cooldownUntilTick", world.tick + secondsToTicks(def.cooldownSeconds * (bare ? defs.bareHands.cooldownMul : 1), dt));
    emit(world, GatherSwing, { entity: e, node });
    if (authority || world.has(e, AnimState)) setAnimOf(world, e, gatherAnimFor(def, tool)); // replicated (AnimState scope "all")
    if (!authority || world.isReplaying) continue;
    makeNoise(world, e, defs.noise.gather);
    // Per-node deterministic stream keyed by the node's NetId (same on every peer), not the shared world.rng.
    const rng = world.rngFor("gather", world.getField(node, NetId, "id") ?? node);

    const bonus = def.requiredTool !== ToolKind.None && !bare ? Math.max(0, tool.tier - def.minTier) * def.bonusPerTier : 0;
    def.yields.forEach((y, i) => {
      if (bare && i > 0) return; // fists: first yield only
      if (y.chance < 1 && rng.next() >= y.chance) return;
      const rolled = rng.int(y.min, y.max + 1) + (i === 0 ? bonus : 0);
      const n0 = bare ? Math.max(defs.bareHands.minYield, Math.floor(rolled * defs.bareHands.yieldMul)) : rolled;
      const gm = skillMul(world, e, yieldSkillMod(defs, defs.resources.get(world.get(node, ResourceNode)!.kind)?.key, y.item));
      const n = gm === 1 ? n0 : scaleCount(n0, gm, rng.next()); // ADR-113 (no extra roll without perks: rng stream unchanged)
      if (n <= 0) return;
      const added = addItem(world, e, y.item, n);
      if (added > 0) emit(world, ItemGathered, { entity: e, node, item: y.item, count: added });
      if (added < n) emit(world, InventoryOverflow, { entity: e, item: y.item, lost: n - added });
    });
    const left = rn.data.amount[ns]! - 1;
    rn.data.amount[ns] = left;
    rn.markChanged(nIdx);
    if (left === 0) {
      emit(world, NodeDepleted, { node, kind: def.id });
      if (def.oneShot) {
        // ADR-259: keep a specifically assigned farm plot's identity and soil for replanting.
        if (world.has(node, WorkerTarget) && def.key.startsWith("crop_")) { world.remove(node, ResourceNode); world.add(node, Crop); }
        else world.destroy(node);
      } // ADR-110: harvested crop
      else { // ADR-134: gone from the world; regrows elsewhere
        const dep = defs.depletion;
        depleteNode(world, node, def.id, world.tick + secondsToTicks(def.respawnSeconds * dep.respawnMul, dt), def.requiredTool === ToolKind.Axe ? secondsToTicks(dep.stumpSeconds, dt) : 0);
      }
    }
  }
}
