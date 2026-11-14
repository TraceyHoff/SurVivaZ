/**
 * ADR-398: one build-menu entry per roof form. Continuous roofs (ADR-397) pick slope / corner / hip / valley shapes from
 * the neighbours, so once Art's rfx_hip art ships, `roof_corner` and `roof_hip` leave the menu and `roof_slope` reads
 * "hip roof". The new forms (cottage, gambrel, shed) have no legacy art, so each stays hidden until its rfx pages ship.
 * Only the tile list changes: the grid, focus order and pad / keyboard / touch handling are the existing build window's.
 */
export const ROOF_FORM_OF: Readonly<Record<string, string>> = { roof_slope: "hip", roof_corner: "hip", roof_hip: "hip", roof_gable: "gab", roof_flat: "flt", roof_cottage: "cot", roof_gambrel: "gam", roof_shed: "shd" };
const NEW_FORM = new Set(["roof_cottage", "roof_gambrel", "roof_shed"]);
const AUTO_SHAPED = new Set(["roof_corner", "roof_hip"]);
const LABEL: Readonly<Record<string, string>> = { roof_slope: "hip roof", roof_gable: "gable roof", roof_flat: "flat roof", roof_cottage: "cottage roof", roof_gambrel: "gambrel roof", roof_shed: "shed roof" };

/** Forms with any `rfx_<form>_…` sprite in the registry (memoised per registry object). */
const cache = new WeakMap<object, ReadonlySet<string>>();
export function rfxFormsWithArt(reg: { allSprites(): Iterable<{ key: string }> } | undefined): ReadonlySet<string> {
  if (!reg) return new Set();
  let s = cache.get(reg);
  if (!s) { const out = new Set<string>(); for (const sp of reg.allSprites()) { const m = /^rfx_(hip|gab|flt|cot|gam|shd)_/.exec(sp.key); if (m) out.add(m[1]!); } cache.set(reg, (s = out)); }
  return s;
}

export function roofMenu<T extends { key: string }>(all: readonly T[], forms: ReadonlySet<string>): T[] {
  return all.filter((p) => !(NEW_FORM.has(p.key) && !forms.has(ROOF_FORM_OF[p.key]!)) && !(AUTO_SHAPED.has(p.key) && forms.has("hip")));
}

/** Tile label: the form name once that form draws continuously, else the piece key as before. */
export function roofMenuLabel(key: string, forms: ReadonlySet<string>): string {
  const f = ROOF_FORM_OF[key]; return f && forms.has(f) && LABEL[key] ? LABEL[key] : key.replace(/_/g, " ");
}
