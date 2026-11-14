# Roof art keys — seamless region roofs (`rfx_*`), Art → Engine

Status: **painted and packed (base set)**. EA confirmed the defaults: one build-menu entry per form, engine auto-picks
pieces, winter is a whole-roof engine snow pass (no `_winter` art), flattening at band 3. All existing roof keys
(`bld_roof_*`) stay as fallbacks. §4 is mirrored by the reference implementation
`packages/assets/pack/building/src/roofs_select.py` (used for the previews; not shipped).

## 1. Audit: what exists today

**Gameplay pieces** (`packages/gameplay/data/pieces.json`, family `roof`, placement `cell`, layer 0, `minLevel 1`):

| piece | minTier | ADR-311 use |
|---|---|---|
| `roof_flat` | 0 (twig ok) | Flat style everywhere; Eaves centre |
| `roof_slope` | 0 (twig ok) | Eaves edges (eave dir rot 0..3 = S, W, N, E) |
| `roof_corner` | 1 | Eaves corners (eaves = rot and rot+3) |
| `roof_gable` | 1 | Gable/HipGable: **every tile is its own ridge** (rot 0/2 E–W, 1/3 N–S) |
| `roof_hip` | 1 | HipGable row-end caps (eave end = rot+3) |
| `roof_chimney` | 1 | swapped in over a hearth (65%), `smoke` attach |

`roof_ridge`, `roof_valley`, `roof_peak` are art-only (no gameplay piece). Styles (`abandoned.ts` `RoofStyle`):
Flat, Eaves, Gable, HipGable, picked per site by `roofWeights(kind)`. ADR-373 mentions "Mill / Stable … barn
roofs", but no barn roof exists; they use the Barn weights.

**Art** (`packages/assets/pack/building/manifest.building.json`, generator `assets/tools/buildings2.py roof_piece`):
- `bld_roof_{flat,slope,gable,hip,corner,chimney,ridge}_t1..t4` on `building_t1..t4` (84×96 grid cells, pivot (42,72),
  anchor (0.5,0.75), `residency: stream`, 1x only). Bare `bld_roof_gable` / `bld_roof_chimney` sit on the t1 page.
  `bld_roof_ridge_tN` reuses the gable frames.
- 88 roof cells per tier page (16 per piece: 4 rotations × **4 baked damage stages**), 352 total, about 23% of each
  page. That is about 1.7 MB PNG + 0.45 MB KTX2 across t1..t4 in the repo (pre-oxipng).
- Tier 0 (twig): there is no `bld_roof_*` art on `building_tw`. Bare `roof_flat` / `roof_slope` resolve
  (first-declared wins) to the **legacy main-pack** `roof_*_twig` sprites (`buildings_twig`). The legacy main pack also
  carries `roof_*{,_stone,_metal,_twig}` plus `_winter` twins.
- Materials per tier (`TIERS`): twig thatch, wood shingle, stone slate shingle, metal teal corrugated,
  reinforced slate corrugated.
- `bld_roof_*` keys do not match the `/^roof/` season rule, so they get no snowcap. Legacy `roof_*` keys do.

**Why the seams show** (reproduced by compositing the real t1 frames: `/workspace/roofaudit/mock_*.png`):
1. **Gable = a row of mini-ridges.** Each `roof_gable` tile peaks on its own centre line (`roof_d ridge = 0.5-|y|`),
   so an N-wide gable roof is N parallel ridges. This is the repeated-stripe sawtooth in Tracey's screenshot.
2. **Per-tile silhouette ink plus fascia.** Every tile is raymarched as a closed 3 px-thick slab. Its +x/+y side faces
   are painted in trim colour and inked, so each internal seam gets a dark line and a light fascia strip.
3. **Height mismatch.** Slopes and corners rise to about 27 px, `roof_flat` sits at 4–7 px with its own raised rim.
   An Eaves roof reads as a sunken tray with a grid of rimmed squares in the middle.
