import { TerrainCmd } from "../terrain.js";
import { DyeCmd } from "../dye.js";
import { DropItemCmd, PetOfferCmd } from "../pets.js";
/**
 * AgentOutput (core ai.ts) -> the inputs a human sends. Pure except applyAgentEmote (queues an emote request).
 * Action strings: "gather" | "gather:<target>" | "attack:<target>" | "eat:<slot>" | "drink:<slot>" | "craft:<recipe>[:<count>]"
 * | "build:<piece>:<x>:<y>" | "open:<target>" | "copen:<t>" | "cdeposit:<t>:<item>:<n>" | "cwithdraw:<t>:<item>:<n>" | "cclose" | "buy:<stall>:<slot>:<qty>:<revision>:<priceItem>:<priceCount>" | "sleep" (stand still).
 */
import { UnlockSkillCmd } from "../skills/progression.js";
import type { AgentOutput, CommandRegistry, Entity, InputFrame, World } from "@engine/core";
import { intentToFrame, type BotIntent } from "./bot_input.js";
import { CloseContainerCmd, DepositCmd, EquipCmd, GameplayActions, OpenContainerCmd, PlaceCmd, ReclaimCmd, RepairCmd, ToggleDoorCmd, ToggleFireCmd, UpgradeCmd, UseCmd, WearCmd, WithdrawCmd } from "../input.js";
import { BuyFromStallCmd, OpenStallCmd } from "../economy/stall.js";
import { QueueCraftCmd } from "../systems/craft_queue.js";
import { PartyAcceptCmd, PartyDeclineCmd, PartyInviteCmd, PartyKickCmd, PartyLeaveCmd } from "../party.js";
import { ClanAcceptCmd, ClanCreateCmd, ClanDemoteCmd, ClanInviteCmd, ClanKickCmd, ClanLeaveCmd, ClanPromoteCmd, ClanSetGoalCmd, ClanSetRankPermsCmd } from "../clan.js";
import { StockStallCmd } from "../economy/stall.js";
import { requestEmote } from "../expression.js";
import { VehicleEnterCmd, VehicleExitCmd, VehicleHitchCmd, VehicleStationCmd, VehicleUnhitchCmd } from "../vehicles.js";
import { VehicleDeployCmd, VehicleRefuelCmd, VehicleRepairCmd } from "../vehicle_craft.js";
import { MountDismountCmd, MountFeedCmd, MountRepairCmd, MountRideCmd, MountSaddleCmd } from "../mount_commands.js";
import { RopeLeadCmd } from "../rope_commands.js";

export function actionIntent(action: string): BotIntent | undefined {
  const [k, ...rest] = action.split(":"); const n = rest.map(Number); if (n.some((v) => !Number.isFinite(v))) return undefined;
  switch (k) {
    case "gather": return { kind: "gather", target: n[0] ?? 0 };
    case "attack": return n.length >= 1 ? { kind: "attack", target: n[0]! } : undefined;
    case "eat": case "drink": return n.length >= 1 ? { kind: "eat", slot: n[0]! } : undefined;
    case "craft": return n.length >= 1 ? { kind: "craft", recipe: n[0]!, count: n[1] ?? 1 } : undefined;
    case "build": return n.length >= 3 ? { kind: "build", piece: n[0]!, x: n[1]!, y: n[2]!, ...(n.length >= 6 ? { level: n[3]!, rot: n[4]!, tier: n[5]! } : {}) } : undefined; // ADR-252 [:level:rot:tier]
    case "open": return n.length >= 1 ? { kind: "open", target: n[0]! } : undefined;
    case "buy": return n.length >= 6 ? { kind: "buy", stall: n[0]!, listingSlot: n[1]!, qty: n[2]!, expectedRevision: n[3]!, expectedPriceItem: n[4]!, expectedPriceCount: n[5]! } : undefined;
    default: return undefined;
  }
}
/** Actions -> intents (unknown / malformed actions dropped). */
export const agentOutputIntents = (out: AgentOutput): BotIntent[] => out.actions.map(actionIntent).filter((x): x is BotIntent => x !== undefined);

