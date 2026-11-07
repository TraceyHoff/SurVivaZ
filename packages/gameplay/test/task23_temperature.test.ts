/**
 * Task 23: seasonal temperatures (summer 70-88F, fall 36-69F, winter 0-35F; heat waves 89-100F, damage >= 90F;
 * rain cooler than the season average; snow only below freezing), clothing insulation tiers, the live character
 * sheet, indoor temperature on the gauge, and farm-worker tilling.
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, seasonFromDays, setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps, DT } from "./helpers.js";
import { ambientTemperature, seasonalBaseTemp, seasonalTemperature, shelteredAirTemp, snowAllowed } from "../src/systems/environment.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);
const env = d.environment; const st = env.seasons!; const L = st.lengthDays;
const SEC = 20;
const slotOf = (w: World, e: Entity, item: number) => G.listSlots(w, e).find((s) => s.item === item)!.slot;
/** Seasonal temperature at `season`, hour `h`, day `day`, weather `kind` at intensity `intensity` (0 = base climate). */
const at = (season: number, h: number, day: number, kind: number, intensity = 1): number => {
  const si = seasonFromDays(season * L + 0.1, L, 0); const time = { t: h / 24, hours: h, day, tickOfDay: 0, dayLengthTicks: 72000 };
  return seasonalTemperature(env, si, time, { kind, intensity });
};
const sample = (season: number, kind: number, intensity = 1): number[] => {
  const out: number[] = []; for (let day = 0; day < 40; day++) for (let h = 0; h < 24; h++) out.push(at(season, h, day, kind, intensity));
  return out;
};
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const noon = { t: 0.5, hours: 12, day: 1, tickOfDay: 0, dayLengthTicks: 72000 };

describe("Task 23 seasonal weather temperatures", () => {
  it("heat waves run 89-100F (31.7-37.8C) in summer", () => {
    const heat = sample(0, G.WeatherKind.Heat);
    expect(Math.min(...heat)).toBeGreaterThanOrEqual(31.7 - 0.01);
    expect(Math.max(...heat)).toBeLessThanOrEqual(37.8 + 0.01);
    expect(mean(heat)).toBeGreaterThan(31.7); expect(mean(heat)).toBeLessThan(37.8);
  });
  it("rain is cooler than the season average in summer and fall", () => {
    expect(mean(sample(0, G.WeatherKind.Rain))).toBeLessThan(mean(sample(0, G.WeatherKind.Clear, 0)) - 1);
    expect(mean(sample(1, G.WeatherKind.Rain))).toBeLessThan(mean(sample(1, G.WeatherKind.Clear, 0)) - 1);
  });
  it("winter snow and blizzard temperatures stay below freezing (32F)", () => {
    expect(Math.max(...sample(2, G.WeatherKind.Snow))).toBeLessThan(0);
    expect(Math.max(...sample(2, G.WeatherKind.Blizzard))).toBeLessThan(0);
  });
});

describe("Task 23 snow only below freezing", () => {
  it("snowAllowed: deep winter yes, a warm winter biome band no", () => {
    const winter = seasonFromDays(2 * L + 0.1, L, 0);
    expect(snowAllowed(env, winter, noon)).toBe(true);
    expect(snowAllowed(env, winter, noon, 20)).toBe(false); // warm band: base temperature above freezing
    expect(seasonalBaseTemp(env, winter, noon)).toBeLessThan(0);
  });
  it("snow already falling re-rolls at once once the season warms past freezing (winter->summer blend)", () => {
    const w = makeWorld({ liveWeather: true }, 7);
    setSeason(w, 2, L - 1); setTimeOfDay(w, 12); // noon of the last winter day: into the 0.75-day blend toward spring
    w.env(Weather).kind = G.WeatherKind.Snow; w.env(Weather).intensity = 1; w.env(Weather).endsAtTick = 0;
    steps(w, 1);
    expect(G.isSnowing(w.env(Weather).kind)).toBe(false);
  });
});

