import { describe, expect, it } from "vitest";
import { CommandRegistry, World } from "@engine/core";
import {
  AttackCmd, capFor, chunkTarget, entriesForMode, GameplayActions, GatherCmd, intentSequence, intentToFrame, jitterAim, loadPopulationData,
  phaseMultiplier, PlaceCmd, populationData, QueueCraftCmd, registerGameplayCommands, resolveBehavior, rollTraits, routineActivity,
  scoreUtilities, validateAiData, validateBotData, validateSpawnData, type SpawnData, type AiData, type BotData,
} from "../src/index.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("population data", () => {
  const { spawns, ai, bots } = populationData();
  it("shipped data validates", () => {
    expect(validateAiData(ai)).toEqual([]); expect(validateSpawnData(spawns, ai)).toEqual([]); expect(validateBotData(bots, ai)).toEqual([]);
  });
  it("covers zombies, the animals (art keys) and five human archetypes", () => {
    expect(spawns.tables.zombies.map((e) => e.kind)).toEqual(["zombie_walker", "zombie_runner", "zombie_brute", "zombie_snuffer"]);
    expect(spawns.tables.animals.map((e) => e.kind)).toEqual(["animal_rabbit", "animal_deer", "animal_boar", "animal_wolf", "animal_chicken", "animal_stag", "animal_red_deer", "animal_elk", "animal_moose", "animal_bear", "animal_fox", "animal_hare", "animal_squirrel", "animal_turkey", "animal_duck", "animal_goose", "animal_goat", "animal_sheep", "animal_cow", "animal_bison", "animal_snake", /* ADR-145 pets */ "animal_dog_dachshund", "animal_dog_lab", "animal_dog_husky", "animal_dog_shepherd", "animal_dog_beagle", "animal_cat_tabby", "animal_cat_siamese", "animal_cat_black", "animal_parrot", "animal_crow", "animal_ferret", /* Task 32 */ "animal_owl", "animal_turtle", "animal_pig", "animal_alpaca", "animal_bee", /* ADR-319 */ "animal_horse", "animal_donkey", "animal_yak"]); // ADR-110 appended 16
    expect(Object.values(bots.archetypes).map((b) => b.role)).toEqual(["gatherer", "builder", "trader", "raider", "loner"]);
  });
  it("reuses zombies.json stats and phase rates", () => {
    const w = resolveBehavior("zombie_walker"); expect(w.hp).toBe(60); expect(w.attack?.structureDamage).toBe(14);
    const walker = spawns.tables.zombies[0]!;
    expect(phaseMultiplier(walker, "night")).toBe(1); expect(phaseMultiplier(walker, "day")).toBeLessThan(0.1);
    expect(phaseMultiplier(spawns.tables.zombies[2]!, "dawn")).toBe(0); // brute weight 0 at dawn
  });
  it("chunk targets honor biome, night weighting, mode and caps", () => {
    const wolf = spawns.tables.animals.find((e) => e.kind === "animal_wolf")!;
    expect(chunkTarget(wolf, 4, "night", "sp")).toBeGreaterThan(chunkTarget(wolf, 4, "day", "sp"));
    expect(chunkTarget(wolf, 1, "night", "sp")).toBe(0); // water
    const g = spawns.tables.humans[0]!;
    expect(chunkTarget(g, 3, "day", "sp")).toBeGreaterThan(0); expect(chunkTarget(g, 3, "day", "mp")).toBe(0);
    expect(entriesForMode("mp").some((x) => x.category === "humans")).toBe(false);
    expect(capFor(wolf, "mp").global).toBe(15);
  });
  it("rejects bad spawn data", () => {
    const d = clone(spawns) as SpawnData;
    d.tables.humans[0]!.modes.mp = true; d.tables.animals[0]!.biomeWeights = { lava: 1 }; d.tables.animals[1]!.group = [3, 1];
    d.tables.animals[2]!.kind = "dragon";
    const e = validateSpawnData(d, ai).join("\n");
    expect(e).toMatch(/disabled in mp/); expect(e).toMatch(/unknown biome lava/); expect(e).toMatch(/animal_deer: group/); expect(e).toMatch(/dragon: no behavior/); expect(e).toMatch(/dragon: animal kinds must match art keys/);
    expect(() => loadPopulationData({ spawns: d })).toThrow(/spawns.json invalid/);
  });
  it("rejects bad behavior data", () => {
    const d = clone(ai) as AiData;
    d.archetypes.animal_wolf!.attack = null; d.archetypes.animal_rabbit!.loot[0]!.item = "unobtainium"; d.archetypes.animal_deer!.flee.hpFrac = 2;
    const e = validateAiData(d).join("\n");
    expect(e).toMatch(/animal_wolf: aggressive archetype needs attack/); expect(e).toMatch(/unknown loot item unobtainium/); expect(e).toMatch(/animal_deer: flee/);
  });
  it("rejects bad bot data", () => {
    const d = clone(bots) as BotData; const g = d.archetypes.bot_gatherer!;
    g.goals.food = 0.9; g.traits.bravery = [0.8, 0.2]; delete g.chat.hungry; g.utility.dance = { base: 1, inputs: {} };
    d.routines.worker = d.routines.worker!.slice(1);
    const e = validateBotData(d, ai).join("\n");
    for (const re of [/sum to 1/, /trait bravery/, /chat hungry/, /unknown utility action dance/, /routine worker: must cover/, /trait bravery/]) expect(e).toMatch(re);
  });
  it("routines, traits and utility scoring", () => {
    expect(routineActivity("bot_raider", "night")).toBe("fight"); expect(routineActivity("bot_gatherer", "day")).toBe("gather");
    const rng = new World().rngFor("bot"); const rand = (): number => rng.next();
    const t = rollTraits("bot_trader", rand);
    expect(t.greed!).toBeGreaterThanOrEqual(0.6); expect(t.greed!).toBeLessThanOrEqual(0.95);
    const calm = scoreUtilities("bot_gatherer", { ...t, invSpaceFree: 1 }), danger = scoreUtilities("bot_gatherer", { ...t, enemyNear: 1, lowHealth: 1, bravery: 0 });
    expect(Object.entries(calm).sort((a, b) => b[1] - a[1])[0]![0]).toBe("gather");
    expect(danger.flee!).toBeGreaterThan(danger.gather!);
    for (const b of Object.values(bots.archetypes)) for (const lines of Object.values(b.chat)) for (const l of lines) expect(l).toMatch(/^bot\./);
  });
});