/**
 * One InputFrame for an AgentOutput via intentToFrame: move (+vehicle boost) with the output's aim, then each action's bits and
 * commands merged in. Target 0 gathers (Primary bit, no command): the bot hits whatever is in front, like a human.
 */
export function agentOutputFrame(out: AgentOutput, tick: number, reg: CommandRegistry): InputFrame {
  const aim = out.aimX || out.aimY ? { x: out.aimX, y: out.aimY } : undefined;
  const f = intentToFrame({ kind: "move", dx: out.moveX, dy: out.moveY, sprint: out.sprint }, tick, reg, aim);
  if (!out.moveX && !out.moveY) f.actions |= out.sprint ? GameplayActions.Sprint : 0;
  for (const it of agentOutputIntents(out)) {
    const g = intentToFrame(it, tick, reg, aim); f.actions |= g.actions;
    for (const c of g.commands) if (!(it.kind === "gather" && it.target === 0)) f.commands.push(c);
  }
  return f;
}
/**
 * Bot-side emote: AgentOutput.emote -> requestEmote on the bot's authoritative entity (the host that owns the
 * server world calls this once per agent tick). Skipped while replaying; unknown names ignored. Returns true if queued.
 */
export function applyAgentEmote(world: World, e: Entity, out: AgentOutput): boolean {
  if (!out.emote || world.isReplaying) return false;
  return requestEmote(world, e, out.emote);
}

// ---------------- AgentOutput.commands (net command path) ----------------
/** One discrete command by registered (net) command name; matches core AgentOutput.commands entries. */
export interface AgentCommand { type: string; payload: unknown }
/** Structural view of AgentOutput with the commands field. Kept so gameplay compiles against a core without it. */
export type AgentOutputWithCommands = AgentOutput & { commands?: AgentCommand[] };