describe("Task 23 heat damage at 90F+", () => {
  const heatWorld = () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    return { w, p };
  };
  it("ADR-277: heat above 90F warns first and only hurts after Overheating", () => {
    const { w, p } = heatWorld();
    const ambient = ambientTemperature(w, 0, 0);
    expect(ambient).toBeGreaterThan(G.HEAT_DAMAGE_ABOVE_C); // 32.2C = 90F; only meaningful in real heat
    const hp0 = w.get(p, G.Health)!.hp;
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(hp0);
    expect(w.get(p, G.Survival)!.bodyTemp).toBeGreaterThan(37);
    w.setField(p, G.Survival, "bodyTemp", 39);
    steps(w, SEC);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(hp0);
  });
  it("a clear summer noon (~85F) does not hurt", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 12);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Clear, intensity: 1, endsAtTick: 0xffffffff });
    const ambient = ambientTemperature(w, 0, 0);
    expect(ambient).toBeGreaterThan(25); expect(ambient).toBeLessThan(G.HEAT_DAMAGE_ABOVE_C);
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max);
  });
  it("an enclosed room protects from heat-wave damage", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    expect(ambientTemperature(w, 10.5, 10.5)).toBeGreaterThan(G.HEAT_DAMAGE_ABOVE_C);
    steps(w, 5 * SEC);
    expect(w.get(p, G.Health)!.hp).toBe(w.get(p, G.Health)!.max);
  });
});

/** A 1-tile room at (10,10): walls on all 4 edges, roof at level 1 (same builder as Task 5). */
type Ent = ReturnType<typeof G.spawnPlayer>;
function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
}
function place(w: World, b: Ent, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  const sn = snap(w, key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}
function room(w: World, b: Ent, tier = 1) {
  place(w, b, "foundation", 10.5, 10.5);
  place(w, b, "wall", 10.5, 10, { tier }); place(w, b, "wall", 10.5, 11, { tier });
  place(w, b, "wall", 10, 10.5, { tier }); place(w, b, "wall", 11, 10.5, { tier });
  place(w, b, "roof_flat", 10.5, 10.5, { level: 1, tier });
}

describe("Task 23 clothing insulation", () => {
  it("every wearable except held offhand tools has insulation", () => {
    for (const it of d.items.values()) {
      const wear = it.wear; if (!wear) continue;
      if (wear.slot === G.WearSlot.OffHand) continue; // knives, torch, lantern, candle: held tools, not clothing
      expect(wear.insulation ?? 0, it.key).toBeGreaterThan(0);
    }
  });
  it("armor insulation rises strictly with tier on every armor line", () => {
    const tiers = ["bone", "bronze", "iron", "steel", "composite"];
    for (const piece of ["helmet", "cuirass", "greaves", "boots", "gauntlets"]) {
      const vals = tiers.map((m) => d.items.get(id(`${m}_${piece}`))!.wear!.insulation!);
      for (let i = 1; i < vals.length; i++) expect(vals[i], `${piece} ${tiers[i]}`).toBeGreaterThan(vals[i - 1]!);
    }
    expect(d.items.get(id("bone_helmet"))!.wear!.insulation).toBe(0.3);
    expect(d.items.get(id("composite_cuirass"))!.wear!.insulation).toBe(2.0);
    expect(d.items.get(id("fur_coat"))!.wear!.insulation).toBe(7);
    expect(d.items.get(id("cloth_mask"))!.wear!.insulation).toBe(0.5);
  });
  it("insulation pulls felt toward comfort: a fur coat warms in the cold and shades in the heat", () => {
    const felt = (season: number, weather: number, wearKey?: string): { felt: number; ins: number } => {
      const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
      setSeason(w, season, 1.5); setTimeOfDay(w, 12);
      Object.assign(w.env(Weather), { kind: weather, intensity: 1, endsAtTick: 0xffffffff });
      if (wearKey) { G.addItem(w, p, id(wearKey), 1); G.wearSlot(w, p, slotOf(w, p, id(wearKey))); G.refreshWorn(w, p); }
      G.exposureSystem(w, DT);
      return { felt: w.getField(p, G.Exposure, "feltTemp")!, ins: w.getField(p, G.Exposure, "insulation")! };
    };
    const coldNaked = felt(2, G.WeatherKind.Clear); const coldCoat = felt(2, G.WeatherKind.Clear, "fur_coat");
    expect(coldNaked.felt).toBeLessThan(8); // genuinely cold: the test is only meaningful below the comfort band
    expect(coldCoat.ins).toBe(7);
    expect(coldCoat.felt).toBeGreaterThan(coldNaked.felt + 5); // the coat warms
    const hotNaked = felt(0, G.WeatherKind.Heat); const hotCoat = felt(0, G.WeatherKind.Heat, "fur_coat");
    expect(hotNaked.felt).toBeGreaterThan(32); // genuinely hot: above the comfort band
    expect(hotCoat.felt).toBeLessThan(hotNaked.felt - 5); // the same coat shades in a heat wave
  });
});

describe("Task 23 indoor temperature on the gauge", () => {
  it("shelteredAirTemp: inside an enclosed room it is cooler than outside in a heat wave, within the comfort band", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    const ambient = ambientTemperature(w, 10.5, 10.5);
    expect(ambient).toBeGreaterThan(32);
    const inside = shelteredAirTemp(w, 10.5, 10.5);
    expect(inside.sheltered).toBe(true); expect(inside.enclosed).toBe(true);
    expect(inside.temp).toBeLessThan(ambient - 1);
    expect(inside.temp).toBeLessThanOrEqual(32); expect(inside.temp).toBeGreaterThanOrEqual(8);
    const outside = shelteredAirTemp(w, 20, 20);
    expect(outside.sheltered).toBe(false); expect(outside.enclosed).toBe(false);
    expect(outside.temp).toBeCloseTo(ambientTemperature(w, 20, 20), 6);
  });
});

