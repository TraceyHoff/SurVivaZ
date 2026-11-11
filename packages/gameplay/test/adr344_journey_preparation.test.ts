// ADR-344: distance-based journey preparation for AI humans (ai/journey.ts, ai/travel.ts): a bot setting
// out on a long trip estimates the trip from the route length (off-screen speeds 2.6 / 5.4 tiles/s, plus
// rest stops) and packs food / water / gear sized to it from its own storage — or its employer's, for
// hired workers — taking only the surplus above the data reserve, never while hungry / thirsty / cold,
// and turns back toward home (or forages en route) when its provisions run out mid-trip.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, scoreBehavior, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import * as J from "../src/ai/journey.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, ensureClaim, makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const T = G.TRAVEL;
const D = G.defaultDefs();
const IRON_ORE = D.itemId("iron_ore");
const WOOD = D.itemId("wood");
const COOKED_MEAT = D.itemId("cooked_meat");
const WATER_FLASK = D.itemId("water_flask");
const BERRIES = D.itemId("berries");
const STONE_AXE = D.itemId("stone_axe");
const STONE_PICKAXE = D.itemId("stone_pickaxe");
const BRONZE_PICKAXE = D.itemId("bronze_pickaxe");
const IRON_VEIN = D.resourceId("iron_vein");
const CHROMITE_VEIN = D.resourceId("chromite_vein");
let nid = 9200;
type Mem = { travel?: G.TravelState; travelAt?: number; roamSince?: number; base?: { x: number; y: number }; resourceNeed?: { items: number[]; at: number }; resourceBanned?: { x: number; y: number; at: number }[]; resourceReturn?: boolean; spawnOff?: boolean; journeyBlocked?: { at: number } };
const mem = (a: Agent): Mem => aiMemoryOf(a) as unknown as Mem;
const M = (entries: [string, number][]): Map<number, number> => new Map(entries.map(([k, n]) => [D.itemId(k), n]));
const rich = (): Map<number, number> => M([["cooked_meat", 10], ["water_flask", 10], ["berries", 10]]);

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; slot?: number; x?: number; y?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 + (opts.slot ?? 0) }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, opts.slot ?? 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
/** Server-side effects of the bot's container actions (copen / cclose are panel state; only the withdraw moves items). */
function applyContainer(r: Rig, o: AgentOutput): void {
  for (const a of o.actions) {
    const [k, t, i, n] = a.split(":");
    if (k !== "cwithdraw") continue;
    const c = G.resolveAttachment(r.w, Number(t) as Entity, G.AttachKind.Storage)!;
    if (G.canUseBaseStorage(r.w, r.p, c)) G.transferItem(r.w, c, r.p, Number(i), Number(n));
  }
}
// ---- a bot at its base (10,10) with a claim and a storage box -----------------------------------------------
const BASE = { x: 10, y: 10 };
// west of the base: the departure route heads north-east, and a box on the east side wedges the bot against its
// south-west corner on the way out (diagonal input into the corner blocks both axes; pre-existing nav geometry,
// not preparation — the box just has to sit off the departure line).
const BOX_AT = { x: BASE.x - 2, y: BASE.y + 1 };
function baseRig(): Rig & { box: Entity } {
  const r = rig({ x: BASE.x + 1, y: BASE.y + 3.3 });
  r.home = { x: BASE.x + 1, y: BASE.y + 1 };
  mem(r.a).base = { ...BASE };
  plantClaim(r.w, r.p, BASE.x - 2, BASE.y - 2);
  const def = D.pieces.get(D.pieceId("basic_storage_box"))!;
  const sn = G.snapPlacement(r.w, { piece: def.id, x: BOX_AT.x, y: BOX_AT.y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  if (typeof sn === "number") throw new Error(`box snap failed: ${sn}`);
  const box = G.placePiece(r.w, r.p, sn, { pay: false });
  steps(r.w, 25);
  return { ...r, box };
}
const boxAtt = (r: Rig, box: Entity): Entity => G.resolveAttachment(r.w, box, G.AttachKind.Storage)!;
const stock = (r: Rig, box: Entity, items: [string, number][]): void => { for (const [k, n] of items) G.addItem(r.w, boxAtt(r, box), D.itemId(k), n); steps(r.w, 25); };
const boxCount = (r: Rig, box: Entity, key: string): number => G.countItem(r.w, boxAtt(r, box), D.itemId(key));
/** A long resource trip the bot is about to leave on (route assigned on the next sensor pass). */
const longTrip = (r: Rig): void => {
  G.addItem(r.w, r.p, STONE_AXE, 1); // the wood trip's tool, carried: no gear to pack
  mem(r.a).resourceNeed = { items: [WOOD], at: r.w.tick };
  mem(r.a).travel = { kind: "resource", x: 800.5, y: 0.5, since: r.w.tick, leg: 0, origin: { x: BASE.x + 1, y: BASE.y + 3.3 }, pending: true, items: [WOOD], nodeKind: D.resourceId("tree") };
};

describe("ADR-344 data: knobs live in ai_journey.json", () => {
  it("estimate, reserve, gate and turn-back knobs are data, not code", () => {
    expect(J.JOURNEY_DATA.minPrepTiles).toBe(100);
    expect(J.JOURNEY_DATA.safetyMargin).toBe(1.25);
    expect(J.JOURNEY_DATA.restEverySeconds).toBe(300);
    expect(J.JOURNEY_DATA.restSeconds).toBe(60);
    expect(J.JOURNEY_DATA.departMinHunger).toBe(55);
    expect(J.JOURNEY_DATA.departMinThirst).toBe(60);
    expect(J.JOURNEY_DATA.turnBackHunger).toBe(30);
    expect(J.JOURNEY_DATA.turnBackThirst).toBe(30);
    expect(J.JOURNEY_DATA.prepDeadlineTicks).toBe(1200);
    expect(J.JOURNEY_DATA.reserve.cooked_meat).toBe(2);
    expect(J.JOURNEY_DATA.defaultReserve).toBe(1);
  });
});

describe("ADR-344 trip estimate", () => {
  it("routeTiles sums the legs from the origin through every waypoint", () => {
    expect(J.routeTiles([{ x: 3, y: 4 }, { x: 3, y: 10 }], { x: 0, y: 0 })).toBe(11);
    expect(J.routeTiles([], { x: 0, y: 0 })).toBe(0);
  });
  it("a foot trip is slower than a mounted trip of the same distance, and long trips budget rests", () => {
    const foot = J.estimateJourney(800, false);
    expect(foot.tiles).toBe(800);
    expect(foot.restStops).toBe(1); // 800 / 2.6 = 308 s: one rest per 300 s
    expect(foot.seconds).toBeCloseTo(800 / T.offscreen.speedTilesPerSec + 60, 9);
    expect(foot.ticks).toBe(Math.ceil(foot.seconds * 20));
    const mounted = J.estimateJourney(800, true);
    expect(mounted.restStops).toBe(0); // 800 / 5.4 = 148 s: no rest yet
    expect(mounted.seconds).toBeCloseTo(800 / T.offscreen.mountSpeedTilesPerSec, 9);
    expect(mounted.seconds).toBeLessThan(foot.seconds);
    expect(J.estimateJourney(1600, false).restStops).toBe(2); // 615 s of walking: two rests
  });
  it("willRide: already riding, or an own mount for a long leg — never for a short leg or a busy mount", () => {
    expect(J.willRide(undefined, true, 800)).toBe(false);
    expect(J.willRide({ riding: true, busy: false }, false, 800)).toBe(true);
    expect(J.willRide({ riding: false, busy: false }, true, 800)).toBe(true);
    expect(J.willRide({ riding: false, busy: false }, true, 10)).toBe(false);
    expect(J.willRide({ riding: false, busy: true }, true, 800)).toBe(false);
    expect(J.willRide({ riding: false, busy: false }, false, 800)).toBe(false); // no mount skill, no ride
  });
  it("journeyNeeds burns vitals rates times the safety margin", () => {
    const n = J.journeyNeeds(J.estimateJourney(1600, false));
    expect(n.hunger).toBeCloseTo(735.38 * 0.05 * 1.25, 1);
    expect(n.thirst).toBeCloseTo(735.38 * 0.08 * 1.25, 1);
  });
});

describe("ADR-344 pack sizing", () => {
  it("a short trip packs little, a long trip packs proportionally more", () => {
    const short = J.planJourneyPack(D, J.estimateJourney(120, false), new Map(), rich(), { freeSlots: 16 });
    expect(short.food).toEqual([{ item: COOKED_MEAT, count: 1 }]);
    expect(short.water).toEqual([{ item: WATER_FLASK, count: 1 }]);
    expect(short.prepared).toBe(true);
    const long = J.planJourneyPack(D, J.estimateJourney(1600, false), new Map(), rich(), { freeSlots: 16 });
    expect(long.food).toEqual([{ item: COOKED_MEAT, count: 2 }]);
    expect(long.water).toEqual([{ item: WATER_FLASK, count: 3 }]);
    expect(long.prepared).toBe(true);
  });
  it("a mounted trip packs less than the same trip on foot", () => {
    const foot = J.planJourneyPack(D, J.estimateJourney(1600, false), new Map(), rich(), { freeSlots: 16 });
    const mounted = J.planJourneyPack(D, J.estimateJourney(1600, true), new Map(), rich(), { freeSlots: 16 });
    expect(mounted.food).toEqual([{ item: COOKED_MEAT, count: 1 }]);
    expect(mounted.water).toEqual([{ item: WATER_FLASK, count: 1 }]);
    expect(mounted.hunger).toBeLessThan(foot.hunger);
    expect(mounted.thirst).toBeLessThan(foot.thirst);
  });
  it("what the bag already holds counts first: a stocked bag packs nothing", () => {
    const bag = M([["cooked_meat", 2], ["water_flask", 3]]);
    const p = J.planJourneyPack(D, J.estimateJourney(1600, false), bag, rich(), { freeSlots: 16 });
    expect(p.food).toEqual([]); expect(p.water).toEqual([]);
    expect(p.hunger).toBe(60); expect(p.thirst).toBe(105);
    expect(p.prepared).toBe(true);
  });
});

describe("ADR-344 never starve the base", () => {
  it("the pack takes only the surplus above the data reserve (per-item, else the default of one)", () => {
    const scarce = M([["cooked_meat", 4], ["water_flask", 1], ["berries", 1]]);
    const p = J.planJourneyPack(D, J.estimateJourney(2400, false), new Map(), scarce, { freeSlots: 16 });
    expect(p.food).toEqual([{ item: COOKED_MEAT, count: 2 }]); // 4 in store, reserve 2: take 2
    expect(p.water).toEqual([]); // the only flask is the reserve: stays
    expect(p.prepared).toBe(false); // short on food and water: the trip is not covered
  });
  it("an item the planner still needs (its gather leaves) is never packed", () => {
    const p = J.planJourneyPack(D, J.estimateJourney(1600, false), new Map(), rich(), { leaves: new Set([COOKED_MEAT]), freeSlots: 16 });
    expect(p.food).toEqual([{ item: BERRIES, count: 4 }]); // 46 hunger / 12 per berry
    expect(p.food.some((f) => f.item === COOKED_MEAT)).toBe(false);
    expect(p.water).toEqual([{ item: WATER_FLASK, count: 2 }]); // berries cover 24 thirst first
  });
  it("the pack fits the bag: a full bag packs nothing it cannot carry", () => {
    const bag = M([["cooked_meat", 20]]); // one full stack: 15 free slots, but no room for a flask stack is not the point — 0 free slots is
    const p = J.planJourneyPack(D, J.estimateJourney(1600, false), bag, rich(), { freeSlots: 0 });
    expect(p.water).toEqual([]); // flasks need a free slot each; none free
    expect(p.food).toEqual([]); // the bag already covers the hunger need
    expect(p.prepared).toBe(false); // thirst uncovered
  });
});

describe("ADR-344 gear: the right tool for the target resource", () => {
  it("requiredToolsFor takes the lowest tier any node yielding the item needs (the planner's leaf rule)", () => {
    expect(J.requiredToolsFor(D, [IRON_ORE])).toEqual([{ kind: G.ToolKind.Pickaxe, tier: 2 }]);
    expect(J.requiredToolsFor(D, [WOOD])).toEqual([{ kind: G.ToolKind.Axe, tier: 1 }]);
    expect(J.requiredToolsFor(D, [D.itemId("bronze_ingot")])).toEqual([]);
  });
  it("toolsForNodeKinds is exact per destination node: iron_vein needs tier 2, chromite tier 4", () => {
    expect(J.toolsForNodeKinds(D, [IRON_VEIN])).toEqual([{ kind: G.ToolKind.Pickaxe, tier: 2 }]);
    expect(J.toolsForNodeKinds(D, [CHROMITE_VEIN])).toEqual([{ kind: G.ToolKind.Pickaxe, tier: 4 }]);
  });
  it("missingGear: nothing anywhere, or only a lower tier, reports the tool to fetch", () => {
    expect(J.missingGear(D, [IRON_ORE], new Map(), undefined)).toEqual([BRONZE_PICKAXE]);
    expect(J.missingGear(D, [IRON_ORE], new Map(), M([["stone_pickaxe", 1]]))).toEqual([BRONZE_PICKAXE]); // tier 1 cannot work iron
    expect(J.missingGear(D, [IRON_ORE], new Map(), M([["bronze_pickaxe", 1]]))).toEqual([]);
    expect(J.missingGear(D, [IRON_ORE], M([["iron_pickaxe", 1]]), undefined)).toEqual([]); // carried
    // the destination node decides: a chromite trip needs steel, even with bronze in storage
    expect(J.missingGear(D, [IRON_ORE], new Map(), M([["bronze_pickaxe", 1]]), [CHROMITE_VEIN])).toEqual([D.itemId("steel_pickaxe")]);
  });
  it("planJourneyPack packs the tool from storage (lowest adequate tier), never one already carried", () => {
    const p = J.planJourneyPack(D, J.estimateJourney(1600, false), new Map(), M([["bronze_pickaxe", 1], ["cooked_meat", 5]]), { targetItems: [IRON_ORE], freeSlots: 16 });
    expect(p.gear).toEqual([{ item: BRONZE_PICKAXE, count: 1 }]);
    const carried = J.planJourneyPack(D, J.estimateJourney(1600, false), M([["stone_pickaxe", 1]]), M([["bronze_pickaxe", 1]]), { targetItems: [IRON_ORE], freeSlots: 16 });
    expect(carried.gear).toEqual([{ item: BRONZE_PICKAXE, count: 1 }]); // the carried tier-1 pick cannot work iron: pack the bronze one
    expect(J.missingGear(D, [IRON_ORE], M([["stone_pickaxe", 1]]), M([["bronze_pickaxe", 1]]))).toEqual([]);
    const noTool = J.planJourneyPack(D, J.estimateJourney(1600, false), new Map(), M([["cooked_meat", 5]]), { targetItems: [IRON_ORE], freeSlots: 16 });
    expect(noTool.gear).toEqual([]);
    expect(noTool.prepared).toBe(false);
  });
});

describe("ADR-344 departure gate: never set out hungry, thirsty or cold", () => {
  it("canPrepareJourney mirrors the autonomy hungry cutoffs (55 / 60)", () => {
    expect(J.canPrepareJourney(100, 100, false)).toBe(true);
    expect(J.canPrepareJourney(40, 100, false)).toBe(false);
    expect(J.canPrepareJourney(100, 40, false)).toBe(false);
    expect(J.canPrepareJourney(100, 100, true)).toBe(false);
    expect(J.canPrepareJourney(55, 60, false)).toBe(true);
  });
  it("a hungry bot does not prepare and its travel behaviour scores 0; fed, the pack appears", () => {
    const r = baseRig(); stock(r, r.box, [["cooked_meat", 6], ["water_flask", 4]]);
    longTrip(r);
    r.w.set(r.p, G.Survival, { hunger: 40, thirst: 100 });
    const hungry = ctxOf(r);
    expect(hungry.world.travel?.route).toBeDefined();
    expect(hungry.world.journeyPrep).toBeUndefined();
    expect(mem(r.a).travel?.journey).toBeUndefined(); // waiting to eat first, not departed bag-only
    const reg = G.survivorRegistry();
    expect(scoreBehavior(reg.get("travel")!, hungry, undefined, [])).toBe(0); // a long trip does not start unresolved
    fed(r);
    const fedCtx = ctxOf(r);
    expect(fedCtx.world.journeyPrep).toBeDefined();
    expect(fedCtx.world.journeyPrep!.box.id).toBe(r.box);
    // the exact pack follows from the assigned route (round trip) and the live counts, not a magic number
    const route = fedCtx.world.travel!.route!;
    const tiles = J.routeTiles(route, { x: BASE.x + 1, y: BASE.y + 3.3 }) * 2;
    const expected = J.planJourneyPack(D, J.estimateJourney(tiles, false), M([["stone_axe", 1]]), M([["cooked_meat", 6], ["water_flask", 4]]), { freeSlots: 15 });
    expect(fedCtx.world.journeyPrep!.items).toEqual([...expected.gear, ...expected.water, ...expected.food]);
    expect(expected.food.length + expected.water.length).toBeGreaterThan(0);
  });
  it("a short trip needs no preparation and its travel behaviour is not gated", () => {
    const r = rig();
    mem(r.a).travel = { kind: "explore", x: 60, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 60, y: 0 }] };
    const c = ctxOf(r);
    expect(c.world.travel?.journey).toBeUndefined();
    expect(c.world.journeyPrep).toBeUndefined();
    const reg = G.survivorRegistry();
    expect(scoreBehavior(reg.get("travel")!, c, undefined, [])).toBeGreaterThan(0);
  });
});

