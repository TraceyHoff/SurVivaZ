# Art brief: Electricity tier (power grid, electric stations, powered building tier, hydroponics)

**From:** Engine Architect  **To:** Art & Assets  **Date:** Nov 27, 2026 (CST)  **Status:** final piece list; engine is wired to these exact keys.

**Owner request (Tracey):** a new end-game tier of electricity-powered crafting/cooking stations, food storage, furniture, fuel and solar generators, small/medium/large batteries, solar panels, wind turbines, water-mill variants, Wireless Power Extender Pylons, a powered building tier that lights and heats rooms, and hydroponic tables. "All the art, assets, animations, sprites, icons etc must be as compressed as small as possible without compromising graphics quality ... the scale must be accurate to the world and the player. All the new powered tier should have animations as well when in use."

Every piece below is unique, dedicated art: no reuse, recolors, stretching or squashing. Engine placeholders (sprite_fallbacks.json, zero new files) stand in until your keys land; your art takes over automatically per key.

## 1. Scale (repo constants, look-ups not guesses)
- Iso 2:1, tile 64x32 px, zStep 16 px (pack README). **1 tile = 1 m of footprint** (ADR-319 / ADR-518).
- **Height: 30.29 px per metre** (player doll 53 px = 1.75 m; `building_scale.json` playerPx/playerM). Building floor = 5 levels = **80 px** (ADR-511).
- **Footprint length: 45.25 px per metre** along the E/W view (64 px tile width / sqrt 2, `render/src/vehicles/scale.ts`).
- 1 art px = 1 world px at 1x; every atlas ships a 1x page and an @2x page (same layout) like all `decor_*` atlases.
- Pivot: footprint centre on the ground (props/stations), tile-edge midpoint for edge mounts (wall light), same as existing furniture. 'Top px' below = pixels from the pivot to the highest point at 1x = round(height_m x 30.29) + the footprint's back-corner rise ((w+h) x 8 px).

## 2. Frame classes (existing pipeline; new tall classes only where a mast/wheel cannot fit)
| class | frame 1x (WxH) | anchor y | headroom above pivot | exists today as |
|---|---|---|---|---|
| s | 64x88 | 0.7955 | 70 px | decor_*_s, hearth_s |
| t | 72x120 | 0.8500 | 102 px | decor_*_t, hearth_t |
| w | 104x120 | 0.7833 | 94 px | decor_*_w |
| wt | 104x144 | 0.8194 | 118 px | decor_*_wt, hearth_wt |
| l | 136x152 | 0.7632 | 116 px | decor_*_l |
| xt | 72x168 | 0.8571 | 144 px | **new** (mast / wheel) |
| xw | 104x200 | 0.8800 | 176 px | **new** (mast / wheel) |
| xxl_t | 112x240 | 0.9000 | 216 px | **new** (mast / wheel) |
| xxl_l | 176x376 | 0.9255 | 348 px | **new** (mast / wheel) |

## 3. Animation convention (same as fired hearth pieces, ADR-218, so no new renderer path)
- `unlit` animation: **1 frame per painted facing** = powered-off / idle (not in use). Also `building.states.unlit` = the same frame(s).
- `idle` animation: **looping active animation** (`loop: true`), played by the engine **only while the piece is powered AND in use** (generator running, station crafting, lamp switched on, fridge holding food, battery charging/discharging, turbine/wheel producing, pylon energised, hydroponic table growing). Frame counts/fps below. `building.frames` = the first active frame (what a powered piece shows in static batches).
- unique4 pieces: `animations.*.rotations` rows for the 2 painted facings (rot 2 = rot 0 frames, rot 3 = rot 1), exactly like `fireplace` in hearth_wt. mirror pieces: one painted facing.
- **No new facings beyond what the pipeline already uses**: unique4 = 2 painted facings, mirror = 1. 4 baked damage stages are NOT required for decor-class pieces (they use `bld_crack`), same as existing furniture.
- Glow (lamps, hobs, coils, LEDs, grow lights) goes in an **emissive mask page** (`<atlas>_emissive.png` + @2x), like hearth_s/t/wt. Keep emissive pixels to the light parts only.

