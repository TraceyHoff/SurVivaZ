/**
 * Replication scope/class per gameplay component, agreed with Netcode. Net applies scopes with
 * NetServer.setScope(def, scope) ("viewers" -> containerViewersScope). networked:false components are
 * listed as "server"/"local" for completeness and never go on the wire.
 */
import { entityIndex, type ComponentDef, type Entity, type World } from "@engine/core";
import * as C from "./components.js";
import { markerScope } from "./map_markers.js";

export type Scope = "all" | "owner" | "viewers" | "markers" | "server" | "local";
/**
 * "static" = net static class (only BuildPiece declares it; every replicated component on a piece entity -
 * Transform, Tribe, PrivilegeZone, CraftingStation - rides the static channel and ignores scopes).
 * "lowRate" = dynamic, but gameplay only writes it at rateHz (Fuel/HeatSource flips are rare anyway).
 */
export type RepClass = "dynamic" | "static" | "lowRate";
export interface Replication { readonly def: ComponentDef; readonly scope: Scope; readonly class: RepClass; readonly rateHz?: number }

const r = (def: ComponentDef, scope: Scope, cls: RepClass = "dynamic", rateHz?: number): Replication => ({ def, scope, class: cls, ...(rateHz !== undefined && { rateHz }) });
export const GAMEPLAY_REPLICATION: readonly Replication[] = [
  r(C.Emitter, "all"), r(C.Buffs, "owner"),
  r(C.Health, "all"), r(C.ResourceNode, "all"), r(C.Survival, "owner"), r(C.VitalsState, "server"),
  r(C.Exposure, "owner"), r(C.Dead, "all"), r(C.Inventory, "owner"), r(C.Equipment, "all"), r(C.Gatherer, "owner"),
  r(C.CraftingStation, "all"), r(C.Crafter, "owner"), r(C.PlayerIntent, "local"),
  r(C.BuildPiece, "all", "static"), r(C.PieceSlot, "local"), r(C.PieceStability, "server"), r(C.Tribe, "all"),
  r(C.PrivilegeZone, "all"), r(C.DoorState, "all"), r(C.Fuel, "all", "lowRate", 2), r(C.Container, "viewers"),
  r(C.ContainerViewers, "server"), r(C.Viewing, "server"), r(C.BuildGhost, "local"),
  r(C.Attacker, "owner"), r(C.Zombie, "all"), r(C.ZombieBrain, "server"), r(C.AnimState, "all"), r(C.NoiseLevel, "server"), r(C.Latency, "server"), r(C.PieceLink, "all"), r(C.Wetness, "all"), r(C.BodyTemp, "all"), r(C.ChunkSurface, "all", "lowRate", 1),
  r(C.GroupSummary, "all"), r(C.CombatTag, "owner"), r(C.LootBag, "all"),
  r(C.Animal, "all"), r(C.Worn, "all"), r(C.WeaponState, "owner"), r(C.LiveExplosive, "all"), r(C.StallHeader, "all"), r(C.Listings, "viewers"), r(C.StallLedger, "viewers"),
  // vehicles (ADR-096/097): pose incl. trailer heading, seats, links and engine/headlight flags go to everyone in AOI
  r(C.Vehicle, "all"), r(C.VehicleSeats, "all"), r(C.Driver, "all"), r(C.Hitch, "all"), r(C.VehicleState, "all"),
  r(C.HitReact, "all"), r(C.NodeRegrow, "all"), // ADR-134
  r(C.Pet, "all"), r(C.TroughOwner, "all"), r(C.PetBrain, "server"), // ADR-145
  r(C.LootSummary, "all"), // ADR-161
  r(C.Stance, "all"), // ADR-244
  r(C.MapMarker, "markers"), // world-map markers: visibility-filtered (private = owner only, party / clan = live members)
  r(C.Diseases, "all"), // Task 13: HUD chips + transmission + move penalty read it on every peer
  r(C.Worker, "all"), r(C.WorkerOrder, "all"), r(C.WorkerTarget, "all"), // ADR-259
  r(C.AutoSprint, "owner"), r(C.HotbarSelection, "owner"), // ADR-289: shared movement prediction state
  r(C.InShaft, "all"), // ADR-299: lid vs shaft so every peer draws the traveler at the right height
  r(C.AnimalSkills, "all"), // Task 15: animal skill panels read points/nodes on every peer
];
export function replicationOf(def: ComponentDef): Replication | undefined { return GAMEPLAY_REPLICATION.find((x) => x.def === def); }

/** "viewers" scope hook for Container: true if clientId currently has the container open. */
export function containerViewersScope(world: World, entity: Entity, clientId: number): boolean {
  const st = world.store(C.ContainerViewers); const s = st.slot(entityIndex(entity)); if (s < 0) return false;
  const n = st.data.count[s]!; const a = st.data.clients;
  for (let i = 0; i < n; i++) if (a[s * C.MAX_VIEWERS + i] === clientId) return true;
  return false;
}

/** Structural subset of @engine/net NetServer that installGameplay drives (gameplay does not depend on net). */
export interface NetReplicationHooks {
  setReplicationClass(def: ComponentDef, cls: "dynamic" | "static"): unknown;
  setScope(def: ComponentDef, scope: "all" | "owner" | "none" | ((world: World, entity: Entity, clientId: number) => boolean)): unknown;
}
/** Applies GAMEPLAY_REPLICATION to a net server: BuildPiece -> static class; owner/viewers scopes. Call before clients join. */
export function applyReplication(net: NetReplicationHooks): void {
  for (const r of GAMEPLAY_REPLICATION) {
    if (!r.def.networked) continue;
    if (r.class === "static") net.setReplicationClass(r.def, "static");
    if (r.scope === "owner") net.setScope(r.def, "owner");
    else if (r.scope === "viewers") net.setScope(r.def, containerViewersScope);
    else if (r.scope === "markers") net.setScope(r.def, markerScope);
  }
}