/** Action string -> a net command (buy, use, craft, place, plus open of a stall). Other actions return undefined and stay frame-only. */
/** Entity fields hold the bot's replica entity; the host (local.ts sendAgentCommands -> NetClient.sendCommand) maps them to NetIds. */
export function actionCommand(action: string): AgentCommand | undefined {
  if (action.startsWith("terrain:")) { const n = action.split(":").slice(1).map(Number); return n.length === 3 && n.every(Number.isInteger) && Math.abs(n[2]!) === 1 ? { type: TerrainCmd.name, payload: { x: n[0]!, y: n[1]!, dir: n[2]! } } : undefined; }
  const party = partyActionCommand(action); if (party !== null) return party;
  const clan = clanActionCommand(action); if (clan !== null) return clan;
  const veh = vehicleActionCommand(action); if (veh !== null) return veh;
  const mnt = mountActionCommand(action); if (mnt !== null) return mnt;
  const rope = ropeActionCommand(action); if (rope !== null) return rope;
  if (action.startsWith("skill:")) { const n = Number(action.slice(6)); return Number.isInteger(n) && n >= 0 ? { type: UnlockSkillCmd.name, payload: { node: n } } : undefined; } // ADR-113
  if (action.startsWith("tame:")) { const [, a, b] = action.split(":"); const t = Number(a), i = Number(b); return Number.isInteger(t) && t > 0 && Number.isInteger(i) && i > 0 ? { type: PetOfferCmd.name, payload: { target: t, item: i } } : undefined; } // ADR-145
  { const [k, ...r] = action.split(":"); const n = r.map(Number); const ok = n.every((v) => Number.isInteger(v) && v >= 0) && n.length >= 1; // ADR-203 container / fire
    if (k === "copen") return ok ? { type: OpenContainerCmd.name, payload: { target: n[0]! } } : undefined;
    if (k === "cclose") return { type: CloseContainerCmd.name, payload: {} };
    if (k === "fire") return ok ? { type: ToggleFireCmd.name, payload: { target: n[0]! } } : undefined;
    if (k === "cdeposit") return ok && n.length >= 3 ? { type: DepositCmd.name, payload: { target: n[0]!, item: n[1]!, count: n[2]! } } : undefined;
    if (k === "cwithdraw") return ok && n.length >= 3 ? { type: WithdrawCmd.name, payload: { target: n[0]!, item: n[1]!, count: n[2]! } } : undefined; // ADR-252
    if (k === "wear") return ok ? { type: WearCmd.name, payload: { slot: n[0]! } } : undefined;
    if (k === "drop") return ok && n.length >= 2 && n[0]! > 0 && n[1]! > 0 ? { type: DropItemCmd.name, payload: { item: n[0]!, count: n[1]! } } : undefined; // ADR-252 inventory "Drop"
    if (k === "door") return ok ? { type: ToggleDoorCmd.name, payload: { target: n[0]! } } : undefined;
    if (k === "dye") return ok && n.length >= 4 ? { type: DyeCmd.name, payload: { kind: n[0]!, slot: n[1]!, palette: n[2]!, index: n[3]! } } : undefined; } // Task 25: bot dye (same command players send; server re-validates brush + dye)
  if (action.startsWith("reclaim:")) { const n = Number(action.split(":")[1]); if (!Number.isInteger(n) || n < 0) return undefined; return { type: ReclaimCmd.name, payload: { target: n } }; }
  if (action.startsWith("equip:") || action.startsWith("repair:")) { const n = Number(action.split(":")[1]); if (!Number.isInteger(n) || n < 0) return undefined; return action[0] === "e" ? { type: EquipCmd.name, payload: { slot: n } } : { type: RepairCmd.name, payload: { target: n } }; } // ADR-203
  if (action.startsWith("upgrade:")) { const [, a, b] = action.split(":"); const t = Number(a), tier = Number(b); return Number.isInteger(t) && t > 0 && Number.isInteger(tier) && tier >= 0 ? { type: UpgradeCmd.name, payload: { target: t, tier } } : undefined; } // Task 28: bot home upgrade (same command players send; server re-validates cost + skill)
  const it = actionIntent(action); if (!it) return undefined;
  switch (it.kind) {
    case "eat": return { type: UseCmd.name, payload: { slot: it.slot } };
    case "craft": return { type: QueueCraftCmd.name, payload: { recipe: it.recipe, count: Math.max(1, Math.min(255, it.count ?? 1)) } }; // CraftCmd is not on the wire
    case "build": return { type: PlaceCmd.name, payload: { piece: it.piece, x: it.x, y: it.y, level: it.level ?? 0, rot: it.rot ?? 0, tier: it.tier ?? 0, variant: it.variant ?? 0 } };
    case "open": return { type: OpenStallCmd.name, payload: { stall: it.target } };
    case "buy": return { type: BuyFromStallCmd.name, payload: { stall: it.stall, listingSlot: it.listingSlot, qty: it.qty, expectedRevision: it.expectedRevision, expectedPriceItem: it.expectedPriceItem, expectedPriceCount: it.expectedPriceCount } };
    default: return undefined;
  }
}
/**
 * Party action strings: "pinvite:<entity>" | "paccept:<party>" | "pdecline:<party>" | "pleave" | "pkick:<entity>".
 * Returns null when the action is not a party action, and undefined when it is one but malformed.
 */
function partyActionCommand(action: string): AgentCommand | undefined | null {
  const [k, a] = action.split(":"); const n = Number(a);
  const one = (type: string, field: string): AgentCommand | undefined => (Number.isFinite(n) && a !== undefined ? { type, payload: { [field]: n } } : undefined);
  switch (k) {
    case "pinvite": return one(PartyInviteCmd.name, "target");
    case "paccept": return one(PartyAcceptCmd.name, "party");
    case "pdecline": return one(PartyDeclineCmd.name, "party");
    case "pkick": return one(PartyKickCmd.name, "target");
    case "pleave": return { type: PartyLeaveCmd.name, payload: {} };
    default: return null;
  }
}
/**
 * Clan action strings: "ccreate" | "cinvite:<entity>" | "caccept:<clan>" | "cleave" | "cpromote:<entity>" | "cdemote:<entity>"
 * | "ckick:<entity>" | "cperms:<role>:<mask>" | "cgoal:<goal>:<x>:<y>" | "cstock:<stall>:<listing>:<invSlot>:<count>".
 * null = not a clan action; undefined = malformed.
 */
