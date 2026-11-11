/**
 * ADR-351 rope leading commands (definitions only, no imports beyond core, so input.ts can append them at
 * module top level without an ESM cycle; handlers live in rope.ts). Append-only: registered after MOUNT_COMMANDS.
 *  - RopeLeadCmd: attach the rope to `target` (a leadable farm animal / mount in reach, rope equipped), or
 *    release the animal currently led when `target` is 0. Un-equipping the rope releases it too (ropeSystem),
 *    so this command is the explicit attach / release; the panel and the Interact controls send it.
 */
import { defineCommand, type CommandDef } from "@engine/core";

export const RopeLeadCmd = defineCommand("gameplay.ropeLead", { target: "u32" });
export const ROPE_COMMANDS: readonly CommandDef[] = [RopeLeadCmd];
export const ROPE_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [RopeLeadCmd.name]: ["target"] };
/** Reject reasons (append to the server's COMMAND_REJECT_REASONS; names already listed keep their earlier code). */
export const ROPE_REJECT_REASONS = ["not_leadable", "no_rope", "already_led"] as const;
