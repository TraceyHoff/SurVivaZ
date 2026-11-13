#!/usr/bin/env python3
"""Add-only packer for dedicated ADR-386 waterfall tiles.

Unique art only (no reuse/recolor of gt_water frames). One looping set per shape:
lip, 1-level sheet, 2-level sheet, base pool. Unique pixels for the two iso facings
that truly differ (px = camera-front +x / lower-right; nx = far -x / upper-left).
py and ny are horizontal mirrors — the sprite renderer already supports flipX; the
keys are not duplicated. 6 seamless frames at 8 fps. Tight shelf-packed page,
trimmed rects + 2 px bleed, PNG + @2x + KTX2. Does not run ground_pack.py.

Usage (repo root, toktx on PATH):
  python3 packages/assets/pack/nature/src/artpass_waterfall.py
Then: pnpm --filter @engine/assets lock:ids:pack
"""
from __future__ import annotations
import hashlib, json, os, sys, subprocess, tempfile
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "assets/tools"))
from ground_core import vn, vn1, fbm, hx  # noqa: E402
from ktx2 import dilate  # noqa: E402

PACK = os.path.join(ROOT, "packages/assets/pack")
ATLAS_DIR = os.path.join(PACK, "atlases")
MAN = os.path.join(PACK, "manifest.json")
PREV = "/workspace/assets/preview"
PAGE_KEY = "gt_waterfall"
NF, FPS = 6, 8
PAD = 2  # 1x bleed around each trimmed frame and the page edge
# Diamond centre in the 64x64 (1x) paint box — same as a 68x52 ground cell after its 2 px pad is stripped.
CX, CY = 32, 16
FW, HW, HH = 64, 32, 16
RES = 8
AH = 64  # paint height at 1x: 32 px diamond + 32 px (2-level) skirt

# Waterfall palette: same teal family as gt_water (WCOL) but its own tones and marks
# (elongated downward streaks, foam rolls, mist) — not a recolor of the lake ripples.
P = {
    "deep": "#1a628f",
    "trough": "#1f74a6",
    "mid": "#2b8fc0",
    "lite": "#45b3d6",
    "streak": "#8ee6f0",
    "shine": "#f3fffd",
    "foam": "#f7ffff",
    "foam_sh": "#c8eef2",
    "mist": "#dff4f8",
    "mist2": "#f5ffff",
}
SOLID = [P[k] for k in ("deep", "trough", "mid", "lite", "streak", "shine", "foam", "foam_sh")]
MISTC = [P["mist"], P["mist2"]]

# (key, kind, facing, levels_or_none) — unique art only
SHAPES = [
    ("gt_waterfall_lip_px", "lip", "px", None),
    ("gt_waterfall_lip_nx", "lip", "nx", None),
    ("gt_waterfall_sheet_1_px", "sheet", "px", 1),
    ("gt_waterfall_sheet_1_nx", "sheet", "nx", 1),
    ("gt_waterfall_sheet_2_px", "sheet", "px", 2),
    ("gt_waterfall_sheet_2_nx", "sheet", "nx", 2),
    ("gt_waterfall_pool_px", "pool", "px", None),
    ("gt_waterfall_pool_nx", "pool", "nx", None),
]
# Engine flip map (not packed): py = flipX(px), ny = flipX(nx)
FLIP = {
    "gt_waterfall_lip_py": "gt_waterfall_lip_px",
    "gt_waterfall_lip_ny": "gt_waterfall_lip_nx",
    "gt_waterfall_sheet_1_py": "gt_waterfall_sheet_1_px",
    "gt_waterfall_sheet_1_ny": "gt_waterfall_sheet_1_nx",
    "gt_waterfall_sheet_2_py": "gt_waterfall_sheet_2_px",
    "gt_waterfall_sheet_2_ny": "gt_waterfall_sheet_2_nx",
    "gt_waterfall_pool_py": "gt_waterfall_pool_px",
    "gt_waterfall_pool_ny": "gt_waterfall_pool_nx",
}

# ---- geometry at RES in the 64x64 1x paint box ------------------------------------------------
_ys, _xs = np.mgrid[0:AH * RES, 0:FW * RES].astype(np.float64)
SX = (_xs + .5) / RES - HW
SY = (_ys + .5) / RES - HH
U = (SX / HW + SY / HH) / 2 + .5
V = (SY / HH - SX / HW) / 2 + .5
TOP = (np.abs(SX) / HW + np.abs(SY) / HH) <= 1 + 0.6 / HH


