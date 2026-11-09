/**
 * ADR-319 / ADR-320 mount commands (definitions only, no imports beyond core + components, so input.ts can append them at
 * module top level without an ESM cycle; handlers live in mounts.ts). Append-only: registered after MOVE_COMMANDS.
 *  - MountFeedCmd: offer one `item` to a wild mount-species animal (taming progress) or to your own mount (heal).
 *  - MountRideCmd / MountDismountCmd: get on a mount you may ride / get off.
 *  - MountSaddleCmd: put the saddle in inventory `slot` on `target` (swap allowed when the bag contents fit).
 *  - MountUnsaddleCmd: take the saddle off (only with an empty saddlebag). MountRepairCmd: repair the equipped saddle.
 *  - MountRenameCmd: name your mount (ASCII, MOUNT_NAME_MAX).
 */
import { defineCommand, type CommandDef } from "@engine/core";
import { MOUNT_NAME_MAX } from "./components.js";

export const MountFeedCmd = defineCommand("gameplay.mountFeed", { target: "u32", item: "u16" });
export const MountRideCmd = defineCommand("gameplay.mountRide", { target: "u32" });
export const MountDismountCmd = defineCommand("gameplay.mountDismount", {});
export const MountSaddleCmd = defineCommand("gameplay.mountSaddle", { target: "u32", slot: "u8" });
export const MountUnsaddleCmd = defineCommand("gameplay.mountUnsaddle", { target: "u32" });
export const MountRepairCmd = defineCommand("gameplay.mountRepair", { target: "u32" });
export const MountRenameCmd = defineCommand("gameplay.mountRename", { target: "u32", len: "u8", text: { type: "u8", length: MOUNT_NAME_MAX } });
export const MOUNT_COMMANDS: readonly CommandDef[] = [MountFeedCmd, MountRideCmd, MountDismountCmd, MountSaddleCmd, MountUnsaddleCmd, MountRepairCmd, MountRenameCmd];
export const MOUNT_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [MountFeedCmd, MountRideCmd, MountSaddleCmd, MountUnsaddleCmd, MountRepairCmd, MountRenameCmd].map((d) => [d.name, ["target"]]));
/** Reject reasons (append to the server's COMMAND_REJECT_REASONS; names already listed keep their earlier code). */
export const MOUNT_REJECT_REASONS = ["not_mount", "not_tameable", "needs_skill", "riding", "not_riding", "mount_busy", "no_saddle", "bag_not_empty", "bag_too_full", "not_saddle", "not_food", "no_room", "full_health", "not_damaged", "already_riding", "dead", "busy", "blocked", "recipe_locked"] as const;
