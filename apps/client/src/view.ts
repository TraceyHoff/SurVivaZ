import { effectiveLevel, levelFlags } from "./gl-recovery.js";
import { pieceFireState } from "./fire-state.js";
import { WaterDepth, waterDepthAt } from "@engine/world";
/** ADR-181 wading look (tint-free stand-in until wade art exists): sink the body and show wet drips/splash. */
const WADE_SINK = 0.15, WADE_WET = 160;
import { isFreeStandingStation, stationFireFrame } from "./station-view.js";
import { DESKTOP_ZOOM } from "./camera-zoom.js";
import { showRenderError, glInfo, BlackFrameCheck } from "./glcheck.js";
/**
 * WebGL2 game view: @engine/render IsoRenderer + Art's pack (packages/assets/pack, served at `<base>art/pack/`).
 *
 * The net World cannot carry render components (World.getSchemaHash covers every registered store and must match
 * the server), so the renderer draws a separate *view World*: each frame `sync()` mirrors the replicated entities
 * (Transform/PrevTransform, env TimeOfDay + Weather, tick) into it and attaches Sprite/AnimState/LightSource/Shadow
 * from the gameplay components (Survival = character, Zombie, ResourceNode, CraftingStation, BuildPiece) using the
 * gameplay defs' sprite keys. Terrain is the net TileClient's TileMap, drawn directly.
 */
import { CorrectionSampler, type CorrectionSource } from "./correction-sampler.js";
import { World, Transform, PrevTransform, TimeOfDay, Weather, Appearance, PlayerId, defineComponent, slotIndex, type WearableSlot, entityIndex, type Entity, seasonAtDays, type SeasonInfo } from "@engine/core";
import { CHUNK_SIZE, tileToChunk, tileToLocal, renderTileHeight, type TileMap } from "@engine/world";
import { assetFetch, assetJsonGz, cacheBustUrl, setDayFraction, setSeasonState, resolveOffHandSprite, CharArtMapper, parseCharArt, type CharArt } from "@engine/render";
import { dayCount, sunFraction } from "./day-clock.js";
import { clanPieceTint, clanPieceTintPair } from "./clan-tint.js";
import { pieceVariantOpts } from "./piece-variant.js";
import { DoorView, doorArt } from "./door-view.js";
import { loadManifest, buildPieceVisual, quarterTurn, type AssetRegistry } from "@engine/assets";
import { BuildGhost, pieceArtRow, pieceRotFlags, ROT_NO_OCCLUDE, IsoRenderer, Canvas2DRenderer, chooseRenderer, Sprite, Shadow, LightSource, Occluder, SpriteAlpha, SpriteFlag, sourcesFromManifest, coreAppearanceBinding, CameraTargetGuard, setResizeSlicing, type AtlasSource, type VfxSpawn } from "@engine/render";
import { countFraction, partitionPhase } from "./load-progress.js";
import { isWarmupCandidate, warmupPageBudget, type WarmupResult } from "@engine/render";
import { GrazedTiles } from "@engine/render";
import { VehicleView, type RiderPlacement, type VehicleSnapshot, type VehicleRenderDef } from "@engine/render";
import { Vehicle as GVehicle, VehicleSeats, VehicleState, Hitch, vehicleDefOf, localPlayerVehicle } from "@engine/gameplay";
import { netIdOf } from "@engine/net";
import { roadSpriteKeys, ROAD_FLAGS, signFrameId } from "./road-sign-view.js";
import { Road, Sign, surfaceDef, signDef, walkAnimRate, petSits, facingAfterTravel } from "@engine/gameplay";
import { HitReact, NodeRegrow, hitDirRad, Equipment, Worn, SlotDye, INVENTORY_SLOTS, wornCosmetics } from "@engine/gameplay";
import { Mount, Riding, isHarnessed } from "@engine/gameplay";
import { harnessOverlayKey, idleGrazing, LAYER_KEY, MOUNT_GAIT_ANIM, MOUNT_SHEET_WILD, mountActOf, mountForeKey, mountGait, mountSpriteKeyOf, riderPose, riderStartTick, saddleOverlayKey, screenNeutralShift, swimClipPx, type MountAct } from "./mount-render.js";
import { AssetRegistry as AssetRegistryClass } from "@engine/assets";
import { gameplayDefs, rotationSteps, rotParts, animalDefs, animalDrawScale, LootBag, Animal, Health, Survival, Zombie, ResourceNode, CraftingStation, Fuel, AnimState as GAnim, BuildPiece as GPiece, Dead, Wetness, BodyTemp, Emitter, PieceLink, STATION_LIGHT_RADIUS, StationKind, Crop, cropSpriteKey, clutterForChunk, resolveSprite, despawnFadeAlpha, GrazedTile, InShaft, DoorState, AttachKind, resolveAttachment, StoreFill, isStorePieceKey, Power as GPower, POWER, type ResolvedSprite } from "@engine/gameplay";
/** ADR-593: tiered piece keys whose light sibling is the powered tier glow. */
const POWERED_TIER_KEYS: ReadonlySet<string> = new Set(POWER.poweredTier.pieces);

/** Render-side schemas the renderer's bindings expect (view World only). */
const VAnim = defineComponent("ViewAnimState", { state: "u8", startTick: "u32" });
const VPiece = defineComponent("ViewBuildPiece", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });
const VWet = defineComponent("ViewWetness", { level: "u8" });
const VTemp = defineComponent("ViewBodyTemp", { cold: "u8", heat: "u8", shivering: "u8" });
const VFuel = defineComponent("ViewFuel", { burnUntilTick: "u32", lit: "u8" });
/** ADR-242: replicated Burning on pieces -> BurningFx (raid fire / embers / smoke). */
const VBurn = defineComponent("ViewBurning", { lit: "u8", intensity: "u8", startTick: "u32" });
/** ADR-135: replicated main-hand item (held sprite at the hand anchor). Task 25: mainHandSlot (255 = none) rides along so the renderer can look up the held slot's dye colour. */
const VEquip = defineComponent("ViewEquipment", { mainHandItem: "u16", mainHandSlot: { type: "u8", default: 255 } });
/** Task 25: replicated SlotDye colours (packed 0xRRGGBB per inventory slot) — the held sprite is tinted by them. */
const VSlotDye = defineComponent("ViewSlotDye", { colors: { type: "u32", length: INVENTORY_SLOTS } });
/** ADR-135: replicated off-hand worn slot (Worn.item[WearSlot.OffHand]) -> offhand_<key> / held_<key> at handL. */
const VOffHand = defineComponent("ViewOffHand", { offHandItem: "u16" });
const OFFHAND_SLOT = 6; /* WearSlot.OffHand */
/** gameplay Anim (Idle Walk Run Attack Hurt Die Gather Build) -> render AnimStateId (Idle Walk Run Attack Hit Death ...). */
const ANIM_MAP: readonly number[] = [0, 1, 2, 3, 4, 5, 3, 3];
/** ADR-107: Swim (14) / Punch (15) pass straight through (atlas fallbacks: swim->walk, punch->attack). */
/** ADR-128: node hit wiggle offset (tiles) `ms` after a hit: damped sine away from the player, undefined when done. */
export function nodeWiggle(ms: number): number | undefined { if (ms < 0 || ms > 360) return undefined; const k = ms / 360; return 0.09 * Math.sin(k * Math.PI * 4) * (1 - k); }
/**
 * ADR-134 flinch pose `ms` after a HitReact (dir = radians, away from the attacker): knockback nudge (tiles, out fast
 * then back), uniform squash pulse, tilt (rad, Canvas2D) and white flash 0..1. undefined once the 260 ms flinch is over.
 */
export const HIT_REACT_MS = 260; // ADR-151: < fastest player melee cooldown (300 ms) so flinches don't stack
export function hitPose(ms: number, dir: number, directed = true): { dx: number; dy: number; scale: number; tilt: number; flash: number } | undefined {
  if (!(ms >= 0) || ms > HIT_REACT_MS) return undefined;
  if (!directed) return ms < 120 ? { dx: 0, dy: 0, scale: 1, tilt: 0, flash: 0.5 * (1 - ms / 120) } : undefined; // ADR-193: no attacker -> no knockback/flinch, faint sizzle only
  const k = ms / HIT_REACT_MS, f = 1 - k;
  const push = 0.16 * Math.sin(Math.min(1, ms / 70) * Math.PI / 2) * f * f;
  const side = Math.sign(Math.cos(dir) - Math.sin(dir)) || 1; // iso screen x ~ (x - y): lean away from the hit
  return { dx: Math.cos(dir) * push, dy: Math.sin(dir) * push, scale: 1 - 0.07 * Math.sin(k * Math.PI * 2) * f, tilt: 0.2 * side * Math.sin(k * Math.PI) * f, flash: ms < 120 ? 1 - ms / 120 : 0 };
}
const animMap = (a: number): number => (a >= 14 && a <= 24 ? a : a === 8 ? 8 : ANIM_MAP[a] ?? 0); // 16..19 ADR-128 harvest/chop/mine/drink, 20..24 ADR-241 block/aim/crouch/carry/sleep, 8 eat
import { LightTable, type LightSpec } from "./lights.js";
import { Burning, Driver, weaponClassOf, Stance, StanceMode, netIdEntity, bedSpots, bedRot } from "@engine/gameplay";
import { animChainFor, bedFit, type AnimChainCtx } from "@engine/render";
import { floorToTerrainZ, worldToScreen } from "@engine/world";
import { RaidFx, useRaidBurning, type RaidPiece } from "./raid-fx.js";
import { MANIFEST_INDEX, withCharArtFragment, loadMergedManifestWith, loadWearShard, type ManifestFragmentRef, type ManifestShardRef, type WearShardIO } from "./manifest-index.js";
import { task34AtlasSources, TASK34_ATLAS_KEYS } from "./task34-art.js";
import { task256AtlasSources, TASK256_ATLAS_KEYS } from "./task256-art.js";
import { task355AtlasSources, installStoreMenuIcons, TASK355_ATLAS_KEYS } from "./task355-art.js";
import { task361AtlasSources, installVehicleMenuIcons, TASK361_ATLAS_KEYS } from "./task361-art.js";
import { task410AtlasSources, TASK410_ATLAS_KEYS } from "./task410-art.js";
import { task420AtlasSources, installTask420MenuIcons, TASK420_ATLAS_KEYS } from "./task420-art.js";
import { task421AtlasSources, installBoatMenuIcons, TASK421_ATLAS_KEYS } from "./task421-art.js";
import { task422AtlasSources, installMotorboatMenuIcons, TASK422_ATLAS_KEYS } from "./task421-art.js";
import { task479AtlasSources, installSailboatMenuIcons, TASK479_ATLAS_KEYS } from "./task421-art.js";
import { task540AtlasSources, TASK540_ATLAS_KEYS } from "./task540-art.js"; // ADR-540: cougar + wolverine
import { prunePaintedCache } from "./painted-cache.js"; // ADR-550: prune stale painted-PNG hashes after boot
import { createPaintWorkerPool } from "./painted-parallel.js"; // ADR-551: paint the 13 groups in parallel / in Workers
import { installGuideArt } from "./task364-art.js";
import { installGuideMenuIcon } from "./guide-art.js";
import { installWetWoodIcon } from "./wetwood-art.js"; // ADR-457: wet firewood's own icon
import { footprintAtlasSources, trackAtlasSources, FOOTPRINT_SPRITE_KEY, TRACK_SPRITE_KEY } from "./footprints-art.js"; // ADR-455: footprints' own sprite; ADR-501: the animal track's own sprite
import { installFishingRodIcon, rodAtlasSources } from "./fishing-rod-art.js"; // ADR-493: the fishing rod's own icon + held sprite
import { FootprintStore, sampleFootprints, collectFootprintOverlays, footprintTuning, snowCoverOf } from "./footprints.js"; // ADR-455
import { stumpKeys } from "./stumps.js";
import { RoofTiler, rfxStandIn, roofWallMaterial } from "./roof-tiler.js";
/** ADR-520: iso px past the screen edges that still count as on screen for vehicle page streaming (the largest sheets ~1000 px). */
const VEH_VIEW_MARGIN = 600;
/** `?cam=animal`: debug camera that follows the first ambient animal instead of the player. */
const CAM_ANIMAL = typeof location !== "undefined" && new URLSearchParams(location.search).get("cam") === "animal";
/** Max bytes for the sprite texture array (mips included) before customization layers are dropped. */
/** ADR-110 clutter quality: lowend / safe = 0.35 density, radius 1 chunk, 400 sprites; else 1, 2 chunks, 1600. */
const CLUTTER = (() => { const q = new URLSearchParams(globalThis.location?.search ?? ""); const low = q.get("gl") === "lowend" || q.get("safe") === "1" || ["lowend", "safe", "debug"].includes(effectiveLevel(globalThis.location?.search ?? ""));
  return q.get("clutter") === "0" ? { density: 0, radius: 0, cap: 0 } : low ? { density: 0.35, radius: 1, cap: 400 } : { density: 1, radius: 2, cap: 1600 }; })();
/** ?gl=lowend: characters beyond the nearest N draw body-only. */
const DRESSED_LOWEND = 8;
let lowendDress = false;
/** Set when the paper-doll atlases were left out, so Appearance layers are not bound to missing sprites. */
let noCosmetics = false;
const PLAYER_KEYS = ["player", "player_b", "player_c"];