def face(facing: str, sk: float):
    """Parallelogram of one iso cliff face extruded `sk` px down from the diamond edge. Returns mask, along [0,1], depth px."""
    if facing == "px":
        # +x / lower-right: edge E(u=1,v=0) -> S(u=1,v=1)
        along = np.clip(1 - SX / HW, 0, 1)
        depth = SY - (HH - SX / 2)
        m = (SX >= 0) & (SX <= HW) & (depth > -0.6) & (depth <= sk)
    else:
        # -x / upper-left (far): edge N(u=0,v=0) -> W(u=0,v=1)
        along = np.clip(-SX / HW, 0, 1)
        depth = SY + HH + SX / 2
        m = (SX <= 0) & (SX >= -HW) & (depth > -0.6) & (depth <= sk)
    return m, along, np.clip(depth, 0, sk)


def _snap_rgb(rgb, pal):
    P = np.array([hx(c) for c in pal], np.float32)
    idx = ((rgb[..., None, :].astype(np.float32) - P[None, None]) ** 2).sum(-1).argmin(-1)
    return P[idx].astype(np.uint8)


def downs(rgb, a_solid, a_mist, f, pal_solid=SOLID):
    """Box-down by f. Solid cel snaps to the waterfall palette with binary alpha; mist keeps soft alpha."""
    h, w = rgb.shape[0] // f, rgb.shape[1] // f
    def box(arr):
        return arr.reshape(h, f, w, f, *arr.shape[2:]).mean((1, 3))
    a_s = box(a_solid.astype(np.float32))
    a_m = box(a_mist.astype(np.float32))
    pre = rgb.astype(np.float32) * np.clip(a_solid.astype(np.float32) + a_mist, 0, 1)[..., None]
    col = box(pre) / np.maximum(box(np.clip(a_solid.astype(np.float32) + a_mist, 0, 1))[..., None], 1e-6)
    out = np.zeros((h, w, 4), np.uint8)
    solid = a_s >= 0.5
    out[solid, :3] = _snap_rgb(col, pal_solid)[solid]
    out[solid, 3] = 255
    # mist in the remaining (or lightly on top of empty) pixels
    mist = (~solid) & (a_m > 0.04)
    if mist.any():
        out[mist, :3] = _snap_rgb(col, MISTC + ["#ffffff"])[mist]
        out[mist, 3] = np.clip(a_m[mist] * 255, 0, 220).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


