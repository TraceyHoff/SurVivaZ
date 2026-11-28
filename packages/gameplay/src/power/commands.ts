/**
 * ADR-590 power commands (definitions only, core imports only, so input.ts can append them without an ESM cycle;
 * handlers live in power/grid.ts installPowerCommands). Append-only: registered after ITEM_REPAIR_COMMANDS.
 *  - PowerToggleCmd: switch a powered piece (lamp, heater, station, source...) on / off. Needs build privilege
 *    at the piece and to stand within 4 tiles. target = the piece entity (NetId-mapped).
 */
import { defineCommand, type CommandDef } from "@engine/core";

export const PowerToggleCmd = defineCommand("gameplay.powerToggle", { target: "u32", on: "u8" });
export const POWER_COMMANDS: readonly CommandDef[] = [PowerToggleCmd];
/** Reject reasons (append to the server's COMMAND_REJECT_REASONS; names already listed keep their earlier code). */
export const POWER_REJECT_REASONS = ["not_powered_piece"] as const;
