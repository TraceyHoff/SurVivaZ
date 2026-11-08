import { describe, expect, it } from "vitest";
import { defaultAppearance, getAppearance, installPermissions, Membership, PlayerId, setAppearance, slotIndex, type CosmeticCatalogLike, type WearableDef } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";

/** Task 25: dye system (DyeCmd + SlotDye), paint brush in the hotbar, bot dye gating, paintable counts. */
const wd = (id: number, slot: WearableDef["slot"]): WearableDef => ({
  id, key: `w${id}`, slot, bodies: { male: { sprite: id, anim: "idle" }, female: { sprite: id, anim: "idle" } }, layer: 1, z: 0, tintChannels: 2, hidesSlots: [], hatHair: false, unlockTags: [],
});
const W = new Map([[1, wd(1, "hair")], [2, wd(2, "top")], [3, wd(3, "bottom")]]);
const hairPal = [{ index: 0, key: "black", color: 0x2e2630 }, { index: 1, key: "brown", color: 0x6b4a2f }, { index: 2, key: "teal", color: 0x3aa6a0 }];
const clothPal = [{ index: 0, key: "white", color: 0xf4f0e8 }, { index: 1, key: "red", color: 0xd9503e }, { index: 2, key: "blue", color: 0x4f8fd6 }];
const cat: CosmeticCatalogLike = { wearable: (i) => W.get(i), bodySprite: () => ({ sprite: 0, anim: "idle" }), skinTones: hairPal, hairColors: hairPal, clothingColors: clothPal };

function setup() {
  const w = makeWorld(); G.installCustomization(w, { catalog: cat });
  const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
  const a = defaultAppearance(cat); a.parts[slotIndex("hair")] = 1; a.parts[slotIndex("top")] = 2; setAppearance(w, p, a);
  const d = G.gameplayDefs(w); const id = (k: string) => d.itemId(k);
  return { w, p, id };
}
/** Put `count` of `item` in an exact inventory slot (bypasses addItem's first-free-slot placement). */
const putInSlot = (w: ReturnType<typeof makeWorld>, e: number, slot: number, item: number, count = 1): void => {
  const v = G.readSlots(w, e); v.items[slot] = item; v.counts[slot] = count; G.writeSlots(w, e, v, G.gameplayDefs(w));
};
const giveBrushDye = (w: ReturnType<typeof makeWorld>, e: number, id: (k: string) => number, brushSlot = 16, dyeCount = 2): void => {
  putInSlot(w, e, brushSlot, id("paint_brush")); G.addItem(w, e, id("dye"), dyeCount);
};
const hair = () => slotIndex("hair");
const top = () => slotIndex("top");

