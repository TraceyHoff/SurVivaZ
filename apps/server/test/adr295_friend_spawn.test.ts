import { describe, expect, it } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { AccountAssigned, ClaimAccount, MemoryWorldStore, tokenToWords, wordsToToken } from "@engine/persist";
import { createGameServer, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";
import { friendSpawn } from "../src/friend-spawn.js";
import { world215 } from "../../../packages/gameplay/test/nav215_fixture.js";

async function session() {
  const net = new LoopbackNetwork(295), store = new MemoryWorldStore(); let hostId: number | undefined;
  const gs = createGameServer({ transport: net.createServer(), seed: 21, store, population: false, joinNearClient: () => hostId });
  gs.world.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: () => 0 });
  const clients: NetClient[] = [];
  const tick = () => { for (let i = 0; i < 4; i++) { net.advance(50); gs.step(.05); for (const c of clients) { c.world.step(.05); c.pollEvents(Infinity); } } };
  const join = async (token?: string) => {
    const w = new World(); installDemoWorld(w, "client");
    const c = new NetClient({ world: w, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }) });
    let account = ""; c.onEvent(AccountAssigned, p => { account = wordsToToken(p); });
    const connected = c.connect(); await new Promise(r => setTimeout(r, 0)); net.advance(100); await connected; clients.push(c);
    c.sendCommand(ClaimAccount, token ? tokenToWords(token) : { t0: 0, t1: 0, t2: 0, t3: 0 }); tick();
    return { c, entity: gs.players.get(c.clientId)!.entity, account: () => account };
  };
  return { gs, store, tick, join, host: (id: number) => { hostId = id; } };
}

describe("ADR-295 friend room-code arrivals", () => {
  it("a new guest joins beside the selected room host, not another guest or a remote world spawn", async () => {
    const s = await session(), host = await s.join(); s.host(host.c.clientId);
    s.gs.world.set(host.entity, Transform, { x: 500.5, y: 500.5, z: 0 });
    const guest = await s.join(), p = s.gs.world.get(guest.entity, Transform)!;
    expect(Math.hypot(p.x - 500.5, p.y - 500.5)).toBeGreaterThanOrEqual(1.5);
    expect(Math.hypot(p.x - 500.5, p.y - 500.5)).toBeLessThanOrEqual(3);
    const second = await s.join(), q = s.gs.world.get(second.entity, Transform)!;
    expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThanOrEqual(1);
    expect(Math.hypot(q.x - 500.5, q.y - 500.5)).toBeLessThanOrEqual(3);
    await s.gs.shutdown();
  });
  it("saved-position account restoration wins over the provisional near-host spawn", async () => {
    const s = await session(), host = await s.join(); s.host(host.c.clientId);
    const guest = await s.join(); s.gs.world.set(guest.entity, Transform, { x: 120.5, y: 140.5, z: 0 });
    await s.gs.persist!.saveAll(); const token = guest.account(); expect(token).not.toBe("");
    guest.c.close(); s.tick(); s.gs.world.set(host.entity, Transform, { x: 700.5, y: 700.5, z: 0 });
    const rejoined = await s.join(token);
    expect(s.gs.world.get(rejoined.entity, Transform)).toMatchObject({ x: 120.5, y: 140.5 });
    await s.gs.shutdown();
  });
  it("searches beyond solid cells, deep water and occupied tiles", () => {
    const { w, me, put } = world215(); w.set(me, Transform, { x: .5, y: .5, z: 0 });
    const first = friendSpawn(w, me)!; put("foundation", first.x, first.y); put("basic_storage_box", first.x, first.y);
    const second = friendSpawn(w, me)!; expect(second).not.toEqual(first);
    G.spawnPlayer(w, { x: second.x, y: second.y });
    const third = friendSpawn(w, me)!; expect(third).not.toEqual(second);
    // A wide lake rejects the nearby rings, but leaves safe ground within the bounded search.
    w.setResource(G.TerrainRes, { tileAt: (x, y) => Math.abs(x) < 7 && Math.abs(y) < 7 ? 1 : 3, heightAt: () => 0 });
    const shore = friendSpawn(w, me)!; expect(shore).toBeDefined(); expect(G.inDeepWater(w, shore.x, shore.y)).toBe(false);
    expect(Math.hypot(shore.x - .5, shore.y - .5)).toBeGreaterThan(3);
  });
  it("keeps arrivals outside a vehicle footprint when the host is riding", () => {
    const { w, me } = world215(); w.set(me, Transform, { x: .5, y: .5, z: 0 });
    const vehicle = G.spawnVehicle(w, "truck_pickup", .5, .5); w.add(me, G.Driver, { vehicleNetId: 1, seat: 0 });
    const def = G.vehicleDefOf(w, vehicle)!, p = friendSpawn(w, me)!;
    expect(Math.hypot(p.x - .5, p.y - .5)).toBeGreaterThanOrEqual(Math.hypot(def.footprint.length, def.footprint.width) / 2 + G.gameplayDefs(w).movement.bodyRadius);
  });
  it("dead/underground/unsupported hosts use safe ground; an entirely unsafe neighbourhood falls back", () => {
    const { w, me } = world215(); w.set(me, Transform, { x: .5, y: .5, z: -3 }); w.add(me, G.Dead);
    expect(friendSpawn(w, me)!.z).toBe(0);
    w.set(me, Transform, { z: 12 }); expect(friendSpawn(w, me)!.z).toBe(0);
    w.setResource(G.TerrainRes, { tileAt: () => 1, heightAt: () => 0 }); expect(friendSpawn(w, me)).toBeUndefined();
  });
});
