/**
 * Pure helpers: bot action intents -> InputFrame / commands using the same bits and commands as players,
 * so bots go through the same validation, rate limits and rules. No controller, no world writes.
 */
import type { CommandRegistry, InputFrame } from "@engine/core";
import { AttackCmd, CraftCmd, EquipCmd, GameplayActions, GatherCmd, OpenContainerCmd, PlaceCmd, UseCmd } from "../input.js";
import { QueueCraftCmd } from "../systems/craft_queue.js";
import { BuyFromStallCmd } from "../economy/stall.js";

export type BotIntent =
  | { kind: "idle" }
  | { kind: "move"; dx: number; dy: number; sprint?: boolean }
  | { kind: "look"; aimX: number; aimY: number }
  | { kind: "gather"; target: number }
  | { kind: "attack"; target: number }
  | { kind: "craft"; recipe: number; count?: number }
  | { kind: "build"; piece: number; x: number; y: number; level?: number; rot?: number; tier?: number; variant?: number }
  | { kind: "eat"; slot: number }
  | { kind: "equip"; slot: number }
  | { kind: "open"; target: number }
  | { kind: "buy"; stall: number; listingSlot: number; qty: number; expectedRevision: number; expectedPriceItem: number; expectedPriceCount: number };

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
/** Build one frame. aim defaults to move direction. Unregistered commands are skipped (returns the frame without them). */
export function intentToFrame(intent: BotIntent, tick: number, reg: CommandRegistry, aim?: { x: number; y: number }): InputFrame {
  const f: InputFrame = { tick, actions: 0, aimX: aim?.x ?? 0, aimY: aim?.y ?? 0, commands: [] };
  const push = (fn: () => InputFrame["commands"][number]): void => { try { f.commands.push(fn()); } catch { /* not in registry */ } };
  switch (intent.kind) {
    case "idle": break;
    case "move": {
      const len = Math.hypot(intent.dx, intent.dy); if (len < 1e-6) break;
      f.moveX = clamp1(intent.dx / len); f.moveY = clamp1(intent.dy / len);
      if (intent.dx > 0.38 * len) f.actions |= GameplayActions.MoveRight; else if (intent.dx < -0.38 * len) f.actions |= GameplayActions.MoveLeft;
      if (intent.dy > 0.38 * len) f.actions |= GameplayActions.MoveDown; else if (intent.dy < -0.38 * len) f.actions |= GameplayActions.MoveUp;
      // Sprint remains a vehicle-boost request only; on-foot movement uses the shared warmup.
      if (intent.sprint) f.actions |= GameplayActions.Sprint;
      if (!aim) { f.aimX = f.moveX; f.aimY = f.moveY; }
      break;
    }
    case "look": f.aimX = intent.aimX; f.aimY = intent.aimY; break;
    case "gather": f.actions |= GameplayActions.Primary; push(() => reg.make(GatherCmd, { target: intent.target })); break;
    case "attack": f.actions |= GameplayActions.Primary; push(() => reg.make(AttackCmd, { target: intent.target })); break;
    case "craft": push(() => (intent.count ?? 1) > 1 ? reg.make(QueueCraftCmd, { recipe: intent.recipe, count: intent.count! }) : reg.make(CraftCmd, { recipe: intent.recipe })); break;
    case "build": f.actions |= GameplayActions.Build;
      push(() => reg.make(PlaceCmd, { piece: intent.piece, x: intent.x, y: intent.y, level: intent.level ?? 0, rot: intent.rot ?? 0, tier: intent.tier ?? 0, variant: intent.variant ?? 0 })); break;
    case "eat": push(() => reg.make(UseCmd, { slot: intent.slot })); break;
    case "equip": push(() => reg.make(EquipCmd, { slot: intent.slot })); break;
    case "open": f.actions |= GameplayActions.Interact; push(() => reg.make(OpenContainerCmd, { target: intent.target })); break;
    case "buy": push(() => reg.make(BuyFromStallCmd, { stall: intent.stall, listingSlot: intent.listingSlot, qty: intent.qty, expectedRevision: intent.expectedRevision, expectedPriceItem: intent.expectedPriceItem, expectedPriceCount: intent.expectedPriceCount })); break;
  }
  return f;
}
/** Sequence of frames for a list of intents starting at tick, honoring a reaction delay (idle frames first). */
export function intentSequence(intents: readonly BotIntent[], startTick: number, reg: CommandRegistry, reactionTicks = 0): InputFrame[] {
  const out: InputFrame[] = [];
  for (let i = 0; i < reactionTicks; i++) out.push(intentToFrame({ kind: "idle" }, startTick + i, reg));
  intents.forEach((it, i) => out.push(intentToFrame(it, startTick + reactionTicks + i, reg)));
  return out;
}
/** Apply aim error (radians, Imperfections.aimErrorRad from bots.json) to a direction using a caller rng in [0,1). */
export function jitterAim(x: number, y: number, aimErrorRad: number, rand: () => number): { x: number; y: number } {
  const a = (rand() * 2 - 1) * aimErrorRad, c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}
