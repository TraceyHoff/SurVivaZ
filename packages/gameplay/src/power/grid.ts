/**
 * ADR-590 electricity tier: the power grid (authority). Cheap by construction:
 *  - the solve runs every POWER.everyTicks (20 = 1 Hz), never per frame;
 *  - topology (which nodes form a network) is rebuilt only when the set of powered pieces changes
 *    (count + id signature) or every topologyEveryTicks as a safety net — union-find over a spatial hash;
 *  - Power fields are written only when a value changes, so replication stays quiet in steady state.
 * Networks: nodes of the same tribe link when their distance <= max(reachA, reachB) (power.json $comment).
 * Solve per network: renewables (solar / wind / water) + fuel generators (load-following) meet demand;
 * surplus charges batteries (rate- and capacity-capped), a deficit discharges them; anything still short
 * browns out consumers in a deterministic (entity id) order. Clients only read Power (view + UI).
 */
import { DEFAULT_TICK_HZ, entityIndex, timeOfDay, Transform, Weather, seasonAt, type CommandHandlers, type Entity, type World } from "@engine/core";
import { installSpatialIndex, isWaterId, waterDepthAt, WaterDepth } from "@engine/world";
import { AttachKind, BuildPiece, Container, CraftQueue, Crafter, CraftingStation, Crop, Dead, Emitter, PieceLink, Power, PowerStore, Tribe } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { StationKind, type GameDefs, type PieceDef } from "../defs.js";
import { attachmentsOf, resolveAttachment } from "../building/links.js";
import { hasPrivilege } from "../building/place.js";
import { readSlots, removeItem } from "../inventory.js";
import { runningQueueStation } from "../systems/craft_queue.js";
import { riverCurrentAt } from "../river_current.js";
import { isUnderground } from "../terrain_depth.js";
import { TerrainRes } from "../world.js";
import { POWER, powerSpecFor, type PowerSpec } from "./data.js";
export { addPowerState } from "./state.js";
import { PowerToggleCmd } from "./commands.js";

const DT = POWER.everyTicks / DEFAULT_TICK_HZ; // seconds of sim time per solve
const WH = DT / 3600; // watt -> watt-hours per solve
const LINK_CELL = 16;

interface Node {
  readonly e: Entity; readonly spec: PowerSpec; readonly def: PieceDef; readonly x: number; readonly y: number; readonly tribe: number;
  /** water mills: flow multiplier from the site (computed at topology build) */ water: number;
}
interface GridState { sig: string; builtTick: number; nets: Node[][]; nodes: Map<Entity, Node> }
const STATE = new WeakMap<World, GridState>();

/** Power spec of a placed piece entity (undefined = not on the grid). */
export function pieceSpec(world: World, e: Entity, defs: GameDefs = gameplayDefs(world)): PowerSpec | undefined {
  const t = world.getField(e, BuildPiece, "type"); if (t === undefined) return undefined;
  return powerSpecFor(defs.pieces.get(t), world.getField(e, BuildPiece, "tier") ?? 0, defs.tiers);
}
function waterSite(world: World, n: { x: number; y: number; spec: PowerSpec }): number {
  const terrain = world.getResource(TerrainRes); if (!terrain || !n.spec.water) return 0;
  const shallowR = gameplayDefs(world).movement.shallowRadius;
  const tx = Math.floor(n.x), ty = Math.floor(n.y); let best = 0;
  const r = n.spec.water === "on" ? 0 : 2;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = tx + dx, y = ty + dy; if (!isWaterId(terrain.tileAt(x, y))) continue;
    let river: unknown; try { river = riverCurrentAt(world, x + 0.5, y + 0.5); } catch { river = undefined; }
    const m = river ? (waterDepthAt(terrain.tileAt, x, y, shallowR) === WaterDepth.Deep ? POWER.water.riverMul : POWER.water.shallowRiverMul) : POWER.water.stillMul;
    if (m > best) best = m;
  }
  return best;
}

