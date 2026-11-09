"""Door-swing in-between frames for the main-pack opening pieces and the garden gate (SurVivaZ door open animation).

Pieces (gameplay pieces.json `door: true`, art in pack/manifest.json `openings` / building `decor_yard_t`):
  door_wood, door_metal  hinge at local x = -w, leaf swings out toward +y (matches the shipped open frame)
  hatch_wood             hinge along the back (-y) edge, lid lifts up to vertical (matches the shipped open frame)
  window_shutters        two leaves hinged at the jambs, swinging out toward +y (matches the shipped open frame)
  garden_gate@{picket,iron,rustic}  leaf hinged on the left post, swings away (-y); no shipped open frame, so the
                         fully-open endpoint is drawn here too.
Geometry is the shipped builders' own boxes (assets/tools/buildings2.py door_leaf / hatch_leaf / window_insert and
decor/outdoor.py garden_gate) re-posed about the hinge with door_swing_lib, then the toolkit's own damage pass,
outline, ground shadow and downscale, then a cel snap (flat fills, one hard shade, hard highlight, binary alpha).
Run via add_door_swing.py (this module must import the main-pack assets/tools, not the vendored pvp_clan copy).
"""
import math, os, sys, zlib
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '../../../../../assets/tools'))
sys.path.insert(0, HERE)
import buildings2 as b2
from buildings import B, finalize, toon_at, planksV, planksH, flat
from iso import IsoCanvas, add_outline, tex_planks, damage
from toon import downscale, SS, ellipse_pts, INK, lerp as clerp
from palette import ramp, RAMPS, hex2rgb
from cel import snap
import door_swing_lib as L
from door_swing_lib import OB, Xf, draw_boxes, FRACS

DEG = math.pi / 180


def palette_for(rps):
    pal = []
    for r in rps:
        pal += [tuple(c) for c in ramp(r)]
    pal += [(255, 248, 225), tuple(INK), clerp(INK, (40, 25, 40), 0.2), clerp(INK, (90, 60, 70), 0.3), clerp(INK, (60, 40, 50), 0.2)]
    pal += [tuple(hex2rgb(c)) for c in RAMPS["ink"]]
    return pal


def cel(im, rps):
    return snap(im, palette_for(rps))


# ------------------------------------------------------------------ openings (128x128 cells, pivot (64, 96))
def door_obs(kind, f):
    hw, a, b = b2.OPEN_DOOR; w = hw - 0.02; th = f * 90 * DEG
    rp = "cloth_red" if kind == "wood" else "iron"; tex = planksV(5) if kind == "wood" else b2.tx("panels")
    hx, hy = L.lerp(-w, -w + 0.02, f), L.lerp(0.0, 0.05, f); t = L.lerp(0.045, 0.04, f)
    xf = Xf(pivot=(-w, 0.0, 0.0), yaw=th, off=(hx + w, hy, 0.0))
    obs = [OB(-w, w, -t, t, a, b - 1, rp, left=tex, right=tex, xf=xf)]
    if kind == "metal":
        tb = L.lerp(0.05, 0.05, f)
        obs += [OB(-w, w, -tb, tb, z, z + 3, "metal_teal", xf=xf) for z in (8, 28)]
    return obs, xf, w, th


