/**
 * Main-thread side of the Web Worker singleplayer server (ADR-105): spawns local-worker.ts and exposes a small
 * handle (createTransport / save / stop). Falls back (returns undefined) when Worker is unavailable, `?worker=0`,
 * or the worker fails / does not come up within `timeoutMs`; the caller then runs createLocalServer in-tab as before.
 */
import type { Channel, ClientTransport } from "@engine/net";
import { snapshotCatalog } from "./catalog-snapshot.js";
import type { CosmeticCatalogLike } from "@engine/core";
import type { FromWorker, ToWorker } from "./local-worker-protocol.js";

export interface LocalServerHandle {
  createTransport(): ClientTransport;
  save(): Promise<void>;
  stop(): Promise<void>;
  readonly inWorker: boolean;
}
export interface WorkerStatusSink { state: string; store: string; error: string | undefined }

class WorkerClientTransport implements ClientTransport {
  private open = false; private msgFns: ((b: Uint8Array, ch: Channel) => void)[] = []; private closeFns: (() => void)[] = [];
  private resolveConnect: (() => void) | undefined;
  constructor(private readonly w: { post(m: ToWorker): void }, readonly cid: number) {}
  get connected(): boolean { return this.open; }
  connect(): Promise<void> { return new Promise((res) => { this.resolveConnect = res; this.w.post({ t: "connect", cid: this.cid }); }); }
  send(bytes: Uint8Array, channel: Channel): void { if (this.open) this.w.post({ t: "send", cid: this.cid, bytes, ch: channel }); }
  onMessage(fn: (b: Uint8Array, ch: Channel) => void): void { this.msgFns.push(fn); }
  onClose(fn: () => void): void { this.closeFns.push(fn); }
  close(): void { if (!this.open) return; this.w.post({ t: "close", cid: this.cid }); this.closed(); }
  /** @internal */ connectedAck(): void { this.open = true; this.resolveConnect?.(); this.resolveConnect = undefined; }
  /** @internal */ deliver(b: Uint8Array, ch: Channel): void { if (this.open) for (const f of this.msgFns) f(b, ch); }
  /** @internal */ closed(): void { if (!this.open) return; this.open = false; for (const f of this.closeFns) f(); }
}

export async function startWorkerServer(o: { dbName: string; bots: number; devSandbox?: boolean; worldRules?: { hordes: boolean; hordeGraceDays: number; aiHumans?: boolean; zombies?: boolean; creative?: boolean }; catalog?: CosmeticCatalogLike | undefined; status: WorkerStatusSink; log?: (s: string) => void; timeoutMs?: number; makeWorker?: () => Worker; /** ADR-254 */ seed?: number; /** ADR-589: the creator's chosen spawn point index */ spawnIndex?: number }): Promise<LocalServerHandle | undefined> {
  if (!o.makeWorker && typeof Worker === "undefined") return undefined;
  let worker: Worker;
  try { worker = o.makeWorker ? o.makeWorker() : new Worker(new URL("./local-worker.ts", import.meta.url), { type: "module" }); } catch (e) { o.log?.(`worker unavailable: ${String(e)}`); return undefined; }
  const post = (m: ToWorker): void => worker.postMessage(m);
  const clients = new Map<number, WorkerClientTransport>(); let nextCid = 1;
  const reqs = new Map<number, { res: () => void; rej: (e: Error) => void }>(); let nextReq = 1;
  const call = (t: "save" | "stop"): Promise<void> => new Promise((res, rej) => { const req = nextReq++; reqs.set(req, { res, rej }); post({ t, req }); });
  let settle: ((ok: boolean, err?: string) => void) | undefined;
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    switch (m.t) {
      case "status": o.status.state = m.state; o.status.store = m.store; o.status.error = m.error; break;
      case "ready": settle?.(true); break;
      case "fail": settle?.(false, m.error); break;
      case "connected": clients.get(m.cid)?.connectedAck(); break;
      case "msg": clients.get(m.cid)?.deliver(m.bytes, m.ch); break;
      case "closed": clients.get(m.cid)?.closed(); clients.delete(m.cid); break;
      case "done": { const r = reqs.get(m.req); reqs.delete(m.req); if (r) { if (m.error) r.rej(new Error(m.error)); else r.res(); } break; }
      case "log": o.log?.(m.msg); break;
    }
  };
  worker.onerror = (ev) => { o.log?.(`worker error: ${ev.message}`); settle?.(false, ev.message || "worker error"); };
  const ok = await new Promise<boolean>((resolve) => {
    const to = setTimeout(() => { o.log?.("worker start timed out"); resolve(false); }, o.timeoutMs ?? 15000);
    settle = (good, err) => { clearTimeout(to); settle = undefined; if (!good && err) o.log?.(`worker failed: ${err}`); resolve(good); };
    let catalog;
    try { catalog = o.catalog ? snapshotCatalog(o.catalog) : undefined; } catch (e) { o.log?.(`catalog snapshot failed: ${String(e)}`); }
    post({ t: "init", init: { dbName: o.dbName, bots: o.bots, ...(o.devSandbox ? { devSandbox: true } : {}), ...(o.worldRules ? { worldRules: o.worldRules } : {}), ...(catalog ? { catalog } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}), ...(o.spawnIndex !== undefined ? { spawnIndex: o.spawnIndex } : {}) } });
  });
  if (!ok) { worker.terminate(); return undefined; }
  return {
    inWorker: true,
    createTransport: () => { const t = new WorkerClientTransport({ post }, nextCid++); clients.set(t.cid, t); return t; },
    save: () => call("save"),
    stop: async () => { try { await call("stop"); } finally { worker.terminate(); } },
  };
}
