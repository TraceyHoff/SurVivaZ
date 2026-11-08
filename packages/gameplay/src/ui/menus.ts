import { SelectHotbarCmd } from "../input.js";
import { wetDrySeconds } from "../exposure-stages.js";
import { ContainerToSlotCmd, MoveSlotCmd, SplitStackCmd } from "../inventory_ops.js";
import { DropItemCmd, encodePetName, nearestPet, petName, PetResult, PetCommandCmd, PetGuardCmd, PetOfferCmd, PetRenameCmd } from "../pets.js";
import { AnimalSkillCmd } from "../animal_skills.js";
import { DismissWorkerCmd, HireWorkerCmd, nearestWorker, SetWorkerJobCmd, WORKER_NO_TARGET, type WorkerJobDetails } from "../recruitment.js";
import { DyeCmd, DyeKind, DyePalette } from "../dye.js";
import { ReadyCmd } from "../ready.js";
/**
 * Menu view-models + command builders for the client's in-game menus (apps/client game-menus.ts, ADR-095 shell).
 * Pure reads over a World (client replica or server world) and plain {cmd, args} intents; no DOM, browser-safe.
 * The client sends intents through its net bridge (`gameplayNet(cmd)`); entity args (target/stall) are Entities here
 * and the sender maps them to NetIds. Server handlers re-validate everything; reasons here are only hints.
 */
import { Appearance, GroupRole, Membership, PlayerId, SEASON_NAMES, Transform, WEARABLE_SLOTS, Weather, getAppearance, slotIndex, SLOT_PALETTE, type CommandDef, type CosmeticCatalogLike, type Entity, type World } from "@engine/core";
import { BuildPiece, CraftingStation, Dead, Container, Exposure, Health, LootBag, ClanInvitePending, ClanStatus, CraftQueue, PartyInvitePending, PartyRank, Progression, RoomHeat, SlotDye, StallHeader, Survival, Wardrobe } from "../components.js";
import { gameplayDefs } from "../config.js";
import { carriedBags } from "../stance.js";
import type { ItemCount } from "../defs.js";
import { countItem, hasBrushInHotbar, listSlots, readSlots, slotItem, slotsWeight } from "../inventory.js";
import { itemInfo, type NameLookup } from "../economy/provenance.js";
import { BuyFromStallCmd, OpenStallCmd, CollectTillCmd, SetListingCmd, SetStallNameCmd, SetStallOpenCmd, StockStallCmd, UnstockStallCmd, listingRevision, stallListings, stallName, tillOf } from "../economy/stall.js";
import { holdingTorch } from "../systems/crafting.js";
import { CancelQueuedCraftCmd, MAX_CRAFT_COUNT, QueueCraftCmd, craftQueueReason, owedOf } from "../systems/craft_queue.js";
import { pieceCost, pieceGates } from "../building/place.js";
import { hasSkillUnlock, unlockRequirement, xpToNext } from "../skills/tree.js";
import { activeDiseases, careStatus, diseasePresentation, CARE_DRY_MAX } from "../diseases.js";
import { ambientTemperature, effectiveInsulation, heatAt, shelteredAirTemp, weatherDef, worldSeason } from "../systems/environment.js";
import { BoilCmd, DepositCmd, EquipCmd, PaintCmd, PlaceCmd, ToggleDoorCmd, ToggleFireCmd, UseCmd, WearCmd, WithdrawCmd } from "../input.js";
import { Equipment, Worn } from "../components.js";
import { ItemCategory, WEAR_SLOTS, WeatherKind } from "../defs.js";
import { entityIndex } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { isAuthority } from "../config.js";
import { NO_SLOT } from "../components.js";
import { Fuel, Pet } from "../components.js";
import { fuelSecondsLeft } from "../systems/fuel.js";
import { KEY_ITEM, keyTooltip } from "../vehicle_keys.js";
const itemDefKey = (w: World, item: number): string => gameplayDefs(w).items.get(item)?.key ?? "";
import { COSMETICS, EquipCosmeticCmd, SetAppearanceCmd, canEditAppearance, hasCreatedLook, unlocksOf } from "../customization.js";
import { canLootBagAt } from "../combat/pvp.js";
import { isBaseStoragePiece } from "../ai/storage_api.js";
import { PartyAcceptCmd, PartyDeclineCmd, PartyInviteCmd, PartyKickCmd, PartyLeaveCmd, PARTY_RULES } from "../party.js";
import { PlaceMapMarkerCmd, RemoveMapMarkerCmd } from "../map_marker_commands.js";
import { MAP_MARKER_LABEL_MAX } from "../components.js";
import { ClanAcceptCmd, ClanDeclineCmd, ClanCreateCmd, ClanDemoteCmd, ClanDisbandCmd, ClanInviteCmd, ClanKickCmd, ClanLeaveCmd, ClanPromoteCmd, ClanSetGoalCmd, ClanSetRankPermsCmd } from "../clan.js";
import { recentBuilds, recentCrafts } from "../recent.js";
import { CLAN_GOAL_COUNT, CLAN_PERMS, clanPermBit, clanState, defaultRankMasks, type ClanPerm } from "../clan_state.js";

export const TICKS_PER_SECOND = 20;
/** One command intent for the client to send (`client.sendCommand(gameplayNet(cmd), args)` after NetId mapping). */
export interface MenuIntent { cmd: CommandDef; args: Record<string, number | number[]>; /** arg names holding Entities (sender maps to NetIds) */ entities?: readonly string[] }
/** `tick` (ADR-172): the authoritative server tick on a networked client. A replica's own `world.tick` counts from its join, so timers that come from the server (invite expiry, craft progress, fuel) must be compared against this value. */
export interface MenuCtx { world: World; player: Entity; names?: NameLookup; catalog?: CosmeticCatalogLike; tick?: number }
/** ADR-172: the "now" for server-stamped ticks. */
export const ctxTick = (c: MenuCtx): number => c.tick ?? c.world.tick;
const intent = (cmd: CommandDef, args: MenuIntent["args"], entities?: readonly string[]): MenuIntent => (entities ? { cmd, args, entities } : { cmd, args });
const itemName = (w: World, item: number): string => gameplayDefs(w).items.get(item)?.name ?? (item ? `#${item}` : "");
const pidOf = (w: World, e: Entity): number => w.getField(e, PlayerId, "id") ?? 0;
const nameOf = (c: MenuCtx, playerId: number): string => (playerId ? c.names?.get(playerId) ?? `Player ${playerId}` : "");
const withNames = (w: World, l: readonly ItemCount[], who?: Entity) => l.map((i) => ({ item: i.item, name: itemName(w, i.item), count: i.count, have: who !== undefined ? countItem(w, who, i.item) : 0 }));

// ---- inventory --------------------------------------------------------------------------------------
export interface InventorySlotView { slot: number; item: number; /** manifest icon key (ItemDef.spriteKey: `sprite` override, else item key) */ icon: string; name: string; count: number; durability: number; crafterId: number; crafterName: string; tooltip: string; /** ADR-128: context action for consumables ("eat" | "drink" | "apply"), else undefined */ consume?: "eat" | "drink" | "apply";
  /** ADR-135: how the slot equips ("hand" = main hand via EquipCmd, "wear" = gear slot via WearCmd) and whether it is equipped now */ equip?: "hand" | "wear"; equipped?: boolean; /** ADR-290: remaining liquid in a fillable container (sips > 0), else undefined */ fill?: LiquidFill }
/** ADR-290: remaining fill of a liquid container: `sips` left of `max` (ItemDef.sips), `frac` 0..1, and the liquid kind. */
export interface LiquidFill { sips: number; max: number; frac: number; liquid: "water" | "boiled_water" }
/** ADR-290: the authoritative fill (slot durability = sips left, ItemDef.sips = capacity) for any liquid container; undefined
 *  for every other item. Display only — the same numbers drinking / watering / refilling already use. */
