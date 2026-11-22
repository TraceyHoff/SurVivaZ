"""ADR-504: base building pieces at the 80 px floor (5 terrain levels x 16 px), measured against the 53 px player.

Importing this module switches the shared iso toolkit (assets/tools/buildings2.py) and pieces.py to the 80 px metric
before any piece is built: walls reach z 80 (one floor), doorways open to ~1.13x the player, window heads at ~60 px,
door leaves / window inserts fill the new openings, and stairs climb one 80 px floor with a dedicated build per tier.
Geometry is re-built at the new height (new courses / planks / stones / panels from the procedural materials at the
same texel density), never the old art stretched. Used by add_building_80px.py (the targeted packer), pieces.py,
twig_corners.py and door_swing_main.py. Spec: docs/art-requests/ADR504_BUILDING_SCALE.md.
"""
import math, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../../../assets/tools'))
import buildings2 as b2
from buildings import B, toon_at, planksH, planksV, flat, flowers_in_box
from toon import ellipse_pts
from palette import ramp

FLOOR_PX = 80                      # one floor = 5 levels x 16 px (was 48)
WALL_H = FLOOR_PX
OPEN_DOOR = (0.25, 2, 67)          # half width, bottom z, lintel z: clear opening ~60 px above the pivot (player 53)
OPEN_WIN = (0.22, 22, 66)          # half width, sill z, head z: sill ~28 px, head ~60 px above the pivot
DOOR_TOP = 61                      # door leaf top (tucked 5 px under the lintel trim, so no gap shows)
WIN_TOP = {"glass": 61, "bars": 59, "shutters_closed": 64, "shutters_open": 64}   # insert tops under the head trim
STAIRS_TOP = 78                    # top tread at the tile's back edge: one floor up (the upper deck's rim covers the 2 px)
STAIRS_N = 10                      # treads (rise ~7.8 px = ~26 cm, going 0.1 tile)

b2.WALL_H = WALL_H; b2.OPEN_DOOR = OPEN_DOOR; b2.OPEN_WIN = OPEN_WIN
T, L, tx, TIERS = b2.T, b2.L, b2.tx, b2.TIERS


# ---------------------------------------------------------------- opening inserts (pack/manifest.json `openings`)
def door_leaf(kind="wood", open_=False):
    """closed / fully open leaf; knob at ~1 m (30 px), the wood door's round window at eye height (~48 px)."""
    hw, a, _ = OPEN_DOOR; w = hw - 0.02; top = DOOR_TOP
    rp = "cloth_red" if kind == "wood" else "iron"; tex = planksV(5) if kind == "wood" else tx("panels")
    if not open_: bx = [B(-w, w, -0.045, 0.045, a, top, rp, left=tex, right=tex)]
    else: bx = [B(-w - 0.02, -w + 0.06, 0.05, 0.05 + 2 * w, a, top, rp, left=tex, right=tex)]
    if kind == "metal":   # three straps on the taller leaf
        if not open_: bx += [B(-w, w, -0.05, 0.05, z, z + 3, "metal_teal") for z in METAL_BANDS]
        else: bx += [B(-w - 0.03, -w + 0.07, 0.05, 0.05 + 2 * w, z, z + 3, "metal_teal") for z in METAL_BANDS]
    def knob(cv, r, m):
        if open_: return
        toon_at(cv, w - 0.07, 0.05, KNOB_Z, r, m, lambda c: c.part(ellipse_pts(16, 24, 1.3, 1.3, n=12), "gold" if kind == "wood" else "iron", lw=0.6, shade=0.3, hl=0.2))
        if kind == "wood": toon_at(cv, 0.0, 0.05, PORT_Z, r, m, lambda c: c.part(ellipse_pts(16, 23, 3.2, 2.8, n=16), "glass", lw=0.6, shade=0.3, hl=0.3))
    return bx, [(-1, knob)]
METAL_BANDS = (9, 29, 49); KNOB_Z = 30; PORT_Z = 48


