/**
 * ADR-250: base storage for AI humans (and anything else that wants a chest without the UI). Pure reads over a world
 * (server or a bot's replica) plus the action-string sequences agents emit; the server still enforces reach, privilege
 * (ADR-207), viewing and capacity through containerSystem, so an AI can never do more than a player could.
 *
 *   const boxes = nearbyStorage(world, bot, 8);                          // closest first; contents when visible
 *   out.actions = storageDepositActions(boxes[0].piece, item, count);    // ["copen:<p>", "cdeposit:<p>:<item>:<n>", "cclose"]
 *
 * Emit one action per think tick (open -> deposit/withdraw -> close): each becomes the entity's PlayerIntent for one tick.
 * Withdraw with item 0 = "take all" (ADR-160).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { AttachKind, BuildPiece, Container } from "../components.js";
import { GameplayConfig } from "../config.js";
import { StationKind, type PieceDef } from "../defs.js";
import { listSlots } from "../inventory.js";
import { resolveAttachment } from "../building/links.js";
import { zoneOwnedBy, zonesAt } from "../building/place.js";
import { canUseBaseStorage } from "../building/actions.js";

/** Plain base storage: a container piece that is not a stall, a fire/fuel slot, a station, a turret (ammo) or a feeding trough.
 *  basic_storage_box is the starter one; storage_box / large_chest / shelves / cabinets / barrels count too. */
export const isBaseStoragePiece = (def: PieceDef | undefined): boolean =>
  !!def && def.container > 0 && !def.stall && !def.fired && def.station === StationKind.None && !def.features.turret && !def.key.endsWith("_trough");
/** Starter storage piece key (never skill-gated, hand-built). */
export const STARTER_STORAGE_PIECE = "basic_storage_box";

export interface StorageInfo {
  /** piece entity: the copen/cdeposit/cwithdraw target (the server resolves it to the Storage attachment) */
  piece: Entity; key: string; x: number; y: number; dist: number; slots: number;
  /** filled only when the Container is readable in this world (server, or a replica while viewing) */
  free?: number; contents?: { item: number; count: number }[];
}

/** Base storage pieces within `radius` of `e`, closest first. */
export function nearbyStorage(world: World, e: Entity, radius: number): StorageInfo[] {
  const defs = world.getResource(GameplayConfig)?.defs; const t = world.get(e, Transform); if (!defs || !t) return [];
  const out: StorageInfo[] = [];
  for (const p of world.query([BuildPiece, Transform])) {
    const def = defs.pieces.get(world.getField(p, BuildPiece, "type") ?? 0); if (!isBaseStoragePiece(def)) continue;
    const pt = world.get(p, Transform)!; const dist = Math.hypot(pt.x - t.x, pt.y - t.y); if (dist > radius) continue;
    const info: StorageInfo = { piece: p, key: def!.key, x: pt.x, y: pt.y, dist, slots: def!.container };
    const c = resolveAttachment(world, p, AttachKind.Storage);
    if (c !== undefined && world.has(c, Container)) {
      const used = listSlots(world, c).filter((s) => s.item && s.count);
      info.free = Math.max(0, (world.getField(c, Container, "slotCount") ?? def!.container) - used.length);
      const m = new Map<number, number>(); for (const s of used) m.set(s.item, (m.get(s.item) ?? 0) + s.count);
      info.contents = [...m].map(([item, count]) => ({ item, count }));
    }
    out.push(info);
  }
  return out.sort((a, b) => a.dist - b.dist || a.piece - b.piece);
}
/** Units of `item` in a storage piece (0 when not readable here). */
export const storedCount = (s: StorageInfo, item: number): number => s.contents?.find((c) => c.item === item)?.count ?? 0;

/**
 * ADR-342: the shared storage-permission rule behind ADR-323/327's mayTakeFromStorage, with the
 * home already resolved by the caller (the bot's own base centre, or its employer's home — the
 * caller knows which base it is stocking for, so this stays free of the planner / AiMemory).
 * Storage this AI may take from: inside a claim every covering zone must be its own / its clan's
 * (tribe) / its employer's (zoneOwnedBy), unclaimed boxes only within `homeTiles` of home. The
 * server's ADR-207 gate (canUseBaseStorage) must agree too. Anything else is someone else's:
 * never touched.
 */
export function mayTakeFromStorageAt(world: World, self: Entity, s: Pick<StorageInfo, "piece" | "x" | "y">, home: { x: number; y: number } | undefined, homeTiles = 5): boolean {
  const c = resolveAttachment(world, s.piece, AttachKind.Storage); if (c !== undefined && !canUseBaseStorage(world, self, c)) return false;
  const zs = zonesAt(world, s.x, s.y); if (zs.length) return zs.every((z) => zoneOwnedBy(world, z, self));
  return !!home && Math.hypot(s.x - home.x, s.y - home.y) <= homeTiles;
}

/** Action strings (agent_output.ts) for one deposit: open, deposit `count` of `item` from the bag, close. */
export const storageDepositActions = (piece: Entity, item: number, count: number): string[] => [`copen:${piece}`, `cdeposit:${piece}:${item}:${count}`, "cclose"];
/** Action strings for one withdraw; item 0 takes everything that fits. */
export const storageWithdrawActions = (piece: Entity, item: number, count: number): string[] => [`copen:${piece}`, `cwithdraw:${piece}:${item}:${count}`, "cclose"];