describe("ADR-344 preparation end to end: pack, then leave", () => {
  it("the bot withdraws the pack from its own box, keeps the reserve, and departs prepared", () => {
    const r = baseRig(); stock(r, r.box, [["cooked_meat", 10], ["water_flask", 10]]);
    longTrip(r); fed(r);
    const ctl = G.survivorController({ seed: 1, commands: false }); ctl.add(r.a); // keep copen/cwithdraw/cclose as action strings for applyContainer (emitAgentCommands would move them into o.commands)
    let journey: G.JourneyState | undefined;
    for (let i = 0; i < 900 && !journey; i++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)!).get(r.a)!;
      applyContainer(r, o); move(r, o); r.w.step(DT); fed(r);
      journey = mem(r.a).travel?.journey;
    }
    expect(journey).toBeDefined();
    expect(journey!.prepared).toBe(true);
    // the exact pack follows from the assigned route (round trip) and the starting counts
    const route = mem(r.a).travel!.route!;
    const tiles = J.routeTiles(route, { x: BASE.x + 1, y: BASE.y + 3.3 }) * 2;
    const expected = J.planJourneyPack(D, J.estimateJourney(tiles, false), M([["stone_axe", 1]]), M([["cooked_meat", 10], ["water_flask", 10]]), { freeSlots: 15 });
    const meat = expected.food.find((f) => f.item === COOKED_MEAT)?.count ?? 0;
    const flask = expected.water.find((f) => f.item === WATER_FLASK)?.count ?? 0;
    expect(meat).toBeGreaterThan(0); expect(flask).toBeGreaterThan(0);
    expect(G.countItem(r.w, r.p, COOKED_MEAT)).toBe(meat);
    expect(G.countItem(r.w, r.p, WATER_FLASK)).toBe(flask);
    expect(boxCount(r, r.box, "cooked_meat")).toBe(10 - meat); // the reserve stays: only the surplus leaves
    expect(boxCount(r, r.box, "water_flask")).toBe(10 - flask);
    // and then it actually leaves on the expedition
    const start = { ...r.w.get(r.p, Transform)! };
    for (let i = 0; i < 600; i++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)!).get(r.a)!;
      applyContainer(r, o); move(r, o); r.w.step(DT); fed(r);
      if (Math.hypot(r.w.get(r.p, Transform)!.x - start.x, r.w.get(r.p, Transform)!.y - start.y) > 20) break;
    }
    const p = r.w.get(r.p, Transform)!;
    expect(Math.hypot(p.x - start.x, p.y - start.y)).toBeGreaterThan(20);
    expect(mem(r.a).travel?.kind).toBe("resource");
  });
  it("an explore leg prepares the same way (the hook is the route, not the kind)", () => {
    const r = baseRig(); stock(r, r.box, [["cooked_meat", 6], ["water_flask", 4]]);
    G.addItem(r.w, r.p, STONE_AXE, 1);
    mem(r.a).travel = { kind: "explore", x: 800, y: 0, since: r.w.tick, leg: 0, origin: { x: BASE.x + 1, y: BASE.y + 3.3 }, pending: true };
    fed(r);
    const c = ctxOf(r);
    expect(c.world.travel?.route).toBeDefined();
    expect(c.world.journeyPrep).toBeDefined();
    expect(c.world.journeyPrep!.items).toEqual(expect.arrayContaining([{ item: COOKED_MEAT, count: 1 }, { item: WATER_FLASK, count: 2 }]));
  });
});

