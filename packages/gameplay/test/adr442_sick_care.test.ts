// ADR-442: sick bots seek care and rest — a cold/flu bot heads to a lit fire with food and water and
// rests until the 240 s care cure completes, instead of gathering / working its hire job / travelling
// while infectious (and spreading it to bots working shoulder-to-shoulder). The care-cure rules
// (240 s, any break resets) and transmission rules are unchanged — this slice only changes what the
// bot DOES while sick.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, setTimeOfDay, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const SEC = 20;
let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; boss: Entity; bot: Entity; a: Agent; ctl: ReturnType<typeof G.survivorController>; home: { x: number; y: number } }
/** Hired Farm bot at (0,0) with a lit campfire at (5,0), a wild carrot to harvest at (-5,0), and
 * berries + a water flask in the bag. Summer noon, so the four care conditions can hold by the fire.
 * Job None = truly unhired (no Worker component): the planner still wants wood, so it gathers. */
function rig(job: number): Rig {
  const w = makeWorld(); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  setTimeOfDay(w, 12);
  const boss = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, boss, 7); net(w, boss);
  const bot = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 55 }); pid(w, bot, 55); net(w, bot);
  if (job !== G.WorkerJob.None) w.add(bot, G.Worker, { owner: 7, homeX: 0, homeY: 0, job } as never);
  w.set(bot, G.Survival, { hunger: 100, thirst: 100 });
  G.spawnStation(w, G.StationKind.Campfire, 5, 0); // lit by default
  G.spawnResourceNode(w, "wild_carrot", -5, 0);
  G.addItem(w, bot, d.itemId("berries"), 3);
  G.addItem(w, bot, d.itemId("water_flask"), 1);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  a.bb.set("greetedAt", 0); // the boss stands on the bot: greet would otherwise win one think tick
  // the controller's random idle pause (0.4%/tick, 10-40 ticks) stalls the walk and drops the
  // behaviour-switch chat when it lands on the switch tick — deterministic for this seed, so the
  // walk / chat assertions disable it; the behaviour under test is unchanged
  a.imperfect.idlePauseChance = 0;
  const ctl = G.survivorController({ seed: 1 }); ctl.add(a);
  return { w, boss, bot, a, ctl, home: { x: 0, y: 0 } };
}
const sicken = (r: Rig, key = "common_cold"): void => { expect(G.contractDisease(r.w, r.bot, key)).toBe(true); };
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.bot, r.a, r.home)!.world;
const ctxOf = (r: Rig): AgentContext<G.AgentWorldView> => { const v = G.buildAgentView(r.w, r.bot, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
/** Drive the controller `n` ticks, applying movement to the bot like a host would (3 tiles/s), and
 * record the current behaviour each tick (tick 0 is the first switch, so assertions skip it). */
const drive = (r: Rig, n: number): { outs: AgentOutput[]; currents: (string | undefined)[] } => {
  const outs: AgentOutput[] = []; const currents: (string | undefined)[] = [];
  for (let t = 0; t < n; t++) {
    const o = r.ctl.tick(t, () => G.buildAgentView(r.w, r.bot, r.a, r.home))!.get(r.a)!;
    outs.push(o); currents.push(r.a.current);
    const tr = r.w.get(r.bot, Transform)!;
    const len = Math.hypot(o.moveX, o.moveY);
    if (len > 0.01) r.w.set(r.bot, Transform, { x: tr.x + (o.moveX / len) * 0.15, y: tr.y + (o.moveY / len) * 0.15 });
  }
  return { outs, currents };
};
const out = (): AgentOutput => ({ ...idleOutput(), actions: [] as string[] });

describe("ADR-442 sick bots seek care and rest", () => {
  it("the sensor reports a sick bot's care target: the lit fire, what is still missing, time left", () => {
    const r = rig(G.WorkerJob.Farm);
    expect(viewOf(r).sickCare).toBeUndefined(); // healthy: no care target
    sicken(r);
    const sc = viewOf(r).sickCare;
    expect(sc).toBeDefined();
    expect(sc!.fire).toMatchObject({ x: 5, y: 0 }); // the lit campfire, not the carrot patch
    expect(sc!.missing).toEqual([]); // dry, fed, hydrated, warm already hold at summer noon
    expect(sc!.secondsLeft).toBeGreaterThan(200); // a fresh cold owes (nearly) the full 240 s
  });

  it("a sick hired Farm bot stops working and walks to the fire instead of the harvest target", () => {
    const r = rig(G.WorkerJob.Farm);
    expect(viewOf(r).farm?.harvest).toBeDefined(); // precondition: there IS farm work to abandon
    sicken(r);
    const { outs, currents } = drive(r, 100); // the pathfinder winds around the terrain: 40 ticks is not enough to arrive
    expect(currents.slice(1).every((c) => c === "seek_care")).toBe(true);
    const at = r.w.get(r.bot, Transform)!;
    expect(at.x).toBeGreaterThan(0); // net displacement is toward the fire (+x), not the carrot patch (-x)
    expect(Math.hypot(at.x - 5, at.y - 0)).toBeLessThan(2); // arrived at the fire
    expect(outs.some((o) => o.actions.includes("gather"))).toBe(false); // never worked while sick
  });

  it("a sick unhired bot stops gathering and seeks care too", () => {
    const r = rig(G.WorkerJob.None); // unhired: the planner still wants wood, so it would gather
    sicken(r);
    const { currents } = drive(r, 40);
    expect(currents.slice(1).every((c) => c === "seek_care")).toBe(true);
  });

  it("a sick Follow bot rests instead of shadowing its owner", () => {
    const r = rig(G.WorkerJob.Follow);
    sicken(r);
    const { currents } = drive(r, 40);
    expect(currents.slice(1).every((c) => c === "seek_care")).toBe(true);
  });

  it("a zombie on top of the bot still wins: flee beats resting", () => {
    const r = rig(G.WorkerJob.Farm);
    sicken(r);
    const z = G.spawnZombie(r.w, "zombie_walker", 1, 0);
    r.a.memory.see({ id: z, kind: "zombie", x: 1, y: 0, tick: 0 });
    // the think itself picks flee: seek_care's calm gate zeroes it while a zombie is remembered
    expect(r.ctl.think(r.a, ctxOf(r))).toBe("flee");
    // ... and the driven bot actually runs away from the zombie, not toward the fire
    let fled = false;
    for (let t = 0; t < 15; t++) {
      r.a.memory.see({ id: z, kind: "zombie", x: 1, y: 0, tick: t });
      const o = r.ctl.tick(t, () => G.buildAgentView(r.w, r.bot, r.a, r.home))!.get(r.a)!;
      if (r.a.current === "flee" && o.moveX < 0) fled = true;
    }
    expect(fled).toBe(true);
  });

  it("resting by the fire completes the care cure, and the bot goes back to work after", () => {
    const r = rig(G.WorkerJob.Farm);
    sicken(r);
    // walk to the fire first (the behaviour), then bank all but 5 s of care and rest there
    const walked = drive(r, 100);
    expect(walked.currents.slice(1).every((c) => c === "seek_care")).toBe(true);
    const at = r.w.get(r.bot, Transform)!;
    expect(Math.hypot(at.x - 5, at.y - 0)).toBeLessThan(2);
    r.w.setField(r.bot, G.Diseases, "careTicks", 4700); // 235 s banked
    steps(r.w, 6 * SEC); // +6 s of care by the fire = 241 s: cured, inside the 300 s flu window
    expect(G.hasDisease(r.w, r.bot, "common_cold")).toBe(false);
    expect(G.hasDisease(r.w, r.bot, "influenza")).toBe(false);
    expect(viewOf(r).sickCare).toBeUndefined(); // no longer sick: no care target
    const back = drive(r, 40);
    // the switch off seek_care takes the controller's reaction delay (4-12 ticks), so assert past it
    expect(back.currents.slice(15).every((c) => c === "work_farm")).toBe(true); // cured: back on the job
  });

  it("the owner can see why: seek_care announces itself on the existing bot chat channel", () => {
    const r = rig(G.WorkerJob.Farm);
    sicken(r);
    const b = G.survivorRegistry().list().find((x) => x.name === "seek_care")!;
    expect(b.chatOnStart).toBe("sick_rest");
    const lines = (G.AGENTS_DATA.chat as Record<string, string[]>)["sick_rest"];
    expect(lines?.length).toBeGreaterThan(0);
    expect(lines!.some((l) => /fire|rest|sick|cold|rough/i.test(l))).toBe(true);
    // end to end: the controller actually emits the line when the behaviour starts
    r.a.identity.traits.chattiness = 1; r.a.lastChatTick = -1e9;
    let said: string | undefined;
    for (let t = 0; t < 40 && !said; t++) {
      const o = r.ctl.tick(t, () => G.buildAgentView(r.w, r.bot, r.a, r.home))!.get(r.a)!;
      said = o.chat?.text;
    }
    expect(said).toBeDefined();
    expect(lines!).toContain(said);
  });

  it("a healthy hired Farm bot is untouched: no care target, still farms", () => {
    const r = rig(G.WorkerJob.Farm);
    expect(viewOf(r).farm?.harvest).toBeDefined();
    const { currents } = drive(r, 100);
    expect(currents.slice(1, 25).every((c) => c === "work_farm")).toBe(true); // before arrival at the carrot
    const at = r.w.get(r.bot, Transform)!;
    expect(Math.hypot(at.x + 5, at.y - 0)).toBeLessThan(2); // arrived at the carrot patch (-x)
    expect(viewOf(r).sickCare).toBeUndefined();
  });

  it("no lit fire nearby: the sick bot still rests at home instead of working", () => {
    const r = rig(G.WorkerJob.Farm);
    // snuff the only fire: no lit campfire within reach any more
    for (const f of r.w.query([G.Fuel])) r.w.set(f, G.Fuel, { lit: 0 });
    sicken(r);
    const { currents } = drive(r, 40);
    expect(currents.slice(1).every((c) => c === "seek_care")).toBe(true); // rests at home; still not working
    expect(viewOf(r).sickCare?.fire).toBeUndefined();
  });

  it("the registry carries seek_care and the behaviour scores while sick", () => {
    expect(G.survivorRegistry().list().map((b) => b.name)).toContain("seek_care");
    const r = rig(G.WorkerJob.Farm);
    sicken(r);
    const c = ctxOf(r);
    const b = G.sickCareBehaviors()[0]!;
    expect(b.considerations.every((k) => k.input(c) >= 0.5)).toBe(true);
    const o = out();
    b.run(c, o);
    expect(o.moveX).toBeGreaterThan(0); // heads for the fire at (5,0)
  });
});
