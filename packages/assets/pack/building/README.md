# building sub-manifest

Tiered base-building pieces (tier1 wood, tier2 stone, tier3 metal, tier4 reinforced); keys in `assets/building/KEYS.md`.

Rebuild: `cd src && python3 build.py ..` (uses `assets/tools` box/roof toolkit), then `python3 preview.py /workspace/assets/building/preview`
then `python3 ../../../../assets/tools/ktx2.py manifest.building.json` (in pack/building) and `pnpm --filter @engine/assets lock:ids:pack`.

- 26 pieces x 4 tiers, 4 damage stages each (baked), `crackOverlay: bld_crack`.
- Rotation rows: symmetric pieces 1 row (`mirror`), axis pieces (walls, ceilings with an axis, gable) 2 drawn rows as `[r0,r1,r0,r1]` `unique4`, asymmetric pieces 4 rows.
- Cells cropped from the 128x128 render cell at (22,24) to 84x96; pivot (42,72). Pages 2016x1056, one per tier, 1x only.
  **ADR-504 (80 px floor):** frames are now 84x120, pivot (42,99) = anchor (0.5, 0.825) on `building_t1..t4`, `building_tw`, `building_fx`
  and the new `building_stairs` stream page (17 rows x 120 = 2040 px keeps every shipped frame index inside the 2048 layer).
  Re-built by the targeted packer `src/add_building_80px.py` (never build.py): wall, wall_window, wall_doorway, wall_arched,
  wall_fortified, wall_corner_outer/_inner/_angled, pillar (t1-t4), the twig corners, `*_twig` walls/pillar/stairs, door/window
  inserts + their swing frames, `bld_crack`, and `bld_stairs_t1..t4`. Metric and builders: `src/scale80.py` (imported by pieces.py).
  build.py / twig_corners.py still crop 84x96 and must not be re-run for these pages.
- `roof_chimney` has a `smoke` attach point.

## Decor (ADR-112 / ADR-113)

`src/decor/` (called from `build.py`) renders `$decor` pieces from `gameplay/data/pieces.json` onto their own pages
`decor_<group>_<cell>` (1x + `@2x`, each with a `tintmask` R = paint / G = secondary-pattern). Sprites: `dec_<key>`
(bare key, first variant) and `dec_<key>__<variant>` (`building.piece = "<key>@<variant>"`). Same rotation-row rules as
above; `residency: "stream"`; one baked damage stage (`[f,f,f,f]`) plus `bld_crack`. Groups are appended in `decor/__init__.py` `GROUPS`, never
reordered, so earlier pages stay byte-identical. Previews: `DECOR_PREVIEW=<dir> python3 build.py ..`.