class Buf:
    def __init__(self):
        self.rgb = np.zeros((AH * RES, FW * RES, 3), np.uint8)
        self.solid = np.zeros((AH * RES, FW * RES), bool)
        self.mist = np.zeros((AH * RES, FW * RES), np.float32)

    def fill(self, m, col):
        self.rgb[m] = hx(col)
        self.solid |= m
        self.mist[m] = 0  # solid covers mist

    def add_mist(self, m, amt, col=None):
        if col is not None:
            # only write colour where we don't already have solid art
            empty = m & ~self.solid
            self.rgb[empty] = hx(col)
        self.mist = np.clip(np.maximum(self.mist, m.astype(np.float32) * amt) * (~self.solid), 0, 1)

    def finish(self):
        return downs(self.rgb, self.solid, self.mist, RES), downs(self.rgb, self.solid, self.mist, RES // 2)


# ---- painters ---------------------------------------------------------------------------------
def _streak_field(along, depth, ph, seed):
    """Seamless downward field: period 16 px in depth and period 1 in ph (one loop).

    Structure is vertical (varies with `along`) so the face reads as a falling curtain;
    brightness rides `scroll` so the curtain flows down and wraps.
    """
    scroll = depth / 16.0 + ph
    col = vn1(along, 8, seed)
    wob = (vn1(along, 7, seed + 3) - .5) * .16
    flow = np.sin((scroll * 2 + along * .35 + wob) * 2 * np.pi)
    flow2 = np.sin((scroll * 4 + col) * 2 * np.pi + 0.7)
    return 0.5 + 0.28 * (col - .5) + 0.22 * flow + 0.12 * flow2, scroll


def paint_sheet(facing, levels, frame):
    b = Buf()
    sk = 16 * levels
    m, along, depth = face(facing, sk)
    ph = frame / NF
    field, scroll = _streak_field(along, depth, ph, seed=8100 + levels * 13 + (0 if facing == "px" else 29))
    # cel bands
    b.fill(m, P["mid"])
    b.fill(m & (field < .40), P["trough"])
    b.fill(m & (field < .28), P["deep"])
    b.fill(m & (field > .62), P["lite"])
    # hard shade along the outer edge of the parallelogram, highlight on the inner
    if facing == "px":
        outer, inner = along < .22, along > .78
    else:
        outer, inner = along < .22, along > .78
    b.fill(m & outer & (field < .7), P["deep"])
    b.fill(m & inner & (field > .5), P["lite"])
    # vertical streak columns, slightly sinuous with downward flow (integer frequencies => seamless)
    n_st = 6 + levels  # a few more columns on the taller sheet
    wavy = along * n_st + 0.18 * np.sin((scroll * 2 + along) * 2 * np.pi) + vn1(along, 5, 9310) * .2
    thin = np.abs((wavy % 1.0) - .5) < (0.10 + 0.03 * (field - .4))
    b.fill(m & thin & (field > .38), P["streak"])
    # brighter core in the middle of the strongest columns, sliding down
    core = thin & (np.abs((wavy % 1.0) - .5) < 0.04) & (field > .5) & (np.sin((scroll * 3) * 2 * np.pi) > 0)
    b.fill(m & core, P["shine"])
    # sparse sparkles riding the cores
    spark = (np.abs(vn1((scroll * 2 + along * 9) % 1.0, 13, 9420) - .5) < .03) & (field > .55) & thin
    b.fill(m & spark, P["shine"])
    # a few foam dashes riding the fall (not a foam cap)
    foam = (vn1((scroll + along * 2.4) % 1.0, 9, 9500 + levels) > .88) & thin & (field > .45)
    b.fill(m & foam, P["foam"])
    b.fill(m & foam & (vn1(along, 8, 9511) > .55), P["foam_sh"])
    # thin foam thread at the rim only (the lip tile carries the curl)
    rim = m & (depth < (1.15 + .35 * np.sin((along * 5 + ph * 2 * np.pi))))
    b.fill(rim, P["foam_sh"])
    b.fill(rim & (depth < 0.7), P["foam"])
    # soft mist wisps in the skirt, looping (rise = scroll wraps)
    if levels >= 1:
        # a couple of soft blobs whose centres travel down
        for i, (ao, bo) in enumerate(((0.28, 0.15), (0.62, 0.55), (0.45, 0.0))):
            cy = ((bo + ph) % 1.0) * sk
            cx = ao + 0.04 * np.sin((ph + i) * 2 * np.pi)
            r = 3.2 + (i % 2)
            # distance in (along * face-width-ish, depth) — along is 0-1 over ~32 px
            d2 = ((along - cx) * 28) ** 2 + ((depth - cy) * 1.0) ** 2
            wisp = m & (d2 < (r * 3.2) ** 2)
            amt = np.clip(1 - np.sqrt(d2) / (r * 3.2), 0, 1) ** 1.4 * 0.45
            b.add_mist(wisp, amt, P["mist"] if i % 2 == 0 else P["mist2"])
    return b.finish()


def paint_lip(facing, frame):
    b = Buf()
    ph = frame / NF
    # edge coordinate and inward distance on the diamond
    if facing == "px":
        along, inward, edge = V, 1 - U, (U > 0.55) & TOP
    else:
        along, inward, edge = V, U, (U < 0.45) & TOP
    wob = (fbm(along, np.full_like(along, ph), 7700, ((5, .6), (11, .4))) - .5) * .04
    lap = 0.11 + 0.025 * np.sin(2 * np.pi * ph + along * 6.2) + wob
    band = edge & (inward < lap + 0.05)
    # curl: teal fold, lite roll, a thin foam lip — not a white cap
    b.fill(band, P["mid"])
    b.fill(band & (inward < lap * 0.85), P["lite"])
    b.fill(band & (inward < lap * 0.50), P["streak"])
    foam = band & (inward < lap * 0.22 + 0.015 * np.sin(2 * np.pi * (ph * 2 + along * 8)))
    b.fill(foam, P["foam"])
    # highlight roll along the crest of the fold
    crest = band & (np.abs(inward - lap * 0.45) < 0.025) & (vn1((along + ph) % 1.0, 10, 7800) > .3)
    b.fill(crest, P["shine"])
    # darker trough just inside the curl (the water folding over the ledge)
    trough = edge & (inward > lap * 0.88) & (inward < lap + 0.045)
    b.fill(trough, P["trough"])
    # tiny droplets just past the edge, looping around the lip
    for i in range(4):
        a0 = (i / 4 + ph * 0.15) % 1.0
        drop = edge & (np.abs(((along - a0 + 0.5) % 1.0) - 0.5) < 0.03) & (inward < 0.05)
        b.fill(drop & (inward < 0.03), P["foam"])
    # a little mist just over the lip (toward the drop)
    mist_m = edge & (inward < lap * 0.5)
    # also a faint puff off the edge: for px, slightly into the sheet / outside the diamond
    if facing == "px":
        off = (~TOP) & (U > 0.85) & (V > 0.05) & (V < 0.95) & (SY > 0) & (SY < 10)
    else:
        off = (~TOP) & (U < 0.15) & (V > 0.05) & (V < 0.95) & (SY > -14) & (SY < 6)
    rise = 0.35 + 0.2 * np.sin(2 * np.pi * ph + along * 4)
    b.add_mist(mist_m, 0.22 * (1 - inward / np.maximum(lap, 1e-3)), P["mist"])
    b.add_mist(off, 0.28 * rise, P["mist2"])
    return b.finish()


def paint_pool(facing, frame):
    b = Buf()
    ph = frame / NF
    # unique agitated surface — radial from the impact edge, not the lake fbm
    if facing == "px":
        # splash of a PX fall lands on the dest's -x (NW) edge
        impact, along, dist = (U < 0.55) & TOP, V, U
    else:
        impact, along, dist = (U > 0.45) & TOP, V, 1 - U
    # base agitated water across the diamond (dedicated swirl, different seed/shape than gt_water)
    swirl = fbm(U * 1.1 + 0.25 * np.sin(2 * np.pi * ph), V * 1.1 - ph * 0.0, 6100, ((4, .5), (9, .3), (16, .2)))
    # bias brighter toward the impact, calmer opposite
    swirl = swirl + 0.08 * (1 - np.clip(dist, 0, 1))
    # expanding rings from the impact edge, period 1 in ph
    ring = np.abs(((dist * 3.2 - ph) % 1.0) - .5)
    b.fill(TOP, P["mid"])
    b.fill(TOP & (swirl < .40), P["trough"])
    b.fill(TOP & (swirl < .28), P["deep"])
    b.fill(TOP & (swirl > .62), P["lite"])
    b.fill(TOP & (ring < .06) & (dist < 0.7) & (swirl > .4), P["streak"])
    # foam shelf along the impact
    wob = (vn1(along, 8, 6200) - .5) * .03
    shelf = TOP & (dist < 0.10 + 0.025 * np.sin(2 * np.pi * ph + along * 7) + wob)
    b.fill(shelf, P["foam_sh"])
    b.fill(shelf & (dist < 0.055 + 0.02 * np.sin(2 * np.pi * (ph * 2 + along * 5))), P["foam"])
    # bouncing foam blobs along the impact, looping
    for i in range(5):
        a0 = (i + 0.5) / 5
        bounce = 0.03 + 0.025 * abs(np.sin(np.pi * ((ph + i * 0.2) % 1.0)))
        blob = TOP & ((along - a0) ** 2 * 28 + (dist - bounce) ** 2 * 70 < 0.055)
        b.fill(blob, P["foam"])
        b.fill(blob & (dist < bounce * 0.55), P["shine"])
    # sparkles on the roil
    sp = TOP & (vn1((U * 8 + ph) % 1.0, 17, 6300) > .92) & (vn1((V * 8 - ph * 0.5) % 1.0, 15, 6310) > .7)
    b.fill(sp & (swirl > .5), P["shine"])
    # soft mist rising from the impact, looping: puffs travel "up" (smaller screen y) and wrap
    for i in range(4):
        a0 = (i + 0.25) / 4
        life = (ph + i * 0.25) % 1.0
        # start at the impact, drift toward the far side / up
        if facing == "px":
            # NW edge: screen toward top-left
            px = (0.08 + along * 0)  # will use uv near U=0, V=a0
            cu, cv = 0.06 + 0.04 * life, a0 + 0.04 * np.sin(life * 2 * np.pi)
        else:
            cu, cv = 0.94 - 0.04 * life, a0 + 0.04 * np.sin(life * 2 * np.pi)
        # also lift in screen y: subtract from SY
        lift = life * 10  # px at 1x
        d2 = ((U - cu) * 32) ** 2 + ((V - cv) * 32) ** 2 + 0  # uv ellipse
        # shift the sample in screen space by lift: compare against SY + lift
        # approximate: a uv circle plus a screen-y lift by moving the centre up
        sx_c = (cu - cv) * HW
        sy_c = (cu + cv - 1) * HH - lift
        d2 = (SX - sx_c) ** 2 + (SY - sy_c) ** 2
        r = 6.5 + 2.5 * life
        amt = np.clip(1 - np.sqrt(d2) / r, 0, 1) ** 1.2 * (np.sin(np.pi * life) * 0.72)
        wisp = d2 < (r * 1.05) ** 2
        b.add_mist(wisp, amt, P["mist"] if i % 2 == 0 else P["mist2"])
    return b.finish()


def render(kind, facing, levels, frame):
    if kind == "sheet":
        return paint_sheet(facing, levels, frame)
    if kind == "lip":
        return paint_lip(facing, frame)
    return paint_pool(facing, frame)


def trim(im1: Image.Image, im2: Image.Image):
    a = np.asarray(im1)
    ys, xs = np.where(a[..., 3] > 0)
    if len(xs) == 0:
        raise SystemExit("empty frame")
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    tx0, ty0, tx1, ty1 = x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD
    w, h = tx1 - tx0, ty1 - ty0
    o1 = Image.new("RGBA", (w, h), (0, 0, 0, 0)); o1.paste(im1, (-tx0, -ty0))
    o2 = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0)); o2.paste(im2, (-tx0 * 2, -ty0 * 2))
    anc = (round((CX - tx0) / w, 6), round((CY - ty0) / h, 6))
    return o1, o2, anc