/** Camera fallback when no player is replicated for CAMERA_GRACE_FRAMES: the legacy origin spawn (server SPAWN). */
/** World z of an entity at (x, y): the sim's z, lifted onto the terrain step (tile height) it stands on. */
const gz: { tiles: TileMap | undefined; cx: number; cy: number; c: ReturnType<TileMap["getChunk"]> } = { tiles: undefined, cx: 0, cy: 0, c: undefined };
/** Drop groundZ's chunk cache (chunks can be replaced between frames). */
export function resetGroundCache(): void { gz.tiles = undefined; gz.c = undefined; }
export function groundZ(tiles: TileMap | undefined, x: number, y: number, z: number): number {
  if (!tiles) return z; const tx = Math.floor(x), ty = Math.floor(y); const cx = tileToChunk(tx), cy = tileToChunk(ty);
  // ADR-157: one-entry chunk cache (getChunk builds a string key: 2 lookups per entity per frame); reset every view frame
  if (gz.tiles !== tiles || gz.cx !== cx || gz.cy !== cy) { gz.tiles = tiles; gz.cx = cx; gz.cy = cy; gz.c = tiles.getChunk(cx, cy); }
  const c = gz.c;
  if (!c) return z; const i = tileToLocal(ty) * CHUNK_SIZE + tileToLocal(tx);
  const h = renderTileHeight((c.tiles as Uint16Array | undefined)?.[i] ?? 0, c.height[i] ?? 0); // ADR-182: swimmers sit on the flat water surface
  return h < 0 ? z + h : Math.max(z, h); // ADR-263: sim z is clamped >= 0, so a shovel pit (negative height) lowers the body
}
/** ADR-265: ground surfaces on the two sides of the snapped terrain face. */
export function ladderFaceHeights(tiles: TileMap | undefined, x: number, y: number, rot: number): { low: number; high: number } {
  const tx = Math.floor(x), ty = Math.floor(y);
  const a = groundZ(tiles, tx + .5, ty + .5, 0);
  const b = (rot & 1) ? groundZ(tiles, tx - .5, ty + .5, 0) : groundZ(tiles, tx + .5, ty - .5, 0);
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

/** ADR-162 / ADR-303: terrain lift for a build piece. Story height (`round(z / levelHeight) * levelHeight`) is stripped
 *  so the renderer can add it back with `floorToTerrainZ(level, …)` — passing the full sim z here used to draw upper
 *  floors a whole story too high (they looked like they were floating with no support). Extra lift above that floor
 *  (decor on a table) is kept on top of the terrain step. */
export function pieceGroundZ(tiles: TileMap | undefined, x: number, y: number, z: number, lh: number): number {
  const step = lh || 1; const floor = Math.round(z / step) * step; const off = z - floor;
  return groundZ(tiles, x, y, 0) + off;
}
/** Raw terrain height of one tile (renderTileHeight), or undefined when its chunk is not resident.
 * Reuses groundZ's one-entry chunk cache when the tile is in it, otherwise reads the chunk directly
 * (a boundary anchor can touch tiles in up to 4 chunks) without disturbing the cache. */
function tileHeightAt(tiles: TileMap, tx: number, ty: number): number | undefined {
  const cx = tileToChunk(tx), cy = tileToChunk(ty);
  const c = gz.tiles === tiles && gz.cx === cx && gz.cy === cy ? gz.c : tiles.getChunk(cx, cy);
  if (!c) return undefined;
  const i = tileToLocal(ty) * CHUNK_SIZE + tileToLocal(tx);
  return renderTileHeight((c.tiles as Uint16Array | undefined)?.[i] ?? 0, c.height[i] ?? 0);
}
/**
 * ADR-412: terrain lift for a build piece whose anchor sits exactly on a tile boundary. A wall on the
 * south/east edge of its structure — and the `wall_corner_outer` L at a vertex — anchors on the boundary
 * line itself, so groundZ's floor() reads the NEIGHBOUR tile outside the structure; when that neighbour
 * is raised ground the piece rendered a whole step (or more) above its own floor, floating over a visible
 * gap. That is the reported ruin defect: ADR-384 only gates the footprint itself, so a flat-footprint site
 * bumped up against raised tiles stamps fine and then floats. Take the lowest ground among the tiles
 * touching the anchor (2 for an edge, 4 for a vertex): the structure's own tile is always one of them, so
 * a raised neighbour can no longer lift the piece. A lower neighbour only sinks the base behind the higher
 * ground — it reads as a foundation down the slope, never a floating gap. Off-boundary anchors touch
 * exactly one tile, so this is identical to pieceGroundZ for every other piece (foundations, furniture,
 * interior walls). Render-side, so ruins already standing in saved worlds are fixed in place: no
 * regeneration, no persist/schema change, and generation/placement are untouched (a placement-time nudge
 * would desync Transform from the derived slot and leave old ruins floating). Story lift / decor offset
 * handling is pieceGroundZ's, unchanged.
 *
 * ADR-433: the ADR-412 comment above is true at the bottom and false at the top. A lower neighbour
 * sinking the base IS a gap when a roof/floor deck sits above the wall: the wall top is base + one
 * floor (3 levels) while the deck above sits on the footprint's own tile, so a one-level drop outside
 * opens a one-level (16 px) see-through gap between wall top and roof seat (ADR-432). `min` satisfies
 * ADR-412 but breaks the roof pair; `max` satisfies the roof pair but re-opens ADR-412. The fix needs
 * inside/outside information, and facing cannot supply it: stamped straight walls all carry rot 0
 * (`packages/gameplay/src/building/abandoned.ts` walls()), so Transform.facing encodes only the edge
 * orientation (a North-edge wall faces 0 or PI, a West-edge wall PI/2 — `slotTransform` in
 * `packages/gameplay/src/building/structure.ts`), and a house's north and south walls share side North
 * and facing 0 with the inside on opposite sides. PieceSlot knows the edge side but is sim-local and
 * never replicated, so the client cannot use it either. The only inside signal the client has is deck
 * adjacency: a deck piece (foundation / floor / roof family) on a tile marks that tile as inside the
 * building. So this function takes an optional `decks` set (keys from `deckTileKey`, built by the
 * render loop from the pieces it already iterates): among the touching tiles, prefer one carrying a
 * deck at level+1 — the deck the wall top must meet, roof or floor above — else one carrying a deck
 * at the wall's own level — the deck it stands on, e.g. walls placed before their roof — and take the
 * MAX height among the preferred tiles; with no decked touching tile, fall back to the ADR-412 min.
 * The max matters only where two decked tiles at different heights touch one anchor: a vertex on a
 * step line, or a party wall decked on both sides at different levels. No single wall top can meet
 * both roof heights there; max meets the higher roof (the gap it would leave is the see-through
 * defect being fixed) and the lower roof's step reads as the corner post continuing past it. With
 * no `decks` argument the behaviour is exactly ADR-412's min, so every bare call — including all
 * ADR-412 pins and a freestanding wall with no deck above — is unchanged. A wall whose inside tile
 * is LOWER than outside still grounds on the inside tile: it stands on inside ground and the higher
 * outside ground buries its lower portion like a retaining wall.
 */
/** ADR-433: numeric key for a deck tile (tx, ty, level): exact in a float64 for |tx|,|ty| < 2^20, level < 2^11. */
export function deckTileKey(tx: number, ty: number, level: number): number {
  const OFF = 1 << 20;
  return (tx + OFF) + (ty + OFF) * (1 << 21) + level * (1 << 42);
}
/** ADR-433: the deck-set key for one placed piece, or undefined when it is not a deck piece. Deck
 * families are foundation / floor / roof (`family` in pieces.json — foundations, floors, all roof
 * forms, including ramp / stilt / triangle variants); walls, doors, furniture, stations and decor
 * never contribute. The level is the piece's story, round(z / lh). */
export function deckKeyFor(family: string | undefined, x: number, y: number, z: number, lh: number): number | undefined {
  if (family !== "foundation" && family !== "floor" && family !== "roof") return undefined;
  return deckTileKey(Math.floor(x), Math.floor(y), Math.round(z / (lh || 1)));
}
export function pieceBoundaryGroundZ(tiles: TileMap | undefined, x: number, y: number, z: number, lh: number, decks?: ReadonlySet<number>): number {
  const step = lh || 1; const floor = Math.round(z / step) * step; const off = z - floor;
  if (!tiles) return off; // no tiles → sim z stripped of story, like pieceGroundZ(undefined, …)
  const onX = Math.abs(x - Math.round(x)) < 1e-4, onY = Math.abs(y - Math.round(y)) < 1e-4;
  if (!onX && !onY) return groundZ(tiles, x, y, 0) + off;
  const xs = onX ? [Math.round(x) - 1, Math.round(x)] : [Math.floor(x)];
  const ys = onY ? [Math.round(y) - 1, Math.round(y)] : [Math.floor(y)];
  const level = Math.round(z / step); // the wall's story: the deck above it is at level + 1
  let h: number | undefined; // ADR-412 min over touching tiles (fallback: no decked tile, or no decks given)
  let upper: number | undefined; // ADR-433 max over touching tiles carrying a deck at level + 1
  let own: number | undefined; // ADR-433 max over touching tiles carrying a deck at this level
  for (const ty of ys) for (const tx of xs) {
    const th = tileHeightAt(tiles, tx, ty); if (th === undefined) continue;
    h = h === undefined ? th : Math.min(h, th);
    if (decks !== undefined) {
      if (decks.has(deckTileKey(tx, ty, level + 1))) upper = upper === undefined ? th : Math.max(upper, th);
      else if (decks.has(deckTileKey(tx, ty, level))) own = own === undefined ? th : Math.max(own, th);
    }
  }
  if (h === undefined) return groundZ(tiles, x, y, 0) + off; // no resident tile touched: same as before
  if (upper !== undefined) return upper + off; // the deck above fixes the wall top: base = inside height
  if (own !== undefined) return own + off; // no deck above yet: stand on the deck the wall stands on
  return h + off; // groundZ(…, 0) semantics: the raw height (max(0, h) for h >= 0, h for a pit)
}
/** ADR-299: pin a shaft hatch (and anyone standing on its lid) to the surrounding rim instead of the pit floor. */
export function shaftRimGroundZ(tiles: TileMap | undefined, x: number, y: number, z: number): number {
  const tx = Math.floor(x), ty = Math.floor(y);
  const h = Math.max(groundZ(tiles, tx + 1.5, ty + .5, 0), groundZ(tiles, tx - .5, ty + .5, 0), groundZ(tiles, tx + .5, ty + 1.5, 0), groundZ(tiles, tx + .5, ty - .5, 0));
  return h < 0 ? z + h : Math.max(z, h);
}
/** ADR-155 camera z easing: time constant (s) and the jump (world z) beyond which it snaps (teleport / respawn). */
/** ADR-157: Transform-shaped read straight from the typed arrays into a scratch object (no allocation, no keyed stores). */
function readXform(w: World, e: Entity, def: typeof Transform | typeof PrevTransform, out: { x: number; y: number; z: number; facing: number }): typeof out | undefined {
  if (!w.isAlive(e)) return undefined; const st = w.store(def); const i = entityIndex(e); if (!st.has(i)) return undefined; const k = st.slot(i), d = st.data as Record<"x" | "y" | "z" | "facing", Float32Array>;
  out.x = d.x[k]!; out.y = d.y[k]!; out.z = d.z[k]!; out.facing = d.facing[k]!; return out;
}
/** ADR-508: view Transform / PrevTransform write that skips the set() (init object + per-field walk + change mark) when
 *  every stored f32 field already holds the value — static pieces, trees and idle bodies, i.e. most entities, most
 *  frames. Missing component: falls through to set() (which throws, as before). Nothing reads the view world's
 *  change marks (the renderer re-gathers every frame), so skipping an identical write changes no output. */
export function writeXform(w: World, e: Entity, def: typeof Transform | typeof PrevTransform, x: number, y: number, z: number, facing: number): void {
  const st = w.store(def); const i = entityIndex(e);
  if (w.isAlive(e) && st.has(i)) {
    const k = st.slot(i), d = st.data as Record<"x" | "y" | "z" | "facing", Float32Array>;
    if (d.x[k] === Math.fround(x) && d.y[k] === Math.fround(y) && d.z[k] === Math.fround(z) && d.facing[k] === Math.fround(facing)) return;
  }
  if (def === Transform) w.set(e, Transform, { x, y, z, facing }); else w.set(e, PrevTransform, { x, y, z, facing });
}
export const CAM_Z_TAU = 0.15, CAM_Z_SNAP = 4;
/** Camera x/y follow easing (s): the camera used to sit exactly on the interpolated player position, so every tick
 * jitter, collision slide and reconciliation remnant moved the whole screen. Easing x/y like z (tau 0.08 s, ~0.2-tile
 * lag at walk speed) smooths that out; large jumps (teleport / respawn) still snap, like z. */
export const CAM_XY_TAU = 0.08, CAM_XY_SNAP = 4;
/** Task 17: camera-easing dt cap — one sim tick. A hitch frame (menu-close DOM
 * teardown, atlas upload) used to ease with dt up to 0.25 s, nearly snapping the
 * camera to the target in a single frame (k≈0.96) so the whole screen jumped;
 * normal frames (16–33 ms) are below the cap and behave exactly as before. */
export const CAM_DT_CAP_S = 0.05;
/** Task 17: one camera-follow step (x/y). Snap only past CAM_XY_SNAP (teleports);
 * otherwise exponential ease with tau CAM_XY_TAU. Pure so the hitch behaviour is
 * testable: with dt capped by the caller, a long frame can never snap the camera
 * most of the way to a moving target (the visible carrier of menu-close judder —
 * every entity on screen moves with the camera). Mutates `cur` on ease (the old
 * allocation behaviour); allocates only on snap / first frame. */
export function stepCameraXY(cur: { x: number; y: number } | undefined, want: { x: number; y: number }, dt: number): { x: number; y: number } {
  if (cur === undefined || Math.hypot(want.x - cur.x, want.y - cur.y) > CAM_XY_SNAP) return { x: want.x, y: want.y };
  const k = 1 - Math.exp(-dt / CAM_XY_TAU);
  cur.x += (want.x - cur.x) * k; cur.y += (want.y - cur.y) * k; return cur;
}
export const CAMERA_FALLBACK = { x: 16, y: 16, z: 0 };
const CAMERA_GRACE_FRAMES = 300;
export interface ViewStatus { localServer: string; snapshots: number; error?: string }
export interface ViewOverrides { hours?: number; weather?: number; intensity?: number;
  /** ADR-239 `?season=`: 0 summer, 1 fall, 2 winter, 3 spring; a fraction blends toward the next season (1.5 = half fall/winter). */ season?: number }
/** ADR-239: the season to draw: the override, else the replicated Season at the client's server-tick day count. */
export function viewSeason(net: World, days: number, ov?: number): SeasonInfo {
  if (ov === undefined || !Number.isFinite(ov)) return seasonAtDays(net, days);
  const p = ((ov % 4) + 4) % 4, index = Math.floor(p), next = (index + 1) % 4, blend = p - index;
  const weights: [number, number, number, number] = [0, 0, 0, 0]; weights[index] = 1 - blend; weights[next] = weights[next]! + blend;
  return { index, next, blend, into: 0, lengthDays: 1, weights, year: 0 };
}

/** Resource Timing watcher (ADR-118): calls back with the count and transfer bytes of matching responses since start. */
function watchResources(match: RegExp, cb: (count: number, bytes: number) => void): () => void {
  if (typeof PerformanceObserver !== "function") return () => {};
  let n = 0, bytes = 0;
  try {
    const po = new PerformanceObserver((list) => { let hit = false; for (const e of list.getEntries()) if (match.test(e.name)) { n++; bytes += (e as PerformanceResourceTiming).transferSize || (e as PerformanceResourceTiming).encodedBodySize || 0; hit = true; } if (hit) cb(n, bytes); });
    po.observe({ type: "resource", buffered: false }); return () => po.disconnect();
  } catch { return () => {}; }
}
/** ADR-183: black-frame self-check state carried by the view. */
export interface BlackCheckState { checks: number; blackFrames: number; blackCheck: BlackFrameCheck | undefined; lost?: boolean }
/**
 * One step of the all-black self-check after a frame. ADR-183: the Canvas2D renderer has no `gl`; before this guard
 * `blackCheck?.gl !== r.gl` was `undefined !== undefined` (false), so no check was created and `bc.pending` threw
 * "reading 'pending'" every frame (shown as a Frame error overlay under ?renderer=canvas). No GL → nothing to read back.
 */
export function blackFrameStep(st: BlackCheckState, r: { gl?: WebGL2RenderingContext | undefined; heldFrames: number }, held0: number, daylight: () => number = () => daylightOf(r as never)): void {
  if (!r.gl) return;
  // ADR-199: a lost (or lost-then-restored, pre-reload) context reads back zeros and its readback buffer is dead
  // (glError 0x502) — that showed a false "World rendered black" overlay after every GPU reset. Stop checking this page.
  if (st.lost || r.gl.isContextLost()) { st.lost = true; st.blackCheck = undefined; st.blackFrames = 0; return; }
  if (st.blackCheck?.gl !== r.gl) st.blackCheck = new BlackFrameCheck(r.gl); const bc = st.blackCheck;
  if (bc.pending) { const black = bc.poll(); if (black === true) { if (++st.blackFrames >= 2) showRenderError("World rendered black", glInfo(r.gl)); } else if (black === false) st.blackFrames = 0; }
  else if (r.heldFrames === held0 && st.checks < 90 && ++st.checks % 30 === 0 && daylight() > 0.5) bc.start(); // held (settling) frames draw nothing: not a black frame
}
/** ADR-360: apply VehicleView rider placements to the rider's view entity — the seat anchor of whatever vehicle
 * (motor or drawn) the rider sits in, in every view rotation. The sim snaps a rider to the vehicle centre; the
 * placement is the seat (the doll's `vehicle` seat socket lands on it, sprites.ts). PrevTransform matches so the
 * rider does not interpolate from the centre. Riders with no view entity yet are skipped. */
export function applyVehicleRiderPlacements(net: World, view: World, map: Map<Entity, Entity>, placements: readonly RiderPlacement[], windows?: Map<number, { bottom: number; top: number; glass?: { lo: number; hi: number; vehicle: number } }>): void {
  windows?.clear(); // ADR-518: rider window clips (true-scale cab seats), rebuilt from this frame's placements
  for (const p of placements) {
    const ne = netIdEntity(net, p.rider); if (ne === undefined) continue;
    const ve = map.get(ne); if (ve === undefined || !view.has(ve, Transform)) continue;
    if (windows && p.clip) windows.set(ve, p.clip);
    view.set(ve, Transform, { x: p.x, y: p.y, z: p.z, facing: p.facing });
    if (view.has(ve, PrevTransform)) view.set(ve, PrevTransform, { x: p.x, y: p.y, z: p.z, facing: p.facing });
  }
}
export class IsoView {
  readonly view = new World({ seed: 1 });
  private map = new Map<Entity, Entity>();
  /** ADR-397: continuous roofs (Art's rfx scheme): per-level region picks, cached until a roof on that level changes. */
  private roofs = new RoofTiler({ roofSpriteId: (key) => { const id = this.sid(key); if (id === undefined) return undefined; const sp = this.registry.sprite(id); return sp.building && (sp.building.piece ?? sp.key).startsWith("roof") ? id : undefined; } });
  private roofPreview: { sig: string; fx: import("@engine/render").RoofFxBinding | undefined } | undefined;
  private nodeAmt = new Map<Entity, number>(); private nodeHit = new Map<Entity, { at: number; dx: number; dy: number }>(); // ADR-128 wiggle
  private seen = new Set<Entity>();
  /** ADR-134: net entity -> last seen HitReact.startTick + local receive time; view entity -> current flinch pose. */
  private hitSeen = new Map<Entity, { tick: number; at: number; dir: number; directed: boolean }>(); private hitPoseOf = new Map<Entity, { scale: number; tilt: number; flash: number; base: number }>();
  /** Light emitters (net entity -> table spec), re-evaluated every frame from replicated Fuel.lit / Emitter.strength. */
  private lightOf = new Map<Entity, { spec: LightSpec; fuel?: Entity }>();
  /** Piece view entity -> building state index (e.g. "unlit") for the renderer's pieceState binding. */
  private pieceStates = new Map<number, number>();
  /** ADR-314: door open state + render-clock swing per view entity. */
  private readonly doors = new DoorView();
  /** ADR-218: fired piece view entity -> FireState (0 out, 1 lit, 2 lit hearth); drives flame anim + embers/smoke. */
  private pieceLit = new Map<number, number>(); private litHearths = new Map<number, number>();
  /** ADR-230: clan-tinted piece view entity -> [primary, secondary] RGBA8 (tintmask R/G) + the tint index it was built from. */
  private pieceTintPairs = new Map<number, readonly [number, number]>(); private pieceTintIdx = new Map<number, number>();
  /** ADR-125: character view entities (players/human bots); their Walk plays at walkAnimRate so feet match ground speed. */
  private characters = new Set<number>(); private walkRate = 1;
  /** ADR-305: last nonzero travel heading per net entity, used so idle does not snap to north. */
  private lastFace = new Map<Entity, number>();
  private constructor(readonly renderer: IsoRenderer, readonly registry: AssetRegistry, private readonly ov: ViewOverrides, readonly lights: LightTable) {
    IsoRenderer.registerComponents(this.view);
    for (const c of [VAnim, VPiece, VWet, VTemp, VFuel, VEquip, VOffHand, VBurn, VSlotDye]) this.view.register(c);
    useRaidBurning(renderer.burning, registry); // ADR-242: pvp_clan raid flames when served
    const cat = noCosmetics ? undefined : registry.cosmetics;
    // ADR-555: the boot catalog exists but is empty until the wear shards lazy-load, so Appearance
    // is registered (and the appearance binding installed) on the catalog's presence, not its size —
    // resolveLayers already skips unknown wearables, so characters draw body-only until the shards
    // land instead of losing their replicated Appearance entirely.
    if (cat) this.view.register(Appearance);
    renderer.bindGameplay({ animState: VAnim, buildPiece: VPiece, wetness: VWet, bodyTemp: VTemp, lit: VFuel, burning: VBurn, pieceState: (e) => this.pieceStates.get(e), pieceSwing: (e, now) => this.doors.swing(e, now), pieceRoofFx: (e) => (e === this.ghost?.entity ? this.roofPreview?.fx : this.roofs.binding(e)), pieceRoofPlane: (x, y, l) => this.roofs.planeOver(x, y, l), pieceSwingSprite: (e) => this.doors.swingSprite(e), pieceScale: (e) => this.pieceScales.get(e), pieceLit: (e) => this.pieceLit.get(e), pieceTints: (e) => this.pieceTintPairs.get(e), litPieces: () => this.litHearths,
      carriedSprite: (e) => this.carriedOf.get(e), bedFit: (e) => this.bedOf.get(e)?.fit, riderClip: (e) => this.riderClipOf.get(e), riderWindow: (e) => this.riderWinOf.get(e), // ADR-244 carry socket / bed fit
      hitFlash: (e) => this.hitPoseOf.get(e)?.flash ?? 0, hitTilt: (e) => this.hitPoseOf.get(e)?.tilt ?? 0,
      animRate: (e, st) => (st === 1 && this.characters.has(e) ? this.walkRate : undefined),
      animChain: (e, st, elapsed) => ((st === 3 || st >= 13) && this.characters.has(e) ? animChainFor(st, this.animCtx(e, elapsed)) : undefined), // ADR-241
      equipment: VEquip, heldSprite: (item) => this.heldSpriteOf(item), heldDye: (e, slot) => { const a = this.view.getArray(e as Entity, VSlotDye, "colors"); const c = a?.[slot] ?? 0; return c !== 0 ? c : undefined; }, offHand: VOffHand, offHandSprite: (item) => this.offHandSpriteOf(item),
      ...(cat ? { appearance: { ...coreAppearanceBinding(cat), override: (_w: unknown, ve: number) => { const g = this.gearOf.get(ve) ?? null; return this.charArtOn(ve) ? { salt: (g?.salt ?? 0) + 7919, parts: g?.parts ?? [] } : g; }, mapLayers: <L extends { sprite: number; slot: string; layerName?: string }>(ve: number, ls: readonly L[]): L[] => this.charArtLayers(ve, ls) } } : {}) });
  }
  /** ADR-370: boot warm-up result (first-view page-ins), read by main.ts for the load-cost breakdown. */
  warmupResult: WarmupResult | undefined;
  /** ADR-380: ms per boot sub-phase inside IsoView.create (renderer / manifest / painted / registry.* / warmup /
   *  variants / lighting), read by main.ts into the ?diag=1 load-cost breakdown. The registry step is split by
   *  atlas.rebuildTimings; without it (Canvas2D) the whole setRegistry call is one "registry" phase.
   *  ADR-548: entries with `parent` are parts of the named phase (painted.<group>, registry.* splits) —
   *  main.ts renders them but keeps them out of the "other" residual, so they never double-count. */
  bootPhases: { name: string; ms: number; parent?: string }[] = [];
  /** ADR-548: painted PNG bytes per atlas (blob.size), read by main.ts for the ?diag=1 load-cost note. */
  paintedAtlasBytes: { key: string; bytes: number }[] = [];
  /** ADR-548: cold-atlas bytes + body-page count note (not ms — see IsoView.create), read by main.ts. */
  registryNote: string | undefined;
  /** ADR-240: `charArt` setting (?charArt= / localStorage): v1 (default), v2s = local player only, v2s-all = every character. */
  charArt: CharArt = parseCharArt(new URLSearchParams(globalThis.location?.search ?? "").get("charArt"), (() => { try { return globalThis.localStorage?.getItem("charArt"); } catch { return null; } })());
  private charArtMapper?: CharArtMapper;
  /** v2 hits by twin (`v2s_`+key) / slot alias, and v1 fallbacks (diagnostics). */
  get charArtStats(): { twin: number; alias: number; v1: number } { return this.charArtMapper?.stats ?? { twin: 0, alias: 0, v1: 0 }; }
  private charArtOn(ve: number): boolean { return this.charArt === "v2s-all" || (this.charArt === "v2s" && ve === this.focusVe); }
  private charArtLayers<L extends { sprite: number; slot: string; layerName?: string }>(ve: number, ls: readonly L[]): L[] {
    if (!this.charArtOn(ve)) return [...ls];
    return (this.charArtMapper ??= new CharArtMapper(this.registry.ids.sprites)).map(ls);
  }
  /** ADR-135: view entity -> worn-gear paper-doll overrides (salt = hash of the worn items). */
  private gearOf = new Map<number, { salt: number; parts: Array<[number, number]> }>();
  private heldCache = new Map<number, number | undefined>();
  /** ADR-241 anim chain context: view entities moving this sync / in a driver seat; item id -> [key, weaponClassOf]. */
  private movingVe = new Set<number>(); private driverVe = new Set<number>();
  /** ADR-244: sleeper ve -> bed lie kind + bedFits offset; carrier ve -> carried bag sprite; net bags hidden while carried. */
  private bedOf = new Map<number, { lie: "lie" | "under"; fit: { x: number; y: number } }>(); private carriedOf = new Map<number, number>(); private carriedNet = new Set<Entity>();
  /** ADR-256: GrazedTile tiles from the net world. ADR-505: per-chunk revisions, so a graze rebuilds one terrain chunk
   *  (WebGL2) / the gt blocks over it (Canvas2D) instead of every chunk; numeric keys, no per-frame Set/string churn. */
  private readonly grazed = new GrazedTiles(); private grazedBound = false;

  /** ADR-256: mirror GrazedTile entities from the net world onto the renderer (view World has no GrazedTile). */
  private syncGrazed(net: World): void {
    const g = this.grazed; g.begin();
    if (net.isRegistered(GrazedTile)) for (const e of net.query([GrazedTile])) { const t = net.get(e, GrazedTile)!; g.add(t.tx, t.ty); }
    g.commit();
    if (!this.grazedBound) { this.renderer.setGrazedTiles(g); this.grazedBound = true; }
  }
  private syncStance(net: World, e: Entity, ve: Entity): void {
    const s = net.isRegistered(Stance) ? net.get(e, Stance) : undefined;
    if (s && s.mode === StanceMode.Sleep && s.lie) {
      const b = netIdEntity(net, s.bedNetId); let fit = { x: 0, y: 0 };
      if (b !== undefined && net.has(b, GPiece)) { const key = gameplayDefs(net).pieces.get(net.getField(b, GPiece, "type")!)?.key ?? ""; fit = bedFit(key, bedSpots(key)[s.spot] ?? "", bedRot(net.getField(b, Transform, "facing") ?? 0)); }
      this.bedOf.set(ve, { lie: s.lie === 2 ? "under" : "lie", fit });
    } else this.bedOf.delete(ve);
    const b = s && s.mode === StanceMode.Carry && s.carriedNetId ? netIdEntity(net, s.carriedNetId) : undefined;
    const bve = b !== undefined ? this.map.get(b) : undefined;
    if (b !== undefined) this.carriedNet.add(b);
    if (bve !== undefined && this.view.has(bve, Sprite)) this.carriedOf.set(ve, this.view.getField(bve, Sprite, "spriteId")!); else this.carriedOf.delete(ve);
  }
  private itemClass = new Map<number, readonly [string, string]>();
  private chainCtx: AnimChainCtx = {};
  private animCtx(ve: number, elapsed: number): AnimChainCtx {
    const c = this.chainCtx; c.moving = this.movingVe.has(ve); c.driver = this.driverVe.has(ve); c.elapsed = elapsed; c.bed = this.bedOf.get(ve)?.lie; c.ride = this.rideOf.get(ve); // ADR-244 (c), ADR-319 ride gait
    const item = this.view.has(ve as Entity, VEquip) ? this.view.getField(ve as Entity, VEquip, "mainHandItem") ?? 0 : 0;
    let ic = this.itemClass.get(item);
    if (!ic) { const key = item && this.netRef ? gameplayDefs(this.netRef).items.get(item)?.key ?? "" : ""; ic = [key, weaponClassOf(key || undefined)]; if (this.netRef || !item) this.itemClass.set(item, ic); }
    c.itemKey = ic[0]; c.weaponClass = ic[1];
    return c;
  }
  private heldSpriteOf(item: number): number | undefined {
    if (this.heldCache.has(item)) return this.heldCache.get(item);
    const key = this.netRef ? gameplayDefs(this.netRef).items.get(item)?.key : undefined; if (!key) return undefined;
    const id = this.registry.ids.sprites.tryId(`held_${key}`); this.heldCache.set(item, id); return id;
  }
  private offCache = new Map<number, number | undefined>();
  private offHandSpriteOf(item: number): number | undefined {
    if (this.offCache.has(item)) return this.offCache.get(item);
    const key = this.netRef ? gameplayDefs(this.netRef).items.get(item)?.key : undefined; if (!key) return undefined;
    const id = resolveOffHandSprite(key, (k) => this.registry.ids.sprites.tryId(k)); this.offCache.set(item, id); return id;
  }
  /** ADR-216: character view entity -> its held-light view entity (separate so the character sprite never gets BloomSource). */
  private heldLights = new Map<number, number>(); private heldLightCache = new Map<number, LightSpec | undefined>();
  private heldLightSpec(item: number): LightSpec | undefined {
    if (!item || !this.netRef) return undefined; if (this.heldLightCache.has(item)) return this.heldLightCache.get(item);
    const def = gameplayDefs(this.netRef).items.get(item); const hl = def?.heldLight ?? 0;
    // ADR-217: the drawn radius is the item's gameplay heldLight (what repels zombies); any heldLight item without its own held_<key> look borrows the torch's
    const base = this.lights.held(def?.key) ?? (hl > 0 ? this.lights.held("torch") : undefined);
    const spec = base ? LightTable.withRadius(base, hl) : undefined; this.heldLightCache.set(item, spec); return spec;
  }
  private dropHeldLight(ve: number): void { const le = this.heldLights.get(ve); if (le !== undefined) { this.view.destroy(le); this.heldLights.delete(ve); } }
  private syncHeldLight(net: World, e: Entity, ve: number): void {
    this.netRef = net;
    const mh = net.isRegistered(Equipment) && net.has(e, Equipment) ? (net.getField(e, Equipment, "mainHandItem") ?? 0) : 0;
    const oh = net.isRegistered(Worn) && net.has(e, Worn) ? (net.get(e, Worn)?.item[OFFHAND_SLOT] ?? 0) : 0;
    const sm = net.has(e, Dead) ? undefined : this.heldLightSpec(mh), so = net.has(e, Dead) ? undefined : this.heldLightSpec(oh);
    const spec = sm && so ? (so.radius > sm.radius ? so : sm) : sm ?? so; // ADR-217: larger of main / off hand, = gameplay heldLightRadius
    if (!spec) { this.dropHeldLight(ve); return; }
    const v = this.view; const t = v.get(ve, Transform)!, p = v.get(ve, PrevTransform) ?? t; let le = this.heldLights.get(ve);
    if (le === undefined) { le = v.create(); this.heldLights.set(ve, le); v.add(le, Transform, { x: t.x, y: t.y, z: t.z, facing: 0 }); v.add(le, PrevTransform, { x: p.x, y: p.y, z: p.z, facing: 0 }); v.add(le, LightSource, { ...spec }); return; }
    v.set(le, PrevTransform, { x: p.x, y: p.y, z: p.z }); v.set(le, Transform, { x: t.x, y: t.y, z: t.z });
    const L = v.get(le, LightSource)!; if (L.radius !== spec.radius || L.intensity !== spec.intensity || L.r !== spec.r) v.set(le, LightSource, { ...spec });
  }
  private netRef: World | null = null;
  get appearanceEnabled(): boolean { return this.view.isRegistered(Appearance); }

  /** ADR-555: wear shards excluded from the boot manifest, in index order; empty once loaded. */
  deferredWearShards: ManifestShardRef[] = [];
  private wearIO: WearShardIO | undefined;
  private wearArtPackBase = "";
  private wearLoad: Promise<void> | undefined;
  private wearDisabled = false;
  /**
   * ADR-555: lazy-load every deferred wear shard into the boot registry (in place — sprite ids are
   * stable via ids.lock.json, so entities already holding wearable ids keep working), extend the
   * atlas sources with the merged wear atlases (painted blob sources already in the map are never
   * overwritten; paper-doll pages stay 1x-only as at boot), and rebuild the atlas registry so the
   * wear pages can stream. Idempotent and in-flight-guarded: concurrent triggers share one load,
   * and a failed shard stays deferred for a later retry. Called before the character creator opens
   * (main.ts) and when a replicated look first names a wearable the boot catalog does not know.
   * The rebuild is a one-off menu/entry cost, not a boot cost — it never runs before first paint.
   */
  async ensureWearShards(): Promise<void> {
    if (this.wearDisabled || !this.deferredWearShards.length) return;
    if (!this.wearLoad) {
      this.wearLoad = (async () => {
        const io = this.wearIO; if (!io) return;
        const cats = this.deferredWearShards.map((s) => s.category);
        await Promise.all(cats.map((c) => loadWearShard(this.registry, c, io)));
        this.deferredWearShards = [];
        const sources = new Map(this.renderer.atlas.sources);
        for (const [k, src] of sourcesFromManifest(this.registry, `${this.wearArtPackBase}manifest.json`, {}, { probeSiblings: false })) {
          if (sources.has(k)) continue;
          if (/(^|\/)customization\//.test(this.registry.atlases.get(k)?.image ?? "")) delete src.pages;
          sources.set(k, src);
        }
        setResizeSlicing(false);
        try { await this.renderer.atlas.setRegistry(this.registry, sources); } finally { setResizeSlicing(true); }
      })().catch((e) => {
        // Keep the shards that did not land deferred so a later trigger retries only those.
        const loaded = this.registry.wearMerge?.loaded ?? [];
        this.deferredWearShards = this.deferredWearShards.filter((s) => !loaded.includes(s.category));
        this.wearLoad = undefined;
        console.warn("[view] wear shards failed to load", e);
      });
    }
    await this.wearLoad;
  }

  static async create(canvas: HTMLCanvasElement, base: string, ov: ViewOverrides = {}, onStage: (stage: string, f: number, label?: string) => void = () => {}): Promise<IsoView> {
    // ADR-380: split the boot load-cost bucket into sub-phases (cheap performance.now() marks, no allocations per
    // frame — this runs once at boot; the split is what Tracey's next ?diag=1 shows, so the 28.5 s boot can be cut
    // where it actually costs instead of by guessing).
    const phases: { name: string; ms: number; parent?: string }[] = [];
    const phase = (name: string, t0: number): void => { phases.push({ name, ms: Math.round(performance.now() - t0) }); };
    let t0 = performance.now();
    onStage("renderer", 0);
    const q0 = new URLSearchParams(location.search);
    // WebGL2 -> Canvas2D sprites -> (main.ts) debug. Probe a FRESH canvas: a lost/blocked context on #game must not decide.
    const probe = (k: "webgl2" | "2d"): unknown => document.createElement("canvas").getContext(k, k === "webgl2" ? { powerPreference: "default" } : undefined);
    const kind = chooseRenderer(probe, { forceCanvas: q0.get("renderer") === "canvas" });
    const make2d = (): IsoRenderer => { console.warn("[view] WebGL2 unavailable: Canvas2D sprite renderer"); return new Canvas2DRenderer(canvas) as unknown as IsoRenderer; };
    let renderer: IsoRenderer;
    if (kind === "canvas2d") renderer = make2d();
    else if (kind === "debug") throw new Error("no WebGL2 and no Canvas2D");
    else try { renderer = new IsoRenderer(canvas, { preserveDrawingBuffer: q0.has("shot"),
      // ?safe=1 implies ?gl=lowend (mediump, no float targets, low texture memory)
      // after a context loss gl-recovery.ts steps the level down (sessionStorage) so a reload starts lower and never loops
      ...(levelFlags(effectiveLevel(location.search)) ? { gl: levelFlags(effectiveLevel(location.search))! } : q0.get("safe") === "1" && !q0.get("gl") ? { gl: ["lowend" as const] } : {}),
      onError: (e) => { if (e.kind !== "context-restored" && e.kind !== "context-lost") /* ADR-199: gl-recovery already reports the loss (one overlay, not two) */ showRenderError(`Renderer: ${e.kind}`, `${e.message}${e.detail ? `\n${e.detail.slice(0, 300)}` : ""}\nTry ?gl=lowend or ?safe=1 — please report this text.`); } });
    } catch (e) { console.warn("[view] IsoRenderer failed", e); renderer = make2d(); }
    { const c = renderer.capabilities; console.info(`[view] gl ${c.renderer} mobile=${c.mobile} lowEnd=${c.lowEnd} flags=${c.flags.join(",")} fallbacks=${c.fallbacks.join("; ")}`); (globalThis as { __renderCaps?: unknown }).__renderCaps = c; }
    phase("renderer", t0); t0 = performance.now();
    onStage("manifest", 0);
    const packBase = `${base}art/pack/`;
    const { registry, deferredWearShards, wearIO } = await loadMergedManifest(`${base}art/`);
    onStage("atlases", 0);
    const sources = sourcesFromManifest(registry, packBase + "manifest.json", {}, { probeSiblings: false });
    phase("manifest", t0); t0 = performance.now();
    // ADR-548: time one painter group + record its PNG bytes (diag only — same painters,
    // same sources). blob.size comes from fetching the in-memory blob: URL (no network, no
    // copy); a source with several blob URLs (task410: 1x + @2x pages) sums them. A fetch
    // that fails (no fetch in this environment) leaves the size unknown; the timing still
    // stands. ADR-551: the groups run concurrently, so a group's ms is its own
    // start-to-finish wall time and groups may overlap; start order is still the
    // listed order below.
    const paintedGroups: { name: string; ms: number }[] = [];
    const paintedAtlasBytes: { key: string; bytes: number }[] = [];
    const paintGroup = async (name: string, run: () => Promise<Map<string, AtlasSource>>): Promise<void> => {
      const g0 = performance.now();
      const out = await run();
      for (const [k, src] of out) if (registry.atlases.has(k)) sources.set(k, src);
      for (const [k, src] of out) {
        let bytes = 0, seen = false;
        for (const u of [src.url, src.emissiveUrl, ...(src.pages ?? []).map((p) => p.url)]) {
          if (!u || !u.startsWith("blob:")) continue;
          try { bytes += (await (await fetch(u)).blob()).size; seen = true; } catch { /* size unknown */ }
        }
        if (seen) paintedAtlasBytes.push({ key: k, bytes });
      }
      paintedGroups.push({ name: `painted.${name}`, ms: Math.round(performance.now() - g0) });
    };
    // ADR-551: the 13 painter groups run CONCURRENTLY (one Promise.all), not one after another.
    // Each group is still cache-first (ADR-550: a warm boot paints nothing anywhere); on a cold
    // boot the misses paint in the Worker pool (2–4 paint-worker.ts threads, created lazily on
    // the first miss, so a warm boot pays nothing for threads it never uses) and fall back to
    // main-thread paint if no Worker exists or a worker fails. Per-group ms may therefore
    // OVERLAP, so the group entries can sum past the painted parent — partitionPhase drops
    // the (negative) residual instead of showing it, as ADR-548 already documents. The pool
    // is terminated once the phase closes: painting is boot-only work.
    const paintPool = createPaintWorkerPool();
    try {
      await Promise.all([
        paintGroup("task34", () => task34AtlasSources({}, paintPool)),
        paintGroup("task256", () => task256AtlasSources({}, paintPool)),
        paintGroup("task355", () => task355AtlasSources({}, paintPool)),
        paintGroup("task361", () => task361AtlasSources({}, paintPool)),
        paintGroup("task410", () => task410AtlasSources({}, paintPool)),
        paintGroup("task420", () => task420AtlasSources({}, paintPool)),
        paintGroup("task421", () => task421AtlasSources({}, paintPool)),
        paintGroup("task422", () => task422AtlasSources({}, paintPool)),
        paintGroup("task479", () => task479AtlasSources({}, paintPool)),
        paintGroup("task540", () => task540AtlasSources({}, paintPool)),
        paintGroup("footprint", () => footprintAtlasSources({}, paintPool)),
        paintGroup("track", () => trackAtlasSources({}, paintPool)),
        paintGroup("rod", () => rodAtlasSources({}, paintPool)),
      ]);
    } finally {
      paintPool?.terminate();
    }
    // ADR-548: the menu-icon paints below are one group (painted.icons) — ~31 small (128x128) icons, each
    // re-painting a cell and doing a synchronous toDataURL("image/png") on the same thread.
    const iconsT0 = performance.now();
    // ADR-357: the five store build-menu icons point at items_build frames 297–301, which are transparent
    // in the shipped atlas (no binary could ship through the snapshot route) — paint them at runtime from
    // the stores' own world art so the build menu shows them. Safe no-op without a canvas.
    installStoreMenuIcons();
    // ADR-361: the nine drawn-vehicle kits, three wooden parts and harness have no atlas cell or CSS rule
    // (they fall back to the fiber category icon) — paint them at runtime from the world art. Safe no-op
    // without a canvas.
    installVehicleMenuIcons();
    // ADR-420: the dock / shipyard build-menu icons point at items_build cells that are transparent in
    // the shipped atlas — paint them at runtime from the structures' own world art. Safe no-op without
    // a canvas.
    installTask420MenuIcons();
    // ADR-421: the three boat kits have no atlas cell or CSS rule either — paint them at runtime from
    // the boats' own world art. Safe no-op without a canvas.
    installBoatMenuIcons();
    // ADR-422: the three motorboat kits likewise — paint them at runtime from the motorboats' own
    // world art. Safe no-op without a canvas.
    installMotorboatMenuIcons();
    // ADR-479: the sailboat kit likewise — paint it at runtime from the sailboat's own world art.
    // Safe no-op without a canvas.
    installSailboatMenuIcons();
    // ADR-364: the guide's placement-hologram image needs the ghost ore store, which has no menu-icon art
    // (it is a rendering of the store's own world art in the game's ghost treatment) — paint it at
    // runtime from the store art. Safe no-op without a canvas.
    installGuideArt();
    // ADR-387: the Guide's own book icon (its menu entry carried the 📖 emoji) — painted at runtime
    // from the guide-art painter and registered in ICON_DATA, so the pause/settings Guide buttons and
    // the Guide panel headers render it. Safe no-op without a canvas.
    installGuideMenuIcon();
    // ADR-457: wet firewood's own icon (a wet pine log, not a tinted dry log) — painted at runtime
    // from the wetwood-art painter and registered in ICON_DATA, so the inventory / hotbar / toast /
    // crafting icons for wet_wood render it. Safe no-op without a canvas.
    installWetWoodIcon();
    // ADR-493: the fishing rod's own icon (a diagonal rod + reel + line and hook) — painted at
    // runtime from the fishing-rod-art painter and registered in ICON_DATA, so the inventory /
    // hotbar / toast / crafting icons for fishing_rod render it. Safe no-op without a canvas.
    installFishingRodIcon();
    paintedGroups.push({ name: "painted.icons", ms: Math.round(performance.now() - iconsT0) });
    // Art's customization pack (~220 paper-doll atlases, 1008x960): the renderer packs every atlas into one 2048² texture
    // array, so these alone need ~1.7 GiB of VRAM ("Texture total allocation size is too large" -> every sprite black).
    // Until Render loads outfit layers on demand, keep them out unless the array fits (?cz=1 forces them in).
    // Paper-doll layers are ON by default: Render streams wearable pages through a refcounted pool within the VRAM budget
    // (renderer.vram). ?cz=0 turns them off; under ?gl=lowend only the nearest DRESSED_LOWEND characters are dressed.
    const custom = [...registry.atlases.values()].filter((a) => /(^|\/)customization\//.test(a.image)).map((a) => a.key);
    for (const k of custom) { const src = sources.get(k); if (src) delete src.pages; } // 1x only for paper-doll layers
    lowendDress = renderer.capabilities.lowEnd || renderer.capabilities.flags.includes("lowend");
    if (q0.get("cz") === "1") lowendDress = false;
    if (custom.length && q0.get("cz") === "0") {
      for (const k of custom) { (registry.atlases as Map<string, unknown>).delete(k); sources.delete(k); }
      noCosmetics = true;
    }
    // ADR-555: with ?cz=0 the wear shards stay out for good (their atlases were just deleted above).
    // ADR-118: count atlas/KTX2 image responses as they land (Resource Timing works for fetch and <img>); expected =
    // the eager atlases (paper-doll/streamed ones load on demand later), so the fraction stays honest and capped < 1.
    // Task 34 blob URLs carry no file extension, so the png-regex watcher never counts them; exclude them so the fraction stays honest.
    const paintedAtlas = new Set<string>([...(TASK34_ATLAS_KEYS as readonly string[]), ...(TASK256_ATLAS_KEYS as readonly string[]), ...(TASK355_ATLAS_KEYS as readonly string[]), ...(TASK361_ATLAS_KEYS as readonly string[]), ...(TASK410_ATLAS_KEYS as readonly string[]), ...(TASK420_ATLAS_KEYS as readonly string[]), ...(TASK421_ATLAS_KEYS as readonly string[]), ...(TASK422_ATLAS_KEYS as readonly string[]), ...(TASK540_ATLAS_KEYS as readonly string[])]);
    const expected = [...registry.atlases.keys()].filter((k) => !custom.includes(k) && !paintedAtlas.has(k)).length;
    const stopWatch = watchResources(/\.(png|webp|ktx2|avif|jpe?g)(\?|$)/i, (n, bytes) => onStage("atlases", countFraction(n, expected), `Loading sprite atlases (${n}/${expected}${bytes ? `, ${(bytes / 1048576).toFixed(1)} MB` : ""})`));
    // ADR-380: the initial setRegistry has no frames to protect — disable the ADR-190 resize slicer for it (its
    // per-6ms frame yields turn resize CPU into several seconds of wall time during boot); re-tiers keep slicing.
    // The registry split comes from atlas.rebuildTimings; without it (Canvas2D) the whole call is one phase.
    phase("painted", t0); t0 = performance.now();
    // ADR-550: prune painted PNGs from retired painter hashes — bounded, async, never blocks
    // boot (fire-and-forget; prunePaintedCache never throws). The keep-set is the keys this
    // boot looked up or stored.
    void prunePaintedCache();
    // ADR-548: per-group split of the painted bracket (one entry per painter group + icons; the
    // residual — paper-doll loop, watcher setup — lands in painted.other). The groups sum to the
    // parent (up to ~1 ms of rounding per group); main.ts renders them via the parent marker.
    for (const e of partitionPhase("painted", phases[phases.length - 1]!.ms, paintedGroups)) phases.push(e);
    setResizeSlicing(false);
    try { await renderer.atlas.setRegistry(registry, sources); } finally { setResizeSlicing(true); stopWatch(); }
    const rt = renderer.atlas?.rebuildTimings;
    let registryNote: string | undefined;
    if (rt) {
      // ADR-548: the rebuild sub-splits ride as parent-marked entries (parts of registry.fetch /
      // registry.fitBudget / registry.upload — never double-counted; see partitionPhase/main.ts).
      // Existing phase names/fields are intact — only sub-fields are added.
      const rtPairs: { key: keyof typeof rt; label: string; parent?: string }[] = [
        { key: "fetchDecode", label: "registry.fetch" },
        { key: "fetchDecodeFetch", label: "registry.fetch.fetch", parent: "registry.fetch" },
        { key: "fetchDecodeDecode", label: "registry.fetch.decode", parent: "registry.fetch" },
        { key: "fetchDecodeWait", label: "registry.fetch.wait", parent: "registry.fetch" },
        { key: "fitBudget", label: "registry.fitBudget" },
        { key: "fitBudgetSearch", label: "registry.fitBudget.search", parent: "registry.fitBudget" },
        { key: "fitBudgetResizes", label: "registry.fitBudget.resizes", parent: "registry.fitBudget" },
        { key: "halveSide", label: "registry.halveSide" },
        { key: "layout", label: "registry.layout" },
        { key: "upload", label: "registry.upload" },
        { key: "uploadAlloc", label: "registry.upload.alloc", parent: "registry.upload" },
        { key: "uploadCopies", label: "registry.upload.copies", parent: "registry.upload" },
        { key: "uploadMips", label: "registry.upload.mips", parent: "registry.upload" },
        { key: "tables", label: "registry.tables" },
        { key: "bodies", label: "registry.bodies" },
        { key: "restore", label: "registry.restore" },
      ];
      for (const p of rtPairs) phases.push({ name: p.label, ms: Math.round(rt[p.key]), ...(p.parent ? { parent: p.parent } : {}) });
      // ADR-548: cold-atlas bytes + body-page count are not ms, so they ride as a load-cost note
      // (main.ts), not a sub-phase — the byte share ADR-552 needs and the count ADR-553 needs.
      const vs = renderer.atlas?.vramStats;
      registryNote = `registry: ${vs?.coldAtlases ?? 0} cold atlases (${(rt.coldAtlasBytes / 1048576).toFixed(1)} MB) · ${rt.bodyPages} body pages` +
        // ADR-557: load/source counts + slot peak + resize chain split are not phases — they ride
        // the note like the cold/body counts above (main.ts renders it verbatim).
        ` · ${rt.fetchDecodeLoads} loads (cache ${rt.fetchDecodeCacheHits} / network ${rt.fetchDecodeNetwork}, slot peak ${rt.fetchDecodePeak}, decode peak ${rt.fetchDecodeDecodePeak}) · resize chain wait ${Math.round(rt.resizeChainWait)}ms / run ${Math.round(rt.resizeChainRun)}ms`;
    } else phases.push({ name: "registry", ms: Math.round(performance.now() - t0) });
    t0 = performance.now();
    // ADR-370: warm-up window — page the visible-pin lazy sheets (furniture / buildings / openings /
    // defenses stream pages, in view at almost any spawn) in before the first paint, at near-player
    // priority, bounded so a slow device just gets a soft start instead of a stalled boot.
    // Resident atlases are already on the GPU; the window only covers lazy pages.
    // ADR-374: no firstView set is knowable here — no world, player or camera target exists yet,
    // so tier-0 ordering cannot happen at boot (it happens at world entry in main.ts
    // drainFirstView, once frames have synced the view). The page count is clamped to the
    // stream pool (warmupPageBudget: 12 on a low-memory pool, not 24); warmupFirstView clamps
    // again internally, so the cap holds even if this call site is ever bypassed.
    const warmupKeys = [...registry.atlases.keys()].filter((k) => isWarmupCandidate(k));
    const warmupResult = await renderer.atlas.warmupFirstView?.(warmupKeys, { maxPages: warmupPageBudget(renderer.atlas.streamPoolSlots?.()) });
    phase("warmup", t0); t0 = performance.now();
    onStage("atlases", 1); onStage("variants", 0);
    const pv = await assetFetch(packBase + "piece_variants.json").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { pieces?: Record<string, string[]> } | null;
    if (pv?.pieces) renderer.atlas.setPieceVariants(pv.pieces);
    for (const a of ["characters", "characters_b", "characters_c"]) if (registry.atlases.has(a)) {
      const h = await assetFetch(`${packBase}atlases/${a}.hands.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (h?.hands) renderer.atlas.setHands(a, h);
    }
    phase("variants", t0); t0 = performance.now();
    onStage("lighting", 0);
    const tuningUrl = `${base}art/survival_fx/render_tuning.json`;
    const look = await renderer.loadLook(tuningUrl);
    const lights = new LightTable(); lights.load(await assetFetch(tuningUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    if (look.warnings.length) console.info("render tuning:", look.warnings);
    renderer.camera.zoom = DESKTOP_ZOOM; // main.ts attachZoom then sizes it per viewport (ADR-100)
    phase("lighting", t0);
    onStage("ready", 0);
    const view = new IsoView(renderer, registry, ov, lights); view.base = base; view.warmupResult = warmupResult ?? undefined; view.bootPhases = phases; view.paintedAtlasBytes = paintedAtlasBytes; view.registryNote = registryNote;
    // ADR-555: the boot manifest excluded the wear shards — the view owns the lazy load from here.
    view.deferredWearShards = deferredWearShards; view.wearIO = wearIO; view.wearArtPackBase = packBase; view.wearDisabled = noCosmetics;
    return view;
  }

  private ghost: BuildGhost | undefined;
  /** Build-placement ghost from the client's buildMode.preview (call every frame; undefined removes it). Free-rotation
   *  pieces (rotSteps 16) are shown at the nearest quarter turn, triangles (12) on their exact art row (pieceArtRow); Tri/Free
   *  pieces pivot at the exact snapped x/y; variant goes by name (defs variantNames). */
  private lastTiles: TileMap | undefined;
  /** ADR-433: deck tiles (foundation / floor / roof) placed in the net world, rebuilt every render frame
   *  from the GPiece pass below — the inside signal for boundary-piece grounding. Reused, never reallocated. */
  private deckKeys = new Set<number>();
  /** ADR-196: world z the ghost is drawn at (terrain-lifted), for the snap overlay. */
  ghostZ: number | undefined;
  private presentedPivot: { x: number; y: number; z: number } | undefined;
  rotationPivot(): { x: number; y: number; z: number } | undefined { return this.presentedPivot; }
  private ladderSections = new Map<Entity, Entity[]>();
  /** ADR-299: tiles where someone is InShaft, so the hatch lid uses Art's open state. */
  private openHatchTiles = new Set<string>();
  /** ADR-299: pit-floor landing companion for each shaft hatch (net entity -> view entity). */
  private hatchBottoms = new Map<Entity, Entity>();
  syncGhost(p: import("@engine/gameplay").BuildPreview | undefined, net: World): void {
    if (!p && !this.ghost) return;
    this.ghost ??= new BuildGhost(this.view, VPiece as never, this.registry);
    if (!p) { if (this.ghost.entity !== null) this.pieceScales.delete(this.ghost.entity); this.ghost.sync(null); this.ghostZ = undefined; return; }
    const names = gameplayDefs(net).pieces.get(p.piece)?.variantNames ?? [];
    const def = gameplayDefs(net).pieces.get(p.piece);
    // ADR-142: lifted onto the terrain step like the placed piece (view mirror `ground`); at z=0 it sank under raised ground
    // ADR-412: boundary-anchored pieces (walls, corners) ground on the lowest touching tile, not the neighbour — a wall
    // ghost previewed against raised ground must sit on the structure's own tile, like the placed piece.
    // ADR-433: pass the deck set (previous frame's render; syncGhost runs before render in main.ts, so a deck
    // placed this frame reaches the ghost next frame — one frame of the old min grounding, invisible in practice;
    // the first frame has an empty set and also falls back to min). A wall ghost previewed against a dropped
    // outside neighbour now sits on its inside tile, like the placed piece, so the preview shows no gap either.
    const baseZ = pieceBoundaryGroundZ(this.lastTiles, p.x, p.y, p.z, gameplayDefs(net).building.levelHeight, this.deckKeys);
    // Overlay uses the drawn world z (story restored); the ghost entity keeps the stripped base so sprites.ts
    // `floorToTerrainZ(level, Transform.z)` does not double the story again.
    this.ghostZ = floorToTerrainZ(p.level, baseZ);
    // ADR-268: the visible hologram is the exact snapped request that Build confirms.
    // Easing between cells showed a different location from the authoritative preview.
    const gx = p.x, gy = p.y;
    const si = def?.roof && this.registry.spriteForPiece(this.pk(p.pieceKey) ?? p.pieceKey) === undefined ? this.roofStandIn(def.key, quarterTurn(p.rot, p.rotSteps), p.tier ?? 0) : undefined; // ADR-400
    if (si) this.ghost.sync({ pieceKey: si.pieceKey, x: gx, y: gy, rot: si.row, valid: p.valid }, { z: baseZ, level: p.level, rotFlags: pieceRotFlags(def), variant: si.variant });
    else this.ghost.sync({ pieceKey: this.pk(p.pieceKey) ?? p.pieceKey, x: gx, y: gy, rot: p.rot, valid: p.valid }, { z: baseZ, level: p.level, tier: p.tier, rotSteps: p.rotSteps, rotFlags: pieceRotFlags(def), ...(names[p.variant] ? { variant: names[p.variant]! } : { variant: p.variant }) });
    this.previewRoof(p, def, net);
    { const ge = this.ghost.entity, sc = this.pieceArtScale(p.pieceKey); if (ge !== null) { if (sc !== 1) this.pieceScales.set(ge, sc); else this.pieceScales.delete(ge); } } // ADR-227
  }
  /** ADR-400: see rfxStandIn (roof-tiler.ts). */
  private roofStandIn(key: string, rot: number, tier: number): ReturnType<typeof rfxStandIn> {
    return rfxStandIn(key, rot, tier, (k) => { const id = this.sid(k); return id === undefined ? undefined : this.registry.sprite(id).building?.piece; });
  }
  /** ADR-397: the placement preview runs the same continuous-roof selection, with the ghost tile as a member (memoised per level version). */
  private previewRoof(p: import("@engine/gameplay").BuildPreview, def: ReturnType<ReturnType<typeof gameplayDefs>["pieces"]["get"]>, net: World): void {
    if (!def?.roof) { this.roofPreview = undefined; return; }
    const x = Math.floor(p.x), y = Math.floor(p.y), rot = quarterTurn(p.rot, p.rotSteps); const tier = p.tier ?? 0;
    const sig = `${def.key},${x},${y},${p.level},${rot},${tier},${this.roofs.version.get(p.level) ?? 0}`;
    if (this.roofPreview?.sig === sig) return;
    const wm = roofWallMaterial(net, x, y, p.level - 1);
    const r = this.roofs.preview({ x, y, key: def.key, rot, tier, ...(wm !== undefined ? { wallMaterial: wm } : {}) }, p.level);
    this.roofPreview = { sig, fx: r?.fx };
  }
  /** A ladder covers the whole terrain face with native-size painted sections, never a stretched sprite. */
  private syncTerrainLadders(net: World, tiles: TileMap | undefined): void {
    const v = this.view, active = new Set<Entity>();
    for (const e of net.query([GPiece, Transform])) {
      const bp = net.get(e, GPiece)!; if (!gameplayDefs(net).pieces.get(bp.type)?.features.terrainLadder) continue;
      const base = this.map.get(e); if (base === undefined || !v.has(base, VPiece)) continue;
      active.add(e); const t = net.get(e, Transform)!;
      const { low, high } = ladderFaceHeights(tiles, t.x, t.y, bp.rot);
      const count = Math.max(1, Math.min(77, high - low));
      let sections = this.ladderSections.get(e); if (!sections) this.ladderSections.set(e, (sections = []));
      while (sections.length > count - 1) v.destroy(sections.pop()!);
      while (sections.length < count - 1) { const part = v.create(); v.add(part, Transform).add(part, PrevTransform).add(part, VPiece); sections.push(part); }
      for (let n = 0; n < count; n++) {
        const part = n === 0 ? base : sections[n - 1]!;
        const tf = { x: t.x, y: t.y, z: low + n, facing: t.facing };
        v.set(part, Transform, tf); v.set(part, PrevTransform, tf);
        if (n > 0) v.set(part, VPiece, v.get(base, VPiece)!);
      }
    }
    for (const [e, parts] of this.ladderSections) if (!active.has(e)) { for (const part of parts) v.destroy(part); this.ladderSections.delete(e); }
  }

  /** ADR-299: draw Art's shaft_hatch_bottom at the live hole floor under each placed hatch. */
  private syncHatchBottoms(net: World, tiles: TileMap | undefined): void {
    const v = this.view, active = new Set<Entity>();
    let defs: ReturnType<typeof gameplayDefs> | undefined;
    try { defs = gameplayDefs(net); } catch { defs = undefined; }
    if (!defs) {
      for (const [, part] of this.hatchBottoms) v.destroy(part);
      this.hatchBottoms.clear();
      return;
    }
    for (const e of net.query([GPiece, Transform])) {
      const bp = net.get(e, GPiece)!; if (!defs.pieces.get(bp.type)?.features.shaftHatch) continue;
      const base = this.map.get(e); if (base === undefined || !v.has(base, VPiece)) continue;
      const tierKey = bp.tier ? `shaft_hatch_bottom@tier${bp.tier}` : "shaft_hatch_bottom";
      const visualId = this.registry.spriteForPiece(this.pk(tierKey) ?? tierKey)
        ?? this.registry.spriteForPiece(this.pk("shaft_hatch_bottom") ?? "shaft_hatch_bottom");
      if (!visualId) continue;
      active.add(e);
      let part = this.hatchBottoms.get(e);
      if (!part) { part = v.create(); v.add(part, Transform).add(part, PrevTransform).add(part, VPiece); this.hatchBottoms.set(e, part); }
      const t = net.get(e, Transform)!;
      const z = groundZ(tiles, t.x, t.y, t.z);
      const tf = { x: t.x, y: t.y, z, facing: t.facing };
      v.set(part, Transform, tf); v.set(part, PrevTransform, tf);
      const src = v.get(base, VPiece)!;
      v.set(part, VPiece, { visualId, variant: src.variant, tint: src.tint, damageStage: src.damageStage, rotation: src.rotation, level: 0, layer: 0, ghost: 0 });
      const idx = this.pieceTintIdx.get(base);
      if (idx) this.setPieceTint(part, visualId, idx);
    }
    for (const [e, part] of this.hatchBottoms) if (!active.has(e)) { v.destroy(part); this.hatchBottoms.delete(e); }
  }

  resize(w: number, h: number, dpr: number): void {
    const safe = new URLSearchParams(location.search).get("safe") === "1" || this.renderer.capabilities.safe || this.renderer.capabilities.lowEnd;
    try { this.renderer.resize(w, h, safe ? 1 : dpr); } catch (e) { showRenderError("Resize failed", `${e instanceof Error ? e.message : String(e)}\n${glInfo(this.renderer.gl)}`); }
  }

  private sid(key: string | undefined): number | undefined { return key ? this.registry.ids.sprites.tryId(key) : undefined; }
  /** ADR-110: sprite with data-driven fallback (sprite_fallbacks.json); real art wins whenever the pack has the key. */
  private rsCache = new Map<string, (ResolvedSprite & { id: number }) | null>();
  private rs(key: string | undefined): (ResolvedSprite & { id: number }) | undefined {
    if (!key) return undefined; let r = this.rsCache.get(key);
    if (r === undefined) { const x = resolveSprite(key, (k) => this.sid(k) !== undefined); r = x ? { ...x, id: this.sid(x.key)! } : null; this.rsCache.set(key, r); }
    return r ?? undefined;
  }

  /** ADR-112: build-piece art fallback (sprite_fallbacks.json `to` chain over piece keys the pack has). */
  private pkCache = new Map<string, string>(); private pkScaleCache = new Map<string, number>();
  /** ADR-227: the fallback chain's `scale` for a build-piece key (campfire -> bonfire art at 0.55); 1 when the pack has the key. */
  pieceArtScale(key: string | undefined): number {
    if (!key) return 1; let r = this.pkScaleCache.get(key);
    if (r === undefined) { r = resolveSprite(key, (k) => this.registry.spriteForPiece(k) !== undefined)?.scale ?? 1; this.pkScaleCache.set(key, r); }
    return r;
  }
  /** ADR-227: per view piece entity draw scale (fallback `scale`), read by both renderers; absent = 1. */
  private pieceScales = new Map<number, number>();
  private pk(key: string | undefined): string | undefined {
    if (!key) return key; let r = this.pkCache.get(key);
    if (r === undefined) { r = resolveSprite(key, (k) => this.registry.spriteForPiece(k) !== undefined)?.key ?? key; this.pkCache.set(key, r); }
    return r;
  }
  /** Mirror `net` into the view World and draw. */
  /** `dayFrac`: the shared smoothed day clock (day-clock.ts, server-tick driven); falls back to net's tick-derived time. */
  render(net: World, tiles: TileMap | undefined, player: Entity | undefined, alpha: number, dayFrac?: number): void {
    const v = this.view, r = this.renderer;
    r.tilemap = tiles;
    v.tick = net.tick;
    const td = v.env(TimeOfDay), nt = net.env(TimeOfDay); td.dayLengthTicks = nt.dayLengthTicks || 72000; // fallback = 3600 s day @ 20 Hz (ADR-106)
    // ADR-115: never re-derive time from the view's own tick (that desynced peers); draw the shared server-tick clock.
    const frac = this.ov.hours !== undefined ? this.ov.hours / 24 : dayFrac;
    td.epochTick = frac !== undefined ? Math.round(v.tick - frac * td.dayLengthTicks) : nt.epochTick;
    { const len = td.dayLengthTicks, days = dayFrac !== undefined ? dayCount() : (net.tick - nt.epochTick) / len; setSeasonState(v, viewSeason(net, days, this.ov.season));
      // ADR-283: lighting reads the seasonal sun fraction (sunrise 0.25 / sunset 0.75); the wall clock stays on the HUD.
      setDayFraction(v, frac !== undefined ? sunFraction(net, frac, days, this.ov.season) : undefined); }
    const w = v.env(Weather), nw = net.env(Weather) as unknown as Record<string, number>;
    for (const k of Object.keys(w)) (w as unknown as Record<string, number>)[k] = nw[k] ?? 0;
    if (this.ov.weather !== undefined) { w.kind = this.ov.weather; w.intensity = this.ov.intensity ?? 1; }

    let defs: ReturnType<typeof gameplayDefs> | undefined; try { defs = gameplayDefs(net); } catch { defs = undefined; }
    const seen = this.seen; seen.clear();
    // the sim moves on the z=0 plane; lift entities onto the terrain step they stand on (tile height = world z)
    this.lastTiles = tiles; resetGroundCache(); this.deckKeys.clear(); const ground = (x: number, y: number, z: number): number => groundZ(tiles, x, y, z);
    const lhv = (defs as unknown as { building?: { levelHeight?: number } } | undefined)?.building?.levelHeight ?? 3;
    // ADR-162: a piece raised above its level floor (decor on a table) keeps that lift over terrain steps
    const groundPiece = (x: number, y: number, z: number): number => pieceGroundZ(tiles, x, y, z, lhv);
    // ADR-412: build pieces ground on the lowest tile touching a boundary anchor (walls, corners); walkers keep pieceGroundZ.
    // ADR-433: the boundary lift takes the deck set, so a wall with a deck above it grounds on its inside tile and its
    // top meets the roof — the Canvas2D fallback reads the same lifted Transform.z (canvas2d.ts gatherPieces), so
    // this one lift covers WebGL2, Canvas2D/Xbox and the ghost; no second, Canvas2D-only fix exists.
    const groundBoundaryPiece = (x: number, y: number, z: number): number => pieceBoundaryGroundZ(tiles, x, y, z, lhv, this.deckKeys);
    const hatchTiles = new Set<string>();
    if (defs && net.isRegistered(GPiece)) {
      for (const pe of net.query([GPiece, Transform])) {
        const pd = defs.pieces.get(net.getField(pe, GPiece, "type")!);
        // ADR-433: deck tiles for boundary grounding, from the same pass that already iterates every piece
        // (no extra query, one numeric Set.add per deck piece). The set is rebuilt every frame, so shovel
        // edits and demolitions are picked up immediately — the grounding is derived, never persisted.
        const pt = net.get(pe, Transform)!;
        const dk = deckKeyFor(pd?.family, pt.x, pt.y, pt.z, lhv);
        if (dk !== undefined) this.deckKeys.add(dk);
        if (!pd?.features.shaftHatch) continue;
        hatchTiles.add(`${Math.floor(pt.x)},${Math.floor(pt.y)}`);
      }
    }
    this.openHatchTiles.clear();
    if (net.isRegistered(InShaft)) {
      for (const te of net.query([InShaft, Transform])) {
        if (!net.getField(te, InShaft, "down")) continue;
        const tt = net.get(te, Transform)!;
        const k = `${Math.floor(tt.x)},${Math.floor(tt.y)}`;
        if (hatchTiles.has(k)) this.openHatchTiles.add(k);
      }
    }
    const rimPiece = (x: number, y: number, z: number): number => {
      const off = z - Math.round(z / lhv) * lhv;
      return off > 1e-3 ? shaftRimGroundZ(tiles, x, y, z - off) + off : shaftRimGroundZ(tiles, x, y, z);
    };
    let dressed: Set<Entity> | undefined;
    if (lowendDress && this.appearanceEnabled && net.isRegistered(Appearance)) { // nearest N to the camera keep their layers
      const cx = this.renderer.camera.x, cy = this.renderer.camera.y;
      const d = [...net.query([Appearance, Transform])].map((e) => { const t = net.get(e, Transform)!; return { e, d: (t.x - cx) ** 2 + (t.y - cy) ** 2 }; });
      dressed = new Set(d.sort((a, b) => a.d - b.d).slice(0, DRESSED_LOWEND).map((x) => x.e));
    }
    this.carriedNet.clear(); if (net.isRegistered(Stance)) for (const p of net.query([Stance])) { const id = net.getField(p, Stance, "carriedNetId"); const b = id ? netIdEntity(net, id) : undefined; if (b !== undefined) this.carriedNet.add(b); }
    for (const e of net.query([Transform])) {
      if (e === net.environment) continue;
      const cur = readXform(net, e, Transform, this.sCur)!; let prev = readXform(net, e, PrevTransform, this.sPrev) ?? cur; // ADR-157: scratch, no per-entity allocation
      // ADR-508: Transform read once into scratch (was an extra net.get copy per entity), and the hatch-tile string key is
      // only built when a hatch exists (it was a template string per entity per frame).
      const isPiece = net.has(e, GPiece), isAnim = !isPiece && net.has(e, GAnim);
      const grBase = isPiece ? groundBoundaryPiece : isAnim ? groundPiece : ground; // ADR-212: walkers on a deck keep their stand height over terrain steps
      const pinToRim = hatchTiles.size > 0 && hatchTiles.has(`${Math.floor(cur.x)},${Math.floor(cur.y)}`) && (isPiece || !(net.isRegistered(InShaft) && net.getField(e, InShaft, "down")));
      const gr = pinToRim ? (isPiece || net.has(e, GAnim) ? rimPiece : shaftRimGroundZ.bind(null, tiles)) : grBase;
      if (this.corrections && net.predicted.has(e)) prev = this.corrSampler.apply(this.corrections, e, net.tick, cur, prev, this.sPrev);
      let ve = this.map.get(e);
      if (ve === undefined) {
        const spec = this.classify(net, e, defs, e === player);
        if (!spec) continue;
        ve = v.create(); this.map.set(e, ve);
        v.add(ve, Transform, { x: cur.x, y: cur.y, z: gr(cur.x, cur.y, cur.z), facing: cur.facing }).add(ve, PrevTransform, { x: prev.x, y: prev.y, z: gr(prev.x, prev.y, prev.z), facing: prev.facing });
        if (spec.pieceVisual !== undefined && spec.roofRot !== undefined && spec.pieceKey) { const wm = roofWallMaterial(net, Math.floor(cur.x), Math.floor(cur.y), (spec.level ?? 0) - 1); this.roofs.add({ ve, x: Math.floor(cur.x), y: Math.floor(cur.y), level: spec.level ?? 0, key: spec.pieceKey, rot: spec.roofRot, tier: spec.roofTier ?? 0, ...(wm !== undefined ? { wallMaterial: wm } : {}) }); }
        if (spec.pieceVisual !== undefined) { v.add(ve, VPiece, { visualId: spec.pieceVisual, variant: spec.variant ?? 0, tint: spec.tint ?? 0, damageStage: spec.damage ?? 0, rotation: spec.rot ?? 0, level: spec.level ?? 0, layer: spec.layer ?? 1, ghost: 0 }); const sc = this.pieceArtScale(spec.pieceKey); if (sc !== 1) this.pieceScales.set(ve, sc); if (spec.tintIndex) this.setPieceTint(ve, spec.pieceVisual, spec.tintIndex); }
        else if (spec.sprite !== undefined) v.add(ve, Sprite, { spriteId: spec.sprite!, frameId: spec.frame ?? 0, flags: spec.flags ?? 0, scale: spec.scale ?? 1, tint: spec.tint ?? 0 });
        if (spec.shadow) v.add(ve, Shadow, { alpha: spec.shadow, length: 1 });
        if (spec.occluder) v.add(ve, Occluder, { fade: 0.35 });
        else if (spec.noOcclude) v.add(ve, Occluder, { fade: 1 }); // ADR-152: low prop whose frame anchor is tall but art is short -> never fade
        if (spec.light) { v.add(ve, LightSource, { ...spec.light, intensity: 0 }); this.lightOf.set(e, { spec: spec.light, ...(spec.fuelOf !== undefined ? { fuel: spec.fuelOf } : {}) }); }
        if (spec.character) { this.characters.add(ve); if (defs) this.walkRate = walkAnimRate(net); }
        if (spec.animated) { v.add(ve, VAnim, { state: 0, startTick: 0 }); v.add(ve, VWet, { level: 0 }); v.add(ve, VTemp, { cold: 0, heat: 0, shivering: 0 }); }
        if (spec.fuel) v.add(ve, VFuel, { burnUntilTick: 0, lit: 1 });
        if (spec.onCreate) this.scales.set(ve, spec.onCreate);
        if (e === player) { r.setFocusEntity(ve); this.focusVe = ve; }
        if (CAM_ANIMAL && net.has(e, Animal) && (this.camAnimal === undefined || !this.map.has(this.camAnimal))) this.camAnimal = e;
      }
      seen.add(e);
      // ADR-293: zero is a valid world heading, not an unset facing.
      // ADR-305: when they stop, keep the last travel heading so a southbound walk does not snap to north.
      const dx = cur.x - prev.x, dy = cur.y - prev.y, moving = dx * dx + dy * dy > 1e-6;
      const travel = facingAfterTravel(cur.facing, dx, dy, this.lastFace.get(e));
      if (travel.last !== undefined) this.lastFace.set(e, travel.last);
      const facing = travel.facing;
      writeXform(v, ve, PrevTransform, prev.x, prev.y, gr(prev.x, prev.y, prev.z), v.getField(ve, Transform, "facing")!);
      writeXform(v, ve, Transform, cur.x, cur.y, gr(cur.x, cur.y, cur.z), facing);
      if (v.has(ve, VAnim)) {
        const ga = net.getInto(e, GAnim, this.sAnim); const dead = net.has(e, Dead);
        let state = dead ? 5 : ga && ga.anim > 1 ? animMap(ga.anim) : moving ? (net.has(e, Zombie) ? 6 : 1) : 0;
        const an = net.has(e, Animal) ? net.get(e, Animal) : undefined;
        if (an) state = this.animalAnim(net, e, an, moving, dead, player);
        // ADR-107: anything on a swim tile at ground level swims (players have no replicated AnimState; locomotion only)
        // ADR-181: only DEEP water swims; shallow water wades (walk anim, body sunk to the shins, splashy wet particles)
        const depth = cur.z < 0.5 && defs && tiles ? waterDepthAt((x, y) => tiles.getTile(x, y), Math.floor(cur.x), Math.floor(cur.y), defs.movement.shallowRadius) : WaterDepth.None;
        if (!dead && (state <= 2 || state === 6 || state === 14) && depth === WaterDepth.Deep) state = 14;
        else if (state === 14 && depth !== WaterDepth.Deep) state = moving ? 1 : 0;
        if (depth === WaterDepth.Shallow) { v.setField(ve, Transform, "z", gr(cur.x, cur.y, cur.z) - WADE_SINK); if (moving && (v.getField(ve, VWet, "level") ?? 0) < WADE_WET) v.has(ve, VWet) ? v.set(ve, VWet, { level: WADE_WET }) : v.add(ve, VWet, { level: WADE_WET }); }
        if (v.getField(ve, VAnim, "state") !== state) v.set(ve, VAnim, { state, startTick: v.tick });
        if (moving) this.movingVe.add(ve); else this.movingVe.delete(ve); // ADR-241 crouch/carry walk
        if (net.has(e, Driver)) this.driverVe.add(ve); else this.driverVe.delete(ve);
        this.syncStance(net, e, ve); // ADR-244
        const wet = net.getField(e, Wetness, "level"); if (wet !== undefined && v.getField(ve, VWet, "level") !== wet && !(depth === WaterDepth.Shallow && moving && wet < WADE_WET)) v.set(ve, VWet, { level: wet });
        const bt = net.getInto(e, BodyTemp, this.sTemp); if (bt && (v.getField(ve, VTemp, "cold") !== bt.cold || v.getField(ve, VTemp, "heat") !== bt.heat || v.getField(ve, VTemp, "shivering") !== bt.shivering)) v.set(ve, VTemp, { cold: bt.cold, heat: bt.heat, shivering: bt.shivering });
      }
      if (net.has(e, ResourceNode) && v.has(ve, Sprite)) { // depleted nodes fade out
        const amt = net.getField(e, ResourceNode, "amount")!; const empty = amt === 0;
        // ADR-128: replicated node hp dropped -> short damped wiggle away from the local player (every client sees it)
        const was = this.nodeAmt.get(e); this.nodeAmt.set(e, amt);
        if (was !== undefined && amt < was) { const pt = player !== undefined ? net.get(player, Transform) : undefined; const ang = pt ? Math.atan2(cur.y - pt.y, cur.x - pt.x) : 0; this.nodeHit.set(e, { at: performance.now(), dx: Math.cos(ang), dy: Math.sin(ang) }); }
        const hit = this.nodeHit.get(e);
        if (hit) { const o = nodeWiggle(performance.now() - hit.at); if (o === undefined) this.nodeHit.delete(e); else v.set(ve, Transform, { x: cur.x + hit.dx * o, y: cur.y + hit.dy * o }); }
        const want = empty ? 0.0001 : this.baseScale(ve); if (v.getField(ve, Sprite, "scale") !== want) v.set(ve, Sprite, { scale: want });
      }
      this.syncHitReact(net, e, ve, cur);
      if (v.has(ve, Sprite) && net.has(e, LootBag)) this.syncLootFade(net, e, ve, alpha); // ADR-238: gentle fade of the bag itself before it despawns
      if (v.has(ve, Sprite) && net.has(e, NodeRegrow)) { // ADR-134: stump while it lasts, then invisible until regrown elsewhere
        const g = net.get(e, NodeRegrow)!; const want = g.stumpUntilTick > net.tick ? this.baseScale(ve) : 0.0001;
        if (v.get(ve, Sprite)!.scale !== want) v.set(ve, Sprite, { scale: want });
      }
      const lo = this.lightOf.get(e);
      if (lo) { // light follows the replicated lit state every frame (fires go out / get relit)
        const em = net.get(e, Emitter); const fu = net.get(lo.fuel ?? e, Fuel);
        const on = fu ? fu.lit === 1 : em ? em.strength > 0 : true;
        const want = on ? lo.spec.intensity : 0; const L = v.get(ve, LightSource)!; if (L.intensity !== want) v.set(ve, LightSource, { intensity: want });
        if (em?.kind === 2 && em.radius > 0 && L.radius !== em.radius) v.set(ve, LightSource, { radius: em.radius }); // ADR-216: radius follows the replicated Emitter
      }
      if (this.appearanceEnabled && net.isRegistered(Appearance)) { // paper-doll look (server-assigned, replicated)
        const a = dressed && !dressed.has(e) ? undefined : net.get(e, Appearance);
        if (!a && v.has(ve, Appearance)) v.remove(ve, Appearance); const va = a ? v.get(ve, Appearance) : undefined;
        if (a && (!va || va.version !== a.version)) { const init = { bodyType: a.bodyType, skinTone: a.skinTone, version: a.version, parts: [...a.parts], primary: [...a.primary], secondary: [...a.secondary] }; if (va) v.set(ve, Appearance, init); else v.add(ve, Appearance, init); }
        // ADR-555: a replicated look naming a wearable the boot catalog does not know yet is the
        // first wear-page request — load the wear shards (fire-and-forget; the character draws
        // body-only until the load lands and the atlas rebuilds, then dresses on the next sync).
        if (a && this.deferredWearShards.length && a.parts.some((id) => id !== 0 && !this.registry.cosmetics?.wearable(id))) void this.ensureWearShards();
      }
      if (net.isRegistered(Equipment) && net.has(e, Equipment)) { // ADR-135 held item + worn gear
        this.netRef = net; const eq = net.get(e, Equipment); const mh = eq?.mainHandItem ?? 0; const ms = eq?.mainHandSlot ?? 255;
        if (eq && !v.has(ve, VEquip)) v.add(ve, VEquip, { mainHandItem: mh, mainHandSlot: ms }); else if (v.has(ve, VEquip) && (v.getField(ve, VEquip, "mainHandItem") !== mh || v.getField(ve, VEquip, "mainHandSlot") !== ms)) v.set(ve, VEquip, { mainHandItem: mh, mainHandSlot: ms });
        const cat = this.registry.cosmetics; const gear = cat ? wornCosmetics(net, e, (k) => cat.byKey(k) !== undefined) : [];
        if (gear.length && cat) { let salt = 7; const parts: Array<[number, number]> = []; for (const [s, k] of gear) { const id = cat.byKey(k)?.id; if (id === undefined) continue; parts.push([slotIndex(s as WearableSlot), id]); salt = (salt * 31 + id * 8 + slotIndex(s as WearableSlot)) % 32749; }
          if (parts.length) this.gearOf.set(ve, { salt: salt + 1, parts }); else this.gearOf.delete(ve); }
        else this.gearOf.delete(ve);
      }
      if (net.isRegistered(Worn)) { // ADR-135 off-hand worn slot
        const oh = net.has(e, Worn) ? (net.get(e, Worn)?.item[OFFHAND_SLOT] ?? 0) : 0;
        if (oh) { this.netRef = net; if (!v.has(ve, VOffHand)) v.add(ve, VOffHand, { offHandItem: oh }); else if (v.getField(ve, VOffHand, "offHandItem") !== oh) v.set(ve, VOffHand, { offHandItem: oh }); }
        else if (v.has(ve, VOffHand)) v.remove(ve, VOffHand);
      }
      if (net.isRegistered(SlotDye)) { // Task 25: dyed inventory slots (held-item tint)
        const sd = net.get(e, SlotDye);
        if (sd) { const colors = [...sd.colors]; const cur = v.has(ve, VSlotDye) ? v.getArray(ve, VSlotDye, "colors") : undefined;
          const same = cur !== undefined && cur.length === colors.length && colors.every((c, i) => c === cur[i]);
          if (!same) { if (v.has(ve, VSlotDye)) v.set(ve, VSlotDye, { colors }); else v.add(ve, VSlotDye, { colors }); } }
        else if (v.has(ve, VSlotDye)) v.remove(ve, VSlotDye);
      }
      if (v.has(ve, VAnim)) this.syncHeldLight(net, e, ve); // ADR-216: a held torch/lantern/candle lights the area around its bearer
      if (v.has(ve, Sprite) && net.has(e, Crop)) { const c = net.get(e, Crop)!; const r = this.rs(cropSpriteKey(c.kind, c.stage)); if (r && (v.get(ve, Sprite)!.spriteId !== r.id || v.get(ve, Sprite)!.scale !== r.scale)) { v.set(ve, Sprite, { spriteId: r.id, scale: r.scale, tint: r.tint }); this.scales.set(ve, r.scale); } }
      if (v.has(ve, Sprite) && net.has(e, Road)) { const r0 = net.get(e, Road)!; const r = this.roadSprite(r0.surface, r0.mask); if (r && v.get(ve, Sprite)!.spriteId !== r.id) v.set(ve, Sprite, { spriteId: r.id }); } // neighbours placed / removed
      if (v.has(ve, Sprite) && net.has(e, Sign)) { const sp = v.get(ve, Sprite)!; const fid = this.signFrame(sp.spriteId, net.get(e, Sign)!.rot); if (sp.frameId !== fid) v.set(ve, Sprite, { frameId: fid }); } // rotated
      if (v.has(ve, VPiece)) { this.syncPieceState(net, e, ve, defs); this.syncPieceTint(net, e, ve); this.syncRaid(net, e, ve); }
      if (v.has(ve, VFuel)) { const f = net.get(e, Fuel); if (f) { v.set(ve, VFuel, { lit: f.lit, burnUntilTick: f.burnUntilTick }); if (v.has(ve, Sprite)) { const sp = v.get(ve, Sprite)!; const fid = this.fireFrame(sp.spriteId, f.lit !== 0); if (sp.frameId !== fid) v.set(ve, Sprite, { frameId: fid }); } } }
    }
    if (r.vfx) this.raid.step(this.registry, r.vfx, this.raidPieces, performance.now() / 1000); this.raidPieces.length = 0; // ADR-242 (Canvas2D: no vfx layer)
    for (const [ne, ve] of this.map) if (!seen.has(ne)) { this.roofs.remove(ve); if (ve === this.focusVe) { r.setFocusEntity(-1); this.focusVe = -1; } v.destroy(ve); this.map.delete(ne); this.corrSampler.forget(ne); this.lastFace.delete(ne); this.characters.delete(ve); this.movingVe.delete(ve); this.driverVe.delete(ve); this.bedOf.delete(ve); this.carriedOf.delete(ve); this.lightOf.delete(ne); this.dropHeldLight(ve); this.pieceStates.delete(ve); this.doors.forget(ve); this.pieceScales.delete(ve); this.pieceLit.delete(ve); this.litHearths.delete(ve); this.pieceTintPairs.delete(ve); this.pieceTintIdx.delete(ve); this.nodeAmt.delete(ne); this.nodeHit.delete(ne); this.animalHp.delete(ne); this.animalPrev.delete(ne); this.scales.delete(ve); this.hitSeen.delete(ne); this.hitPoseOf.delete(ve); this.gearOf.delete(ve); }

    this.roofs.refreshWalls((x, y, l) => roofWallMaterial(net, x, y, l)); // ADR-402: wall material changes reach the roof
    this.roofs.flush(); // ADR-397: re-picks only levels where a roof was placed / removed
    this.syncTerrainLadders(net, tiles);
    this.syncHatchBottoms(net, tiles);
    this.syncClutter(tiles, ground);
    this.syncMounts(net);
    this.syncVehicles(net, player, ground, frac);
    const camE = CAM_ANIMAL && this.camAnimal !== undefined ? this.camAnimal : player;
    const pv = camE !== undefined ? this.map.get(camE) : undefined;
    let want: { x: number; y: number; z: number } | undefined;
    if (pv !== undefined) { const t = v.get(pv, Transform)!, p = v.get(pv, PrevTransform) ?? t; want = this.sWant; want.x = p.x + (t.x - p.x) * alpha; want.y = p.y + (t.y - p.y) * alpha; want.z = p.z + (t.z - p.z) * alpha; }
    // Capture the actual interpolated player before camera-follow smoothing mutates sWant.
    this.presentedPivot = want ? { x: want.x, y: want.y, z: want.z } : undefined;
    const st = this.status;
    const why = player === undefined ? `no player entity (entities ${this.map.size}, local server ${st?.localServer ?? "?"}, snapshots ${st?.snapshots ?? 0}${st?.error ? `: ${st.error}` : ""})` : "player not mirrored into the view";
    // ADR-155: the target z is lifted onto stepped tile heights, so a step jerked the whole screen for 2-3 frames
    // (camera speed 3.8x). Ease only the camera's z (tau CAM_Z_TAU s); x/y stay exact, sprites stay on their steps.
    // Camera x/y follow is eased the same way (tau CAM_XY_TAU s): exact follow passed every tick jitter straight
    // to the screen. Sprites themselves still sit on their interpolated steps; only the camera lags slightly.
    if (want) { const now = performance.now(), dt = this.camZAt ? Math.min(CAM_DT_CAP_S, (now - this.camZAt) / 1000) : 0; this.camZAt = now;
      if (this.camZ === undefined || Math.abs(want.z - this.camZ) > CAM_Z_SNAP) this.camZ = want.z; else this.camZ += (want.z - this.camZ) * (1 - Math.exp(-dt / CAM_Z_TAU));
      want.z = this.camZ;
      this.camXY = stepCameraXY(this.camXY, want, dt);
      want.x = this.camXY.x; want.y = this.camXY.y; }
    const hadErr = this.camGuard.error; const tgt = this.camGuard.resolve(want, camE !== player ? "follow" : "player", why);
    if (this.camGuard.error && !hadErr) console.warn(`[render] ${this.camGuard.error}`);
    r.camera.lookAt(tgt.x + this.camShake.x, tgt.y + this.camShake.y, tgt.z); // ADR-214: screen shake offset (tiles; 0 when off)
    r.sceneDiag = { entities: this.map.size, playerEid: player, cameraTarget: tgt, localServer: st?.localServer, snapshots: st?.snapshots, lastError: st?.error ?? this.camGuard.error };
    v.runPhase("renderPrep", 0);
    const held0 = r.heldFrames;
    this.syncGrazed(net); // ADR-256: grazed grass art on the tilemap
    // ADR-455: footprints in snow and mud (client-side transient decals). Sample mover positions from
    // the net world (replicated Transforms) every 5 ticks and draw the current prints as one-frame VFX
    // overlays (flat ground decals). No sim state, no replication — each client stamps its own. The
    // snow cover comes from the view world (its season is set above); the wetness from the net world's
    // replicated ChunkSurface. Canvas2D has no VFX layer (r.vfx undefined), so footprints render on
    // WebGL2 only.
    if (player !== undefined) {
      const pt = net.get(player, Transform);
      if (pt) {
        const ft = footprintTuning(defs?.environment);
        sampleFootprints(this.footprints, net, pt.x, pt.y, net.tick, ft, snowCoverOf(v));
        if (this.footprintSpriteId === undefined) this.footprintSpriteId = this.rs(FOOTPRINT_SPRITE_KEY)?.id;
        if (this.trackSpriteId === undefined) this.trackSpriteId = this.rs(TRACK_SPRITE_KEY)?.id;
        if (r.vfx && this.footprintSpriteId !== undefined) {
          collectFootprintOverlays(this.footprints, { boot: this.footprintSpriteId, ...(this.trackSpriteId === undefined ? {} : { track: this.trackSpriteId }) }, net.tick, Math.max(1, Math.round(ft.fadeSeconds * 20)), this.footprintOverlays);
          r.vfx.overlay = this.footprintOverlays;
        }
      }
    }
    try { r.render(v, alpha); } catch (e) { showRenderError("Renderer exception", `${e instanceof Error ? e.stack ?? e.message : String(e)}\n${glInfo(r.gl)}`); return; }
    // all-black self-check over the first frames (daytime only, where black means a broken pass)
    // ADR-148: async readback (no pipeline stall during startup); the default framebuffer is read right after the frame
    blackFrameStep(this, r, held0);
  }
  private camZ: number | undefined; private camZAt = 0;
  private camXY: { x: number; y: number } | undefined;
  /** ADR-157 per-frame scratch components (render loop reads without allocating). */
  /** ADR-208: NetClient (or any provider) whose reconciliation offsets are rendered on predicted entities. */
  corrections: CorrectionSource | undefined; private corrSampler = new CorrectionSampler();
  private sWant = { x: 0, y: 0, z: 0 };
  private sBag = { owner: 0, despawnAtTick: 0, spawnTick: 0, kind: 0, emptiedTick: 0 };
  /** ADR-238: SpriteAlpha from the replicated despawn timer (server ticks; `alpha` = interpolation into the next tick). */
  private syncLootFade(net: World, e: Entity, ve: Entity, alpha: number): void {
    const v = this.view; const lb = net.getInto(e, LootBag, this.sBag); if (!lb) return;
    const a = this.carriedNet.has(e) ? 0 : despawnFadeAlpha(lb, net.tick + alpha); // ADR-244: a carried bag draws at its carrier's socket
    if (a >= 0.999) { if (v.has(ve, SpriteAlpha)) v.remove(ve, SpriteAlpha); }
    else if (v.has(ve, SpriteAlpha)) v.setField(ve, SpriteAlpha, "alpha", a); else v.add(ve, SpriteAlpha, { alpha: a });
  }
  private sCur = { x: 0, y: 0, z: 0, facing: 0 }; private sPrev = { x: 0, y: 0, z: 0, facing: 0 }; private sAnim: Record<string, number> & { anim: number } = { anim: 0 }; private sTemp = { cold: 0, heat: 0, shivering: 0 }; private sHit: Record<string, number> & { startTick: number; dir: number } = { startTick: 0, dir: 0 };
  /** ADR-214: per-frame camera shake offset in tiles, written by the VFX layer (fx/) before render. */
  readonly camShake = { x: 0, y: 0 };
  checks = 0; blackFrames = 0; blackCheck: BlackFrameCheck | undefined;
  /** View entity currently given to setFocusEntity; cleared when destroyed so a recycled id (a remote player) never inherits the focus silhouette. */
  private focusVe = -1;
  /** ADR-110 render-only ground clutter: view-World sprites for chunks around the camera (never networked). Density 1,
   *  ~0.35 under ?gl=lowend / ?safe=1; hard cap on live sprites; ?clutter=0 disables. Missing clutter_* art = nothing. */
  private clutter = new Map<string, Entity[]>(); private clutterFrame = 0; private clutterCount = 0;
  private syncClutter(tiles: TileMap | undefined, ground: (x: number, y: number, z: number) => number): void {
    if (!tiles || CLUTTER.density <= 0 || ++this.clutterFrame % 15 !== 1) return;
    const v = this.view; const ccx = tileToChunk(Math.floor(this.renderer.camera.x)), ccy = tileToChunk(Math.floor(this.renderer.camera.y)); const R = CLUTTER.radius;
    for (const [k, list] of this.clutter) { const [x, y] = k.split(",").map(Number) as [number, number];
      if (Math.abs(x - ccx) > R + 1 || Math.abs(y - ccy) > R + 1) { for (const ve of list) v.destroy(ve); this.clutterCount -= list.length; this.clutter.delete(k); } }
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const cx = ccx + dx, cy = ccy + dy, k = `${cx},${cy}`; if (this.clutter.has(k) || !tiles.getChunk(cx, cy)) continue;
      const list: Entity[] = [];
      for (const it of clutterForChunk(0x5eed, cx, cy, CHUNK_SIZE, (tx, ty) => tiles.getTile(tx, ty), CLUTTER.density)) {
        if (this.clutterCount + list.length >= CLUTTER.cap) break;
        const r = this.rs(it.key); if (!r) continue; // no art and no fallback: skipped
        const ve = v.create(); const z = ground(it.x, it.y, 0);
        v.add(ve, Transform, { x: it.x, y: it.y, z, facing: 0 }).add(ve, PrevTransform, { x: it.x, y: it.y, z, facing: 0 }).add(ve, Sprite, { spriteId: r.id, frameId: 0, flags: it.flip ? SpriteFlag.FlipX : 0, scale: it.scale * r.scale, tint: r.tint });
        list.push(ve);
      }
      this.clutter.set(k, list); this.clutterCount += list.length;
    }
  }
  /** ADR-242: raid hit / repair / collapse fx input + Burning mirror for one piece. */
  private readonly raid = new RaidFx(); private readonly raidPieces: RaidPiece[] = [];
  /** ADR-455: client-side transient footprints (snow/mud) + their one-frame VFX overlay (reused scratch). */
  private readonly footprints = new FootprintStore(); private readonly footprintOverlays: VfxSpawn[] = [];
  private footprintSpriteId: number | undefined;
  /** ADR-501: the animal-track sprite id (undefined until resolved, like footprintSpriteId). */
  private trackSpriteId: number | undefined;
  private syncRaid(net: World, e: Entity, ve: Entity): void {
    const v = this.view; const bp = net.get(e, GPiece); const t = v.get(ve, Transform); if (!bp || !t) return;
    this.raidPieces.push({ e, x: Math.floor(t.x) + 0.5, y: Math.floor(t.y) + 0.5, z: floorToTerrainZ(v.getField(ve, VPiece, "level") ?? 0, t.z), hp: bp.hp, tier: bp.tier });
    const b = net.isRegistered(Burning) ? net.get(e, Burning) : undefined; const has = v.has(ve, VBurn);
    if (b && b.lit) { if (!has) v.add(ve, VBurn, { lit: 1, intensity: b.intensity, startTick: b.startTick }); else if (v.getField(ve, VBurn, "intensity") !== b.intensity) v.set(ve, VBurn, { intensity: b.intensity }); }
    else if (has) v.remove(ve, VBurn);
  }
  /** ADR-134: replicated HitReact -> flinch (knockback nudge on the view Transform, squash on Sprite.scale, flash/tilt bindings). */
  private syncHitReact(net: World, e: Entity, ve: Entity, cur: { x: number; y: number }): void {
    const h = net.getInto(e, HitReact, this.sHit); const v = this.view; const now = performance.now();
    if (h) { const s = this.hitSeen.get(e);
      if (!s) this.hitSeen.set(e, { tick: h.startTick, at: net.tick - h.startTick <= 6 ? now : -1e9, dir: hitDirRad(h.dir), directed: h.src !== 0 }); // late joiners skip stale hits
      else if (s.tick !== h.startTick) { s.tick = h.startTick; s.at = now; s.dir = hitDirRad(h.dir); s.directed = h.src !== 0; } }
    const s = this.hitSeen.get(e); const pose = s ? hitPose(now - s.at, s.dir, s.directed) : undefined;
    const had = this.hitPoseOf.get(ve);
    if (!pose) { if (had) { this.hitPoseOf.delete(ve); if (v.has(ve, Sprite)) v.set(ve, Sprite, { scale: had.base }); } return; }
    const base = had?.base ?? v.get(ve, Sprite)?.scale ?? 1;
    this.hitPoseOf.set(ve, { ...pose, base });
    const t = v.get(ve, Transform)!; v.set(ve, Transform, { x: cur.x + pose.dx, y: cur.y + pose.dy, z: t.z, facing: t.facing });
    if (v.has(ve, Sprite)) v.set(ve, Sprite, { scale: base * pose.scale });
  }
  /** ADR-134 test/diag hook: current flinch pose of a net entity's view, if any. */
  hitPoseFor(netEntity: Entity): { scale: number; tilt: number; flash: number } | undefined { const ve = this.map.get(netEntity); return ve === undefined ? undefined : this.hitPoseOf.get(ve); }
  /** Set by the app each frame (local-server state, snapshots received, startup error) for diag + the camera fallback. */
  status: ViewStatus | undefined;
  readonly camGuard = new CameraTargetGuard(CAMERA_FALLBACK, CAMERA_GRACE_FRAMES);
  private animalHp = new Map<Entity, { hp: number; hitUntil: number }>();
  /** Animal anim (render state ids: 0 idle, 1 walk, 2 run, 4 hit, 5 death) from Animal.state (0 idle, 1 wander, 2 flee), movement and Health. */
  private animalAnim(net: World, e: Entity, an: { kind: number; state: number }, moving: boolean, dead: boolean, _player: Entity | undefined): number {
    const now = performance.now(); const hp = net.getField(e, Health, "hp"); const rec = this.animalHp.get(e) ?? { hp: hp ?? 0, hitUntil: 0 };
    if (hp !== undefined) { if (hp < rec.hp - 1e-3) rec.hitUntil = now + 250; rec.hp = hp; } this.animalHp.set(e, rec); // ADR-117: animal sounds come from the audio director
    let st = dead || (hp !== undefined && hp <= 0) ? 5 : now < rec.hitUntil ? 4 : an.state === 2 && moving ? 2 : moving ? 1 : petSits(net, e) ? 13 : 0; // ADR-146: Stay -> sit
    if (st === 0 && this.grazes(net, e, an.kind)) st = 9; // ADR-322: graze (mount sheets: tamed mounts, wild horse / donkey / yak)
    this.animalPrev.set(e, st === 5 ? 5 : an.state);
    return st;
  }
  private animalPrev = new Map<Entity, number>();
  /** ADR-322: a standing, unridden mount-sheet animal grazes: when just fed (AnimState Eat / Graze) or on its idle cycle. */
  private grazes(net: World, e: Entity, kind: number): boolean {
    const tamed = net.isRegistered(Mount) && net.has(e, Mount);
    if (!tamed && !MOUNT_SHEET_WILD.has(animalDefs()[kind]?.key ?? "")) return false;
    if (tamed && (net.getField(e, Mount, "riderNetId") ?? 0) !== 0) return false;
    const ga = net.getInto(e, GAnim, this.sAnim); if (ga && (ga.anim === 8 || ga.anim === 9)) return true;
    return idleGrazing(net.tick, this.renderer.tickHz || 20, (entityIndex(e) * 2654435761) >>> 0);
  }
  base = "/"; private camAnimal: Entity | undefined;

  private scales = new Map<Entity, number>();

  /** Owning piece of an attachment: the BuildPiece standing at the same position (attachments copy its Transform). */
  private pieceAt(net: World, e: Entity): Entity | undefined {
    const t = net.get(e, Transform); if (!t) return undefined;
    for (const p of net.query([GPiece, Transform])) { const pt = net.get(p, Transform)!; if (Math.abs(pt.x - t.x) < 1e-3 && Math.abs(pt.y - t.y) < 1e-3 && Math.abs(pt.z - t.z) < 1e-3) return p; }
    return undefined;
  }
  private pieceKeyAt(net: World, e: Entity, defs: ReturnType<typeof gameplayDefs> | undefined): string | undefined {
    const p = this.pieceAt(net, e); return p !== undefined ? defs?.pieces.get(net.get(p, GPiece)!.type)?.key : undefined;
  }
  private siblings(net: World, e: Entity): Entity[] {
    const t = net.get(e, Transform)!; const out: Entity[] = [];
    for (const o of net.query([PieceLink, Transform])) { if (o === e) continue; const ot = net.get(o, Transform)!; if (Math.abs(ot.x - t.x) < 1e-3 && Math.abs(ot.y - t.y) < 1e-3 && Math.abs(ot.z - t.z) < 1e-3) out.push(o); }
    return out;
  }
  private hasLightSibling(net: World, e: Entity): boolean { return this.siblings(net, e).some((o) => net.get(o, Emitter)?.kind === 2); }
  private fuelSibling(net: World, e: Entity): Entity | undefined { return this.siblings(net, e).find((o) => net.has(o, Fuel)); }
  /** Fired pieces show their "unlit" building state while their fire attachment is out. */
  /** ADR-230: clan tint pair for a piece whose art carries a tintmask (else none: an unmasked frame would be multiplied whole). */
  private setPieceTint(ve: Entity, visualId: number, idx: number): boolean {
    const t = clanPieceTintPair(this.registry, visualId, idx); const had = this.pieceTintPairs.get(ve);
    this.pieceTintIdx.set(ve, idx);
    if (!t) { if (had) { this.pieceTintPairs.delete(ve); return true; } return false; }
    if (had && had[0] === t[0] && had[1] === t[1]) return false;
    this.pieceTintPairs.set(ve, t); return true;
  }
  /** ADR-230: repaint / clan change -> retint (staggered every 15 ticks; only a changed index touches VPiece, so static chunks stay cached). */
  private syncPieceTint(net: World, e: Entity, ve: Entity): void {
    if ((net.tick + entityIndex(e)) % 15 !== 0) return;
    const p = net.get(e, GPiece); if (!p) return; const idx = p.paint || p.tint;
    if ((this.pieceTintIdx.get(ve) ?? 0) === idx) return;
    const vid = this.view.get(ve, VPiece)!.visualId; this.setPieceTint(ve, vid, idx);
    const t = this.pieceTintPairs.get(ve); this.view.set(ve, VPiece, { tint: t ? t[0] : 0 });
  }
  private syncPieceState(net: World, e: Entity, ve: Entity, defs: ReturnType<typeof gameplayDefs> | undefined): void {
    const p0 = net.get(e, GPiece); if (!p0 || !defs) return;
    const pieceDef = defs.pieces.get(p0.type);
    if (pieceDef?.features.shaftHatch) {
      const t = net.get(e, Transform)!;
      const open = this.openHatchTiles.has(`${Math.floor(t.x)},${Math.floor(t.y)}`);
      const vis = buildPieceVisual(this.registry, { type: p0.type, ...pieceArt(net, p0.type, p0.rot), tint: p0.tint, paint: p0.paint, damageStage: p0.damageStage, state: open ? "open" : "closed" }, { tier: p0.tier, pieceKey: (typ) => this.pk(defs.pieces.get(typ)?.key), ...pieceVariantOpts(pieceDef.variantNames, p0.variant) });
      this.pieceStates.set(ve, vis.stateIndex);
      return;
    }
    if (pieceDef?.door) { // ADR-314: DoorState lives on the Door attachment (replicated); draw open / closed / breached and swing on change
      const att = resolveAttachment(net, e, AttachKind.Door); const open = att !== undefined ? net.getField(att, DoorState, "open") ?? 0 : 0;
      const vid = this.view.get(ve, VPiece)?.visualId ?? 0;
      const opts = { tier: p0.tier, pieceKey: (typ: number) => this.pk(defs.pieces.get(typ)?.key), ...pieceVariantOpts(pieceDef.variantNames, p0.variant) };
      const st = this.doors.sync(ve, open, () => doorArt(this.registry, pieceDef.key, { type: p0.type, ...pieceArt(net, p0.type, p0.rot), tint: p0.tint, paint: p0.paint, damageStage: p0.damageStage }, opts), vid);
      if (st >= 0) this.pieceStates.set(ve, st); else this.pieceStates.delete(ve);
      return;
    }
    const def = pieceDef as { fired?: boolean } | undefined;
    if (isStorePieceKey(pieceDef?.key)) { // ADR-356: store fill state (StoreFill, mirrored by gameplay.storeFill)
      if ((net.tick + entityIndex(e)) % 15 !== 0 && this.pieceStates.has(ve)) return; // cheap: fill changes are rare
      const level = net.isRegistered(StoreFill) && net.has(e, StoreFill) ? net.getField(e, StoreFill, "level") ?? 0 : 0;
      const p = net.get(e, GPiece)!;
      const vis = buildPieceVisual(this.registry, { type: p.type, ...pieceArt(net, p.type, p.rot), tint: p.tint, paint: p.paint, damageStage: p.damageStage, state: level }, { tier: p0.tier, pieceKey: (typ) => this.pk(defs.pieces.get(typ)?.key), ...pieceVariantOpts(pieceDef?.variantNames, p0.variant) });
      this.pieceStates.set(ve, vis.stateIndex);
      return;
    }
    if (net.isRegistered(GPower) && net.has(e, GPower)) { // ADR-590: powered pieces play their `idle` loop only while powered AND in use (Power.active), else `unlit`
      if ((net.tick + entityIndex(e)) % 10 !== 0 && this.pieceStates.has(ve)) return; // cheap: active flips at most once per 1 Hz grid solve
      const active = net.getField(e, GPower, "active") === 1; const p = net.get(e, GPiece)!;
      const vis = buildPieceVisual(this.registry, { type: p.type, ...pieceArt(net, p.type, p.rot), tint: p.tint, paint: p.paint, damageStage: p.damageStage, state: active ? "idle" : "unlit" }, { tier: p0.tier, pieceKey: (t) => this.pk(defs.pieces.get(t)?.key), ...pieceVariantOpts(pieceDef?.variantNames, p.variant) });
      this.pieceStates.set(ve, vis.stateIndex); this.pieceLit.set(ve, active ? 1 : 0); // FireState.Lit = idle loop, no hearth particles
      return;
    }
    if (!def?.fired) return;
    if ((net.tick + entityIndex(e)) % 15 !== 0 && this.pieceStates.has(ve)) return; // cheap: lit flips are rare
    const fire = this.siblings(net, e).find((o) => net.has(o, Fuel)); const lit = fire !== undefined && net.get(fire, Fuel)!.lit === 1;
    const p = net.get(e, GPiece)!;
    const vis = buildPieceVisual(this.registry, { type: p.type, ...pieceArt(net, p.type, p.rot), tint: p.tint, paint: p.paint, state: lit ? "idle" : "unlit" }, { pieceKey: (t) => this.pk(defs?.pieces.get(t)?.key), ...pieceVariantOpts(defs?.pieces.get(p.type)?.variantNames, p.variant) });
    this.pieceStates.set(ve, vis.stateIndex);
    const fs = pieceFireState(defs?.pieces.get(p.type)?.key, lit); this.pieceLit.set(ve, fs);
    if (fs === 2) this.litHearths.set(ve, fs); else this.litHearths.delete(ve);
  }
  /** ADR-119: autotile variant for the replicated mask, else the plain surface tile (with sprite_fallbacks). */
  private roadSprite(surface: number, mask: number): (ResolvedSprite & { id: number }) | undefined {
    const [m, base] = roadSpriteKeys(surfaceDef(surface)?.key, mask); const exact = this.sid(m);
    return exact !== undefined ? { key: m, id: exact, scale: 1, tint: 0 } as ResolvedSprite & { id: number } : this.rs(base);
  }
  private fireFrame(sid: number, lit: boolean): number {
    let names: string[] = []; try { names = this.registry.sprite(sid).animList.map((a) => a.name ?? ""); } catch { /* unknown sprite */ }
    return stationFireFrame(names, lit);
  }
  private signFrame(sid: number, rot: number): number {
    let names: string[] = []; try { names = this.registry.sprite(sid).animList.map((a) => a.name ?? ""); } catch { /* unknown sprite */ }
    return signFrameId(names, rot);
  }
  private baseScale(ve: Entity): number { return this.scales.get(ve) ?? 1; }

  /** ADR-170: vehicles were never drawn in the client (render's VehicleView had no caller). Mirror every net Vehicle as a
   * VehicleSnapshot (key = NetId) into VehicleView, which owns the segment sprites + headlight lights in the view World. */
  private vehicleView: VehicleView | undefined; private vehAt = 0;
  readonly vehicleSnaps: VehicleSnapshot[] = [];
  /** ADR-319 rider gait per rider view entity (anim chain ride_idle / ride_walk / ride_gallop). */
  private rideOf = new Map<number, 0 | 1 | 2>();
  /** ADR-322: rider ve -> swim clip (px above the seat pivot); mount -> {act, tick it began} (rider own clock). */
  private riderClipOf = new Map<number, number>(); /** ADR-518: vehicle rider view entity -> window clip */ private riderWinOf = new Map<number, { bottom: number; top: number; glass?: { lo: number; hi: number; vehicle: number } }>(); private mountAct = new Map<Entity, { act: MountAct; at: number }>();
  /** ADR-319 / ADR-320 view-only layers of a mount: saddle overlay and (while ridden) the fore layer drawn over the rider. ADR-361: the harness overlay, one step below the saddle. */
  private mountLayers = new Map<Entity, { harness?: Entity; saddle?: Entity; fore?: Entity }>();
  /**
   * ADR-319 / ADR-320 mounts on every peer, from replicated Mount / Riding:
   * - a tamed mount switches to its true-scale `mount_<art>` sheet (taming happens after the view entity exists);
   * - the mount takes the rider's (predicted or interpolated) pose, so it never slides under them; gait idle / walk / gallop
   *   from Riding.speed, and the rider's ride_<gait> restarts on the same tick so both play frame-locked (1:1 frames, same fps);
   * - the rider sits at the mount frame's `seat` anchor (the doll's own ride_* seat socket lands there, see sprites.ts);
   * - draw order mount -> saddle `mount_saddle_<art>_<tier>` -> rider -> `mount_<art>_fore`, by screen-neutral depth shifts.
   */
  private syncMounts(net: World): void {
    const v = this.view; const riders = new Set<number>();
    if (net.isRegistered(Mount)) {
      const q = (this.renderer.iso.view ?? 0) & 3; const live = new Set<Entity>();
      for (const m of net.query([Mount])) {
        const mve = this.map.get(m); if (mve === undefined || !v.has(mve, Transform)) continue; live.add(m);
        const mm = net.get(m, Mount)!; const sp = mm.species;
        const want = this.rs(mountSpriteKeyOf(sp)); const cur = v.get(mve, Sprite);
        if (want && cur && cur.spriteId !== want.id && !net.has(m, Dead)) { v.set(mve, Sprite, { spriteId: want.id, scale: want.scale, tint: want.tint }); this.scales.set(mve, want.scale); }
        const rider = mm.riderNetId ? netIdEntity(net, mm.riderNetId) : undefined;
        const rve = rider !== undefined && net.has(rider, Riding) ? this.map.get(rider) : undefined;
        const L = this.mountLayers.get(m) ?? {}; this.mountLayers.set(m, L);
        // ADR-322: the mount's action (hit / graze / moose swim; death = the rider is off) from its view anim state
        const mst = v.getField(mve, VAnim, "state") ?? 0; const act = mountActOf(mst, this.spriteHasAnim(mve, "swim"));
        if (act) { const was = this.mountAct.get(m); if (!was || was.act !== act) this.mountAct.set(m, { act, at: v.tick }); } else this.mountAct.delete(m);
        if (rider !== undefined && rve !== undefined && v.has(rve, Transform) && act !== "death" && !net.has(m, Dead)) {
          const t = v.get(rve, Transform)!, p = v.get(rve, PrevTransform);
          v.set(mve, Transform, { x: t.x, y: t.y, z: t.z, facing: t.facing }); if (p && v.has(mve, PrevTransform)) v.set(mve, PrevTransform, { x: p.x, y: p.y, z: p.z, facing: p.facing });
          const gait = mountGait(net.getField(rider, Riding, "speed") ?? 0, sp);
          if (v.has(mve, VAnim) && !act) { const st = v.getField(mve, VAnim, "state") ?? 0; if (st !== gait && st <= 2) v.set(mve, VAnim, { state: gait, startTick: v.tick }); }
          // gaits: rider frame fi = mount frame fi (same start tick, same fps); actions: ride_idle on the rider's own clock
          const rs = riderStartTick(act, v.getField(mve, VAnim, "startTick") ?? v.tick, this.mountAct.get(m)?.at ?? v.tick);
          if (v.has(rve, VAnim) && (v.getField(rve, VAnim, "state") !== 13 || v.getField(rve, VAnim, "startTick") !== rs)) v.set(rve, VAnim, { state: 13, startTick: rs });
          this.rideOf.set(rve, act ? 0 : gait); riders.add(rve); this.driverVe.add(rve); this.movingVe.delete(rve);
          const an = this.mountAnchors(mve, act ?? MOUNT_GAIT_ANIM[gait], q);
          if (act === "swim" && an?.seat && an.water) this.riderClipOf.set(rve, swimClipPx(an.seat.y, an.water.y)); else this.riderClipOf.delete(rve);
          const pose = riderPose(sp, an?.seat, q);
          v.set(rve, Transform, { x: t.x + pose.dx, y: t.y + pose.dy, z: t.z + pose.dz }); if (p) v.set(rve, PrevTransform, { x: p.x + pose.dx, y: p.y + pose.dy, z: p.z + pose.dz });
          const fore = this.layerOn(mve, L.fore, mountForeKey(sp), LAYER_KEY.fore, q); if (fore !== undefined) L.fore = fore; else delete L.fore;
        } else if (L.fore !== undefined) { v.destroy(L.fore); delete L.fore; }
        const sad = this.layerOn(mve, L.saddle, mm.saddle ? saddleOverlayKey(mm.saddle, sp) : "", LAYER_KEY.saddle, q); if (sad !== undefined) L.saddle = sad; else delete L.saddle;
        // ADR-361: the harness overlay, exactly while MountHarness is present (drops with the mount's death loot).
        const har = this.layerOn(mve, L.harness, isHarnessed(net, m) ? harnessOverlayKey(sp) : "", LAYER_KEY.harness, q); if (har !== undefined) L.harness = har; else delete L.harness;
      }
      for (const [m, L] of this.mountLayers) if (!live.has(m)) { if (L.harness !== undefined) v.destroy(L.harness); if (L.saddle !== undefined) v.destroy(L.saddle); if (L.fore !== undefined) v.destroy(L.fore); this.mountLayers.delete(m); }
    }
    for (const ve of this.rideOf.keys()) if (!riders.has(ve)) this.rideOf.delete(ve);
    for (const ve of this.riderClipOf.keys()) if (!riders.has(ve)) this.riderClipOf.delete(ve);
    for (const m of this.mountAct.keys()) if (!net.isAlive(m)) this.mountAct.delete(m);
  }
  /** True when the sprite on view entity `ve` has an animation named `anim`. */
  private spriteHasAnim(ve: Entity, anim: string): boolean {
    const sp = this.view.get(ve, Sprite); if (!sp) return false;
    try { return this.registry.sprite(sp.spriteId).animations.has(anim); } catch { return false; }
  }
  /** Creates / updates / removes one overlay layer (`key` sprite) on mount view entity `mve`, `k` sort steps above it. */
  private layerOn(mve: Entity, ve: Entity | undefined, key: string, k: number, q: number): Entity | undefined {
    const v = this.view; const r = key ? this.rs(key) : undefined;
    if (!r) { if (ve !== undefined) v.destroy(ve); return undefined; }
    const t = v.get(mve, Transform)!, p = v.get(mve, PrevTransform) ?? t; const a = v.get(mve, VAnim); const sh = screenNeutralShift(k, q);
    if (ve === undefined) { ve = v.create(); v.add(ve, Transform, { x: 0, y: 0, z: 0, facing: 0 }).add(ve, PrevTransform, { x: 0, y: 0, z: 0, facing: 0 }).add(ve, Sprite, { spriteId: r.id, frameId: 0, flags: 0, scale: r.scale, tint: r.tint }).add(ve, VAnim, { state: 0, startTick: 0 }); }
    else if (v.getField(ve, Sprite, "spriteId") !== r.id) v.set(ve, Sprite, { spriteId: r.id, scale: r.scale, tint: r.tint });
    v.set(ve, Transform, { x: t.x + sh.dx, y: t.y + sh.dy, z: t.z + sh.dz, facing: t.facing }); v.set(ve, PrevTransform, { x: p.x + sh.dx, y: p.y + sh.dy, z: p.z + sh.dz, facing: p.facing });
    if (a && (v.getField(ve, VAnim, "state") !== a.state || v.getField(ve, VAnim, "startTick") !== a.startTick)) v.set(ve, VAnim, { state: a.state, startTick: a.startTick });
    return ve;
  }
  /** Current frame's `seat` (and moose swim `water`) anchors of a mount sheet's `anim` (gait or ADR-322 action), 1x px from
   *  the pivot; undefined = no anchor (table seat height). Non-looping anims (death) hold their last frame. */
  private mountAnchors(mve: Entity, anim: string, q: number): { seat?: { x: number; y: number }; water?: { x: number; y: number } } | undefined {
    const v = this.view; const sp = v.get(mve, Sprite); const a = v.get(mve, VAnim); if (!sp) return undefined;
    try {
      const def = this.registry.sprite(sp.spriteId).animations.get(anim); if (!def) return undefined;
      const n = def.frames.length || 1; const hz = this.renderer.tickHz || 20; const raw = Math.floor(((v.tick - (a?.startTick ?? 0)) / hz) * (def.fps || 1));
      const i = def.loop === false ? Math.min(Math.max(0, raw), n - 1) : ((raw % n) + n) % n;
      const facing = (v.getField(mve, Transform, "facing") ?? 0) + q * (Math.PI / 2); const dirs = def.directions ?? 8;
      const an = this.registry.dirFrameAnchors(sp.spriteId, anim, i * dirs + AssetRegistryClass.directionIndex(facing, dirs)); const k = sp.scale || 1;
      const seat = an?.["seat"], water = an?.["water"];
      return { ...(seat ? { seat: { x: seat.x * k, y: seat.y * k } } : {}), ...(water ? { water: { x: water.x * k, y: water.y * k } } : {}) };
    } catch { return undefined; }
  }
  /** ADR-520: off-screen vehicles (VEH_VIEW_MARGIN iso px past the edges) don't touch their streamed page, so the
   *  LRU hands the slots to the vehicles on screen (was: every vehicle in the loaded world requested its page each frame). */
  private vehInView(): (x: number, y: number) => boolean {
    const r = this.renderer.camera.visibleRect(VEH_VIEW_MARGIN); const iso = this.renderer.iso;
    return (x, y) => { const p = worldToScreen(x, y, 0, iso); return p.sx >= r.x0 && p.sx <= r.x1 && p.sy >= r.y0 && p.sy <= r.y1; };
  }
  private syncVehicles(net: World, player: Entity | undefined, ground: (x: number, y: number, z: number) => number, frac: number | undefined): void {
    if (!net.isRegistered(GVehicle)) return;
    const list = this.vehicleSnaps; list.length = 0;
    for (const e of net.query([GVehicle, Transform])) {
      const d = vehicleDefOf(net, e); if (!d) continue;
      const t = net.get(e, Transform)!, vh = net.get(e, GVehicle)!; const key = netIdOf(net, e) ?? entityIndex(e) + 1;
      const seats = net.has(e, VehicleSeats) ? Array.from((net.get(e, VehicleSeats) as unknown as { occupant: ArrayLike<number> }).occupant) : undefined;
      const parent = net.has(e, Hitch) ? net.getField(e, Hitch, "parentNetId") ?? 0 : 0;
      const state = net.has(e, VehicleState) ? net.getField(e, VehicleState, "flags") ?? 0 : undefined;
      list.push({ key, def: d as unknown as VehicleRenderDef, x: t.x, y: t.y, z: ground(t.x, t.y, t.z), heading: vh.heading, drift: vh.drift, speed: vh.speed, paint: (vh as { paint?: number }).paint ?? 0,
        ...(seats ? { occupants: seats } : {}), ...(parent ? { parent } : {}), ...(state !== undefined ? { state } : {}) });
    }
    if (!list.length && !this.vehicleView) return;
    // ADR-519: only the WebGL2 AtlasManager streams vehicle pages; the Canvas2D fallback's atlas has no retainSprite (every
    // frame with a vehicle threw "retainSprite is not a function" there) and draws Art straight from the loaded images
    const pages = this.renderer.atlas as unknown as { retainSprite?: unknown } | undefined;
    this.vehicleView ??= new VehicleView(this.view, this.registry, { art: true, ...(typeof pages?.retainSprite === "function" ? { pages: pages as never } : {}) });
    const now = performance.now(), dt = this.vehAt ? Math.min(0.25, (now - this.vehAt) / 1000) : 0; this.vehAt = now;
    const f = frac ?? 0.5, darkness = Math.max(0, Math.min(1, Math.cos(f * 2 * Math.PI) * 1.6 + 0.2));
    // ADR-360: the placements are the riders' seats — the sim snaps a rider to the vehicle centre, so without
    // this a driver renders in the middle of the wagon instead of on its bench. Same path for motor and drawn.
    applyVehicleRiderPlacements(net, this.view, this.map, this.vehicleView.sync(list, dt, { darkness, lowEnd: this.renderer.capabilities.lowEnd, ...(player !== undefined ? { localVehicle: localPlayerVehicle(net, player) } : {}), riderShadows: false, view: this.renderer.iso.view ?? 0, inView: this.vehInView() }), this.riderWinOf);
  }
  private classify(net: World, e: Entity, defs: ReturnType<typeof gameplayDefs> | undefined, own: boolean): Spec | undefined {
    const h = (entityIndex(e) * 2654435761) >>> 0;
    if (net.isRegistered(GVehicle) && net.has(e, GVehicle)) return undefined; // ADR-170: drawn by VehicleView (syncVehicles)
    // characters: own player (Survival is owner-only) + other players and human bots (PlayerId / Appearance / Health+AnimState)
    if (net.has(e, Animal)) {
      const a = net.get(e, Animal)!;
      const k = animalDefs()[a.kind];
      // ADR-319: a tamed mount draws on its dedicated true-scale sheet (mount_<art>, scale 1); wild animals keep their own sheet
      const mk = net.isRegistered(Mount) && net.has(e, Mount) ? this.rs(mountSpriteKeyOf(net.getField(e, Mount, "species") ?? 0)) : undefined;
      const r = mk ?? this.rs(k?.spriteKey);
      if (r) {
        // ADR-485: live-art draw scale — only when the resolved art IS the species' own key (real art)
        // and it is not a mount sheet (mounts are already true-scale). A fallback resolution already
        // carries its own corrected scale from sprite_fallbacks.json, so it must not be multiplied again.
        const live = !mk && r.key === k?.spriteKey ? animalDrawScale(k?.key) : 1;
        // ADR-496: a rare old animal draws larger — the same sprite, scaled. Only real-art species
        // can be old (the sim never marks a fallback species), and mounts are never old either.
        const old = !mk && a.old === 1 ? (k?.oldScaleMul ?? 1) : 1;
        const sc = r.scale * live * old;
        return { sprite: r.id, animated: true, shadow: 0.8, ...(r.tint ? { tint: r.tint } : {}), ...(sc !== 1 ? { scale: sc, onCreate: sc } : {}) };
      }
      const ph = this.sid(`animal_${k?.key ?? ""}`) ?? this.sid("player"); // species key fallback; base sprite only if the pack lacks animal art
      return ph === undefined ? undefined : { sprite: ph, animated: true, shadow: 0.6, ...(this.sid(`animal_${k?.key ?? ""}`) === undefined ? { scale: 0.55, onCreate: 0.55 } : {}) };
    }
    if (net.has(e, Survival) || (!net.has(e, Zombie) && (net.has(e, PlayerId) || net.has(e, Appearance) || (net.has(e, Health) && net.has(e, GAnim))))) {
      const s = this.sid(own ? "player" : PLAYER_KEYS[h % PLAYER_KEYS.length]) ?? this.sid("player");
      return s === undefined ? undefined : { sprite: s, animated: true, shadow: 1, character: true };
    }
    if (net.has(e, Zombie)) {
      const z = net.get(e, Zombie)!; const key = defs?.zombies.get(z.kind)?.spriteKey;
      const s = this.sid(key) ?? this.sid("zombie_walker");
      return s === undefined ? undefined : { sprite: s, animated: true, shadow: 1, frame: z.variant };
    }
    if (net.has(e, LootBag)) { // ADR-166: death bags / zombie+animal loot / supply crates were never given a sprite (label only)
      const r = this.rs(LOOT_BAG_SPRITE); if (!r) return undefined;
      return { sprite: r.id, frame: 0, shadow: 0.6, noOcclude: true, flags: h & 1 ? SpriteFlag.FlipX : 0, ...(r.tint ? { tint: r.tint } : {}), ...(r.scale !== 1 ? { scale: r.scale, onCreate: r.scale } : {}) };
    }
    if (net.has(e, NodeRegrow)) { // ADR-134: depleted tree -> stump (<species>_tree_stump, else tree_stump) until stumpUntilTick; other kinds draw nothing
      const g = net.get(e, NodeRegrow)!; if (g.stumpUntilTick <= net.tick) return undefined;
      const sk = stumpKeys(defs?.resources.get(g.kind)?.spriteKey); const r = this.rs(sk[0]) ?? this.rs(sk[1]); if (!r) return undefined;
      return { sprite: r.id, flags: h & 1 ? SpriteFlag.FlipX : 0, scale: r.scale, shadow: 0.6, onCreate: r.scale, ...(r.tint ? { tint: r.tint } : {}) };
    }
    if (net.has(e, ResourceNode)) {
      const n = net.get(e, ResourceNode)!; const key = defs?.resources.get(n.kind)?.spriteKey;
      const r = this.rs(key); if (!r) return undefined; const s = r.id;
      const tall = key === "tree" || !!key?.startsWith("tree_") || !!key?.endsWith("_tree"); // ADR-110 species: <x>_tree
      const scale = (tall ? 1.1 + (h % 50) / 100 : 1) * r.scale;
      return { sprite: s, ...(r.tint ? { tint: r.tint } : {}), flags: (h & 1 ? SpriteFlag.FlipX : 0) | (tall || !!key?.endsWith("_bush") ? SpriteFlag.Sway : 0), scale, shadow: 0.9, occluder: !!tall, onCreate: scale };
    }
    if (net.has(e, Road)) { // ADR-119: flat road_<surface>_m<mask> autotile -> road_<surface> -> sprite_fallbacks chain
      const r0 = net.get(e, Road)!; const r = this.roadSprite(r0.surface, r0.mask); if (!r) return undefined;
      return { sprite: r.id, flags: ROAD_FLAGS, ...(r.tint ? { tint: r.tint } : {}), ...(r.scale !== 1 ? { scale: r.scale, onCreate: r.scale } : {}) };
    }
    if (net.has(e, Sign)) { // ADR-120: the sign post art at its facing (idle / idle_r1..r3); its text is a DOM world label (world-labels.ts)
      const s0 = net.get(e, Sign)!; const r = this.rs(signDef(s0.kind)?.key ?? "sign_wooden_post");
      return r ? { sprite: r.id, frame: this.signFrame(r.id, s0.rot), shadow: 0.6, ...(r.tint ? { tint: r.tint } : {}), ...(r.scale !== 1 ? { scale: r.scale, onCreate: r.scale } : {}) } : undefined;
    }
    if (net.has(e, Crop)) { // ADR-110: farm_soil / crop_<plant>_<stage> / sapling_<tree|bush>_<stage> (stage synced per frame)
      const c = net.get(e, Crop)!; const r = this.rs(cropSpriteKey(c.kind, c.stage)); if (!r) return undefined;
      return { sprite: r.id, scale: r.scale, onCreate: r.scale, ...(r.tint ? { tint: r.tint } : {}), flags: (h & 1 ? SpriteFlag.FlipX : 0) | (c.kind > 0 ? SpriteFlag.Sway : 0), shadow: c.kind > 0 ? 0.5 : 0 };
    }
    // Piece attachments (fire/fuel, light, door, storage) share the piece's position: no sprite of their own, but a
    // light Emitter (kind 2) or a fired attachment becomes a renderer light keyed by the owning piece.
    if (net.has(e, PieceLink)) {
      const key = this.pieceKeyAt(net, e, defs);
      const em = net.get(e, Emitter);
      const isLight = em?.kind === 2 || (net.has(e, Fuel) && !this.hasLightSibling(net, e));
      const base = isLight ? this.lights.get(key) ?? (key && POWERED_TIER_KEYS.has(key) ? this.lights.get("powered_tier") : undefined) ?? this.lights.get("campfire") : undefined; // ADR-593
      const spec = base ? LightTable.withRadius(base, em?.kind === 2 ? em.radius : undefined) : undefined; // ADR-216: draw the gameplay light radius
      return spec ? { light: spec, ...(em?.kind === 2 ? { fuelOf: this.fuelSibling(net, e) } : {}) } : undefined;
    }
    if (isFreeStandingStation(net.has(e, CraftingStation), net.has(e, GPiece))) { // free-standing station (spawnStation): bonfire sprite + light following Fuel.lit
      const camp = net.getField(e, CraftingStation, "kind") === StationKind.Campfire ? this.rs("campfire") : undefined; // ADR-227: campfire stations draw the campfire fallback (bonfire art scaled)
      const s = camp?.id ?? this.sid("bonfire") ?? this.sid("campfire_lit") ?? this.sid("fx_fire"); if (s === undefined) return undefined;
      const fired = net.has(e, Fuel); const bf = fired ? this.lights.get("bonfire") : undefined;
      const spec = bf ? LightTable.withRadius(bf, STATION_LIGHT_RADIUS[net.getField(e, CraftingStation, "kind") ?? 0]) : undefined; // ADR-216: = gameplay light grid
      return { sprite: s, frame: fired ? this.fireFrame(s, (net.getField(e, Fuel, "lit") ?? 0) !== 0) : 0, ...(camp && camp.scale !== 1 ? { scale: camp.scale } : {}), shadow: 0.6, fuel: fired, noOcclude: true, ...(spec ? { light: spec } : {}) };
    }
    if (net.has(e, GPiece) && defs) {
      const p = net.get(e, GPiece)!; const def = defs.pieces.get(p.type);
      let vis = buildPieceVisual(this.registry, { type: p.type, ...pieceArt(net, p.type, p.rot), tint: p.tint, paint: p.paint, damageStage: p.damageStage }, { tier: p.tier, pieceKey: (t) => this.pk(defs.pieces.get(t)?.key), ...pieceVariantOpts(def?.variantNames, p.variant) });
      const si = !vis.visualId && def?.roof ? this.roofStandIn(def.key, quarterTurn(p.rot), p.tier) : undefined; // ADR-400: rfx-only roof forms
      if (si) vis = buildPieceVisual(this.registry, { type: p.type, rot: si.row, tint: p.tint, paint: p.paint, damageStage: p.damageStage }, { pieceKey: () => si.pieceKey, variant: si.variant });
      if (!vis.visualId) return undefined;
      const lh = (defs as unknown as { building?: { levelHeight?: number } }).building?.levelHeight ?? 1;
      const z = net.get(e, Transform)!.z; const level = Math.max(0, Math.round(z / (lh || 1)));
      return { pieceVisual: vis.visualId, variant: p.variant, rot: vis.rotation | pieceRotFlags(def) | (LOW_PROP_PIECES.has(def?.key ?? "") ? ROT_NO_OCCLUDE : 0), tint: clanPieceTint(this.registry, vis), tintIndex: vis.tintIndex, damage: vis.damageStage, level, layer: vis.layer, pieceKey: def?.key, ...(def?.roof ? { roofRot: vis.rotation, roofTier: p.tier } : {}) };
    }
    // emissive sprites (e.g. glow mushrooms) carry a light when the table knows their key
    return undefined;
  }
}

/** gameplay Placement.Tri (4) and the vertex-snapped Free (3) corner walls (ADR-104): drawn at the exact Transform x/y
 *  (centroid / vertex), not the floored tile. Other Free pieces keep the tile-centre pivot. */
/** ADR-152: low ground props never auto-fade as occluders (their frame is far taller than the art). */
/** ADR-166: every LootBag entity (death bag, zombie/animal loot, supply crate) draws this pack sprite. */
export const LOOT_BAG_SPRITE = "death_bag";
export const LOW_PROP_PIECES: ReadonlySet<string> = new Set(["campfire"]);

/** rot/rotSteps for buildPieceVisual: triangles (12 steps of 30°) map exactly onto an art row (pieceArtRow), no quarter-turn snap. */
/** ADR-174: art rot of a placed piece (off-grid free pieces carry FINE_ROT; their 15° step maps to the nearest art row). */
const pieceArt = (net: World, type: number, rot: number): { rot: number; rotSteps: number } => { const def = gameplayDefs(net).pieces.get(type); if (!def) return artRot(rot, rotationSteps(net, type)); const r = rotParts(def, rot); return artRot(r.rot, r.steps); };
const artRot = (rot: number, steps: number): { rot: number; rotSteps: number } => (steps === 12 ? { rot: pieceArtRow(rot, 12), rotSteps: 4 } : { rot, rotSteps: steps });

interface Spec {
  sprite?: number; frame?: number; flags?: number; scale?: number; shadow?: number; occluder?: boolean; /** ADR-152: explicit Occluder{fade:1} so a short prop never auto-fades */ noOcclude?: boolean; animated?: boolean; character?: boolean; fuel?: boolean;
  light?: { r: number; g: number; b: number; radius: number; intensity: number; flicker: number };
  pieceVisual?: number; /** ADR-397: roof piece (quarter turn, tier) -> continuous-roof picks */ roofRot?: number; roofTier?: number; /** ADR-230: effective clan tint index (paint || tint) */ tintIndex?: number; variant?: number; rot?: number; onCreate?: number; tint?: number; damage?: number; level?: number; layer?: number; pieceKey?: string | undefined;
  /** light gated by this sibling's Fuel.lit (light attachment of a fired piece) */ fuelOf?: Entity | undefined;
}

/** Art's sfx_animal_<species> (2 variants, ogg); silently skipped if audio is unavailable or blocked before a user gesture. */

/** `<art>/manifests.index.json` (written by vite.config.ts with only the served fragments) or MANIFEST_INDEX (manifest-index.ts). */
async function loadMergedManifest(art: string): Promise<ReturnType<typeof loadManifest> & { deferredWearShards: ManifestShardRef[]; wearIO: WearShardIO }> {
  const get = async (u: string): Promise<unknown> => { try { const r = await assetFetch(u); return r.ok ? await r.json() : undefined; } catch { return undefined; } };
  let idx = (await get(art + "manifests.index.json")) as { fragments?: ManifestFragmentRef[]; gz?: boolean } | undefined;
  // ADR-406: the index is a single point of failure for the whole manifest load — if it 404s (a stale
  // 404 in the browser HTTP cache / CDN edge, the same stuck-cache class as the top shard), the loader
  // falls back to plain-JSON fragment loads and every gz-only fragment 404s. One retry against a
  // cache-busting URL (a fresh key at every layer) before falling back to MANIFEST_INDEX; if the index
  // genuinely does not exist the busted fetch 404s too and the fallback proceeds exactly as before.
  idx ??= (await get(cacheBustUrl(art + "manifests.index.json"))) as { fragments?: ManifestFragmentRef[]; gz?: boolean } | undefined;
  // ADR-394: a built dist ships the fragments, shards and ids.lock as `.json.gz` (the dev server serves plain JSON)
  // ADR-405: no `.catch(() => undefined)` here: assetJsonGz returns undefined ONLY for a genuinely missing file
  // (a 404 on every attempt); a fetch/gunzip/parse failure throws with its cause, so the boot error names the
  // real failure instead of every failure surfacing as "manifest shard missing". Optional fragments still skip
  // when missing; a real failure fails the boot (and the safe-retry reload) loudly rather than silently booting
  // without the fragment. Prefetch (prefetch-art.ts) keeps its best-effort catch.
  const getManifest = idx?.gz ? assetJsonGz : get;
  // ADR-406: shards of a v2 index (and required fragments) are REQUIRED — load them through a loader that
  // throws with the cause (URL, HTTP 404, attempts) instead of returning undefined, so a genuinely missing
  // shard reads as a 404 after a cache-busting retry, never as "manifest shard missing".
  const getManifestRequired = idx?.gz ? (u: string) => assetJsonGz(u, { required: true }) : undefined;
  const charArt = parseCharArt(new URLSearchParams(globalThis.location?.search ?? "").get("charArt"), (() => { try { return globalThis.localStorage?.getItem("charArt"); } catch { return null; } })());
  const list = withCharArtFragment(idx?.fragments?.length ? idx.fragments : MANIFEST_INDEX, charArt); // ADR-240: v2 sample only with charArt
  // ADR-248: shared with the dedicated server (@engine/assets loadMergedManifestWith); atlas paths become absolute per
  // fragment, so sourcesFromManifest (pack base) loads each PNG from its one source.
  // ADR-555: the boot manifest excludes the wear shards (deferWear) — loadMergedManifestWith returns them as
  // deferredWearShards for IsoView.ensureWearShards; ADR-549's parallel fragment fetch is unchanged.
  const { result, collisions, warnings, deferredWearShards } = await loadMergedManifestWith(list, { get: getManifest, getRequired: getManifestRequired, artUrl: new URL(art, location.href).href, excludeWearShards: true });
  if (collisions.length) console.info(`[view] manifest: ${collisions.length} duplicate keys kept from the first fragment (${collisions.slice(0, 5).map((c) => `${c.section}.${c.key}`).join(", ")}...)`);
  for (const w of warnings) if (!/ defined in /.test(w)) console.warn(`[view] manifest: ${w}`);
  return { ...result, deferredWearShards, wearIO: { get: getManifest, getRequired: getManifestRequired, artUrl: new URL(art, location.href).href, lock: result.lock } };
}

/** Daylight for the black-frame self-check; renderers without a `lighting` state (Canvas2D) count as night (check skipped). */
export function daylightOf(r: { lighting?: { daylight?: number } | undefined }): number { return r.lighting?.daylight ?? 0; }

/** ADR-228: ghost easing rate (1/s; ~40 ms to close 2/3 of the gap) and the jump (tiles) past which it snaps instead. */
export const GHOST_EASE_RATE = 25, GHOST_EASE_SNAP = 3;