describe("Task 23 live character sheet", () => {
  const named = (w: World, x = 0, y = 0) => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); const p = G.spawnPlayer(w, { x, y }); w.add(p, PlayerId, { id: 7 }); return p; };
  const sheetFor = (w: World, p: Entity, names = new Map([[7, "Testy"]])) => G.characterSheetView({ world: w, player: p, names })!;
  it("shows live body temperature, vitals, experience and base insulation for a naked player", () => {
    const w = makeWorld(); const p = named(w);
    const s = sheetFor(w, p);
    expect(s.name).toBe("Testy");
    expect(s.health).toBe(s.maxHealth); expect(s.hunger).toBe(100); expect(s.thirst).toBe(100);
    expect(s.level).toBe(1); expect(s.xp).toBe(0); expect(s.xpNext).toBeGreaterThan(0);
    expect(s.diseases).toEqual([]);
    expect(s.insulationBase).toBe(0); expect(s.insulationClothing).toBe(0); expect(s.worn).toEqual([]);
    expect(s.seasonName).toBe("summer"); expect(s.sheltered).toBe(false);
    expect(s.indoorC).toBeCloseTo(s.ambientC, 6);
    // the body temperature tracks the player live
    w.set(p, G.Survival, { bodyTemp: 39.5 });
    expect(sheetFor(w, p).bodyTempC).toBeCloseTo(39.5, 1);
  });
  it("worn clothing adds its insulation to the sheet with a per-item breakdown", () => {
    const w = makeWorld(); const p = named(w);
    G.addItem(w, p, id("fur_coat"), 1); G.wearSlot(w, p, slotOf(w, p, id("fur_coat"))); G.refreshWorn(w, p);
    const s = sheetFor(w, p);
    expect(s.insulationBase).toBe(0);
    expect(s.insulationClothing).toBe(7);
    expect(s.worn).toMatchObject([{ name: expect.stringMatching(/Fur Coat/i), insulation: 7 }]);
  });
  it("inside a room in a heat wave the sheet reports the cooler indoor temperature", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 10.5, y: 10.5 }); room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 }); if (!w.isRegistered(PlayerId)) w.register(PlayerId); w.add(p, PlayerId, { id: 7 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: G.WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    const s = sheetFor(w, p);
    expect(s.sheltered).toBe(true); expect(s.enclosed).toBe(true);
    expect(s.indoorC).toBeLessThan(s.ambientC - 1);
  });
});

