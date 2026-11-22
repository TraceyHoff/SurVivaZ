# Vehicle art keys + texture-compression ask (Render -> Art)

Vehicle art streams through the `veh` page pool (`AtlasManager`, pool class `veh`): one atlas page per vehicle
family, refcounted per live vehicle, LRU-evicted when off screen (`VehicleView.sync({ inView })`).

Art ships grouped `veh_*` atlases (e.g. `veh_cars_0`, which holds `car_compact`); sprites are looked up by Art key,
not by atlas name (`vehicles/artPack.ts`). Any `veh_*` atlas whose source is a file streams; blob/data placeholders
stay resident (they are the debug fallback only when a page is not resident yet).

Optional per-atlas `*.hands.json` (steering/hand anchors) may be absent; the 404s in dev are expected.

Working set: desktop 8 slots, low-memory (<= 256 MB texture budget, mobile / `?gl=lowend`) 6 slots at full res.
Visible vehicles are never stored downscaled to save memory; the pool reserve for vehicles is excluded from the
budget trade-offs (only the wearables pool and cold atlases shrink).

## KTX2 ask

Render has a compressed-texture probe (`probeCompressedTextures`: ETC2 / ASTC / S3TC / BPTC) and a KTX2 loader stub
(`src/assets/ktx2.ts`) behind a feature check with a PNG fallback. No Basis transcoder is installed yet.

Please export, next to every existing PNG (same basename, `.ktx2`, same @2x / 1x pages, mips included):

- **Colour pages: ETC1S** (Basis LZ), quality ~128, sRGB, premultiplied alpha off (same as the PNGs).
- **Masks (tintmask, sheen, sway) and emissive: UASTC** (+ RDO ~1.0 + Zstd), linear, so mask edges and light shapes stay
  sharp under block compression.
- Keep the PNGs: they stay the fallback for GPUs/browsers without a supported target and for `?gl=safe`.

Expected effect on mobile (Mali/Adreno, ASTC or ETC2): colour arrays ~4x smaller (8 bpp ASTC 4x4 / ETC2 RGBA vs 32 bpp)
at the same resolution, i.e. the remaining downscaled cold tier can go back to full res within the ~160 MB budget.


## True-scale pass (Art & Assets, branch `art/vehicles-true-scale`)

Owner ask (via Engine Architect): every vehicle at real-world size next to the player. All 31 vehicle / trailer / bike
keys (+ their 12 legacy aliases and 46 `<key>_st_<state>` state sprites; 89 sprites) were re-rendered from their 3D models re-authored
in metres; nothing is a stretched, squashed, tinted or downscaled copy of the old pages.

### Scale and projection (`assets/vehicles/tools/vrender.py`)
- **Length:** 1 tile = 1 m of footprint, 45.25 px per m along the E/W view (`U`, = `targetSpritePx` in
  `packages/render/src/vehicles/scale.ts`), 22.63 px per m of depth (2:1). Length target = `vehicles.json` footprint.length x 45.25.
- **Height:** the player doll is 53 px = 1.75 m, so **30.29 px per m** (`ZK = 53 / 1.75`; model z unit = 1 m). Roof
  target = real roof height x 30.29.
- Facings: the same 8 authored facings (E, SE, S, SW, W, NW, N, NE; heading 45 deg steps, no mirroring), one projection for
  all of them: `screen = (u*45.25, v*22.63 - z*30.29)`. Backface culling and painter depth use that projection's own
  camera ray `(0, 30.29, 22.63)` (it used `(0, cos30, sin30)` when height was 39.2 px/m), so every facing is consistent.
- Wheels (car discs and bike rims) keep a real radius and stay **round on screen** in the side view (their x half-axis is
  multiplied by 30.29 / 45.25), instead of turning into 1.5:1 ovals.
- **Reading the heights:** the roof column below is the roof at the vehicle centreline (what a player standing at the
  pivot compares against). The sprite's opaque top sits higher on screen because the far roof edge is lifted by iso depth
  (half the roof width x 22.63 px), so an opaque-bbox measure (the old `ART_HEIGHT_PX` method) reads ~6-30 px more.
