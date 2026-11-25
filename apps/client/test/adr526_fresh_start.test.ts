// @vitest-environment jsdom
// ADR-526 fresh start: "Delete everything" must wipe ALL game data on the device — every ?player slot's worlds,
// every game localStorage key, every game sessionStorage key — while unrelated keys on the origin survive.
// fake-indexeddb is a dev dependency of @engine/persist (same import as delete_picker.test.ts).
import { beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error untyped relative path into persist's dev dependency
import { IDBFactory } from "../../../packages/persist/node_modules/fake-indexeddb/build/esm/index.js";
import { IndexedDbWorldStore } from "@engine/persist";
import { AGENT_RECORDS_NS, deleteLocalProgress, hostDbName, isGameStorageKey, listGameSlots, localDbName } from "../src/delete-progress.js";

const bytes = new Uint8Array([1, 2, 3]);
async function seed(factory: IDBFactory, name: string, players: string[]): Promise<void> {
  const s = await IndexedDbWorldStore.open(name, { factory });
  await s.write({ chunks: [{ key: "0,0" as never, format: 1, bytes, tick: 1 }], players: players.map((token) => ({ token, name: token, format: 1, bytes, tick: 1 })),
    records: [{ ns: AGENT_RECORDS_NS, id: "b0", format: 1, bytes, tick: 1, ownerKind: 0, ownerId: 0, chunk: "" as const }] });
  await s.close();
}
const names = async (f: IDBFactory): Promise<string[]> => (await f.databases()).map((d: { name: string }) => d.name);

class MapStore {
  m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

beforeEach(() => { localStorage.clear(); });

describe("ADR-526 fresh start", () => {
  test("delete everything wipes a second slot's worlds and keys, the server URL, error log / FX / audio / charArt / tutorial keys, and game session keys", async () => {
    const factory = new IDBFactory();
    await seed(factory, localDbName("1"), ["aa"]); await seed(factory, hostDbName("1"), ["bb"]);
    await seed(factory, localDbName("2"), ["zz"]); await seed(factory, hostDbName("2"), ["yy"]);
    const session = new MapStore();
    for (const [k, v] of [
      ["engine-settings", "{}"], ["engine.input.bindings", "{}"], ["survivaz.render.quality", "auto"],
      ["engine-server-url", "wss://example:7777"], ["engine.account.1", "tok1"], ["engine.account.2", "tok2"],
      ["engine.name.2", "Zed"], ["engine.lastPlayed.singleplayer.1", "1"], ["engine.lastPlayed.hosted.2", "2"],
      ["survivaz.character.singleplayer.2", "{}"], ["survivaz-tutorial-1", "3"], ["survivaz-tutorial-2", "1"],
      ["survivaz.errorlog.v1", "[{}]"], ["survivaz.fx.v1", "{}"], ["survivaz.audio.v1", "{}"],
      ["charArt", "v2s"], ["engine-fs-tip", "1"], ["other-app-key", "keep"],
    ] as const) localStorage.setItem(k, v);
    for (const [k, v] of [
      ["survivaz.glLevel", "1"], ["survivaz.glReloads", "0"], ["survivaz.editchar", "1"],
      ["engine-menu-page", "multiplayer"], ["engine-p2p-notice", "hi"], ["other-session", "keep"],
    ] as const) session.setItem(k, v);
    expect(await listGameSlots({ slot: "1", factory })).toEqual(expect.arrayContaining(["1", "2"]));

    const r = await deleteLocalProgress({ slot: "1", factory, session, kinds: new Set(), everything: true, blockedMs: 500 });
    expect(r.ok).toBe(true); expect(r.message).toContain("2 player slots"); expect(r.message).toContain("fresh game");
    expect(await names(factory)).toEqual([]);
    for (const k of ["engine-settings", "engine.input.bindings", "survivaz.render.quality", "engine-server-url",
      "engine.account.1", "engine.account.2", "engine.name.2", "engine.lastPlayed.singleplayer.1", "engine.lastPlayed.hosted.2",
      "survivaz.character.singleplayer.2", "survivaz-tutorial-1", "survivaz-tutorial-2", "survivaz.errorlog.v1",
      "survivaz.fx.v1", "survivaz.audio.v1", "charArt", "engine-fs-tip"]) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem("other-app-key")).toBe("keep"); // unrelated keys survive — never localStorage.clear()
    for (const k of ["survivaz.glLevel", "survivaz.glReloads", "survivaz.editchar", "engine-menu-page", "engine-p2p-notice"]) expect(session.getItem(k)).toBeNull();
    expect(session.getItem("other-session")).toBe("keep");
  });

  test("a per-category delete still only touches its own category and slot", async () => {
    const factory = new IDBFactory();
    await seed(factory, localDbName("1"), ["aa"]); await seed(factory, localDbName("2"), ["zz"]); await seed(factory, hostDbName("2"), ["yy"]);
    localStorage.setItem("engine-settings", "{}"); localStorage.setItem("engine-server-url", "wss://example:7777");
    localStorage.setItem("engine.account.2", "tok2"); localStorage.setItem("survivaz-tutorial-2", "1");
    const r = await deleteLocalProgress({ slot: "1", factory, kinds: new Set(["settings"]) });
    expect(r.ok).toBe(true);
    expect(localStorage.getItem("engine-settings")).toBeNull();
    expect(await names(factory)).toEqual(expect.arrayContaining([localDbName("1"), localDbName("2"), hostDbName("2")])); // worlds kept
    expect(localStorage.getItem("engine-server-url")).toBe("wss://example:7777");
    expect(localStorage.getItem("engine.account.2")).toBe("tok2");
    expect(localStorage.getItem("survivaz-tutorial-2")).toBe("1");
  });

  test("the second slot is still found when IndexedDB databases() is unavailable (slots parsed from storage keys)", async () => {
    const factory = new IDBFactory();
    await seed(factory, localDbName("2"), ["zz"]);
    localStorage.setItem("engine.lastPlayed.singleplayer.2", "2"); localStorage.setItem("survivaz-tutorial-2", "1");
    // A factory without databases(): deleteDatabase still works, enumeration falls back to key parsing.
    const noList = { deleteDatabase: (name: string) => factory.deleteDatabase(name) } as unknown as IDBFactory;
    const r = await deleteLocalProgress({ slot: "1", factory: noList, kinds: new Set(), everything: true, blockedMs: 500 });
    expect(r.ok).toBe(true);
    expect(await names(factory)).toEqual([]);
    expect(localStorage.getItem("engine.lastPlayed.singleplayer.2")).toBeNull();
  });

  test("isGameStorageKey covers the game's namespaces and nothing else", () => {
    for (const k of ["engine-settings", "engine-server-url", "engine.input.bindings", "engine.account.1",
      "survivaz.render.quality", "survivaz.errorlog.v1", "survivaz-tutorial-2", "charArt"]) expect(isGameStorageKey(k)).toBe(true);
    for (const k of ["other-app-key", "myengine.settings", "enginex", "survivazx", ""] ) expect(isGameStorageKey(k)).toBe(false);
  });
});
