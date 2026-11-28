/**
 * ADR-588: one remembered choice for abandoned-structure markers on the maps — the
 * world-generation survey (menu.ts) and the in-game world map (world-map.ts) share it, so
 * turning structures off in one place turns them off in both. Default on (the ADR-586
 * behaviour). Stored in localStorage; any storage failure falls back to the default.
 */
const KEY = "survivaz.showStructures";
export function loadShowStructures(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}
export function saveShowStructures(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode / no storage */ }
}
