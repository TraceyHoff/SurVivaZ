
## Native-size pipeline (VEHICLES_RENDER.md)
- `python3 tools/build.py` renders every doc id at true target px (`scaleMode: "native"`); legacy keys are alias sprites (`aliasOf`).
- `python3 tools/split_facings.py` (right after build.py, before assemble) splits any sheet whose 1x page is >1008px into facing-group pages `veh_art_<key>_f{h|v|d}<n>` (h = E/W, v = S/N, d = diagonals; ≤1008 @1x, ≤2016 @2x, dims multiple of 16) and adds per-animation `dirFrames` ([frame*dirs+dir] → {atlas, frame, anchor}). The renderer resolves `dirFrames` (render 62e770d), so the legacy full-size pages are no longer emitted: each split sprite's `atlas` points at its first facing page (the E/fh page) and its `frames`/`frameAttach` keep legacy indices (the validator skips their range check when every animation has dirFrames). `--retarget <manifest>` applies the same to an already assembled manifest. Page dims are 16-aligned; build tries 1008, then 1024, then 2048. Run with PYTHONHASHSEED=0.
- `python3 tools/lineup.py` → `preview/scale_lineup.png` (player vs bike/sedan/pickup/RV/semi).
- `python3 ../tools/ktx2.py <manifest...> --report out.json` (from packages/assets/pack) writes KTX2 twins: ETC1S colour pages, UASTC masks; manifest fields `ktx2` (atlas + page) and `masksKtx2`. PNG stays the fallback.

## True-scale pass (2026-11, branch art/vehicles-true-scale)
Heights at the player doll scale (53 px = 1.75 m -> 30.29 px/m), lengths at 45.25 px per footprint metre; real-world sizes,
frames, anchors and the seat/rider anchor file are documented in `docs/ART_KEYS_VEHICLES.md` ("True-scale pass").
Pipeline: build.py -> split_facings.py -> oxipng -> merge_parts.py (targeted swap) -> assets/tools/ktx2.py -> seats.py.
`VEH_PIN=<shipped manifest>` keeps the shipped state -> page grouping so no sprite key changes. Pages are indexed PNGs (save_indexed).