4. **Identical repeats.** Every tile uses the same noise seed (3), and courses use tile-local coordinates, so shingle
   stagger and course lines restart at every tile edge.
5. Hip/corner creases are drawn per tile with no notion of the whole roof, so ridges never line up.

## 2. Design overview

- The roof is **one continuous surface per connected roof region**. The engine picks each tile's piece from its
  neighbours (shape) and from its distance to the eave (height band), and draws it raised by that band's height.
  Every piece is cut from one global heightfield (1x world-space ray cast of the extended surface), so edges match by
  construction. Course lines are world-aligned and continue across tiles; there is no ink on internal seams, and the
  eave lip/fascia and outline appear only on the real perimeter (fascia only on visible S/E sides).
- **Roof type = form** (shape family, as in ADR-311). **Tier = material.** Every form × tier is its own painted art:
  no tint, recolour or reuse.

| form | look | t0 | t1 | t2 | t3 | t4 |
|---|---|---|---|---|---|---|
| `hip` | hipped, pitched on all sides | thatch | wood shingle | slate | teal tin | iron plate |
| `gab` | one ridge, triangular gable ends + gable walls | — | shingle | slate | tin | plate, brick trim |
| `flt` | flat deck, parapet lip on the perimeter only | reed | deck boards | flagstone | diamond plate | plate |
| `cot` | storybook cottage, flared eaves | — | clay scallop | slate scallop | patina standing seam | iron scallop |
| `gam` | gambrel barn, steep lower / shallow upper | — | brick-red boards | slate diamond | clay tin | slate plate |
| `shd` | shed / lean-to, single pitch | bark | dark boards | cobble flags | iron tin | teal plate |

- Damage: one baked stage per frame (`frames` rows `[f,f,f,f]`) + the existing `crackOverlay: bld_crack`.
- Winter: **no `_winter` art.** The `rfx_` prefix is deliberately outside the per-sprite `/^roof/` snowcap rule
  (it would re-stripe the roof); EA does a whole-roof snow pass.

## 3. Key list

Sprite key: **`rfx_<form>_<seg>_<shape>[c][_v<n>]_t<N>`**, N = 0 (twig) … 4. Lookup is by sprite key
(`registry.spriteId`). Each sprite keeps a `building` block (piece `"<gameplayKey>@<spriteKey>"` with gameplayKey
`roof_slope` for hip/cot/shd, `roof_gable` for gab/gam, `roof_flat` for flt, `roof_chimney` for the stack; footprint
1×1, layer 0, `rotationArt: "unique4"`, `crackOverlay: "bld_crack"`). The `@rfx…` piece strings never collide with
the legacy `@tierN` ones, so first-declared-wins `spriteForPiece` is unaffected.

- `seg`: `lo` = band 0 (eave course: lip, fascia, outline), `up` = band ≥ 1. `shd` adds `top` / `lotop` (high side).
- `shape` (each `building.frames` row is one orientation; see §4):

| shape | meaning | rows |
|---|---|---|
| `e` | edge / slope (1 side downhill) | 4 |
| `o` | outer / hip corner (2 adjacent sides downhill) | 4 |
| `i` | inner corner / valley (1 diagonal downhill) | 4 |
| `r` | ridge / 1-wide strip (2 opposite sides downhill) | `[r0,r1,r0,r1]` |
| `h` | hip end / strip end (3 sides downhill) | 4 |
| `p` | peak / single tile | 1 (`[p,p,p,p]`) |
| `f` | plateau (nothing downhill, or band == KMAX) | 1 |

- `c` = crest, on `e` only: the uphill neighbour is a member with the **same** band (even-width roofs), so the
  ridge cap is painted on the uphill edge.
- `_v1`, `_v2` = interior variants (moss, patch, knot, vent). Edge pixels identical to v0. Only on `lo_e`, `up_e`,
  `up_f` (and `flt` `f`), never on crest pieces.
