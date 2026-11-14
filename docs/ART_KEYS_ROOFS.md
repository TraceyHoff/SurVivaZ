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

Tiers: `hip`, `flt`, `shd` t0–t4; `gab`, `cot`, `gam` t1–t4 (no twig gable). **475 sprites, 1,450 frames.**

Examples: `rfx_hip_lo_e_t1`, `rfx_hip_up_ec_t2`, `rfx_hip_up_e_v2_t1`, `rfx_gab_lo_ver_t3`, `rfx_gab_up_vf_t2`,
`rfx_gam_wall_up_t1`, `rfx_shd_lotop_e_t0`, `rfx_flt_f_v1_t4`, `rfx_chimney_t1`.

**Build-menu icons** (one unique icon per form per tier, own page `items_build_rfx`, 32 px + `@2x` 64 px, stream):
`build_rfx_<form>_t<N>` — `hip` t0–4, `gab` t1–4, `flt` t0–4, `cot` t1–4, `gam` t1–4, `shd` t0–4 (27 icons).
CSS classes are regenerated by `vehicle_items/src/gen_icon_css.py`. `items_build` itself is untouched.

## 4. Selection scheme (engine)

Dirs (ADR-311): **0 = S (+y), 1 = W (−x), 2 = N (−y), 3 = E (+x)**. Mask bits: **N=1, E=2, S=4, W=8, NE=16, SE=32,
SW=64, NW=128**. Orientation is world-relative; apply view rotation like existing pieces (`quarterTurn`).

**Region and form.** Members = roof-family pieces on the same level, 8-connected. Legacy keys (`roof_flat`,
`roof_slope`, `roof_corner`, `roof_hip`, `roof_gable`, `roof_chimney`) are one group: form `hip` if any
slope/corner/hip, else `gab` if any gable, else `flt` (chimney-only → `hip`). New gameplay keys `roof_cottage`,
`roof_gambrel`, `roof_shed` (still to be added by EA) each form their own group. Missing / disrepaired tiles are
non-members (holes get eave lips). Shape comes from the region; art tier from each tile's own tier.

**Band**, KMAX = 3:
- `hip`, `cot`: Chebyshev distance to the nearest non-member − 1, capped at KMAX.
- `gab`, `gam`: one ridge axis per region (majority rot; else the long axis). band = min(runA, runB) capped at KMAX,
  runA/runB = consecutive members perpendicular to the ridge.
- `shd`: downhill dir D (majority rot). band = members downhill of the tile (**uncapped**). `top` = uphill neighbour
  is a non-member.
- `flt`: 0.

**Draw height** `zoff(band) = Σ rise[0..band−1]` px at 1x (1 level = 48 px), added to the piece's normal z:

| form | rise per band (px) |
|---|---|
| `hip`, `gab` | 14, 14, 14 |
| `cot` | 10 (flared), 16, 16 |
| `gam` | 22, 8, 8 |
| `shd` | 9 per band |
| `flt` | 0 |

**Lower mask** L: bit set if that neighbour is a non-member or has a lower band. `gab`/`gam`: only the two
perpendicular-to-ridge cardinal bits (no diagonals). `shd`: unused. `flt`: non-membership only (cardinals + diagonals).
For `hip`/`cot`/`gab`/`gam` at band == KMAX, force L = 0 → `up_f`.

**Shape from n = L & 15:**

| n | key | row |
|---|---|---|
| 4 / 8 / 1 / 2 | `e` | 0 / 1 / 2 / 3 |
| 6 / 12 / 9 / 3 | `o` | 0 / 1 / 2 / 3 |
| 5 / 10 | `r` | 0 (ridge E–W) / 1 (ridge N–S) |
| 14 / 13 / 11 / 7 | `h` | 0 / 1 / 2 / 3 |
| 15 | `p` | 0 |
| 0 | `i` if a diagonal bit is set (first of SE→0, SW→1, NW→2, NE→3), else `f` | |

`seg = lo` if band 0 else `up`. Exceptions: `gab`/`gam` with n = 0 below KMAX → `up_r` (row by axis); `flt` parapet pieces
are `lo`, the field has no seg (`rfx_flt_f[_v<n>]`); `shd` is always `e` row D with seg `lotop`/`lo` (band 0) or `top`/`up`.