def window_insert(kind):
    hw, a, _ = OPEN_WIN; w = hw; b = WIN_TOP[kind]; third = (b - a) / 3
    if kind == "glass":   # 6 panes: centre mullion + two transoms on the taller sash, flower box under the sill
        return [B(-w, w, -0.015, 0.015, a, b, "glass", left=flat(0.3), right=flat(0.3), faces="lr", edge=False),
                B(-0.025, 0.025, -0.03, 0.03, a, b, "wood_dark", faces="lr")] + \
               [B(-w, w, -0.03, 0.03, z - 1, z + 1, "wood_dark", faces="lr") for z in (a + third, a + 2 * third)] + \
               [B(-w, w, T + 0.02, T + 0.16, a - 6, a, "wood", left=planksH(3), right=planksH(3))], \
               [(-1, lambda cv, r, m: toon_at(cv, 0.0, T + 0.09, a, r, m, flowers_in_box))]
    if kind == "bars":    # five bars, three rails
        return [B(x - 0.018, x + 0.018, -0.02, 0.02, a, b, "iron", faces="lr") for x in np.linspace(-w + 0.04, w - 0.04, 5)] + \
               [B(-w, w, -0.025, 0.025, z, z + 1.5, "iron", faces="lrt") for z in (a + 3, (a + b) / 2, b - 4)], []
    if kind == "shutters_closed":   # two leaves with a Z-brace each, flower latch at the meeting stile
        bx = [B(-w, 0, T + 0.01, T + 0.04, a, b, "cloth_teal", left=planksV(4), right=planksV(4)), B(0, w, T + 0.01, T + 0.04, a, b, "cloth_teal", left=planksV(4), right=planksV(4))]
        bx += [B(-w + 0.02, w - 0.02, T + 0.04, T + 0.05, z, z + 2, "cloth_teal", faces="lt") for z in (a + 5, b - 7)]
        return bx, [(-1, lambda cv, r, m: toon_at(cv, 0.0, T + 0.05, (a + b) / 2 - 3, r, m, lambda c: c.part(ellipse_pts(16, 24, 2.5, 2.2, n=16), "flower_yel", lw=0.5, shade=0.2, hl=0.2)))]
    if kind == "shutters_open":
        return [B(-w - 0.02, -w + 0.01, T + 0.01, T + 0.01 + w, a, b, "cloth_teal", left=planksV(4), right=planksV(4)),
                B(w - 0.01, w + 0.02, T + 0.01, T + 0.01 + w, a, b, "cloth_teal", left=planksV(4), right=planksV(4))], []
    raise KeyError(kind)


b2.door_leaf = door_leaf; b2.window_insert = window_insert


# ---------------------------------------------------------------- stairs: one floor, a dedicated build per tier
def _tread_z(k): return STAIRS_TOP * (k + 1) / STAIRS_N
def _span(k): y1 = 0.5 - k / STAIRS_N; return y1 - 1 / STAIRS_N, y1   # tread k (0 = bottom, at +y) rises toward -y


def _posts(bx, rp, w, zt, **kw):
    """two support posts under the top tread at the back corners (the flight is open underneath)."""
    for sx in (-0.42, 0.36): bx.append(B(sx, sx + w, -0.49, -0.49 + w, 0, zt, rp, **kw))


