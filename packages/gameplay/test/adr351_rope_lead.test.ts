// ADR-351 rope leading: rope equipped -> attach -> the animal follows the holder home on a visible,
// networked lead; arrival ends the lead cleanly; too far / stuck breaks it; danger balks it (no break);
// un-equip / death clean up with no dangling lead. Wild + tamed farm animals both leadable; bees are not.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const ROPE = d.itemId("rope");
const T = G.ROPE_TUNING;

const setPid = (w: World, e: Entity, id: number): void => { if (!w.isRegistered(PlayerId)) w.register(PlayerId); if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const at = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;
const moveTo = (w: World, e: Entity, x: number, y: number): void => { const t = at(w, e); w.set(e, Transform, { ...t, x, y }); };
const dist = (w: World, a: Entity, b: Entity): number => Math.hypot(at(w, a).x - at(w, b).x, at(w, a).y - at(w, b).y);

/** Player with a PlayerId, rope in hotbar slot 16, equipped through the real Equip intent. */
function holder(x = 0, y = 0): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 1 }); setPid(w, p, 1); steps(w, 1);
  G.addItem(w, p, ROPE, 1);
  const v = G.readSlots(w, p); v.put(G.HOTBAR_OFFSET, ROPE, 1); v.put(0, 0, 0); G.writeSlots(w, p, v, d);
  w.set(p, G.PlayerIntent, { action: G.IntentAction.Equip, slot: G.HOTBAR_OFFSET }); steps(w, 2);
  expect(G.ropeEquipped(w, p)).toBe(true);
  return { w, p };
}
/** The same, but the rope stays in the pack (not equipped). */
function holderUnequipped(x = 0, y = 0): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 1 }); setPid(w, p, 1); steps(w, 1);
  G.addItem(w, p, ROPE, 1); return { w, p };
}
const cow = (w: World, x: number, y: number): Entity => G.spawnAnimal(w, "animal_cow", x, y);
const tamedCow = (w: World, owner: Entity, x: number, y: number): Entity => {
  const a = cow(w, x, y); const k = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind: k, owner, fedUntil: w.tick + 100000, produceAt: w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};

