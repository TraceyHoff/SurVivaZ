import { describe, it, expect } from "vitest";
import { addItem, Container, ContainerViewers, containerView, defaultDefs, fillContainer, inventoryView, liquidFill, readSlots, spawnPlayer, takeSip, writeSlots } from "../src/index.js";
import { Transform } from "@engine/core";
import { makeWorld } from "./helpers.js";

const d = defaultDefs(); const id = (k: string): number => d.itemId(k);
/** Every fillable liquid container in the data (ItemDef.sips > 0). */
const containers = [...d.items.values()].filter((x) => x.sips > 0);

describe("ADR-290 liquid container fill", () => {
  it("covers every sips > 0 item (raw + boiled water flask / canteen / bottle / waterskin) and nothing else", () => {
    expect(containers.map((x) => x.key).sort()).toEqual(["boiled_canteen", "boiled_water_bottle", "boiled_water_flask", "boiled_waterskin", "canteen", "water_bottle", "water_flask", "waterskin"]);
    const w = makeWorld();
    for (const x of [...d.items.values()]) if (!(x.sips > 0)) expect(liquidFill(w, x.id, 3)).toBeUndefined();
  });
  it.each(containers.map((x) => [x.key, x] as const))("%s: full, partial, near-empty and empty fractions", (_k, def) => {
    const w = makeWorld(); const max = def.sips;
    expect(liquidFill(w, def.id, max)).toEqual({ sips: max, max, frac: 1, liquid: def.boiled ? "boiled_water" : "water" });
    expect(liquidFill(w, def.id, 1)!.frac).toBeCloseTo(1 / max);
    expect(liquidFill(w, def.id, 0)).toMatchObject({ sips: 0, frac: 0 });
    expect(liquidFill(w, def.id, max + 9)!.frac).toBe(1); expect(liquidFill(w, def.id, -2)!.frac).toBe(0); // clamped
  });
  it("inventoryView carries the authoritative fill and tracks sips / refill (gameplay unchanged)", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0 }); addItem(w, p, id("canteen"), 1); addItem(w, p, id("wood"), 3);
    const slot = inventoryView({ world: w, player: p }).find((s) => s.item === id("canteen"))!.slot;
    const fill = (): ReturnType<typeof liquidFill> => inventoryView({ world: w, player: p }).find((s) => s.slot === slot)!.fill;
    const start = readSlots(w, p).durability(slot); expect(fill()!.sips).toBe(start); expect(fill()!.max).toBe(6);
    // force full, then drink down one sip at a time
    const v = readSlots(w, p); v.put(slot, v.item(slot), 1, v.created(slot), 6); writeSlots(w, p, v, d);
    expect(fill()).toMatchObject({ sips: 6, frac: 1 });
    expect(takeSip(w, p, slot)).toBe(true); expect(fill()).toMatchObject({ sips: 5 });
    for (let i = 0; i < 4; i++) takeSip(w, p, slot); expect(fill()).toMatchObject({ sips: 1 }); expect(fill()!.frac).toBeCloseTo(1 / 6);
    takeSip(w, p, slot); expect(fill()).toMatchObject({ sips: 0, frac: 0 }); expect(takeSip(w, p, slot)).toBe(false);
    expect(fillContainer(w, p, slot)).toBe(6); expect(fill()).toMatchObject({ sips: 6, frac: 1 });
    expect(inventoryView({ world: w, player: p }).find((s) => s.item === id("wood"))!.fill).toBeUndefined();
  });
  it("containerView (open storage grid) carries the same fill", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0 }); const box = w.create();
    w.add(box, Transform, { x: 0.5, y: 0, z: 0 }).add(box, Container, { slotCount: 4 }).add(box, ContainerViewers);
    const v = readSlots(w, box); v.put(0, id("boiled_water_flask"), 1, 0, 1); v.put(1, id("stone"), 2, 0, 0); writeSlots(w, box, v, d);
    const cv = containerView({ world: w, player: p }, box)!;
    expect(cv.slots[0]!.fill).toEqual({ sips: 1, max: 4, frac: 0.25, liquid: "boiled_water" }); expect(cv.slots[1]!.fill).toBeUndefined(); expect(cv.slots[2]!.fill).toBeUndefined();
  });
});