def shelf(sizes, max_w=1024, pad=PAD):
    """Tight row pack, shortest page that fits. sizes: (w,h) at 1x. Returns places (x,y), page W,H."""
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0]))
    # try a few max widths and pick the smallest area whose W,H <= 1024
    cands = []
    for cap in (256, 320, 384, 448, 512, 640, 768, 1024):
        if cap > max_w:
            continue
        x = pad
        y = pad
        row_h = 0
        place = [None] * len(sizes)
        started = False
        for i in order:
            w, h = sizes[i]
            if started and x + w + pad > cap:
                y += row_h + pad
                x = pad
                row_h = 0
            place[i] = (x, y)
            x += w + pad
            row_h = max(row_h, h)
            started = True
        pw = max(place[i][0] + sizes[i][0] for i in range(len(sizes))) + pad
        ph = y + row_h + pad
        # 4-px align for ETC
        pw = (pw + 3) & ~3
        ph = (ph + 3) & ~3
        if pw <= max_w and ph <= max_w:
            cands.append((pw * ph, pw, ph, place, cap))
    if not cands:
        raise SystemExit("cannot pack within 1024")
    cands.sort()
    _, pw, ph, place, _ = cands[0]
    return place, pw, ph


def sha(im: Image.Image) -> str:
    a = np.asarray(im)
    return hashlib.sha1(a.tobytes()).hexdigest()


