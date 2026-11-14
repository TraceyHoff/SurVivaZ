import cfgJson from "./roofRfx.json";

/**
 * ADR-397: continuous roofs, exactly as Art & Assets' docs/ART_KEYS_ROOFS.md §4. Pure: the caller passes one level's
 * roof tiles, gets a pick per tile (form, band, lower mask, shape/row, rfx key stem, lift in px, overlays). Sprite
 * existence is the caller's job (`rfxSpriteKeys` lists the keys to try, most specific first).
 *
 * Directions (ADR-311): dir 0 = S (+y), 1 = W (-x), 2 = N (-y), 3 = E (+x).
 * Mask bits (autotile): N1 E2 S4 W8 NE16 SE32 SW64 NW128.
 */
export type RfxForm = "hip" | "gab" | "flt" | "cot" | "gam" | "shd";
export type RfxShape = "e" | "o" | "i" | "r" | "h" | "p" | "f";
export interface RfxFormCfg { rise: number[]; kmax: number; crest: boolean }
export interface RfxMaterialRule { /** matched against RfxTile.wallMaterial (exact) */ wall: string; skin: string; forms?: RfxForm[] }
export interface RfxConfig { seed: number; levelPx: number; forms: Record<RfxForm, RfxFormCfg>; groups: Record<string, string>; materials: { skinKey: string; rules: RfxMaterialRule[] } }
export const RFX: RfxConfig = cfgJson as unknown as RfxConfig;

export const DIR_V: ReadonlyArray<readonly [number, number]> = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // S W N E
const BIT_OF_DIR = [4, 8, 1, 2]; // S W N E -> mask bit
export const M_N = 1, M_E = 2, M_S = 4, M_W = 8, M_NE = 16, M_SE = 32, M_SW = 64, M_NW = 128;
const NB: ReadonlyArray<readonly [number, number, number]> = [[0, -1, M_N], [1, 0, M_E], [0, 1, M_S], [-1, 0, M_W], [1, -1, M_NE], [1, 1, M_SE], [-1, 1, M_SW], [-1, -1, M_NW]];