describe("Task 25: dye system", () => {
  it("SlotDye is networked and persistent; the dye command is registered", () => {
    expect(G.SlotDye.networked).toBe(true); expect(G.SlotDye.persistent).toBe(true);
    expect(G.DyeCmd.name).toBe("gameplay.dye");
    const reg = G.registerGameplayCommands(); expect(reg.idOf(G.DyeCmd)).toBeGreaterThanOrEqual(0); // registered, no throw
    expect(G.DYE_REJECT_REASONS).toEqual(["no_brush", "no_dye", "no_wearable", "bad_palette", "not_dyeable", "bad_dye_kind"]);
  });
  it("paint brush must be in the hotbar (slots 16-23), not just the pack", () => {
    const { w, p, id } = setup();
    expect(G.hasBrushInHotbar(w, p)).toBe(false);
    putInSlot(w, p, 0, id("paint_brush")); expect(G.hasBrushInHotbar(w, p)).toBe(false); // pack only: rejected
    putInSlot(w, p, 0, 0); putInSlot(w, p, 16, id("paint_brush")); expect(G.hasBrushInHotbar(w, p)).toBe(true);
    putInSlot(w, p, 16, 0); putInSlot(w, p, 23, id("paint_brush")); expect(G.hasBrushInHotbar(w, p)).toBe(true);
  });
  it("hair dye consumes one dye and sets the hair colour (appearance version bumps)", () => {
    const { w, p, id } = setup(); giveBrushDye(w, p, id);
    const before = getAppearance(w, p)!; expect(before.primary[hair()]).toBe(0);
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 2)).toBeUndefined();
    expect(G.dyeApply(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 2)).toBe(true);
    expect(G.countItem(w, p, id("dye"))).toBe(1); // one of two consumed
    const after = getAppearance(w, p)!; expect(after.primary[hair()]).toBe(2); expect(after.version).not.toBe(before.version);
    expect(after.parts[hair()]).toBe(1); // the style itself is unchanged
  });
  it("hair dye fails visibly without a brush, without dye, without hair, or with a bad index — nothing is consumed", () => {
    const { w, p, id } = setup();
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 1)).toBe("no_brush"); // no brush, no dye
    putInSlot(w, p, 16, id("paint_brush"));
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 1)).toBe("no_dye");
    G.addItem(w, p, id("dye"), 1);
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 99)).toBe("bad_palette");
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Clothing, 1)).toBe("bad_palette"); // hair needs the hair palette
    const a = getAppearance(w, p)!; const bald = { ...a, parts: [...a.parts] }; bald.parts[hair()] = 0; setAppearance(w, p, bald);
    expect(G.dyeValidate(w, p, G.DyeKind.Hair, hair(), G.DyePalette.Hair, 1)).toBe("no_wearable");
    expect(G.countItem(w, p, id("dye"))).toBe(1); // validation never consumes
  });
  it("worn dye recolours the worn slot with its own palette; the wrong palette is rejected", () => {
    const { w, p, id } = setup(); giveBrushDye(w, p, id);
    expect(G.dyeValidate(w, p, G.DyeKind.Worn, top(), G.DyePalette.Clothing, 1)).toBeUndefined();
    expect(G.dyeValidate(w, p, G.DyeKind.Worn, top(), G.DyePalette.Hair, 1)).toBe("bad_palette"); // top uses the clothing palette
    expect(G.dyeApply(w, p, G.DyeKind.Worn, top(), G.DyePalette.Clothing, 1)).toBe(true);
    expect(getAppearance(w, p)!.primary[top()]).toBe(1);
    expect(G.dyeValidate(w, p, G.DyeKind.Worn, slotIndex("bottom"), G.DyePalette.Clothing, 1)).toBe("no_wearable"); // nothing worn there
  });
  it("held dye stores the palette RGB in SlotDye and consumes one dye; non-tools are not dyeable", () => {
    const { w, p, id } = setup(); putInSlot(w, p, 0, id("stone_axe")); // a tool in pack slot 0
    giveBrushDye(w, p, id);
    expect(G.dyeValidate(w, p, G.DyeKind.Held, 0, G.DyePalette.Clothing, 2)).toBeUndefined();
    expect(G.dyeApply(w, p, G.DyeKind.Held, 0, G.DyePalette.Clothing, 2)).toBe(true);
    expect(G.countItem(w, p, id("dye"))).toBe(1);
    const colors = w.getArray(p, G.SlotDye, "colors")!; expect(colors[0]).toBe(0x4f8fd6); // blue, the clothing palette's index 2
    expect(colors[1]).toBe(0); // other slots undyed
    putInSlot(w, p, 2, id("berries")); // food is not a tool / weapon
    expect(G.dyeValidate(w, p, G.DyeKind.Held, 2, G.DyePalette.Clothing, 1)).toBe("not_dyeable");
    expect(G.dyeValidate(w, p, G.DyeKind.Held, 5, G.DyePalette.Clothing, 1)).toBe("not_dyeable"); // empty slot
    expect(G.dyeValidate(w, p, 9, 0, G.DyePalette.Clothing, 1)).toBe("bad_dye_kind");
  });
  it("dyeView reports brush / dye / hair / worn / held for the Character panel", () => {
    const { w, p, id } = setup();
    const ctx = { world: w, player: p, catalog: cat } as G.MenuCtx;
    let v = G.dyeView(ctx); expect(v.brush).toBe(false); expect(v.dye).toBe(0); expect(v.hair?.equipped).toBe(1); expect(v.worn.map((t) => t.key)).toContain("top"); expect(v.held).toBeUndefined();
    putInSlot(w, p, 0, id("stone_axe")); giveBrushDye(w, p, id);
    // held only counts once the tool is equipped in the main hand    v = G.dyeView(ctx); expect(v.brush).toBe(true); expect(v.dye).toBe(2); expect(v.held).toBeUndefined();
    w.set(p, G.Equipment, { mainHandSlot: 0, mainHandItem: id("stone_axe") });
    v = G.dyeView(ctx); expect(v.held?.slot).toBe(0); expect(v.held?.name).toBe("Stone Axe"); expect(v.held?.color).toBe(0);
    G.dyeApply(w, p, G.DyeKind.Held, 0, G.DyePalette.Clothing, 2);
    v = G.dyeView(ctx); expect(v.held?.color).toBe(0x4f8fd6);
  });
  it("painting a piece without a brush in the hotbar fails NoBrush (23) and consumes nothing", () => {
    const { w, p, id } = setup();
    const defs = G.gameplayDefs(w); const pieceId = defs.pieceId("rug");
    const sn = G.snapPlacement(w, { piece: pieceId, x: 1, y: 0, level: 0, rot: 0, tier: 1, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap rug ${sn}`);
    const piece = G.placePiece(w, p, sn, { pay: false });
    G.addItem(w, p, id("dye"), 2);
    const failed = collect(w, G.BuildFailed);
    w.set(p, G.PlayerIntent, { action: G.IntentAction.Paint, target: piece, paint: 3 });
    steps(w, 1);
    expect(failed.some((f) => f.reason === G.BuildFail.NoBrush)).toBe(true);
    expect(w.getField(piece, G.BuildPiece, "paint")).toBe(0);
    expect(G.countItem(w, p, id("dye"))).toBe(2); // nothing consumed
    // with a brush in the hotbar the same paint succeeds and spends one dye
    putInSlot(w, p, 16, id("paint_brush"));
    w.set(p, G.PlayerIntent, { action: G.IntentAction.Paint, target: piece, paint: 3 });
    steps(w, 1);
    expect(w.getField(piece, G.BuildPiece, "paint")).toBe(3);
    expect(G.countItem(w, p, id("dye"))).toBe(1);
  });
  it("paintable pieces: 158 flagged + tiered pieces paintable server-side; claim_totem excluded", () => {
    const d = G.gameplayDefs(makeWorld());
    let flagged = 0, tiered = 0, total = 0;
    for (const p of d.pieces.values()) { total++; if (p.paintable) flagged++; if (p.tiered) tiered++; }
    expect(total).toBe(188); expect(flagged).toBe(159); expect(tiered).toBeGreaterThan(0); // Task 28: +3 salt-storage pieces, all paintable; Task 34: +1 Apiary, paintable; ADR-265: +1 unpaintable terrain Ladder
    expect(d.pieces.get(d.pieceId("claim_totem"))!.paintable).toBe(false);
    expect(d.pieces.get(d.pieceId("rug"))!.paintable).toBe(true);
    for (const k of ["salt_barrel", "curing_box", "cold_store"]) expect(d.pieces.get(d.pieceId(k))!.paintable).toBe(true);
    expect(d.pieces.get(d.pieceId("wall"))!.tiered).toBe(true);
  });
  it("bot dye action string maps to the DyeCmd net command; malformed dye actions are dropped", () => {
    const c = G.actionCommand("dye:0:0:0:2");
    expect(c).toEqual({ type: "gameplay.dye", payload: { kind: 0, slot: 0, palette: 0, index: 2 } });
    expect(G.actionCommand("dye:0:0")).toBeUndefined();
    expect(G.actionCommand("dye:0:0:0")).toBeUndefined();
    const out = { actions: ["dye:0:0:0:2", "gather"], commands: [] as G.AgentCommand[] };
    G.emitAgentCommands(out as G.AgentOutputWithCommands);
    expect(out.commands).toEqual([{ type: "gameplay.dye", payload: { kind: 0, slot: 0, palette: 0, index: 2 } }]);
    expect(out.actions).toEqual(["gather"]); // the dye action moved out of the frame actions
  });
});

describe("Task 25: bot dye gating (no Task 16 loop)", () => {
  const botSetup = () => {
    const { w, p, id } = setup();
    if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w); G.installEconomy(w);
    const bot = spawnLearned(w, { x: 5, y: 5, maxWeight: 0, clientId: 2 });
    if (w.isRegistered(Membership)) w.add(bot, Membership, { partyId: 0, clanId: 0 });
    if (w.has(bot, PlayerId)) w.set(bot, PlayerId, { id: 2 }); else w.add(bot, PlayerId, { id: 2 });
    const a = defaultAppearance(cat); a.parts[slotIndex("hair")] = 1; setAppearance(w, bot, a);
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    agent.bb.set("sitePickAt", 0); // Task 16 pattern: no base anchor yet, so the planner cannot delete craftRecipe
    return { w, p, bot, id, agent };
  };
  const viewOf = (w: ReturnType<typeof makeWorld>, bot: number, agent: ReturnType<typeof G.makeAgent>) => {
    return G.buildAgentView(w, bot, agent, { x: 5, y: 5 })!.world;
  };
  it("a brush-less bot never wants dye and never gets a dye craft", () => {
    const { w, bot, id, agent } = botSetup();
    G.addItem(w, bot, id("berries"), 6); // enough berries for two dyes
    const v = viewOf(w, bot, agent);
    expect(v.dye).toBeUndefined();
    expect(v.craftRecipe).not.toBe(G.gameplayDefs(w).recipeId("dye"));
  });
  it("a bot with a brush, berries and un-dyed hair gets exactly one dye craft (never a stockpile)", () => {
    const { w, bot, id, agent } = botSetup();
    putInSlot(w, bot, 16, id("paint_brush"));
    G.addItem(w, bot, id("berries"), 6);
    const v = viewOf(w, bot, agent);
    expect(v.dye).toBeUndefined(); // no dye carried yet: nothing to apply
    expect(v.craftRecipe).toBe(G.gameplayDefs(w).recipeId("dye"));
  });
  it("a bot holding a dye + brush gets a dye action target (its deterministic colour for today)", () => {
    const { w, bot, id, agent } = botSetup();
    putInSlot(w, bot, 16, id("paint_brush"));
    G.addItem(w, bot, id("dye"), 1);
    const v = viewOf(w, bot, agent);
    expect(v.dye).toBeDefined();
    expect(v.dye!.kind).toBe(G.DyeKind.Hair); expect(v.dye!.palette).toBe(G.DyePalette.Hair);
    expect(v.dye!.index).toBeGreaterThanOrEqual(0); expect(v.dye!.index).toBeLessThan(3); // the 3-colour test palette
    expect(v.dye!.index).not.toBe(getAppearance(w, bot)!.primary[slotIndex("hair")]); // never re-dyes the colour it has
    expect(v.craftRecipe).not.toBe(G.gameplayDefs(w).recipeId("dye")); // already carrying one: no more crafting
  });
  it("a bot already wearing today's colour wants nothing (no craft, no dye action)", () => {
    const { w, bot, id, agent } = botSetup();
    putInSlot(w, bot, 16, id("paint_brush"));
    G.addItem(w, bot, id("dye"), 1); G.addItem(w, bot, id("berries"), 6);
    const v1 = viewOf(w, bot, agent); const target = v1.dye!.index;
    // dye to today's colour, then re-sense: the want must clear
    expect(G.dyeApply(w, bot, G.DyeKind.Hair, slotIndex("hair"), G.DyePalette.Hair, target)).toBe(true);
    const v2 = viewOf(w, bot, agent);
    expect(v2.dye).toBeUndefined(); expect(v2.craftRecipe).not.toBe(G.gameplayDefs(w).recipeId("dye"));
  });
});