- Overlay keys: verges `rfx_<form>_<seg>_{vel,ver,vr,vf}_t<N>` (seg = lo/up of the tile under them), gable walls
  `rfx_gab_wall_t<N>`, `rfx_gam_wall_lo_t<N>` / `rfx_gam_wall_up_t<N>`, shed side/high walls `rfx_shd_wall_t<N>`,
  stack `rfx_chimney_t1..t4` (`smoke` attach).

**Per form, per tier (as shipped):**

| form | sprites | frames |
|---|---|---|
| `hip`, `cot` | `lo_{e,o,i,r,h,p}` · `up_{e,o,i,r,h,p,f}` · `lo_ec up_ec` · `lo_e_v1/v2 up_e_v1/v2 up_f_v1/v2` (21) | 65 |
| `gab` | `lo_{e,r}` · `up_{e,r,f}` · `lo_ec up_ec` · `lo_e_v1/v2 up_e_v1/v2 up_f_v1/v2` · `lo_{vel,ver,vr}` · `up_{vel,ver,vr,vf}` · `wall` (21) | 63 |
| `gam` | as `gab` with `wall_lo` + `wall_up` (22) | 66 |
| `shd` | `{lo,up,top,lotop}_e` · `lo_e_v1/v2 up_e_v1/v2` · `{lo,up}_{vel,ver}` · `wall` (13) | 47 |
| `flt` | `lo_{e,o,i,r,h,p}` (parapet) · `f f_v1 f_v2` (field, no seg) (9) | 22 |
| stack | `rfx_chimney_t1..t4` | 1 |

Tiers: `hip`, `flt`, `shd` t0–t4; `gab`, `cot`, `gam` t1–t4 (no twig gable). **475 sprites, 1,526 frames** (eaves pass: back-end verges are no longer blank).

Examples: `rfx_hip_lo_e_t1`, `rfx_hip_up_ec_t2`, `rfx_hip_up_e_v2_t1`, `rfx_gab_lo_ver_t3`, `rfx_gab_up_vf_t2`,
`rfx_gam_wall_up_t1`, `rfx_shd_lotop_e_t0`, `rfx_flt_f_v1_t4`, `rfx_chimney_t1`.

**Build-menu icons** (one unique icon per form per tier, own page `items_build_rfx`, 32 px + `@2x` 64 px, stream; 27):
- `cot` / `gam` / `shd`: `build_roof_cottage_t1..4`, `build_roof_gambrel_t1..4`, `build_roof_shed_t0..4` — the
  ADR-398 pieces' own `build_<pieceKey>_t<N>` keys, so the build window finds them with no code change.
- `hip` / `gab` / `flt`: `build_rfx_hip_t0..4`, `build_rfx_gab_t1..4`, `build_rfx_flt_t0..4` (the menu pieces
  `roof_slope` / `roof_gable` / `roof_flat` already own legacy `build_roof_*_t<N>` icons on `items_build`; EA may
  prefer `build_rfx_<form>_t<N>` once that form draws continuously).

CSS classes are regenerated by `vehicle_items/src/gen_icon_css.py`. `items_build` itself is untouched.

## 4. Selection scheme (engine)

Dirs (ADR-311): **0 = S (+y), 1 = W (−x), 2 = N (−y), 3 = E (+x)**. Mask bits: **N=1, E=2, S=4, W=8, NE=16, SE=32,
SW=64, NW=128**. Orientation is world-relative; apply view rotation like existing pieces (`quarterTurn`).

**Region and form.** Members = roof-family pieces on the same level, 8-connected. Legacy keys (`roof_flat`,
`roof_slope`, `roof_corner`, `roof_hip`, `roof_gable`, `roof_chimney`) are one group: form `hip` if any
slope/corner/hip, else `gab` if any gable, else `flt` (chimney-only → `hip`). New gameplay keys `roof_cottage`,
`roof_gambrel`, `roof_shed` (still to be added by EA) each form their own group. Missing / disrepaired tiles are
non-members (holes get eave lips). Shape comes from the region; art tier from each tile's own tier.