**Crest** (`e` only, not `shd`): neighbour at (row+2)%4 is a member with equal band → append `c`.

**Variant** (only `e`/`f`, not crest, seg lo/up): `h = hashU32(0x52F00396, tx, ty, level) & 3` (the `abandoned.ts`
hash): 0–1 → v0, 2 → `_v1`, 3 → `_v2`.

**Overlays** (extra instances on the same tile, depth-biased just after it):
- `gab`/`gam` verge at ridge-axis end side x when that neighbour is a non-member: `e` tile row d → `ver` if
  x == (d+1)%4, `vel` if x == (d+3)%4, drawn with row d; `r` tile → `vr` row x; `f` tile → `vf` row x. Under a band-k
  end tile, stack k gable-wall strips facing x, strip j at zoff(j) (`gam`: `wall_lo` for j = 0, `wall_up` above).
- `shd`: side non-member at (D+1)%4 → `ver`, (D+3)%4 → `vel` (row D) + k wall strips facing it; `top`/`lotop`
  tiles get k+1 wall strips facing (D+2)%4. All use `rfx_shd_wall_t<N>`.
- `roof_chimney` (t ≥ 1): normal member, plus `rfx_chimney_tN` drawn at zoff(band) + rise[band]/2.

**Fallback.** Missing key or non-resident page → draw the legacy sprite exactly as today. Ghost previews run the same
selection.

## 5. Pages, residency, bytes (measured)

Cells **72×68**, pivot **(36,44)**, anchor (0.5, 44/68) — the same world point as the 84×96/(42,72) building cells.
1x only, solid cel, binary alpha, indexed PNG, oxipng'd, KTX2 twin via `assets/tools/ktx2.py`. Page `_a` = hip, gab,
flt (+ stack), `_b` = cot, gam, shd; 28 columns, cells deduped by hash. All `residency: "stream"`.

| page | size | sprites | PNG | KTX2 |
|---|---|---|---|---|
| `rfx_t0_a` | 2016×272 | 30 | 14,747 | 75,220 |
| `rfx_t0_b` | 2016×136 | 13 | 5,133 | 30,969 |
| `rfx_t1_a` / `_b` | 2016×408 / 408 | 52 / 56 | 17,332 / 23,297 | 106,129 / 122,527 |
| `rfx_t2_a` / `_b` | 2016×408 / 408 | 52 / 56 | 18,510 / 25,418 | 106,961 / 119,938 |
| `rfx_t3_a` / `_b` | 2016×340 / 408 | 52 / 56 | 15,732 / 24,412 | 104,412 / 130,331 |
| `rfx_t4_a` / `_b` | 2016×340 / 408 | 52 / 56 | 16,002 / 22,616 | 100,344 / 120,148 |
| **10 roof pages** | | 475 | **183,199** | **1,016,979** |
| `items_build_rfx` + `@2x` | 256×128 / 512×256 | 27 | 25,191 | 46,462 |

- **Dist delta ≈ 1.62 MB raw**: 1,271,831 B atlases (PNG + KTX2) + manifest.building +327 KB raw (+13.9 KB gz) +
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

3. **ADR-397 alignment** (engine landed from the phase-1 draft; these are the deltas to the shipped art, all in
   `roofRfx.json` / `roofRfx.ts`):
   - Verge keys: `rfx_<form>_<seg>_{vel,ver,vr,vf}` (seg = the tile's `lo`/`up`; the verge triangle height follows
     that band's rise, e.g. gam 22 vs 8 px), not `rfx_<form>_verge_{el,er,r}`. An `f` tile at a ridge end gets `vf`.
   - Band == kmax on `hip`/`cot`/`gab`/`gam`: force lower = 0 → `up_f` (a sloped `e` at kmax would climb above
     the plateau). `gab`/`gam` kmax 3 as previewed (5 also works with this rule; up rises are uniform).
   - `shd`: no band clamp (kmax ≥ 64); shed `up_e` is band-agnostic, a clamp makes deep sheds step.
   - Crest only on `e` (no `oc` art; with `crest` on `o` every perimeter corner of a ≥ 3-wide hip would crest —
     EA's own question — and `rfxSpriteKeys` already falls back to `o`).
   - `isStreamedBuildingAtlas` / `bld` pool: `/^rfx_/` pages.