export function liquidFill(w: World, item: number, durability: number): LiquidFill | undefined {
  const d = gameplayDefs(w).items.get(item); const max = d?.sips ?? 0; if (!d || max <= 0) return undefined;
  const sips = Math.max(0, Math.min(max, Math.floor(durability))); return { sips, max, frac: sips / max, liquid: d.boiled ? "boiled_water" : "water" };
}
/** ADR-128: "eat" / "drink" for consumables (liquid containers and thirst-only food drink), undefined otherwise. */
export function consumeKind(w: World, item: number): "eat" | "drink" | "apply" | undefined {
  const d = gameplayDefs(w).items.get(item); if (!d?.food) return undefined;
  if (d.cures.length && !d.food.hunger && !d.food.thirst && !d.food.health) return "apply";
  return d.sips > 0 || (d.food.thirst > 0 && d.food.hunger <= 0) ? "drink" : "eat";
}
/** ADR-128: tooltip line(s) with food/water values ("Food +24 · Water +2 · Health +3"; containers add "Water 3/6 sips"). */
export function foodTooltip(w: World, item: number, durability = 0): string {
  const d = gameplayDefs(w).items.get(item); const f = d?.food; if (!f) return "";
  if (consumeKind(w, item) === "apply") return "Apply to heal " + d!.cures.map(key => gameplayDefs(w).diseases.find(x => x.key === key)?.name ?? key).join(", ") + ". Not consumed when unneeded.";
  const per = d.sips > 0 ? 1 / d.sips : 1; const r = (v: number): string => `${v > 0 ? "+" : ""}${Math.round(v * per * 10) / 10}`;
  const parts = [f.hunger ? `Food ${r(f.hunger)}` : "", f.thirst ? `Water ${r(f.thirst)}` : "", f.health ? `Health ${r(f.health)}` : ""].filter(Boolean);
  const line = parts.join(" · ") + (d.sips > 0 ? " per sip" : "");
  return d.sips > 0 ? `${line}\n${durability > 0 ? `Water ${durability}/${d.sips} sips` : "Empty: use next to water to refill"}` : line;
}
/** ADR-128: eat/drink the item in `slot` (server validates cooldown, rot, refill-at-water). */
export function useIntent(slot: number): MenuIntent { return intent(UseCmd, { slot }); }
/** Task 13: boil the filled raw-water container in `slot` at a lit campfire (server validates the fire). */
export function boilIntent(slot: number): MenuIntent { return intent(BoilCmd, { slot }); }
/** ADR-135: main-hand equip (same command the hotbar keys send) and wear/unwear toggle for gear slots. */
export const selectHotbarIntent = (slot: number): MenuIntent => intent(SelectHotbarCmd, { slot });
export const equipIntent = (slot: number): MenuIntent => intent(EquipCmd, { slot });
/** ADR-204: split `count` off a stack (where 0 = own inventory, 1 = open container) / move a slot (swap) e.g. onto the hotbar. */
export const splitStackIntent = (slot: number, count: number, where = 0): MenuIntent => intent(SplitStackCmd, { where, slot, count });
export const containerToSlotIntent = (slot: number, to: number, dir: 0 | 1 = 0): MenuIntent => intent(ContainerToSlotCmd, { slot, to, dir });
/** ADR-231: pack slot -> container slot (swap / merge; the container slot may be empty). */
export const slotToContainerIntent = (packSlot: number, cslot: number): MenuIntent => intent(ContainerToSlotCmd, { slot: cslot, to: packSlot, dir: 1 });
export const moveSlotIntent = (slot: number, to: number, where = 0): MenuIntent => intent(MoveSlotCmd, { where, slot, to });
/** World-map marker intents: place at (x, y) with a visibility (0 private, 1 party, 2 clan) and a label; remove by entity. */
export const placeMapMarkerIntent = (x: number, y: number, visibility: number, label: string): MenuIntent => {
  const chars = Array.from(label.slice(0, MAP_MARKER_LABEL_MAX)).map((c) => c.charCodeAt(0));
  return intent(PlaceMapMarkerCmd, { x, y, visibility, len: chars.length, label: chars });
};
export const removeMapMarkerIntent = (marker: Entity): MenuIntent => intent(RemoveMapMarkerCmd, { marker: marker as unknown as number }, ["marker"]);
export const wearIntent = (slot: number): MenuIntent => intent(WearCmd, { slot });
export const EQUIP_SLOT_LABELS = ["Head", "Body", "Legs", "Feet", "Hands", "Back", "Off hand", "Accessory"] as const;
export interface EquipSlotView { slot: number; label: string; invSlot: number; item: number; name: string; icon: string }
/** ADR-135: paper-doll slots: Main hand (index -1) then the 8 Worn slots; invSlot -1 = empty. */
export function equipmentView(c: MenuCtx): EquipSlotView[] {
  const w = c.world; const d = gameplayDefs(w); const out: EquipSlotView[] = [];
  const mk = (slot: number, label: string, inv: number, item: number): EquipSlotView => ({ slot, label, invSlot: item ? inv : -1, item, name: item ? itemName(w, item) : "", icon: item ? d.items.get(item)?.spriteKey ?? "" : "" });
  const eq = w.isRegistered(Equipment) ? w.get(c.player, Equipment) : undefined;
  out.push(mk(-1, "Main hand", eq?.mainHandSlot ?? -1, eq && eq.mainHandSlot !== NO_SLOT ? eq.mainHandItem : 0));
  const st = w.isRegistered(Worn) && w.has(c.player, Worn) ? w.store(Worn) : undefined; const s = st ? st.slot(entityIndex(c.player)) : -1;
  for (let i = 0; i < WEAR_SLOTS; i++) { const sl = st && s >= 0 ? st.data.slot[s * WEAR_SLOTS + i]! : 0; out.push(mk(i, EQUIP_SLOT_LABELS[i]!, sl - 1, sl ? st!.data.item[s * WEAR_SLOTS + i]! : 0)); }
  return out;
}
// ---- holding capacity (pack / container / station storage) -----------------------------------------------
/** Weight + slot capacity of any inventory-like entity (pack, container, station storage): weight is recomputed
 * from contents, maxWeight already includes the carry skill for packs (readSlots). `pct` is the weight fraction;
 * encumbrance starts at 0.7 (movement.json encumberedFrom) and slows to 0.45x at full weight. */
export interface CapacityView { weight: number; maxWeight: number; freeWeight: number; slotsUsed: number; slotCount: number; freeSlots: number; pct: number }
export function capacityView(c: MenuCtx, e: Entity): CapacityView | undefined {
  const w = c.world; let v: ReturnType<typeof readSlots>;
  try { v = readSlots(w, e); } catch { return undefined; }
  const defs = gameplayDefs(w); let used = 0; for (let i = 0; i < v.slotCount; i++) if (v.item(i)) used++;
  const weight = slotsWeight(v, defs); const max = v.maxWeight;
  return { weight, maxWeight: max, freeWeight: Math.max(0, max - weight), slotsUsed: used, slotCount: v.slotCount, freeSlots: Math.max(0, v.slotCount - used), pct: max > 0 ? weight / max : 0 };
}
/** One-line capacity summary, e.g. "42.3/60 kg · 12/16 slots · 17.7 kg + 4 slots free". */
export function capacityText(cv: CapacityView): string {
  return `${Math.round(cv.weight * 10) / 10}/${Math.round(cv.maxWeight * 10) / 10} kg · ${cv.slotsUsed}/${cv.slotCount} slots · ${Math.round(cv.freeWeight * 10) / 10} kg + ${cv.freeSlots} slots free`;
}

/** ADR-128: drink straight from an adjacent water tile (UseCmd with NO_SLOT). */
export function drinkWaterIntent(): MenuIntent { return intent(UseCmd, { slot: NO_SLOT }); }
function equippedSlots(c: MenuCtx): Set<number> { const o = new Set<number>(); for (const v of equipmentView(c)) if (v.invSlot >= 0) o.add(v.invSlot); return o; }
export function inventoryView(c: MenuCtx): InventorySlotView[] {
  const w = c.world; const out: InventorySlotView[] = []; let equipped: Set<number> | undefined;
  for (const s of listSlots(w, c.player)) {
    if (!s.item || !s.count) continue;
    const info = itemInfo(w, c.player, s.slot, c.names ?? { get: () => undefined });
    const crafterName = info?.crafterName || nameOf(c, s.crafterId);
    const name = itemName(w, s.item); const ck = consumeKind(w, s.item);
    const tip = [`${name} ×${s.count}`, s.durability && !gameplayDefs(w).items.get(s.item)?.sips && gameplayDefs(w).items.get(s.item)?.maxDurability ? `Durability ${s.durability}/${gameplayDefs(w).items.get(s.item)!.maxDurability}` : "", foodTooltip(w, s.item, s.durability), itemDefKey(w, s.item) === KEY_ITEM ? keyTooltip(w, s.crafterId) : crafterName ? `Crafted by ${crafterName}` : ""].filter(Boolean).join("\n");
    const def = gameplayDefs(w).items.get(s.item); const handy = def?.weapon || def?.tool || def?.ranged || def?.thrown;
    const eqv = equipped ??= equippedSlots(c); const equip = def?.wear && (def.category === ItemCategory.Clothing || def.category === ItemCategory.Armor) ? "wear" as const : handy ? "hand" as const : def?.wear ? "wear" as const : undefined;
    const fill = liquidFill(w, s.item, s.durability);
    out.push({ slot: s.slot, item: s.item, icon: def?.spriteKey ?? "", name, count: s.count, durability: s.durability, crafterId: s.crafterId, crafterName, tooltip: tip, ...(ck ? { consume: ck } : {}), ...(equip ? { equip, equipped: eqv.has(s.slot) } : {}), ...(fill ? { fill } : {}) });
  }
  return out;
}