**Band** (kmax per form in `packages/assets/src/roofRfx.json`: hip/cot 3, gab/gam 5, shd 64 = unclamped, flt 0):
- `hip`, `cot`: Chebyshev distance to the nearest non-member − 1, capped at kmax.
- `gab`, `gam`: one ridge axis per region (majority rot; else the long axis). band = min(runA, runB) capped at kmax,
  runA/runB = consecutive members perpendicular to the ridge.
- `shd`: downhill dir D (majority rot). band = members downhill of the tile (**uncapped**). `top` = uphill neighbour
  is a non-member.
- `flt`: 0.

**Draw height** `zoff(band) = Σ rise[0..band−1]` px at 1x (1 level = 48 px), added to the piece's normal z:

| form | rise per band (px) |
|---|---|
| `hip`, `gab` | 14 per band |
| `cot` | 10 (flared), then 16 |
| `gam` | 22, then 8 |
| `shd` | 9 per band |
| `flt` | 0 |

**Lower mask** L: bit set if that neighbour is a non-member or has a lower band. `gab`/`gam`: only the two
perpendicular-to-ridge cardinal bits (no diagonals). `shd`: unused. `flt`: non-membership only (cardinals + diagonals).
**Crown:** on `hip`/`cot`/`gab`/`gam`, a tile at band == kmax is always `up_f` (flat crown at zoff(kmax)); a
sloped piece there would climb above the plateau and leave a pit.

**Shape from n = L & 15:**

| n | key | row |
|---|---|---|
| 4 / 8 / 1 / 2 | `e` | 0 / 1 / 2 / 3 |
| 6 / 12 / 9 / 3 | `o` | 0 / 1 / 2 / 3 |
| 5 / 10 | `r` | 0 (ridge E–W) / 1 (ridge N–S) |
| 14 / 13 / 11 / 7 | `h` | 0 / 1 / 2 / 3 |
| 15 | `p` | 0 |
| 0 | `i` if a diagonal bit is set (first of SE→0, SW→1, NW→2, NE→3), else `f` | |

`seg = lo` if band 0 else `up`. Exceptions: `gab`/`gam` with n = 0 below kmax → `up_r` (row by axis); `flt` parapet pieces
are `lo`, the field has no seg (`rfx_flt_f[_v<n>]`); `shd` is always `e` row D with seg `lotop`/`lo` (band 0) or `top`/`up`.

**Crest** (`e` only, not `shd`): neighbour at (row+2)%4 is a member with equal band → append `c`.

**Variant** (only `e`/`f`, not crest, seg lo/up): `h = hashU32(0x52F00396, tx, ty, level) & 3` (the `abandoned.ts`
hash): 0–1 → v0, 2 → `_v1`, 3 → `_v2`.

**Overlays** (extra instances on the same tile, depth-biased just after it):
- `gab`/`gam` verge at ridge-axis end side x when that neighbour is a non-member: `e` tile row d → `ver` if
  x == (d+1)%4, `vel` if x == (d+3)%4, drawn with row d; `r` tile → `vr` row x; crown `f` tile → `up_vf` row x. Under a band-k
  end tile, stack k gable-wall strips facing x, strip j at zoff(j) (`gam`: `wall_lo` for j = 0, `wall_up` above).
- `shd`: side non-member at (D+1)%4 → `ver`, (D+3)%4 → `vel` (row D) + k wall strips facing it; `top`/`lotop`
  tiles get k+1 wall strips facing (D+2)%4. All use `rfx_shd_wall_t<N>`.
- `roof_chimney` (t ≥ 1): normal member, plus `rfx_chimney_tN` drawn at zoff(band) + rise[band]/2.

**Fallback.** Missing key or non-resident page → draw the legacy sprite exactly as today. Ghost previews run the same
selection.

## 5. Pages, residency, bytes (measured)

