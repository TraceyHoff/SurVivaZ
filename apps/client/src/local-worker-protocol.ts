/** Message protocol between the main thread and the singleplayer server Web Worker (ADR-105). */
import type { Channel } from "@engine/net";
import type { CatalogSnapshot } from "./catalog-snapshot.js";

export interface WorkerInit { dbName: string; bots: number; devSandbox?: boolean; catalog?: CatalogSnapshot; worldRules?: { hordes: boolean; hordeGraceDays: number; aiHumans?: boolean; zombies?: boolean; creative?: boolean }; /** ADR-254: optional pinned world seed */ seed?: number }
export type ToWorker =
  | { t: "init"; init: WorkerInit }
  | { t: "connect"; cid: number }
  | { t: "send"; cid: number; bytes: Uint8Array; ch: Channel }
  | { t: "close"; cid: number }
  | { t: "save"; req: number }
  | { t: "stop"; req: number };
export type FromWorker =
  | { t: "status"; state: string; store: string; error: string | undefined }
  | { t: "ready" }
  | { t: "fail"; error: string }
  | { t: "connected"; cid: number }
  | { t: "msg"; cid: number; bytes: Uint8Array; ch: Channel }
  | { t: "closed"; cid: number }
  | { t: "done"; req: number; error?: string }
  | { t: "log"; msg: string };
