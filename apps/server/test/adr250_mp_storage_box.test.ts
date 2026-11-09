// ADR-250: a Basic Storage Box placed by a fresh (unskilled) player over the network replicates to everyone; a second
// player deposits/withdraws through the same net container commands; Pick up (Demolish) drops the contents for both.
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

describe("ADR-250 basic storage box over the network", () => {
  it("fresh player places it; both clients see it; the other player stores + takes; pick up drops the contents on both", async () => {
    const { gs, tick, connect } = await setup(); const w = gs.world;
    const A = await connect(); const B = await connect(); tick(5);
    const a0 = w.get(A.e, Transform)!; const X = Math.floor(a0.x) + 2.5, Y = Math.floor(a0.y) + 0.5;
    w.set(A.e, Transform, { x: X - 1.5, y: Y, z: 0 }); w.set(B.e, Transform, { x: X - 1.5, y: Y + 1, z: 0 }); tick(10);
    const rej: string[] = []; onGameplayRejected(A.c, (r) => rej.push(`A:${r.reason}`)); onGameplayRejected(B.c, (r) => rej.push(`B:${r.reason}`));
    expect(G.pieceUnlocked(w, A.e, d.pieces.get(d.pieceId("workbench"))!, 1)).toBe(false); // nothing learned
    // ADR-310: a fresh player plants a Claim Flag (ungated) over the net before any base piece. ADR-207: storage inside a
    // claim opens only for the claim's tribe, so B shares A's clan to keep exercising "the other player stores + takes".
    for (const e of [A.e, B.e]) { if (w.has(e, G.Tribe)) w.setField(e, G.Tribe, "id", 7); else w.add(e, G.Tribe, { id: 7 }); }
    const flag = d.pieces.get(d.pieceId("claim_totem"))!;
    for (const c of G.pieceCost(d, flag, flag.fixedTier)) G.addItem(w, A.e, c.item, c.count);
    tick(3);
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: flag.id, x: X - 3.5, y: Y + 2, level: 0, rot: 0, tier: flag.fixedTier, variant: 0 } as never); tick(8);
    expect(G.hasOwnClaim(w, A.e, X, Y), `flag rej ${rej}`).toBe(true);
    for (const c of G.pieceCost(d, d.pieces.get(d.pieceId(KEY))!, 1)) G.addItem(w, A.e, c.item, c.count);
    tick(3);
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: d.pieceId(KEY), x: X, y: Y, level: 0, rot: 2, tier: 1, variant: 0 } as never); tick(8);
    const box = boxAt(w, X, Y)!; expect(box, `rej ${rej}`).toBeDefined(); expect(rej).toEqual([]);
    for (const cw of [A.c.world, B.c.world]) { const r = boxAt(cw, X, Y)!; expect(r).toBeDefined(); expect(cw.getField(r, G.BuildPiece, "rot")).toBe(2); }
    // B (not the builder) deposits stone, A withdraws part of it — same commands the container panel sends
    G.addItem(w, B.e, it_("stone"), 9); tick(3);
    const rb = boxAt(B.c.world, X, Y)!;
    B.c.sendCommand(gameplayNet(G.OpenContainerCmd), { target: rb } as never); tick(3);
    B.c.sendCommand(gameplayNet(G.DepositCmd), { target: rb, item: it_("stone"), count: 9 } as never); tick(3);
    B.c.sendCommand(gameplayNet(G.CloseContainerCmd), { target: rb } as never); tick(3);
    const st = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
    expect([G.countItem(w, st, it_("stone")), G.countItem(w, B.e, it_("stone"))]).toEqual([9, 0]);
    const ra = boxAt(A.c.world, X, Y)!;
    A.c.sendCommand(gameplayNet(G.OpenContainerCmd), { target: ra } as never); tick(3);
    A.c.sendCommand(gameplayNet(G.WithdrawCmd), { target: ra, item: it_("stone"), count: 4 } as never); tick(3);
    expect([G.countItem(w, st, it_("stone")), G.countItem(w, A.e, it_("stone"))]).toEqual([5, 4]);
    // pick up: refund to A, box gone on both clients, a loot bag with the 5 stone on both
    A.c.sendCommand(gameplayNet(G.DemolishCmd), { target: ra } as never); tick(10);
    expect(rej).toEqual([]); expect(boxAt(w, X, Y)).toBeUndefined();
    expect(G.countItem(w, A.e, it_("sticks"))).toBe(10);
    for (const cw of [A.c.world, B.c.world]) {
      expect(boxAt(cw, X, Y)).toBeUndefined();
      const [bag] = near(cw, X, Y, G.LootBag); expect(bag).toBeDefined(); expect(cw.get(bag!, G.LootSummary)).toMatchObject({ item: it_("stone"), count: 5 });
    }
  });
});