def door_decor(cv, kind, xf, w, th, rot, mirror):
    """knob (+ the wood door's round window) on the +y face while that face is still toward the camera."""
    vf = L.view(rot, mirror); n = xf.vec((0, 1, 0)); nx, ny = vf(n[0], n[1])
    if nx + ny <= 0.05:
        return
    X, Y, _ = xf.pt(w - 0.07, 0.05, 20)
    toon_at(cv, X, Y, 20, rot, mirror, lambda c: c.part(ellipse_pts(16, 24, 1.3, 1.3, n=12), "gold" if kind == "wood" else "iron", lw=0.6, shade=0.3, hl=0.2))
    if kind == "wood":   # little round window, drawn in the leaf plane so it foreshortens with the swing
        ring = [xf.pt(0.0 + 0.085 * math.cos(k / 24 * 2 * math.pi), 0.047, 31 + 2.8 * math.sin(k / 24 * 2 * math.pi)) for k in range(24)]
        pts = L.proj_poly(cv, ring, rot, mirror)
        cv.poly(pts, ramp("glass")[1]); cv.lines(pts, clerp(INK, (90, 60, 70), 0.3), 0.7, 255, closed=True)
        hl = [xf.pt(-0.03 + 0.03 * math.cos(k / 12 * 2 * math.pi), 0.048, 32.5 + 0.9 * math.sin(k / 12 * 2 * math.pi)) for k in range(12)]
        cv.poly(L.proj_poly(cv, hl, rot, mirror), ramp("glass")[0])


def hatch_obs(f):
    h = 0.21; ph = f * 90 * DEG
    xf = Xf(pivot=(0.0, -h, 4.0), pitch=ph)
    t0 = L.lerp(3.0, 4.0 - 1.44, f)
    obs = [OB(-h, h, -h, h, t0, 5.5, "wood", top=lambda w, hh, s: tex_planks(w, hh, s, board=6), left=planksH(2), right=planksH(2), xf=xf)]
    if f < 0.5:
        obs.append(OB(-h, h, -0.03, 0.03, 5.5, 6.2, "iron", faces="t", xf=xf))
    return obs


def shutter_obs(f):
    w, a, b = b2.OPEN_WIN; T = b2.T; th = f * 90 * DEG; obs = []
    for s in (-1, 1):
        hx = L.lerp(s * w, s * (w + 0.005), f); hy = L.lerp(T + 0.025, T + 0.01, f)
        # local leaf: along +x from the hinge (left leaf) / -x (right leaf); yaw folds both out toward +y
        xf = Xf(pivot=(0.0, 0.0, 0.0), yaw=(th if s < 0 else math.pi - th), off=(hx, hy, 0.0))
        obs.append(OB(0.0, w, -0.015, 0.015, a, b, "cloth_teal", left=planksV(4), right=planksV(4), xf=xf))
    return obs


OPENINGS = {   # key -> (rotation rows, layer, ramps used, mirror art)
    "door_wood": (4, 1, ["cloth_red", "gold", "glass"], False),
    "door_metal": (4, 1, ["iron", "metal_teal"], False),
    "hatch_wood": (4, 0, ["wood", "iron"], False),
    "window_shutters": (2, 1, ["cloth_teal", "flower_yel"], True),
}


def render_opening(key, rot, f):
    """-> 4 damage-stage 128x128 RGBA cells for one rotation row at swing fraction f (0 closed .. 1 open)."""
    rows, layer, rps, mirror_art = OPENINGS[key]; seed = zlib.crc32(key.encode()) % 1000
    mirror = mirror_art and rot % 2 == 1; r = 1 if mirror else rot
    cv = IsoCanvas(128, 128, 64, 96, seed)
    if key.startswith("door_"):
        kind = key[5:]; obs, xf, w, th = door_obs(kind, f)
        for i, o in enumerate(obs):   # leaf first, then the metal door's bands on top of it
            draw_boxes(cv, [o], r, mirror, seed + i)
        door_decor(cv, kind, xf, w, th, r, mirror)
    elif key == "hatch_wood":
        for i, o in enumerate(hatch_obs(f)):   # lid, then its iron strap
            draw_boxes(cv, [o], r, mirror, seed + i)
    else:
        draw_boxes(cv, shutter_obs(f), r, mirror, seed)
        if f < 0.3:   # flower latch rides on the left leaf's free edge while it still faces the camera
            w, a, b = b2.OPEN_WIN; th = f * 90 * DEG
            X = -w + math.cos(th) * w; Y = b2.T + 0.05 + math.sin(th) * w
            toon_at(cv, X, Y, (a + b) / 2 - 3, r, mirror, lambda c: c.part(ellipse_pts(16, 24, 2.5, 2.2, n=16), "flower_yel", lw=0.5, shade=0.2, hl=0.2))
    sr = (-0.55, 0.55, -0.55, 0.55) if layer >= 1 else None
    return [cel(finalize(cv, st, seed + rot, sr), rps + ["wood"]) for st in range(4)]