describe("ADR-344 gear: the trip waits while the planner works the tool chain", () => {
  it("requiredToolChain: the tool, its recipe closure, and its stations (iron = the bronze chain)", () => {
    const wood = J.requiredToolChain(D, [WOOD])!;
    expect(wood.tool).toBe(STONE_AXE);
    expect([...wood.items].sort((a, b) => a - b)).toEqual([STONE_AXE, WOOD, D.itemId("stone"), D.itemId("fiber")].sort((a, b) => a - b));
    expect(wood.stations.size).toBe(0); // the stone axe is a hand craft
    const iron = J.requiredToolChain(D, [IRON_ORE])!;
    expect(iron.tool).toBe(BRONZE_PICKAXE);
    for (const k of ["bronze_ingot", "copper_ore", "tin_ore", "planks"]) expect(iron.items.has(D.itemId(k))).toBe(true);
    expect(iron.stations.has(4)).toBe(true); // anvil (StationKind.Anvil); furnace + workbench join it via the sub-recipes
    expect(J.requiredToolChain(D, [BERRIES])).toBeUndefined(); // bare hands: no tool, no wait
    expect(J.requiredToolChain(D, [])).toBeUndefined();
  });
  it("stepTargetsToolChain: withdraw / craft / build steps on the chain, nothing else", () => {
    const iron = J.requiredToolChain(D, [IRON_ORE])!;
    expect(J.stepTargetsToolChain(D, { k: "withdraw", item: BRONZE_PICKAXE, count: 1 }, iron)).toBe(true);
    expect(J.stepTargetsToolChain(D, { k: "craft", recipe: D.recipeId("bronze_pickaxe"), count: 1, station: 4, ticks: 10 }, iron)).toBe(true);
    expect(J.stepTargetsToolChain(D, { k: "build", piece: D.pieceId("anvil"), x: 0, y: 0, level: 0, slot: "s0", stand: { x: 0, y: 0 } }, iron)).toBe(true);
    expect(J.stepTargetsToolChain(D, { k: "craft", recipe: D.recipeId("stone_axe"), count: 1, station: 0, ticks: 10 }, iron)).toBe(false);
    expect(J.stepTargetsToolChain(D, undefined, iron)).toBe(false);
  });
  it("a fresh bot's wood expedition waits for the axe chain, then departs once the axe is in hand", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "tree", 800.5, 0.5);
    mem(r.a).resourceNeed = { items: [WOOD], at: r.w.tick };
    mem(r.a).travel = { kind: "resource", x: 800.5, y: 0.5, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, pending: true, items: [WOOD] };
    const c = ctxOf(r);
    expect(c.world.travel?.route!.length).toBeGreaterThan(10); // the route is assigned: only the departure waits
    expect(c.world.plan?.leaves.some((l) => [WOOD, D.itemId("stone"), D.itemId("fiber")].includes(l))).toBe(true); // the plan is working the axe chain
    expect(c.world.travel?.journey).toBeUndefined(); // no axe in hand: the trip does not start
    const reg = G.survivorRegistry();
    expect(scoreBehavior(reg.get("travel")!, c, undefined, [])).toBe(0);
    G.addItem(r.w, r.p, STONE_AXE, 1); // the means, in hand
    const c2 = ctxOf(r);
    expect(c2.world.travel?.journey).toBeDefined(); // no box here: bag-only, but the departure is no longer held
    expect(c2.world.travel?.journey?.prepared).toBe(false);
    expect(scoreBehavior(reg.get("travel")!, c2, undefined, [])).toBeGreaterThan(0);
  });
  it("the wait is bounded: past the prep deadline the bot leaves with what the bag holds", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "tree", 800.5, 0.5);
    mem(r.a).resourceNeed = { items: [WOOD], at: r.w.tick };
    mem(r.a).travel = { kind: "resource", x: 800.5, y: 0.5, since: r.w.tick - 1300, leg: 0, origin: { x: 0, y: 0 }, pending: true, items: [WOOD] };
    const c = ctxOf(r);
    expect(c.world.travel?.route!.length).toBeGreaterThan(10);
    expect(c.world.travel?.journey).toBeDefined(); // waited long enough: bag-only, unprepared, but moving
    expect(c.world.travel?.journey?.prepared).toBe(false);
  });
  it("pickTravelGoal records the prospected node kind on the goal", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    mem(r.a).resourceNeed = { items: [IRON_ORE], at: r.w.tick };
    const g = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
    expect(g.kind).toBe("resource");
    expect(g.nodeKind).toBe(IRON_VEIN);
  });
});

