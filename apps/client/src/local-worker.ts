/**
 * Singleplayer authoritative server inside a dedicated Web Worker (ADR-105). Runs createLocalServer (sim, population,
 * virtual-player bots, IndexedDB persistence) off the main thread so phones keep the render/input thread free. The main
 * thread talks to it through local-bridge.ts; each main-side client transport maps to one loopback client in here.
 */
import type { ClientTransport } from "@engine/net";
import { catalogFromSnapshot } from "./catalog-snapshot.js";
import { createLocalServer, localStatus, openBrowserStore, type LocalServer } from "./local.js";
import type { FromWorker, ToWorker } from "./local-worker-protocol.js";

const scope = globalThis as unknown as { postMessage(m: FromWorker): void; onmessage: ((ev: { data: ToWorker }) => void) | null };
const post = (m: FromWorker): void => scope.postMessage(m);
const status = (): void => post({ t: "status", state: localStatus.state, store: localStatus.store, error: localStatus.error });

let local: LocalServer | undefined;
const clients = new Map<number, ClientTransport>();
const pending: ToWorker[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;

function loop(): void {
  const now = performance.now(); const dt = Math.min(now - last, 250); last = now;
  try { local?.pump(dt); } catch (e) { post({ t: "log", msg: `pump error: ${e instanceof Error ? e.stack ?? e.message : String(e)}` }); }
  timer = setTimeout(loop, 8);
}

function handle(m: ToWorker): void {
  if (m.t === "init") { void init(m.init); return; }
  if (!local) { pending.push(m); return; }
  switch (m.t) {
    case "connect": {
      const tr = local.createTransport(); clients.set(m.cid, tr);
      tr.onMessage((bytes, ch) => post({ t: "msg", cid: m.cid, bytes, ch }));
      tr.onClose(() => { clients.delete(m.cid); post({ t: "closed", cid: m.cid }); });
      void tr.connect().then(() => post({ t: "connected", cid: m.cid }), (e: unknown) => { post({ t: "log", msg: `connect failed: ${String(e)}` }); post({ t: "closed", cid: m.cid }); });
      break;
    }
    case "send": clients.get(m.cid)?.send(m.bytes, m.ch); break;
    case "close": clients.get(m.cid)?.close(); break;
    case "save": void Promise.resolve(local.game.persist?.saveAll()).then(() => post({ t: "done", req: m.req }), (e: unknown) => post({ t: "done", req: m.req, error: String(e) })); break;
    case "stop": {
      if (timer !== undefined) clearTimeout(timer); timer = undefined;
      const l = local; void l.stop().then(() => post({ t: "done", req: m.req }), (e: unknown) => post({ t: "done", req: m.req, error: String(e) }));
      break;
    }
  }
}

async function init(i: Parameters<typeof handle>[0] extends infer T ? T extends { t: "init"; init: infer I } ? I : never : never): Promise<void> {
  try {
    localStatus.state = "opening-store"; status();
    const store = await openBrowserStore(i.dbName); status();
    localStatus.state = "starting"; status();
    local = await createLocalServer({ store, bots: i.bots, ...(i.devSandbox ? { devSandbox: true } : {}), ...(i.worldRules ? { worldRules: i.worldRules } : {}), ...(i.catalog && i.catalog.size ? { catalog: catalogFromSnapshot(i.catalog) } : {}), ...(i.seed !== undefined ? { seed: i.seed } : {}), ...(i.spawnIndex !== undefined ? { spawnIndex: i.spawnIndex } : {}), log: (msg) => post({ t: "log", msg }) });
    last = performance.now(); loop();
    post({ t: "ready" }); status();
    for (const m of pending.splice(0)) handle(m);
  } catch (e) { post({ t: "fail", error: e instanceof Error ? e.message : String(e) }); }
}

scope.onmessage = (ev) => handle(ev.data);
