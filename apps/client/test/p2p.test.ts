import { Transform } from "@engine/core";
import { TerrainRes } from "@engine/gameplay";
/**
 * P2P loopback e2e: the browser host (createLocalServer, mode "multiplayer") serving guests over an in-memory
 * paired fake data channel (reliable + unreliable with loss/reorder). No real WebRTC.
 */
import { describe, it, expect } from "vitest";
import { FakeRtcNetwork, NetRejectedError, RejectReason, RtcClientTransport, RtcServerTransport, type FakeLinkOptions, type RtcPeerLink } from "@engine/net";
import { MemoryWorldStore } from "@engine/persist";
import { DevBotHello, Ping } from "@engine/server/protocol";
import { ClientSession, HOST_ENDED, type KeyValue } from "../src/session.js";
import { startP2PHost, guestTransport, type P2PHost } from "../src/host.js";
import {
  SignalingError, formatRoomCode, generateRoomCode, hostPlayerCap, normalizeRoomCode, resolveIceServers, roomPeerId,
  DEFAULT_ICE_SERVERS, ROOM_ALPHABET, type Signaling, type SignalingRoom,
} from "../src/p2p.js";

class MapStorage implements KeyValue { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }

/** Signaling over FakeRtcNetwork: same contract as PeerJsSignaling. */
class FakeSignaling implements Signaling {
  rooms = new Map<string, (l: RtcPeerLink) => void>();
  constructor(readonly net: FakeRtcNetwork, readonly link: FakeLinkOptions = {}) {}
  host(code: string): Promise<SignalingRoom> {
    if (this.rooms.has(code)) return Promise.reject(new SignalingError("taken", "taken"));
    const fns: ((l: RtcPeerLink) => void)[] = [];
    this.rooms.set(code, (l) => { for (const f of fns) f(l); });
    return Promise.resolve({ code, onPeer: (f) => fns.push(f), onError: () => {}, close: () => this.rooms.delete(code) });
  }
  join(code: string): Promise<RtcPeerLink> {
    const r = this.rooms.get(code); if (!r) return Promise.reject(new SignalingError("not-found", "No game found with that code."));
    const [guest, host] = this.net.link(this.link); r(host); return Promise.resolve(guest);
  }
}

interface Rig { store: MemoryWorldStore; net: FakeRtcNetwork; sig: FakeSignaling; host: P2PHost; hostSession: ClientSession; guests: ClientSession[] }
async function tick(r: Rig, ms = 50): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    r.net.flush(); r.host.local.pump(50); r.net.flush();
    for (const s of [r.hostSession, ...r.guests]) { s.world?.step(1 / 20); s.poll(); }
    await Promise.resolve(); await Promise.resolve();
  }
}
async function until<T>(r: Rig, p: Promise<T>, maxMs = 3000): Promise<T> {
  let done = false, val: T | undefined, err: unknown; p.then((v) => { done = true; val = v; }, (e: unknown) => { done = true; err = e; });
  for (let t = 0; t < maxMs && !done; t += 50) await tick(r);
  if (err) throw err; if (!done) throw new Error("timeout"); return val as T;
}
async function rig(opts: { cap?: number; link?: FakeLinkOptions; aiHumans?: boolean; seed?: number } = {}): Promise<Rig> {
  const net = new FakeRtcNetwork(3); const sig = new FakeSignaling(net, opts.link);
  let x = 7; const random = (): number => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const store = new MemoryWorldStore();
  const host = await startP2PHost({ signaling: sig, store, seed: opts.seed ?? 9, cap: opts.cap ?? 6, population: false, random, ...(opts.aiHumans === false ? { worldRules: { hordes: true, hordeGraceDays: 3, aiHumans: false } } : {}) });
  const hostSession = new ClientSession({ storage: new MapStorage(), slot: "h", sampleButtons: () => 0 });
  const r: Rig = { store, net, sig, host, hostSession, guests: [] };
  await until(r, hostSession.connect("p2p-host", "Hosty", host.hostTransport));
  host.hostClientId = hostSession.client!.clientId;
  return r;
}
async function join(r: Rig, name: string): Promise<ClientSession> {
  const s = new ClientSession({ storage: new MapStorage(), slot: name, sampleButtons: () => 0 });
  r.guests.push(s);
  await until(r, s.connect(`p2p:${r.host.code}`, name, guestTransport(r.sig, r.host.code)));
  return s;
}
const end = async (r: Rig): Promise<void> => { for (const s of [r.hostSession, ...r.guests]) s.disconnect(); await r.host.leave(); };

