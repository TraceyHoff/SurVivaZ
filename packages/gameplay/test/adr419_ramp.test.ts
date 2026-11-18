// ADR-419: the ramp tool — one gameplay.terrainRamp command grades a ±1 staircase
// (foot + direction + height change) for players and AI humans, so a >= 2-level step
// becomes walkable without touching movement physics (1-level steps were already walkable).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandRegistry, CommandRejected, installCommandHandlers, Transform } from "@engine/core";
import { TileMap, WATER_TILE, classifyGroundShape, type GroundNeighbourhood } from "@engine/world";
import * as G from "../src/index.js";
import { findRampOnRoute, nextRampWork, planRampPlan } from "../src/ai/terrain_base.js";
import { aiMemoryOf, makePlan } from "../src/ai/planner.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const root = join(__dirname, "../../..");
/** A flat grass field (tile 3, height `h`) wired in as the world's terrain (cf. task36). */
function field(w: ReturnType<typeof makeWorld>, h = 2, x0 = -16, x1 = 47, y0 = -16, y1 = 47): TileMap {
  const map = new TileMap();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, h); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); return map;
}
const hold = (w: ReturnType<typeof makeWorld>, p: number, key: string): void => {
  if (!G.countItem(w, p as never, id(key))) G.addItem(w, p as never, id(key), 1);
  let slot = 0; while (G.slotItem(w, p as never, slot).item !== id(key)) slot++;
  w.set(p as never, G.Equipment, { mainHandSlot: slot, mainHandItem: id(key) });
};
const hAt = (w: ReturnType<typeof makeWorld>, x: number, y: number): number => w.resource(G.TerrainRes).heightAt(x, y);
const nbAt = (w: ReturnType<typeof makeWorld>, x: number, y: number): GroundNeighbourhood => ({
  h: hAt(w, x, y),
  edge: [hAt(w, x + 1, y), hAt(w, x - 1, y), hAt(w, x, y + 1), hAt(w, x, y - 1)],
  diag: [hAt(w, x + 1, y - 1), hAt(w, x + 1, y + 1), hAt(w, x - 1, y + 1), hAt(w, x - 1, y - 1)],
});

describe("ADR-419 ramp planning (pure)", () => {
  it("an up-ramp on flat ground: tiles rise 1 level each, cost 1+2+3 soil, round-robin order", () => {
    const w = makeWorld(); field(w, 2);
    const r = G.planRamp(w, 0, 0, 1, 0, 3);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.plan.edits).toEqual([
      { x: 1, y: 0, dir: 1 }, { x: 2, y: 0, dir: 1 }, { x: 3, y: 0, dir: 1 },
      { x: 2, y: 0, dir: 1 }, { x: 3, y: 0, dir: 1 }, { x: 3, y: 0, dir: 1 },
    ]); // level 1 of every tile, then level 2, then level 3 — no intermediate cliff
    expect(r.plan.soilNeeded).toBe(6); expect(r.plan.soilYielded).toBe(0);
    // The foot tile is unchanged; the graded tiles are the next |delta| along the axis.
    expect(r.plan.edits.every((e) => e.x >= 1 && e.x <= 3 && e.y === 0)).toBe(true);
  });

  it("a down-ramp cuts into a plateau: the high side is dug down to the staircase, yielding soil", () => {
    const w = makeWorld(); field(w, 2);
    for (let x = 1; x <= 6; x++) G.setTerrainDig(w, x, 0, 3); // plateau at 5, foot at 2
    expect(hAt(w, 1, 0)).toBe(5);
    const r = G.planRamp(w, 0, 0, 1, 0, 3);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.plan.edits).toEqual([{ x: 1, y: 0, dir: -1 }, { x: 2, y: 0, dir: -1 }, { x: 1, y: 0, dir: -1 }]);
    expect(r.plan.soilNeeded).toBe(0); expect(r.plan.soilYielded).toBe(3);
  });

  it("rejects a zero delta, a diagonal direction, and |delta| > 16 as bad tile / limit", () => {
    const w = makeWorld(); field(w, 2);
    expect(G.planRamp(w, 0, 0, 1, 0, 0)).toEqual({ ok: false, fail: G.TerrainFail.BadTile });
    expect(G.planRamp(w, 0, 0, 1, 1, 3)).toEqual({ ok: false, fail: G.TerrainFail.BadTile });
    expect(G.planRamp(w, 0, 0, 0, 0, 3)).toEqual({ ok: false, fail: G.TerrainFail.BadTile });
    expect(G.planRamp(w, 0, 0, 1, 0, 17)).toEqual({ ok: false, fail: G.TerrainFail.Limit });
    expect(G.planRamp(w, 0, 0, 0, -1, -12).ok).toBe(true); // 1+..+12 = 78 edits, under the 96 cap
    expect(G.planRamp(w, 0, 0, 0, -1, -16)).toEqual({ ok: false, fail: G.TerrainFail.Limit }); // 136 edits > 96
  });

  it("an already-graded ramp plans nothing (BadTile), and a ramp past the -300/326 bounds is a Limit", () => {
    const w = makeWorld(); field(w, 2);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 6);
    const r = G.planRamp(w, 0, 0, 1, 0, 3); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.None);
    expect(G.planRamp(w, 0, 0, 1, 0, 3)).toEqual({ ok: false, fail: G.TerrainFail.BadTile });
    G.setTerrainDig(w, 0, 0, 324); // foot at 326: any up-ramp exceeds the ceiling
    expect(G.planRamp(w, 0, 0, 1, 0, 1)).toEqual({ ok: false, fail: G.TerrainFail.Limit });
  });
});

