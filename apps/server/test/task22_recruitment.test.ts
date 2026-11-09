import { describe, it, expect } from "vitest";
import { installPermissions, Membership, PlayerId, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { decodePlayerInto, encodePlayer } from "@engine/persist";
import { GAMEPLAY_NET_COMMANDS } from "../src/protocol.js";
import { gameModeConfig } from "../src/game.js";
import { parseServerArgs } from "../src/main.js";

/** Minimal hire setup (mirrors packages/gameplay/test/task22_recruitment.test.ts). */
const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const mkPlayer = (w: World, x: number, y: number, id: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id }); pid(w, e, id); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
const mkWorld = (): World => { const w = new World(); G.installGameplay(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w); return w; };

const bridged = new Set(GAMEPLAY_NET_COMMANDS.map((x) => x.core));

describe("Task 22: AI-human recruitment (server)", () => {
  it("worker commands are bridged with their entity fields", () => {
    for (const c of G.WORKER_COMMANDS) expect(bridged.has(c)).toBe(true);
    expect(GAMEPLAY_NET_COMMANDS.find((x) => x.core === G.HireWorkerCmd)!.net.entityFields).toEqual(["target"]);
    expect(GAMEPLAY_NET_COMMANDS.find((x) => x.core === G.SetWorkerJobCmd)!.net.entityFields).toEqual(["worker", "target"]);
    expect(GAMEPLAY_NET_COMMANDS.find((x) => x.core === G.DismissWorkerCmd)!.net.entityFields).toEqual(["worker"]);
    // worker commands sit just before the dye commands at the tail (append-only, wire indices stable);
    // Task 25 appended DyeCmd after them, so the tail is worker + dye, in that order.
    const tail = GAMEPLAY_NET_COMMANDS.slice(-(G.WORKER_COMMANDS.length + G.DYE_COMMANDS.length + G.TERRAIN_COMMANDS.length + G.HOTBAR_COMMANDS.length + G.RECLAIM_COMMANDS.length + G.MOVE_COMMANDS.length));
    expect(tail.map((x) => x.core)).toEqual([...G.WORKER_COMMANDS, ...G.DYE_COMMANDS, ...G.TERRAIN_COMMANDS, ...G.HOTBAR_COMMANDS.map(([d]) => d), ...G.RECLAIM_COMMANDS.map(([d]) => d), ...G.MOVE_COMMANDS.map(([d]) => d)]);
  });
  it("gameModeConfig: human bots in singleplayer, and in multiplayer only when AI humans are on", () => {
    expect(gameModeConfig("singleplayer", true, true).humanBots).toBe(true);
    expect(gameModeConfig("singleplayer", true, false).humanBots).toBe(true);
    expect(gameModeConfig("multiplayer", true, true).humanBots).toBe(true);
    expect(gameModeConfig("multiplayer", true, false).humanBots).toBe(false);
    expect(gameModeConfig("multiplayer", false, true).humanBots).toBe(false);
    expect(gameModeConfig("multiplayer").humanBots).toBe(true); // defaults: want bots, AI humans on
  });
  it("dedicated server: --ai-humans / --no-ai-humans and AI_HUMANS env", () => {
    expect(parseServerArgs([], {}).aiHumans).toBe(true);
    expect(parseServerArgs(["--no-ai-humans"], {}).aiHumans).toBe(false);
    expect(parseServerArgs(["--ai-humans"], { AI_HUMANS: "0" }).aiHumans).toBe(true);
    expect(parseServerArgs([], { AI_HUMANS: "0" }).aiHumans).toBe(false);
    expect(parseServerArgs([], { AI_HUMANS: "false" }).aiHumans).toBe(false);
  });
  it("worker reject reasons include ai_humans_off (hire gate reads WorldRules)", () => {
    // the hire gate itself is covered in packages/gameplay/test/task22_recruitment.test.ts (setWorldRules off -> AiHumansOff)
    expect(G.WORKER_REJECT_REASONS).toContain("ai_humans_off");
  });
  it("recruited AI state persists across save/load (owner, job, wanted item)", () => {
    // Moved here from the gameplay test: the player codec lives in @engine/persist,
    // which gameplay must not depend on (persist itself depends on gameplay — a cycle).
    // This package declares @engine/persist, so the round-trip lives here.
    const w = mkWorld();
    const p = mkPlayer(w, 0, 0, 7); const bot = mkPlayer(w, 2, 0, 9);
    G.setAiHumanPredicate(w, (e) => e === bot);
    G.ensureWorker(w, bot);
    const item = w.get(bot, G.Worker)!.wantedItem;
    G.addItem(w, p, item, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
    const wanted = w.get(bot, G.Worker)!.wantedItem;
    const bytes = encodePlayer(w, bot);
    const w2 = mkWorld();
    const bot2 = mkPlayer(w2, 0, 0, 9);
    const r = decodePlayerInto(w2, bot2, bytes);
    expect(r.restored).toContain("Worker");
    const wk = w2.get(bot2, G.Worker)!;
    expect(wk.owner).toBe(7); expect(wk.job).toBe(G.WorkerJob.Defend); expect(wk.wantedItem).toBe(wanted);
  });
});