describe("ADR-344 running out mid-trip: turn back, do not press on and die", () => {
  it("off-screen: provisions drain with the miles and the bot turns back (no ban, floor holds)", () => {
    const r = rig();
    mem(r.a).base = { x: 0, y: 0 };
    r.w.set(r.p, G.Survival, { hunger: 40, thirst: 100 });
    mem(r.a).travel = { kind: "resource", x: 800, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 800, y: 0 }], items: [WOOD], journey: { food: 1, water: 100, estTicks: 100000, prepared: false } };
    let turned = false;
    for (let i = 0; i < 60 && !turned; i++) { G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks); turned = mem(r.a).travel?.kind === "return"; }
    expect(turned).toBe(true);
    expect(mem(r.a).travel).toMatchObject({ kind: "return", x: 1, y: 1 }); // home = base anchor + 1
    expect(mem(r.a).journeyBlocked).toBeDefined(); // no immediate re-launch
    expect(mem(r.a).resourceBanned ?? []).toEqual([]); // the node is fine: no ban
    const p = r.w.get(r.p, Transform)!;
    expect(Math.hypot(p.x, p.y)).toBeLessThan(100); // turned back long before the 800-tile node
    expect(r.w.get(r.p, G.Survival)!.hunger).toBeGreaterThanOrEqual(T.offscreen.needsFloor); // abstract foraging kept it alive
  });
  it("off-screen: a long trip that left with no journey record gets the rule from what the bag holds", () => {
    const r = rig();
    mem(r.a).base = { x: 0, y: 0 };
    G.addItem(r.w, r.p, COOKED_MEAT, 1); G.addItem(r.w, r.p, WATER_FLASK, 1);
    mem(r.a).travel = { kind: "resource", x: 800, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 800, y: 0 }], items: [WOOD] };
    G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks);
    const j = mem(r.a).travel?.journey!;
    expect(j.prepared).toBe(false); // recorded from the bag, not packed: meat 30 / flask 35, minus one step of drain
    expect(j.food).toBeGreaterThan(29); expect(j.food).toBeLessThanOrEqual(30);
    expect(j.water).toBeGreaterThan(34); expect(j.water).toBeLessThanOrEqual(35);
    expect(mem(r.a).travel?.kind).toBe("resource"); // still going: provisions not yet gone
  });
  it("off-screen: an empty bag travels on abstract foraging, with no journey record and no turn-back", () => {
    const r = rig();
    mem(r.a).base = { x: 0, y: 0 };
    mem(r.a).travel = { kind: "resource", x: 800, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 800, y: 0 }], items: [WOOD] };
    const start = { ...r.w.get(r.p, Transform)! };
    for (let i = 0; i < 10; i++) G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks);
    expect(mem(r.a).travel?.journey).toBeUndefined(); // nothing to run out of: no record is invented
    expect(mem(r.a).travel?.kind).toBe("resource");
    expect(r.w.get(r.p, Transform)!.x).toBeGreaterThan(start.x + 10); // ADR-343: it travels on, it does not turn back
  });
  it("full-sim: an empty bag and a low need turn the bot back toward home", () => {
    const r = rig({ x: 400, y: 0 }); r.home = { x: 0, y: 0 }; // the bot travelled 400 tiles out from home
    mem(r.a).resourceNeed = { items: [WOOD], at: 0 };
    r.w.set(r.p, G.Survival, { hunger: 20, thirst: 20 });
    mem(r.a).travel = { kind: "resource", x: 800, y: 0, since: 0, leg: 1, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 400, y: 0 }, { x: 800, y: 0 }], items: [WOOD], journey: { food: 0, water: 0, estTicks: 1000, prepared: false } };
    const c = ctxOf(r);
    expect(c.world.travel).toBeUndefined(); // this pass shows no travel: the return leg is being planned
    expect(mem(r.a).travel?.kind).toBe("return");
    expect(mem(r.a).travel).toMatchObject({ x: 0, y: 0 });
    expect(mem(r.a).journeyBlocked).toBeDefined();
  });
  it("full-sim: food in the bag, or needs still high, presses on", () => {
    const r = rig({ x: 400, y: 0 });
    mem(r.a).resourceNeed = { items: [WOOD], at: 0 };
    r.w.set(r.p, G.Survival, { hunger: 20, thirst: 20 });
    G.addItem(r.w, r.p, COOKED_MEAT, 2); G.addItem(r.w, r.p, WATER_FLASK, 1);
    mem(r.a).travel = { kind: "resource", x: 800, y: 0, since: 0, leg: 1, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 400, y: 0 }, { x: 800, y: 0 }], items: [WOOD], journey: { food: 60, water: 35, estTicks: 1000, prepared: true } };
    const c = ctxOf(r);
    expect(c.world.travel?.kind).toBe("resource"); // carries food and water: no turn-back
    expect(J.shouldTurnBack(0, 0, 80, 80)).toBe(false); // empty bag but needs high: presses on (forage en route)
    expect(J.shouldTurnBack(0, 1, 20, 80)).toBe(true); // no food and hungry: turns back
    expect(J.shouldTurnBack(1, 0, 80, 20)).toBe(true); // no water and thirsty: turns back
  });
  it("provisionsExhausted: only a carried provision running out turns the bot back", () => {
    expect(J.provisionsExhausted({ food: 1, water: 100 }, { food: 0, water: 99 })).toBe(true); // food ran out
    expect(J.provisionsExhausted({ food: 100, water: 1 }, { food: 99, water: 0 })).toBe(true); // water ran out
    expect(J.provisionsExhausted({ food: 10, water: 10 }, { food: 9, water: 9 })).toBe(false); // still carrying
    expect(J.provisionsExhausted({ food: 0, water: 100 }, { food: -1, water: 99 })).toBe(false); // food was never carried
    expect(J.provisionsExhausted({ food: 0, water: 0 }, { food: -1, water: -1 })).toBe(false); // nothing carried: a 0/0 record never turns back
  });
});