function buildTopology(world: World, defs: GameDefs, list: Entity[], sig: string): GridState {
  const tf = world.store(Transform); const nodes: Node[] = [];
  for (const e of list) {
    const spec = pieceSpec(world, e, defs); if (!spec) continue;
    const s = tf.slot(entityIndex(e)); if (s < 0) continue;
    const def = defs.pieces.get(world.getField(e, BuildPiece, "type")!)!;
    const n: Node = { e, spec, def, x: tf.data.x[s]!, y: tf.data.y[s]!, tribe: world.getField(e, Tribe, "id") ?? 0, water: 0 };
    if (spec.kind === "water") n.water = waterSite(world, n);
    nodes.push(n);
  }
  // union-find over a spatial hash (cell = LINK_CELL; max reach 16 => neighbours within the 3x3 / 5x5 block)
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const cells = new Map<string, number[]>();
  nodes.forEach((n, i) => { const k = `${Math.floor(n.x / LINK_CELL)},${Math.floor(n.y / LINK_CELL)}`; (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); });
  const maxReach = Math.max(1, ...nodes.map((n) => n.spec.reach)); const span = Math.ceil(maxReach / LINK_CELL);
  nodes.forEach((a, i) => {
    if (a.spec.reach <= 0) return; // consumers link only from a node with reach
    const cx = Math.floor(a.x / LINK_CELL), cy = Math.floor(a.y / LINK_CELL);
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (j === i) continue; const b = nodes[j]!; if (b.tribe !== a.tribe) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(a.spec.reach, b.spec.reach)) { const ra = find(i), rb = find(j); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
  });
  const groups = new Map<number, Node[]>();
  nodes.forEach((n, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(n); });
  return { sig, builtTick: world.tick, nets: [...groups.values()], nodes: new Map(nodes.map((n) => [n.e, n])) };
}

/** Per-solve globals: solar factor (sun elevation x season x weather) and wind speed. */
function environment(world: World): { solar: number; wind: number } {
  let solar = 1, wind = 0;
  const tod = timeOfDay(world);
  if (tod.dayLengthTicks > 0 && tod.sun) {
    const { sunrise, sunset } = tod.sun; const h = tod.hours;
    solar = h >= sunrise && h < sunset ? Math.sin(Math.PI * (h - sunrise) / (sunset - sunrise)) : 0;
  }
  const w = seasonAt(world).weights; const sm = POWER.solar.seasonMul;
  solar *= (w[0] ?? 1) * (sm.summer ?? 1) + (w[1] ?? 0) * (sm.fall ?? 1) + (w[2] ?? 0) * (sm.winter ?? 1) + (w[3] ?? 0) * (sm.spring ?? 1);
  try {
    const wx = world.env(Weather); const m = POWER.solar.weatherMul[String(wx.kind)] ?? 1;
    solar *= 1 + (m - 1) * Math.min(1, Math.max(0.5, wx.intensity || 1)); wind = wx.windSpeed;
  } catch { /* no weather env: clear, calm */ }
  return { solar: Math.max(0, solar), wind };
}
/** Wind turbine output fraction for a hub wind speed (tiles/s): cubic-ish ramp from cutIn to rated, 0 above cutOut. */
export function windFraction(speed: number): number {
  const { cutIn, rated, cutOut } = POWER.wind;
  if (speed < cutIn || speed >= cutOut) return 0;
  if (speed >= rated) return 1;
  const f = (speed - cutIn) / (rated - cutIn); return f * f;
}
function sourceOutput(world: World, n: Node, env: { solar: number; wind: number }): number {
  const p = n.spec.produce ?? 0;
  switch (n.spec.kind) {
    case "solar": return isUnderground(world, n.x, n.y) ? 0 : p * env.solar;
    case "wind": return p * windFraction(env.wind * (n.spec.reach >= 10 ? POWER.wind.largeHubMul : 1));
    case "water": return p * n.water;
    default: return 0;
  }
}

