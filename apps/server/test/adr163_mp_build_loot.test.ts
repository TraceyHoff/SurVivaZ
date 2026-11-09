import { describe, it, expect } from "vitest";
import { PlayerId, Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { ClaimAccount, MemoryWorldStore } from "@engine/persist";
import { createGameServer, applyMoveInput, installDemoWorld, gameplayNet, onGameplayRejected, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";
import { GAMEPLAY_NET_COMMANDS } from "../src/protocol.js";

const d = G.defaultDefs();
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
  [...w.query([comp, Transform])].filter((e) => { const t = w.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y) < 0.3; });
const pieceAt = (w: World, key: string, x: number, y: number) => near(w, x, y, G.BuildPiece).find((e) => w.getField(e, G.BuildPiece, "type") === d.pieceId(key));

describe("ADR-163 build-mode piece actions over the network", () => {
  it("every target-bearing build command is bridged and maps target as an entity", () => {
    for (const c of [G.DemolishCmd, G.UpgradeCmd, G.RepairCmd, G.ToggleDoorCmd, G.LockDoorCmd]) {
      const b = GAMEPLAY_NET_COMMANDS.find((x) => x.core === c); expect(b, c.name).toBeDefined();
      expect(b!.net.entityFields).toEqual(["target"]);
    }
  });

  it("two clients: labels, bare-hand loot, vase on table with rotation, and demolishing the table drops the vase on both", async () => {
    const { gs, tick, connect } = await connect2(); const w = gs.world;
    const A = await connect(); const B = await connect(); tick(5);
    const a0 = w.get(A.e, Transform)!; const X = Math.floor(a0.x) + 3.5, Y = Math.floor(a0.y) + 0.5;
    w.set(B.e, Transform, { x: X - 2, y: Y, z: 0 }); w.set(A.e, Transform, { x: X - 1.5, y: Y, z: 0 }); tick(10);
    // loot label + bare-hand loot (A drops, B takes with an empty hand)
    const bag = G.dropItem(w, A.e, d.itemId("wood"), 4) ?? (() => { G.addItem(w, A.e, d.itemId("wood"), 4); return G.dropItem(w, A.e, d.itemId("wood"), 4)!; })();
    // Only death bags get the owner-only window (Task 4: voluntarily dropped stacks are lootable immediately),
    // so this scenario exercises the window with a death bag: same owner and contents, kind flipped to Death.
    w.set(bag, G.LootBag, { ...w.get(bag, G.LootBag)!, kind: G.LootSource.Death });
    tick(5);
    const bt = w.get(bag, Transform)!; const rb = near(B.c.world, bt.x, bt.y, G.LootBag)[0]!;
    expect(rb).toBeDefined(); expect(B.c.world.get(rb, G.LootSummary)).toMatchObject({ item: d.itemId("wood"), count: 4 });
    expect(near(A.c.world, bt.x, bt.y, G.LootBag)).toHaveLength(1);
    const rej: string[] = []; onGameplayRejected(B.c, (r) => rej.push(r.reason)); onGameplayRejected(A.c, (r) => rej.push(r.reason));
    expect(w.getField(B.e, G.Equipment, "mainHandItem") ?? 0).toBe(0);
    B.c.sendCommand(gameplayNet(G.OpenContainerCmd), { target: rb } as never); tick(3);
    B.c.sendCommand(gameplayNet(G.WithdrawCmd), { target: rb, item: 0, count: 0 } as never); tick(5);
    expect(G.countItem(w, B.e, d.itemId("wood"))).toBe(0); // owner-only window (PVP.bagOwnerOnlySeconds): B is refused
    const ra = near(A.c.world, bt.x, bt.y, G.LootBag)[0]!; expect(w.getField(A.e, G.Equipment, "mainHandItem") ?? 0).toBe(0);
    A.c.sendCommand(gameplayNet(G.OpenContainerCmd), { target: ra } as never); tick(3);
    A.c.sendCommand(gameplayNet(G.WithdrawCmd), { target: ra, item: 0, count: 0 } as never); tick(5);
    expect(G.countItem(w, A.e, d.itemId("wood"))).toBe(4); expect(near(B.c.world, bt.x, bt.y, G.LootBag)).toHaveLength(1); // ADR-238: emptied bag fades for emptiedSeconds
    tick(20 * (G.DESPAWN.emptiedSeconds + 1)); expect(near(B.c.world, bt.x, bt.y, G.LootBag)).toHaveLength(0); // ... then vanishes for B too
    // floor + table placed by the server; vase placed by A over the net with rot 1
    for (const k of ["foundation"]) { const sn = G.snapPlacement(w, { piece: d.pieceId(k)!, x: X, y: Y, level: 0, rot: 0, tier: 1, variant: 0 }) as G.Snapped; G.placePiece(w, 0, sn, { pay: false }); }
    { const sn = G.snapPlacement(w, { piece: d.pieceId("table")!, x: X, y: Y, level: 0, rot: 0, tier: 1, variant: 0 }) as G.Snapped; G.placePiece(w, 0, sn, { pay: false }); }
    { // ADR-310: A plants a Claim Flag over the net so the vase (a base piece) may go down
      const flag = d.pieces.get(d.pieceId("claim_totem"))!; for (const c of G.pieceCost(d, flag, flag.fixedTier)) G.addItem(w, A.e, c.item, c.count);
      tick(3); A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: flag.id, x: X - 3, y: Y + 2.5, level: 0, rot: 0, tier: flag.fixedTier, variant: 0 } as never); tick(8);
      expect(G.hasOwnClaim(w, A.e, X, Y), `flag rej ${rej}`).toBe(true);
    }
    for (const c of G.pieceCost(d, d.pieces.get(d.pieceId("vase")!)!, 1)) G.addItem(w, A.e, c.item, c.count * 2);
    tick(5);
    A.c.sendCommand(gameplayNet(G.PlaceCmd), { piece: d.pieceId("vase")!, x: X, y: Y, level: 0, rot: 1, tier: 1, variant: 0 } as never); tick(8);
    const vase = pieceAt(w, "vase", X, Y)!; expect(vase, `rej ${rej}`).toBeDefined();
    const zTop = w.get(vase, Transform)!.z; expect(zTop).toBeGreaterThan(0.79);
    for (const cw of [A.c.world, B.c.world]) {
      const v = pieceAt(cw, "vase", X, Y)!; expect(v).toBeDefined();
      const tz = cw.get(pieceAt(cw, "table", X, Y)!, Transform)!.z; const tzS = w.get(pieceAt(w, "table", X, Y)!, Transform)!.z;
      expect(Math.abs(cw.get(v, Transform)!.z - tz - (zTop - tzS))).toBeLessThan(0.03); // replicated Transform.z is quantized
      expect(cw.getField(v, G.BuildPiece, "rot")).toBe(1);
    }
    // A demolishes the table through the client command path (client replica entity -> NetId -> server entity)
    const rt = pieceAt(A.c.world, "table", X, Y)!; expect(rt).toBeDefined();
    A.c.sendCommand(gameplayNet(G.DemolishCmd), { target: rt } as never); tick(10);
    expect(rej).toEqual([]);
    expect(pieceAt(w, "table", X, Y)).toBeUndefined(); const zFloor = w.get(vase, Transform)!.z; expect(zFloor).toBeLessThan(zTop - 0.7);
    for (const cw of [A.c.world, B.c.world]) {
      expect(pieceAt(cw, "table", X, Y)).toBeUndefined();
      expect(Math.abs(cw.get(pieceAt(cw, "vase", X, Y)!, Transform)!.z - zFloor)).toBeLessThan(0.03);
    }
  });
});
const connect2 = setup;