def stairs(tier):
    """rises toward -y across the tile, top tread at z STAIRS_TOP on the back edge (gameplay stairs ramp)."""
    M = TIERS[tier]; n = STAIRS_N; bx = []; top = STAIRS_TOP
    if tier == "twig":       # sloped log stringers on two back props, lashed reed treads, no risers
        _posts(bx, "bark", 0.07, top - 8, left=tx("logs"), right=tx("logs"))
        for sx in (-0.43, 0.35):
            for k in range(n): y0, y1 = _span(k); z = _tread_z(k); bx.append(B(sx, sx + 0.08, y0, y1, max(0, z - 10), z - 1, "bark", left=planksV(3), right=planksV(3), edge=False))
        for k in range(n):
            y0, y1 = _span(k); z = _tread_z(k)
            bx.append(B(-0.4, 0.4, y0 + 0.01, y1 - 0.01, z - 3, z, "thatch", top=tx("reed"), left=planksH(3), right=planksH(3)))
            bx.append(B(-0.44, -0.4, y0 + 0.03, y1 - 0.03, z - 4, z + 0.5, "bark"))   # twine lashing knots
        return bx, []
    if tier == "wood":       # open-riser plank flight on dark stringers and back posts, newel post at the foot
        _posts(bx, "wood_dark", 0.06, top - 6, left=planksV(3), right=planksV(3))
        for k in range(n):
            y0, y1 = _span(k); z = _tread_z(k)
            bx.append(B(-0.36, 0.36, y0, y1 + 0.015, z - 3, z, "wood", top=tx("deck"), left=planksH(3), right=tx("flat")))
        for sx in (-0.42, 0.36):
            for k in range(n): y0, y1 = _span(k); bx.append(B(sx, sx + 0.06, y0, y1, max(0, _tread_z(k) - 12), _tread_z(k) + 1, "wood_dark", left=planksV(3), right=planksV(3), edge=False))
        bx += [B(0.36, 0.44, 0.40, 0.48, 0, 24, "wood_dark", left=planksV(3), right=planksV(3)), B(0.35, 0.45, 0.39, 0.49, 24, 27, "wood_dark", top=flat())]
        return bx, []
    if tier == "stone":      # solid flight: one mass of stone under flagstone treads, cobble cheek walls
        for k in range(n):
            y0, y1 = _span(k); z = _tread_z(k)
            bx.append(B(-0.36, 0.36, y0, y1, 0, z - 2, "stone", top=flat(), left=tx("flat"), right=tx("flat"), edge=False))
            bx.append(B(-0.37, 0.37, y0 - 0.005, y1 + 0.01, z - 2, z, "stone", top=tx("flag"), left=tx("flat"), right=tx("flat")))
        for sx in (-0.44, 0.36):
            for k in range(n): y0, y1 = _span(k); bx.append(B(sx, sx + 0.08, y0, y1, 0, _tread_z(k) + 3, "cobble", top=flat(), left=tx("cobble4"), right=tx("cobble4"), edge=False))
        bx += [B(0.355, 0.445, 0.41, 0.5, 0, 14, "stone", top=flat(), left=tx("ashlar"), right=tx("ashlar"))]
        bx.append(B(0.37, 0.43, 0.43, 0.49, 14, 18, "stone", top=flat()))   # cap on the foot cheek
        return bx, []
    if tier == "metal":      # diamond-plate treads on teal steel stringers, open underneath, two back columns
        _posts(bx, "metal_teal", 0.05, top - 5, left=tx("flat"), right=tx("flat"))
        for k in range(n):
            y0, y1 = _span(k); z = _tread_z(k)
            bx.append(B(-0.36, 0.36, y0, y1 + 0.01, z - 2, z, "iron", top=tx("diamond"), left=tx("flat"), right=tx("flat")))
            bx.append(B(-0.36, 0.36, y1 - 0.012, y1 + 0.01, z - 4, z - 2, "metal_teal", faces="lr"))   # nosing angle
        for sx in (-0.42, 0.36):
            for k in range(n): y0, y1 = _span(k); bx.append(B(sx, sx + 0.06, y0, y1, max(0, _tread_z(k) - 9), _tread_z(k) + 1, "metal_teal", left=tx("flat"), right=tx("flat"), edge=False))
            bx.append(B(sx, sx + 0.06, 0.38, 0.5, 0, 6, "metal_teal", top=flat()))   # foot plate
        bx += [B(0.37, 0.43, 0.41, 0.47, 0, 26, "metal_teal", left=tx("flat"), right=tx("flat")), B(0.36, 0.44, 0.40, 0.48, 26, 28, "iron", top=flat())]
        return bx, []
    if tier == "reinforced":   # riveted plate treads on a slate mass, armoured cheek plates, brick-capped foot post
        for k in range(n):
            y0, y1 = _span(k); z = _tread_z(k)
            bx.append(B(-0.35, 0.35, y0, y1, 0, z - 3, "slate", top=flat(), left=tx("flat"), right=tx("flat"), edge=False))
            bx.append(B(-0.36, 0.36, y0, y1 + 0.012, z - 3, z, "iron", top=tx("plates"), left=tx("flat"), right=tx("flat")))
        for sx in (-0.43, 0.35):
            for k in range(n): y0, y1 = _span(k); bx.append(B(sx, sx + 0.08, y0, y1, 0, _tread_z(k) + 2, "iron", top=flat(), left=tx("plates"), right=tx("plates"), edge=False))
        bx += [B(0.35, 0.45, 0.40, 0.5, 0, 20, "slate", top=flat(), left=tx("ashlar"), right=tx("ashlar")), B(0.34, 0.46, 0.39, 0.51, 20, 23, "brick", top=flat())]
        return bx, []
    raise KeyError(tier)