Cells **96×80**, pivot **(48,44)**, anchor **(0.5, 0.55)** (= 44/80) since the eaves pass (§9; was 72×68, (36,44), anchor
44/68 — the pivot is the same world point, only the frame grew to fit the overhang). 1x only, solid cel, binary alpha,
indexed PNG, oxipng'd, KTX2 twin via `assets/tools/ktx2.py`. Page `_a` = hip, gab, flt (+ stack), `_b` = cot, gam, shd;
**21 columns** (2016 px), cells deduped by hash. All `residency: "stream"`.

| page | size | sprites | PNG | KTX2 |
|---|---|---|---|---|
| `rfx_t0_a` / `_b` | 2016×400 / 240 | 30 / 13 | 16,684 / 8,838 | 86,925 / 46,403 |
| `rfx_t1_a` / `_b` | 2016×640 / 720 | 52 / 56 | 22,829 / 28,484 | 134,041 / 157,479 |
| `rfx_t2_a` / `_b` | 2016×640 / 720 | 52 / 56 | 24,268 / 31,923 | 136,686 / 157,516 |
| `rfx_t3_a` / `_b` | 2016×640 / 720 | 52 / 56 | 21,612 / 32,295 | 136,363 / 171,161 |
| `rfx_t4_a` / `_b` | 2016×640 / 720 | 52 / 56 | 22,514 / 28,866 | 131,684 / 158,435 |
| **10 roof pages** | | 475 | **238,313** | **1,316,693** |
| `items_build_rfx` + `@2x` | 256×128 / 512×256 | 27 | 25,191 | 46,462 |

- Base-set ship delta (before the eaves pass): **≈ 1.62 MB raw**: 1,271,831 B atlases (PNG + KTX2) + manifest.building +327 KB raw (+13.9 KB gz) +
  manifest.items +6.6 KB + gameplay-panels.css +2.5 KB (ids.lock +15 KB, repo only). Well under the 2.8 MB estimate.
- GPU: ≈ 0.9 MB per resident roof page (ETC2/ASTC with mips). A typical cabin needs one page.
- **EA note:** the `bld` stream pool (`isStreamedBuildingAtlas`) only matches `/^building_t\d+$/`; extend it to
  `/^rfx_/` so these pages stream/evict with buildings.

## 6. Tooling

`packages/assets/pack/building/src/add_roofs.py` (add-only; replaces only its own `rfx_*` atlases/sprites and the
`items_build_rfx` page; never runs `build.py`): `python3 add_roofs.py [--material <m>] [--no-icons]`, then oxipng,
`ktx2.py` on a temp manifest of only the new atlases, `gen_icon_css.py`, `pnpm --filter @engine/assets lock:ids:pack`.
Art lib `roofs_lib.py`; reference selection `roofs_select.py`; composites `roofs_preview.py`.
Preview: `/workspace/assets/preview/roofs.png`. Test: `packages/assets/test/roofs_rfx.test.ts`.

## 7. Still open for EA

1. Add gameplay keys `roof_cottage`, `roof_gambrel` (minTier 1), `roof_shed` (minTier 0) + ADR-311 weights
   (Barn/Mill/Stable → gam, Shed/Hunter Shack → shd, Cottage/Farmhouse → cot).
2. Engine: per-tile band z offset, per-level region flood (invalidate on `StructureIndex.version`), overlay instances
   with depth bias, whole-region cutaway, whole-roof snow pass, `bld` pool regex.