// ---- crafting ---------------------------------------------------------------------------------------
export interface RecipeView { id: number; key: string; name: string; seconds: number; station: number; output: { item: number; name: string; count: number }; ingredients: { item: number; name: string; count: number; have: number }[]; reason: string | undefined }
export interface QueueJobView { slot: number; recipe: number; name: string; count: number; state: number; progress: number; secondsLeft: number }
export interface OwedView { item: number; name: string; count: number; crafterName: string }
/** ADR-136: `station` = which list this is (0 = on your person / hand only); `elsewhere` = recipes hidden here, per station kind (hint text). */
export interface CraftingView { station: number; stationName: string; recipes: RecipeView[]; queue: QueueJobView[]; owed: OwedView[]; maxCount: number; elsewhere: { station: number; name: string; count: number }[] }
/** Display names per StationKind (0 hand … 5 garage). */
export const STATION_NAMES: Readonly<Record<number, string>> = { 0: "By hand", 1: "Campfire / stove", 2: "Workbench", 3: "Furnace", 4: "Anvil / forge", 5: "Garage" };
// ---- container panel (ADR-098: up to 96 slots, paged) ------------------------------------------------
/** Slots per page in the container panel (one page = the old 24-slot box). */
export const CONTAINER_PAGE_SIZE = 24;
export interface ContainerSlotView { slot: number; item: number; icon: string; name: string; count: number; tooltip: string; /** ADR-290 */ fill?: LiquidFill }
export interface ContainerView { entity: Entity; slotCount: number; page: number; pages: number; first: number; slots: ContainerSlotView[]; weight: number; maxWeight: number }
/** The container the player has open on this replica: Container replicates only to viewers (containerViewersScope),
 *  so on a client the nearest non-player Container within reach is the open one. */
export function openContainer(c: MenuCtx): Entity | undefined {
  const w = c.world; const p = w.get(c.player, Transform); if (!p) return undefined;
  const reach = gameplayDefs(w).building.containerReach + 1; let best: Entity | undefined; let bd = reach * reach;
  for (const e of w.query([Container, Transform])) {
    if (e === c.player || (w.isRegistered(Pet) && w.has(e, Pet))) continue; // ADR-145: a pet bag shows only in the pet panel
    const t = w.get(e, Transform)!; const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
    if (d <= bd) { bd = d; best = e; }
  }
  return best;
}
/** One page of a container (every slot in the page, empties included, so focus positions stay stable). `page` is clamped. */
export function containerView(c: MenuCtx, e: Entity, page = 0, pageSize = CONTAINER_PAGE_SIZE): ContainerView | undefined {
  const w = c.world; const box = w.get(e, Container); if (!box) return undefined;
  const v = readSlots(w, e); const n = v.slotCount; const pages = Math.max(1, Math.ceil(n / pageSize));
  const pg = Math.max(0, Math.min(pages - 1, page | 0)); const first = pg * pageSize; const slots: ContainerSlotView[] = [];
  for (let i = first; i < Math.min(n, first + pageSize); i++) {
    const item = v.item(i), count = v.count(i); const name = item ? itemName(w, item) : "";
    const fill = item ? liquidFill(w, item, v.durability(i)) : undefined;
    slots.push({ slot: i, item, count, name, icon: item ? gameplayDefs(w).items.get(item)?.spriteKey ?? "" : "", tooltip: item ? `${name} ×${count} · slot ${i + 1}/${n}` : `Empty · slot ${i + 1}/${n}`, ...(fill ? { fill } : {}) });
  }
  return { entity: e, slotCount: n, page: pg, pages, first, slots, weight: box.weight, maxWeight: box.maxWeight };
}
/** ADR-160: withdraw every stack from an open container (server: Withdraw with item 0). */
export const takeAllIntent = (target: Entity): MenuIntent => intent(WithdrawCmd, { target, item: 0, count: 0 }, ["target"]);
export const withdrawIntent = (target: Entity, item: number, count: number): MenuIntent => intent(WithdrawCmd, { target, item, count }, ["target"]);
/** ADR-108 station fuel panel: lit state, burn time left, and the fuel items the player can drop in. */
export interface FuelView { lit: boolean; secondsLeft: number; fuels: { item: number; key: string; name: string; count: number; seconds: number }[] }
export function fuelView(c: MenuCtx, fire: Entity): FuelView | undefined {
  const w = c.world; if (!w.has(fire, Fuel)) return undefined; const defs = gameplayDefs(w);
  const fuels: FuelView["fuels"] = [];
  for (const x of listSlots(w, c.player)) { const it = defs.items.get(x.item); if (!it || !it.fuelSeconds) continue; const f = fuels.find((y) => y.item === x.item); if (f) f.count += x.count; else fuels.push({ item: x.item, key: it.key, name: it.name, count: x.count, seconds: it.fuelSeconds }); }
  return { lit: (w.getField(fire, Fuel, "lit") ?? 0) > 0, secondsLeft: fuelSecondsLeft(w, fire, undefined, c.tick), fuels };
}
export const toggleFireIntent = (target: Entity): MenuIntent => intent(ToggleFireCmd, { target }, ["target"]);
export const toggleDoorIntent = (target: Entity): MenuIntent => intent(ToggleDoorCmd, { target }, ["target"]);
export const depositIntent = (target: Entity, item: number, count: number): MenuIntent => intent(DepositCmd, { target, item, count }, ["target"]);

/** ADR-136: the personal menu (station 0) lists ONLY hand recipes; a station's panel lists ONLY that station's recipes. */
export function craftingView(c: MenuCtx, station = 0): CraftingView { // station -1 = every recipe (camper station filters itself)
  const w = c.world; const defs = gameplayDefs(w); const all = [...defs.recipes.values()];
  // ADR-141: a client replica never runs the postSim spatial-index system, so station range checks saw no stations
  // and every station recipe read "no_station" (greyed, "light it / move closer") while standing at the workbench.
  if (!isAuthority(w)) installSpatialIndex(w).rebuild();
  const counts = new Map<number, number>(); for (const r of all) if (station >= 0 && r.station !== station) counts.set(r.station, (counts.get(r.station) ?? 0) + 1);
  const elsewhere = [...counts].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({ station: k, name: STATION_NAMES[k] ?? `Station ${k}`, count: n }));
  const torchHeld = station === 0 && holdingTorch(w, c.player); // ADR-262: torch recipes (cooked meat) join the personal list
  const recipes = all.filter((r) => station < 0 || r.station === station || (torchHeld && r.torch === true)).map((r): RecipeView => ({ id: r.id, key: r.key, name: itemName(w, r.output.item), seconds: r.seconds, station: r.station,
    output: { item: r.output.item, name: itemName(w, r.output.item), count: r.output.count }, ingredients: withNames(w, r.ingredients, c.player), reason: craftQueueReason(w, c.player, r.id, 1) }));
  // Task 33: craftable first — a recipe with no reason is craftable right now (materials + station + skill +
  // unlock + queue space, all for ×1). Stable sort, so the data order is kept within each group.
  recipes.sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0));
  const queue: QueueJobView[] = []; const q = w.get(c.player, CraftQueue);
  if (q) for (let i = 0; i < q.state.length; i++) {
    const st = q.state[i]!; if (!st) continue; const r = defs.recipes.get(q.recipeId[i]!);
    const s0 = q.startTick[i]!, s1 = q.endTick[i]!; const running = st === 2 && s1 > s0;
    const progress = running ? Math.min(1, Math.max(0, (ctxTick(c) - s0) / (s1 - s0))) : 0;
    queue.push({ slot: i, recipe: q.recipeId[i]!, name: r ? itemName(w, r.output.item) : `#${q.recipeId[i]}`, count: q.count[i]!, state: st, progress, secondsLeft: running ? Math.max(0, (s1 - ctxTick(c)) / TICKS_PER_SECOND) : (r?.seconds ?? 0) });
  }
  const owed = owedOf(w, c.player).map((o) => ({ item: o.item, name: itemName(w, o.item), count: o.count, crafterName: nameOf(c, o.crafterId) }));
  return { station, stationName: STATION_NAMES[station] ?? `Station ${station}`, recipes, queue, owed, maxCount: MAX_CRAFT_COUNT, elsewhere };
}
export const JOB_STATE_LABEL = ["", "Queued", "Crafting", "Paused", "Done"] as const;
/** Task 33: the player's Recently Crafted recipes as RecipeViews, in recency order (craftable first within
 * the list, like the main list). Recipes whose defs are gone are skipped. */
