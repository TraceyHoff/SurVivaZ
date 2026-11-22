"""ADR-504 targeted packer: base building pieces re-built at the 80 px floor (scale80.py), add-only for everything else.

Run from repo root: python3 packages/assets/pack/building/src/add_building_80px.py
Then: (cd packages/assets && npx tsx scripts/write-lock-pack.ts) and python3 tools/measure-building-scale.py.

Never runs build.py / build_all. What it writes:
  building_t1..t4  frames 84x96 -> 84x120 (pivot (42,72) -> (42,99): the same world point, 99 px headroom, 21 below).
                   17 rows x 120 = 2040 px, so every shipped frame index stays put inside the 2048 texture-array layer
                   (84x128 would need 2176 px). Re-built: wall, wall_window, wall_doorway, wall_arched, wall_fortified,
                   wall_corner_outer / _inner / _angled, pillar (every rotation row x 4 damage stages). Every other frame
                   (foundations, floors, wall_low, roofs, chimney, shaft hatch ...) is the shipped pixels moved 27 px down.
  building_tw      same 84x120 frame; twig (t0) vertex corners re-built, shaft-hatch frames moved like above.
  building_fx      bld_crack overlay 84x120, cracks spread over the 88 px face.
  building_stairs  NEW stream page (84x120): bld_stairs_t1..t4 (`stairs@tier<N>`), a dedicated flight per tier.
  pack/atlases/buildings_twig.png (128x128, pivot 96, kept): wall / window / doorway / corner / pillar / stairs _twig
                   cells re-built in place.
  pack/atlases/openings.png (kept): door_wood / door_metal (closed + open), window_shutters (closed + open),
                   window_glass, window_bars re-built in place; hatch_wood untouched.
  door_swing_openings (kept): door_wood / door_metal / window_shutters swing1..4 re-built in place; hatch untouched.
"""
import json, os, sys, zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
import random

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(ROOT / "assets/tools"))
import scale80 as S8            # noqa: E402  (patches buildings2 before pieces / pieces2 capture builders)
import pieces as PC             # noqa: E402
import pieces2 as P2            # noqa: E402
import backs                    # noqa: E402
import buildings2 as b2         # noqa: E402
from buildings import render_boxes, finalize   # noqa: E402

PACK = ROOT / "packages/assets/pack"; BLD = PACK / "building"
CW, CH, PX, PY = 84, 120, 42, 99          # new building_t* frame and pivot
OCH, OPY = 96, 72                          # shipped frame height / pivot y
ANCHOR = {"x": PX / CW, "y": PY / CH}       # 0.5, 0.825
PAD = 12
RCELL, RORG = (128, CH + PAD + 8), (64, PY + PAD)   # render cell: 12 px spare above the frame to catch clipping
OX = RORG[0] - PX
KEYS = ["wall", "wall_window", "wall_doorway", "wall_arched", "wall_fortified", "wall_corner_outer", "wall_corner_inner", "wall_corner_angled", "pillar"]
TW_KEYS = ["wall_corner_outer", "wall_corner_inner", "wall_corner_angled"]
TWIG = ["wall_twig", "wall_window_twig", "wall_doorway_twig", "wall_corner_twig", "pillar_twig", "stairs_twig"]
OPEN_KEYS = ["door_wood", "door_metal", "window_shutters", "window_glass", "window_bars"]
SWING_KEYS = ["door_wood", "door_metal", "window_shutters"]
PC.TIER_NAMES[0] = "twig"


DECOR_RAMPS = ["gold", "glass", "flower_pink", "flower_yel", "flower_blue", "grass", "leaf", "thatch"]


def ramps_of(bx, dec):
    """house-style cel snap palette: the ramps the piece's boxes are painted in (+ the decor sprites' ramps, + ink)."""
    return sorted({b.rp for b in bx} | ({"ink"} | (set(DECOR_RAMPS) if dec else set())))


def cel(im, rps):
    import door_swing_main as DM   # palette_for + cel.snap: flat fills, one hard shade, hard highlight, binary alpha
    return DM.cel(im, rps)


