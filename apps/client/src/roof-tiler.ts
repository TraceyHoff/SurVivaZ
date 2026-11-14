import { rfxCell, rfxPickLevel, rfxSeat, rfxSpriteKeys, RFX, type RfxConfig, type RfxPick, type RfxTile } from "@engine/assets";
import type { RoofFxBinding } from "@engine/render";
import { BuildPiece, StructureIndex, StructureIndexRes, gameplayDefs } from "@engine/gameplay";
import type { World } from "@engine/core";

/**
 * ADR-397: continuous roofs (Art & Assets docs/ART_KEYS_ROOFS.md §4). Tracks placed roof tiles per level; a place /
 * remove bumps that level's version, and the next flush re-picks the whole level once (regions, bands, shapes) and
 * caches the result until the next change, so a steady frame does no roof work. Each tile's pick resolves to the first
 * existing `rfx_*` building sprite (`rfxSpriteKeys`: skin, variant, crest dropped in that order); a tile with no rfx art
 * has no binding and draws its legacy sprite exactly as before.
 */
export interface RoofCell { ve: number; x: number; y: number; level: number; key: string; rot: number; tier: number; wallMaterial?: string }
export interface RoofLookup { /** id of a building sprite whose piece starts with `roof` (renderer isRoof), else undefined */ roofSpriteId(key: string): number | undefined }

export class RoofTiler {
  private levels = new Map<number, Map<string, RoofCell>>();
  private byVe = new Map<number, RoofCell>();
  private dirty = new Set<number>();
  private fx = new Map<number, RoofFxBinding>();
  private picks = new Map<number, RfxPick>();
  /** per-level cache version (bumped on every place / remove on that level) */
  readonly version = new Map<number, number>();
  private ids = new Map<string, number | null>();
  constructor(private readonly look: RoofLookup, private readonly cfg: RfxConfig = RFX) {}

  get size(): number { return this.byVe.size; }
  add(c: RoofCell): void {
    if (this.cfg.groups[c.key] === undefined) return;
    this.remove(c.ve);
    let lv = this.levels.get(c.level); if (!lv) this.levels.set(c.level, (lv = new Map()));
    const k = rfxCell(c.x, c.y); const old = lv.get(k); if (old) this.byVe.delete(old.ve);
    lv.set(k, c); this.byVe.set(c.ve, c); this.touch(c.level);
  }
  remove(ve: number): void {
    const c = this.byVe.get(ve); if (!c) return;
    this.byVe.delete(ve); this.fx.delete(ve); this.picks.delete(ve);
    const lv = this.levels.get(c.level); const k = rfxCell(c.x, c.y);
    if (lv?.get(k)?.ve === ve) { lv.delete(k); if (!lv.size) this.levels.delete(c.level); }
    this.touch(c.level);
  }
  private touch(level: number): void { this.dirty.add(level); this.version.set(level, (this.version.get(level) ?? 0) + 1); }

  /** Render binding (SpriteBindings.pieceRoofFx). */
  binding(ve: number): RoofFxBinding | undefined { return this.fx.get(ve); }
  pick(ve: number): RfxPick | undefined { return this.picks.get(ve); }

  private sid(key: string): number | undefined {
    let v = this.ids.get(key); if (v === undefined) { v = this.look.roofSpriteId(key) ?? null; this.ids.set(key, v); }
    return v ?? undefined;
  }
  /** First existing sprite for a pick at a tier (undefined = legacy). */
  resolve(p: RfxPick, tier: number): RoofFxBinding | undefined {
    let vis: number | undefined;
    for (const k of rfxSpriteKeys(p.stem, tier, p.skin, this.cfg)) { vis = this.sid(k); if (vis !== undefined) break; }
    if (vis === undefined) return undefined;
    const seat = rfxSeat(p.form, this.cfg); // ADR-404: the roof rests on the wall tops
    const overlays: { vis: number; row: number; liftPx: number }[] = [];
    for (const o of p.overlays) {
      let ov: number | undefined;
      for (const k of rfxSpriteKeys(o.key, tier, p.skin, this.cfg)) { ov = this.sid(k); if (ov !== undefined) break; }
      if (ov !== undefined) overlays.push({ vis: ov, row: o.row, liftPx: o.zoffPx + seat });
    }
    return { vis, row: p.row, liftPx: p.zoffPx + seat, overlays };
  }

  private wallCursor: Iterator<RoofCell> | undefined;
  /**
   * ADR-402: re-read the wall material under up to `budget` roof tiles (round robin), re-picking a level whose material
   * changed (a wall placed, upgraded or demolished after the roof arrived). Bounded per
   * frame: `budget` tiles x 4 edge lookups.
   */
  refreshWalls(read: (x: number, y: number, wallLevel: number) => string | undefined, budget = 64): number {
    let n = 0, changed = 0;
    while (n < budget && this.byVe.size) {
      let it = this.wallCursor?.next();
      if (!it || it.done) { this.wallCursor = this.byVe.values(); it = this.wallCursor.next(); if (it.done) break; }
      const c = it.value; n++;
      const wm = read(c.x, c.y, c.level - 1);
      if (wm !== c.wallMaterial) { if (wm === undefined) delete c.wallMaterial; else c.wallMaterial = wm; this.touch(c.level); changed++; }
    }
    return changed;
  }

