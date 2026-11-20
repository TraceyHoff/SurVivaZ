/**
 * World-map markers: player-placed points of interest on the map.
 *  - PlaceMapMarkerCmd { x, y, visibility, len, label[24] }: server-authoritative. The marker entity carries
 *    Transform (world position, so chunk persistence saves it), Owner (placing client's session, so the owner
 *    always passes the replication scope) and MapMarker (persistent PlayerId owner, visibility, the party/clan
 *    id it was placed under, and a sanitized label, max MAP_MARKER_LABEL_MAX chars, like Sign text).
 *  - RemoveMapMarkerCmd { marker }: only the marker's owner may remove it (server resolves the NetId entity).
 * Visibility is set at creation and never changes:
 *  - private (0): only the owner sees it (replication scope returns false for everyone else; the Owner pass
 *    still lets the owner see it).
 *  - party (1): the owner's party at creation is recorded; any current member of that party sees it, including
 *    players who join the party after the marker was placed (the scope checks live membership, not a snapshot).
 *  - clan (2): same, for the owner's clan.
 * The client applies the same rule locally (visibleMarkers) so a marker stops showing the moment the viewer
 * leaves the party/clan, even before the next snapshot arrives. The server also flags marker entities global
 * (net.setGlobal, in apps/server) so they replicate regardless of AOI — a map marker for a far-away location
 * must show on the map even when the player is nowhere near it.
 */
import { entityIndex, GroupKind, Membership, Owner, Permissions, PlayerId, Transform, type CommandHandlers, type Entity, type GroupRegistry, type World } from "@engine/core";
import { BuildPiece, CraftingStation, MAP_MARKER_LABEL_MAX, MapMarker, MarkerVisibility, PieceBuilder, PieceOwner } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { StationKind } from "./defs.js";
import { FireToggled, PieceDestroyed } from "./events.js";
import { pieceOf } from "./building/links.js";
import { PlaceMapMarkerCmd, RemoveMapMarkerCmd } from "./map_marker_commands.js";
import { sanitizeSignText } from "./signs.js";


const pidOf = (w: World, e: Entity): number => (w.isRegistered(PlayerId) ? w.getField(e, PlayerId, "id") ?? 0 : 0);
const groupsOf = (w: World): GroupRegistry | undefined => { try { return w.resource(Permissions).groups; } catch { return undefined; } };

/** Party / clan id of a player right now (0 = none). Prefers the core GroupRegistry; falls back to the player's mirrored Membership. */
export const partyOfPlayer = (w: World, player: number): number => {
  const g = groupsOf(w); if (g) return g.groupsOf(player, GroupKind.Party)[0]?.id ?? 0;
  for (const e of w.query([PlayerId])) if (w.getField(e, PlayerId, "id") === player) return w.getField(e, Membership, "partyId") ?? 0;
  return 0;
};
export const clanOfPlayer = (w: World, player: number): number => {
  const g = groupsOf(w); if (g) return g.groupsOf(player, GroupKind.Clan)[0]?.id ?? 0;
  for (const e of w.query([PlayerId])) if (w.getField(e, PlayerId, "id") === player) return w.getField(e, Membership, "clanId") ?? 0;
  return 0;
};