/** Fuel seconds one item gives a generator (0 = not a generator fuel). */
function fuelSecondsOf(defs: GameDefs, item: number): number {
  const d = defs.items.get(item); if (!d) return 0;
  const l = POWER.fuel.liquidSeconds[d.key]; if (l) return l;
  return d.fuelSeconds > 0 ? d.fuelSeconds * POWER.fuel.solidMul : 0;
}
/** Seconds of fuel left in a generator's tank (current item + container). */
function fuelReserve(world: World, defs: GameDefs, n: Node): number {
  let s = world.getField(n.e, PowerStore, "fuel") ?? 0;
  const st = resolveAttachment(world, n.e, AttachKind.Storage); if (st === undefined) return s;
  const v = readSlots(world, st); for (let i = 0; i < v.slotCount; i++) s += v.count(i) * fuelSecondsOf(defs, v.item(i));
  return s;
}
/** Burn `seconds` of full-rate fuel, pulling the next fuel item from the container when the current one runs out. */
function burnFuel(world: World, defs: GameDefs, n: Node, seconds: number): void {
  let f = world.getField(n.e, PowerStore, "fuel") ?? 0; f -= seconds;
  while (f <= 0) {
    const st = resolveAttachment(world, n.e, AttachKind.Storage); if (st === undefined) break;
    const v = readSlots(world, st); let took = 0;
    for (let i = 0; i < v.slotCount && !took; i++) { const it = v.item(i); const fs = it ? fuelSecondsOf(defs, it) : 0; if (fs > 0 && removeItem(world, st, it, 1)) took = fs; }
    if (!took) { f = 0; break; }
    f += took;
  }
  world.setField(n.e, PowerStore, "fuel", Math.max(0, f));
}

interface UseCtx { crafting: { x: number; y: number; kind: StationKind }[] }
function inUse(world: World, n: Node, ctx: UseCtx): boolean {
  switch (n.spec.use) {
    case "always": return true;
    case "switch": case undefined: return true; // the on switch gates draw already
    case "food": {
      const st = resolveAttachment(world, n.e, AttachKind.Storage); if (st === undefined) return false;
      const v = readSlots(world, st); for (let i = 0; i < v.slotCount; i++) if (v.count(i)) return true; return false;
    }
    case "craft": {
      const kind = world.getField(n.e, CraftingStation, "kind") ?? StationKind.None; const range = world.getField(n.e, CraftingStation, "range") ?? 3;
      return ctx.crafting.some((c) => c.kind === kind && Math.hypot(c.x - n.x, c.y - n.y) <= range);
    }
    case "grow": {
      const found: Entity[] = [];
      for (const c of installSpatialIndex(world).queryRadius(n.x, n.y, 1.25, found)) if (world.has(c, Crop) && (world.getField(c, Crop, "kind") ?? 0) > 0) return true;
      return false;
    }
  }
  return true;
}
function craftingNow(world: World): UseCtx["crafting"] {
  const out: UseCtx["crafting"] = []; const defs = gameplayDefs(world); const tf = world.store(Transform);
  const push = (e: Entity, kind: StationKind): void => { const s = tf.slot(entityIndex(e)); if (s >= 0 && kind !== StationKind.None) out.push({ x: tf.data.x[s]!, y: tf.data.y[s]!, kind }); };
  for (const e of world.query([Crafter, Transform])) { const r = world.getField(e, Crafter, "recipe") ?? 0; if (r) push(e, defs.recipes.get(r)?.station ?? StationKind.None); }
  for (const e of world.query([CraftQueue, Transform])) { const k = runningQueueStation(world, e); if (k !== StationKind.None) push(e, k); }
  return out;
}