3. **ADR-397 alignment — done** (Art patch to `roofRfx.ts/json` + `adr397_roof_rfx.test.ts`, checked by compositing
   EA's selection with the packed art): crown rule at kmax (fixed the pit in ≥ 9-wide hips), shed band unclamped
   (fixed the stepped deep sheds), crest on `e` only (there is no `oc` art; an `o` corner already meets its
   neighbours' ridge, so 2×2 / perimeter corners are correct as plain `o`), crown gable ends get `up_vf`.
   Engine resolves Art's names directly or via the ADR-398 alias stems: verges `rfx_<form>_<lo|up>_v{el,er,r,f}`,
   flat field `rfx_flt_f[_v<n>]`, crown `up_f`. Verge kinds are letters (`vel`, `ver`, `vr`, `vf`) and are overlay-only;
   interior variants are always `_v<digit>` on surface pieces, so `rfxSpriteKeys`' `/_v\d$/` never confuses them.
4. Open: `isStreamedBuildingAtlas` / `bld` pool for `/^rfx_/` (today the pages use the generic stream pool);
   flip `roof_forms.json` `live` (needs EA's ADR-311/398 test updates); `shk` wiring for `site:<kind>` and wall
   `variantNames` (§8).

## 8. `shk` split-log shake skin (log cabins)

Owner-approved material skin for log-wall buildings, through the ADR-397 material hook (`roofRfx.json`
`materials`, `skinKey: "{base}_{skin}{tier}"`). Same piece grammar and selection; only the art differs.

**Keys:** `rfx_<form>_<seg>_<shape>[c][_v<n>]_shk_t<N>` plus the skin's overlays
(`rfx_<form>_<lo|up>_v{el,er,r,f}_shk_t<N>`, `rfx_gab_wall_shk_t1`, `rfx_shd_wall_shk_t<N>`) and a fieldstone stack
`rfx_chimney_shk_t1`. Examples: `rfx_hip_lo_e_shk_t1`, `rfx_gab_up_ec_shk_t1`, `rfx_gab_lo_ver_shk_t1`,
`rfx_shd_lotop_e_shk_t0`, `rfx_cot_up_f_v2_shk_t1`.

| tier | forms | look |
|---|---|---|
| t0 (twig) | `hip`, `shd` (34 sprites) | weathered silver-brown split logs, wide ragged shakes; shed side walls dark log |
| t1 (wood) | `hip`, `gab`, `cot`, `shd` + stack (77 sprites) | hand-split red cedar shakes, thick dark butts, log gable ends, fieldstone chimney |

No `flt` (flat roofs aren't shingled) and no `gam` (barns, not cabins). Twig has no `gab`/`cot` base forms either.
Unique art: own ramps (`shake_split`, `shake_cedar`), own `shake` pattern (split widths, per-shake butt length,
dropped shakes, split grain), log gable walls; 0 of 335 shake cells is pixel-identical to any base cell. Seamless by
the same world-space heightfield as the base set. Where no shake key exists (other tiers/forms) `rfxSpriteKeys`
falls back to the base key, so a t2+ roof on log walls keeps its base material
(slate, tin, plate); only t0/t1 roofs show shakes.

Pages: `rfx_shk_t0` (2016×480) and `rfx_shk_t1` (2016×960) since the eaves pass, one page per tier (a cabin loads one page), stream.

**Selection rule** (data in `roofRfx.json`, vote logic in `roofRfx.ts`):
- Log walls = **twig- and wood-tier walls** (owner decision: shakes on wood-wall cabins too): any `family: "wall"`
  piece — `wall`, `wall_low`, `wall_window`, `wall_doorway`, `wall_arched`, `wall_fortified`, corners — at tier
  `twig` or `wood`. Client material strings `twig`, `wood`. Stone, metal and reinforced walls vote base.
- Clan palisade wall (`wall` variant 3, logs) on any tier: rule `"<tier>:clan_palisade"`. Inactive until EA gives
  the `wall` piece `variantNames` (`roofWallMaterial` only appends a variant name when one exists).
- Cabin ruins: abandoned kinds **`cabin` (5), `hunter_shack` (7), `fisher_hut` (26)** are stamped with tier-1 wood
  walls, so the `wood` rule already gives them shakes; rules `site:cabin`, `site:hunter_shack`, `site:fisher_hut` keep
  them shaked if EA ever reports `site:<kind>` (e.g. for stone-tier ruins). Note: every wood-walled ruin (cottage,
  farmhouse…) with a t1 hip/gab/cot/shd roof now gets shakes too.
- Forms `hip`, `gab`, `shd`, `cot` only.
- **Mixed walls:** every roof tile of the connected region that reports a supporting wall (one level down) votes for
  the skin its wall maps to (no rule = base). Strict majority wins; **a tie goes to base**. Interior tiles don't vote.
  The whole region gets one skin, so a roof never mixes shakes and shingles.

**Bytes:** PNG 57,635 + KTX2 263,120 = 320,755 B atlases; `manifest.building.json` +77,653 B raw (+2.9 KB gz); total dist +398,408 B (≈ 0.40 MB).
Preview: `/workspace/assets/preview/roofs_shake.png` (6×4 cabins, stone-wall base vs wood/twig-wall shake, rendered
with EA's selection; last row: wood-wall cabin at t1 shakes vs t2 slate fallback).

## 9. Eaves pass: roofs overhang the walls (ADR-404 follow-up)

Owner ask (via EA): the roof sits **on top of** the walls and overhangs them; no wall strip shows. Every rfx form × tier and
the `shk` skin were repainted (same keys, same grammar, same selection; only the art and the frame changed).

- **Overhang** (measured as screen drop at 1x: 1 tile of outward shift = 32 px): the surface continues the form's own
  slope **6 px** (0.1875 tile) past the tile diamond on every **outer** edge — every side in the piece's lower mask
  (`lo` eaves, shed high edge `top`/`lotop`, flat parapets) — and **8 px** (0.25 tile) at outer corners, flared over the
  half edge next to the corner (`o`, `h`, `p`, the gable eave/rake corners). Interior sides (member neighbours, all `up`
  pieces, `f` crowns, `i` valleys) stop exactly at the diamond, so seams tile as before; tile cuts carry no ink (the
  outline is judged against the neighbours' fill).
- **Fascia:** a 4 px trim-ramp board under the camera-facing **S/E** eave and rake lines (highlight, board, hard shade,
  ink bottom). Flat roofs: the parapet face drops 8 + 3 = 11 px. N/W (back) eaves overhang with the outline only.
- **Rakes (gable / gambrel / shed ends):** the verge overlays `…_v{el,er,r,f}` now carry the rake strip (6 px past the
  end side, 8 px flare at the eave corner) plus the bargeboard on S/E ends; back ends (N/W rows), blank before, now hold
  just the rake strip. Shed verges also reach 6 px past their uphill side (the key has no `top` flag), so the shed's high
  corner is covered too.
- **End strips:** `rfx_gab_wall`, `rfx_gam_wall_lo/up`, `rfx_shd_wall` and the band-0 gable / shed triangles reach **3 px
  below** the seat (over the wall top under them).
- **Frame:** 96×80, pivot (48,44), **anchor (0.5, 0.55)** — 12 px wider each side, 12 px deeper below the pivot, top
  unchanged; the art's union bbox is x −48…+47, y −41…+33 around the pivot.
- **Seat guidance (EA):** wall art tops sit ≈ 5–6 px above the level line at an edge's centre column (twig 4.5).
  Eaves on hip/cot hang ≥ 8 px (overhang + slope drop) + 4 px fascia below their seat line, so **hip/cot seat ≈ 13** hides
  the wall tops with no clip on the eave sides. Gable / shed ends and flat faces only reach 3 px below the seat, so with
  them **gab/gam/shd/flt seat ≤ 9** (else a gap opens under the end triangle) — or keep the ADR-404 clip on the end walls.
- **Bytes:** atlases PNG 240,834 → 312,459 B, KTX2 1,280,099 → 1,652,245 B (**+443,771 B**); `manifest.building.json`
  −8,165 B raw (+678 B gz; anchors shorten). **Dist ≈ +0.44 MB.** Tools: `add_roofs.py --no-icons` and
  `--material shk --no-icons`, oxipng `-o 4`, `ktx2.py` on a temp manifest of the 12 `rfx_*` atlases. Icons unchanged.
- Preview: `/workspace/assets/preview/roofs_eaves.png` (left = live before, right = eaves pass; hip, shake cabins, gable,
  shed, gambrel, cottage, flat over real wall art with the ADR-404 clip).