## 4. Pieces (manifest key = piece key; build icon `build_<key>`)
| # | manifest key | name | footprint tiles | real size m (L x D x H) | top px @1x | base diamond px | class / frame | facings (rotationArt) | unlit frames | active (idle) frames @fps | frames total / facing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `electrician_workstation` | Electrician's Workstation | 2x1 | 1.9 x 0.8 x 2.0 | 85 | 96x48 | wt 104x144 | 2 (unique4) | 1 | 6 @ 10 | 7 |
| 2 | `generator_fuel` | Fuel Generator | 2x1 | 1.8 x 0.9 x 1.2 | 60 | 96x48 | w 104x120 | 2 (unique4) | 1 | 6 @ 12 | 7 |
| 3 | `generator_solar` | Solar Generator | 1x1 | 1.0 x 1.0 x 0.9 | 43 | 64x32 | s 64x88 | 1 (mirror) | 1 | 4 @ 4 | 5 |
| 4 | `solar_panel` | Solar Panel | 2x1 | 2.0 x 1.0 x 1.4 | 66 | 96x48 | w 104x120 | 2 (unique4) | 1 | 4 @ 3 | 5 |
| 5 | `wind_turbine` | Wind Turbine | 1x1 | 2.4 x 2.4 x 6.2 | 204 | 64x32 | xxl_t 112x240 | 1 (mirror) | 1 | 8 @ 12 | 9 |
| 6 | `wind_turbine_large` | Large Wind Turbine | 2x2 | 4.4 x 4.4 x 10.2 | 341 | 128x64 | xxl_l 176x376 | 1 (mirror) | 1 | 8 @ 10 | 9 |
| 7 | `water_wheel` | Water Wheel | 2x1 | 2.4 x 0.9 x 2.6 | 103 | 96x48 | wt 104x144 | 2 (unique4) | 1 | 8 @ 8 | 9 |
| 8 | `water_wheel_overshot` | Overshot Water Mill | 2x2 | 3.4 x 2.0 x 4.0 | 153 | 128x64 | xw 104x200 | 2 (unique4) | 1 | 8 @ 8 | 9 |
| 9 | `water_turbine` | Micro Hydro Turbine | 1x1 | 0.8 x 0.8 x 1.0 | 46 | 64x32 | s 64x88 | 1 (mirror) | 1 | 6 @ 12 | 7 |
| 10 | `battery_small` | Small Battery | 1x1 | 0.5 x 0.3 x 0.6 | 34 | 64x32 | s 64x88 | 1 (mirror) | 1 | 4 @ 2 | 5 |
| 11 | `battery_medium` | Battery Bank | 1x1 | 0.6 x 0.6 x 1.3 | 55 | 64x32 | t 72x120 | 1 (mirror) | 1 | 4 @ 2 | 5 |
| 12 | `battery_large` | Large Battery Array | 2x1 | 1.8 x 0.8 x 2.0 | 85 | 96x48 | w 104x120 | 2 (unique4) | 1 | 4 @ 2 | 5 |
| 13 | `power_pylon` | Wireless Power Extender Pylon | 1x1 | 0.6 x 0.6 x 3.0 | 107 | 64x32 | xt 72x168 | 1 (mirror) | 1 | 6 @ 8 | 7 |
| 14 | `electric_stove` | Electric Stove | 1x1 | 0.76 x 0.65 x 1.1 | 49 | 64x32 | s 64x88 | 2 (unique4) | 1 | 4 @ 6 | 5 |
| 15 | `electric_furnace` | Electric Furnace | 1x1 | 1.0 x 1.0 x 1.6 | 64 | 64x32 | t 72x120 | 2 (unique4) | 1 | 6 @ 10 | 7 |
| 16 | `power_workbench` | Power Tool Workbench | 2x1 | 2.0 x 0.8 x 1.6 | 72 | 96x48 | w 104x120 | 2 (unique4) | 1 | 6 @ 10 | 7 |
| 17 | `power_hammer` | Power Hammer | 1x1 | 1.0 x 1.0 x 2.2 | 83 | 64x32 | t 72x120 | 2 (unique4) | 1 | 6 @ 10 | 7 |
| 18 | `fridge` | Refrigerator | 1x1 | 0.7 x 0.7 x 1.8 | 71 | 64x32 | t 72x120 | 2 (unique4) | 1 | 4 @ 4 | 5 |
| 19 | `chest_freezer` | Chest Freezer | 2x1 | 1.4 x 0.7 x 0.85 | 50 | 96x48 | w 104x120 | 2 (unique4) | 1 | 4 @ 4 | 5 |
| 20 | `electric_floor_lamp` | Electric Floor Lamp | 1x1 | 0.4 x 0.4 x 1.6 | 64 | 64x32 | t 72x120 | 1 (mirror) | 1 | 4 @ 4 | 5 |
| 21 | `electric_table_lamp` | Electric Table Lamp | 1x1 | 0.3 x 0.3 x 0.5 | 31 | 64x32 | s 64x88 | 1 (mirror) | 1 | 4 @ 4 | 5 |
| 22 | `electric_wall_light` | Electric Wall Light | 1x1 | 0.3 x 0.15 x 0.3 | 25 | 64x32 | t 72x120 | 2 (unique4) | 1 | 4 @ 4 | 5 |
| 23 | `ceiling_light` | Ceiling Light | 1x1 | 0.5 x 0.5 x 0.25 | 24 | 64x32 | t 72x120 | 1 (mirror) | 1 | 4 @ 4 | 5 |
| 24 | `flood_light` | Flood Light | 1x1 | 0.5 x 0.5 x 3.0 | 107 | 64x32 | xt 72x168 | 1 (mirror) | 1 | 4 @ 4 | 5 |
| 25 | `electric_heater` | Electric Heater | 1x1 | 0.6 x 0.3 x 0.65 | 36 | 64x32 | s 64x88 | 2 (unique4) | 1 | 4 @ 4 | 5 |
| 26 | `hydroponic_table` | Hydroponic Table | 2x1 | 2.0 x 1.0 x 1.7 | 75 | 96x48 | w 104x120 | 2 (unique4) | 1 | 4 @ 6 | 5 |