def _crop(cv, seed, layer, rps):
    """4 damage stages cropped to 84x120 and cel-snapped; clip = opaque art (alpha > 40) outside the frame (the render
    cell has 12 px spare above)."""
    sr = (-0.55, 0.55, -0.55, 0.55) if layer >= 1 else None; out = []
    for st in range(4):
        im = cel(finalize(cv, st, seed, sr), rps); a = np.asarray(im)[..., 3] > 40
        inside = a[PAD:PAD + CH, OX:OX + CW].sum()
        out.append((im.crop((OX, PAD, OX + CW, PAD + CH)), bool(a.sum() != inside)))
    return out


def job_piece(args):
    """build.py render() at the 84x120 crop (same seeds, rotation rows and ADR-253 back details)."""
    t, key, rot = args; kind, fn, layer, rows, tall, _ = PC.PIECES[key]; tn = PC.TIER_NAMES[t]
    seed = zlib.crc32(f'{key}{t}'.encode()) % 1000
    up = key in PC.OLD_ROWS and rot >= PC.OLD_ROWS[key]
    bx, dec = fn(tn)
    if up: bx = bx + backs.details(bx, rot, seed)
    cv = render_boxes(bx, rot, seed=seed, decor=dec, cell=RCELL, origin=RORG)
    return ("piece", t, key, rot), _crop(cv, seed + rot, layer, ramps_of(bx, dec))


def job_stairs(args):
    t, rot = args; seed = zlib.crc32(f'stairs{t}'.encode()) % 1000
    bx, dec = S8.stairs(PC.TIER_NAMES[t])
    cv = render_boxes(bx, rot, seed=seed, decor=dec, cell=RCELL, origin=RORG)
    return ("stairs", t, rot), _crop(cv, seed + rot, 1, ramps_of(bx, dec))


def job_main(args):
    """pieces2 (main pack 128x128 cells, pivot (64,96)): twig set + openings, closed / open states."""
    key, rot, state = args; d = P2.P[key]; spec = d["draw"] if state is None else d["states"][state]
    res = spec[1](*spec[2]); bx, dec = res if isinstance(res, tuple) else (res, None)
    return ("main", key, rot, state), [(cel(im, ramps_of(bx, dec)), False) for im in P2.frames_for(key, rot, spec)]


def job_swing(args):
    import door_swing_main as DM
    from door_swing_lib import FRACS
    S8.patch_door_swing(DM)
    key, k, rot = args
    return ("swing", key, k, rot), [(im, DM.check_clip(im)) for im in DM.render_opening(key, rot, FRACS[k])]