  /** Re-pick dirty levels. Returns the view entities whose binding changed (their static chunk re-signs on its own). */
  flush(): number[] {
    if (!this.dirty.size) return [];
    const changed: number[] = [];
    for (const level of this.dirty) {
      const lv = this.levels.get(level); if (!lv) continue;
      const picks = rfxPickLevel([...lv.values()], level, this.cfg);
      for (const c of lv.values()) {
        const p = picks.get(rfxCell(c.x, c.y)); if (!p) continue;
        this.picks.set(c.ve, p);
        const b = this.resolve(p, c.tier); const was = this.fx.get(c.ve);
        if (!sameFx(b, was)) { if (b) this.fx.set(c.ve, b); else this.fx.delete(c.ve); changed.push(c.ve); }
      }
    }
    this.dirty.clear();
    return changed;
  }

  /** ADR-397 placement preview: the same selection with the ghost tile as a member of its level. */
  preview(t: RfxTile, level: number): { pick: RfxPick; fx: RoofFxBinding | undefined } | undefined {
    if (this.cfg.groups[t.key] === undefined) return undefined;
    const lv = this.levels.get(level); const tiles: RfxTile[] = lv ? [...lv.values()].filter((c) => c.x !== t.x || c.y !== t.y) : [];
    tiles.push(t);
    const pick = rfxPickLevel(tiles, level, this.cfg).get(rfxCell(t.x, t.y)); if (!pick) return undefined;
    return { pick, fx: this.resolve(pick, t.tier) };
  }
}

function sameFx(a: RoofFxBinding | undefined, b: RoofFxBinding | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.vis !== b.vis || a.row !== b.row || a.liftPx !== b.liftPx || a.overlays.length !== b.overlays.length) return false;
  return a.overlays.every((o, i) => o.vis === b.overlays[i]!.vis && o.row === b.overlays[i]!.row && o.liftPx === b.overlays[i]!.liftPx);
}


/**
 * ADR-397 material hook: the wall material under a roof tile, `<tier key>` or `<tier key>:<wall variant name>` (e.g.
 * "wood", "twig:clan_palisade"), read from any wall on the tile's four edges one level down. RfxConfig.materials.rules map it to
 * a skin (Art's split-log shakes for log-wall cabins); a region uses its tiles' majority. undefined = no wall found.
 */
export function roofWallMaterial(net: World, x: number, y: number, wallLevel: number): string | undefined {
  if (wallLevel < 0) return undefined;
  let idx: StructureIndex | undefined; try { idx = net.getResource(StructureIndexRes) as StructureIndex | undefined; } catch { return undefined; }
  if (!idx) return undefined;
  const defs = gameplayDefs(net);
  for (const [tx, ty, side] of StructureIndex.tileEdges(x, y)) {
    const e = idx.edge(tx, ty, wallLevel, side); if (!e) continue;
    const bp = net.get(e, BuildPiece); if (!bp) continue;
    const def = defs.pieces.get(bp.type); if (!def || def.family !== "wall") continue;
    const tierKey = defs.tiers[bp.tier]?.key ?? String(bp.tier);
    const vn = bp.variant ? def.variantNames[bp.variant] : undefined; // variant 0 = the plain look: the bare tier
    return vn ? `${tierKey}:${vn}` : tierKey;
  }
  return undefined;
}

/**
 * ADR-400: the piece art for a roof piece with no legacy sprite (the ADR-398 forms cottage / gambrel / shed). It is the
 * rfx sprite the ADR-397 selection picks for that piece standing alone, at its tier (Art's own art for that form, not
 * borrowed), so that piece still gets a view entity, a ghost and a Canvas2D / streaming-time picture. Once placed next to
 * others, the continuous-roof binding takes over as for every rfx roof. `art(spriteKey)` returns the sprite's
 * `building.piece` (`<base>@<variant>`) or undefined. undefined when the key has a legacy sprite or is not an rfx-only form.
 */
export function rfxStandIn(key: string, rot: number, tier: number, art: (spriteKey: string) => string | undefined, cfg: RfxConfig = RFX): { pieceKey: string; variant: string; row: number } | undefined {
  const g = cfg.groups[key]; if (g === undefined || g === "legacy") return undefined;
  const p = rfxPickLevel([{ x: 0, y: 0, key, rot: rot & 3, tier }], 0, cfg).get(rfxCell(0, 0)); if (!p) return undefined;
  for (let t = tier; t <= 4; t++) for (const k of rfxSpriteKeys(p.stem, t, undefined, cfg)) { // below the form's lowest tier: its nearest tier's art
    const piece = art(k); const at = piece?.indexOf("@") ?? -1;
    if (piece && at > 0) return { pieceKey: piece.slice(0, at), variant: piece.slice(at + 1), row: p.row };
  }
  return undefined;
}