Total piece frames: **253** at 1x (+ the same at @2x). Suggested atlases (uniform grids, one per class): `elec_s`, `elec_t`, `elec_w`, `elec_wt`, `elec_xt`, `elec_xw`, `elec_xxl_t`, `elec_xxl_l` in a new fragment `pack/electricity/manifest.electricity.json` (registered in `packages/assets/src/manifest-index.ts` like task540), `residency: "stream"`.

### Per-piece notes (look, what animates, special placement)
- `electrician_workstation` (station): Steel bench at 0.9 m, pegboard with cable spools, multimeter, soldering station, oscilloscope. Active: solder sparks + scope trace + bench lamp flicker.
- `generator_fuel` (source): Enclosed diesel/petrol genset on skid, exhaust stack, fuel cap, control panel. Active: body vibration, exhaust puffs, gauge needle, green run LED.
- `generator_solar` (source): Portable power station box (0.6x0.4x0.5 m) with a fold-out 1 m panel on a tilt stand. Active: LED charge bars march, panel glint.
- `solar_panel` (source): Ground-mount aluminium frame, 2 m x 1 m monocrystalline panel tilted ~30 deg, junction box + cable. Active: slow light glint sweep across the cells.
- `wind_turbine` (source): Lattice/tube mast, hub at 5.0 m, 3-blade rotor 2.4 m diameter, tail vane, guy wires. Active: rotor spin (8 frames = 120 deg of a 3-blade rotor, loops seamlessly).
- `wind_turbine_large` (source): Tubular steel tower on concrete pad, nacelle at 8.0 m, 3-blade rotor 4.4 m diameter. Active: rotor spin (8 frames = 120 deg, seamless loop).
- `water_wheel` (source): Undershot timber wheel 2.4 m diameter, 0.6 m wide, on a stone/timber bank frame with a small generator housing. Placed on the bank, wheel dips into the adjacent water tile. Active: wheel turns (8 frames = one paddle pitch), splash at the waterline. The wheel overhangs the water-side edge of the footprint; paint the bank side as land.
- `water_wheel_overshot` (source): Overshot wheel 3.4 m diameter fed by a wooden flume on trestles, small mill house with generator. Active: wheel turns, water pours from flume, splash. The wheel overhangs the water-side edge of the footprint; paint the bank side as land.
- `water_turbine` (source): In-stream micro turbine: steel housing on a skid sitting in shallow water, intake grate, generator cap, cable mast. Active: water churn/foam at the outflow, spinning shaft collar.
- `battery_small` (battery): Sealed lead-acid/LiFePO4 pack in a ventilated steel case, terminal caps, 4-segment LED gauge. Active (charging or discharging): LED segments animate (fill on charge).
- `battery_medium` (battery): Floor rack cabinet of 4 modules, bus bars, inverter on top, LED gauge. Active: LED gauge animates.
- `battery_large` (battery): Two tall battery cabinets with inverter/charger, conduit, warning labels, LED gauges. Active: LED gauges animate, inverter fan.
- `power_pylon` (pylon): Slim steel mast on a weighted base with a toroidal transmitter coil and small dish on top. Active (network energised): coil glow pulse + faint arc ring.
- `electric_stove` (station): Freestanding enamel range: 4 ceramic hobs, oven door window, backsplash with dials (1.1 m incl. backsplash, worktop 0.92 m). Active: hobs glow red, oven window lit.
- `electric_furnace` (station): Induction smelting furnace: insulated steel body, tilting crucible, control box, coolant pipes. Active: crucible glow cycles, heat shimmer, status lamp.
- `power_workbench` (station): Heavy bench with table saw, bench drill, vice and tool rack. Active: saw blade spins, drill runs, sawdust specks.
- `power_hammer` (station): Electric forging hammer: C-frame, motor + belt guard, ram and anvil die, foot pedal. Active: ram strikes (down/up cycle), belt moves, tiny sparks on strike.
- `fridge` (storage): Upright two-door fridge-freezer, handle, small LED display. Active (holding food): display digits/LED cycle, faint condenser shimmer.
- `chest_freezer` (storage): Long chest freezer, lid with handle, front grille, thermostat LED. Active (holding food): LED cycle, frost wisps at the lid seal.
- `electric_floor_lamp` (furniture): Modern standing lamp, drum shade, weighted base, cord. Active (switched on): warm glow (4-frame gentle breathe).
- `electric_table_lamp` (furniture): Desk lamp with shade (sits on tables like table_lamp). Active: warm glow breathe.
- `electric_wall_light` (furniture): Wall-mounted LED sconce at 1.8 m on a wall edge (mount like wall_sconce). Active: glow breathe. Mounted at 1.8 m: the fixture sits 55-64 px above the edge pivot (draw it there in the frame).
- `ceiling_light` (furniture): Flush/pendant LED fixture hanging from the ceiling, drawn at 2.3-2.6 m above the floor (ceiling mount like chandelier). Active: glow breathe. Hangs from the ceiling: fixture body sits 70-79 px above the floor pivot (2.3-2.6 m), like chandelier.
- `flood_light` (furniture): Outdoor steel pole, two LED flood heads angled down, junction box. Active: lamp heads lit with light-cone sheen.
- `electric_heater` (furniture): Oil-filled radiator / fan heater with grille and dial. Active: coil glow behind grille, heat shimmer.
- `hydroponic_table` (farming): Steel table at 0.9 m with a nutrient tray (plants sit in 2 net-pot rows on the tray surface at 0.9 m = 27 px), reservoir + pump under, LED grow-light bar on posts at 1.7 m. Active (powered and growing): grow light pink/white glow pulse, water ripple in tray, pump LED. Crop sprites are drawn by the engine on the tray surface (27 px above pivot); leave the tray top visible and empty (net pots only).