function clanActionCommand(action: string): AgentCommand | undefined | null {
  const [k, ...rest] = action.split(":"); const n = rest.map(Number); const ok = (c: number) => n.length >= c && n.every(Number.isFinite);
  switch (k) {
    case "ccreate": return { type: ClanCreateCmd.name, payload: {} };
    case "cleave": return { type: ClanLeaveCmd.name, payload: {} };
    case "cinvite": return ok(1) ? { type: ClanInviteCmd.name, payload: { target: n[0]! } } : undefined;
    case "caccept": return ok(1) ? { type: ClanAcceptCmd.name, payload: { clan: n[0]! } } : undefined;
    case "cpromote": return ok(1) ? { type: ClanPromoteCmd.name, payload: { target: n[0]! } } : undefined;
    case "cdemote": return ok(1) ? { type: ClanDemoteCmd.name, payload: { target: n[0]! } } : undefined;
    case "ckick": return ok(1) ? { type: ClanKickCmd.name, payload: { target: n[0]! } } : undefined;
    case "cperms": return ok(2) ? { type: ClanSetRankPermsCmd.name, payload: { role: n[0]!, mask: n[1]! } } : undefined;
    case "cgoal": return ok(3) ? { type: ClanSetGoalCmd.name, payload: { goal: n[0]!, x: n[1]!, y: n[2]! } } : undefined;
    case "cstock": return ok(4) ? { type: StockStallCmd.name, payload: { stall: n[0]!, listingSlot: n[1]!, invSlot: n[2]!, count: Math.max(1, Math.min(65535, n[3]!)) } } : undefined;
    default: return null;
  }
}
/**
 * Vehicle action strings (DESIGN.md §31): "venter:<vehicle>[:<seat>]" | "vexit" | "vhitch:<trailer>:<tow>" | "vunhitch:<trailer>"
 * | "vstation:<vehicle>:<index>" | "vrefuel:<vehicle>:<slot>[:<count>]" | "vrepair:<vehicle>:<slot>" | "vdeploy:<slot>:<x>:<y>[:<heading>]".
 * Driving itself is moveX/moveY (+sprint = boost) while seated, exactly like a human. null = not a vehicle action.
 */
function vehicleActionCommand(action: string): AgentCommand | undefined | null {
  const [k, ...rest] = action.split(":"); const n = rest.map(Number); const ok = (c: number) => n.length >= c && n.every(Number.isFinite);
  switch (k) {
    case "venter": return ok(1) ? { type: VehicleEnterCmd.name, payload: { target: n[0]!, seat: n[1] ?? 255 } } : undefined;
    case "vexit": return { type: VehicleExitCmd.name, payload: {} };
    case "vhitch": return ok(2) ? { type: VehicleHitchCmd.name, payload: { target: n[0]!, tow: n[1]! } } : undefined;
    case "vunhitch": return ok(1) ? { type: VehicleUnhitchCmd.name, payload: { target: n[0]! } } : undefined;
    case "vstation": return ok(2) ? { type: VehicleStationCmd.name, payload: { target: n[0]!, station: n[1]! } } : undefined;
    case "vrefuel": return ok(2) ? { type: VehicleRefuelCmd.name, payload: { target: n[0]!, slot: n[1]!, count: Math.max(1, Math.min(255, n[2] ?? 1)) } } : undefined;
    case "vrepair": return ok(2) ? { type: VehicleRepairCmd.name, payload: { target: n[0]!, slot: n[1]! } } : undefined;
    case "vdeploy": return ok(3) ? { type: VehicleDeployCmd.name, payload: { slot: n[0]!, x: n[1]!, y: n[2]!, heading: n[3] ?? 0 } } : undefined;
    default: return null;
  }
}
/**
 * ADR-321 mount action strings: "mfeed:<animal>:<item>" (tame a wild one / heal the own mount) | "mride:<mount>" | "mdismount"
 * | "msaddle:<mount>:<slot>" | "mrepair:<mount>". The server re-validates (checkFeed / checkRide / checkSaddle / checkRepair).
 */
