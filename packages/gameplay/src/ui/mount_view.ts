/**
 * ADR-319 / ADR-320 mount panel view-model + intents (pure reads of the replicated world; the client renders it as
 * shell buttons, so touch, D-pad / stick and keyboard all reach every action). The saddlebag opens through the normal
 * container panel (OpenContainer), never through Use (ADR-303).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { Animal, Dead, Health, Hitch, Mount, MountHarness, MountTaming, Pet, Riding, Tamed, Vehicle } from "../components.js";
import { gameplayDefs } from "../config.js";
import { countItem, listSlots, readSlots } from "../inventory.js";
import { foodPref, harnessItemOf, isHarnessed, mayUseMount, mountOfRider, mountSpecies, MOUNT_TUNING, saddleOfItemKey, type FoodPref } from "../mount_defs.js";
import { MountDismountCmd, MountFeedCmd, MountHarnessCmd, MountRenameCmd, MountRepairCmd, MountRideCmd, MountSaddleCmd, MountUnharnessCmd, MountUnsaddleCmd } from "../mount_commands.js";
import { hasSkillUnlock, unlockRequirement } from "../skills/tree.js";
import { harnessInfo, isRiding, mountName, MOUNT_TAME_TOKEN, saddleInfo, saddleRepairCost, sanitizeMountName, speciesOf } from "../mounts.js";
import { leadInfo, type LeadInfo } from "../rope.js";
import { netIdEntity } from "../vehicle_net.js";
import { isDrawnDef, VehicleHitchCmd, VehicleUnhitchCmd, vehicleDefOf, VEHICLE_TUNING } from "../vehicles.js";
import type { MenuIntent } from "./menus.js";

export const mountRideIntent = (m: Entity): MenuIntent => ({ cmd: MountRideCmd, args: { target: m }, entities: ["target"] });
export const mountDismountIntent = (): MenuIntent => ({ cmd: MountDismountCmd, args: {} });
export const mountFeedIntent = (m: Entity, item: number): MenuIntent => ({ cmd: MountFeedCmd, args: { target: m, item }, entities: ["target"] });
export const mountSaddleIntent = (m: Entity, slot: number): MenuIntent => ({ cmd: MountSaddleCmd, args: { target: m, slot }, entities: ["target"] });
export const mountUnsaddleIntent = (m: Entity): MenuIntent => ({ cmd: MountUnsaddleCmd, args: { target: m }, entities: ["target"] });
export const mountRepairIntent = (m: Entity): MenuIntent => ({ cmd: MountRepairCmd, args: { target: m }, entities: ["target"] });
/** ADR-359: harness on / off this mount (the harness in inventory `slot` / the one it wears). */
export const mountHarnessIntent = (m: Entity, slot: number): MenuIntent => ({ cmd: MountHarnessCmd, args: { target: m, slot }, entities: ["target"] });
export const mountUnharnessIntent = (m: Entity): MenuIntent => ({ cmd: MountUnharnessCmd, args: { target: m }, entities: ["target"] });
/** ADR-359: hook this (harnessed) mount up to a drawn vehicle, or detach it (the vehicle stays parked where it is). */
export const mountHitchIntent = (mount: Entity, vehicle: Entity): MenuIntent => ({ cmd: VehicleHitchCmd, args: { target: vehicle, tow: mount }, entities: ["target", "tow"] });
export const mountUnhitchIntent = (vehicle: Entity): MenuIntent => ({ cmd: VehicleUnhitchCmd, args: { target: vehicle }, entities: ["target"] });
export function mountRenameIntent(m: Entity, name: string): MenuIntent {
  const s = sanitizeMountName(name); const text = Array.from({ length: 16 }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));
  return { cmd: MountRenameCmd, args: { target: m, len: s.length, text }, entities: ["target"] };
}