/** Pure: why a placement fails, or undefined. Coordinates must be finite and inside the world (checked by the caller against its own bounds if any). */
export function placeMarkerReject(w: World, actor: Entity, x: number, y: number, visibility: number): string | undefined {
  const me = pidOf(w, actor); if (!me) return "no_player";
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "bad_coords";
  if (visibility !== 0 && visibility !== 1 && visibility !== 2) return "bad_visibility";
  if (visibility === 1 && !partyOfPlayer(w, me)) return "no_party";
  if (visibility === 2 && !clanOfPlayer(w, me)) return "no_clan";
  return undefined;
}
/** Raw spawn (no checks): returns the marker entity. Label is sanitized like sign text. */
export function spawnMarker(w: World, actor: Entity, x: number, y: number, visibility: number, label = ""): Entity {
  const me = pidOf(w, actor); const clientId = w.has(actor, Owner) ? w.getField(actor, Owner, "clientId") ?? 0 : 0;
  return spawnMarkerOwned(w, me, clientId, x, y, visibility, label,
    visibility === 1 ? partyOfPlayer(w, me) : 0, visibility === 2 ? clanOfPlayer(w, me) : 0);
}
/** Raw spawn by owner id (no checks): the smoke-marker path (server-side, no actor entity). */
export function spawnMarkerOwned(w: World, owner: number, clientId: number, x: number, y: number, visibility: number, label = "", party = 0, clan = 0): Entity {
  const clean = sanitizeSignText(label, MAP_MARKER_LABEL_MAX);
  const e = w.create();
  w.add(e, Transform, { x, y, z: 0 }).add(e, Owner, { clientId }).add(e, MapMarker, { owner, visibility, party, clan, len: 0 });
  const a = w.getArray(e, MapMarker, "label")!; for (let i = 0; i < MAP_MARKER_LABEL_MAX; i++) a[i] = i < clean.length ? clean.charCodeAt(i) : 0;
  w.setField(e, MapMarker, "len", clean.length); w.store(MapMarker).markChanged(entityIndex(e));
  return e;
}
export function placeMarker(w: World, actor: Entity, x: number, y: number, visibility: number, label = ""): string | Entity {
  const r = placeMarkerReject(w, actor, x, y, visibility); if (r) return r;
  return spawnMarker(w, actor, x, y, visibility, label);
}
/** Marker label (decoded from the u8 array). */
export function markerLabel(w: World, e: Entity): string {
  const n = w.getField(e, MapMarker, "len") ?? 0; const a = w.getArray(e, MapMarker, "label"); if (!a) return "";
  let o = ""; for (let i = 0; i < Math.min(n, MAP_MARKER_LABEL_MAX); i++) o += String.fromCharCode(a[i] ?? 32); return o;
}
/** Is this marker visible to `viewer` (a player entity)? Same rule the server scope uses, evaluated locally. */
export function markerVisibleTo(w: World, marker: Entity, viewer: Entity): boolean {
  if (!w.has(marker, MapMarker)) return false;
  const me = pidOf(w, viewer); if (!me) return false;
  const m = w.get(marker, MapMarker)!; if (m.owner === me) return true;
  if (m.visibility === 1) return m.party !== 0 && partyOfPlayer(w, me) === m.party;
  if (m.visibility === 2) return m.clan !== 0 && clanOfPlayer(w, me) === m.clan;
  return false;
}
/** All markers visible to `viewer`, sorted by label then position. */
export function visibleMarkers(w: World, viewer: Entity): { entity: Entity; x: number; y: number; visibility: number; owner: number; label: string }[] {
  const out: { entity: Entity; x: number; y: number; visibility: number; owner: number; label: string }[] = [];
  if (!w.isRegistered(MapMarker)) return out;
  for (const e of w.query([MapMarker])) {
    if (!markerVisibleTo(w, e, viewer)) continue;
    const t = w.get(e, Transform); const m = w.get(e, MapMarker)!;
    out.push({ entity: e, x: t?.x ?? 0, y: t?.y ?? 0, visibility: m.visibility, owner: m.owner, label: markerLabel(w, e) });
  }
  out.sort((a, b) => (a.label || "Marker").localeCompare(b.label || "Marker") || a.x - b.x || a.y - b.y);
  return out;
}
/** Server-side replication scope for MapMarker: the owner always passes via the Owner component (net handles that
 * before calling this); everyone else passes only if they currently share the marker's party / clan. */
