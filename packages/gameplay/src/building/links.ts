/** Piece <-> attachment resolution (doors, fires, storage are separate non-static entities, see PieceLink). */
import { defineResource, type Entity, type World } from "@engine/core";
import { AttachKind, Container, DoorState, Emitter, Fuel, PieceLink } from "../components.js";

/** piece entity -> its attachment entities (sim-local; rebuilt by the structure index on both peers). */
export const Attachments = defineResource<Map<Entity, Entity[]>>("gameplay.Attachments");
/** attachment entity -> piece entity. */
export const AttachmentOwner = defineResource<Map<Entity, Entity>>("gameplay.AttachmentOwner");

const MARK: Readonly<Record<AttachKind, import("@engine/core").ComponentDef>> = { [AttachKind.Door]: DoorState, [AttachKind.Fire]: Fuel, [AttachKind.Storage]: Container, [AttachKind.Light]: Emitter, [AttachKind.Till]: Container, [AttachKind.Smell]: Emitter, [AttachKind.Heat]: Emitter };

/** Resolves a command target (the piece or the attachment itself) to the attachment of `kind`. */
export function resolveAttachment(world: World, target: Entity, kind: AttachKind): Entity | undefined {
  if (!world.isAlive(target)) return undefined;
  if (world.has(target, MARK[kind])) return target;
  for (const a of world.getResource(Attachments)?.get(target) ?? []) if (world.getField(a, PieceLink, "kind") === kind && world.isAlive(a)) return a;
  // storage commands may target a fire (fuel slots) and vice versa
  if (kind === AttachKind.Storage) return resolveAttachment(world, target, AttachKind.Fire);
  return undefined;
}
export function pieceOf(world: World, e: Entity): Entity | undefined { return world.getResource(AttachmentOwner)?.get(e); }
export function attachmentsOf(world: World, piece: Entity): readonly Entity[] { return world.getResource(Attachments)?.get(piece) ?? []; }
export function linkAttachment(world: World, piece: Entity, att: Entity): void {
  let m = world.getResource(Attachments); if (!m) world.setResource(Attachments, (m = new Map()));
  let o = world.getResource(AttachmentOwner); if (!o) world.setResource(AttachmentOwner, (o = new Map()));
  const l = m.get(piece) ?? []; if (!l.includes(att)) l.push(att); m.set(piece, l); o.set(att, piece);
}
export function unlinkPiece(world: World, piece: Entity): readonly Entity[] {
  const m = world.getResource(Attachments); const l = m?.get(piece) ?? []; m?.delete(piece);
  const o = world.getResource(AttachmentOwner); for (const a of l) o?.delete(a);
  return l;
}