describe("room codes, caps, ICE", () => {
  it("codes are 6 unambiguous chars and map to a namespaced peer id", () => {
    for (let i = 0; i < 200; i++) { const c = generateRoomCode(); expect(c).toMatch(/^[2-9A-HJKMNP-Z]{6}$/); expect(normalizeRoomCode(c.toLowerCase())).toBe(c); }
    expect(ROOM_ALPHABET).not.toMatch(/[01ILO]/);
    expect(normalizeRoomCode(" abc-234 ")).toBe("ABC234"); expect(normalizeRoomCode("ABCO23")).toBeUndefined(); expect(normalizeRoomCode("ABC23")).toBeUndefined();
    expect(roomPeerId("ABC234")).toBe("survivaz-v8-ABC234"); expect(formatRoomCode("ABC234")).toBe("ABC-234");
  });
  it("caps mobile hosts at 6 and lets desktop configure a larger cap", () => {
    expect(hostPlayerCap({ coarsePointer: true, uaMobile: undefined }, 20).cap).toBe(6);
    expect(hostPlayerCap({ coarsePointer: false, uaMobile: true }, 20)).toMatchObject({ cap: 6, mobile: true });
    expect(hostPlayerCap({ coarsePointer: false, uaMobile: false }, 20).cap).toBe(20);
    expect(hostPlayerCap({ coarsePointer: false, uaMobile: false }, 999).cap).toBe(32);
  });
  it("ICE servers default to public STUN and accept a TURN override", () => {
    expect(resolveIceServers(undefined)).toBe(DEFAULT_ICE_SERVERS); expect(resolveIceServers("nope")).toBe(DEFAULT_ICE_SERVERS);
    const turn = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
    expect(resolveIceServers(JSON.stringify(turn))).toEqual(turn);
  });
});

describe("RTC transports over the fake paired channel", () => {
  it("routes reliable traffic in order and unreliable traffic on its own lossy/reordering pipe", async () => {
    const net = new FakeRtcNetwork(11); const [g, h] = net.link({ loss: 0.3, reorder: 0.3 });
    const server = new RtcServerTransport(); const got: [string, number][] = [];
    server.onMessage((_c, b, ch) => got.push([ch, b[0]!]));
    server.accept(h);
    const client = new RtcClientTransport(() => Promise.resolve(g)); const c = client.connect(); net.flush(); await c;
    for (let i = 1; i <= 100; i++) { client.send(new Uint8Array([i]), "reliable"); client.send(new Uint8Array([i]), "unreliable"); if (i % 10 === 0) net.flush(); }
    net.flush(); net.flush();
    const rel = got.filter(([ch]) => ch === "reliable").map(([, v]) => v), unr = got.filter(([ch]) => ch === "unreliable").map(([, v]) => v);
    expect(rel).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(unr.length).toBeLessThan(100); expect(net.stats.dropped).toBeGreaterThan(0);
    expect(unr.some((v, i) => i > 0 && v < unr[i - 1]!)).toBe(true); // reordered
  });
  it("host close sends the bye frame: guest closeReason is host-ended; a dropped link is connection-lost", async () => {
    const net = new FakeRtcNetwork(1);
    const server = new RtcServerTransport(); const left: number[] = []; server.onDisconnect((c) => left.push(c));
    const [g1, h1] = net.link(), [g2, h2] = net.link(); server.accept(h1); server.accept(h2);
    const a = new RtcClientTransport(() => Promise.resolve(g1)), b = new RtcClientTransport(() => Promise.resolve(g2));
    const pa = a.connect(), pb = b.connect(); net.flush(); await pa; await pb;
    h2.close(); net.flush(); expect(b.closeReason).toBe("connection-lost");
    server.close(); net.flush(); expect(a.closeReason).toBe("host-ended"); expect(left.sort()).toEqual([1, 2]);
  });
});

