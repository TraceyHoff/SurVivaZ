// @vitest-environment jsdom
// Main-menu "Delete progress" picker (ADR-099) + camera zoom defaults (ADR-100).
import { describe, expect, test } from "vitest";
// @ts-expect-error untyped relative path into persist's dev dependency
import { IDBFactory } from "../../../packages/persist/node_modules/fake-indexeddb/build/esm/index.js";
import { IndexedDbWorldStore } from "@engine/persist";
import { AGENT_RECORDS_NS, deleteLocalProgress, hostDbName, lastPlayedKey, listLocalSaves, localDbName } from "../src/delete-progress.js";
import { DESKTOP_ZOOM, LEGACY_ZOOM, USER_ZOOM_MAX, USER_ZOOM_MIN, attachZoom, defaultZoom, loadUserZoom } from "../src/camera-zoom.js";

const bytes = new Uint8Array([1, 2, 3]);
async function seed(factory: IDBFactory, name: string, players: string[], bots: number): Promise<void> {
  const s = await IndexedDbWorldStore.open(name, { factory });
  await s.write({ chunks: [{ key: "0,0" as never, format: 1, bytes, tick: 1 }], players: players.map((token) => ({ token, name: token, format: 1, bytes, tick: 1 })),
    records: Array.from({ length: bots }, (_, i) => ({ ns: AGENT_RECORDS_NS, id: `b${i}`, format: 1, bytes, tick: 1, ownerKind: 0, ownerId: 0, chunk: "" as const })) });
  await s.close();
}
const counts = async (factory: IDBFactory, name: string) => { const s = await IndexedDbWorldStore.open(name, { factory }); try { return { players: s.playerTokens().length, bots: s.listRecords(AGENT_RECORDS_NS).length, chunks: s.count("chunks") }; } finally { await s.close(); } };
const names = async (f: IDBFactory): Promise<string[]> => (await f.databases()).map((d: { name: string }) => d.name);

describe("Delete progress picker", () => {
  test("lists what's on the device without creating DBs", async () => {
    const factory = new IDBFactory(); localStorage.clear();
    const list = await listLocalSaves({ slot: "1", factory });
    expect(list.map((s) => s.present)).toEqual([false, false, false, false, false]);
    expect(await names(factory)).toEqual([]);
    await seed(factory, localDbName("1"), ["aa"], 2); await seed(factory, hostDbName("1"), ["bb", "cc"], 0);
    localStorage.setItem("engine-settings", "{\"bots\":3}"); localStorage.setItem(lastPlayedKey("singleplayer", "1"), String(Date.now() - 5 * 60000));
    const l2 = await listLocalSaves({ slot: "1", factory });
    expect(l2.every((s) => s.present)).toBe(true);
    expect(l2[0]!.detail).toContain("5 min ago"); expect(l2[2]!.detail).toContain("3 saved characters"); expect(l2[3]!.detail).toContain("2 bots");
  });
  test("character + bots only keeps the worlds; everything wipes all incl. identity", async () => {
    const factory = new IDBFactory(); localStorage.clear();
    await seed(factory, localDbName("1"), ["aa"], 2); await seed(factory, hostDbName("1"), ["bb"], 0);
    await seed(factory, localDbName("2"), ["zz"], 1); await seed(factory, hostDbName("2"), ["yy"], 0); // ADR-526: a second slot
    localStorage.setItem("engine-settings", "{}"); localStorage.setItem("engine.account.1", "tok"); localStorage.setItem("engine.account.2", "other");
    const r = await deleteLocalProgress({ slot: "1", factory, kinds: new Set(["character", "bots"]) });
    expect(r.ok).toBe(true);
    expect(await counts(factory, localDbName("1"))).toEqual({ players: 0, bots: 0, chunks: 1 });
    expect((await counts(factory, hostDbName("1"))).players).toBe(0);
    expect((await counts(factory, localDbName("2"))).players).toBe(1); // per-category delete is slot-scoped
    expect(localStorage.getItem("engine-settings")).toBe("{}");
    expect((await deleteLocalProgress({ slot: "1", factory, kinds: new Set() })).ok).toBe(false);
    const all = await deleteLocalProgress({ slot: "1", factory, kinds: new Set(), everything: true, blockedMs: 500 });
    expect(all.ok).toBe(true); expect(await names(factory)).toEqual([]);
    expect(localStorage.getItem("engine-settings")).toBeNull(); expect(localStorage.getItem("engine.account.1")).toBeNull();
    expect(localStorage.getItem("engine.account.2")).toBeNull(); // ADR-526: everything wipes ALL slots now
  });
});

describe("camera zoom (ADR-100)", () => {
  test("desktop shows ~30% more area than the old 1.6, phones zoom out less, user zoom clamps + persists", () => {
    expect((LEGACY_ZOOM / defaultZoom(1920, 1080)) ** 2).toBeCloseTo(1.3 / 1.1 ** 2, 2); // ADR-206: default ~10% closer than ADR-100
    expect(defaultZoom(390, 844)).toBeLessThan(DESKTOP_ZOOM);
    localStorage.setItem("engine-settings", "{\"bots\":5}");
    const el = document.createElement("canvas"); const cam = { zoom: 0 };
    const z = attachZoom(cam, el, { viewport: () => ({ w: 1920, h: 1080 }) });
    expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM);
    for (let i = 0; i < 50; i++) el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
    expect(z.user).toBe(USER_ZOOM_MIN);
    for (let i = 0; i < 50; i++) dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));
    expect(z.user).toBe(USER_ZOOM_MAX); expect(cam.zoom).toBeCloseTo(DESKTOP_ZOOM * USER_ZOOM_MAX);
    z.setUser(1.2); z.dispose();
  });
  test("persisted zoom merges into settings", async () => {
    localStorage.setItem("engine-settings", "{\"bots\":5}");
    const z = attachZoom({ zoom: 0 }, document.createElement("div"), { viewport: () => ({ w: 1000, h: 1000 }) });
    z.setUser(1.25); await new Promise((r) => setTimeout(r, 350)); z.dispose();
    expect(JSON.parse(localStorage.getItem("engine-settings")!)).toEqual({ bots: 5, zoom: 1.25 }); expect(loadUserZoom()).toBe(1.25);
  });
});