## 5. Powered building tier (tier 5 "powered", built from the normal build menu)
Walls/floors with integrated LED light strips and radiant heating panels; they light and heat the room while powered.
- Pieces (15): `bld_foundation_t5`, `bld_foundation_triangle_t5`, `bld_floor_t5`, `bld_floor_triangle_t5`, `bld_floor_hatch_frame_t5`, `bld_floor_stairwell_t5`, `bld_wall_t5`, `bld_wall_low_t5`, `bld_wall_window_t5`, `bld_wall_doorway_t5`, `bld_wall_arched_t5`, `bld_wall_corner_inner_t5`, `bld_wall_corner_outer_t5`, `bld_wall_corner_angled_t5`, `bld_pillar_t5`.
- Atlas `building_t5`, **same layout rules as building_t4**: 84x120 frames, anchor y 0.825, unique4 (2 painted facings), `building.frames[rot][damage]` with 4 baked damage stages, `crackOverlay: bld_crack`, 80 px floor (walls 80-88 px tops, door opening 58-64, window sill 24-30 / head 56-64 per ADR-504 targets). Pivots identical to t4.
- Powered look = `building.frames` (strips glowing, emissive mask page `building_t5_emissive.png`). `building.states.unlit[rot][damage]` = same piece with strips dark.
- Active animation: `idle` loop **4 frames @ 4 fps** (slow light-strip shimmer / heat-panel glow) for the intact stage only, per painted facing (`rotations`). Damaged stages are static.
- Frames per piece: 2 facings x (4 powered + 4 unlit + 3 extra anim) = 22; total ~330 cells (t4 is 24x17 = 408 cells).
- Material: dark graphite composite panels with steel trim, recessed warm-white strips, subtle heating-grille texture. Clearly a step above `reinforced` (t4). Not a recolor of t4.
- Roofs and stairs are not in this tier (any existing tier roof works on top), so no `rfx_t5_*` is needed.
- **No seasonal variants**: the building pipeline has none for base pieces (only the ADR-410 ramp tilesets are per season).