describe("ADR-419 ramp grading (world)", () => {
  it("grades an up-ramp: heights 2,3,4,5, foot unchanged, 6 soil spent, no 2+ drop on the graded axis", () => {
    const w = makeWorld(); field(w, 2);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 6);
    const r = G.planRamp(w, 0, 0, 1, 0, 3); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, p, r.plan, true)).toBe(G.TerrainFail.None); // dry run changes nothing
    expect(hAt(w, 1, 0)).toBe(2); expect(G.countItem(w, p, id("soil"))).toBe(6);
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.None);
    expect([hAt(w, 0, 0), hAt(w, 1, 0), hAt(w, 2, 0), hAt(w, 3, 0)]).toEqual([2, 3, 4, 5]);
    expect(G.countItem(w, p, id("soil"))).toBe(0);
    // Every graded tile's downhill axis edge drops exactly 1 (the ADR-409 ramp shape on the graded axis).
    for (const x of [1, 2, 3]) {
      const s = classifyGroundShape(nbAt(w, x, 0));
      expect(s.edgeDrops[1], `tile ${x}`).toBe(1); // -x edge: one level down toward the foot
    }
    // The +x edge of the middle tiles is uphill (no drop); the top tile ends in a 3-level ledge
    // onto the flat field — a ramp ends where the ground does, it does not flatten the world beyond it.
    expect(classifyGroundShape(nbAt(w, 1, 0)).edgeDrops[0]).toBe(0);
    expect(classifyGroundShape(nbAt(w, 2, 0)).edgeDrops[0]).toBe(0);
    expect(classifyGroundShape(nbAt(w, 3, 0)).edgeDrops[0]).toBe(3);
  });

  it("grades past shovel reach: only the foot tile must be in reach (a 6-tile ramp from where you stand)", () => {
    const w = makeWorld(); field(w, 2);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 21);
    expect(G.editTerrain(w, p, 6, 0, 1)).toBe(G.TerrainFail.TooFar); // a single edit that far is refused
    const r = G.planRamp(w, 0, 0, 1, 0, 6); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.None);
    expect([1, 2, 3, 4, 5, 6].map((x) => hAt(w, x, 0))).toEqual([3, 4, 5, 6, 7, 8]);
    expect(G.countItem(w, p, id("soil"))).toBe(0); // 1+2+3+4+5+6 = 21
  });

  it("refuses without a shovel, without enough soil, and with a foot out of reach — and previews never mutate", () => {
    const w = makeWorld(); field(w, 2);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
    const r = G.planRamp(w, 0, 0, 1, 0, 3); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, p, r.plan, true)).toBe(G.TerrainFail.NoShovel);
    hold(w, p, "stone_shovel");
    expect(G.gradeRamp(w, p, r.plan, true)).toBe(G.TerrainFail.NoSoil);
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.NoSoil);
    G.addItem(w, p, id("soil"), 5); // one short of the 6 needed: the total is checked up front, not per edit
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.NoSoil);
    expect(hAt(w, 1, 0)).toBe(2); expect(G.countItem(w, p, id("soil"))).toBe(5);
    const far = G.planRamp(w, 9, 9, 1, 0, 3); expect(far.ok).toBe(true); if (!far.ok) return;
    G.addItem(w, p, id("soil"), 1);
    expect(G.gradeRamp(w, p, far.plan)).toBe(G.TerrainFail.TooFar);
  });

  it("water: an up-ramp over water fills it first (one extra edit); a down-ramp into water is refused", () => {
    const w = makeWorld(); const map = field(w, 2); map.setTile(2, 0, WATER_TILE); // lake bed at 2
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 4);
    const up = G.planRamp(w, 0, 0, 1, 0, 2); expect(up.ok).toBe(true); if (!up.ok) return;
    expect(up.plan.soilNeeded).toBe(4); // (1,0): +1; (2,0) water: fill + raise to 4 = 3
    expect(G.gradeRamp(w, p, up.plan)).toBe(G.TerrainFail.None);
    expect(w.resource(G.TerrainRes).tileAt(2, 0)).toBe(G.TERRAIN.earthTile); expect(hAt(w, 2, 0)).toBe(4);
    // A down-ramp into genuinely open water is refused, as with a shovel.
    map.setTile(4, 0, WATER_TILE); // fresh lake tile, bed at 2
    const down = G.planRamp(w, 3, 0, 1, 0, -3);
    expect(down.ok).toBe(false); if (down.ok) return;
    expect(down.fail).toBe(G.TerrainFail.BadTile); // digging open water is refused, as with a shovel
  });

  it("a downhill ramp near shore floods: its lowest dug tile fills, water does not climb the ramp", () => {
    const w = makeWorld(); const map = field(w, 2);
    for (let y = -4; y <= 4; y++) map.setTile(0, y, WATER_TILE); // lake column, surface 2
    const p = G.spawnPlayer(w, { x: 3.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel");
    const r = G.planRamp(w, 3, 0, -1, 0, -2); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, p, r.plan)).toBe(G.TerrainFail.None);
    expect([hAt(w, 3, 0), hAt(w, 2, 0), hAt(w, 1, 0)]).toEqual([2, 1, 0]);
    expect(G.countItem(w, p, id("soil"))).toBe(3);
    for (let s = 0; s < 5; s++) G.terrainFlowStep(w);
    const t = w.resource(G.TerrainRes);
    // Flowed water's surface is its own bed (ADR-263), so the lake wets the bed-0 tile but cannot
    // climb to the bed-1 tile: a dug ramp is a channel at its foot, not a flooded staircase.
    expect(t.tileAt(1, 0)).toBe(WATER_TILE); expect(t.tileAt(2, 0)).toBe(G.TERRAIN.earthTile); expect(hAt(w, 2, 0)).toBe(1); // dug, dry earth
    expect(t.tileAt(3, 0)).toBe(3); // the foot, at the lake surface, stays dry land
  });

  it("the command is registered, rate-limited to 2/s, bridged, and grades through the handler (rejected when poor)", () => {
    const w = makeWorld(); field(w, 2);
    const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 }); hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 6);
    const reg = G.registerGameplayCommands(new CommandRegistry());
    const h = installCommandHandlers(w, reg); G.installRampCommands(w, h);
    expect(G.RAMP_COMMANDS).toEqual([G.TerrainRampCmd]);
    expect(G.COMMAND_RATES[G.TerrainRampCmd.name]).toBe(2);
    expect(reg.def(reg.idOf(G.TerrainRampCmd))).toBe(G.TerrainRampCmd);
    const rej: string[] = []; w.events.on(CommandRejected, (e) => rej.push(e.reason));
    const run = (v: Record<string, number>): void => { h.enqueue(p, 1, 1, reg.make(G.TerrainRampCmd as never, v as never)); w.step(1 / 20); };
    run({ x: 0, y: 0, dx: 1, dy: 0, delta: 3 });
    expect(rej).toEqual([]); expect([hAt(w, 1, 0), hAt(w, 2, 0), hAt(w, 3, 0)]).toEqual([3, 4, 5]);
    run({ x: 0, y: 0, dx: 1, dy: 0, delta: 3 }); // already graded + no soil left
    expect(rej).toEqual(["bad_tile"]);
  });
});