export function recentCraftsView(c: MenuCtx): RecipeView[] {
  const w = c.world; const defs = gameplayDefs(w);
  const out: RecipeView[] = [];
  for (const id of recentCrafts(w, c.player)) {
    const r = defs.recipes.get(id); if (!r) continue;
    out.push({ id: r.id, key: r.key, name: itemName(w, r.output.item), seconds: r.seconds, station: r.station,
      output: { item: r.output.item, name: itemName(w, r.output.item), count: r.output.count },
      ingredients: withNames(w, r.ingredients, c.player), reason: craftQueueReason(w, c.player, r.id, 1) });
  }
  out.sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0));
  return out;
}
/** Task 33: the player's Recently Crafted pieces as BuildPieceViews, in recency order. */
export function recentBuildsView(c: MenuCtx): BuildPieceView[] {
  const order = new Map(recentBuilds(c.world, c.player).map((id, i) => [id, i]));
  return buildView(c).filter((p) => order.has(p.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
export const queueCraftIntent = (recipe: number, count = 1): MenuIntent => intent(QueueCraftCmd, { recipe, count: Math.max(1, Math.min(MAX_CRAFT_COUNT, count | 0)) });
export const cancelQueuedCraftIntent = (slot: number): MenuIntent => intent(CancelQueuedCraftCmd, { slot });

// ---- build ------------------------------------------------------------------------------------------
export interface BuildPieceView { id: number; key: string; tiers: { tier: number; key: string; cost: { item: number; name: string; count: number; have: number }[]; affordable: boolean; /** ADR-221: not yet learned in the skill tree */ locked: boolean; /** ADR-221: "Requires Stonework (Crafting & Building)" when locked */ requirement?: string }[]; variants: string[]; paintable: boolean; category: string }
export interface BuildSelection { piece: number; tier: number; variant: number; paint: number; /** ADR-211: false = the player rotated by hand (RB / R): a corner keeps that rotation instead of auto-fitting its junction */ autoRot?: boolean }
export function buildView(c: MenuCtx): BuildPieceView[] {
  const w = c.world; const defs = gameplayDefs(w);
  return [...defs.pieces.values()].map((p) => {
    const tierIds = p.tiered ? defs.tiers.map((t) => t.id) : [p.fixedTier];
    const tiers = tierIds.map((t) => { const cost = withNames(w, pieceCost(defs, p, t), c.player); const miss = pieceGates(defs, p, t).filter((k) => !hasSkillUnlock(w, c.player, k)).map(unlockRequirement).filter((r) => !!r);
      return { tier: t, key: defs.tiers.find((d) => d.id === t)?.key ?? String(t), cost, affordable: cost.every((x) => x.have >= x.count), locked: miss.length > 0,
        ...(miss.length ? { requirement: `Requires ${miss.map((r) => `${r!.name} (${r!.tree})`).join(" + ")}` } : {}) }; });
    const variants = Array.from({ length: Math.max(1, p.variants) }, (_, i) => p.variantNames[i] || `Variant ${i + 1}`);
    return { id: p.id, key: (p as { key?: string }).key ?? String(p.id), tiers, variants, paintable: p.paintable, category: p.category };
  });
}
/** Placement intent at a world point (the placement ghost / aim supplies x, y, level, rot). */
export const placeIntent = (s: BuildSelection, at: { x: number; y: number; level?: number; rot?: number }): MenuIntent =>
  intent(PlaceCmd, { piece: s.piece, x: at.x, y: at.y, level: at.level ?? 0, rot: at.rot ?? 0, tier: s.tier, variant: s.variant });
/** Tint an existing piece (PaintCmd; needs the net bridge, see DESIGN.md asks). */
export const paintIntent = (target: Entity, paint: number): MenuIntent => intent(PaintCmd, { target, paint }, ["target"]);

// ---- character / wardrobe ---------------------------------------------------------------------------
export interface WardrobeSlotView { slot: number; key: string; equipped: number; primary: number; secondary: number }
export interface WardrobeView { canEdit: boolean; created: boolean; /** current body / skin (0 if none): whole-look writes (skin) must keep them */ bodyType: number; skinTone: number; slots: WardrobeSlotView[]; unlocks: { tag: string; unlocked: boolean }[]; palettes: { skin: number; hair: number; clothing: number } }
export function wardrobeView(c: MenuCtx): WardrobeView {
  const w = c.world; const created = w.has(c.player, Wardrobe) ? hasCreatedLook(w, c.player) : false;
  const a = w.isRegistered(Appearance) ? getAppearance(w, c.player) : undefined;
  const have = unlocksOf(w, c.player);
  return { canEdit: canEditAppearance(w, c.player, !created), created, bodyType: a?.bodyType ?? 0, skinTone: a?.skinTone ?? 0,
    slots: WEARABLE_SLOTS.map((k, i) => ({ slot: i, key: k, equipped: a?.parts[i] ?? 0, primary: a?.primary[i] ?? 0, secondary: a?.secondary[i] ?? 0 })),
    unlocks: COSMETICS.unlockTags.map((t) => ({ tag: t, unlocked: have.has(t) })),
    palettes: { skin: c.catalog?.skinTones.length ?? 0, hair: c.catalog?.hairColors.length ?? 0, clothing: c.catalog?.clothingColors.length ?? 0 } };
}
export const equipCosmeticIntent = (slot: number, wearable: number, primary = 0, secondary = 0): MenuIntent => intent(EquipCosmeticCmd, { slot, wearable, primary, secondary });
export const setAppearanceIntent = (v: { bodyType: number; skinTone: number; parts: number[]; primary: number[]; secondary: number[] }): MenuIntent =>
  intent(SetAppearanceCmd, { bodyType: v.bodyType, skinTone: v.skinTone, parts: [...v.parts], primary: [...v.primary], secondary: [...v.secondary] });

// ---- Task 25: dyeing ------------------------------------------------------------------------------------
/** One dyeable appearance target (hair or a worn slot): its palette (0 hair / 1 clothing) and current colour. */
export interface DyeTargetView { kind: number; slot: number; key: string; equipped: number; primary: number; palette: number }
/** Dye panel view: brush/dye readiness, the palettes (for swatches), hair + worn targets, the held tool/weapon. */
export interface DyeView {
  brush: boolean; dye: number;
  hairPalette: { index: number; key: string; color: number }[]; clothingPalette: { index: number; key: string; color: number }[];
  hair: DyeTargetView | undefined; worn: DyeTargetView[];
  held: { slot: number; item: number; name: string; color: number } | undefined;
}
/** Pure read over the client replica: what this player can dye right now, and with what colours. */
export function dyeView(c: MenuCtx): DyeView {
  const w = c.world; const a = w.isRegistered(Appearance) ? getAppearance(w, c.player) : undefined;
  const dye = (() => { try { return countItem(w, c.player, gameplayDefs(w).itemId("dye")); } catch { return 0; } })();
  const hairPalette = c.catalog?.hairColors ?? []; const clothingPalette = c.catalog?.clothingColors ?? [];
  const hair: DyeTargetView | undefined = { kind: DyeKind.Hair, slot: slotIndex("hair"), key: "hair", equipped: a?.parts[slotIndex("hair")] ?? 0, primary: a?.primary[slotIndex("hair")] ?? 0, palette: DyePalette.Hair };
  const worn: DyeTargetView[] = WEARABLE_SLOTS.map((k, i) => ({ kind: DyeKind.Worn, slot: i, key: k, equipped: a?.parts[i] ?? 0, primary: a?.primary[i] ?? 0, palette: SLOT_PALETTE[k] === "hairColors" ? DyePalette.Hair : DyePalette.Clothing }))
    .filter((t) => t.key !== "hair" && t.equipped !== 0);
  let held: DyeView["held"];
  const eq = w.isRegistered(Equipment) ? w.get(c.player, Equipment) : undefined;
  const hs = eq?.mainHandSlot ?? 255;
  if (hs !== 255) {
    let item = 0; try { item = slotItem(w, c.player, hs).item; } catch { item = 0; }
    const d = item ? gameplayDefs(w).items.get(item) : undefined;
    if (item && d && (d.tool || d.weapon || d.ranged || d.thrown)) {
      const colors = w.has(c.player, SlotDye) ? w.getArray(c.player, SlotDye, "colors") : undefined;
      held = { slot: hs, item, name: d.name, color: colors?.[hs] ?? 0 };
    }
  }
  return { brush: hasBrushInHotbar(w, c.player), dye, hairPalette, clothingPalette, hair, worn, held };
}
export const dyeIntent = (kind: number, slot: number, palette: number, index: number): MenuIntent => intent(DyeCmd, { kind, slot, palette, index });

// ---- Task 23: live character sheet -----------------------------------------------------------------------
/** Base insulation (deg C) of an unclothed body: bare skin provides no insulation in this model. */
export const BASE_INSULATION_C = 0;
export interface CharacterSheetWorn { slot: string; name: string; insulation: number }
export interface CharacterSheetDisease { key: string; name: string; short: string; color: string; icon: string }
export interface CharacterSheetView {
  name: string; bodyTempC: number; health: number; maxHealth: number; hunger: number; thirst: number; stamina: number; maxStamina: number;
  level: number; xp: number; xpNext: number; diseases: CharacterSheetDisease[];
  insulationBase: number; insulationClothing: number; insulationWet: number; worn: CharacterSheetWorn[];
  ambientC: number; indoorC: number; sheltered: boolean; enclosed: boolean; season: number; seasonName: string;
  /** Task 31: wetness 0..1 (worn gear shares it), seconds until dry at the current drying rate (undefined when dry or still getting wetter in the rain), whether a fire is speeding the drying. */
  wetness: number; drySeconds: number | undefined; dryByFire: boolean;
  /** Task 31: seconds of care still owed to cure a cold/flu (undefined when healthy), and which care conditions are unmet. */
  careSecondsLeft: number | undefined; careMissing: string[];
}
/**
 * Task 23: the live character sheet (body temperature, vitals, diseases, experience, insulation, shelter).
 * Pure read over the client replica; the panel refreshes 4x/s while open, so the numbers track the player.
 */
export function characterSheetView(c: MenuCtx): CharacterSheetView | undefined {
  const w = c.world; const p = c.player;
  const sv = w.get(p, Survival); const hp = w.get(p, Health); if (!sv || !hp) return undefined;
  const prog = w.get(p, Progression);
  const t = w.get(p, Transform);
  // Task 24: the indoor temperature includes the room's smoothed fire heat (RoomHeat).
  const air = t ? shelteredAirTemp(w, t.x, t.y, t.z, undefined, w.getField(p, RoomHeat, "heat") ?? 0) : undefined;
  const ambient = t ? ambientTemperature(w, t.x, t.y) : ambientTemperature(w);
  const si = worldSeason(w);
  // Task 31: wetness + care timers for the sheet. Drying rate matches exposureSystem (dryPerSec, x3 by a fire);
  // in rain while exposed the player is still getting wetter, so there is no dry time to show.
  const wet = w.getField(p, Exposure, "wetness") ?? 0;
  const heat = t ? heatAt(w, t.x, t.y, t.z) : 0;
  const env = gameplayDefs(w).environment;
  const wdef = weatherDef(env, w.env(Weather).kind as WeatherKind);
  const gettingWetter = wdef.wetnessPerSec > 0 && (air?.exposure ?? 1) > 0;
  const dryRate = env.dryPerSec * (heat > 0 ? env.heatDryMul : 1);
  const care = careStatus(w, p);
  const insClothing = w.getField(p, Exposure, "insulation") ?? 0;
  return {
    name: nameOf(c, pidOf(w, p)),
    bodyTempC: sv.bodyTemp, health: hp.hp, maxHealth: hp.max, hunger: sv.hunger, thirst: sv.thirst, stamina: sv.stamina, maxStamina: sv.maxStamina,
    level: prog?.level ?? 1, xp: prog?.xp ?? 0, xpNext: xpToNext(prog?.level ?? 1),
    diseases: activeDiseases(w, p).map((d) => ({ key: d.key, ...diseasePresentation(w, p, d), color: d.color })),
    insulationBase: BASE_INSULATION_C,
    insulationClothing: insClothing,
    insulationWet: effectiveInsulation(insClothing, wet),
    worn: equipmentView(c).filter((s) => s.slot >= 0 && s.item !== 0).map((s) => ({
      slot: s.label, name: s.name, insulation: gameplayDefs(w).items.get(s.item)?.wear?.insulation ?? 0,
    })),
    ambientC: ambient, indoorC: air?.temp ?? ambient, sheltered: air?.sheltered ?? false, enclosed: air?.enclosed ?? false,
    season: si.index, seasonName: SEASON_NAMES[si.index] ?? "summer",
    wetness: wet,
    drySeconds: wet > 0 && !gettingWetter ? Math.ceil(wetDrySeconds(wet, dryRate) - 0.0001) : undefined,
    dryByFire: heat > 0,
    careSecondsLeft: care.sick ? Math.ceil(care.secondsLeft) : undefined,
    careMissing: care.sick ? care.missing : [],
  };
}

// ---- social helpers -------------------------------------------------------------------------------------
export interface PlayerRef { entity: Entity; playerId: number; name: string; distance: number }
/** Replicated players near me (invite / kick targets), nearest first. */
export function nearbyPlayers(c: MenuCtx, radius = 32): PlayerRef[] {
  const w = c.world; const me = w.get(c.player, Transform); const out: PlayerRef[] = [];
  for (const e of w.query([PlayerId, Transform])) {
    if (e === c.player) continue; const t = w.get(e, Transform)!; const d = me ? Math.hypot(t.x - me.x, t.y - me.y) : 0;
    if (d <= radius) out.push({ entity: e, playerId: pidOf(w, e), name: nameOf(c, pidOf(w, e)), distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance);
}
const groupMembers = (c: MenuCtx, field: "partyId" | "clanId", id: number): PlayerRef[] => {
  if (!id) return []; const w = c.world; const me = w.get(c.player, Transform); const out: PlayerRef[] = [];
  for (const e of w.query([PlayerId, Membership])) if (w.getField(e, Membership, field) === id) { const t = w.get(e, Transform); out.push({ entity: e, playerId: pidOf(w, e), name: nameOf(c, pidOf(w, e)), distance: me && t ? Math.hypot(t.x - me.x, t.y - me.y) : 0 }); }
  return out;
};
const pending = (w: World, e: Entity, def: typeof PartyInvitePending | typeof ClanInvitePending, now: number) => {
  const p = w.get(e, def as typeof PartyInvitePending) as unknown as { from: number; expiresTick: number; party?: number; clan?: number } | undefined;
  return p && p.expiresTick > now && (p.party ?? p.clan) ? p : undefined;
};

// ---- party ------------------------------------------------------------------------------------------
export interface PartyView { party: number; members: PlayerRef[]; maxSize: number; invite: { party: number; from: number; fromName: string; secondsLeft: number } | undefined; candidates: PlayerRef[]; /** my PartyRank role (0 = none) */ myRole: number; canInvite: boolean; /** kick allowed by rank (PARTY_RULES; the server still validates) */ canKick: (m: PlayerRef) => boolean }
export function partyView(c: MenuCtx): PartyView {
  const w = c.world; const party = w.getField(c.player, Membership, "partyId") ?? 0; const members = groupMembers(c, "partyId", party);
  const p = pending(w, c.player, PartyInvitePending, ctxTick(c));
  const rank = (e: Entity): number => w.getField(e, PartyRank, "role") ?? 0; const myRole = party ? rank(c.player) : 0;
  return { party, members, maxSize: PARTY_RULES.maxSize, myRole, canInvite: !party || myRole >= PARTY_RULES.minInviteRole,
    canKick: (m) => m.entity !== c.player && myRole >= PARTY_RULES.minKickRole && myRole > rank(m.entity),
    invite: p ? { party: p.party!, from: p.from, fromName: nameOf(c, p.from), secondsLeft: Math.ceil((p.expiresTick - ctxTick(c)) / TICKS_PER_SECOND) } : undefined,
    candidates: nearbyPlayers(c).filter((x) => !members.some((m) => m.entity === x.entity)) };
}
export const partyInviteIntent = (target: Entity): MenuIntent => intent(PartyInviteCmd, { target }, ["target"]);
export const partyAcceptIntent = (party: number): MenuIntent => intent(PartyAcceptCmd, { party });
export const partyDeclineIntent = (party: number): MenuIntent => intent(PartyDeclineCmd, { party });
export const partyLeaveIntent = (): MenuIntent => intent(PartyLeaveCmd, {});
export const partyKickIntent = (target: Entity): MenuIntent => intent(PartyKickCmd, { target }, ["target"]);

// ---- clan -------------------------------------------------------------------------------------------
export const CLAN_GOAL_NAMES = ["None", "Build base", "Stock stalls", "Defend", "Raid"] as const;
export const CLAN_ROLE_NAMES: Readonly<Record<number, string>> = { [GroupRole.Member]: "Member", [GroupRole.Officer]: "Officer", [GroupRole.Leader]: "Leader" };
export interface ClanView {
  clan: number; role: number; roleName: string; goal: number; goalName: string; goalX: number; goalY: number; contrib: number; members: (PlayerRef & { role: number })[];
  invite: { clan: number; from: number; fromName: string; secondsLeft: number } | undefined; candidates: PlayerRef[];
  /** Rank perm masks [member, officer] (authoritative when the world holds ClanState, else the defaults). */
  perms: { role: number; roleName: string; mask: number; perms: { perm: ClanPerm; on: boolean }[] }[]; goals: readonly string[];
}
export function clanView(c: MenuCtx): ClanView {
  const w = c.world; const st = w.get(c.player, ClanStatus); const clan = st?.clan || (w.getField(c.player, Membership, "clanId") ?? 0);
  const members = groupMembers(c, "clanId", clan).map((m) => ({ ...m, role: w.get(m.entity, ClanStatus)?.role ?? GroupRole.Member }));
  const known = clan ? clanState(w).clans.get(clan) : undefined; const [dm, dof] = defaultRankMasks();
  const masks: [number, number] = known ? [known.member, known.officer] : [dm, dof];
  const p = pending(w, c.player, ClanInvitePending, ctxTick(c)); const goal = st?.goal ?? 0;
  return { clan, role: st?.role ?? 0, roleName: CLAN_ROLE_NAMES[st?.role ?? 0] ?? "", goal, goalName: CLAN_GOAL_NAMES[goal] ?? "", goalX: st?.goalX ?? 0, goalY: st?.goalY ?? 0, contrib: st?.contrib ?? 0, members,
    invite: p ? { clan: p.clan!, from: p.from, fromName: nameOf(c, p.from), secondsLeft: Math.ceil((p.expiresTick - ctxTick(c)) / TICKS_PER_SECOND) } : undefined,
    candidates: nearbyPlayers(c).filter((x) => !members.some((m) => m.entity === x.entity)),
    perms: [GroupRole.Member, GroupRole.Officer].map((role, i) => ({ role, roleName: CLAN_ROLE_NAMES[role]!, mask: masks[i]!, perms: CLAN_PERMS.map((perm) => ({ perm, on: (masks[i]! & clanPermBit(perm)) !== 0 })) })),
    goals: CLAN_GOAL_NAMES.slice(0, CLAN_GOAL_COUNT) };
}
export const togglePermMask = (mask: number, perm: ClanPerm): number => (mask ^ clanPermBit(perm)) >>> 0;
export const clanCreateIntent = (): MenuIntent => intent(ClanCreateCmd, {});
export const clanInviteIntent = (target: Entity): MenuIntent => intent(ClanInviteCmd, { target }, ["target"]);
export const clanAcceptIntent = (clan: number): MenuIntent => intent(ClanAcceptCmd, { clan });
export const clanLeaveIntent = (): MenuIntent => intent(ClanLeaveCmd, {});
export const clanPromoteIntent = (target: Entity): MenuIntent => intent(ClanPromoteCmd, { target }, ["target"]);
export const clanDemoteIntent = (target: Entity): MenuIntent => intent(ClanDemoteCmd, { target }, ["target"]);
export const clanKickIntent = (target: Entity): MenuIntent => intent(ClanKickCmd, { target }, ["target"]);
export const clanSetRankPermsIntent = (role: number, mask: number): MenuIntent => intent(ClanSetRankPermsCmd, { role, mask });
export const clanSetGoalIntent = (goal: number, x = 0, y = 0): MenuIntent => intent(ClanSetGoalCmd, { goal, x, y });
export const clanDisbandIntent = (): MenuIntent => intent(ClanDisbandCmd, {});

// ---- trade stall ------------------------------------------------------------------------------------
export interface StallListingView { slot: number; enabled: boolean; stockItem: number; stockName: string; stock: number; qty: number; priceItem: number; priceName: string; priceCount: number; canAfford: boolean }
export interface StallView { stall: Entity; name: string; open: boolean; mine: boolean; revision: number; listings: StallListingView[]; till: { item: number; name: string; count: number }[] }
/** Nearest replicated stall within `radius` tiles (the one the panel shows). */
export function nearestStall(c: MenuCtx, radius = 6): Entity | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me) return undefined; let best: Entity | undefined; let bd = radius;
  for (const e of w.query([StallHeader, Transform])) { const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= bd) { bd = d; best = e; } }
  return best;
}
export function stallView(c: MenuCtx, stall: Entity): StallView | undefined {
  const w = c.world; const h = w.get(stall, StallHeader); if (!h) return undefined;
  const me = pidOf(w, c.player); const clan = w.getField(c.player, Membership, "clanId") ?? 0;
  const mine = (h.ownerKind === 1 && h.ownerId === me && me !== 0) || (h.ownerKind === 2 && h.ownerId === clan && clan !== 0);
  const listings = stallListings(w, stall).map((l) => ({ slot: l.slot, enabled: l.enabled, stockItem: l.stockItem, stockName: itemName(w, l.stockItem), stock: l.stock, qty: l.qty,
    priceItem: l.priceItem, priceName: itemName(w, l.priceItem), priceCount: l.priceCount, canAfford: l.priceItem ? countItem(w, c.player, l.priceItem) >= l.priceCount : false }));
  const t = tillOf(w, stall); const till = t !== undefined && w.has(t, Container) ? listSlots(w, t).filter((s) => s.item && s.count).map((s) => ({ item: s.item, name: itemName(w, s.item), count: s.count })) : [];
  return { stall, name: stallName(w, stall), open: h.open === 1, mine, revision: listingRevision(w, stall), listings, till };
}
export const buyFromStallIntent = (v: StallView, l: StallListingView, qty = 1): MenuIntent =>
  intent(BuyFromStallCmd, { stall: v.stall, listingSlot: l.slot, qty, expectedRevision: v.revision, expectedPriceItem: l.priceItem, expectedPriceCount: l.priceCount }, ["stall"]);
/** ADR-143: join the stall's viewers so Listings + stock replicate to this client (buyers saw an empty panel). */
export const openStallIntent = (stall: Entity): MenuIntent => intent(OpenStallCmd, { stall }, ["stall"]);
export const collectTillIntent = (stall: Entity): MenuIntent => intent(CollectTillCmd, { stall }, ["stall"]);
export const setListingIntent = (stall: Entity, slot: number, priceItem: number, priceCount: number, qty: number, enabled: boolean): MenuIntent =>
  intent(SetListingCmd, { stall, listingSlot: slot, priceItem, priceCount, qty, enabled: enabled ? 1 : 0 }, ["stall"]);
export const stockStallIntent = (stall: Entity, listingSlot: number, invSlot: number, count: number): MenuIntent => intent(StockStallCmd, { stall, listingSlot, invSlot, count }, ["stall"]);
export const unstockStallIntent = (stall: Entity, listingSlot: number, count: number): MenuIntent => intent(UnstockStallCmd, { stall, listingSlot, count }, ["stall"]);
export const setStallOpenIntent = (stall: Entity, open: boolean): MenuIntent => intent(SetStallOpenCmd, { stall, open: open ? 1 : 0 }, ["stall"]);
export function setStallNameIntent(stall: Entity, raw: string): MenuIntent {
  const bytes = Array.from(raw.replace(/[^\x20-\x7e]/g, "").slice(0, 24), (ch) => ch.charCodeAt(0));
  return intent(SetStallNameCmd, { stall, len: bytes.length, name: [...bytes, ...new Array<number>(24 - bytes.length).fill(0)] }, ["stall"]);
}

// ---- stall owner: stock + price ---------------------------------------------------------------------
/** Owner's "list an item" form state. */
export interface StallListDraft { listing: number; invSlot: number; count: number; priceItem: number; priceCount: number; qty: number }
/** Price currencies offered in the owner UI: coin first, then every distinct item in the owner's pack. */
export function priceItemChoices(c: MenuCtx): { item: number; name: string }[] {
  const d = gameplayDefs(c.world); let coin = 0; try { coin = d.itemId("coin"); } catch { /* no coin item */ }
  const out = coin ? [{ item: coin, name: itemName(c.world, coin) }] : [];
  for (const s of inventoryView(c)) if (!out.some((o) => o.item === s.item)) out.push({ item: s.item, name: s.name });
  return out;
}
/** Stock `count` from `invSlot` into the listing, then set its price/qty and enable it (two commands, in order). */
export function listItemIntents(stall: Entity, d: StallListDraft): MenuIntent[] {
  const out: MenuIntent[] = [];
  if (d.invSlot >= 0 && d.count > 0) out.push(stockStallIntent(stall, d.listing, d.invSlot, d.count));
  out.push(setListingIntent(stall, d.listing, d.priceItem, Math.max(1, d.priceCount), Math.max(1, d.qty), true));
  return out;
}

// ---- interact → panel -------------------------------------------------------------------------------
export const STALL_INTERACT_RANGE = 2.5;
export type InteractPanel =
  | { panel: "trade"; stall: Entity }
  | { panel: "wardrobe" }
  | { panel: "station"; station: Entity; kind: number }
  | { panel: "pet"; pet: Entity }
  | { panel: "worker"; worker: Entity }
  | { panel: "loot"; bag: Entity }
  | { panel: "lootLocked"; bag: Entity }
  | { panel: "storage"; piece: Entity }
  | { panel: "door"; piece: Entity };
/** What Interact / Use should do: the closest eligible target. Doors compete by distance with storage, loot,
 *  stations, wardrobes, pets and workers so standing at a house door opens the door instead of a chest through
 *  the wall (ADR-303). Use never opens inventory unless that closest target is a container, loot bag, death bag,
 *  or crafting station (etc.). */
export function interactPanel(c: MenuCtx): InteractPanel | undefined {
  const s = nearestStall(c, STALL_INTERACT_RANGE); if (s !== undefined) return { panel: "trade", stall: s };
  const door = nearestDoor(c);
  const wardrobe = nearestWardrobePiece(c);
  const st = nearestStation(c); const pet = nearestPet(c.world, c.player); const worker = nearestWorker(c.world, c.player);
  const bag = nearestLootBag(c);
  const storage = nearestStoragePiece(c);
  type Cand = { d: number; pri: number; pick: InteractPanel };
  const cands: Cand[] = [];
  if (door) cands.push({ d: door.d, pri: 0, pick: { panel: "door", piece: door.entity } });
  if (bag) {
    const locked = !canLootBagAt(c.world, c.player, bag.entity, ctxTick(c));
    cands.push({ d: bag.d, pri: 1, pick: locked ? { panel: "lootLocked", bag: bag.entity } : { panel: "loot", bag: bag.entity } });
  }
  if (storage) cands.push({ d: storage.d, pri: 2, pick: { panel: "storage", piece: storage.entity } });
  if (wardrobe) cands.push({ d: wardrobe.d, pri: 3, pick: { panel: "wardrobe" } });
  if (pet && !(nearestOpenable(c, pet.d) < pet.d)) cands.push({ d: pet.d, pri: 4, pick: { panel: "pet", pet: pet.entity } });
  if (worker && !(nearestOpenable(c, worker.d) < worker.d)) cands.push({ d: worker.d, pri: 5, pick: { panel: "worker", worker: worker.entity } });
  if (st) cands.push({ d: stationDistance(c, st.station), pri: 6, pick: { panel: "station", ...st } });
  if (!cands.length) return undefined;
  cands.sort((a, b) => a.d - b.d || a.pri - b.pri);
  return cands[0]!.pick;
}
/** ADR-303: nearest door or gate (`def.door`) within build reach — the same range `doorSystem` accepts. */
export function nearestDoor(c: MenuCtx, r = gameplayDefs(c.world).building.buildReach): { entity: Entity; d: number } | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me || !w.isRegistered(BuildPiece)) return undefined;
  const defs = gameplayDefs(w); let best: { entity: Entity; d: number } | undefined;
  for (const e of w.query([BuildPiece, Transform])) {
    if (w.has(e, Dead)) continue;
    const def = defs.pieces.get(w.getField(e, BuildPiece, "type") ?? 0); if (!def?.door) continue;
    const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y);
    if (d <= r && (!best || d < best.d)) best = { entity: e, d };
  }
  return best;
}
/** Nearest wardrobe / mirror piece within cosmetics.wardrobeRange, with its distance (so a closer door can win). */
export function nearestWardrobePiece(c: MenuCtx, r = COSMETICS.wardrobeRange): { entity: Entity; d: number } | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me || !w.isRegistered(BuildPiece)) return undefined;
  const defs = gameplayDefs(w); let best: { entity: Entity; d: number } | undefined;
  for (const e of w.query([BuildPiece, Transform])) {
    if (w.has(e, Dead)) continue;
    const def = defs.pieces.get(w.getField(e, BuildPiece, "type") ?? 0); if (!def?.features.wardrobe) continue;
    const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y);
    if (d <= r && (!best || d < best.d)) best = { entity: e, d };
  }
  return best;
}
/** Nearest plain base-storage piece within container reach (same definition AI storage uses: container piece
 *  that is not a stall, fire, station, turret or trough). The piece entity is the OpenContainer target — the
 *  server resolves it to its Storage attachment, so the client needs no replicated Container to offer it. */
