"""Add-only door-swing (open/close animation) art for every `door: true` piece in packages/gameplay/data/pieces.json.

Run from repo root: python3 packages/assets/pack/building/src/add_door_swing.py
Then: (cd packages/assets && npx tsx scripts/write-lock-pack.ts) for the new sprite ids. KTX2 twins of the pages this
script writes are re-encoded here (toktx from PATH or /tmp/ktx/out/KTX-Software-*/bin).

What it writes (never moves or repaints a shipped frame; idempotent: re-running reuses its own indices):
  new atlases (residency stream), fully owned by this script:
    door_swing_openings  128x128 (pivot 64,96)  door_wood / door_metal / hatch_wood / window_shutters in-betweens, 1x
    door_swing_clan      160x256 (pivot 80,248) gate_clan / clan_hall_door in-betweens, 1x + tintmask
    door_swing_yard       72x120 (pivot 36,102) garden_gate picket / iron / rustic in-betweens, 1x + @2x + tintmask
  appended cells (drawn open endpoints for pieces that shipped closed-only):
    clan_structures_large  clan_hall_door open (2 rows x 4 damage), 1x/@2x + tintmask, after the last used frame
    decor_yard_t           garden_gate open per variant (2 rows), 1x/@2x + tintmask, after the last used frame
  sprites: `<base sprite>_swing` per door sprite: building.states swing1..swing4 ([rotation][damage] like every
    building sprite) + animations.swing (rotation-0 intact sequence with `rotations`, loop false); base sprites
    clan_hall_door / dec_garden_gate* gain states {closed, open} + animations closed/open (shaft_hatch pattern).
Open = closed (base sprite) -> swing1..swing4 -> open (base sprite state "open"); close = the same frames reversed.
"""
import json, os, pickle, subprocess, sys, tempfile, hashlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import door_swing_main as DM
from door_swing_lib import FRACS, STEPS

ROOT = HERE.parents[4]
PACK = ROOT / "packages/assets/pack"
BLD = PACK / "building"
PREVIEW = Path("/workspace/assets/preview/door_open.png")
OPEN_FPS, GATE_FPS = 16, 11   # ~62 ms / ~91 ms per frame over the 6-frame sequence

OPENINGS = ["door_wood", "door_metal", "hatch_wood", "window_shutters"]
GARDEN = ["picket", "iron", "rustic"]


def read(p): return json.loads(Path(p).read_text())
def write(p, d): Path(p).write_text(json.dumps(d, indent=1) + "\n")


def used_frames(man, atlas):
    fr = set()
    for s in man["sprites"]:
        if s["atlas"] != atlas: continue
        for a in s["animations"].values():
            fr |= set(a["frames"])
            for r in a.get("rotations", []): fr |= set(r)
        b = s.get("building", {})
        for r in b.get("frames", []): fr |= set(r)
        for rows in b.get("states", {}).values():
            for r in rows: fr |= set(r)
    return fr


