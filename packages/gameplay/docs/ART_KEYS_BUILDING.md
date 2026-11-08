# Building art keys (modular building, ADR-104)

This doc is the source of truth for gameplay building sprite keys (assets/building/KEYS.md defers to it).

## Scheme
- **Sprite key:** `pieceVariantKey(defs, piece)` gives `<pieceKey>@tier<N>`, where N = `BuildPiece.tier`: 1 wood, 2 stone, 3 metal, 4 reinforced.
  - Tier 0 (twig) and untiered pieces use the bare `<pieceKey>`, which is the main pack's twig/base art. There is no `@tier0`.
- **Fallback chain:** `pieceVariantKeyChain` gives `[<key>@tier<N>, <key>]`. The bare key is also the tier1 art for new pieces, as in KEYS.md.
- **Damage is not in the key.** Draw the overlay sprite `BUILD_CRACK_OVERLAY` = `bld_crack` with anim `crackOverlayAnim(BuildPiece.damageStage)`:
  - 0 intact: no overlay
  - 1: `stage1`
  - 2: `stage2`
  - 3 wrecked: `stage3`
- **Attach:** `roof_chimney` has `attach.smoke` at {x:0, y:-46}. Gameplay emits no smoke entity; the attach is render-only.
- **Height:** 1 floor = `FLOOR_HEIGHT_LEVELS` (3, in @engine/world) terrain z levels = 48 px wall.
  - gameplay `building.levelHeight` was 2 and is now 3. A test asserts it equals FLOOR_HEIGHT_LEVELS.

## Keys (104 total, 26 pieces × 4 tiers; ❌ = not in manifest.building.json)
| piece | keys |
|---|---|
| `shaft_hatch` | `shaft_hatch@tier1` `shaft_hatch@tier2` `shaft_hatch@tier3` `shaft_hatch@tier4` |
| `floor` | `floor@tier1` `floor@tier2` `floor@tier3` `floor@tier4` |
| `floor_hatch_frame` | `floor_hatch_frame@tier1` `floor_hatch_frame@tier2` `floor_hatch_frame@tier3` `floor_hatch_frame@tier4` |
| `floor_skylight` | `floor_skylight@tier1` `floor_skylight@tier2` `floor_skylight@tier3` `floor_skylight@tier4` |
| `floor_stairwell` | `floor_stairwell@tier1` `floor_stairwell@tier2` `floor_stairwell@tier3` `floor_stairwell@tier4` |
| `floor_triangle` | `floor_triangle@tier1` ❌ `floor_triangle@tier2` ❌ `floor_triangle@tier3` ❌ `floor_triangle@tier4` ❌ |
| `foundation` | `foundation@tier1` `foundation@tier2` `foundation@tier3` `foundation@tier4` |
| `foundation_ramp` | `foundation_ramp@tier1` ❌ `foundation_ramp@tier2` ❌ `foundation_ramp@tier3` ❌ `foundation_ramp@tier4` ❌ |
| `foundation_steps` | `foundation_steps@tier1` `foundation_steps@tier2` `foundation_steps@tier3` `foundation_steps@tier4` |
| `foundation_stilt` | `foundation_stilt@tier1` `foundation_stilt@tier2` `foundation_stilt@tier3` `foundation_stilt@tier4` |
| `foundation_triangle` | `foundation_triangle@tier1` `foundation_triangle@tier2` `foundation_triangle@tier3` `foundation_triangle@tier4` |
| `pillar` | `pillar@tier1` `pillar@tier2` `pillar@tier3` `pillar@tier4` |
| `roof_chimney` | `roof_chimney@tier1` `roof_chimney@tier2` `roof_chimney@tier3` `roof_chimney@tier4` |
| `roof_corner` | `roof_corner@tier1` `roof_corner@tier2` `roof_corner@tier3` `roof_corner@tier4` |
| `roof_flat` | `roof_flat@tier1` `roof_flat@tier2` `roof_flat@tier3` `roof_flat@tier4` |
| `roof_gable` | `roof_gable@tier1` `roof_gable@tier2` `roof_gable@tier3` `roof_gable@tier4` |
| `roof_hip` | `roof_hip@tier1` `roof_hip@tier2` `roof_hip@tier3` `roof_hip@tier4` |
| `roof_slope` | `roof_slope@tier1` `roof_slope@tier2` `roof_slope@tier3` `roof_slope@tier4` |
| `wall` | `wall@tier1` `wall@tier2` `wall@tier3` `wall@tier4` |
| `wall_arched` | `wall_arched@tier1` `wall_arched@tier2` `wall_arched@tier3` `wall_arched@tier4` |
| `wall_corner_angled` | `wall_corner_angled@tier1` `wall_corner_angled@tier2` `wall_corner_angled@tier3` `wall_corner_angled@tier4` |
| `wall_corner_inner` | `wall_corner_inner@tier1` `wall_corner_inner@tier2` `wall_corner_inner@tier3` `wall_corner_inner@tier4` |
| `wall_corner_outer` | `wall_corner_outer@tier1` `wall_corner_outer@tier2` `wall_corner_outer@tier3` `wall_corner_outer@tier4` |
| `wall_doorway` | `wall_doorway@tier1` `wall_doorway@tier2` `wall_doorway@tier3` `wall_doorway@tier4` |
| `wall_fortified` | `wall_fortified@tier1` `wall_fortified@tier2` `wall_fortified@tier3` `wall_fortified@tier4` |
| `wall_low` | `wall_low@tier1` `wall_low@tier2` `wall_low@tier3` `wall_low@tier4` |
| `wall_window` | `wall_window@tier1` `wall_window@tier2` `wall_window@tier3` `wall_window@tier4` |

## Missing keys (Art asked, names not renamed)
- `foundation_ramp@tier1..4` (+ bare `foundation_ramp`): a sloped foundation for the stilt/steps family.
- `floor_triangle@tier1..4` (+ bare `floor_triangle`): a triangle floor/ceiling that tops `foundation_triangle`.

Until Art ships these, the renderer falls back to the bare key, which is missing too, so the placeholder shows.

## Notes for Art
- The corner pieces (`wall_corner_outer/inner/angled`) are **vertex-snapped free pieces** in gameplay (layer 3; angled has 8 rot steps). KEYS.md draws them as "cell (corner post)".
  - Anchor each sprite on the post at the tile corner, not the tile centre.
- Triangle pieces rotate in 30° steps (12). The renderer currently shows them at the nearest quarter turn.
- Art-only keys that gameplay does not place: `wall_corner`, `roof_ridge`. Gameplay uses `wall_corner_outer` and `roof_gable` for these.