# ------------------------------------------------------------------ garden gate (decor_yard_t look, wider swing cell)
YARD_CELL = (72, 120, 36, 102)     # decor_yard_t's T cell: w, h, pivot x, pivot y (anchor 0.5, 0.85)
GATE_OPEN_DEG = 75                 # garden gates stop at 75 deg against their stop: the leaf stays inside the 72 px cell
YARD_RAMPS = {"picket": ["wood_dark", "paint"], "iron": ["stone", "black_iron"], "rustic": ["wood_dark", "wood", "iron"]}


def garden_obs(v, f):
    import decor.lib  # noqa: F401  (registers paint / black_iron ramps)
    from decor.outdoor import garden_gate
    bx = garden_gate(v); posts = [b for b in bx if b.v[0] in (-.52, .40) and b.v[5] == 36]
    leaf = [b for b in bx if b not in posts]
    th = -f * GATE_OPEN_DEG * DEG   # swings away from the camera (-y), hinged on the left post
    xf = Xf(pivot=(-0.40, 0.0, 0.0), yaw=th)
    obs = [OB.of(b) for b in posts] + [OB.of(b, xf) for b in leaf]
    for o in obs:   # thin facings: no ink edges (decor/lib.py render rule)
        x0, x1, y0, y1 = o.v[:4]
        if min(x1 - x0, y1 - y0) < .035: o.edge = False
    return obs


def render_garden(v, rot, f):
    """-> (colour 1x, colour 2x, tintmask 1x, tintmask 2x) for garden_gate@v at swing fraction f."""
    import decor.lib as DL
    w, h, ox, oy = YARD_CELL; seed = zlib.crc32(f'garden_gate@{v}'.encode()) % 1000
    res = []
    for mask in (False, True):
        DL.MASK[0] = mask; _ink = IsoCanvas.ink_edges
        if mask: IsoCanvas.ink_edges = lambda self, *a, **k: None
        try:
            cv = IsoCanvas(w, h, ox, oy, seed); draw_boxes(cv, garden_obs(v, f), rot, False, seed)
        finally:
            DL.MASK[0] = False; IsoCanvas.ink_edges = _ink
        res.append(cv)
    img = add_outline(res[0].img, 1.0, seed + rot)
    sh = IsoCanvas(w, h, ox, oy); sh.ground_shadow(-.55, .55, -.55, .55); img = Image.alpha_composite(sh.img, img)
    outs = []
    for k in (1, 2):
        col = cel(downscale(img, (w * k, h * k)), YARD_RAMPS[v] + ["paint2"])
        m = np.asarray(res[1].img, np.float32)
        rgb = Image.fromarray((m[..., :3] * (m[..., 3:4] / 255.0)).astype(np.uint8), 'RGB').resize((w * k, h * k), Image.BOX)
        mk = np.where(np.asarray(rgb) >= 128, 255, 0).astype(np.uint8)
        mk[np.asarray(col)[..., 3] < 128] = 0; mk[..., 2] = 0
        outs.append((col, Image.fromarray(mk, 'RGB')))
    return outs[0][0], outs[1][0], outs[0][1], outs[1][1]


def check_clip(im, margin=2):
    """True if opaque art (alpha >= 128; the soft ground shadow is ignored) reaches the cell's 2 px padding."""
    a = np.asarray(im)[..., 3] >= 128
    return bool(a[:margin].any() or a[-margin:].any() or a[:, :margin].any() or a[:, -margin:].any())