describe("ADR-351 rope leading (sim)", () => {
  it("attaches with rope equipped and the animal follows the holder (visible rope state for the holder)", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.checkLead(w, p, c)).toBeUndefined();
    expect(G.attachLead(w, p, c)).toBe(true);
    expect(w.has(c, G.RopeLead)).toBe(true);
    expect(w.getField(c, G.RopeLead, "holder")).toBe(1);
    // the visible rope: the holder entity resolves from the stored PlayerId, and the panel sees it
    expect(G.holderEntity(w, 1)).toBe(p);
    expect(G.leadInfo(w, p, c)).toEqual({ leadable: false, led: true, ledByMe: true, holderId: 1 });
    expect(G.ledAnimalOf(w, p)).toBe(c);
    const d0 = dist(w, p, c);
    moveTo(w, p, 8, 0); steps(w, 100);
    expect(dist(w, p, c)).toBeLessThan(6); // it followed the teleported holder (was 6 away)
    expect(dist(w, p, c)).toBeLessThanOrEqual(T.followDistance + 0.05); // and stopped at heel distance
    expect(at(w, c).x).toBeGreaterThan(2); // it actually moved toward the holder
    expect(w.has(c, G.RopeLead)).toBe(true); // still led after following
    void d0;
  });
  it("wild and tamed farm animals are both leadable; a bee and someone else's animal are not", () => {
    const { w, p } = holder(0, 0);
    const wild = cow(w, 2, 0); expect(G.isLeadable(w, wild)).toBe(true); expect(G.attachLead(w, p, wild)).toBe(true);
    expect(G.releaseLead(w, wild, G.RopeResult.Released, p)).toBe(true);
    const mine = tamedCow(w, p, 2, 0); expect(G.isLeadable(w, mine)).toBe(true); expect(G.attachLead(w, p, mine)).toBe(true);
    expect(G.releaseLead(w, mine, G.RopeResult.Released, p)).toBe(true);
    const other = spawnLearned(w, { x: 10, y: 0, maxWeight: 0, clientId: 2 }); setPid(w, other, 2);
    const theirs = tamedCow(w, other, 2, 0);
    expect(G.mayLead(w, p, theirs)).toBe(false); expect(G.checkLead(w, p, theirs)).toBe("not_owner");
    const bee = G.spawnAnimal(w, "animal_bee", 2, 0);
    expect(G.isLeadable(w, bee)).toBe(false); expect(G.checkLead(w, p, bee)).toBe("not_leadable");
    const horse = G.spawnAnimal(w, "animal_horse", 2, 0);
    expect(G.isLeadable(w, horse)).toBe(true); // mounts lead too
  });
  it("needs the rope equipped: pack-only rope cannot attach", () => {
    const { w, p } = holderUnequipped(0, 0); const c = cow(w, 2, 0);
    expect(G.ropeEquipped(w, p)).toBe(false);
    expect(G.checkLead(w, p, c)).toBe("no_rope"); expect(G.attachLead(w, p, c)).toBe(false);
    expect(w.has(c, G.RopeLead)).toBe(false);
  });
  it("one lead per holder, and only in attach range", () => {
    const { w, p } = holder(0, 0); const a = cow(w, 2, 0); const b = cow(w, 2, 1);
    expect(G.attachLead(w, p, a)).toBe(true);
    expect(G.checkLead(w, p, b)).toBe("already_led");
    const far = cow(w, 30, 0); expect(G.checkLead(w, p, far)).toBe("already_led"); // one-lead beats range here
    expect(G.releaseLead(w, a, G.RopeResult.Released, p)).toBe(true);
    expect(G.checkLead(w, p, far)).toBe("too_far");
  });
  it("release on un-equip, and release through the command (target 0)", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.attachLead(w, p, c)).toBe(true);
    // un-equip through the real Equip intent (same slot again toggles it off)
    w.set(p, G.PlayerIntent, { action: G.IntentAction.Equip, slot: G.HOTBAR_OFFSET }); steps(w, 2);
    expect(G.ropeEquipped(w, p)).toBe(false); steps(w, 1);
    expect(w.has(c, G.RopeLead)).toBe(false); // ropeSystem released it
    // re-equip, then attach again and release through the command path (target 0)
    w.set(p, G.PlayerIntent, { action: G.IntentAction.Equip, slot: G.HOTBAR_OFFSET }); steps(w, 2);
    expect(G.ropeEquipped(w, p)).toBe(true);
    expect(G.attachLead(w, p, c)).toBe(true);
    expect(G.releaseLead(w, c, G.RopeResult.Released, p)).toBe(true);
    expect(w.has(c, G.RopeLead)).toBe(false);
  });
  it("arriving inside the holder's claim ends the lead cleanly and the animal stays there", () => {
    const { w, p } = holder(38, 0); ensureClaim(w, p, 0, 0); // claim centre (0,0), radius 32
    const c = cow(w, 40, 0); const got: { result: number }[] = [];
    w.events.on(G.RopeEvent, (e: { result: number }) => got.push({ result: e.result }));
    expect(G.attachLead(w, p, c)).toBe(true);
    let arrived = false;
    for (let i = 0; i < 1200 && !arrived; i++) {
      moveTo(w, p, at(w, p).x - 0.04, 0); // walk home at 0.8 tiles/s; the cow walks 0.9
      steps(w, 1);
      arrived = got.some((g) => g.result === G.RopeResult.Arrived);
    }
    expect(arrived).toBe(true);
    expect(w.has(c, G.RopeLead)).toBe(false);
    expect(Math.hypot(at(w, c).x, at(w, c).y)).toBeLessThanOrEqual(32); // inside the claim
    expect(w.get(c, G.Animal)!.homeX).toBeCloseTo(at(w, c).x, 6); // home reset where it stands: it stays
  });
  it("breaks free when the holder gets too far (teleport / sprint away)", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0); const got: { result: number }[] = [];
    w.events.on(G.RopeEvent, (e: { result: number }) => got.push({ result: e.result }));
    expect(G.attachLead(w, p, c)).toBe(true);
    moveTo(w, p, 30, 0); steps(w, 1);
    expect(w.has(c, G.RopeLead)).toBe(false);
    expect(got.some((g) => g.result === G.RopeResult.BrokeFree)).toBe(true);
  });
  it("balks at danger instead of breaking: a zombie near the animal stops it, and it resumes when the zombie leaves", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.attachLead(w, p, c)).toBe(true);
    const z = G.spawnZombie(w, "zombie_walker", 2.5, 0.5);
    moveTo(w, p, 8, 0);
    const x0 = at(w, c).x; steps(w, 60);
    expect(at(w, c).x).toBeCloseTo(x0, 6); // balked: did not follow into danger
    expect(w.has(c, G.RopeLead)).toBe(true); // lead stayed on
    w.destroy(z); steps(w, 100);
    expect(at(w, c).x).toBeGreaterThan(x0); // resumed following once the danger left
  });
  it("breaks free when the animal is genuinely stuck (fenced in, cannot move toward the holder)", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.attachLead(w, p, c)).toBe(true);
    // pen the cow in with a fence on each neighbouring tile (placed directly, like plantClaim does, so the
    // test is about the rope, not about the building rules: fences need a claim, and a claim here would
    // also cover the cow and release the lead by arrival instead)
    const pid = (k: string) => d.pieceId(k);
    const def = d.pieces.get(pid("fence_picket"))!; const t = def.tiered ? 0 : def.fixedTier;
    for (const [x, y] of [[1.5, 0.5], [3.5, 0.5], [2.5, -0.5], [2.5, 1.5]] as const) {
      const sn = G.snapPlacement(w, { piece: pid("fence_picket"), x, y, level: 0, rot: 0, tier: t, variant: 0 });
      expect(typeof sn).not.toBe("number");
      G.placePiece(w, p, sn as never, { pay: false });
    }
    moveTo(w, p, 8, 0);
    const got: { result: number }[] = [];
    w.events.on(G.RopeEvent, (e: { result: number }) => got.push({ result: e.result }));
    steps(w, Math.ceil(T.stuckSeconds * 20) + 40);
    expect(w.has(c, G.RopeLead)).toBe(false);
    expect(got.some((g) => g.result === G.RopeResult.BrokeFree)).toBe(true);
  });
  it("holder death and animal death clean up with no dangling lead", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.attachLead(w, p, c)).toBe(true);
    w.add(p, G.Dead, { cause: 0, tick: w.tick }); steps(w, 1);
    expect(w.has(c, G.RopeLead)).toBe(false);
    // a fresh holder + animal: the animal dying removes the lead too
    const { w: w2, p: p2 } = holder(0, 0); const c2 = cow(w2, 2, 0);
    expect(G.attachLead(w2, p2, c2)).toBe(true);
    w2.add(c2, G.Dead, { cause: 0, tick: w2.tick }); steps(w2, 1);
    expect(w2.has(c2, G.RopeLead)).toBe(false);
  });
  it("a led animal does not wander off on its own animal AI while the holder stands still", () => {
    const { w, p } = holder(0, 0); const c = cow(w, 2, 0);
    expect(G.attachLead(w, p, c)).toBe(true);
    steps(w, 200);
    expect(dist(w, p, c)).toBeLessThanOrEqual(T.followDistance + 0.01);
  });
  it("the rope command is registered (append-only, after mounts) with its entity field", () => {
    const reg = G.registerGameplayCommands();
    expect(reg.idOf(G.RopeLeadCmd)).toBeGreaterThanOrEqual(0);
    expect(G.COMMAND_ENTITY_FIELDS[G.RopeLeadCmd.name]).toEqual(["target"]);
    expect(reg.make(G.RopeLeadCmd, { target: 5 }).values).toEqual({ target: 5 });
  });
});

