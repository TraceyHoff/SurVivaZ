/**
 * Survival behaviors for virtual players: party, stall_trade, eat, drink, sleep, craft, build. Like the reference set
 * they read only the bot's own replica (fillAgentSensors) and write AgentOutput (action strings, see agent_output.ts).
 * Entity ids in the view are replica ids; hosts whose replica ids differ from the server's translate open/buy targets.
 */
import { Appearance, Membership, PlayerId, StallDisplay, Transform, getAppearance, slotIndex, timeOfDay, type Entity, type World } from "@engine/core";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { Animal, BuildPiece, Dead, Listings, Pet, Tamed } from "../components.js";
import { GameplayConfig } from "../config.js";
import { Customization } from "../customization.js";
import { DyeKind, DyePalette } from "../dye.js";
import { readSlots, countItem, slotFreshness, exchangeItems, hasBrushInHotbar } from "../inventory.js";
import { crafterIdFor } from "../economy/provenance.js";
import { spoilStageIndex, spoilStages } from "../food.js";
import { pieceCost, pieceUnlocked } from "../building/place.js";
import { StationKind, type GameDefs, type ItemDef, type PieceDef, type RecipeDef } from "../defs.js";
import { FIRE_AFTER_GOALS, GOAL_CRAFTS, pieceNear, stuckOn } from "./autonomy.js";
import { PET_TREATS, speciesOfAnimal, tameChance } from "../pets.js";
import { isDomesticAnimal } from "../skills/husbandry.js";
import { UseCmd } from "../input.js";
import { containerSeq } from "./base_behaviors.js";
import { storageDepositActions } from "./storage_api.js";
import type { AgentOutputWithCommands } from "./agent_output.js";

export interface StallOffer { id: number; x: number; y: number; slot: number; item: number; qty: number; priceItem: number; priceCount: number; revision?: number }
export interface AgentSensors { food?: number; water?: number; partyMates?: { id: number; x: number; y: number }[]; stall?: StallOffer; /** ADR-145: a wild pet-species animal nearby + the best treat in the bag (the bot has no pet yet) */ tame?: { id: number; x: number; y: number; item: number } }
/** ADR-250: the starter basic_storage_box (never skill-gated, hand-built) instead of the plank storage_box. */
export const BUILD_PLAN_PIECES = ["campfire", "basic_storage_box", "workbench"] as const;