const reach = MOUNT_TUNING.interactRange + 0.5;
/** Nearest rideable animal around `player`: an own / permitted Mount, or a wild animal of a rideable species. */
export function nearestRideable(world: World, player: Entity, range = reach, onlyMounts = false): Entity | undefined {
  if (!world.isRegistered(Mount)) return undefined; const me = world.get(player, Transform); if (!me) return undefined;
  let best: Entity | undefined, bd = Infinity;
  for (const e of world.query([Animal, Transform], [Dead])) {
    if (world.has(e, Pet) || world.has(e, Tamed)) continue;
    const own = world.has(e, Mount); if (onlyMounts && !own) continue; if (own ? !mayUseMount(world, player, e) : !speciesOf(world, e)) continue;
    if (own && (world.getField(e, Mount, "riderNetId") ?? 0) !== 0) continue;
    const t = world.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y); if (d <= range && d < bd) { bd = d; best = e; }
  }
  return best;
}
export interface MountFoodView { item: number; key: string; name: string; count: number; pref: FoodPref }
export interface MountSaddleChoice { slot: number; item: number; name: string; tier: number; slots: number; defense: number }
export interface MountHarnessChoice { slot: number; item: number; name: string }
export interface MountDrawnChoice { id: number; name: string; cls: string }
export interface MountView {
  entity: Entity; species: number; speciesName: string; name: string; wild: boolean; mayUse: boolean; riding: boolean; taken: boolean;
  hp: number; maxHp: number; tame: number; canTame: boolean; tameNeeds?: string; walk: number; gallop: number;
  saddle?: { name: string; tier: number; dur: number; max: number; slots: number; defense: number; used: number };
  /** ADR-359: the harness it wears (undefined when bare), harnesses in the player's pack, the drawn vehicle it tows
   *  (undefined when free), and parked unhitched drawn vehicles near the mount that it could hook up to. */
  harness?: { name: string; item: number };
  harnesses: MountHarnessChoice[];
  towing?: MountDrawnChoice;
  drawn: MountDrawnChoice[];
  foods: MountFoodView[]; saddles: MountSaddleChoice[]; repair: { item: number; name: string; count: number; have: number }[];
  /** ADR-351: rope lead state for this mount. */
  lead: LeadInfo;
}
/** Display name for a vehicle def id ("wagon_medium" -> "Wagon Medium"). Defs carry no name field. */
export const vehicleLabel = (id: string): string => id.split("_").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
/** Panel model for `m` as seen by `player` (undefined when it is not a rideable animal). */
export function mountView(world: World, player: Entity, m: Entity): MountView | undefined {
  if (!world.isAlive(m) || !world.has(m, Animal)) return undefined; const sp = speciesOf(world, m); const spec = mountSpecies(sp); if (!spec) return undefined;
  const defs = gameplayDefs(world); const wild = !world.has(m, Mount); const h = world.get(m, Health);
  const ridingThis = isRiding(world, player) && mountOfRider(world, player) === m;
  const foods: MountFoodView[] = [];
  for (const [key, pref] of Object.entries(spec.foods)) {
    const d = [...defs.items.values()].find((x) => x.key === key); if (!d) continue; const count = countItem(world, player, d.id);
    if (count > 0) foods.push({ item: d.id, key, name: d.name, count, pref });
  }
  const rank = { love: 0, like: 1, ok: 2 } as const; foods.sort((a, b) => rank[a.pref] - rank[b.pref] || a.name.localeCompare(b.name));
  const saddles: MountSaddleChoice[] = []; const v = readSlots(world, player);
  for (let i = 0; i < v.slotCount; i++) { const it = v.item(i); if (!it || !v.count(i)) continue; const d = defs.items.get(it); const sd = saddleOfItemKey(d?.key); if (sd && d) saddles.push({ slot: i, item: it, name: d.name, tier: sd.tier, slots: sd.slots, defense: sd.defense }); }
  const si = wild ? undefined : saddleInfo(world, m);
  const repair = si && si.dur < si.max ? saddleRepairCost(world, si.item).map((c) => ({ item: c.item, name: defs.items.get(c.item)?.name ?? "?", count: c.count, have: countItem(world, player, c.item) })) : [];
  // ADR-359: harness state, the drawn vehicle it tows, and hook-up candidates near the mount.
  const harness = wild ? undefined : harnessInfo(world, m);
  const harnesses: MountHarnessChoice[] = [];
  for (let i = 0; i < v.slotCount; i++) { const it = v.item(i); if (!it || !v.count(i)) continue; const d = defs.items.get(it); if (d?.family === "harness") harnesses.push({ slot: i, item: it, name: d.name }); }
  let towing: MountDrawnChoice | undefined; const drawn: MountDrawnChoice[] = [];
  if (!wild && world.isRegistered(Hitch)) {
    const towId = world.getField(m, Hitch, "towNetId") ?? 0;
    if (towId) { const tv = netIdEntity(world, towId); const td = tv !== undefined ? vehicleDefOf(world, tv) : undefined; if (tv !== undefined && td) towing = { id: tv, name: vehicleLabel(td.id), cls: td.class }; }
    else {
      const mt = world.get(m, Transform);
      if (mt) for (const e of world.query([Vehicle, Transform])) {
        if (!world.has(e, Hitch)) continue;
        const d = vehicleDefOf(world, e); if (!d || !isDrawnDef(d)) continue;
        if (world.getField(e, Hitch, "parentNetId")) continue; // already hitched
        if (Math.abs(world.getField(e, Vehicle, "speed") ?? 0) >= VEHICLE_TUNING.parkedSpeed) continue; // parked only
        const t = world.get(e, Transform)!; if (Math.hypot(t.x - mt.x, t.y - mt.y) > 4) continue;
        drawn.push({ id: e, name: vehicleLabel(d.id), cls: d.class });
      }
      drawn.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  const canTame = hasSkillUnlock(world, player, MOUNT_TAME_TOKEN); const req = canTame ? undefined : unlockRequirement(MOUNT_TAME_TOKEN);
  return {
    entity: m, species: sp, speciesName: spec.name, name: wild ? spec.name : mountName(world, m), wild, mayUse: !wild && mayUseMount(world, player, m),
    riding: ridingThis, taken: !wild && (world.getField(m, Mount, "riderNetId") ?? 0) !== 0 && !ridingThis,
    hp: h?.hp ?? 0, maxHp: h?.max ?? spec.hp, tame: wild && world.isRegistered(MountTaming) ? world.getField(m, MountTaming, "progress") ?? 0 : 0,
    canTame, ...(req ? { tameNeeds: `${req.name} (${req.tree})` } : {}), walk: spec.walk, gallop: spec.gallop,
    ...(si ? { saddle: { name: defs.items.get(si.item)?.name ?? "Saddle", tier: si.tier, dur: si.dur, max: si.max, slots: si.slots, defense: si.defense, used: listSlots(world, m).length } } : {}),
    ...(harness ? { harness } : {}), harnesses, ...(towing ? { towing } : {}), drawn,
    foods, saddles, repair,
    lead: leadInfo(world, player, m),
  };
}
/** HUD chip text while riding (name · gait · HP · towing). */
export function ridingHud(world: World, player: Entity): string | undefined {
  if (!isRiding(world, player)) return undefined; const m = mountOfRider(world, player); const spec = mountSpecies(world.getField(player, Riding, "species") ?? 0);
  const speed = world.getField(player, Riding, "speed") ?? 0; const gait = speed < 0.05 ? "Standing" : spec && speed > spec.walk + 0.3 ? "Gallop" : "Walk";
  const h = m !== undefined ? world.get(m, Health) : undefined; const name = m !== undefined && world.has(m, Mount) ? mountName(world, m) : spec?.name ?? "Mount";
  let tow = "";
  if (m !== undefined && world.isRegistered(Hitch)) {
    const towId = world.getField(m, Hitch, "towNetId") ?? 0;
    if (towId) { const tv = netIdEntity(world, towId); const d = tv !== undefined ? vehicleDefOf(world, tv) : undefined; if (d) tow = ` · towing ${vehicleLabel(d.id)}`; }
  }
  return `${name} · ${gait}${h ? ` · ${Math.round((h.hp / Math.max(1, h.max)) * 100)}%` : ""}${tow}`;
}

/** Toast text for a MountEvent (gameplay.mountEvent net event): result = MountResult, value per result. */
export function mountEventText(result: number, value: number, name = "Your mount"): string | undefined {
  switch (result) {
    case 1: return `Taming… ${value}%`;
    case 2: return "Tamed! It's yours now — Use to ride, U / LB+X for its menu.";
    case 3: return `It shied away (${value}%). Try a food it loves.`;
    case 4: return "Ouch! It kicked you.";
    case 5: return `${name} ate.`;
    case 8: return "Saddle on.";
    case 9: return "Saddle off.";
    case 10: return "Saddle repaired.";
    case 11: return "Get off your mount to do that.";
    case 12: return "Your mount died. Its saddle and bags dropped.";
    case 13: return "Renamed.";
    case 15: return "Harness on — it can pull a wagon, cart, carriage or chariot now.";
    case 16: return "Harness off.";
    default: return undefined;
  }
}
const MOUNT_REJECT_TEXT: Record<string, string> = {
  needs_skill: "Learn Horsemanship (Husbandry) to tame and ride.", not_food: "It won't eat that.", not_tameable: "That animal can't be ridden.",
  not_owner: "That isn't your mount.", mount_busy: "Someone is riding it.", already_riding: "You're already riding.", no_saddle: "No saddle on it.",
  bag_not_empty: "Empty the saddlebag first.", bag_too_full: "Empty the saddlebag's extra slots first.", not_saddle: "That isn't a saddle.", no_room: "No room in your pack.",
  full_health: "It isn't hungry.", not_damaged: "The saddle isn't damaged.", skill_locked: "Learn this saddle's Saddlery node first.", cannot_afford: "Missing repair materials.",
  too_far: "Get closer.", busy: "Put down what you're doing first.", blocked: "You can only get on at ground level.", riding: "Get off your mount first.", not_riding: "You're not riding.",
  no_harness: "It needs a harness to pull that.", not_harness: "That isn't a harness.", hitched: "Detach the wagon first.",
};
/** Friendly text for a rejected mount command (undefined for other commands). Also covers the drawn-vehicle hitch:
 *  a harnessed mount is the hook-up, so a `gameplay.vehicleHitch` refused as `no_harness` explains itself here. */
export function mountRejectText(commandName: string, reason: string): string | undefined {
  if (commandName === "gameplay.vehicleHitch" && reason === "no_harness") return "It needs a harness to pull that. Put a harness on the mount first.";
  if (commandName === "gameplay.vehicleHitch" && reason === "incompatible") return "That mount can't pull that vehicle.";
  if (!commandName.startsWith("gameplay.mount")) return undefined; return MOUNT_REJECT_TEXT[reason] ?? reason.replace(/_/g, " ");
}