function mountActionCommand(action: string): AgentCommand | undefined | null {
  const [k, ...rest] = action.split(":"); const n = rest.map(Number); const ok = (c: number) => n.length >= c && n.every((v) => Number.isInteger(v) && v >= 0);
  switch (k) {
    case "mfeed": return ok(2) && n[1]! > 0 ? { type: MountFeedCmd.name, payload: { target: n[0]!, item: n[1]! } } : undefined;
    case "mride": return ok(1) ? { type: MountRideCmd.name, payload: { target: n[0]! } } : undefined;
    case "mdismount": return { type: MountDismountCmd.name, payload: {} };
    case "msaddle": return ok(2) ? { type: MountSaddleCmd.name, payload: { target: n[0]!, slot: n[1]! } } : undefined;
    case "mrepair": return ok(1) ? { type: MountRepairCmd.name, payload: { target: n[0]! } } : undefined;
    default: return null;
  }
}
/**
 * ADR-351 rope action strings: "rope:<animal>" attaches the rope to the animal, "rope:0" releases the
 * animal currently led. The server re-validates (checkLead: reach, rope equipped, ownership).
 */
function ropeActionCommand(action: string): AgentCommand | undefined | null {
  const [k, ...rest] = action.split(":"); const n = rest.map(Number); const ok = (c: number) => n.length >= c && n.every((v) => Number.isInteger(v) && v >= 0);
  switch (k) {
    case "rope": return ok(1) ? { type: RopeLeadCmd.name, payload: { target: n[0]! } } : undefined;
    default: return null;
  }
}
const COMMAND_ACTIONS = new Set(["mfeed", "mride", "mdismount", "msaddle", "mrepair", "rope", "terrain", "venter", "vexit", "vhitch", "vunhitch", "vstation", "vrefuel", "vrepair", "vdeploy", "ccreate", "cinvite", "caccept", "cleave", "cpromote", "cdemote", "ckick", "cperms", "cgoal", "cstock", "eat", "drink", "craft", "build", "open", "buy", "pinvite", "paccept", "pdecline", "pleave", "pkick", "skill", "equip", "repair", "upgrade", "copen", "cclose", "cdeposit", "fire", "cwithdraw", "wear", "door", "drop", "dye"]);
/**
 * Moves the command-type actions (eat, drink, craft, build, open, buy) out of out.actions and into out.commands, in order.
  Movement and gather/attack/sleep stay
 * as actions for the input frame. Mutates and returns out.
 */
export function emitAgentCommands<O extends AgentOutputWithCommands>(out: O): O {
  const keep: string[] = [];
  for (const a of out.actions) {
    if (!COMMAND_ACTIONS.has(a.split(":")[0]!)) { keep.push(a); continue; }
    const c = actionCommand(a); if (c) (out.commands ??= []).push(c);
  }
  out.actions = keep; return out;
}

/**
 * ADR-252: stance actions -> the stance inputs a player's client sends (ADR-244): "block" holds Guard, "crouch" presses
 * Crouch (the server toggles on the rising edge), "rest" is the Rest edge (lie down in the bed in reach). They are not
 * commands or intents (actionIntent / actionCommand ignore them); the host ORs them into the input frame.
 */
export interface AgentStanceInput { guard: boolean; crouch: boolean; rest: boolean }
export function agentStanceInput(out: Pick<AgentOutput, "actions">): AgentStanceInput {
  let guard = false, crouch = false, rest = false;
  for (const a of out.actions) { if (a === "block") guard = true; else if (a === "crouch") crouch = true; else if (a === "rest") rest = true; }
  return { guard, crouch, rest };
}
