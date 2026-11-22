# ADR-504 art request: base building pieces at a realistic floor height (80 px)

**Owner decision being served:** "Can we make all the base building pieces sizes scale correctly with the player and the world?"
**Why art:** the gap is in the shipped art itself. Every number below was measured at 1x from the art the game resolves
(`tools/measure-building-scale.py` → `packages/gameplay/data/building_scale.measured.json`) and confirmed in real
WebGL2 renders with the player doll beside each piece. No engine scale can fix it honestly: a uniform scale breaks the
64 px tile grid, and a vertical-only scale stretches the art.

## What is off (1x px above the piece's pivot / ground point; player doll = 53 px = 1.75 m)
| piece | now | vs player | target |
|---|---|---|---|
| wall (all tiers) | 55–56 (48 face + 8 cap) | 1.05x — head height | 80 face + cap ≤ 8 → **80–88** |
| wall_doorway clear opening | **31** (8 px footing → 31) | **0.59x** — the player cannot fit | floor → **58–64** (aim 60 = 1.13x) |
| door_wood / door_metal leaf | 41 | 0.78x | **60–66** |
| wall_window opening | sill 24, head 30 | — | sill **24–30**, head **58–62** |
| window_glass / _shutters / _bars | 35–40 | — | fill the new opening: **56–64** |
| wall_arched crown | 22–23 | 0.43x | **60–64** |
| wall_corner_inner / _outer / _angled | 55–56 | — | **80–88** |
| pillar | 59 | — | **80–92** |
| wall_fortified | 65 | — | **84–96** (80 face + crenels) |
| stairs | 64 (rises 48) — and every tier draws `stairs_twig` | — | top step at the back corner **94–100** (rises one 80 px floor across the tile); dedicated `stairs@tier1..4` |

Furniture and props already assume a taller room (wardrobe 91, kitchen_cupboard 84, bookcase 81, bunk_bed 81, chandelier 82,
fireplace 99 px above their pivots), and the clan hall door opening is 64 px — the base walls are the outlier.

## Already right — do NOT repaint
foundations, floors (hatch / stairwell / skylight / triangle), all roofs (legacy + rfx, incl. shakes and eaves), wall_low
(32 px ≈ 1.07 m, waist high), hatch_wood, ladder (per terrain level), fences, garden_gate, barricade_spiked, gate_clan,
clan_hall_door, watchtower.

## Delivery spec
- **Floor = 5 terrain levels = 80 px** (from 3 = 48 px). 1 px vertical ≈ 3.3 cm (53 px / 1.75 m).
- **Same keys, same layout:** every sprite keeps its key, atlas key, `building.frames` `[rot][damage]` grid, `rotationArt`
  (unique4 rows; rot 2 = rot 0 frames, rot 3 = rot 1, exactly as shipped), 4 baked damage stages, door/window
  `closed` / `swing1..4` / `open` states. **No new facings, no new rotations.**
- **Sets:** t0 twig (`*_twig` in `pack/atlases/buildings_twig.png`, plus bare `bld_wall_corner_*`), t1–t4
  (`bld_*_t1..t4` in `pack/building/atlases/building_t1..t4.png`), openings (`door_wood`, `door_metal`, `window_*` in
  `openings.png`), their swing frames (`door_swing_openings.png`), and the `bld_crack` overlay (must cover an 88 px face).
- **Frames:** `building_t*` 84×96 → **84×128**, anchor y 0.75 → **0.8125** (the pivot stays 24 px above the frame bottom,
  the same world point; 104 px headroom). `buildings_twig` / `openings` / `door_swing_openings` (128×128, anchor 0.75)
  already have 96 px headroom — keep their frames.
- **Pivot:** unchanged world point — the tile-edge midpoint on the ground for edge pieces, the tile centre for cells,
  the vertex for corner posts. Wall faces stay flush on the foundation rim (ADR-210).
- **Quality:** dedicated paint at the same texel density (1 art px = 1 world px, @2x pages where they exist) — new courses
  of logs / planks / stones / panels, never the old face stretched or stacked. Same palette per tier.
