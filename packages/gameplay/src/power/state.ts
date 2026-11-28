/** ADR-590: power state helpers with no system imports (placePiece calls addPowerState; keeps building/place.ts cycle-free). */
import type { Entity, World } from "@engine/core";
import { Power, PowerStore } from "../components.js";
import type { PowerSpec } from "./data.js";

/** Give a newly placed powered piece its grid state (placePiece, authority). Switch defaults on; stores start empty. */
export function addPowerState(world: World, e: Entity, spec: PowerSpec): void {
  if (!world.has(e, Power)) world.add(e, Power, { on: 1, powered: 0, active: 0, level: 0, supply: 0, demand: 0 });
  if ((spec.store || spec.kind === "fuel") && !world.has(e, PowerStore)) world.add(e, PowerStore, { stored: 0, fuel: 0 });
}