## 6. Icons
- Build icons (`items_build`, 32x32 cell + @2x 64x64, art inset 2 px): `build_<key>` for all 26 pieces above, and `build_<key>_t5` for the 15 powered-tier pieces (ADR-229 naming). The 26 electric pieces are crafted as kits at the Electrician's Workstation; each kit item's inventory icon points at its `build_<key>` icon (same object, no second painting).
- Inventory icons (`items_icons`, 32x32 + @2x) for 4 new end-game components: `circuit_board` (Circuit Board), `electric_motor` (Electric Motor), `solar_cell` (Solar Cell), `led_bulb` (LED Bulb).
- Skill icons (`items_skills`, 32x32 + @2x): `skill_electrician` (Electrician branch node), `skill_power_grid` (generators/batteries/pylons node), `skill_powered_tier` (powered building tier), `skill_hydroponics`.
- HUD/prompt glyphs (32x32 + @2x, resident): `icon_power_on`, `icon_power_off`, `icon_battery` (used in the interact prompt status).

## 7. Compression target (smallest file with no visible quality loss, current pipeline formats)
- PNG RGBA8 straight alpha, **oxipng-optimised** (CI oxipng cache, ADR-391), + **KTX2** (Basis, same settings as the existing decor atlases) for every page and mask, 1x and @2x. Indexed/limited palette where it is lossless for that sheet.
- Pack frames tightly: uniform grids sized to the class, no empty columns/rows beyond the last frame, transparent padding only where the grid needs it.
- Emissive pages: only the glowing pixels, rest fully transparent (they compress to a few KB like hearth_t_emissive 3.8 KB).
- Tintmask pages are **not** needed (these pieces are not paintable), saving ~1 file per page.
- Reference sizes today: decor_light_t 55 KB png / 138 KB @2x; hearth_t 21 KB / 54 KB; building_t4 1.56 MB png / 0.55 MB ktx2.
- **Budget for the whole drop: <= +6 MB of dist** (all pages, masks, KTX2, icons).

## 8. Dist size vs guard
- Live dist (Pages run for main f46c20a0, Nov 27 9:08 PM CST): **571.9 MB of the 800 MB guard** (Pages hard limit 1 GB). 5,082 files: .ktx2 314.8 MB, .png 227.1 MB, audio 20.5 MB.
- Headroom 228 MB; this drop should cost ~1% of it.

## 9. Delivery
- Push to a branch `art/electricity-tier` (not main) and send me the SHA; I verify scale against the player doll in WebGL2 + Canvas2D and fast-forward it.
- Ship in any order; each key goes live as it lands (the engine already resolves these keys and falls back to placeholders per key).
- Please run `pnpm --filter @engine/assets lock:ids:pack` and the manifest validator as usual.

## 10. Engine behaviour you can rely on (for animation intent)
| piece group | in use = active animation plays when |
|---|---|
| generators | powered on, fuelled (fuel gen) / producing (solar gen) |
| solar / wind / water | producing > 0 W (sun up, wind, water flow) |
| batteries | charging or discharging |
| pylon | its network carries power |
| electric stations | powered and a player is crafting at it |
| fridge / freezer | powered and holding food |
| lamps / heater / flood light | powered and switched on |
| hydroponic table | powered and a crop is growing on it |
| powered building tier | powered |