const pct = (v: number): number => Math.max(0, Math.min(100, Math.round(v * 100)));
const q10 = (w: number): number => Math.min(0xffff, Math.round(w / 10)); // tens of watts
function write(world: World, e: Entity, f: "on" | "powered" | "active" | "level" | "supply" | "demand", v: number): boolean {
  if (world.getField(e, Power, f) === v) return false; world.setField(e, Power, f, v); return true;
}
/** Network totals (UI only): rewritten when they move by >= 50 W (or to / from 0), so a drifting solar output stays off the wire. */
function writeTotal(world: World, e: Entity, f: "supply" | "demand", v: number): void {
  const cur = world.getField(e, Power, f) ?? 0;
  if (cur !== v && (Math.abs(cur - v) >= 5 || v === 0 || cur === 0)) world.setField(e, Power, f, v);
}
/** Light / heat attachments follow `active` (ADR-590: lamps, heater, powered building tier). */
export function setPowerEmitters(world: World, piece: Entity, spec: PowerSpec, active: boolean): void {
  for (const a of attachmentsOf(world, piece)) {
    if (!world.has(a, Emitter)) continue;
    const kind = world.getField(a, PieceLink, "kind");
    if (kind === AttachKind.Light) world.setField(a, Emitter, "strength", active ? 1 : 0);
    else if (kind === AttachKind.Heat) world.setField(a, Emitter, "strength", active ? spec.heat ?? 0 : 0);
  }
}

/** One network's solve. Exported for tests. */
function solveNet(world: World, defs: GameDefs, net: Node[], env: { solar: number; wind: number }, ctx: UseCtx): void {
  const standby = POWER.standbyFraction;
  let renew = 0, demand = 0;
  const out = new Map<Entity, number>(); const draw = new Map<Entity, number>(); const use = new Map<Entity, boolean>();
  const batteries: Node[] = []; const gens: Node[] = []; const loads: Node[] = [];
  for (const n of net) {
    const on = (world.getField(n.e, Power, "on") ?? 1) !== 0;
    if (n.spec.store) batteries.push(n);
    if (n.spec.role === "source") {
      if (!on) { out.set(n.e, 0); continue; }
      if (n.spec.kind === "fuel") gens.push(n);
      else { const w = sourceOutput(world, n, env); out.set(n.e, w); renew += w; }
    } else if (n.spec.role === "consumer" || n.spec.role === "pylon") {
      if (!on) { draw.set(n.e, 0); use.set(n.e, false); continue; }
      const u = inUse(world, n, ctx); use.set(n.e, u);
      const w = (n.spec.watts ?? 0) * (u ? 1 : standby); draw.set(n.e, w); demand += w; loads.push(n);
    }
  }
  // battery headroom (W) and available discharge (W)
  let charge = 0, discharge = 0, stored = 0, cap = 0;
  for (const b of batteries) {
    const s = world.getField(b.e, PowerStore, "stored") ?? 0; const c = b.spec.store!; stored += s; cap += c;
    charge += Math.min(b.spec.rate ?? 0, (c - s) / WH); discharge += Math.min(b.spec.rate ?? 0, s / WH);
  }
  // fuel generators follow load: cover the deficit, and top the batteries up while they are below half
  let need = Math.max(0, demand - renew) + (cap > 0 && stored / cap < 0.5 ? charge : 0);
  for (const g of gens) {
    const p = g.spec.produce ?? 0; const w = need > 0 && fuelReserve(world, defs, g) > 0 ? Math.min(p, need) : 0;
    out.set(g.e, w); need -= w; renew += w;
    if (w > 0) burnFuel(world, defs, g, DT * Math.max(POWER.fuel.minLoad, w / p));
  }
  const supply = renew;
  // balance
  let flow = supply - demand; // >0 charge, <0 discharge
  let poweredSet: Set<Entity>;
  if (flow >= 0 || -flow <= discharge) poweredSet = new Set(loads.map((n) => n.e));
  else {
    // brownout: power loads in entity order while the budget lasts
    let budget = supply + discharge; poweredSet = new Set();
    for (const n of [...loads].sort((a, b) => a.e - b.e)) { const w = draw.get(n.e)!; if (w <= budget) { poweredSet.add(n.e); budget -= w; } }
    let used = 0; for (const n of loads) if (poweredSet.has(n.e)) used += draw.get(n.e)!;
    flow = supply - used;
  }
  // distribute the flow over batteries (each rate / capacity capped), in entity order
  const bflow = new Map<Entity, number>();
  let rem = flow;
  for (const b of [...batteries].sort((a, c) => a.e - c.e)) {
    const s = world.getField(b.e, PowerStore, "stored") ?? 0; const c = b.spec.store!; const rate = b.spec.rate ?? 0;
    let w = 0;
    if (rem > 0) w = Math.min(rem, rate, (c - s) / WH);
    else if (rem < 0) w = -Math.min(-rem, rate, s / WH);
    rem -= w; bflow.set(b.e, w);
    world.setField(b.e, PowerStore, "stored", Math.max(0, Math.min(c, s + w * WH)));
  }
  const energised = supply > 0 || discharge > 0;
  const sup10 = q10(supply), dem10 = q10(demand);
  for (const n of net) {
    const e = n.e; let powered = false, active = false, level = 0;
    const on = (world.getField(e, Power, "on") ?? 1) !== 0;
    switch (n.spec.role) {
      case "source": {
        const w = out.get(e) ?? 0; powered = on && (w > 0 || energised); active = on && w > 0;
        if (n.spec.kind === "fuel") level = pct(Math.min(1, fuelReserve(world, defs, n) / Math.max(1, POWER.fuel.liquidSeconds.lamp_oil ?? 600) / 4));
        break;
      }
      case "battery": powered = energised; active = Math.abs(bflow.get(e) ?? 0) > 1; break;
      default: powered = on && poweredSet.has(e); active = powered && (use.get(e) ?? false);
    }
    if (n.spec.store) level = pct((world.getField(e, PowerStore, "stored") ?? 0) / n.spec.store);
    const wasActive = (world.getField(e, Power, "active") ?? 0) !== 0;
    write(world, e, "powered", powered ? 1 : 0); write(world, e, "active", active ? 1 : 0);
    write(world, e, "level", level); writeTotal(world, e, "supply", sup10); writeTotal(world, e, "demand", dem10);
    if (wasActive !== active || world.tick < POWER.everyTicks * 2) setPowerEmitters(world, e, n.spec, active);
  }
}

