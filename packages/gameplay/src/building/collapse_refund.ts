/**
 * ADR-517: pieces that collapse because a player demolished their support refund that player, piece by piece, by the
 * demolish rule (100% own build, 50% anyone else's, min 1 each). integrity.ts calls `piece` for every credited
 * collapse (attachments included, each once) and `flush` once per stability pass, which pays each player:
 * into the pack (overflow in an owned bag at their feet) when they are alive and within COLLAPSE_REFUND_NEAR of the
 * first collapse, otherwise in a bag they own at that first collapse spot.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { Dead } from "../components.js";
import { dropOwnedBag, refundOrDrop } from "../overflow.js";
import { demolishRefund } from "./edit.js";
import { CollapseRefundRes, type CollapseCredit } from "./integrity.js";

/** Tiles: farther than this from the first collapsed piece (or dead / offline) and the refund waits there in a bag. */
export const COLLAPSE_REFUND_NEAR = 16;

interface Pending { credit: CollapseCredit; at: { x: number; y: number; z: number }; items: Map<number, number> }

export function installCollapseRefund(world: World): void {
  const pending = new Map<string, Pending>();
  world.setResource(CollapseRefundRes, {
    piece(w: World, credit: CollapseCredit, piece: Entity): void {
      const { items } = demolishRefund(w, credit.by, piece); if (!items.length) return;
      const k = `${credit.by}:${credit.pid}`; let p = pending.get(k);
      if (!p) { const t = w.get(piece, Transform); pending.set(k, (p = { credit, at: { x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0 }, items: new Map() })); }
      for (const c of items) p.items.set(c.item, (p.items.get(c.item) ?? 0) + c.count);
    },
    flush(w: World): void {
      for (const p of pending.values()) {
        const items = [...p.items].map(([item, count]) => ({ item, count }));
        const by = p.credit.by; const t = w.isAlive(by) && !w.has(by, Dead) ? w.get(by, Transform) : undefined;
        if (t && Math.hypot(t.x - p.at.x, t.y - p.at.y) <= COLLAPSE_REFUND_NEAR) refundOrDrop(w, by, items);
        else dropOwnedBag(w, p.at, p.credit.pid, items);
      }
      pending.clear();
    },
  });
}