## Engine status (ADR-590 / ADR-591, Nov 27, 2026 CST)
- Live in data with placeholders: all 26 piece keys above (tinted neighbours via `sprite_fallbacks.json` `sprites`, marked `$placeholder`), kits and components use the generic placeable icon. The build menu shows the neighbour's tile until `build_<key>` ships (adr229 keeps these as "pending", never the glyph).
- Skill nodes Electrician / Power Grid / Hydroponics reuse `skill_tinkerer` / `skill_grease_monkey` / `skill_master_farmer` until `skill_electrician` / `skill_power_grid` / `skill_hydroponics` ship; swap the three `icon` fields in `packages/gameplay/data/skills.json` when they land.
- Active animation hook: the client plays `idle` only while the piece's replicated `Power.active` is 1 (powered AND in use) and `unlit` otherwise (apps/client/src/view.ts, FireState.Lit path — no hearth particles).
- Update (Art, batch 4, Nov 28, 2026 CST): all 26 `build_<key>` and 15 `build_<piece>_t5` icons shipped (`items_build_elec`), so the 26 `$placeholder` entries are removed from `sprite_fallbacks.json`; each of the 25 kit items has its own `kit_<key>` item sprite on the same `items_build_elec` cell as its `build_<key>` (brief: same object, no second painting). The four skill nodes now use `skill_electrician` / `skill_power_grid` / `skill_hydroponics` / `skill_powered_tier` (`items_elec`). Tier 5 has its own art (`bld_<piece>_t5`, `<piece>@tier5`), so the tier-4 borrow in `visual.ts` / `buildIconKey` no longer triggers for these 15 pieces.

## Art delivered (Art, Nov 27-28, 2026 CST)
Dedicated art per key (no reuse / recolour / tint / shared frames), true scale 30.29 px/m, hearth convention
(`idle` loop while `Power.active`, `unlit` 1 frame per painted facing, `building.states.unlit`, emissive mask page per
atlas). Pages `elec_<class>` (+ `@2x`, `_emissive`, `_emissive@2x`; PNG oxipng + KTX2), `residency: stream`, in the
existing building fragment (`manifest.building.json`), so no new fragment / manifest-index wiring was needed.
Packer: `packages/assets/pack/building/src/add_electricity.py` (add-only, owns `elec_*` only; frame indices never move
when later batches append), art kit `src/elec/` (`lib.py` + `pieces<batch>.py`), encode `src/elec_encode.py elec_`,
preview `src/elec_preview.py`. The `$placeholder` entries in `sprite_fallbacks.json` stay until each key's `build_<key>` icon ships (the build tile borrows them, adr229); real art already wins in the world (resolveSprite returns the key itself, untinted).
Test: `packages/assets/test/adr590_electricity_art.test.ts` (layout, convention, pages, true-scale floor/ceiling, emissive
only on active frames).