describe("Task 23 farm-worker tilling", () => {
  const pid = (w: World, e: Entity, i: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id: i }); else w.add(e, PlayerId, { id: i }); };
  const mkPlayer = (w: World, x: number, y: number, i: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: i }); pid(w, e, i); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
  const setup = () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
    const p = mkPlayer(w, 0, 0, 7); const bot = mkPlayer(w, 2, 0, 9);
    G.setAiHumanPredicate(w, (e) => e === bot);
    G.ensureWorker(w, bot);
    const giveWanted = (): number => { const item = w.get(bot, G.Worker)!.wantedItem; G.addItem(w, p, item, 1); return item; };
    giveWanted();
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm)).toBe(G.WorkerFail.None);
    return { w, p, bot };
  };
  const agentView = (w: World, bot: Entity) => {
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    return G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
  };
  const give = (w: World, e: Entity, key: string, n = 1) => G.addItem(w, e, id(key), n);

  it("with seeds and a hoe, the farm sensor picks a till target near the anchor", () => {
    const { w, bot } = setup();
    give(w, bot, "wheat_seeds", 3); give(w, bot, "hoe", 1);
    const v = agentView(w, bot);
    expect(v.world.hire?.job).toBe(G.WorkerJob.Farm);
    expect(v.world.farm?.till).toBeDefined();
    expect(v.world.farm!.till!.slot).toBe(slotOf(w, bot, id("hoe")));
    expect(v.world.farm!.till!.lack).toBeUndefined();
    expect(Math.hypot(v.world.farm!.till!.x - 0, v.world.farm!.till!.y - 0)).toBeLessThanOrEqual(12);
  });
  it("no tilling without seeds, and no tilling without a hoe (or one in base storage)", () => {
    const { w, bot } = setup();
    give(w, bot, "hoe", 1);
    expect(agentView(w, bot).world.farm?.till).toBeUndefined(); // seeds required
    const { w: w2, bot: bot2 } = setup();
    give(w2, bot2, "wheat_seeds", 3);
    expect(agentView(w2, bot2).world.farm?.till).toBeUndefined(); // hoe required
  });
  it("planting existing tilled soil comes first: no till while empty soil waits", () => {
    const { w, bot } = setup();
    give(w, bot, "wheat_seeds", 3); give(w, bot, "hoe", 1);
    const crop = G.spawnCrop(w, 3, 0, 0); // tilled, unplanted soil near the anchor
    const v = agentView(w, bot);
    expect(v.world.farm?.till).toBeUndefined();
    expect(v.world.farm?.tend?.kind).toBe("plant");
    expect(v.world.farm?.tend?.id).toBe(crop);
  });
  it("a hoe in base storage is fetched first (till target carries the lack)", () => {
    const { w, p, bot } = setup();
    give(w, bot, "wheat_seeds", 3);
    // place a basic storage box near the anchor with a hoe inside it
    const boxDef = d.pieces.get(d.pieceId("basic_storage_box"))!;
    for (const c of G.pieceCost(d, boxDef, boxDef.fixedTier)) G.addItem(w, p, c.item, c.count);
    const placed = G.tryPlace(w, p, { piece: boxDef.id, x: 3.5, y: 0.5, level: 0, rot: 0, tier: boxDef.fixedTier, variant: 0 });
    expect(placed.ok).toBe(true);
    const st2 = G.resolveAttachment(w, (placed as { piece: Entity }).piece, G.AttachKind.Storage)!;
    G.addItem(w, st2, id("hoe"), 1);
    const v = agentView(w, bot);
    expect(v.world.farm?.till).toBeDefined();
    expect(v.world.farm!.till!.slot).toBe(-1);
    expect(v.world.farm!.till!.lack).toEqual({ item: id("hoe"), count: 1 });
  });
  it("till then plant: the tilled plot becomes plantable soil and the sensor switches to planting", () => {
    const { w, bot } = setup();
    give(w, bot, "wheat_seeds", 3); give(w, bot, "hoe", 1);
    const till = agentView(w, bot).world.farm?.till;
    expect(till).toBeDefined();
    expect(G.till(w, bot, till!.x, till!.y)).toBe(G.FarmFail.None); // the bot's Use on the hoe slot
    const v = agentView(w, bot);
    expect(v.world.farm?.till).toBeUndefined();
    expect(v.world.farm?.tend?.kind).toBe("plant");
  });
});