def page(cells, cols, cw, ch, mode="RGBA"):
    rows = (max(cells) // cols + 1) if cells else 1
    im = Image.new(mode, (cols * cw, rows * ch))
    for i, c in cells.items(): im.paste(c, (i % cols * cw, i // cols * ch))
    assert max(im.size) <= 2048, im.size
    return im, rows


def paste_into(path, cells, cols, cw, ch):
    """add-only: grow the page to fit, paste cells at their indices, leave every other pixel as shipped."""
    old = Image.open(path); mode = old.mode
    need = max(old.height // ch, max(cells) // cols + 1)
    im = Image.new(mode, (old.width, need * ch)); im.paste(old, (0, 0))
    assert max(im.size) <= 2048, (path, im.size)
    for i, c in cells.items(): im.paste(c.convert(mode), (i % cols * cw, i // cols * ch))
    im.save(path, optimize=True); return need


def grid_rows(idx_of, rows_unique):
    """[rotation][damage] for 4 view rotations from 1/2/4 drawn rows (2 rows -> r0, r1, r0, r1 as the shipped art)."""
    rr = [[idx_of(r, st) for st in range(4)] for r in range(rows_unique)]
    return rr if rows_unique == 4 else (rr + rr if rows_unique == 2 else rr * 4)


def swing_sprite(key, atlas, anchor, base_b, piece, steps, rotart, fps):
    states = {f"swing{k}": steps[k - 1] for k in range(1, STEPS + 1)}
    rot_seq = [[steps[k][r][0] for k in range(STEPS)] for r in range(4)]
    b = {"piece": piece, "footprint": dict(base_b["footprint"]), "layer": base_b["layer"], "frames": steps[0], "states": states}
    if base_b.get("crackOverlay"): b["crackOverlay"] = base_b["crackOverlay"]
    return {"key": key, "category": "building", "atlas": atlas, "anchor": dict(anchor),
            "animations": {"idle": {"frames": [steps[0][0][0]], "fps": 1},
                           "swing": {"frames": rot_seq[0], "fps": fps, "loop": False, "rotations": rot_seq}},
            "building": b, "rotationArt": rotart}


def upsert(man, rec):
    for i, s in enumerate(man["sprites"]):
        if s["key"] == rec["key"]: man["sprites"][i] = rec; return
    man["sprites"].append(rec)


def upsert_atlas(man, rec):
    for i, a in enumerate(man["atlases"]):
        if a["key"] == rec["key"]: man["atlases"][i] = rec; return
    man["atlases"].append(rec)


def add_open_state(s, open_rows):
    b = s["building"]; closed = b.get("states", {}).get("closed", b["frames"])
    b["states"] = {"closed": closed, "open": open_rows}
    s["animations"] = {"idle": {"frames": [closed[0][0]], "fps": 1}, "closed": {"frames": [closed[0][0]], "fps": 1},
                       "open": {"frames": [open_rows[0][0]], "fps": 1}}


def toktx_env():
    env = dict(os.environ)
    import glob
    for d in glob.glob("/tmp/ktx/out/KTX-Software-*/bin"): env["PATH"] = d + ":" + env["PATH"]
    for d in glob.glob("/tmp/ktx/out/KTX-Software-*/lib"): env["LD_LIBRARY_PATH"] = d + ":" + env.get("LD_LIBRARY_PATH", "")
    return env


def encode(jobs):
    """ETC1S colour / UASTC linear tint masks with full mips, exactly as assets/tools/ktx2.py (dilated colour)."""
    sys.argv = ["ktx2.py"]
    sys.path.insert(0, str(ROOT / "assets/tools"))
    os.environ.update(toktx_env())
    import ktx2
    ktx2.force = True
    for src, mode in jobs:
        dst = os.path.splitext(src)[0] + ".ktx2"
        ktx2.enc((str(src), dst, mode, "linear" if mode == "uastc" else "srgb"))
        print("ktx2", os.path.relpath(dst, ROOT))


def main():
    pack = read(PACK / "manifest.json"); man = read(BLD / "manifest.building.json")
    base = {s["key"]: s for s in pack["sprites"]}; base.update({s["key"]: s for s in man["sprites"]})
    clip = []; newcells = {}   # (atlas, idx) -> image  (1x colour) for the uniqueness check

    # ---------------- openings in-betweens
    cells = {}; idx = 0; recs = []
    for key in OPENINGS:
        R = DM.OPENINGS[key][0]; start = idx; seq = []
        for k, f in enumerate(FRACS):
            for r in range(R):
                for st, im in enumerate(DM.render_opening(key, r, f)):
                    if DM.check_clip(im): clip.append((key, k + 1, r, st))
                    cells[idx] = im; idx += 1
        steps = [grid_rows(lambda r, st, k=k, s0=start: s0 + (k * R + r) * 4 + st, R) for k in range(STEPS)]
        bs = base[key]
        recs.append(swing_sprite(f"{key}_swing", "door_swing_openings", bs["anchor"], bs["building"], f"{key}_swing", steps, bs["rotationArt"], OPEN_FPS))
    pg, rows = page(cells, 16, 128, 128); pg.save(BLD / "atlases/door_swing_openings.png", optimize=True)
    upsert_atlas(man, {"key": "door_swing_openings", "image": "atlases/door_swing_openings.png", "frameW": 128, "frameH": 128,
                       "columns": 16, "rows": rows, "residency": "stream", "ktx2": "atlases/door_swing_openings.ktx2"})
    for r in recs: upsert(man, r)
    newcells.update({("door_swing_openings", i): c for i, c in cells.items()})
    print("door_swing_openings", len(cells), "cells", pg.size)

    # ---------------- garden gate: in-betweens (own atlas) + open endpoint (appended to decor_yard_t)
    g = {}
    for v in GARDEN:
        for r in range(2):
            for k, f in enumerate(FRACS + [1.0], 1):
                g[(v, k, r)] = DM.render_garden(v, r, f)
                if DM.check_clip(g[(v, k, r)][0]): clip.append(("garden_gate@" + v, k, r))
    c1, c2, m1, m2 = {}, {}, {}, {}; idx = 0; start_of = {}
    for v in GARDEN:
        start_of[v] = idx
        for k in range(1, STEPS + 1):
            for r in range(2):
                a, b, c, d = g[(v, k, r)]; c1[idx], c2[idx], m1[idx], m2[idx] = a, b, c, d; idx += 1
    for cs, cw, ch, name, mode in ((c1, 72, 120, "door_swing_yard.png", "RGBA"), (c2, 144, 240, "door_swing_yard@2x.png", "RGBA"),
                                   (m1, 72, 120, "door_swing_yard.tintmask.png", "RGB"), (m2, 144, 240, "door_swing_yard.tintmask@2x.png", "RGB")):
        pg, rows = page(cs, 12, cw, ch, mode); pg.save(BLD / "atlases" / name, optimize=True)
    upsert_atlas(man, {"key": "door_swing_yard", "image": "atlases/door_swing_yard.png", "frameW": 72, "frameH": 120, "columns": 12, "rows": rows,
                       "pages": [{"scale": 2, "image": "atlases/door_swing_yard@2x.png", "ktx2": "atlases/door_swing_yard@2x.ktx2",
                                  "masksKtx2": {"tintmask": "atlases/door_swing_yard.tintmask@2x.ktx2"}}],
                       "masks": {"tintmask": "atlases/door_swing_yard.tintmask.png"}, "residency": "stream", "placeholder": None,
                       "ktx2": "atlases/door_swing_yard.ktx2", "masksKtx2": {"tintmask": "atlases/door_swing_yard.tintmask.ktx2"}})
    newcells.update({("door_swing_yard", i): c for i, c in c1.items()})
    # open endpoints on decor_yard_t (reuse indices on re-run)
    yard = next(a for a in man["atlases"] if a["key"] == "decor_yard_t")
    prev = by_key(man, "dec_garden_gate__picket")["building"].get("states", {}).get("open")
    ystart = prev[0][0] if prev else max(used_frames(man, "decor_yard_t")) + 1
    o1, o2, om1, om2 = {}, {}, {}, {}; open_idx = {}
    for i, v in enumerate(GARDEN):
        for r in range(2):
            j = ystart + i * 2 + r; a, b, c, d = g[(v, STEPS + 1, r)]; o1[j], o2[j], om1[j], om2[j] = a, b, c, d
        open_idx[v] = ystart + i * 2
    for cs, cw, ch, name in ((o1, 72, 120, "decor_yard_t.png"), (o2, 144, 240, "decor_yard_t@2x.png"),
                             (om1, 72, 120, "decor_yard_t.tintmask.png"), (om2, 144, 240, "decor_yard_t.tintmask@2x.png")):
        rows = paste_into(BLD / "atlases" / name, cs, yard["columns"], cw, ch)
    yard["rows"] = rows
    newcells.update({("decor_yard_t", i): c for i, c in o1.items()})
    for skey, v in (("dec_garden_gate", "picket"), ("dec_garden_gate__picket", "picket"), ("dec_garden_gate__iron", "iron"), ("dec_garden_gate__rustic", "rustic")):
        s = by_key(man, skey); o = open_idx[v]
        add_open_state(s, [[o] * 4, [o + 1] * 4, [o] * 4, [o + 1] * 4])
        s0 = start_of[v]
        steps = [[[s0 + k * 2] * 4, [s0 + k * 2 + 1] * 4, [s0 + k * 2] * 4, [s0 + k * 2 + 1] * 4] for k in range(STEPS)]
        piece = s["building"]["piece"].replace("garden_gate", "garden_gate_swing")
        upsert(man, swing_sprite(skey + "_swing", "door_swing_yard", s["anchor"], s["building"], piece, steps, s["rotationArt"], OPEN_FPS))
    print("door_swing_yard", len(c1), "cells; decor_yard_t open", sorted(o1))

    # ---------------- clan gate + hall door (separate process: vendored pvp_clan toolkit)
    tmp = tempfile.mktemp(suffix=".pkl")
    subprocess.run([sys.executable, str(HERE / "door_swing_clan.py"), tmp], check=True)
    raw = pickle.load(open(tmp, "rb")); os.remove(tmp)
    C = {k: (Image.frombytes("RGBA", sz, a), Image.frombytes("RGB", sz, b)) for k, (a, b, sz) in raw.items()}
    for k, (col, _) in C.items():
        if k[4] == 1 and DM.check_clip(col): clip.append(k)
    c1, m1 = {}, {}; idx = 0
    for key in ("gate_clan", "clan_hall_door"):
        s0 = idx
        for k in range(1, STEPS + 1):
            for r in range(2):
                for st in range(4):
                    c1[idx], m1[idx] = C[(key, k, r, st, 1)]; idx += 1
        steps = [grid_rows(lambda r, st, k=k, s0=s0: s0 + (k * 2 + r) * 4 + st, 2) for k in range(STEPS)]
        bs = by_key(man, key)
        upsert(man, swing_sprite(f"{key}_swing", "door_swing_clan", bs["anchor"], bs["building"], f"{key}_swing", steps, bs["rotationArt"], GATE_FPS))
    for cs, name, mode in ((c1, "door_swing_clan.png", "RGBA"), (m1, "door_swing_clan_tintmask.png", "RGB")):
        pg, rows = page(cs, 12, 160, 256, mode); pg.save(BLD / "atlases" / name, optimize=True)
    upsert_atlas(man, {"key": "door_swing_clan", "image": "atlases/door_swing_clan.png", "frameW": 160, "frameH": 256, "columns": 12, "rows": rows,
                       "masks": {"tintmask": "atlases/door_swing_clan_tintmask.png"}, "residency": "stream",
                       "ktx2": "atlases/door_swing_clan.ktx2", "masksKtx2": {"tintmask": "atlases/door_swing_clan_tintmask.ktx2"}})
    newcells.update({("door_swing_clan", i): c for i, c in c1.items()})
    # hall door open endpoint appended to clan_structures_large (same r0/r1 interleave as the shipped rows)
    lg = next(a for a in man["atlases"] if a["key"] == "clan_structures_large"); hd = by_key(man, "clan_hall_door")
    prev = hd["building"].get("states", {}).get("open")
    hstart = prev[0][0] if prev else max(used_frames(man, "clan_structures_large")) + 1
    o1, o2, om1, om2 = {}, {}, {}, {}
    for st in range(4):
        for r in range(2):
            j = hstart + st * 2 + r
            o1[j], om1[j] = C[("clan_hall_door", STEPS + 1, r, st, 1)]; o2[j], om2[j] = C[("clan_hall_door", STEPS + 1, r, st, 2)]
    for cs, cw, ch, name in ((o1, 160, 256, "clan_structures_large.png"), (o2, 320, 512, "clan_structures_large@2x.png"),
                             (om1, 160, 256, "clan_structures_large_tintmask.png"), (om2, 320, 512, "clan_structures_large_tintmask@2x.png")):
        rows = paste_into(BLD / "atlases" / name, cs, lg["columns"], cw, ch)
    lg["rows"] = rows
    newcells.update({("clan_structures_large", i): c for i, c in o1.items()})
    orow = [[hstart + st * 2 for st in range(4)], [hstart + st * 2 + 1 for st in range(4)]]
    add_open_state(hd, orow + orow)
    print("door_swing_clan", len(c1), "cells; clan_structures_large open", sorted(o1))

    write(BLD / "manifest.building.json", man)
    print("clipped:", clip)
    assert not clip, clip
    unique_check(man, pack, newcells)
    preview(man, pack)
    if "--no-ktx" not in sys.argv:
        A = BLD / "atlases"
        encode([(A / "door_swing_openings.png", "etc1s"), (A / "door_swing_yard.png", "etc1s"), (A / "door_swing_yard@2x.png", "etc1s"),
                (A / "door_swing_yard.tintmask.png", "uastc"), (A / "door_swing_yard.tintmask@2x.png", "uastc"),
                (A / "door_swing_clan.png", "etc1s"), (A / "door_swing_clan_tintmask.png", "uastc"),
                (A / "decor_yard_t.png", "etc1s"), (A / "decor_yard_t@2x.png", "etc1s"), (A / "decor_yard_t.tintmask.png", "uastc"), (A / "decor_yard_t.tintmask@2x.png", "uastc"),
                (A / "clan_structures_large.png", "etc1s"), (A / "clan_structures_large@2x.png", "etc1s"),
                (A / "clan_structures_large_tintmask.png", "uastc"), (A / "clan_structures_large_tintmask@2x.png", "uastc")])


def by_key(man, k): return next(s for s in man["sprites"] if s["key"] == k)


def atlas_cells(path, fw, fh):
    im = Image.open(path).convert("RGBA"); out = []
    for y in range(0, im.height - fh + 1, fh):
        for x in range(0, im.width - fw + 1, fw): out.append(((x // fw) + (y // fh) * (im.width // fw), im.crop((x, y, x + fw, y + fh))))
    return out


def unique_check(man, pack, newcells):
    """every new cell: non-empty, pixel-different from every other new cell and from every shipped cell of the same size."""
    h = lambda im: hashlib.sha1(im.convert("RGBA").tobytes()).hexdigest()
    seen = {}
    for k, im in newcells.items():
        assert np.asarray(im)[..., 3].max() > 0, ("empty cell", k)
        d = h(im); assert d not in seen, ("duplicate new cells", k, seen[d]); seen[d] = k
    new_keys = set(newcells)
    n = 0
    for mf, root in ((man, BLD), (pack, PACK)):
        for a in mf["atlases"]:
            if (a["frameW"], a["frameH"]) not in {(128, 128), (160, 256), (72, 120)}: continue
            p = root / a["image"]
            if not p.exists(): continue
            for i, im in atlas_cells(p, a["frameW"], a["frameH"]):
                if (a["key"], i) in new_keys: continue
                if np.asarray(im)[..., 3].max() == 0: continue
                n += 1; assert h(im) not in seen, ("new cell duplicates shipped art", a["key"], i, seen[h(im)])
    print(f"uniqueness: {len(newcells)} new cells, all distinct, none equal to {n} shipped cells of the same size")


def cell(path, idx, cols, fw, fh):
    im = Image.open(path).convert("RGBA"); return im.crop((idx % cols * fw, idx // cols * fh, idx % cols * fw + fw, idx // cols * fh + fh))


def preview(man, pack):
    """closed -> swing1..4 -> open for every door sprite at rot 0 and rot 1."""
    A = {a["key"]: (a, BLD) for a in man["atlases"]}; A.update({a["key"]: (a, PACK) for a in pack["atlases"] if a["key"] not in A})
    S = {s["key"]: s for s in pack["sprites"]}; S.update({s["key"]: s for s in man["sprites"]})
    def get(skey, state, rot):
        s = S[skey]; a, root = A[s["atlas"]]; b = s["building"]
        rows = b["states"][state] if state in b.get("states", {}) else b["frames"]
        return cell(root / a["image"], rows[rot][0], a["columns"], a["frameW"], a["frameH"])
    rows = [("door_wood", (24, 20, 104, 108), 2), ("door_metal", (24, 20, 104, 108), 2), ("hatch_wood", (24, 40, 104, 108), 2),
            ("window_shutters", (24, 30, 104, 108), 2), ("gate_clan", (0, 70, 160, 256), 1), ("clan_hall_door", (0, 70, 160, 256), 1),
            ("dec_garden_gate__picket", (0, 30, 72, 120), 2), ("dec_garden_gate__iron", (0, 30, 72, 120), 2), ("dec_garden_gate__rustic", (0, 30, 72, 120), 2)]
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    tiles = []
    for skey, box, sc in rows:
        for rot in (0, 1):
            seq = [get(skey, "closed", rot)] + [get(skey + "_swing", f"swing{k}", rot) for k in range(1, STEPS + 1)] + [get(skey, "open", rot)]
            seq = [im.crop(box).resize(((box[2] - box[0]) * sc, (box[3] - box[1]) * sc), Image.NEAREST) for im in seq]
            tiles.append((f"{skey}  rot {rot}", seq))
    cw = max(im.width for _, s in tiles for im in s) + 8
    H = sum(s[0].height + 24 for _, s in tiles) + 40
    out = Image.new("RGB", (190 + cw * 6, H), "#292c35"); d = ImageDraw.Draw(out)
    d.text((14, 10), "SurVivaZ | door open: closed (shipped) -> swing1..4 (new) -> open (shipped; hall door + garden gates new). Close = reverse.", font=font, fill="#f6e6bf")
    labels = ["closed", "swing1", "swing2", "swing3", "swing4", "open"]
    y = 36
    for name, seq in tiles:
        d.text((14, y + seq[0].height // 2), name, font=font, fill="#f6e6bf")
        for j, im in enumerate(seq):
            x = 190 + j * cw
            d.rectangle([x - 2, y - 2, x + im.width + 1, y + im.height + 1], fill="#353946")
            out.paste(im, (x, y), im); d.text((x, y + im.height + 2), labels[j], font=font, fill="#a9a6b8")
        y += seq[0].height + 24
    PREVIEW.parent.mkdir(parents=True, exist_ok=True); out.save(PREVIEW); print(PREVIEW, out.size)


if __name__ == "__main__":
    main()