def crack(stage):
    """hairline cracks over the 80 px wall band (z 6..84 above the pivot), faint so they read on any face."""
    S = 4; im = Image.new('RGBA', (CW * S, CH * S), (0, 0, 0, 0)); d = ImageDraw.Draw(im); rnd = random.Random(504 + stage)
    for _ in range(stage * 5):
        x, y = rnd.uniform(18, 62), rnd.uniform(PY - 84, PY - 12); pts = [(x * S, y * S)]
        for _ in range(3 + stage): x += rnd.uniform(-4, 4); y += rnd.uniform(-1, 6); pts.append((x * S, y * S))
        d.line(pts, fill=(42, 27, 46, 190), width=S); d.line([(p[0] + S, p[1] + S) for p in pts], fill=(255, 240, 220, 70), width=S // 2)
    return im.resize((CW, CH), Image.LANCZOS)


def cells_of(rows):
    return [(r, st, i) for r, row in enumerate(rows) for st, i in enumerate(row)]


def old_cell(page, i, cols):
    return page.crop(((i % cols) * CW, (i // cols) * OCH, (i % cols) * CW + CW, (i // cols) * OCH + OCH))


def regrid(page, cols, rows, repl):
    """shipped 84x96 page -> 84x120 page: replaced cells from `repl`, every other cell moved down by PY - OPY."""
    out = Image.new("RGBA", (cols * CW, rows * CH), (0, 0, 0, 0)); page = page.convert("RGBA")
    for i in range(cols * rows):
        x, y = (i % cols) * CW, (i // cols) * CH
        if i in repl: out.paste(repl[i], (x, y))
        else:
            c = old_cell(page, i, cols)
            if c.getbbox(): out.paste(c.crop((0, 0, CW, CH - (PY - OPY))), (x, y + PY - OPY))
    assert max(out.size) <= 2048, out.size
    return out


def paste_cells(path, cells, cols, cw, ch):
    im = Image.open(path).convert("RGBA")
    for i, c in cells.items():
        x, y = (i % cols) * cw, (i // cols) * ch
        im.paste(Image.new("RGBA", (cw, ch), (0, 0, 0, 0)), (x, y)); im.paste(c, (x, y))
    return im


def main():
    man = json.loads((BLD / "manifest.building.json").read_text()); pack = json.loads((PACK / "manifest.json").read_text())
    SB = {s["key"]: s for s in man["sprites"]}; SM = {s["key"]: s for s in pack["sprites"]}
    jobs = [(job_piece, (t, k, r)) for t in (1, 2, 3, 4) for k in KEYS for r in range(PC.PIECES[k][3])]
    jobs += [(job_piece, (0, k, r)) for k in TW_KEYS for r in range(PC.PIECES[k][3])]
    jobs += [(job_stairs, (t, r)) for t in (1, 2, 3, 4) for r in range(4)]
    for k in TWIG + OPEN_KEYS:
        d = P2.P[k]; rots = {"single": [0], "mirror": [0, 1], "unique4": [0, 1, 2, 3]}[d["art"]]
        for st in [None] + list(d.get("states", {})):
            jobs += [(job_main, (k, r, st)) for r in rots]
    from door_swing_lib import FRACS
    import door_swing_main as DM
    jobs += [(job_swing, (k, i, r)) for k in SWING_KEYS for i in range(len(FRACS)) for r in range(DM.OPENINGS[k][0])]
    with ProcessPoolExecutor(os.cpu_count()) as ex:
        R = dict(ex.map(_run, jobs, chunksize=1))
    clipped = [k for k, v in R.items() if any(c for _, c in v)]
    print("clipped:", clipped)
    assert not [k for k in clipped if k[0] in ("piece", "stairs")], clipped

    # ---- building_t1..t4
    for t in (1, 2, 3, 4):
        repl = {}
        for k in KEYS:
            for r, st, i in cells_of(SB[f"bld_{k}_t{t}"]["building"]["frames"][:PC.PIECES[k][3]]): repl[i] = R[("piece", t, k, r)][st][0]
        a = next(a for a in man["atlases"] if a["key"] == f"building_t{t}")
        pg = regrid(Image.open(BLD / a["image"]), a["columns"], a["rows"], repl); pg.save(BLD / a["image"], optimize=True)
        a["frameH"] = CH; print(a["key"], pg.size, len(repl), "cells re-built")
    # ---- building_tw (twig corners re-built; shaft hatch frames moved)
    a = next(a for a in man["atlases"] if a["key"] == "building_tw"); repl = {}
    for k in TW_KEYS:
        s = next(s for s in man["sprites"] if s.get("building", {}).get("piece") == k)
        for r, st, i in cells_of(s["building"]["frames"]): repl[i] = R[("piece", 0, k, r)][st][0]
    pg = regrid(Image.open(BLD / a["image"]), a["columns"], a["rows"], repl); pg.save(BLD / a["image"], optimize=True); a["frameH"] = CH
    print("building_tw", pg.size, len(repl), "cells re-built")
    # ---- building_fx crack overlay
    a = next(a for a in man["atlases"] if a["key"] == "building_fx")
    cp = Image.new("RGBA", (CW * 3, CH), (0, 0, 0, 0))
    for i, s in enumerate((1, 2, 3)): cp.paste(crack(s), (i * CW, 0))
    cp.save(BLD / a["image"], optimize=True); a["frameH"] = CH
    # ---- building_stairs (new stream page)
    sp = Image.new("RGBA", (CW * 16, CH * 4), (0, 0, 0, 0)); recs = []
    for t in (1, 2, 3, 4):
        base = (t - 1) * 16
        for r in range(4):
            for st in range(4): i = base + r * 4 + st; sp.paste(R[("stairs", t, r)][st][0], ((i % 16) * CW, (i // 16) * CH))
        fr = [[base + r * 4 + st for st in range(4)] for r in range(4)]
        recs.append({"key": f"bld_stairs_t{t}", "category": "building", "atlas": "building_stairs", "anchor": dict(ANCHOR),
                     "animations": {"idle": {"frames": [base], "fps": 1}},
                     "building": {"piece": f"stairs@tier{t}", "footprint": {"w": 1, "h": 1}, "layer": 1, "frames": fr, "crackOverlay": "bld_crack"},
                     "rotationArt": "unique4"})
    sp.save(BLD / "atlases/building_stairs.png", optimize=True)
    sa = {"key": "building_stairs", "image": "atlases/building_stairs.png", "frameW": CW, "frameH": CH, "columns": 16, "rows": 4,
          "residency": "stream", "ktx2": "atlases/building_stairs.ktx2"}
    man["atlases"] = [x for x in man["atlases"] if x["key"] != "building_stairs"]
    i_t4 = max(i for i, x in enumerate(man["atlases"]) if x["key"].startswith("building_t")); man["atlases"].insert(i_t4 + 1, sa)
    man["sprites"] = [s for s in man["sprites"] if not s["key"].startswith("bld_stairs_t")]
    last = max(i for i, s in enumerate(man["sprites"]) if s.get("atlas", "").startswith("building_t") and s["atlas"] != "building_tw")
    man["sprites"][last + 1:last + 1] = recs
    # ---- anchors: every sprite on the re-gridded pages
    regridded = {"building_t1", "building_t2", "building_t3", "building_t4", "building_tw", "building_fx", "building_stairs"}
    n = 0
    for s in man["sprites"]:
        if s.get("atlas") in regridded: s["anchor"] = dict(ANCHOR); n += 1
    print("anchors ->", ANCHOR, n, "sprites")
    (BLD / "manifest.building.json").write_text(json.dumps(man, indent=1) + "\n")
    # ---- main pack: twig set + openings in place (128x128, pivot (64,96))
    for akey, keys in (("buildings_twig", TWIG), ("openings", OPEN_KEYS)):
        a = next(a for a in pack["atlases"] if a["key"] == akey); cells = {}
        for k in keys:
            d = P2.P[k]; b = SM[k]["building"]; nrows = {"single": 1, "mirror": 2, "unique4": 4}[d["art"]]
            for st_name in [None] + list(d.get("states", {})):
                rows = b["frames"] if st_name is None else b["states"][st_name]
                for r, st, i in cells_of(rows[:nrows]): cells[i] = R[("main", k, r, st_name)][st][0]
        im = paste_cells(PACK / a["image"], cells, a["columns"], a["frameW"], a["frameH"]); im.save(PACK / a["image"], optimize=True)
        print(akey, len(cells), "cells re-built")
    # ---- door swing in-betweens in place
    a = next(a for a in man["atlases"] if a["key"] == "door_swing_openings"); cells = {}
    for k in SWING_KEYS:
        b = SB[f"{k}_swing"]["building"]; nrows = DM.OPENINGS[k][0]
        for i_f in range(len(FRACS)):
            for r, st, i in cells_of(b["states"][f"swing{i_f + 1}"][:nrows]): cells[i] = R[("swing", k, i_f, r)][st][0]
    im = paste_cells(BLD / a["image"], cells, a["columns"], a["frameW"], a["frameH"]); im.save(BLD / a["image"], optimize=True)
    print("door_swing_openings", len(cells), "cells re-built")
    import pickle
    pickle.dump({k: [im for im, _ in v] for k, v in R.items()}, open("/tmp/b80_frames.pkl", "wb"))


def _run(j):
    fn, a = j; return fn(a)


if __name__ == "__main__":
    main()