export function nearestStoragePiece(c: MenuCtx, r = gameplayDefs(c.world).building.containerReach): { entity: Entity; d: number } | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me || !w.isRegistered(BuildPiece)) return undefined; let best: { entity: Entity; d: number } | undefined;
  for (const e of w.query([BuildPiece, Transform])) { if (w.has(e, Dead)) continue; const def = gameplayDefs(w).pieces.get(w.getField(e, BuildPiece, "type") ?? 0); if (!isBaseStoragePiece(def)) continue; const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= r && (!best || d < best.d)) best = { entity: e, d }; }
  return best;
}
/** ADR-160: nearest LootBag within container reach of the player (hand loot; no tool needed), with its distance. */
export function nearestLootBag(c: MenuCtx, r = gameplayDefs(c.world).building.containerReach): { entity: Entity; d: number } | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me || !w.isRegistered(LootBag)) return undefined; let best: { entity: Entity; d: number } | undefined;
  const carried = carriedBags(w); // ADR-244: a carried bag is not a loot target (Interact drops it)
  for (const e of w.query([LootBag, Transform])) { if (carried.has(e)) continue; const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= r && (!best || d < best.d)) best = { entity: e, d }; }
  return best;
}
/** Distance to the nearest non-pet, non-station LootBag / Container within `r` (Infinity if none). */
function nearestOpenable(c: MenuCtx, r: number): number {
  const w = c.world; const me = w.get(c.player, Transform); if (!me) return Infinity; let bd = Infinity;
  const carried = carriedBags(w);
  for (const q of [[LootBag, Transform], [Container, Transform]] as const) for (const e of w.query([...q], [Dead])) {
    if (carried.has(e)) continue;
    if (e === c.player || w.has(e, PlayerId) || w.has(e, Pet) || w.has(e, CraftingStation)) continue; const t = w.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= r && d < bd) bd = d;
  }
  return bd;
}
const stationDistance = (c: MenuCtx, e: Entity): number => { const a = c.world.get(c.player, Transform), b = c.world.get(e, Transform); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity; };
export const petOfferIntent = (target: Entity, item: number): MenuIntent => intent(PetOfferCmd, { target, item }, ["target"]);
export const petCommandIntent = (pet: Entity, cmd: number): MenuIntent => intent(PetCommandCmd, { pet, cmd }, ["pet"]);
/** Task 22: hire an AI human (the wanted item is taken by the server as the hire completes). */
export const hireWorkerIntent = (target: Entity): MenuIntent => intent(HireWorkerCmd, { target }, ["target"]);
/** Task 22: assign / change a hired worker's job. */
export const setWorkerJobIntent = (worker: Entity, job: number, d: WorkerJobDetails = {}): MenuIntent => intent(SetWorkerJobCmd, { worker, job, selections: [...(d.selections ?? [])], kind: d.kind ?? 0, target: d.kind === 2 && d.target ? d.target : WORKER_NO_TARGET, x: d.x ?? 0, y: d.y ?? 0 }, ["worker", "target"]);
/** Task 22: release a hired worker (owner and job cleared; the wanted item is kept for a future hire). */
export const dismissWorkerIntent = (worker: Entity): MenuIntent => intent(DismissWorkerCmd, { worker }, ["worker"]);
/** Task 14: guard a location (kind 1; target is ignored server-side, send the pet as the wire placeholder) or an entity (kind 2). */
export const petGuardIntent = (pet: Entity, kind: number, target: Entity, x: number, y: number): MenuIntent => intent(PetGuardCmd, { pet, kind, target, x, y }, ["pet", "target"]);
/** Task 15: buy an animal skill-tree node (node = index into the animal's tree). */
export const animalSkillIntent = (animal: Entity, node: number): MenuIntent => intent(AnimalSkillCmd, { animal, node }, ["animal"]);
/** Task 14: tell the server this client has finished loading (second loading screen dismissed). */
export const readyIntent = (): MenuIntent => intent(ReadyCmd, {});
export const petRenameIntent = (pet: Entity, name: string): MenuIntent => intent(PetRenameCmd, { pet, ...encodePetName(name) } as never, ["pet"]);
export const dropItemIntent = (item: number, count: number): MenuIntent => intent(DropItemCmd, { item, count });
/** ADR-136: nearest crafting station (placed piece or spawned) within its own range of the player; opens its crafting panel on Interact. */
export function nearestStation(c: MenuCtx): { station: Entity; kind: number } | undefined {
  const w = c.world; const me = w.get(c.player, Transform); if (!me) return undefined;
  let best: { station: Entity; kind: number } | undefined; let bd = Infinity;
  for (const e of w.query([CraftingStation, Transform])) {
    const cs = w.get(e, CraftingStation)!; if (!cs.kind || w.has(e, Dead)) continue; const t = w.get(e, Transform)!;
    const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= cs.range && d < bd) { bd = d; best = { station: e, kind: cs.kind }; }
  }
  return best;
}