export function markerScope(w: World, e: Entity, clientId: number): boolean {
  if (!w.has(e, MapMarker)) return false;
  const m = w.get(e, MapMarker)!; if (m.visibility !== 1 && m.visibility !== 2) return false;
  // viewer PlayerId: the entity owned by this client that carries a PlayerId
  let viewer = 0;
  for (const p of w.query([PlayerId])) if (w.has(p, Owner) && w.getField(p, Owner, "clientId") === clientId) { viewer = w.getField(p, PlayerId, "id") ?? 0; break; }
  if (!viewer || viewer === m.owner) return false;
  const g = groupsOf(w); if (!g) return false;
  const kind = m.visibility === 1 ? GroupKind.Party : GroupKind.Clan; const id = m.visibility === 1 ? m.party : m.clan;
  const grp = id ? g.get(id) : undefined; return !!grp && grp.kind === kind && grp.members.has(viewer);
}
/** Only the owner may remove a marker. */
export function removeMarkerReject(w: World, actor: Entity, marker: Entity): string | undefined {
  const me = pidOf(w, actor); if (!me) return "no_player";
  if (!w.isAlive(marker) || !w.has(marker, MapMarker)) return "not_found";
  if (w.getField(marker, MapMarker, "owner") !== me) return "not_owner";
  return undefined;
}
export function removeMarker(w: World, actor: Entity, marker: Entity): string | undefined {
  const r = removeMarkerReject(w, actor, marker); if (r) return r;
  w.destroy(marker); return undefined;
}
/** Server: marker command handlers. */
export function installMapMarkerCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(PlaceMapMarkerCmd, {
    validate: (v, c) => placeMarkerReject(world, c.actor, v.x, v.y, v.visibility),
    handle: (v, c) => { const label = Array.from({ length: Math.min(v.len, MAP_MARKER_LABEL_MAX) }, (_, i) => String.fromCharCode(v.label[i] ?? 32)).join(""); placeMarker(world, c.actor, v.x, v.y, v.visibility, label); },
  });
  handlers.on(RemoveMapMarkerCmd, {
    validate: (v, c) => removeMarkerReject(world, c.actor, v.marker as Entity),
    handle: (v, c) => { removeMarker(world, c.actor, v.marker as Entity); },
  });
}

/**
 * ADR-453 smoke columns (map-marker variant): a lit campfire / fireplace shows on the map from anywhere
 * as a private marker labelled "Smoke", owned by the fire's owner. The in-world tall column is NOT built
 * (Tracey decision: map-marker variant only). The marker is placed on FireToggled(lit) and removed on
 * FireToggled(unlit) or when the piece is destroyed; the owner can also remove it by hand.
 * Visibility is private: only the owner sees their smoke (party/clan sharing is a follow-up decision).
 * Which fires qualify: campfire + fireplace pieces, and free-standing Campfire stations. Furnaces, stoves
 * and ovens do not — they would spam the map from every base. Zero per-frame work: the marker rides the
 * existing global replication and the map's existing visibleMarkers query.
 */
export const SMOKE_MARKER_LABEL = "Smoke";
export const SMOKE_HEARTH_KEYS: readonly string[] = ["campfire", "fireplace"];

/** The smoke target for a fire entity (Fuel attachment or free-standing station), or undefined when it is not a smoke hearth. */
export function smokeTargetFor(world: World, fire: Entity): { piece: Entity; x: number; y: number; owner: number } | undefined {
  const defs = gameplayDefs(world);
  const piece = pieceOf(world, fire);
  if (piece !== undefined) {
    const t = world.getField(piece, BuildPiece, "type");
    const key = t === undefined ? undefined : defs.pieces.get(t)?.key;
    if (key === undefined || !SMOKE_HEARTH_KEYS.includes(key)) return undefined;
    const pos = world.get(piece, Transform) ?? world.get(fire, Transform); if (!pos) return undefined;
    // ADR-317: the builder is PieceBuilder, with PieceOwner as the legacy fallback (same as builtBy).
    const owner = world.getField(piece, PieceBuilder, "player") ?? world.getField(piece, PieceOwner, "player") ?? 0;
    return { piece, x: pos.x, y: pos.y, owner };
  }
  const st = world.get(fire, CraftingStation);
  if (!st || st.kind !== StationKind.Campfire) return undefined;
  const pos = world.get(fire, Transform); if (!pos) return undefined;
  return { piece: fire, x: pos.x, y: pos.y, owner: 0 };
}