def pack_and_write(frames):
    """frames: list of dicts {key, fi, im1, im2, anc}. Returns atlases, sprites, hashes."""
    sizes = [(d["im1"].size[0], d["im1"].size[1]) for d in frames]
    place, pw, ph = shelf(sizes)
    print(f"page {pw}x{ph} cells {len(frames)} fill {sum(w*h for w,h in sizes)/(pw*ph):.3f}", flush=True)
    page1 = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    page2 = Image.new("RGBA", (pw * 2, ph * 2), (0, 0, 0, 0))
    for d, (x, y) in zip(frames, place):
        page1.paste(d["im1"], (x, y), d["im1"])
        page2.paste(d["im2"], (x * 2, y * 2), d["im2"])
        d["rect"] = {"x": x, "y": y, "w": d["im1"].size[0], "h": d["im1"].size[1]}
    page1 = dilate(page1)
    page2 = dilate(page2)
    p1 = os.path.join(ATLAS_DIR, f"{PAGE_KEY}.png")
    p2 = os.path.join(ATLAS_DIR, f"{PAGE_KEY}@2x.png")
    page1.save(p1, optimize=True)
    page2.save(p2, optimize=True)
    atlases = [{
        "key": PAGE_KEY,
        "image": f"atlases/{PAGE_KEY}.png",
        "frameW": pw, "frameH": ph, "columns": 1, "rows": 1,
        "pages": [{"scale": 2, "image": f"atlases/{PAGE_KEY}@2x.png"}],
    }]
    # KTX2 for this page only
    enc = os.path.join(PACK, "manifest.waterfall-encode.json")
    try:
        json.dump({"atlases": atlases}, open(enc, "w"))
        env = os.environ.copy()
        # toktx may live in a known local prefix
        extra = "/tmp/ktx/out/KTX-Software-4.4.2-Linux-x86_64/bin"
        env["PATH"] = extra + os.pathsep + env.get("PATH", "")
        subprocess.run([sys.executable, os.path.join(ROOT, "assets/tools/ktx2.py"), os.path.basename(enc)],
                       cwd=PACK, check=True, env=env)
        atlases = json.load(open(enc))["atlases"]
    finally:
        if os.path.exists(enc):
            os.remove(enc)
    # sprites
    by_key: dict[str, list] = {}
    for d in frames:
        by_key.setdefault(d["key"], []).append(d)
    sprites = []
    hashes = {}
    for key, kind, facing, levels in SHAPES:
        group = sorted(by_key[key], key=lambda d: d["fi"])
        df = []
        for d in group:
            df.append({"atlas": PAGE_KEY, "frame": 0, "rect": d["rect"], "anchor": {"x": d["anc"][0], "y": d["anc"][1]}})
            hashes[f"{key}:{d['fi']}"] = sha(d["im1"])
        sprites.append({
            "key": key,
            "category": "tile",
            "atlas": PAGE_KEY,
            "anchor": {"x": 0.5, "y": 0.346154},
            "placeholder": "gt_water" if kind != "sheet" else "gt_water",
            "animations": {"idle": {"frames": list(range(NF)), "fps": FPS, "loop": True, "directions": 1, "dirFrames": df}},
        })
    return atlases, sprites, hashes, page1, page2, place, (pw, ph)