// ---- social directory (owner-scoped net events: gameplay.clanRoster / clanRosterMember / onlinePlayer) ----------
export const clanDeclineIntent = (clan: number): MenuIntent => intent(ClanDeclineCmd, { clan });
export const ROLE_NAMES = ["", "Member", "Officer", "Leader"] as const;
/** Client-side store fed by client.onEvent(ClanRoster | ClanRosterMember | OnlinePlayer). Ids are account PlayerIds. */
export class SocialDirectory {
  clan = 0; memberMask = 0; officerMask = 0; size = 0;
  readonly roster = new Map<number, { role: number; online: boolean }>();
  readonly online = new Set<number>();
  /** Bumped on every change (cheap "did it change" for panels). */
  version = 0;
  reset(): void { this.clan = this.memberMask = this.officerMask = this.size = 0; this.roster.clear(); this.online.clear(); this.version++; }
  onRoster(e: { clan: number; memberMask: number; officerMask: number; size: number }): void {
    if (e.clan !== this.clan || !e.clan) this.roster.clear();
    this.clan = e.clan; this.memberMask = e.memberMask; this.officerMask = e.officerMask; this.size = e.size; this.version++;
  }
  /** role 1 Member, 2 Officer, 3 Leader; 0 = removed. */
  onMember(e: { clan: number; player: number; role: number; online: number }): void {
    if (!e.clan || e.clan !== this.clan) return;
    if (!e.role) this.roster.delete(e.player); else this.roster.set(e.player, { role: e.role, online: e.online === 1 }); this.version++;
  }
  onOnline(e: { player: number; online: number }): void { if (e.online) this.online.add(e.player); else this.online.delete(e.player); this.version++; }
}
const entityOfPlayer = (w: World, playerId: number): Entity | undefined => { for (const e of w.query([PlayerId])) if (pidOf(w, e) === playerId) return e; return undefined; };
export interface RosterRow { playerId: number; name: string; role: number; roleName: string; online: boolean; entity: Entity | undefined }
/** Clan members from the replicated roster (works beyond AOI; entity only when that player is replicated). */
export function clanRosterRows(c: MenuCtx, dir: SocialDirectory | undefined, clan: number): RosterRow[] | undefined {
  if (!dir || !clan || dir.clan !== clan || !dir.roster.size) return undefined;
  return [...dir.roster].map(([pid, r]) => ({ playerId: pid, name: nameOf(c, pid), role: r.role, roleName: ROLE_NAMES[r.role] ?? "Member", online: r.online, entity: entityOfPlayer(c.world, pid) }))
    .sort((a, b) => b.role - a.role || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
export interface InviteTarget { playerId: number; name: string; entity: Entity | undefined; distance: number | undefined }
/** Invite / whisper candidates: online directory (plus nearby replicated players), minus me and `exclude`; replicated ones first by distance. */
export function onlineTargets(c: MenuCtx, dir: SocialDirectory | undefined, exclude: ReadonlySet<number> = new Set()): InviteTarget[] {
  const me = pidOf(c.world, c.player); const out = new Map<number, InviteTarget>();
  for (const p of nearbyPlayers(c)) if (!exclude.has(p.playerId)) out.set(p.playerId, { playerId: p.playerId, name: p.name, entity: p.entity, distance: p.distance });
  for (const pid of dir?.online ?? []) if (pid !== me && !exclude.has(pid) && !out.has(pid)) out.set(pid, { playerId: pid, name: nameOf(c, pid), entity: entityOfPlayer(c.world, pid), distance: undefined });
  return [...out.values()].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.name.localeCompare(b.name));
}
/** Nearest paintable build piece within build reach (Build panel "Paint" target). Matches the server rule in
 * building/actions.ts: flagged paintable OR tiered (tiered pieces were always paintable server-side). */
export function paintTarget(c: MenuCtx): Entity | undefined {
  const w = c.world; const d = gameplayDefs(w); const me = w.get(c.player, Transform); if (!me) return undefined;
  let best: Entity | undefined; let bd = d.building.buildReach;
  for (const e of w.query([BuildPiece, Transform])) {
    const def = d.pieces.get(w.get(e, BuildPiece)!.type); if (!def?.paintable && !def?.tiered) continue;
    const t = w.get(e, Transform)!; const dist = Math.hypot(t.x - me.x, t.y - me.y); if (dist <= bd) { bd = dist; best = e; }
  }
  return best;
}

/** ADR-145: toast text for a replicated pet event (PetEventEvt: pet, result, value). */
export function petEventText(world: World, pet: Entity | undefined, result: number, value: number): string {
  const name = pet !== undefined && world.isAlive(pet) && world.has(pet, Pet) ? petName(world, pet) : "Your pet";
  switch (result) {
    case PetResult.Tamed: return `Tamed! ${name} is your pet now.`;
    case PetResult.Refused: return "It sniffs and refuses that.";
    case PetResult.Shied: return "It took the treat but shied away — try again.";
    case PetResult.Fed: return `${name} ate.`;
    case PetResult.NotHungry: return `${name} isn't hungry.`;
    case PetResult.LevelUp: return `${name} reached level ${value}!`;
    case PetResult.Renamed: return "Pet renamed.";
    case PetResult.Command: return value === 1 ? `${name} stays and guards.` : `${name} follows you.`;
    default: return "";
  }
}