const smokeByPiece = new WeakMap<World, Map<Entity, Entity>>(); // piece/fire entity -> smoke marker
const smokeIndex = (world: World): Map<Entity, Entity> => { let m = smokeByPiece.get(world); if (!m) smokeByPiece.set(world, (m = new Map())); return m; };
/** The client session of a player id right now (0 when offline — the marker still exists, it just cannot replicate until they are back). */
function ownerClientId(world: World, player: number): number {
  if (!player || !world.isRegistered(PlayerId)) return 0;
  for (const p of world.query([PlayerId])) {
    if ((world.getField(p, PlayerId, "id") ?? 0) !== player) continue;
    return world.has(p, Owner) ? world.getField(p, Owner, "clientId") ?? 0 : 0;
  }
  return 0;
}

/** Spawn a smoke marker for a lit fire (idempotent: one marker per fire). Returns the marker, or undefined. */
export function placeSmokeMarker(world: World, fire: Entity): Entity | undefined {
  const tgt = smokeTargetFor(world, fire); if (!tgt) return undefined;
  const idx = smokeIndex(world);
  const ex = idx.get(tgt.piece); if (ex !== undefined && world.isAlive(ex) && world.has(ex, MapMarker)) return ex;
  const e = spawnMarkerOwned(world, tgt.owner, ownerClientId(world, tgt.owner), tgt.x, tgt.y, MarkerVisibility.Private, SMOKE_MARKER_LABEL);
  idx.set(tgt.piece, e); return e;
}
/** Remove the smoke marker for a fire (no-op when there is none). Falls back to a position+label scan when the in-memory index is empty (e.g. after a restart). */
export function removeSmokeMarker(world: World, fire: Entity): boolean {
  const idx = smokeIndex(world);
  const piece = pieceOf(world, fire) ?? fire;
  const ex = idx.get(piece);
  if (ex !== undefined) {
    idx.delete(piece);
    if (world.isAlive(ex) && world.has(ex, MapMarker)) { world.destroy(ex); return true; }
    return false;
  }
  const tgt = smokeTargetFor(world, fire); if (!tgt) return false;
  for (const m of world.query([MapMarker])) {
    const mm = world.get(m, MapMarker)!; if (mm.owner !== tgt.owner || markerLabel(world, m) !== SMOKE_MARKER_LABEL) continue;
    const t = world.get(m, Transform); if (!t || Math.hypot(t.x - tgt.x, t.y - tgt.y) > 1.5) continue;
    world.destroy(m); return true;
  }
  return false;
}
/** Remove the smoke marker for a destroyed piece (in-memory index only — the piece is gone, so no position is available). */
export function removeSmokeMarkerForPiece(world: World, piece: Entity): boolean {
  const idx = smokeIndex(world); const ex = idx.get(piece); if (ex === undefined) return false;
  idx.delete(piece);
  if (world.isAlive(ex) && world.has(ex, MapMarker)) { world.destroy(ex); return true; }
  return false;
}
/** Subscribe once per world: FireToggled places/removes the marker, PieceDestroyed cleans up a lit fire's marker. */
export function installSmokeMarkers(world: World): void {
  world.events.on(FireToggled, (p: { entity: Entity; lit: number }) => {
    if (!isAuthority(world) || world.isReplaying) return;
    if (p.lit) placeSmokeMarker(world, p.entity); else removeSmokeMarker(world, p.entity);
  });
  world.events.on(PieceDestroyed, (p: { piece: Entity; type: number; cause: number }) => {
    if (!isAuthority(world) || world.isReplaying) return;
    removeSmokeMarkerForPiece(world, p.piece);
  });
}