| key | class / atlas | facings | measured top px (brief) | notes |
|---|---|---|---|---|
| `generator_fuel` | w / elec_w | 2 (rot 0, 1) | 51 (60) | genset on a skid, louvred enclosure, dark control panel (hour meter ticks, run LED), exhaust smoke + 1 px vibration |
| `generator_solar` | s / elec_s | mirror | 43 (43) | power-station box + fold-out panel; glint sweep, charge bars |
| `battery_small` | s / elec_s | mirror | 22 (34) | strap-handle pack, 4-segment gauge animates |
| `battery_medium` | t / elec_t | mirror | 47 (55) | 4-module rack, bus bars, inverter on top, gauge + module LEDs |
| `battery_large` | w / elec_w | 2 (rot 0, 1) | 82 (85) | two louvred cabinets + inverter, vertical gauges, inverter fan spins |
| `power_pylon` | xt / elec_xt | mirror | 93 (107) | weighted base, mast, toroidal coil + dish; coil glow pulse + soft arc ring |
| `solar_panel` | w / elec_w | 2 (rot 0, 3) | 67 (66, +4 ok) | two modules on a ground-mount frame, combiner box (charge + MPPT LEDs); glint sweep. Both painted facings show the cells |
| `wind_turbine` | xxl_t / elec_xxl_t | mirror | 189 (204) | guyed tube mast, nacelle + tail vane, hub 151 px, 2.4 m rotor as a true iso disc; 8 frames = 120 deg, soft motion disc, controller LEDs |
| `wind_turbine_large` | xxl_l / elec_xxl_l | mirror | 313 (341) | tapered can-section tower, door, transformer cabinet, nacelle with anemometer + aviation light, hub 242 px, 4.4 m rotor |
| `water_wheel` | wt / elec_wt (**144x152**) | 2 (rot 0, 3) | 101 (103) | 2.4 m undershot wheel overhanging the water side, axle trestles, gearbox, shed + cable pole; 8 frames = one paddle pitch, foam + splash |
| `water_wheel_overshot` | xw / elec_xw (**184x216**, pivot 180) | 2 (rot 0, 3) | 148 (153) | 3.4 m shrouded bucket wheel, flume on trestles, stone mill house; water pours from the flume, splash, wheel turns |
| `water_turbine` | s / elec_s | mirror | 32 (46) | ducted turbine on a skid in the water, trash rack, generator cap, cable mast; spinning collar mark, outlet churn |
| `electrician_workstation` | wt / elec_wt | 2 (rot 0, 1) | 84 (85) | steel bench at 0.9 m, pegboard with cable spools, oscilloscope (moving trace), soldering station (sparks), multimeter, bench lamp flicker |
| `electric_stove` | s / elec_s | 2 (rot 0, 1) | 45 (49) | enamel range, worktop 28 px, 4 ceramic hobs cycling red, oven window lit, backsplash dials + clock |
| `electric_furnace` | t / elec_t | 2 (rot 0, 1) | 57 (64) | insulated body, refractory rim, crucible with molten surface (glow cycle), flue, control box, coolant pipes, heat shimmer |
| `power_workbench` | w / elec_w | 2 (rot 0, 1) | 53 (72) | heavy bench, table saw (blade spins, sawdust), bench drill (chuck runs), vice, tool rack, switch LED |
| `power_hammer` | t / elec_t | 2 (rot 0, 1) | 76 (83) | C-frame, motor + belt guard (belt moves), ram down/up cycle with sparks on the strike, foot pedal |
| `fridge` | t / elec_t | 2 (rot 0, 1) | 66 (71) | two-door fridge-freezer, LED display digits cycle, note under a magnet, condenser shimmer |
| `chest_freezer` | w / elec_w | 2 (rot 0, 1) | 44 (50) | chest freezer, lid handle, grille, thermostat LEDs, frost wisps at the lid seal |
| `electric_floor_lamp` | t / elec_t | mirror | 53 (64) | weighted base, pole, drum shade glowing warm (breathe), cord + plug |
| `electric_table_lamp` | s / elec_s | mirror | 16 (31) | articulated desk lamp drawn at z 0 (the engine lifts it onto tables like table_lamp), warm glow breathe |
| `electric_wall_light` | t / elec_t | **4** (rot 0-3) | 70 (fixture 55-64 px) | LED sconce on a backplate on the wall face, wall wash up/down; no shadow. 4 painted facings like `dec_wall_sconce` (the fixture must sit on the room side) |
| `ceiling_light` | t / elec_t | mirror | 83 (canopy at the 80 px ceiling, body 70-76 px) | canopy, stem, dome shade, lit diffuser ring, glow; no shadow |
| `flood_light` | xt / elec_xt | mirror | 94 (107) | concrete footing, 3 m pole, crossarm with two LED flood heads, junction box LED, soft light cones |
| `electric_heater` | s / elec_s | 2 (rot 0, 1) | 29 (36) | fan heater on feet, coil bars glowing behind the grille, dial, pilot light, heat shimmer |
| `hydroponic_table` | w / elec_w | 2 (rot 0, 1) | 68 (75) | steel table, nutrient tray surface at 27 px left empty (12 net pots in 2 rows, ripple), reservoir + pump LED, grow-light bar at 1.7 m (pink pulse) |

Facings: `(rot 0, 1)` = the true rotations; `(rot 0, 3)` = parts that must face the camera (panel cells, the wheel on
the water side) use the rot 3 geometry for the second painted facing (`rotations` stays [r0, r1, r0, r1]). Water mills
need only *a* water tile beside them (`besideWater`), so the player turns the wheel to it.
Wider frames than the brief where a wheel overhangs its footprint in every facing: wt 144x152 (brief 104x144), xw
184x216 pivot 180 (brief 104x200 pivot 176). Pages are indexed PNG + tRNS (exact cel palette; anti-aliased / soft pixels
mapped to the nearest of 64 extra entries) to stay byte-lean.