def merge_manifest(atlases, sprites):
    m = json.load(open(MAN))
    m["atlases"] = [a for a in m["atlases"] if a["key"] != PAGE_KEY]
    m["sprites"] = [s for s in m["sprites"] if not str(s.get("key", "")).startswith("gt_waterfall_")]
    # insert after the last gt_ atlas / sprite so ground stays grouped
    ia = max((i for i, a in enumerate(m["atlases"]) if str(a["key"]).startswith("gt_")), default=len(m["atlases"]) - 1) + 1
    m["atlases"][ia:ia] = atlases
    isp = max((i for i, s in enumerate(m["sprites"]) if str(s.get("key", "")).startswith("gt_")), default=len(m["sprites"]) - 1) + 1
    m["sprites"][isp:isp] = sprites
    open(MAN, "w").write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")


def existing_water_hashes():
    m = json.load(open(MAN))
    a = next(x for x in m["atlases"] if x["key"] == "gt_summer_p0")
    im = Image.open(os.path.join(ATLAS_DIR, os.path.basename(a["image"])))
    fw, fh, cols = a["frameW"], a["frameH"], a["columns"]
    out = set()
    for idx in range(42, 50):  # gt_water + gt_water_shallow
        x, y = (idx % cols) * fw, (idx // cols) * fh
        out.add(sha(im.crop((x, y, x + fw, y + fh))))
    return out


def preview(frames, path_png, path_gif):
    """Mock lake-to-sea scene: 2-level PX drop, then 1-level PX, then 1-level PY (flip)."""
    m = json.load(open(MAN))
    a = next(x for x in m["atlases"] if x["key"] == "gt_summer_p0")
    sheet = Image.open(os.path.join(ATLAS_DIR, os.path.basename(a["image"]))).convert("RGBA")
    fw, fh, cols = a["frameW"], a["frameH"], a["columns"]

    def cell(idx):
        x, y = (idx % cols) * fw, (idx // cols) * fh
        return sheet.crop((x, y, x + fw, y + fh))

    grass = [cell(i) for i in range(0, 6)]
    dirt = [cell(i) for i in range(6, 12)]
    water = [cell(i) for i in range(42, 46)]
    shallow = [cell(i) for i in range(46, 50)]
    # our frames by key,fi
    ours = {}
    for d in frames:
        ours[(d["key"], d["fi"])] = d

    def flip_im(im):
        return im.transpose(Image.FLIP_LEFT_RIGHT)

    def blit_ground(dst, im, sx, sy):
        # 68x52, anchor (34, 18)
        dst.alpha_composite(im, (int(round(sx - 34)), int(round(sy - 18))))

    def blit_ours(dst, key, fi, sx, sy, flip=False):
        d = ours[(key, fi)]
        im = flip_im(d["im1"]) if flip else d["im1"]
        ax, ay = d["anc"]
        if flip:
            ax = 1 - ax
        w, h = im.size
        dst.alpha_composite(im, (int(round(sx - ax * w)), int(round(sy - ay * h))))

    def iso(tx, ty, z):
        return (tx - ty) * 32, (tx + ty) * 16 - z * 16

    # One surface per (tx, ty). Lake z=5; 2-level PX fall to z=3; 1-level PX to z=2;
    # 1-level PY (flip of px) to z=1; sea z=0. Banks sit at the neighbour water height.
    lake = {(0, 0), (1, 0), (0, 1), (1, 1)}
    land = []
    for x in range(-1, 2):
        for y in range(-1, 2):
            land.append((x, y, 5, "water" if (x, y) in lake else "grass"))
    # (1,1) is the spill tile (still lake water at z=5); shore on the remaining lake-level neighbours
    land += [(0, 2, 5, "grass"), (-1, 2, 5, "grass"), (2, -1, 5, "grass"), (1, 2, 5, "grass")]
    # mid terrace — water at (2,1) z=3, banks at z=3 (do not also place z=5 grass on these xy)
    land += [(2, 1, 3, "water"), (2, 0, 3, "grass"), (2, 2, 3, "grass"), (3, 0, 3, "grass")]
    # 1-level PX step
    land += [(3, 1, 2, "water"), (4, 1, 2, "grass"), (4, 0, 2, "grass")]
    # 1-level PY step
    land += [(3, 2, 1, "water"), (4, 2, 1, "grass")]
    # sea
    land += [(3, 3, 0, "shallow"), (4, 3, 0, "shallow"), (2, 3, 0, "shallow"), (5, 3, 0, "shallow"),
             (5, 2, 0, "grass"), (3, 4, 0, "grass"), (4, 4, 0, "grass"), (2, 4, 0, "grass"), (5, 4, 0, "grass")]
    tiles = {}
    for t in land:
        key = (t[0], t[1])
        if key in tiles:
            raise SystemExit(f"preview tile collision {key}: {tiles[key]} vs {t}")
        tiles[key] = t
    # Falls:
    # lip+sheet2 on (1,1) z=5 toward +x; pool on (2,1) z=3
    # lip+sheet1 on (2,1) z=3 toward +x; pool on (3,1) z=2
    # lip+sheet1 on (3,1) z=2 toward +y (flip of px); pool on (3,2) z=1 (flip)

    # canvas bounds
    pts = [iso(t[0], t[1], t[2]) for t in tiles.values()]
    minx = min(p[0] for p in pts) - 50
    maxx = max(p[0] for p in pts) + 50
    miny = min(p[1] for p in pts) - 40
    maxy = max(p[1] for p in pts) + 70
    W, H = int(maxx - minx), int(maxy - miny)
    # sky-ish background
    bg = (186, 224, 236, 255)

    def draw_frame(fi):
        dst = Image.new("RGBA", (W, H), bg)
        # painter's: back to front by (tx+ty), then ty, then z (low first so taller tops win? 
        # actually draw low first, then higher? No: a higher tile further back should be drawn first.
        # Sort by (tx+ty) then tx. For same tile stack, draw low z first then high? They're offset.
        # Draw all by iso key; for same (tx,ty) draw low z first.
        items = sorted(tiles.values(), key=lambda t: (t[0] + t[1], t[0], t[2]))
        wf = fi % 4  # lake water 4 frames
        for tx, ty, z, kind in items:
            sx, sy = iso(tx, ty, z)
            sx, sy = sx - minx, sy - miny
            var = (tx * 3 + ty * 7) % 6
            if kind == "grass":
                blit_ground(dst, grass[var], sx, sy)
            elif kind == "dirt":
                blit_ground(dst, dirt[var % 6], sx, sy)
            elif kind == "water":
                blit_ground(dst, water[wf], sx, sy)
            else:
                blit_ground(dst, shallow[wf], sx, sy)
            # pools on destination tiles (under the arriving sheet's foot)
            if (tx, ty, z) == (2, 1, 3):
                blit_ours(dst, "gt_waterfall_pool_px", fi, sx, sy)
            if (tx, ty, z) == (3, 1, 2):
                blit_ours(dst, "gt_waterfall_pool_px", fi, sx, sy)
            if (tx, ty, z) == (3, 2, 1):
                blit_ours(dst, "gt_waterfall_pool_px", fi, sx, sy, flip=True)
            if (tx, ty, z) == (3, 3, 0):
                blit_ours(dst, "gt_waterfall_pool_px", fi, sx, sy, flip=True)
            # lips + sheets on source tiles
            if (tx, ty, z) == (1, 1, 5):
                blit_ours(dst, "gt_waterfall_lip_px", fi, sx, sy)
                blit_ours(dst, "gt_waterfall_sheet_2_px", fi, sx, sy)
            if (tx, ty, z) == (2, 1, 3):
                blit_ours(dst, "gt_waterfall_lip_px", fi, sx, sy)
                blit_ours(dst, "gt_waterfall_sheet_1_px", fi, sx, sy)
            if (tx, ty, z) == (3, 1, 2):
                blit_ours(dst, "gt_waterfall_lip_px", fi, sx, sy, flip=True)
                blit_ours(dst, "gt_waterfall_sheet_1_px", fi, sx, sy, flip=True)
            if (tx, ty, z) == (3, 2, 1):
                blit_ours(dst, "gt_waterfall_lip_px", fi, sx, sy, flip=True)
                blit_ours(dst, "gt_waterfall_sheet_1_px", fi, sx, sy, flip=True)
        return dst

    frames_im = [draw_frame(i) for i in range(NF)]
    # scale 3x nearest for readable cel pixels
    sc = 3
    big = [im.resize((W * sc, H * sc), Image.Resampling.NEAREST) for im in frames_im]
    # still frame: mid loop
    os.makedirs(PREV, exist_ok=True)
    big[2].save(path_png, optimize=True)
    big[0].save(path_gif, save_all=True, append_images=big[1:], duration=int(1000 / FPS), loop=0, disposal=2, optimize=True)
    print("preview", path_png, os.path.getsize(path_png), path_gif, os.path.getsize(path_gif))


def contact_sheet(frames, path):
    # one row per shape, 6 frames
    by = {}
    for d in frames:
        by.setdefault(d["key"], []).append(d)
    rows = []
    pad = 4
    for key, *_ in SHAPES:
        group = sorted(by[key], key=lambda d: d["fi"])
        h = max(d["im1"].size[1] for d in group)
        w = sum(d["im1"].size[0] for d in group) + pad * (len(group) + 1)
        row = Image.new("RGBA", (w, h + pad * 2), (30, 40, 50, 255))
        x = pad
        for d in group:
            row.paste(d["im1"], (x, pad + (h - d["im1"].size[1])), d["im1"])
            x += d["im1"].size[0] + pad
        rows.append(row)
    W = max(r.size[0] for r in rows)
    H = sum(r.size[1] for r in rows)
    out = Image.new("RGBA", (W, H), (30, 40, 50, 255))
    y = 0
    for r in rows:
        out.paste(r, (0, y))
        y += r.size[1]
    out.save(path)
    print("contact", path, out.size)


def main():
    print("render", len(SHAPES), "sprites x", NF, "frames", flush=True)
    frames = []
    seen = {}
    for key, kind, facing, levels in SHAPES:
        for fi in range(NF):
            im1, im2 = render(kind, facing, levels, fi)
            im1, im2, anc = trim(im1, im2)
            h = sha(im1)
            if h in seen:
                raise SystemExit(f"duplicate pixels {key}:{fi} == {seen[h]}")
            seen[h] = f"{key}:{fi}"
            frames.append({"key": key, "fi": fi, "im1": im1, "im2": im2, "anc": anc})
            print(f"  {key} f{fi} {im1.size} anchor={anc}", flush=True)
    water_h = existing_water_hashes()
    overlap = [k for k, h in ((f"{d['key']}:{d['fi']}", sha(d["im1"])) for d in frames) if h in water_h]
    if overlap:
        raise SystemExit(f"reused gt_water pixels: {overlap}")
    atlases, sprites, hashes, page1, page2, place, size = pack_and_write(frames)
    merge_manifest(atlases, sprites)
    contact_sheet(frames, "/tmp/wfall/contact.png")
    preview(frames, os.path.join(PREV, "waterfall.png"), os.path.join(PREV, "waterfall.gif"))
    # sizes
    files = [os.path.join(ATLAS_DIR, f"{PAGE_KEY}{s}") for s in (".png", "@2x.png", ".ktx2", "@2x.ktx2")]
    for f in files:
        print("file", os.path.basename(f), os.path.getsize(f) if os.path.exists(f) else "MISSING")
    print("page", size, "sprites", len(sprites), "unique", len(hashes))


if __name__ == "__main__":
    main()