- House style: solid cel (flat fills, no grain, one hard shade + hard highlight, 1 px part lines, bold slightly-dark
  outline = neighbour colour 62% toward ink, 1 px at 1x / 2 px at @2x), **binary alpha** on the body; the soft contact
  shadow is the one soft effect (alpha 16..96 in 6 flat steps, colour #281a32). Damage/rust/soot/grime are hard-edged
  patches. Pages are indexed PNG (<= 256 colours + tRNS) after oxipng -o2; KTX2 twins re-encoded with `assets/tools/ktx2.py`.

### Real sizes and measurements (1x px, E view, intact)
| key (aliases) | real L x W x H m | tyre r m | E length px target / opaque | roof px @centreline (old target) | opaque top above pivot px (E) | heightX = H / 1.75 m | seats |
|---|---|---|---|---|---|---|---|
| bike_basic | 1.8 x 0.6 x 1.1 | 0.35 | 81 / 78 | **33** (46) | 39 | 0.629 | 1 |
| bike_road | 1.8 x 0.6 x 1.02 | 0.34 | 81 / 78 | **31** (46) | 35 | 0.583 | 1 |
| bike_mountain | 1.8 x 0.6 x 1.1 | 0.35 | 81 / 80 | **33** (47) | 41 | 0.629 | 1 |
| bike_bmx | 1.8 x 0.6 x 0.92 | 0.31 | 81 / 80 | **28** (37) | 34 | 0.526 | 1 |
| bike_fat_tire | 1.8 x 0.6 x 1.12 | 0.37 | 81 / 86 | **34** (47) | 42 | 0.640 | 1 |
| bike_cruiser | 1.8 x 0.6 x 1.1 | 0.33 | 81 / 80 | **33** (46) | 41 | 0.629 | 1 |
| bike_tandem | 2.6 x 0.6 x 1.05 | 0.34 | 118 / 116 | **32** (46) | 38 | 0.600 | 2 |
| bike_cargo | 2.4 x 0.8 x 1.1 | 0.33 | 109 / 109 | **33** (49) | 39 | 0.629 | 1 |
| bike_trike | 1.9 x 1.0 x 1.05 | 0.3 | 86 / 84 | **32** (46) | 39 | 0.600 | 1 |
| car_compact (car_hatchback) | 3.6 x 1.6 x 1.48 | 0.31 | 163 / 167 | **45** (89) | 59 | 0.846 | 4 |
| car_sedan | 4.6 x 1.8 x 1.45 | 0.32 | 208 / 212 | **44** (95) | 60 | 0.829 | 4 |
| car_muscle (car_sports) | 4.8 x 1.9 x 1.35 | 0.39 | 217 / 220 | **41** (89) | 58 | 0.771 | 2 |
| car_offroad (car_suv) | 4.4 x 1.9 x 1.78 | 0.36 | 199 / 203 | **54** (107) | 73 | 1.017 | 4 |
| car_wagon | 4.9 x 1.8 x 1.5 | 0.31 | 222 / 226 | **45** (96) | 63 | 0.857 | 4 |
| truck_pickup (car_pickup) | 5.4 x 2.0 x 1.85 | 0.42 | 244 / 248 | **56** (111) | 74 | 1.057 | 2 |
| truck_flatbed | 6.5 x 2.2 x 2.1 | 0.48 | 294 / 297 | **64** (118) | 85 | 1.200 | 2 |
| truck_box | 7 x 2.3 x 3.2 | 0.51 | 317 / 320 | **97** (155) | 124 | 1.829 | 2 |
| van_cargo (van_delivery) | 5.2 x 2.0 x 2.0 | 0.35 | 235 / 238 | **61** (126) | 83 | 1.143 | 2 |
| van_passenger (van_minivan) | 5.4 x 2.0 x 1.78 | 0.31 | 244 / 248 | **54** (122) | 72 | 1.017 | 4 |
| camper_van | 6 x 2.1 x 2.6 | 0.36 | 272 / 275 | **79** (137) | 99 | 1.486 | 4 |
| camper_rv (camper_motorhome) | 9 x 2.5 x 3.4 | 0.44 | 407 / 410 | **103** (155) | 124 | 1.943 | 2 |
| semi_tractor (truck_semi_cab) | 6.5 x 2.5 x 3.9 | 0.52 | 294 / 297 | **118** (170) | 146 | 2.229 | 2 |
| trailer_utility_small (trailer_utility) | 2.5 x 1.5 x 1.0 | 0.23 | 113 / 116 | **30** (56) | 50 | 0.571 | 0 |
| trailer_cargo_medium (trailer_box) | 4 x 2.0 x 2.3 | 0.26 | 181 / 185 | **70** (111) | 93 | 1.314 | 0 |
| trailer_flatbed_large (trailer_flatbed) | 6 x 2.3 x 1.0 | 0.37 | 272 / 274 | **30** (67) | 58 | 0.571 | 0 |
| trailer_livestock | 6 x 2.3 x 2.6 | 0.3 | 272 / 272 | **79** (130) | 108 | 1.486 | 0 |
| trailer_tanker | 6.5 x 2.3 x 2.8 | 0.39 | 294 / 298 | **85** (141) | 92 | 1.600 | 0 |
| trailer_camper (camper_trailer) | 6.5 x 2.3 x 2.9 | 0.41 | 294 / 297 | **88** (133) | 105 | 1.657 | 0 |
| trailer_log | 6.0 x 2.3 x 2.0 | 0.33 | 272 / 272 | **61** (100) | 82 | 1.143 | 0 |
| semi_trailer_box | 13 x 2.5 x 4.05 | 0.5 | 588 / 592 | **123** (178) | 152 | 2.314 | 0 |
| semi_trailer_flatbed | 13 x 2.5 x 1.55 | 0.49 | 588 / 592 | **47** (74) | 78 | 0.886 | 0 |

Notes: `trailer_log` has no `vehicles.json` def (length from its art target, 272 px = 6.0 m). Tyre radius is the model's
wheel centre height. Old target = the previous native `targetPx.height`.
Real heights used (m): bikes 0.92-1.12 (bmx 0.92, road 1.02), compact 1.48, sedan 1.45, muscle 1.35, SUV/offroad 1.78,
wagon 1.50, pickup 1.85, flatbed truck 2.10, box truck 3.20, cargo van 2.00, minivan 1.78, camper van 2.60 (pop-top),
RV 3.40, semi tractor 3.90 (stacks), utility trailer 1.00, cargo trailer 2.30, flatbed trailer 1.00, livestock 2.60,
tanker 2.80, travel trailer 2.90, log trailer 2.00 (load), semi dry van 4.05, semi flatbed 1.55 (headboard; 1.4 m deck).
No boats, wagons/carts, buses or ATVs exist in this pack (the `vehicles.json` wagon/boat defs have no art here).

### Frames and anchors (changed: every frame is shorter; widths ~unchanged)
Keys, animation states, frame indices (`frames` / `frameAttach`), 8 facings and the state -> page grouping (so every
`<key>_st_<state>` sprite) are unchanged (`VEH_PIN`). Anchor x stays 0.5; anchor y per row below (split vehicles carry
per-facing anchors in `dirFrames`). Atlas pages that are no longer needed were dropped: `veh_art_camper_rv_fh1`,
`_fv1`, `_fd4`, `veh_art_semi_trailer_flatbed_fd4`, `_fd5`, `veh_art_trailer_tanker_fd1` (sprite keys / ids.lock unchanged).
| key | frame before (WxH, anchor) | frame after (WxH, anchor) |
|---|---|---|
| bike_basic | 118x93 a(0.5, 0.64516) | 118x80 a(0.5, 0.5875) |
| bike_road | 118x93 a(0.5, 0.64516) | 118x78 a(0.5, 0.57692) |
| bike_mountain | 118x94 a(0.5, 0.64894) | 118x81 a(0.5, 0.59259) |
| bike_bmx | 118x83 a(0.5, 0.60241) | 118x74 a(0.5, 0.55405) |
| bike_fat_tire | 118x95 a(0.5, 0.65263) | 118x82 a(0.5, 0.59756) |
| bike_cruiser | 118x93 a(0.5, 0.64516) | 118x81 a(0.5, 0.59259) |
| bike_tandem | 144x108 a(0.5, 0.63889) | 144x94 a(0.5, 0.58511) |
| bike_cargo | 140x101 a(0.5, 0.62376) | 140x87 a(0.5, 0.56322) |
| bike_trike | 134x98 a(0.5, 0.62245) | 134x85 a(0.5, 0.56471) |
| car_compact | 180x172 a(0.5, 0.69186) | 180x126 a(0.5, 0.59524) |
| car_sedan | 226x185 a(0.5, 0.65946) | 226x137 a(0.5, 0.55474) |
| car_muscle | 236x195 a(0.5, 0.66154) | 236x153 a(0.5, 0.5817) |
| car_offroad | 216x209 a(0.5, 0.69856) | 216x154 a(0.5, 0.6039) |
| car_wagon | 240x210 a(0.5, 0.68095) | 240x158 a(0.5, 0.58861) |
| truck_pickup | 262x221 a(0.5, 0.66968) | 262x175 a(0.5, 0.59429) |
| truck_flatbed | 314x254 a(0.5, 0.65748) | 314x209 a(0.5, 0.59809) |
| truck_box | E/W 340x235 a(0.5, 0.79575); S/N 152x323 a(0.5, 0.71827); diag 316x319 a(0.5, 0.72414) | E/W 338x169 a(0.5, 0.74557); S/N 146x260 a(0.5, 0.66539); diag 306x253 a(0.5, 0.67194) |
| van_cargo | 256x251 a(0.5, 0.7251) | 254x184 a(0.5, 0.63587) |
| van_passenger | 262x235 a(0.5, 0.68936) | 262x165 a(0.5, 0.5697) |
| camper_van | 292x271 a(0.5, 0.70111) | 292x214 a(0.5, 0.63551) |
| camper_rv | E/W 428x231 a(0.5, 0.76623); S/N 210x365 a(0.5, 0.67671); diag 368x345 a(0.5, 0.68406) | E/W 428x182 a(0.5, 0.73627); S/N 204x310 a(0.5, 0.63871); diag 362x287 a(0.5, 0.64112) |
| semi_tractor | 316x302 a(0.5, 0.70861) | 312x249 a(0.5, 0.6506) |
| trailer_utility_small | 156x120 a(0.5, 0.71667) | 156x93 a(0.5, 0.64516) |
| trailer_cargo_medium | 220x207 a(0.5, 0.75362) | 220x165 a(0.5, 0.69697) |
| trailer_flatbed_large | 324x199 a(0.5, 0.64824) | 324x173 a(0.5, 0.60116) |
| trailer_livestock | 324x260 a(0.5, 0.73846) | 324x213 a(0.5, 0.66197) |
| trailer_tanker | E/W 352x194 a(0.5, 0.79382); S/N 138x274 a(0.5, 0.72628); diag 264x261 a(0.5, 0.7318) | E/W 352x133 a(0.5, 0.72932); S/N 132x220 a(0.5, 0.65454); diag 258x201 a(0.5, 0.66666) |
| trailer_camper | E/W 370x196 a(0.5, 0.77551); S/N 186x259 a(0.5, 0.65637); diag 278x248 a(0.5, 0.69354) | E/W 368x153 a(0.5, 0.7451); S/N 180x212 a(0.5, 0.59434); diag 270x200 a(0.5, 0.645) |
| trailer_log | 324x232 a(0.5, 0.7069) | 324x196 a(0.5, 0.63776) |
| semi_trailer_box | E/W 600x257 a(0.5, 0.8288); S/N 156x483 a(0.5, 0.67909); diag 510x439 a(0.5, 0.69932) | E/W 600x196 a(0.5, 0.79081); S/N 150x425 a(0.5, 0.64); diag 506x378 a(0.5, 0.65873) |
| semi_trailer_flatbed | E/W 600x154 a(0.5, 0.7143); S/N 156x381 a(0.5, 0.59318); diag 512x337 a(0.5, 0.60831) | E/W 600x121 a(0.5, 0.66116); S/N 150x351 a(0.5, 0.5641); diag 506x304 a(0.5, 0.57566) |

Manifest meta: `targetPx.height` = the new roof px; `footprintTiles`, `seats`, attach names, lights (re-projected per
facing) and tint masks keep their schema.

### Seat / rider anchors: `packages/assets/pack/vehicles/seats.vehicles.json`
Per key (aliases listed): `realSize` (m) and every rider seat (`driver`, `seat_passenger`, `seat_rear_l/_r`, bikes
`seat` / tandem `seat_rear`) with its model position `u, v, z` (m; u forward, v right, z up = seat H-point), `zPx`, and
per facing (`E` .. `NE`, the sheet order) `x, y` = 1x px offset of the H-point from the sprite pivot (double for @2x).
Draw order:
- `"draw": "over"` (bikes, trike, tandem, cargo bike): draw the seated rider after the vehicle sprite.
- `"draw": "window"` (every enclosed cab): draw the rider after the vehicle sprite, clipped to screen rows
  `clipTop..clipBottom` (1x px from the pivot; roof underside .. beltline at that seat), so only head and shoulders show
  through the glass and the door hides the legs. Without clipping: draw the rider before the sprite (fully occluded).
The rider's feet pivot = the H-point + the doll's sitting hip height (engine constant).
Not shipped to dist (the vite copy rule only takes `manifest.*.json` + atlases); import it at build time or fold it into
`vehicles.json` `seatAnchors`.

### Rebuild
    cd assets/vehicles/tools; export PYTHONHASHSEED=0 VEH_PIN=<shipped manifest.vehicles.json>
    python3 paint.py $OUT && python3 build.py $OUT $PREV && python3 split_facings.py $OUT && (cd $OUT/atlases && oxipng -o 2 *.png)
    python3 merge_parts.py $OUT packages/assets/pack/vehicles      # targeted swap of veh_art_* only (interior/sounds/vfx kept)
    python3 ../../tools/ktx2.py packages/assets/pack/vehicles/manifest.vehicles.json
    python3 seats.py packages/assets/pack/vehicles && python3 true_scale_preview.py <old manifest> <old atlases> packages/assets/pack/vehicles <doll.png> <out.png>