describe("ADR-344 hired workers pack from the employer's storage only", () => {
  let hid = 9300;
  function workerRig(): Rig & { boss: Entity; box: Entity } {
    const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const boss = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
    if (!w.has(boss, PlayerId)) w.add(boss, PlayerId, { id: 7 }); else w.set(boss, PlayerId, { id: 7 });
    w.add(boss, NetId, { id: ++hid });
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 55 });
    if (!w.has(p, PlayerId)) w.add(p, PlayerId, { id: 55 }); else w.set(p, PlayerId, { id: 55 });
    w.add(p, NetId, { id: ++hid });
    w.add(p, G.Worker, { owner: 7, homeX: 0, homeY: 0, job: G.WorkerJob.Gather } as never);
    const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
    ensureClaim(w, boss, 0, 0);
    const def = D.pieces.get(D.pieceId("basic_storage_box"))!;
    const sn = G.snapPlacement(w, { piece: def.id, x: 3.5, y: 1.6, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (typeof sn === "number") throw new Error(`employer box snap failed: ${sn}`);
    const box = G.placePiece(w, boss, sn, { pay: false });
    steps(w, 25);
    return { w, p, a, home: { x: 0, y: 0 }, boss, box };
  }
  const wctx = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
  it("a sent worker's pack comes from the employer's box", () => {
    const r = workerRig();
    stock(r, r.box, [["cooked_meat", 6], ["water_flask", 4]]);
    fed(r);
    G.orderTravel(r.a, 800, 0, r.w.tick);
    const c = wctx(r);
    expect(c.world.travel?.kind).toBe("sent");
    expect(c.world.travel?.route).toBeDefined();
    expect(c.world.journeyPrep).toBeDefined();
    expect(c.world.journeyPrep!.box.id).toBe(r.box);
    expect(c.world.journeyPrep!.items).toEqual(expect.arrayContaining([{ item: COOKED_MEAT, count: 1 }, { item: WATER_FLASK, count: 2 }]));
  });
  it("a stranger's full box is never touched, even beside an empty employer box", () => {
    const r = workerRig();
    fed(r);
    // a stranger's box, full of food, under another claim far away (claims cannot overlap the employer's)
    const q = spawnLearned(r.w, { x: 60, y: 60, maxWeight: 0, clientId: 99 });
    if (!r.w.has(q, PlayerId)) r.w.add(q, PlayerId, { id: 99 }); else r.w.set(q, PlayerId, { id: 99 });
    plantClaim(r.w, q, 60, 60);
    const def = D.pieces.get(D.pieceId("basic_storage_box"))!;
    const sn = G.snapPlacement(r.w, { piece: def.id, x: 63.5, y: 61.6, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (typeof sn === "number") throw new Error(`stranger box snap failed: ${sn}`);
    const strangerBox = G.placePiece(r.w, q, sn, { pay: false });
    steps(r.w, 25);
    stock(r, strangerBox, [["cooked_meat", 6], ["water_flask", 4]]);
    // the permission rule itself: the hired worker may not take from the stranger's box
    expect(G.mayTakeFromStorageAt(r.w, r.p, { piece: strangerBox, x: 63.5, y: 61.6 }, { x: 0, y: 0 })).toBe(false);
    G.orderTravel(r.a, 800, 0, r.w.tick);
    const c = wctx(r);
    expect(c.world.travel?.kind).toBe("sent");
    expect(c.world.journeyPrep?.box.id).not.toBe(strangerBox);
    expect(boxCount(r, strangerBox, "cooked_meat")).toBe(6);
    expect(boxCount(r, strangerBox, "water_flask")).toBe(4);
    expect(mem(r.a).travel?.journey?.prepared).toBe(false); // employer's box is empty: leaves bag-only
  });
});