- **Size:** `building_t1..t4` are 7.7 MB today; keep the whole drop ≤ +2.5 MB of dist after oxipng (the site guard is 800 MB).
- **Branch, not main:** push to `art/building-80px` and send me the SHA. 80 px walls on main while floors are still 48 px
  would poke 32 px through every roof and upper floor. I land the art and the engine flip together in one fast-forward
  push: `tiers.json` levelHeight 3→5, `FLOOR_HEIGHT_LEVELS` 3→5, `roofRfx.json` levelPx 48→80, `building_scale.json`
  floorLevels 5 with `pendingArt` emptied, re-measured `building_scale.measured.json`, roof seats re-checked
  (ADR-404/405), stairs ramp and the level-height tests. `adr504_building_scale.test.ts` checks every number above.

## Art delivered (Art & Assets, branch `art/building-80px`)
Re-built at the 80 px floor by the targeted packer `packages/assets/pack/building/src/add_building_80px.py` (metric + builders in
`src/scale80.py`, imported by `pieces.py`); never build.py / build_all. New geometry from the procedural materials at the same
texel density (new log / plank / stone / panel courses), cel-snapped (flat fills, one hard shade, hard highlight, binary alpha;
the soft contact shadow kept). Measured with `tools/measure-building-scale.py` (px above the pivot, 1x):

| piece | delivered | target |
|---|---|---|
| wall (t0–t4) | 87–89 | 80–90 |
| wall_doorway clear opening | 60 (sill 7–8, footing) | 58–64 |
| door_wood / door_metal leaf | 65 / 65 | 60–66 |
| wall_window opening | sill 28–29, head 59–60 | sill 24–30, head 58–62 |
| window_glass / _shutters / _bars | 63 / 63 / 62 | 56–64 |
| wall_arched crown | 58–65 (round head, keystone) | 60–64 |
| wall_corner_inner / _outer / _angled | 87–88 / 87–88 / 88 | 80–88 |
| pillar | 91 | 80–92 |
| wall_fortified | 95–96 (5 px crenels, stepped buttresses, arrow slits) | 84–96 |
| stairs (t0 `stairs_twig`, t1–t4 `bld_stairs_t<N>`) | 94–97 (10 treads, top tread z 78 at the back edge) | 94–100 |

- **Frame (deviation, needed):** `building_t1..t4`, `building_tw`, `building_fx` and the new `building_stairs` use **84×120, pivot (42,99),
  anchor (0.5, 0.825)** instead of 84×128 / 0.8125. The tier pages have 17 rows of 24 and every shipped frame index is pinned
  (shaft hatch / foundation / floor-hatch tests); 17 × 128 = 2176 px would overflow the 2048 texture-array layer, 17 × 120 = 2040
  fits. The pivot is the same world point; headroom is 99 px (tallest art: angled corner rot 3 = 99, fortified = 96), and 21 px
  stay below the pivot (the shipped art reaches +21; only an alpha ≤ 2 shadow row of the untouched cells is cropped).
- **Untouched pieces** on those pages (foundations, floors, wall_low, roofs, chimney, shaft hatch) are the shipped pixels moved down
  27 px into the taller cell — not repainted.
- **Stairs:** dedicated flights per tier on the stream page `building_stairs` (no room on the tier pages): t1 open-riser planks on dark
  stringers + newel, t2 solid stone with flagstone treads and cobble cheeks, t3 diamond-plate treads on teal stringers, t4 riveted
  plates on a slate mass with armoured cheeks; t0 `stairs_twig` (reed treads on log stringers) re-built in place.
- **Openings:** door leaves (knob at 30, the wood door's port at 48, metal door three straps), 6-pane glass, 5-bar grille, Z-braced
  shutters, and their swing1..4 frames (`door_swing_openings`); `bld_crack` spreads over the 88 px face.
- **Engine flip (EA):** `building_scale.json` (`floorLevels` 5, `floorPx` 80, `pendingArt` emptied), `tiers.json` levelHeight,
  `FLOOR_HEIGHT_LEVELS`, `roofRfx.json` levelPx — until then the ADR-504 "pending pinned" / "floor flips with the art" checks fail
  on this branch by design (the art is measured at 80 px while the contract still says 48).