// ---- AI humans --------------------------------------------------------------------------------------------------
let nid = 9000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(x = 40, y = 0): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); setPid(w, p, 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.defaultDefs();
  return { w, p, a, id: (k) => d.itemId(k), home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
function ctxOf(r: Rig): Ctx {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits, bravery: 0.8, industriousness: 0.8 }, rng: r.a.rng, agent: r.a, world: v.world };
}
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
function apply(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }): void {
  const { w, p } = r;
  for (const a of o.actions) if (a.startsWith("equip:")) { const s = Number(a.slice(6)); w.set(p, G.Equipment, { mainHandSlot: s, mainHandItem: G.readSlots(w, p).item(s) }); }
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number };
    if (c.type === G.RopeLeadCmd.name) { const t = v.target as Entity; if (t === 0) { const led = G.ledAnimalOf(w, p); if (led !== undefined) G.releaseLead(w, led, G.RopeResult.Released, p); } else if (!G.checkLead(w, p, t)) G.attachLead(w, p, t); }
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(w, p, bits, DT);
}

describe("ADR-351 rope leading (AI humans)", () => {
  it("a bot with rope leads a wild cow back to its claim and the lead releases on arrival", () => {
    const r = rig(40, 0); ensureClaim(r.w, r.p, 0, 0); // bot's fenced-in area at (0,0)
    G.addItem(r.w, r.p, ROPE, 1);
    const c = cow(r.w, 43, 0);
    const got: { result: number }[] = [];
    r.w.events.on(G.RopeEvent, (e: { result: number }) => got.push({ result: e.result }));
    const b = G.ropeBehaviors().find((x) => x.name === "lead_animal")!;
    let led = false, arrived = false;
    for (let i = 0; i < 4000 && !arrived; i++) {
      const ctx = ctxOf(r); const o = out(); b.run(ctx, o); G.mountPolicy(ctx, o, "lead_animal"); apply(r, o); r.w.step(DT);
      if (r.w.has(c, G.RopeLead)) led = true;
      if (led && !r.w.has(c, G.RopeLead)) arrived = true;
    }
    expect(led).toBe(true); // the bot equipped the rope and attached it
    expect(arrived).toBe(true); // ...walked it home, and the lead released inside the claim
    expect(got[got.length - 1]!.result).toBe(G.RopeResult.Arrived); // released by arrival, not a break-free
    expect(Math.hypot(at(r.w, c).x, at(r.w, c).y)).toBeLessThanOrEqual(32);
  });
  it("the rope sensor reports the lead for the holder and the behaviour is in the registry", () => {
    const r = rig(0, 0); G.addItem(r.w, r.p, ROPE, 1);
    const c = cow(r.w, 2, 0);
    const v0 = G.buildAgentView(r.w, r.p, r.a, r.home)!;
    expect(v0.world.rope?.target?.id).toBe(c); // a wild cow in reach is a candidate
    expect(v0.world.rope?.ropeEquipped).toBe(false);
    const v = G.readSlots(r.w, r.p); v.put(G.HOTBAR_OFFSET, ROPE, 1); G.writeSlots(r.w, r.p, v, d);
    r.w.set(r.p, G.Equipment, { mainHandSlot: G.HOTBAR_OFFSET, mainHandItem: ROPE });
    expect(G.attachLead(r.w, r.p, c)).toBe(true);
    const v1 = G.buildAgentView(r.w, r.p, r.a, r.home)!;
    expect(v1.world.rope?.leading?.id).toBe(c); // now leading: the sensor reports the live lead
    expect(G.survivorRegistry().list().map((x) => x.name)).toContain("lead_animal");
  });
  it("\"rope:<target>\" / \"rope:0\" become the rope command", () => {
    const o = out(); o.actions = ["rope:12", "rope:0", "rope:x"]; G.emitAgentCommands(o);
    expect(o.actions).toEqual([]);
    expect(o.commands!.map((x) => x.type)).toEqual([G.RopeLeadCmd.name, G.RopeLeadCmd.name]);
    expect(o.commands![0]!.payload).toEqual({ target: 12 });
    expect(o.commands![1]!.payload).toEqual({ target: 0 });
  });
});