b2.stairs = stairs


# ---------------------------------------------------------------- door-swing in-betweens (door_swing_main.py)
def patch_door_swing(DM):
    """door_swing_main reads b2.OPEN_DOOR / OPEN_WIN for the hinge and leaf extents; the leaf top, metal straps and the
    knob / round window heights follow the 80 px leaf here. Shutters use WIN_TOP so swing frames meet the closed / open art."""
    import door_swing_lib as Lb
    from door_swing_lib import OB, Xf
    DEG = math.pi / 180
    def door_obs(kind, f):
        hw, a, _ = OPEN_DOOR; w = hw - 0.02; th = f * 90 * DEG
        rp = "cloth_red" if kind == "wood" else "iron"; tex = planksV(5) if kind == "wood" else tx("panels")
        hx, hy = Lb.lerp(-w, -w + 0.02, f), Lb.lerp(0.0, 0.05, f); t = Lb.lerp(0.045, 0.04, f)
        xf = Xf(pivot=(-w, 0.0, 0.0), yaw=th, off=(hx + w, hy, 0.0))
        obs = [OB(-w, w, -t, t, a, DOOR_TOP, rp, left=tex, right=tex, xf=xf)]
        if kind == "metal": obs += [OB(-w, w, -0.05, 0.05, z, z + 3, "metal_teal", xf=xf) for z in METAL_BANDS]
        return obs, xf, w, th
    def door_decor(cv, kind, xf, w, th, rot, mirror):
        vf = Lb.view(rot, mirror); n = xf.vec((0, 1, 0)); nx, ny = vf(n[0], n[1])
        if nx + ny <= 0.05: return
        X, Y, _ = xf.pt(w - 0.07, 0.05, KNOB_Z)
        toon_at(cv, X, Y, KNOB_Z, rot, mirror, lambda c: c.part(ellipse_pts(16, 24, 1.3, 1.3, n=12), "gold" if kind == "wood" else "iron", lw=0.6, shade=0.3, hl=0.2))
        if kind == "wood":
            ring = [xf.pt(0.085 * math.cos(k / 24 * 2 * math.pi), 0.047, PORT_Z + 3.0 * math.sin(k / 24 * 2 * math.pi)) for k in range(24)]
            pts = Lb.proj_poly(cv, ring, rot, mirror)
            cv.poly(pts, ramp("glass")[1]); cv.lines(pts, DM.clerp(DM.INK, (90, 60, 70), 0.3), 0.7, 255, closed=True)
            hl = [xf.pt(-0.03 + 0.03 * math.cos(k / 12 * 2 * math.pi), 0.048, PORT_Z + 1.5 + 0.9 * math.sin(k / 12 * 2 * math.pi)) for k in range(12)]
            cv.poly(Lb.proj_poly(cv, hl, rot, mirror), ramp("glass")[0])
    def shutter_obs(f):
        w, a, _ = OPEN_WIN; b = WIN_TOP["shutters_closed"]; th = f * 90 * DEG; obs = []
        for s in (-1, 1):
            hx = Lb.lerp(s * w, s * (w + 0.005), f); hy = Lb.lerp(T + 0.025, T + 0.01, f)
            xf = Xf(pivot=(0.0, 0.0, 0.0), yaw=(th if s < 0 else math.pi - th), off=(hx, hy, 0.0))
            obs.append(OB(0.0, w, -0.015, 0.015, a, b, "cloth_teal", left=planksV(4), right=planksV(4), xf=xf))
        return obs
    DM.door_obs, DM.door_decor, DM.shutter_obs = door_obs, door_decor, shutter_obs