/** The grid system (authority; scheduled every POWER.everyTicks by install.ts). */
export function powerGridSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying || !world.isRegistered(Power)) return;
  const list = [...world.query([Power, BuildPiece, Transform])].filter((e) => !world.has(e, Dead)).sort((a, b) => a - b);
  if (!list.length) { STATE.delete(world); return; }
  const defs = gameplayDefs(world);
  const sig = `${list.length}:${list.join(",")}`;
  let st = STATE.get(world);
  if (!st || st.sig !== sig || world.tick - st.builtTick >= POWER.topologyEveryTicks) { st = buildTopology(world, defs, list, sig); STATE.set(world, st); }
  const env = environment(world); const ctx: UseCtx = { crafting: craftingNow(world) };
  for (const net of st.nets) solveNet(world, defs, net, env, ctx);
}
/** Force a topology rebuild next solve (tests; tribe changes). */
export function invalidatePowerGrid(world: World): void { STATE.delete(world); }
/** Network members of a piece (UI / tests): same network list, or [] when not on the grid. */
export function powerNetworkOf(world: World, e: Entity): Entity[] {
  const st = STATE.get(world); if (!st) return [];
  return st.nets.find((n) => n.some((x) => x.e === e))?.map((x) => x.e) ?? [];
}

/** ADR-590: why a power toggle is refused (undefined = ok). */
export function checkPowerToggle(world: World, actor: Entity, piece: Entity): string | undefined {
  if (!world.isAlive(piece)) return "not_found";
  if (!world.has(piece, Power) || world.has(piece, Dead)) return "not_powered_piece";
  const tf = world.store(Transform); const a = tf.slot(entityIndex(actor)), b = tf.slot(entityIndex(piece)); if (a < 0 || b < 0) return "not_found";
  const x = tf.data.x[b]!, y = tf.data.y[b]!;
  if (Math.hypot(tf.data.x[a]! - x, tf.data.y[a]! - y) > 4) return "too_far";
  if (!hasPrivilege(world, actor, x, y)) return "no_privilege";
  return undefined;
}
export function installPowerCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(PowerToggleCmd, {
    validate: (v, c) => checkPowerToggle(world, c.actor, v.target as Entity),
    handle: (v) => { world.setField(v.target as Entity, Power, "on", v.on ? 1 : 0); },
  });
}
void Container;
