/**
 * ADR-474 item-repair commands (definitions only, no imports beyond core, so input.ts can append them at
 * module top level without an ESM cycle; handlers live in item_repair.ts). Append-only: registered after RAMP_COMMANDS.
 *  - ItemRepairCmd: repair the tool / weapon in inventory `slot` (durability restored to full, in place).
 *    First-tier tools (tier 1) repair anywhere with the resources in the bag; later tiers need an anvil in
 *    range (Tracey). The client Repair button (ui/menus.ts itemRepairIntent) and the bot `irepair:<slot>`
 *    action (ai/agent_output.ts) both send this command.
 */
import { defineCommand, type CommandDef } from "@engine/core";

export const ItemRepairCmd = defineCommand("gameplay.itemRepair", { slot: "u8" });
export const ITEM_REPAIR_COMMANDS: readonly CommandDef[] = [ItemRepairCmd];
/** Reject reasons (append to the server's COMMAND_REJECT_REASONS; names already listed keep their earlier code). */
export const ITEM_REPAIR_REJECT_REASONS = ["not_repairable", "needs_anvil"] as const;