describe("P2P host e2e (host-authoritative, loopback data channels)", () => {
  it("guests join, see replicated snapshots, round-trip a command; host lists players; AI humans off, so no human bots", async () => {
    const r = await rig({ link: { loss: 0.1, reorder: 0.2 }, aiHumans: false });
    expect(r.host.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(r.host.local.game.mode).toBe("multiplayer"); expect(r.host.local.game.modeConfig.humanBots).toBe(false); expect(r.host.local.bots).toEqual([]);
    const a = await join(r, "Ana"); const b = await join(r, "Bo");
    await tick(r, 2000);
    expect(a.status).toBe("connected"); expect(a.player).toBeDefined(); expect(b.player).toBeDefined();
    expect(a.client!.stats.snapshots).toBeGreaterThan(5);
    expect(a.client!.latestTick).toBeGreaterThan(0);
    // snapshot replication: Ana's replica holds both guests and the host (all at spawn, in AOI)
    expect(a.world!.entityCount).toBeGreaterThanOrEqual(3);
    const names = r.host.players(); expect(names.length).toBe(3); expect(names[0]).toMatchObject({ host: true, name: "Hosty" });
    expect(names.map((p) => p.name).sort()).toEqual(["Ana", "Bo", "Hosty"]);
    // command round trip: Ping (reliable) -> Pong event
    a.client!.sendCommand(Ping, { t: 1 }); await tick(r, 1500);
    expect(a.rttMs).toBeDefined();
    await end(r);
  });

  it("lists real players, not AI humans, in the shared session roster", async () => {
    const r = await rig();
    try {
      const bot = await join(r, "AI human");
      expect(r.host.local.game.markVirtual(bot.client!.clientId)).toBe(true);
      expect(r.host.players().map((p) => p.name)).toEqual(["Hosty"]);
    } finally { await end(r); }
  });

  it("applies the server's rate limits and dev-bot rejection to guests", async () => {
    const r = await rig();
    const a = await join(r, "Spam"); await tick(r, 300);
    const anomalies: string[] = []; r.host.local.game.net.onAnomaly((_s, kind) => anomalies.push(kind));
    for (let i = 0; i < 20; i++) a.client!.sendCommand(Ping, { t: i });
    await tick(r, 300);
    const s = [...r.host.local.game.net.sessions.values()].find((x) => x.clientId === a.client!.clientId)!;
    expect(s.stats.rateLimited).toBeGreaterThanOrEqual(10); expect(anomalies).toContain("rateLimited");
    // a guest claiming to be a dev bot is kicked (multiplayer host never enables NET_DEV_BOTS)
    const b = await join(r, "Botty"); await tick(r, 300);
    expect(r.host.local.game.players.size).toBe(3);
    b.client!.sendCommand(DevBotHello, { v: 1 }); await tick(r, 500);
    expect(r.host.local.game.players.size).toBe(2);
    await end(r);
  });

  it("rejects joins past the player cap with a clear reason", async () => {
    const r = await rig({ cap: 3 });
    await join(r, "G1"); await join(r, "G2");
    const s = new ClientSession({ storage: new MapStorage(), slot: "x", sampleButtons: () => 0 }); r.guests.push(s);
    const err = await until(r, s.connect("p2p", "G3", guestTransport(r.sig, r.host.code)).then(() => undefined, (e: unknown) => e));
    expect(err).toBeInstanceOf(NetRejectedError);
    expect((err as NetRejectedError).reason).toBe(RejectReason.ServerFull);
    expect((err as Error).message).toContain("3 players max");
    expect(s.status).toBe("error"); expect(r.host.local.game.players.size).toBe(3);
    await end(r);
  });

  it("joining an unknown code fails with a user-facing message", async () => {
    const r = await rig();
    const s = new ClientSession({ storage: new MapStorage(), slot: "x", sampleButtons: () => 0 });
    await expect(s.connect("p2p", "Z", guestTransport(r.sig, "ZZZZZZ"))).rejects.toThrow("No game found");
    await end(r);
  });

  it("host leave ends the session for guests with 'Host ended the session' and saves the world", async () => {
    const r = await rig();
    const a = await join(r, "Ana"); await tick(r, 500);
    const ended: string[] = []; a.onEnded = (d) => ended.push(d);
    const tickBefore = r.store.readMeta()?.tick ?? -1; const live = r.host.local.game.world.tick;
    expect(tickBefore).toBeLessThan(live);
    const leaving = r.host.leave(); r.net.flush(); await leaving; r.net.flush();
    expect(a.status).toBe("disconnected"); expect(a.detail).toBe(HOST_ENDED); expect(ended).toEqual([HOST_ENDED]);
    expect(r.sig.rooms.size).toBe(0);
    expect(r.store.readMeta()?.tick).toBe(live); // world saved through the persistence store on leave
    expect(r.store.count("players")).toBeGreaterThanOrEqual(2);
    r.hostSession.disconnect();
  });
});


// ADR-270: the host chooses one world seed; guests cannot replace it.
it("hosting uses the chosen seed and joining keeps it", async () => {
  const r = await rig({ seed: 424242 });
  try { expect(r.host.local.game.world.seed).toBe(424242); await join(r, "Guest"); expect(r.host.local.game.world.seed).toBe(424242); }
  finally { await end(r); }
});


it("ADR-295 actual room-code guests arrive beside the host", async () => {
  const r = await rig();
  try {
    const w = r.host.local.game.world, host = r.host.local.game.players.get(r.host.hostClientId!)!.entity;
    w.setResource(TerrainRes, { tileAt: () => 3, heightAt: () => 0 });
    w.set(host, Transform, { x: 500.5, y: 500.5, z: 0 });
    const guest = await join(r, "NearFriend"); await tick(r, 300);
    const e = r.host.local.game.players.get(guest.client!.clientId)!.entity, p = w.get(e, Transform)!;
    const distance = Math.hypot(p.x - 500.5, p.y - 500.5);
    expect(distance).toBeGreaterThanOrEqual(1.5); expect(distance).toBeLessThanOrEqual(3);
  } finally { await end(r); }
});
