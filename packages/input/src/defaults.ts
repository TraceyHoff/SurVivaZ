import { defineActions, extendActions } from "@engine/core";
import type { ActionDef, BindingProfile, ContextDef } from "./model.js";
import type { FrameMapping } from "./system.js";
import kbm from "../profiles/keyboardMouse.json" with { type: "json" };
import pad from "../profiles/gamepad.json" with { type: "json" };
import touch from "../profiles/touch.json" with { type: "json" };

/**
 * Default action set, contexts and frame mapping implementing Survival Systems' input contract.
 * Frame hold bits keep gameplay's existing order (GameplayActions: MoveUp..Build = bits 0..8) and append Crouch, Charge.
 */
export const DefaultHoldBits = extendActions(
  defineActions(["MoveUp", "MoveDown", "MoveLeft", "MoveRight", "Sprint", "Primary", "Secondary", "Interact", "Build"] as const),
  ["Crouch", "Charge"] as const,
);
/** Edge actions -> InputFrame.edges bit order (append only). */
export const EDGE_ACTIONS = ["Jump", "Reload", "Hotbar1", "Hotbar2", "Hotbar3", "Hotbar4", "Hotbar5", "Hotbar6", "Hotbar7", "Hotbar8",
  "HotbarNext", "HotbarPrev", "QuickUse", "ToggleInventory", "ToggleCrafting", "ToggleMap", "OpenChat", "OpenSocial", "Cancel",
  "Carry", "Rest"] as const; // ADR-244 append-only
export const DefaultEdgeBits = defineActions(EDGE_ACTIONS);

const btn = (name: string): ActionDef => ({ name, type: "button" });
export const DEFAULT_ACTIONS: readonly ActionDef[] = [
  { name: "Move", type: "axis2D" }, { name: "Aim", type: "axis2D" }, { name: "Camera.Zoom", type: "axis1D" },
  /** ADR-253 camera view rotation (90° steps): KBM [ / ], pad RB + D-pad ←/→ (build mode: LT + D-pad ←/→), touch HUD buttons. */
  btn("Camera.RotateCCW"), btn("Camera.RotateCW"),
  ...["Sprint", "Primary", "Secondary", "Crouch", "Interact", "ContextRadial", "Charge", ...EDGE_ACTIONS, "ToggleBuild", "ToggleCharacter", "RoadTool", "PlaceSign", "Vehicle.Engine", "Vehicle.Lights"].map(btn),
  ...["Mark", "Confirm", "Cancel", "Next"].map((n) => btn(`Road.${n}`)), { name: "Road.Cursor", type: "axis2D" },
  ...["PlaceConfirm", "Cancel", "RotateCW", "RotateCCW", "PieceNext", "PiecePrev", "TierNext", "TierPrev", "ToggleSnap", "LevelUp", "LevelDown", "DemolishMode", "UpgradeMode", "RepairMode", "RoadTool", "PlaceSign"].map((n) => btn(`Build.${n}`)), // ADR-171: last two appended
  { name: "Build.Nudge", type: "axis2D" },
  { name: "UI.Navigate", type: "axis2D" }, ...["Submit", "Back", "TabNext", "TabPrev"].map((n) => btn(`UI.${n}`)),
  ...["MoveSlot", "SplitStack", "Drop", "QuickTransfer", "Equip", "Use", "TakeAll", "Sort"].map((n) => btn(`Inv.${n}`)),
  ...["Craft", "Amount", "Cancel", "FilterNext", "FilterPrev"].map((n) => btn(`Craft.${n}`)),
  ...["AddOffer", "RemoveOffer", "Lock", "Confirm"].map((n) => btn(`Trade.${n}`)),
  ...["Send", "Cancel", "SwitchChannel", "QuickPhrase"].map((n) => btn(`Chat.${n}`)),
  ...["Invite", "Kick", "Promote", "Demote", "Leave", "SetPermissions", "ContextMenu"].map((n) => btn(`Social.${n}`)),
  ...["Confirm", "Cancel"].map((n) => btn(`Dialog.${n}`)),
  /** ADR-263 (Task 36) shovel terrain edit (Gameplay, only while a shovel is in the main hand): KBM Y raise / H lower,
   * pad LT + D-pad ↑ raise / LT + D-pad ↓ lower, touch the HUD ⬆ Raise / ⬇ Dig buttons. Appended. */
  btn("Terrain.Raise"), btn("Terrain.Lower"),
  /** ADR-316 demolish mode without a ghost (KBM Delete / Backspace / pad LB+B / touch build menu + HUD) and ADR-318 move a placed piece
   * (KBM F / pad hold Y / touch HUD "Move"). Appended. */
  btn("ToggleDemolish"), btn("Build.Move"),
  /** ADR-319 mount panel (ride / saddlebag / saddle / feed / rename): KBM U / pad LB+X / touch "Mount" (contextual). Appended. */
  btn("Mount.Menu"),
];
/** Context stack defaults. Building keeps movement (non-consuming); menus block movement; chat blocks gameplay except movement on gamepad. */
export const DEFAULT_CONTEXTS: readonly ContextDef[] = [
  { name: "Gameplay", priority: 0 },
  { name: "Building", priority: 10 },
  /** ADR-123 road tool: non-consuming like Building (walk while laying); gamepad RS moves the tile cursor. */
  { name: "Road", priority: 12 },
  { name: "Inventory", priority: 20, consume: true },
  { name: "Crafting", priority: 20, consume: true },
  { name: "Trade", priority: 25, consume: true },
  { name: "Social", priority: 25, consume: true },
  { name: "Chat", priority: 30, consume: true, textEntry: true, passthrough: { gamepad: ["Move"] } },
  { name: "Dialog", priority: 40, consume: true },
];
export const DEFAULT_PROFILES: readonly BindingProfile[] = [kbm as BindingProfile, pad as BindingProfile, touch as BindingProfile];
export const DEFAULT_FRAME_MAPPING: FrameMapping = {
  holdBits: { Sprint: DefaultHoldBits.Sprint, Primary: DefaultHoldBits.Primary, Secondary: DefaultHoldBits.Secondary, Interact: DefaultHoldBits.Interact, Crouch: DefaultHoldBits.Crouch, Charge: DefaultHoldBits.Charge },
  edgeBits: Object.fromEntries(EDGE_ACTIONS.map((a) => [a, DefaultEdgeBits[a]])),
  move: { action: "Move", up: DefaultHoldBits.MoveUp, down: DefaultHoldBits.MoveDown, left: DefaultHoldBits.MoveLeft, right: DefaultHoldBits.MoveRight },
  ghostNudge: "Build.Nudge",
  contextBits: { Building: DefaultHoldBits.Build },
};
/** UI actions that drive the FocusManager per context (submit/back differ by screen). */
export const DEFAULT_FOCUS_ACTIONS = {
  navigate: "UI.Navigate", tabNext: "UI.TabNext", tabPrev: "UI.TabPrev",
  submit: ["UI.Submit", "Inv.MoveSlot", "Craft.Craft", "Trade.AddOffer", "Social.ContextMenu", "Dialog.Confirm"],
  back: ["UI.Back", "Dialog.Cancel", "Chat.Cancel"],
};
import touchLayouts from "../profiles/touchLayout.json" with { type: "json" };
import type { VirtualLayout } from "./touch.js";
/** Default virtual control layouts (data only; Renderer/Art draw them). Swap layouts on context change. */
export const DEFAULT_TOUCH_LAYOUTS: { gameplay: VirtualLayout; building: VirtualLayout } = touchLayouts as { gameplay: VirtualLayout; building: VirtualLayout };