/** abandoned.ts hashU32 (copied: @engine/assets cannot depend on gameplay; a client test pins equality). */
export function rfxHashU32(seed: number, a: number, b = 0, c = 0): number {
  let h = (seed ^ Math.imul(a, 0x9e3779b9) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export interface RfxTile { x: number; y: number; /** gameplay piece key */ key: string; /** world quarter turn 0-3 */ rot: number; tier: number; /** ADR-397 material hook: the building's wall material (e.g. tier key or a wall variant) */ wallMaterial?: string }
export interface RfxOverlay { /** key stem without tier, e.g. rfx_gab_verge_er */ key: string; /** other stems for the same overlay, tried in order after `key` (Art's packed names, e.g. rfx_gab_lo_ver) */ alts: string[]; row: number; zoffPx: number; /** draw order after the tile (0, 1, ...) */ order: number }
export interface RfxPick {
  form: RfxForm; band: number; lower: number; shape: RfxShape; row: number; seg: "lo" | "up" | "top" | "lotop" | ""; crest: boolean; variant: 0 | 1 | 2;
  /** full stem without tier: rfx_<form>_<seg>_<shape>[c][_v<n>] (flt f: rfx_flt_f[_v<n>]) */ stem: string;
  /** other stems for the same tile, tried after `stem` (Art's packed names: rfx_flt_lo_f, gab/gam plateau up_f) */ alts: string[];
  /** lift above the piece z in px at 1x */ zoffPx: number; overlays: RfxOverlay[]; skin?: string; region: number;
}

export const rfxCell = (x: number, y: number): string => `${x},${y}`;
export function rfxGroupOf(key: string, cfg: RfxConfig = RFX): string | undefined { return cfg.groups[key]; }
export function rfxRise(form: RfxForm, band: number, cfg: RfxConfig = RFX): number { const r = cfg.forms[form].rise; return r[Math.min(band, r.length - 1)] ?? 0; }
export function rfxZoff(form: RfxForm, band: number, cfg: RfxConfig = RFX): number { let z = 0; for (let j = 0; j < band; j++) z += rfxRise(form, j, cfg); return z; }

/** Region form: legacy -> hip if any slope/corner/hip (or chimney-only), else gab if any gable, else flt; new groups are their own form. */
export function rfxRegionForm(group: string, keys: Iterable<string>): RfxForm {
  if (group === "cot" || group === "gam" || group === "shd") return group;
  let slope = false, gable = false, flat = false;
  for (const k of keys) { if (k === "roof_slope" || k === "roof_corner" || k === "roof_hip") slope = true; else if (k === "roof_gable") gable = true; else if (k === "roof_flat") flat = true; }
  return slope ? "hip" : gable ? "gab" : flat ? "flt" : "hip";
}

const majority = (rots: number[], f: (r: number) => number): number | undefined => {
  const c = new Map<number, number>(); for (const r of rots) { const k = f(r); c.set(k, (c.get(k) ?? 0) + 1); }
  let best: number | undefined, bn = -1, tie = false;
  for (const [k, n] of [...c].sort((a, b) => a[0] - b[0])) { if (n > bn) { best = k; bn = n; tie = false; } else if (n === bn) tie = true; }
  return tie ? undefined : best;
};

/** Shape + row from n = L & 15 and the diagonal bits (§4 table). */
export function rfxShapeOf(lower: number): { shape: RfxShape; row: number } {
  switch (lower & 15) {
    case 0: { const d = lower & 0xf0; if (!d) return { shape: "f", row: 0 }; return { shape: "i", row: d & M_SE ? 0 : d & M_SW ? 1 : d & M_NW ? 2 : 3 }; }
    case 4: return { shape: "e", row: 0 }; case 8: return { shape: "e", row: 1 }; case 1: return { shape: "e", row: 2 }; case 2: return { shape: "e", row: 3 };
    case 6: return { shape: "o", row: 0 }; case 12: return { shape: "o", row: 1 }; case 9: return { shape: "o", row: 2 }; case 3: return { shape: "o", row: 3 };
    case 5: return { shape: "r", row: 0 }; case 10: return { shape: "r", row: 1 };
    case 14: return { shape: "h", row: 0 }; case 13: return { shape: "h", row: 1 }; case 11: return { shape: "h", row: 2 }; case 7: return { shape: "h", row: 3 };
    default: return { shape: "p", row: 0 };
  }
}

/** Interior variant: k = hashU32(0x52F00396, tx, ty, level) & 3; 0-1 -> v0, 2 -> v1, 3 -> v2. */
export function rfxVariant(x: number, y: number, level: number, cfg: RfxConfig = RFX): 0 | 1 | 2 { const k = rfxHashU32(cfg.seed, x, y, level) & 3; return k === 3 ? 2 : k === 2 ? 1 : 0; }

/** Pick every tile of one level. Tiles of keys outside `groups` are ignored. */
export function rfxPickLevel(tiles: readonly RfxTile[], level: number, cfg: RfxConfig = RFX): Map<string, RfxPick> {
  const at = new Map<string, RfxTile>(); for (const t of tiles) if (cfg.groups[t.key] !== undefined) at.set(rfxCell(t.x, t.y), t);
  const out = new Map<string, RfxPick>(); const seen = new Set<string>(); let regionId = 0;
  for (const start of at.values()) {
    const sk = rfxCell(start.x, start.y); if (seen.has(sk)) continue;
    const group = cfg.groups[start.key]!; const region: RfxTile[] = []; const q = [start]; seen.add(sk);
    while (q.length) { // 8-connected, same group
      const t = q.pop()!; region.push(t);
      for (const [dx, dy] of NB) { const k = rfxCell(t.x + dx, t.y + dy); const n = at.get(k); if (n && !seen.has(k) && cfg.groups[n.key] === group) { seen.add(k); q.push(n); } }
    }
    pickRegion(region, group, level, regionId++, cfg, out);
  }
  return out;
}

function pickRegion(region: RfxTile[], group: string, level: number, regionId: number, cfg: RfxConfig, out: Map<string, RfxPick>): void {
  const mem = new Map<string, RfxTile>(); for (const t of region) mem.set(rfxCell(t.x, t.y), t);
  const isM = (x: number, y: number): boolean => mem.has(rfxCell(x, y));
  const form = rfxRegionForm(group, region.map((t) => t.key)); const fc = cfg.forms[form];
  const band = new Map<string, number>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const t of region) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x); y1 = Math.max(y1, t.y); }
  // ridge axis (gab/gam): 0 = E-W ridge (perpendicular dirs S/N), 1 = N-S ridge (W/E)
  let axis = 0, downD = 0;
  if (form === "gab" || form === "gam") axis = majority(region.map((t) => t.rot), (r) => r & 1) ?? (x1 - x0 >= y1 - y0 ? 0 : 1);
  if (form === "shd") downD = majority(region.map((t) => t.rot), (r) => r & 3) ?? 0;
  if (form === "hip" || form === "cot") { // Chebyshev distance to the nearest non-member, BFS over bbox + 1
    const dist = new Map<string, number>(); const q: [number, number][] = [];
    for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) if (!isM(x, y)) { dist.set(rfxCell(x, y), 0); q.push([x, y]); }
    for (let i = 0; i < q.length; i++) { const [x, y] = q[i]!; const d = dist.get(rfxCell(x, y))!;
      for (const [dx, dy] of NB) { const nx = x + dx, ny = y + dy; if (nx < x0 - 1 || nx > x1 + 1 || ny < y0 - 1 || ny > y1 + 1) continue; const k = rfxCell(nx, ny); if (!dist.has(k)) { dist.set(k, d + 1); q.push([nx, ny]); } } }
    for (const t of region) band.set(rfxCell(t.x, t.y), Math.max(0, Math.min(fc.kmax, dist.get(rfxCell(t.x, t.y))! - 1)));
  } else {
    const run = (t: RfxTile, d: number): number => { const [dx, dy] = DIR_V[d]!; let n = 0, x = t.x + dx, y = t.y + dy; while (isM(x, y)) { n++; x += dx; y += dy; } return n; };
    for (const t of region) {
      let b = 0;
      if (form === "gab" || form === "gam") b = Math.min(run(t, axis === 0 ? 0 : 1), run(t, axis === 0 ? 2 : 3));
      else if (form === "shd") b = run(t, downD);
      band.set(rfxCell(t.x, t.y), Math.max(0, Math.min(fc.kmax, b)));
    }
  }
  const bandAt = (x: number, y: number): number | undefined => band.get(rfxCell(x, y));
  // ADR-397 material hook: one wall material per region (majority of the tiles that report one; interior tiles have no wall)
  const wm = new Map<string, number>(); for (const t of region) if (t.wallMaterial !== undefined) wm.set(t.wallMaterial, (wm.get(t.wallMaterial) ?? 0) + 1);
  let wall: string | undefined, wn = 0; for (const [k, n] of [...wm].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (n > wn) { wall = k; wn = n; }
  const rule = wall !== undefined ? cfg.materials.rules.find((r) => r.wall === wall && (!r.forms || r.forms.includes(form))) : undefined;
  const perp = axis === 0 ? M_N | M_S : M_E | M_W;
  for (const t of region) {
    const b = band.get(rfxCell(t.x, t.y))!;
    let lower = 0;
    for (const [dx, dy, bit] of NB) { const nb = bandAt(t.x + dx, t.y + dy); if (nb === undefined || (form !== "flt" && nb < b)) lower |= bit; }
    if (form === "gab" || form === "gam") lower &= perp;
    let { shape, row } = rfxShapeOf(lower);
    let seg: RfxPick["seg"] = b === 0 ? "lo" : "up";
    const nbr = (d: number): [number, number] => [t.x + DIR_V[d]![0], t.y + DIR_V[d]![1]];
    const eqMember = (d: number): boolean => { const [x, y] = nbr(d); return bandAt(x, y) === b; };
    let top = false, plateau = false;
    if ((form === "gab" || form === "gam") && (lower & 15) === 0) { shape = "r"; row = axis; seg = "up"; plateau = true; }
    if (form === "flt") { seg = shape === "f" ? "" : "lo"; }
    if (form === "shd") { shape = "e"; row = downD; const [ux, uy] = nbr((downD + 2) % 4); top = !isM(ux, uy); seg = b === 0 ? (top ? "lotop" : "lo") : top ? "top" : "up"; }
    let crest = false;
    if (fc.crest && shape === "e") crest = eqMember((row + 2) % 4);
    else if (fc.crest && shape === "o") crest = eqMember((row + 1) % 4) || eqMember((row + 2) % 4);
    const varOk = !crest && ((shape === "e" && (seg === "lo" || seg === "up")) || shape === "f");
    const variant = varOk ? rfxVariant(t.x, t.y, level, cfg) : 0;
    const stem = `rfx_${form}_${seg ? seg + "_" : ""}${shape}${crest ? "c" : ""}${variant ? `_v${variant}` : ""}`;
    const zoffPx = rfxZoff(form, b, cfg);
    const overlays: RfxOverlay[] = []; let order = 0;
    const strips = (k: number, x: number): void => { for (let j = 0; j < k; j++) overlays.push({ key: form === "gam" ? (j === 0 ? "rfx_gam_wall_lo" : "rfx_gam_wall_up") : `rfx_${form}_wall`, alts: [], row: x, zoffPx: rfxZoff(form, j, cfg), order: order++ }); };
    // Art's packed verge names carry the band seg: rfx_<form>_<lo|up>_v{el,er,r,f} (doc §4: rfx_<form>_verge_{el,er,r})
    const vseg = seg === "lo" || seg === "lotop" ? "lo" : "up";
    const verge = (x: number, d: number, onR: boolean): void => {
      if (onR) overlays.push({ key: `rfx_${form}_verge_r`, alts: [`rfx_${form}_${vseg}_vr`, ...(plateau ? [`rfx_${form}_up_vf`] : [])], row: x, zoffPx, order: order++ });
      else if (x === (d + 1) % 4) overlays.push({ key: `rfx_${form}_verge_er`, alts: [`rfx_${form}_${vseg}_ver`], row: d, zoffPx, order: order++ });
      else if (x === (d + 3) % 4) overlays.push({ key: `rfx_${form}_verge_el`, alts: [`rfx_${form}_${vseg}_vel`], row: d, zoffPx, order: order++ });
    };
    if (form === "gab" || form === "gam") {
      for (const x of axis === 0 ? [1, 3] : [0, 2]) { const [nx, ny] = nbr(x); if (isM(nx, ny)) continue; verge(x, row, shape === "r"); strips(b, x); }
    } else if (form === "shd") {
      for (const x of [(downD + 1) % 4, (downD + 3) % 4]) { const [nx, ny] = nbr(x); if (isM(nx, ny)) continue; verge(x, downD, false); strips(b, x); }
      if (top) strips(b + 1, (downD + 2) % 4);
    }
    if (t.key === "roof_chimney") overlays.push({ key: "rfx_chimney", alts: [], row: 0, zoffPx: zoffPx + rfxRise(form, b, cfg) / 2, order: order++ });
    const vs = variant ? `_v${variant}` : "";
    const alts = form === "flt" && shape === "f" ? [`rfx_flt_lo_f${vs}`] : plateau ? // gab/gam plateau (n = 0 past the clamp): Art also packed up_f, tried after the doc's up_r
       [`rfx_${form}_up_f${rfxVariant(t.x, t.y, level, cfg) ? `_v${rfxVariant(t.x, t.y, level, cfg)}` : ""}`] : [];
    out.set(rfxCell(t.x, t.y), { form, band: b, lower, shape, row, seg, crest, variant, stem, alts, zoffPx, overlays, region: regionId, ...(rule ? { skin: rule.skin } : {}) });
  }
}

/** Keys to try for a stem at a tier, most specific first: skin, variant, crest dropped in that order (all Art's keys). */
export function rfxSpriteKeys(stem: string, tier: number, skin?: string, cfg: RfxConfig = RFX): string[] {
  const t = `_t${tier}`; const out: string[] = [];
  const bases = [stem]; const noV = stem.replace(/_v\d$/, ""); if (noV !== stem) bases.push(noV);
  const noC = noV.replace(/^(rfx_\w+_(?:lo|up)_[eo])c$/, "$1"); if (noC !== noV) bases.push(noC);
  for (const b of bases) { if (skin) out.push(cfg.materials.skinKey.replace("{base}", b).replace("{skin}", skin).replace("{tier}", t)); out.push(b + t); }
  return out;
}