/** ADR-212: per-defs lookups (were rebuilt with [...map.values()].filter/find per bot per perception tick). */
interface DefsCache { hand: RecipeDef[]; itemByKey: Map<string, ItemDef>; pieceByKey: Map<string, PieceDef>; recipeFor: Map<number, RecipeDef> }
const DC = new WeakMap<GameDefs, DefsCache>();
function defsCache(defs: GameDefs): DefsCache {
  let c = DC.get(defs); if (c) return c;
  c = { hand: [], itemByKey: new Map(), pieceByKey: new Map(), recipeFor: new Map() };
  for (const r of defs.recipes.values()) { if (r.station === StationKind.None) c.hand.push(r); if (!c.recipeFor.has(r.output.item)) c.recipeFor.set(r.output.item, r); }
  for (const i of defs.items.values()) if (!c.itemByKey.has(i.key)) c.itemByKey.set(i.key, i);
  for (const p of defs.pieces.values()) if (!c.pieceByKey.has(p.key)) c.pieceByKey.set(p.key, p);
  DC.set(defs, c); return c;
}
/** Fills optional AgentWorldView sensors from the replica (no writes). Missing gameplay config/inventory = skipped. */
export function fillAgentSensors(world: World, self: Entity, view: AgentWorldView, hungry = false): void {
  const cfg = world.getResource(GameplayConfig); const t = world.get(self, Transform); if (!cfg || !t) return; const defs = cfg.defs; noteCampfire(world);
  let slots: ReturnType<typeof readSlots> | undefined; try { slots = readSlots(world, self); } catch { slots = undefined; }
  if (slots) {
    let empty = 0, bestFood = -1, bestWater = -1, fScore = 0, wScore = 0;
    for (let i = 0; i < slots.items.length; i++) {
      const it = slots.items[i]!; if (!it || !slots.counts[i]) { if (i < slots.addLimit) empty++; continue; }
      const f = defs.items.get(it)?.food; if (!f || f.health < 0) continue;
      if (spoilStages(defs)[spoilStageIndex(slotFreshness(world, self, i), spoilStages(defs))]?.sick) continue; // spoiled food makes you sick (negative regen): a player bins it
      if (f.hunger > fScore) { fScore = f.hunger; bestFood = i; }
      if (f.thirst > wScore) { wScore = f.thirst; bestWater = i; }
    }
    view.invSpaceFree = slots.addLimit ? empty / slots.addLimit : 0;
    if (bestFood >= 0) view.food = bestFood; if (bestWater >= 0) view.water = bestWater;
    const have = (item: number, n: number): boolean => countItem(world, self, item) >= n;
    // ADR-203: goal tools first (stone axe / pickaxe / spear); other hand recipes keep the next goal tool's ingredients and the campfire cost
    const dc = defsCache(defs);
    // Task 16: purpose-driven bot crafting. The legacy pick used to select ANY affordable hand recipe whose output the
    // bot did not own. Dye (3rd hand recipe in file order, berries x3, always affordable) was the loop: crafted, then
    // junk-dropped when the bag filled (dye is neither ladder-useful nor plan-kept), then crafted again forever,
    // scattering dye piles bots never reclaim (ADR-252: bots never perceive ground loot) until areas lagged. Now a
    // recipe is selectable only when its output serves the next unowned goal tool — the tool itself, or a
    // hand-craftable ingredient of it — capped at the outstanding need, so existing stock counts toward the need and
    // the bot uses what it already holds before crafting more. Plan-driven crafts are untouched: fillPlanSensors
    // overwrites craftRecipe with the plan's own hand-craft step after this runs.
    const need = new Map<number, number>();
    for (const k of GOAL_CRAFTS) {
      const d = dc.itemByKey.get(k); if (!d || countItem(world, self, d.id) > 0) continue;
      const gr = dc.recipeFor.get(d.id);
      if (gr && gr.station === StationKind.None) {
        need.set(d.id, 1);
        const queue = [{ item: d.id, need: 1 }]; const seen = new Set<number>([d.id]); let pops = 0;
        while (queue.length && pops++ < 64) { // 64 pops bounds any recipe cycle; real goal chains are depth <= 2
          const cur = queue.shift()!; const r = dc.recipeFor.get(cur.item);
          if (!r || r.station !== StationKind.None) continue;
          for (const g of r.ingredients) {
            if (g.item === cur.item) continue;
            const add = Math.ceil(cur.need / r.output.count) * g.count;
            const prev = need.get(g.item) ?? 0; need.set(g.item, prev + add);
            if (!seen.has(g.item)) { seen.add(g.item); queue.push({ item: g.item, need: prev + add }); }
            else if (add > 0) queue.push({ item: g.item, need: add }); // re-propagate the delta
          }
        }
      }
      break;
    }
    // Task 25: bot dye goal — purpose-gated and bounded (the Task 16 loop cannot return through this path). Each bot
    // has one deterministic hair colour per (bot, day): fnv1a(bot PlayerId, day) over the hair palette. While the
    // bot's hair is not today's colour it wants exactly one dye (need = 1, only while it carries none) — the dye
    // recipe (3 berries, hand) then becomes selectable through the same `hand` filter below, sorted after the goal
    // tools (goalOf 99) and behind the same room gate, so it never displaces a goal craft and never stockpiles.
    // Once the bot dyes (or already wears today's colour) the need clears until tomorrow. The bot must hold a paint
    // brush in its hotbar (the same rule as players) and have a hair style equipped; without a brush it never wants
    // dye, and dye is never junk-dropped while it holds a brush (see fillPlanSensors).
    const dyeId = defs.itemId("dye");
    const cat = world.getResource(Customization)?.catalog;
    const hairLen = cat?.hairColors.length ?? 0;
    const hairSlot = slotIndex("hair");
    // Task 25: getAppearance throws when the entity has no Appearance (World.get) — animal agent views hit this
    // path, so guard it; no appearance means no hair to dye.
    const app = world.isRegistered(Appearance) && world.has(self, Appearance) ? getAppearance(world, self) : undefined;
    const hairId = app?.parts[hairSlot] ?? 0;
    let dyeTarget: number | undefined;
    if (dyeId && cat && hairLen > 0 && hairId !== 0 && hasBrushInHotbar(world, self)) {
      const pid = world.isRegistered(PlayerId) && world.has(self, PlayerId) ? (world.getField(self, PlayerId, "id") ?? 0) : 0;
      let h = 2166136261; const s = `${pid}:${timeOfDay(world).day}`;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
      const idx = (h >>> 0) % hairLen;
      if ((app?.primary[hairSlot] ?? -1) !== idx) dyeTarget = idx;
    }
    if (dyeTarget !== undefined) {
      if (countItem(world, self, dyeId) > 0) view.dye = { kind: DyeKind.Hair, slot: hairSlot, palette: DyePalette.Hair, index: dyeTarget };
      else { delete view.dye; need.set(dyeId, 1); }
    } else delete view.dye;
    const hand = dc.hand.filter((r) => { const n = need.get(r.output.item); return n !== undefined && countItem(world, self, r.output.item) < n; });
    const goalOf = (r: (typeof hand)[number]): number => { const k = defs.items.get(r.output.item)?.key ?? ""; const i = (GOAL_CRAFTS as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };
    // other hand recipes may only spend what the next unowned goal tool does not need (reserve = its ingredients)
    const reserve = new Map<number, number>();
    for (const k of GOAL_CRAFTS) { const d = dc.itemByKey.get(k); if (!d || countItem(world, self, d.id) > 0) continue;
      const gr = dc.recipeFor.get(d.id); if (gr) for (const g of gr.ingredients) reserve.set(g.item, g.count); break; }
    const fireRes = new Map<number, number>();
    { const cf = dc.pieceByKey.get("campfire"); // and the home campfire's cost
      if (cf && !pieceNear(world, cf.id, view.home.x, view.home.y, 6)) for (const c of pieceCost(defs, cf, 0)) { reserve.set(c.item, (reserve.get(c.item) ?? 0) + c.count); fireRes.set(c.item, c.count); } }
    for (const r of hand.sort((a, b) => goalOf(a) - goalOf(b))) {
      // ADR-217: the goal tools after the axe (FIRE_AFTER_GOALS) wait for the campfire's cost too (wood is chopped now)
      const extra = goalOf(r) === 99 ? (id: number) => reserve.get(id) ?? 0 : goalOf(r) >= FIRE_AFTER_GOALS ? (id: number) => fireRes.get(id) ?? 0 : () => 0;
      // Task 16: room gate — the craft system would fail this with InventoryFull (its output never drops to the
      // ground; a failed add lands in CraftOwed), so don't pick a recipe whose full output can't land in the bag.
      // The dry run mirrors checkRecipe: ingredients out, then the whole output in.
      if (r.ingredients.every((g) => have(g.item, g.count + extra(g.item)))
        && exchangeItems(world, self, r.ingredients, [r.output], true, crafterIdFor(world, self, r.output.item))) { view.craftRecipe = r.id; break; }
    }
    // ADR-203: plan each base piece that is missing near home (campfire first), not only "no piece at all"
    let k = 0;
    for (const key of BUILD_PLAN_PIECES) {
      k++; const def = dc.pieceByKey.get(key); if (!def || pieceNear(world, def.id, view.home.x, view.home.y, 6)) continue;
      if (!pieceUnlocked(world, self, def, def.tiered ? 0 : def.fixedTier)) continue; // ADR-221: learn it first (skillPickBehavior)
      if (pieceCost(defs, def, 0).every((c) => have(c.item, c.count))) { view.buildPlan = { piece: def.id, x: Math.round(view.home.x) + k, y: Math.round(view.home.y) + (k === 1 ? 0 : 2) }; break; }
    }
  }
  const party = world.getField(self, Membership, "partyId") ?? 0;
  if (party) { const mates: { id: number; x: number; y: number }[] = []; for (const e of world.query([Membership, Transform])) if (e !== self && world.getField(e, Membership, "partyId") === party) { const p = world.get(e, Transform)!; mates.push({ id: e, x: p.x, y: p.y }); } if (mates.length) view.partyMates = mates; }
  let best: StallOffer | undefined, bd = 12;
  for (const e of world.query([StallDisplay, Transform])) {
    const p = world.get(e, Transform)!; const d = Math.hypot(p.x - t.x, p.y - t.y); if (d >= bd) continue;
    const item = world.getArray(e, StallDisplay, "item")!, qty = world.getArray(e, StallDisplay, "qty")!, price = world.getArray(e, StallDisplay, "price")!, cur = world.getArray(e, StallDisplay, "currency")!;
    for (let i = 0; i < item.length; i++) {
      if (!item[i] || !price[i]) continue; const isFood = !!defs.items.get(item[i]!)?.food; if (hungry && !isFood) continue;
      if (slots && countItem(world, self, cur[i]!) < price[i]!) continue;
      best = { id: e, x: p.x, y: p.y, slot: i, item: item[i]!, qty: qty[i]!, priceItem: cur[i]!, priceCount: price[i]!, ...(world.has(e, Listings) ? { revision: world.getField(e, Listings, "revision")! } : {}) }; bd = d; break;
    }
  }
  if (best) view.stall = best;
  // ADR-145: AI humans tame a pet too (one each) when they carry a treat the species accepts
  if (slots && world.isRegistered(PlayerId) && world.has(self, PlayerId)) {
    const me = world.getField(self, PlayerId, "id") ?? 0; let mine = false; for (const e of world.query([Pet])) if (world.getField(e, Pet, "owner") === me) { mine = true; break; }
    if (!mine) {
      let bt: { id: number; x: number; y: number; item: number } | undefined, bc = 0, bdist = 14;
      const treats = PET_TREATS.map((k) => { const d = defsCache(defs).itemByKey.get(k); return d && countItem(world, self, d.id) > 0 ? d : undefined; }).filter((d) => d !== undefined);
      if (treats.length) for (const e of world.query([Animal, Transform], [Dead, Pet, Tamed])) {
        const sp = speciesOfAnimal(world, e); if (!sp) continue; const p = world.get(e, Transform)!; const d = Math.hypot(p.x - t.x, p.y - t.y); if (d > bdist) continue;
        for (const it of treats) { const c = tameChance(sp, it.key); if (c > bc || (c === bc && c > 0 && d < bdist)) { bc = c; bdist = d; bt = { id: e, x: p.x, y: p.y, item: it.id }; } }
      }
      if (bt && bc > 0) view.tame = bt;
    }
  }
  // Task 28: tame farm animals for food (winter stores + self-sufficiency) — Use animal_feed next to a wild
  // domestic animal (tameBase 0.35, needs husbandry 1), or feed an owned animal whose fedUntil has lapsed.
  // Capped at 2 owned livestock so a bot does not hoard the whole field.
  const feedId = defsCache(defs).itemByKey.get("animal_feed")?.id;
  if (slots && feedId && countItem(world, self, feedId) > 0) {
    const feedSlot = slots.items.findIndex((it, i) => it === feedId && slots.counts[i]);
    if (feedSlot >= 0) {
      let livestock = 0; let hungry: { id: number; x: number; y: number } | undefined, hd = Infinity;
      for (const e of world.query([Animal, Transform, Tamed])) {
        if (world.getField(e, Tamed, "owner") !== self) continue; livestock++;
        const fed = world.getField(e, Tamed, "fedUntil") ?? 0;
        if (fed <= world.tick) { const p = world.get(e, Transform)!; const dd = Math.hypot(p.x - t.x, p.y - t.y); if (dd < hd) { hd = dd; hungry = { id: e, x: p.x, y: p.y }; } }
      }
      if (livestock < 2 || hungry) {
        let best: { id: number; x: number; y: number } | undefined; let bd = 14;
        if (hungry) best = hungry; // feed first: a fed animal produces
        else if (livestock < 2) for (const e of world.query([Animal, Transform], [Dead, Pet, Tamed])) {
          if (!isDomesticAnimal(world, e)) continue;
          const p = world.get(e, Transform)!; const dd = Math.hypot(p.x - t.x, p.y - t.y);
          if (dd < bd) { bd = dd; best = { id: e, x: p.x, y: p.y }; }
        }
        if (best) view.tameLivestock = { ...best, slot: feedSlot };
      }
    }
  }
  // Task 28: fill the trough with hay for hungry owned livestock — the bot carries hay, a hungry owned animal
  // exists, and a feeding_trough stands within 12 tiles. Deposits up to 4 hay per trip; the trough feeds the
  // animal on its own (husbandrySystem hay pass), so the bot only tops it up. The server resolves copen/cdeposit
  // from the trough piece to its storage attachment, so the piece id is the deposit target.
  const hayId = defsCache(defs).itemByKey.get("hay")?.id;
  if (slots && hayId && countItem(world, self, hayId) > 0) {
    let hungry = false;
    for (const e of world.query([Animal, Transform, Tamed])) {
      if (world.getField(e, Tamed, "owner") !== self) continue;
      if ((world.getField(e, Tamed, "fedUntil") ?? 0) <= world.tick) { hungry = true; break; }
    }
    if (hungry) {
      const troughId = defsCache(defs).pieceByKey.get("feeding_trough")?.id;
      if (troughId) for (const b of world.query([BuildPiece, Transform], [Dead])) {
        if (world.get(b, BuildPiece)!.type !== troughId) continue;
        const p = world.get(b, Transform)!; if (Math.hypot(p.x - t.x, p.y - t.y) > 12) continue;
        view.feedTrough = { id: b, x: p.x, y: p.y, item: hayId, count: Math.min(4, countItem(world, self, hayId)) };
        break;
      }
    }
  }
}

const toward = (o: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const cooled = (tick: number, at: number, ticks: number): number => (tick - at >= ticks ? 1 : 0);
let campfireId: number | undefined;
const isCampfire = (piece: number | undefined): boolean => piece !== undefined && piece === campfireId;
/** Called by fillAgentSensors so build's considerations can tell a campfire plan apart without the defs. */
function noteCampfire(world: World): void { if (campfireId !== undefined) return; const d = world.getResource(GameplayConfig)?.defs; if (d) for (const p of d.pieces.values()) if (p.key === "campfire") campfireId = p.id; }
const night = (p: string): number => (p === "night" ? 1 : p === "dusk" ? 0.6 : 0);

/** party, stall_trade, eat, drink, sleep, craft, build. */
export function survivalBehaviors(): GameBehavior[] {
  return [
    { name: "eat", inertia: 0, considerations: [
        { name: "hungry", curve: { type: "logistic", k: 12, mid: 0.55 }, input: (c) => 1 - c.self.hunger },
        { name: "hasFood", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.food !== undefined ? cooled(c.self.tick, c.bb.num("ateAt", -1e9), 40) : 0) },
        // ADR-446: a pending shared meal suppresses lone eating (the meal behavior eats at the
        // hearth instead). The sensor precomputes suppressLoneEat: only on a short walk to the
        // hearth and above starvation hunger — far away or starving, bots eat alone as today.
        { name: "noMealWaits", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.sharedMeal?.suppressLoneEat ? 0 : 1) }],
      run: (c, o) => { if (c.world.food === undefined) return false; o.actions.push(`eat:${c.world.food}`); c.bb.set("ateAt", c.self.tick); return false; } },
    { name: "drink", inertia: 0, considerations: [
        { name: "thirsty", curve: { type: "logistic", k: 12, mid: 0.55 }, input: (c) => 1 - c.self.thirst },
        { name: "hasWater", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.water !== undefined ? cooled(c.self.tick, c.bb.num("drankAt", -1e9), 40) : 0) }],
      run: (c, o) => { if (c.world.water === undefined) return false; o.actions.push(`drink:${c.world.water}`); c.bb.set("drankAt", c.self.tick); return false; } },
    { name: "sleep", chatOnStart: "rest", scheduleBonus: 0.4, inertia: 0.3, considerations: [
        { name: "night", curve: { type: "step", at: 0.5 }, input: (c) => night(c.self.phase) },
        { name: "safe", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) || (c.world.cold && (c.world.fireMissing || (c.world.fire && !c.world.fire.lit))) ? 0 : 1) }],
      run: (c, o) => { if (toward(o, c.self.x, c.self.y, c.world.home.x, c.world.home.y, 0.8) < 1.5) { o.moveX = 0; o.moveY = 0; o.aimX = 0; o.aimY = 0; o.actions.push("sleep"); } if (night(c.self.phase) < 0.5) return false; } },
    { name: "craft", scheduleBonus: 0.3, traits: { industriousness: 0.6 }, considerations: [
        { name: "canCraft", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.craftRecipe !== undefined ? cooled(c.self.tick, c.bb.num("craftedAt", -1e9), 200) : 0) },
        { name: "daylight", curve: { type: "linear", m: -0.6, b: 1 }, input: (c) => night(c.self.phase) }],
      run: (c, o) => { if (c.world.craftRecipe === undefined) return false; o.actions.push(`craft:${c.world.craftRecipe}`); c.bb.set("craftedAt", c.self.tick); return false; } },
    { name: "build", scheduleBonus: 0.3, traits: { industriousness: 0.6 }, considerations: [
        { name: "plan", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.buildPlan ? cooled(c.self.tick, c.bb.num("builtAt", -1e9), 200) : 0) },
        // ADR-203: a campfire (light + heat) is what a survivor builds at dusk / night; other pieces are daytime work
        { name: "daylight", curve: { type: "linear", m: -0.8, b: 1 }, input: (c) => (isCampfire(c.world.buildPlan?.piece) ? 0 : night(c.self.phase)) },
        { name: "nightFire", curve: { type: "linear", m: 0.6, b: 0.4 }, input: (c) => (isCampfire(c.world.buildPlan?.piece) ? night(c.self.phase) : 0) }],
      run: (c, o) => {
        const p = c.world.buildPlan; if (!p) return false;
        const sh = c.bb.num("buildShift"); const x = p.x + (sh % 3), y = p.y + Math.floor(sh / 3) % 3;
        if (toward(o, c.self.x, c.self.y, x, y, 0.8) < 2) { o.moveX = 0; o.moveY = 0; o.actions.push(`build:${p.piece}:${x}:${y}`); c.bb.set("builtAt", c.self.tick); c.bb.set("buildShift", sh + 1); return false; }
        if (stuckOn(c, x, y)) { c.bb.set("buildShift", sh + 1); return false; }
      } },
    { name: "stall_trade", scheduleBonus: 0.3, traits: { greed: 0.5, sociability: 0.4 }, considerations: [
        { name: "offer", curve: { type: "inverse" }, input: (c) => { const s = c.world.stall; return s && cooled(c.self.tick, c.bb.num("tradedAt", -1e9), 300) ? Math.hypot(s.x - c.self.x, s.y - c.self.y) / 12 : 1; } },
        { name: "need", curve: { type: "linear", m: 0.6, b: 0.4 }, input: (c) => 1 - c.self.hunger }],
      run: (c, o) => {
        const s = c.world.stall; if (!s) return false;
        if (toward(o, c.self.x, c.self.y, s.x, s.y, 0.8) > 1.8) return;
        o.moveX = 0; o.moveY = 0;
        if (s.revision === undefined) { if (c.self.tick - c.bb.num("openedAt", -1e9) > 40) { o.actions.push(`open:${s.id}`); c.bb.set("openedAt", c.self.tick); } return; }
        o.actions.push(`buy:${s.id}:${s.slot}:1:${s.revision}:${s.priceItem}:${s.priceCount}`); c.bb.set("tradedAt", c.self.tick); return false;
      } },
    { name: "tame_pet", traits: { sociability: 0.5 }, inertia: 0.3, considerations: [ // ADR-145
        { name: "candidate", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.tame && cooled(c.self.tick, c.bb.num("tamedAt", -1e9), 60) ? 1 : 0) },
        { name: "safe", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const a = c.world.tame; if (!a) return false;
        if (toward(o, c.self.x, c.self.y, a.x, a.y, 0.6) > 1.8) return;
        o.moveX = 0; o.moveY = 0; o.actions.push(`tame:${a.id}:${a.item}`); c.bb.set("tamedAt", c.self.tick); return false;
      } },
    { name: "tame_livestock", traits: { industriousness: 0.5 }, inertia: 0.3, considerations: [ // Task 28: food production
        { name: "candidate", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.tameLivestock && cooled(c.self.tick, c.bb.num("livestockAt", -1e9), 60) ? 1 : 0) },
        { name: "safe", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => { // walk to the animal and Use the feed slot (the same command a player sends; the server
        // re-validates reach, husbandry skill and the tame chance — a failed roll is retried next sense tick).
        const a = c.world.tameLivestock; if (!a) return false;
        if (toward(o, c.self.x, c.self.y, a.x, a.y, 0.6) > 1.8) return;
        o.moveX = 0; o.moveY = 0;
        if (c.self.tick - c.bb.num("livestockAt", -1e9) >= 60) {
          const oc = o as unknown as AgentOutputWithCommands;
          (oc.commands ??= []).push({ type: UseCmd.name, payload: { slot: a.slot } });
          c.bb.set("livestockAt", c.self.tick);
        }
        return false;
      } },
    { name: "feed_trough", traits: { industriousness: 0.5 }, inertia: 0.3, considerations: [ // Task 28: hay into the trough
        { name: "candidate", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.feedTrough && cooled(c.self.tick, c.bb.num("fedTroughAt", -1e9), 120) ? 1 : 0) },
        { name: "safe", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => { // walk to the trough and deposit hay (open -> deposit -> close, one action per think tick)
        const f = c.world.feedTrough; if (!f) return false;
        if (toward(o, c.self.x, c.self.y, f.x, f.y, 0.6) > 2.2) return;
        o.moveX = 0; o.moveY = 0;
        if (containerSeq(c, o, f.id, storageDepositActions(f.id as Entity, f.item, f.count))) { c.bb.set("fedTroughAt", c.self.tick); return false; }
      } },
    { name: "party", traits: { sociability: 1 }, inertia: 0.2, considerations: [
        { name: "mateAway", curve: { type: "logistic", k: 10, mid: 0.3 }, input: (c) => { const m = nearestMate(c.world, c.self.x, c.self.y); return m ? Math.min(1, m.d / 12) : 0; } }],
      run: (c, o) => {
        const m = nearestMate(c.world, c.self.x, c.self.y); if (!m) return false;
        if (c.self.tick - c.bb.num("behaviorStart") === 0 || !c.bb.get("partyWaved")) { o.emote = "wave"; c.bb.set("partyWaved", true); }
        if (toward(o, c.self.x, c.self.y, m.x, m.y, 0.9) < 2.5) { o.moveX = 0; o.moveY = 0; c.bb.set("partyWaved", false); return false; }
      } },
  ];
}
function nearestMate(w: AgentWorldView, x: number, y: number): { x: number; y: number; d: number } | undefined {
  let best: { x: number; y: number; d: number } | undefined; for (const m of w.partyMates ?? []) { const d = Math.hypot(m.x - x, m.y - y); if (!best || d < best.d) best = { x: m.x, y: m.y, d }; } return best;
}
