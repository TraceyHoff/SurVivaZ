/**
 * ADR-212: rehydrate derived components on build pieces that come back from storage.
 *
 * The server saves pieces through core persistence (persistent components only: Transform, BuildPiece, Tribe, PieceLink,
 * Container, Fuel, DoorState, ...). Components placePiece derives from the piece def are not persistent, so after a
 * restart / "log back in" a loaded piece had no PieceStability (every wall/floor on a reloaded foundation failed
 * server validation with NoSupport while the client preview, which assumes ground stability, showed green) and no
 * CraftingStation (workbenches / forges could not be used, no Interact prompt). structureIndexSystem queues every piece
 * it indexes without PieceStability and every attachment it links; on the authority this pass restores them.
 * Idempotent; clients skip it (CraftingStation / Emitter replicate from the server).
 */
import { type Entity, type World } from "@engine/core";
import { Falloff } from "@engine/world";
import { AttachKind, BuildPiece, Container, ContainerViewers, CraftingStation, Emitter, Fuel, PieceLink, PieceStability, PrivilegeZone, StallHeader, StallSign } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { StationKind } from "../defs.js";
import { emitterSpecs, EmitterKind } from "../realism.js";
import { setEmittersLit } from "../systems/fuel.js";
import { recomputeRegion } from "./integrity.js";
import { pieceOf } from "./links.js";
import { LoadedQueueRes, structures } from "./structure.js";
import { Transform } from "@engine/core";
import { POWER, powerSpecFor } from "../power/data.js";
import { addPowerState } from "../power/state.js";
import { invalidateZoneGrid, zonesNear, zonesShareOwner } from "./zones.js";

export function rehydrateLoadedStructures(world: World): void {
  const q = world.getResource(LoadedQueueRes); if (!q || (!q.pieces.length && !q.atts.length)) return;
  const pieces = q.pieces.splice(0), atts = q.atts.splice(0);
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const idx = structures(world); const loaded = new Set<Entity>(); const legacy: [Entity, number][] = [];
  for (const e of pieces) {
    if (!world.isAlive(e) || world.has(e, PieceStability)) continue;
    const def = defs.pieces.get(world.getField(e, BuildPiece, "type") ?? 0); if (!def) continue;
    if (def.privilegeRadius > 0 && (world.getField(e, PrivilegeZone, "radius") ?? def.privilegeRadius) < def.privilegeRadius) legacy.push([e, def.privilegeRadius]);
    world.add(e, PieceStability, { value: 0, placedTick: world.tick });
    if (def.station !== StationKind.None && !def.fired && !world.has(e, CraftingStation)) world.add(e, CraftingStation, { kind: def.station });
    const power = powerSpecFor(def, world.getField(e, BuildPiece, "tier") ?? 0, defs.tiers); if (power) addPowerState(world, e, power); // ADR-590 (grid writes the rest)
    loaded.add(e);
  }
  if (legacy.length) growLegacyClaims(world, legacy);
  if (loaded.size) { recomputeRegion(world, idx, loaded); for (const e of loaded) idx.dirty.add(e); } // dirty: raise anything resting on them (propagateUp)
  for (const a of atts) {
    if (!world.isAlive(a)) continue; const p = pieceOf(world, a); if (p === undefined) continue;
    const def = defs.pieces.get(world.getField(p, BuildPiece, "type") ?? 0); if (!def) continue;
    const kind = world.getField(a, PieceLink, "kind") ?? 0; const specs = emitterSpecs(def, defs.ai.smell.fire);
    if (world.has(a, Container) && !world.has(a, ContainerViewers)) world.add(a, ContainerViewers);
    if (kind === AttachKind.Fire) {
      const heat = specs.find((s) => s.kind === 1);
      if (heat && !world.has(a, Emitter)) world.add(a, Emitter, { kind: heat.kind, radius: heat.radius, strength: 0, falloff: Falloff.Linear });
      if (def.station !== StationKind.None && !world.has(a, CraftingStation)) world.add(a, CraftingStation, { kind: def.station });
    } else if (kind === AttachKind.Light) {
      const light = specs.find((s) => s.kind === 2);
      if (light && !world.has(a, Emitter)) world.add(a, Emitter, { kind: light.kind, radius: light.radius, strength: def.fired || def.key in POWER.pieces ? 0 : light.strength, falloff: Falloff.Quadratic });
      else if (light && world.getField(a, Emitter, "radius") !== light.radius) world.setField(a, Emitter, "radius", light.radius); // ADR-216: saves keep the old radius
    } else if (kind === AttachKind.Smell) {
      // ADR-486: a loaded Smell sibling keeps its Emitter (re-added when the save predates the
      // emitter, radius fixed like the light above); a sibling missing entirely is grown by
      // setEmittersLit when the fire is next lit (see systems/fuel.ts).
      const smell = specs.find((s) => s.kind === EmitterKind.Smell);
      if (smell && !world.has(a, Emitter)) world.add(a, Emitter, { kind: smell.kind, radius: smell.radius, strength: 0, falloff: Falloff.Linear });
      else if (smell && world.getField(a, Emitter, "radius") !== smell.radius) world.setField(a, Emitter, "radius", smell.radius);
    } else if (kind === AttachKind.Heat) {
      // ADR-590: powered heat sibling (heater / powered tier) — starts cold; the grid sets it from Power.active
      const ps = powerSpecFor(def, world.getField(p, BuildPiece, "tier") ?? 0, defs.tiers);
      if (ps?.heat && !world.has(a, Emitter)) world.add(a, Emitter, { kind: EmitterKind.Heat, radius: ps.heatRadius ?? 3, strength: 0, falloff: Falloff.Linear });
    } else if (kind === AttachKind.Storage && world.has(a, StallHeader) && !world.has(a, StallSign)) world.add(a, StallSign, { soldOut: 1 });
  }
  for (const a of atts) if (world.isAlive(a) && world.getField(a, Fuel, "lit")) setEmittersLit(world, a, 1);
}

/**
 * ADR-315: saved Claim Flags keep the radius they were placed with (12 before ADR-315). Grow each to the current
 * privilegeRadius, but never into another party's claim: a flag stops where its rim would meet a foreign claim's rim
 * (and never shrinks below its saved radius), so a reload cannot lock anyone out of land they built on. Same-owner /
 * same-clan flags grow freely (their overlap only ever widens their own land). Deterministic: ascending entity order.
 */
export function growLegacyClaims(world: World, legacy: readonly (readonly [Entity, number])[]): void {
  for (const [e, target] of [...legacy].sort((a, b) => a[0] - b[0])) {
    const r0 = world.getField(e, PrivilegeZone, "radius") ?? 0; const t = world.get(e, Transform); if (!t) continue;
    let r = target;
    for (const z of zonesNear(world, t.x, t.y, target)) {
      if (z === e || zonesShareOwner(world, z, e)) continue;
      const zt = world.get(z, Transform)!; const d = Math.hypot(zt.x - t.x, zt.y - t.y); const rz = world.getField(z, PrivilegeZone, "radius") ?? 0;
      r = Math.min(r, Math.max(r0, d - rz));
    }
    if (r > r0) world.setField(e, PrivilegeZone, "radius", r);
  }
  invalidateZoneGrid(world);
}