describe("bot intents -> InputFrame", () => {
  const reg = registerGameplayCommands();
  it("move sets analog + digital bits and aims along movement", () => {
    const f = intentToFrame({ kind: "move", dx: 3, dy: -3, sprint: true }, 7, reg);
    expect(f.tick).toBe(7); expect(f.actions & GameplayActions.MoveRight).toBeTruthy(); expect(f.actions & GameplayActions.MoveUp).toBeTruthy();
    expect(f.actions & GameplayActions.Sprint).toBeTruthy(); expect(f.moveX).toBeCloseTo(Math.SQRT1_2); expect(f.aimY).toBeCloseTo(-Math.SQRT1_2);
  });
  it("uses the player commands", () => {
    expect(intentToFrame({ kind: "gather", target: 5 }, 0, reg).commands[0]).toEqual(reg.make(GatherCmd, { target: 5 }));
    expect(intentToFrame({ kind: "attack", target: 9 }, 0, reg).commands[0]!.type).toBe(reg.idOf(AttackCmd));
    expect(intentToFrame({ kind: "craft", recipe: 2, count: 3 }, 0, reg).commands[0]!.type).toBe(reg.idOf(QueueCraftCmd));
    const b = intentToFrame({ kind: "build", piece: 1, x: 2, y: 3 }, 0, reg);
    expect(b.commands[0]!.type).toBe(reg.idOf(PlaceCmd)); expect(b.actions & GameplayActions.Build).toBeTruthy();
  });
  it("skips commands the registry lacks", () => { expect(intentToFrame({ kind: "gather", target: 1 }, 0, new CommandRegistry()).commands).toEqual([]); });
  it("sequence applies reaction delay; aim jitter stays within error", () => {
    const seq = intentSequence([{ kind: "attack", target: 1 }], 10, reg, 3);
    expect(seq.map((f) => f.tick)).toEqual([10, 11, 12, 13]); expect(seq.slice(0, 3).every((f) => f.commands.length === 0)).toBe(true);
    const j = jitterAim(1, 0, (10 * Math.PI) / 180, () => 1); expect(Math.atan2(j.y, j.x) * 180 / Math.PI).toBeCloseTo(10);
  });
});
