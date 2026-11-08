# Building piece art keys (sub-manifest `packages/assets/pack/building/manifest.building.json`)

Status: art landed (4 tier pages). Survival: adopt these **piece keys** (`BuildPieceDef.key`); the renderer resolves
`building.piece` = `<pieceKey>@tier<N>` from `BuildPiece.tier` (render 9b50b7d) and falls back to the bare `<pieceKey>` sprite.
`packages/gameplay/docs/ART_KEYS_BUILDING.md` (d86a464) is the source of truth; this file matches it.

## Tiers (gameplay `tiers.json` index)
| tier | material | look |
|---|---|---|
| 0 | twig | main pack `<piece>_twig` art (unchanged, no @tier0 art) |
| 1 | wood | planks, cobble plinth, shingles |
| 2 | stone | ashlar/cobble, slate roof |
| 3 | metal | bolted teal-iron panels, corrugated roof |
| 4 | reinforced | riveted steel plates, cross bracing, hazard trim |

## Piece keys (every one has `@tier1` .. `@tier4`)
Existing gameplay keys (bare sprite stays the main pack's wood art; this pack adds `@tierN` only):
`foundation`, `floor` (solid ceiling), `floor_hatch_frame` (hatch ceiling), `wall`, `wall_low` (half wall), `wall_window`, `wall_doorway`, `pillar`, `roof_flat`, `roof_slope`.
Existing art-only keys (main pack art, this pack adds `@tierN`): `wall_corner` (= outer corner art), `roof_ridge` (= gable art), `roof_hip`, `roof_corner`.
New keys (bare key = tier1 art + `@tier1..4`):

| group | keys | placement | rotation art |
|---|---|---|---|
| foundations | `foundation_triangle`, `foundation_ramp`, `foundation_steps`, `foundation_stilt` | triangle: tri (unit equilateral, pivot = centroid); others cell | triangle/ramp/steps unique4, stilt symmetric |
| shaft access | `shaft_hatch` | 1×1 cell, ground/rim level (layer 0), closed walkable lid | unique4; hinge faces -y at rot 0 |
| walls | `wall_arched`, `wall_fortified` | edge | 2 drawn rows (axis), rows reused for rot 2/3 |
| ceilings | `floor_stairwell`, `floor_skylight`, `floor_triangle` | cell / tri (centroid), level >= 1 | stairwell 2 rows, skylight symmetric, triangle unique4 |
| corners | `wall_corner_outer`, `wall_corner_inner`, `wall_corner_angled` | vertex (pivot = corner post on the tile corner) | unique4 |
| roofs | `roof_gable`, `roof_chimney` | cell, roof | gable 2 rows, chimney symmetric |

## Damage
`BuildPiece.damageStage` 0 intact, 1 scuffed, 2 cracked/chipped, 3 wrecked (frames baked per rotation).
Damage is not in the key. Every sprite declares `crackOverlay: "bld_crack"` (anims `stage1..3`).

## Attach points
`roof_chimney*`: `smoke` (chimney mouth, pivot-relative px) for a smoke VFX.

## Grid
1 cell = 1 iso tile 64x32. Pivot = cell centre (cell/edge pieces), tile corner (vertex corners) or centroid (triangles).
1 floor = FLOOR_HEIGHT_LEVELS (3) terrain levels x zStep 16 px = 48 px = wall height; ceilings and roofs are drawn from
their own level's floor (z = level * 3 terrain levels), so they sit on wall tops.
Triangles: unit equilateral, rot 0 = edge 0 facing +x; renderer shows 30-degree rots at the nearest quarter (4 rows).
Corner stubs are 0.22 tile (edge walls already run vertex to vertex); angled = post + 45-degree half-diagonal to the tile centre.

## Sprite keys (manifest)
`bld_<piece>_t<N>` -> `building.piece` `<piece>@tier<N>`; new pieces also have `bld_<piece>` -> bare `<piece>` (tier1 art).
`wall_corner@tierN` / `roof_ridge@tierN` reuse the `wall_corner_outer` / `roof_gable` frames. Crack overlay sprite: `bld_crack`.

## Atlas
One page per tier, `building_t1..t4`: 2016x1056, 84x96 cells, pivot (42,72) = anchor (0.5, 0.75), 1x only; ~8.1 MiB RGBA8 each (32.5 MiB all), KTX2 ETC1S twins ~2 MiB each (8.1 MiB all) via assets/tools/ktx2.py.

## Shaft Hatch (add-only art)
`shaft_hatch` (twig, bare key) and `shaft_hatch@tier1..4`: dedicated ground trapdoors, not raised floor holes.
There is no `@tier0`: tier 0 resolves to the bare key, which is now TWIG art (it was tier-1 wood before).

- `bld_shaft_hatch` (piece `shaft_hatch`, twig) on always-resident `building_tw`: closed `[48..51]`,`[52..55]`,`[56..59]`,`[60..63]`; open `[64..67]`..`[76..79]`. idle = 48.
- `bld_shaft_hatch_t1..t4` on `building_t1..t4`: closed frames unchanged `[352..355]`,`[356..359]`,`[360..363]`,`[364..367]` (idle 352);
  open appended `[368..371]`,`[372..375]`,`[376..379]`,`[380..383]`.
- Each row = one rotation (unique4, hinge on -y at rot 0), columns = damage 0–3.
- Open state: `building.states.open` (and `states.closed` = `building.frames`); `animations.open` = open intact frame
  (64 twig / 368 tiers), `animations.closed` = `animations.idle` = closed intact. Closed stays the placed default.

`shaft_hatch_bottom` (twig, bare) and `shaft_hatch_bottom@tier1..4`: pit-floor landing + rope back up (rope on the -y side, under the hinge).
- `bld_shaft_hatch_bottom` on `building_tw` frames `[80..83]`..`[92..95]`; `bld_shaft_hatch_bottom_t1..t4` on `building_t1..t4` frames `[384..387]`..`[396..399]`.
- No open state. Anchor (0.5, 0.75), footprint 1×1, layer 0, `rotationArt: unique4`, `crackOverlay: bld_crack` (same as the hatch).

Pages: `building_t1..t4` 2016×1632 (24 × 17 rows); `building_tw` 1344×576 (16 × 6 rows; corner frames 0–47 unchanged).
Build-window icons in `items_build` (32px + 64px pages): `build_shaft_hatch_t1..t4` 287–290, `build_shaft_hatch_t0` 291,
`build_shaft_hatch_bottom_t0..t4` 292–296.
Re-run only `packages/assets/pack/building/src/add_shaft_hatch.py` (append-only, reuses existing indices);
it preserves all previously shipped sprite records and pixel cells. Never run the whole building pack for this addition.
