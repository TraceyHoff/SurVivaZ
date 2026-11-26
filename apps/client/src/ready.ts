/**
 * Task 14: the second loading screen's dismissal condition. The world counts as loaded when the session is
 * connected, the player entity is spawned, and the full 5x5 chunk block around the player has streamed in.
 * ADR-544: the gate was 3x3 (9 chunks) while the server keeps a 5x5 active set (ChunkManager loadRadius 2),
 * so the screen lifted with the outer ring of the player's own view still missing — the overlay lifted onto
 * an unfinished world by design. A bounded fallback (30 s, or a failed connection) dismisses the screen
 * anyway rather than soft-locking — the server still gates vitals until it hears gameplay.ready, so a slow
 * load costs waiting, not hunger.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { chunkKeyOf } from "@engine/world";

export const READY_TIMEOUT_MS = 30000;
export const READY_POLL_MS = 100;
/** ADR-544: chunk radius the ready gate waits for — matches the server ChunkManager loadRadius (2). */
export const READY_RADIUS_CHUNKS = 2;
/** ADR-544: chunks in the ready block: (2 * READY_RADIUS_CHUNKS + 1)^2 = 25. */
export const READY_CHUNK_COUNT = (2 * READY_RADIUS_CHUNKS + 1) ** 2;
/** Minimal session shape the readiness check needs (structural, so tests can fake it). */
export interface ReadySessionLike {
  status: string;
  world: World | undefined;
  player: Entity | undefined;
  client: { tiles: { tiles: { getChunkByKey(key: string): unknown } } } | undefined;
}
const CHUNK = 32;
/** Fraction of the 5x5 chunk block around the player that has arrived (0 when there is no player yet). */
export function readyFraction(s: ReadySessionLike): number {
  if (!s.world || s.player === undefined || !s.client) return 0;
  const t = s.world.get(s.player, Transform); if (!t) return 0;
  let have = 0;
  for (let dx = -READY_RADIUS_CHUNKS; dx <= READY_RADIUS_CHUNKS; dx++) for (let dy = -READY_RADIUS_CHUNKS; dy <= READY_RADIUS_CHUNKS; dy++) if (s.client.tiles.tiles.getChunkByKey(chunkKeyOf(t.x + dx * CHUNK, t.y + dy * CHUNK))) have++;
  return have / READY_CHUNK_COUNT;
}
/** Connected + player spawned + all 25 chunks around the player present. */
export function isWorldReady(s: ReadySessionLike): boolean {
  return s.status === "connected" && readyFraction(s) >= 1;
}
/**
 * Poll until ready (true), the connection fails (false), or the timeout elapses (false). Progress reports
 * the chunk fraction so the loading screen's bar can track the real stream-in.
 */
export function waitForWorldReady(s: ReadySessionLike, opts: { timeoutMs?: number; pollMs?: number; onProgress?: (f: number) => void } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS, pollMs = opts.pollMs ?? READY_POLL_MS;
  return new Promise((ok) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const f = readyFraction(s); opts.onProgress?.(f);
      if (isWorldReady(s)) { clearInterval(iv); ok(true); }
      else if (s.status === "error" || s.status === "disconnected" || Date.now() - t0 > timeoutMs) { clearInterval(iv); ok(false); }
    }, pollMs);
  });
}
