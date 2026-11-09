// ADR-317 / ADR-318 over the network: MoveCmd re-slots the same piece on the server (contents kept) and every client's
// replica + structure index follows; a clanmate's Demolish refunds 50%, the builder's 100%; an outsider is refused.
import { describe, it, expect } from "vitest";
import { PlayerId, Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { ClaimAccount, MemoryWorldStore } from "@engine/persist";
import { createGameServer, applyMoveInput, installDemoWorld, gameplayNet, onGameplayRejected, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";

const d = G.defaultDefs(); const KEY = "basic_storage_box"; const it_ = (k: string) => d.itemId(k);
async function setup() {
  const net = new LoopbackNetwork(7);
  const gs = createGameServer({ transport: net.createServer(), store: new MemoryWorldStore(), seed: 5 });
  const clients: NetClient[] = [];
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) { net.advance(50); gs.step(1 / 20); for (const c of clients) { c.world.step(1 / 20); c.pollEvents(Infinity); } } };
  const connect = async () => {
    const world = new World({ seed: 1 }); installDemoWorld(world, "client");
    const c = new NetClient({ world, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }), applyInput: (w, e, cmd) => applyMoveInput(w, e, cmd) });
    const p = c.connect(); await new Promise((r) => setTimeout(r, 0)); net.advance(100); await p; clients.push(c);
    c.sendCommand(ClaimAccount, { t0: 0, t1: 0, t2: 0, t3: 0 }); tick(3);
    const e = gs.players.get(c.clientId!)!.entity; return { c, e, pid: gs.world.getField(e, PlayerId, "id")! };
  };
  return { gs, tick, connect };
}
const near = (w: World, x: number, y: number, comp: typeof G.BuildPiece | typeof G.LootBag): Entity[] =>
  [...w.query([comp, Transform])].filter((e) => { const t = w.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y) < 0.6; });
const boxAt = (w: World, x: number, y: number) => near(w, x, y, G.BuildPiece).find((e) => w.getField(e, G.BuildPiece, "type") === d.pieceId(KEY));

describe("ADR-317/318 over the network", () => {
  it("MoveCmd moves a stocked box for everyone; a foreign MoveCmd / DemolishCmd is rejected; refunds 50% vs 100%", async () => {
    const { gs, tick, connect } = await setup(); const w = gs.world;
    const A = await connect(); const B = await connect(); const C = await connect(); tick(5);
    const a0 = w.get(A.e, Transform)!; const X = Math.floor(a0.x) + 2.5, Y = Math.floor(a0.y) + 0.5;
    w.set(A.e, Transform, { x: X - 1.5, y: Y, z: 0 }); w.set(B.e, Transform, { x: X - 1.5, y: Y + 1, z: 0 }); w.set(C.e, Transform, { x: X - 1.5, y: Y - 1, z: 0 }); tick(10);
    const rej: string[] = []; onGameplayRejected(A.c, (r) => rej.push(`A:${r.reason}`)); onGameplayRejected(B.c, (r) => rej.push(`B:${r.reason}`)); onGameplayRejected(C.c, (r) => rej.push(`C:${r.reason}`));
    for (const e of [A.e, B.e]) { if (w.has(e, G.Tribe)) w.setField(e, G.Tribe, "id", 7); else w.add(e, G.Tribe, { id: 7 }); } // A + B share a clan; C is an outsider
    const flag = d.pieces.get(d.pieceId("claim_totem"))!;
    for (const c of G.pieceCost(d, flag, flag.fixedTier)) G.addItem(w, A.e, c.item, c.count);
    for (const c of G.pieceCost(d, d.pieces.get(d.pieceId(KEY))!, 1)) G.addItem(w, A.e, c.item, c.count * 2);
    tick(3);
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: flag.id, x: X - 3.5, y: Y + 2, level: 0, rot: 0, tier: flag.fixedTier, variant: 0 } as never); tick(8);
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: d.pieceId(KEY), x: X, y: Y, level: 0, rot: 0, tier: 1, variant: 0 } as never); tick(8);
    const box = boxAt(w, X, Y)!; expect(box, `rej ${rej}`).toBeDefined();
    G.addItem(w, G.resolveAttachment(w, box, G.AttachKind.Storage)!, it_("stone"), 6); tick(3);
    // the outsider can neither move nor demolish it (server-validated: nothing changes)
    const rc = boxAt(C.c.world, X, Y)!; expect(rc).toBeDefined();
    C.c.sendCommand(gameplayNet(G.MoveCmd), { target: rc, x: X, y: Y + 1, level: 0, rot: 0 } as never); tick(8);
    C.c.sendCommand(gameplayNet(G.DemolishCmd), { target: rc } as never); tick(8);
    expect(boxAt(w, X, Y)).toBe(box);
    // A moves it one tile: same server entity, contents kept; every replica (and its structure index) follows
    const ra = boxAt(A.c.world, X, Y)!;
    A.c.sendCommand(gameplayNet(G.MoveCmd), { target: ra, x: X, y: Y + 1, level: 0, rot: 1 } as never); tick(10);
    expect(rej.filter((r) => r.startsWith("A:"))).toEqual([]);
    expect(boxAt(w, X, Y)).toBeUndefined(); expect(boxAt(w, X, Y + 1)).toBe(box);
    expect(G.countItem(w, G.resolveAttachment(w, box, G.AttachKind.Storage)!, it_("stone"))).toBe(6);
    for (const cw of [A.c.world, B.c.world, C.c.world]) {
      expect(boxAt(cw, X, Y)).toBeUndefined(); const r = boxAt(cw, X, Y + 1)!; expect(r).toBeDefined(); expect(cw.getField(r, G.BuildPiece, "rot")).toBe(1);
      expect(G.structures(cw).indexedAt(r)?.slot).toMatchObject({ tx: Math.floor(X), ty: Math.floor(Y + 1) });
    }
    // B (clanmate, not the builder) takes down a second box: 50%; A takes down her own: 100%
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: d.pieceId(KEY), x: X, y: Y, level: 0, rot: 0, tier: 1, variant: 0 } as never); tick(8);
    const second = boxAt(B.c.world, X, Y)!; expect(second, `rej ${rej}`).toBeDefined();
    const sticks0 = G.countItem(w, B.e, it_("sticks"));
    B.c.sendCommand(gameplayNet(G.DemolishCmd), { target: second } as never); tick(10);
    expect(boxAt(w, X, Y)).toBeUndefined(); expect(G.countItem(w, B.e, it_("sticks")) - sticks0).toBe(5);
    const aSticks = G.countItem(w, A.e, it_("sticks"));
    A.c.sendCommand(gameplayNet(G.DemolishCmd), { target: boxAt(A.c.world, X, Y + 1)! } as never); tick(10);
    expect(G.countItem(w, A.e, it_("sticks")) - aSticks).toBe(10);
  });
});