Measured tops are below the brief's ceiling where the object does not fill its whole footprint (the brief's figure
assumes the far corner reaches full height); every key stands at least round(height m x 30.29) px.

### Batch 4: powered building tier + icons (Nov 28, 2026 CST)
**Powered tier** (`bld_<piece>_t5`, piece `<piece>@tier5`): packer `packages/assets/pack/building/src/add_tier5.py` (add-only,
owns `building_t5` + `building_t5_floor` and their `_emissive` masks), art kit `src/elec/tier5.py`. Geometry = the shared
tier builders (pieces.py / buildings2.py at the scale80 metric), so pivots, footprints and heights are exactly t4's; new
material set (dark graphite composite panels, gunmetal posts / beams, brushed-steel plinth and trim, gunmetal deck plate,
precast concrete footings) and a steel-and-glass upper band on every full wall face (glazed panel, brushed-steel mullions and
sill), plus the powered parts painted on top: recessed warm-white LED strips (walls: under the cap beam
at 72 px and a skirting strip at 8.5 px, both faces; pillars / corner posts: a vertical strip per face; decks: an inset
perimeter ring, hole rims on hatch frame / stairwell, step lights round the foundation sides) and radiant heating panels
(gunmetal grille + hot element line + status LED on each wall face, under-window radiator on the window wall, grille in
every deck).
- Layout = building_t4: 84x120 frames, anchor (0.5, 0.825), `unique4`, painted rows as t4 (2 for the straight walls and the
  stairwell, 4 for the rest), `building.frames[rot][damage]` (4 baked damage stages, LED segments knock out with damage),
  `crackOverlay: bld_crack`. `building.states.unlit[rot][damage]` = strips / elements dark. `animations.idle` = 4 frames
  @ 4 fps per painted row (a slow shimmer pulse travels along the strips, glow halos breathe), `animations.unlit` = unlit d0.
- 11 cells per painted row (4 powered + 4 unlit + 3 extra animation), 48 rows = 528 cells on two pages: `building_t5`
  (walls + pillar, 286 cells on a 24x17 = 2016x2040 tier page like building_t1..t4, so the ADR-503 building stream pool
  keeps one page geometry) and `building_t5_floor` (foundations + floors, 242 cells, 22x11, a plain stream page) - one
  t4-size page cannot hold 528 cells.
  1x only like building_t4, indexed PNG + KTX2, streamed. Measured rot-0 tops = t4's (walls 92, corners 87-88, pillar 91,
  low wall 36, foundation 28, floor 20, stairwell 26, triangles 14 / 21; the 80-88 px brief band is the wall face, the
  measured top includes the back corner of the cap).
- Not a recolour of t4: own materials, own parts, own render (same procedural geometry as every tier).

**Icons**
- `items_build_elec` (stream, 32 px + @2x, CSS-only like items_build): `build_<key>` x 26 and `build_<piece>_t5` x 15, ADR-224
  cel pass from each piece's own active frame (rot 0): figure crop, 2 px inset, own flat palette, bold outline ring.
  `kit_<key>` (25 kit items, category item) share their piece's `build_<key>` cell.
- Item defs checked (items.json + vehicle_items.json): every electricity ingredient already had its own icon (copper wire =
  `item_copper_wire`, battery acid, battery, fuel tank, small engine, steel plate, iron pipe, glass); the 4 new components are
  painted here. 15 older non-electricity items still have no icon of their own (wet_wood, reeds, flax, cured_venison,
  cured_poultry, cured_prime_cut, smoked_fish, well_water_flask, well_canteen, well_water_bottle, well_waterskin, dung,
  dung_fertilizer, harness, fishing_rod) - outside this drop.
- `items_elec` (resident, 32 px + @2x): `circuit_board`, `electric_motor`, `solar_cell`, `led_bulb` (items), `skill_electrician`,
  `skill_power_grid`, `skill_hydroponics` (crafting medallions), `skill_powered_tier` (building medallion), `icon_power_on`,
  `icon_power_off`, `icon_battery` (interact-prompt glyphs), painted with draw.C in cel mode.
- Generator `packages/assets/pack/items/src/elec_icons.py`; both atlases are in gen_icon_css.py (SRC + UI_OK) and the
  stylesheet is regenerated (this also picked up `build_dock` / `build_shipyard`, which were in the manifest but missing
  from the CSS).