describe("ADR-419 AI ramps", () => {
  it("findRampOnRoute spots a >= 2-level step on a frequent route; nextRampWork grades it in one step", () => {
    const w = makeWorld(); field(w, 2);
    for (let x = 5; x <= 10; x++) G.setTerrainDig(w, x, 0, 3); // plateau at 5 east of x=5
    const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
    w.add(bot, G.Worker, {} as never); G.addItem(w, bot, id("stone_shovel"), 1);
    const plan = findRampOnRoute(w, bot, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(plan).toMatchObject({ x: 4, y: 0, dx: 1, dy: 0, delta: 3 }); // foot before the cliff, cut into the plateau
    expect(planRampPlan(w, bot, 4, 0, 1, 0, 3)).toMatchObject({ x: 4, y: 0, dx: 1, dy: 0, delta: 3 });
    const work = nextRampWork(w, bot, plan!);
    expect(work).toMatchObject({ k: "ramp", x: 4, y: 0, dx: 1, dy: 0, delta: 3 }); // down-ramp: no soil to fetch first
    expect(G.actionCommand(`ramp:4:0:1:0:3`)).toEqual({ type: G.TerrainRampCmd.name, payload: { x: 4, y: 0, dx: 1, dy: 0, delta: 3 } });
    expect(G.actionCommand("ramp:4:0:1:1:3")).toBeUndefined(); // diagonal direction is not a ramp
    // Apply the step the way the bot would (walk to the stand, then one command) and the route is walkable.
    if (work && work.k === "ramp") w.set(bot, Transform, { x: work.stand.x, y: work.stand.y });
    const r = G.planRamp(w, 4, 0, 1, 0, 3); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(G.gradeRamp(w, bot, r.plan)).toBe(G.TerrainFail.None);
    expect([hAt(w, 4, 0), hAt(w, 5, 0), hAt(w, 6, 0), hAt(w, 7, 0)]).toEqual([2, 3, 4, 5]);
    expect(findRampOnRoute(w, bot, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeUndefined();
  });

  it("no ramp when the route is already walkable (all steps <= 1)", () => {
    const w = makeWorld(); field(w, 2);
    const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5 });
    expect(findRampOnRoute(w, bot, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeUndefined();
  });

  it("an up-ramp bot quarries its own soil first (ramp-sized quarry, not the 12-soil pad cap)", () => {
    const w = makeWorld(); field(w, 2);
    const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
    w.add(bot, G.Worker, {} as never); G.addItem(w, bot, id("stone_shovel"), 1);
    const plan = planRampPlan(w, bot, 0, 0, 1, 0, 3)!; // 6 soil needed, bag empty
    const work = nextRampWork(w, bot, plan);
    expect(work?.k).toBe("terrain"); // digs a quarry tile beside the ramp
    if (work?.k !== "terrain") return;
    expect(work.dir).toBe(-1);
    expect(G.editTerrain(w, bot, work.x, work.y, -1)).toBe(G.TerrainFail.None);
    expect(G.countItem(w, bot, id("soil"))).toBe(1);
  });

  it("the planner emits a ramp step for a stored ramp plan (earlier ladder goals snoozed)", () => {
    const w = makeWorld(); field(w, 2);
    const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
    w.add(bot, G.Worker, {} as never); G.addItem(w, bot, id("stone_shovel"), 1);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1);
    const ramp = planRampPlan(w, bot, 4, 0, 1, 0, 3, { x: 10, y: 0 }); expect(ramp).toBeDefined();
    aiMemoryOf(a).ramp = ramp!;
    for (let x = 5; x <= 10; x++) G.setTerrainDig(w, x, 0, 3);
    const tick = w.tick + 1000;
    const snooze: Record<string, number> = {};
    for (const g of ["axe", "pickaxe", "campfire", "basic_storage_box", "wood", "workbench", "wear:torch", "earthworks"]) snooze[g] = tick;
    const plan = makePlan({ ramp: ramp!, world: w, self: bot, defs: d, fails: {}, snooze });
    expect(plan.goal).toBe("ramp");
    expect(plan.step).toMatchObject({ k: "ramp", x: 4, y: 0, dx: 1, dy: 0, delta: 3 });
  });
});

describe("ADR-419 client wiring (bindings + bridging)", () => {
  it("Terrain.Ramp is bound on keyboard (T) and gamepad (LT + Y), and the action exists", () => {
    const kb = JSON.parse(readFileSync(join(root, "packages/input/profiles/keyboardMouse.json"), "utf8"));
    const pad = JSON.parse(readFileSync(join(root, "packages/input/profiles/gamepad.json"), "utf8"));
    expect(kb.bindings.Gameplay).toContainEqual({ action: "Terrain.Ramp", control: "key.KeyT" });
    expect(pad.bindings.Gameplay).toContainEqual({ action: "Terrain.Ramp", control: "pad.y", modifiers: ["pad.lt"] });
    expect(readFileSync(join(root, "packages/input/src/defaults.ts"), "utf8")).toContain(`btn("Terrain.Ramp")`);
    // Touch has no profile binding for terrain: the HUD Ramp button covers it (world-tools.ts).
    expect(readFileSync(join(root, "apps/client/src/world-tools.ts"), "utf8")).toContain("TerrainRampCmd");
  });
});
