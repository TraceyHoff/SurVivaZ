"""Base-building piece set, tiers 1 wood / 2 stone / 3 metal / 4 reinforced. Reuses the main pack's iso box/roof
toolkit (assets/tools/buildings*.py) so materials, outlines, damage and the grid match the existing pieces exactly:
1 cell = 1 tile (64x32), pivot = cell centre on the ground, walls on the cell centre line, 1 floor = 48 px."""
import os, sys, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../../../assets/tools'))
import buildings2 as b2
from buildings import B, render_boxes, planksH, planksV, flat
from toon import SS, noise
from buildings2 import WALL_H, T, L, tx, TIERS

def tex_plates(w, h, s, pw=14, ph=12):
    """riveted steel plates with a cross brace (reinforced tier)"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32); P, Q = pw * SS, ph * SS
    fx, fy = xx % P, yy % Q; t = 1.0 + (noise(w, h, 5 * SS, s) - 0.5) * 0.25
    t = np.where((fx < SS * 0.9) | (fy < SS * 0.9), 2.9, t)
    riv = ((np.abs(fx - SS * 2.2) < SS * 0.9) | (np.abs(fx - P + SS * 2.2) < SS * 0.9)) & ((np.abs(fy - SS * 2.2) < SS * 0.9) | (np.abs(fy - Q + SS * 2.2) < SS * 0.9))
    t = np.where(riv, -0.5, t)
    u = xx / max(1, w); v = yy / max(1, h); br = (np.abs(u - v) < 0.05) | (np.abs(u + v - 1) < 0.05)
    return np.where(br, t - 0.55, t) + np.where(noise(w, h, 4 * SS, s + 5) > 0.82, 0.7, 0)
b2.TEX["plates"] = tex_plates
TIERS["reinforced"] = dict(wall=("iron", "plates"), base=("slate", "ashlar"), frame=("slate", "plates"), floor=("iron", "diamond"),
                           found=("slate", "ashlar"), roof="slate", roof_style="corrugated", trim="brick", post_w=0.1, beam=True)
TIER_NAMES = {1: "wood", 2: "stone", 3: "metal", 4: "reinforced"}

def _W(M, thick=T):
    wrp, wtx = M["wall"]; return lambda x0, x1, za, zb: B(x0, x1, -thick, thick, za, zb, wrp, left=tx(wtx), right=tx(wtx), top=flat())
def _frame(M, bx, top, thick=T):
    frp, ftx = M["frame"]; pw = M["post_w"]
    for sx in (-1, 1): bx.append(B(sx * L - (pw if sx > 0 else 0), sx * L + (pw if sx < 0 else 0), -thick - 0.04, thick + 0.04, 0, top + 1, frp, left=tx(ftx), right=tx(ftx)))
    bx.append(B(-L, L, -thick - 0.05, thick + 0.05, top - 5, top, frp, top=flat()))
def _plinth(M, bx, x0=-L, x1=L, thick=T):
    if M["base"]: brp, btx = M["base"]; bx.append(B(x0, x1, -thick - 0.03, thick + 0.03, 0, 7, brp, top=tx(btx), left=tx(btx), right=tx(btx))); return 7
    return 0

def wall_arched(tier):
    M = TIERS[tier]; W = _W(M); bx = []; pw = M["post_w"]; inner = L - pw; hw = 0.3; spring = 26
    if M["base"]:
        brp, btx = M["base"]
        for a, b in ((-L, -hw), (hw, L)): bx.append(B(a, b, -T - 0.03, T + 0.03, 0, 7, brp, top=tx(btx), left=tx(btx), right=tx(btx)))
    z0 = 7 if M["base"] else 0
    bx += [W(-inner, -hw, z0, WALL_H - 5), W(hw, inner, z0, WALL_H - 5)]
    n = 7   # arch: stepped voussoirs (half-circle approximated with boxes)
    for k in range(n):
        x0 = -hw + hw * (1 - np.cos(np.pi / 2 * k / n)) * 0; a = hw * np.cos(np.pi / 2 * (k + 1) / n); zb = spring + hw * 36 * np.sin(np.pi / 2 * (k + 1) / n) * 0.75
        za = spring + hw * 36 * np.sin(np.pi / 2 * k / n) * 0.75
        bx += [W(-hw, -a, za, WALL_H - 5), W(a, hw, za, WALL_H - 5)]
    bx.append(W(-0.04, 0.04, spring + hw * 27, WALL_H - 5))
    fr = M["trim"]; bx.append(B(-0.06, 0.06, -T - 0.04, T + 0.04, spring + hw * 27 - 2, spring + hw * 27 + 4, fr))   # keystone
    bx.append(B(-hw, hw, -T, T, 0, 1.5, M["base"][0] if M["base"] else "dirt", top=flat()))
    _frame(M, bx, WALL_H); return bx, []

def wall_fortified(tier):
    M = TIERS[tier]; t2 = T * 1.5; W = _W(M, t2); bx = []
    z0 = _plinth(M, bx, thick=t2 + 0.02)
    bx.append(W(-L + M["post_w"], L - M["post_w"], z0, WALL_H - 5))
    _frame(M, bx, WALL_H, t2)
    frp, ftx = M["frame"]
    for x in (-0.25, 0.25):   # buttresses on the outer (+y) face
        bx.append(B(x - 0.07, x + 0.07, t2, t2 + 0.14, 0, 30, frp, left=tx(ftx), right=tx(ftx), top=flat()))
    for x in (-0.38, 0.0, 0.38):   # merlons
        bx.append(B(x - 0.09, x + 0.09, -t2 - 0.05, t2 + 0.05, WALL_H, WALL_H + 7, frp, top=flat(), left=tx(ftx), right=tx(ftx)))
    return bx, []

R3 = 1 / np.sqrt(3)   # circumradius of a unit equilateral triangle
TRI = [(R3 * np.cos(np.radians(a)), R3 * np.sin(np.radians(a))) for a in (60, 180, 300)]   # gameplay rot 0: edge 0 normal +x, centroid = pivot

def _strips(poly, n, mk):
    """fill a convex polygon with n thin x-strips (sub-pixel wide, so the diagonals read smooth); mk(x0, x1, y0, y1) -> B"""
    xs = [p[0] for p in poly]; xa, xb = min(xs), max(xs); out = []
    for k in range(n):
        x0 = xa + (xb - xa) * k / n; x1 = xa + (xb - xa) * (k + 1) / n; xc = (x0 + x1) / 2; ys = []
        for (ax, ay), (bx_, by) in zip(poly, poly[1:] + poly[:1]):
            if (ax - xc) * (bx_ - xc) <= 0 and ax != bx_: ys.append(ay + (by - ay) * (xc - ax) / (bx_ - ax))
        if len(ys) >= 2 and max(ys) - min(ys) > 1e-3: out.append(mk(x0, x1, min(ys), max(ys)))
    return out
def _shrink(poly, f):
    return [(x * f, y * f) for x, y in poly]

def foundation_triangle(tier):
    """unit equilateral triangle on its centroid (gameplay placement "tri"); slab z 0..9, deck 9..12"""
    M = TIERS[tier]; rp, t = M["found"]; frp, ft = M["floor"]
    bx = _strips(TRI, 48, lambda a, b, c, d: B(a, b, c, d, 0, 9, rp, top=tx(t), left=tx(t), right=tx(t), edge=False))
    bx += _strips(_shrink(TRI, 0.92), 48, lambda a, b, c, d: B(a, b, c, d, 9, 12, frp, top=tx(ft), left=tx("flat"), right=tx("flat"), edge=False))
    return bx, []

def floor_triangle(tier):
    """triangle ceiling/floor deck (z 0..4) that tops foundation_triangle"""
    M = TIERS[tier]; rp, t = M["floor"]; trim = M["trim"]
    bx = _strips(TRI, 48, lambda a, b, c, d: B(a, b, c, d, 0, 4, rp, top=tx(t), left=tx("flat"), right=tx("flat"), edge=False))
    return bx, []

def foundation_ramp(tier):
    """sloped foundation: deck height 12 at the -y edge down to grade at +y (smooth 24-step slope), side cheeks"""
    M = TIERS[tier]; rp, t = M["found"]; frp, ft = M["floor"]; n = 24; bx = []
    for k in range(n):
        y0 = -0.5 + k / n; y1 = y0 + 1 / n; z = 12 * (1 - (k + 0.5) / n) + 0.5
        bx.append(B(-0.44, 0.44, y0, y1, 0, z, frp, top=tx(ft), left=tx("flat"), right=tx("flat"), edge=False))
        for sx in (-1, 1): bx.append(B(sx * 0.5 - (0.06 if sx > 0 else 0), sx * 0.5 + (0.06 if sx < 0 else 0), y0, y1, 0, z + 1.5, rp, top=tx(t), left=tx(t), right=tx(t), edge=False))
    return bx, []

def foundation_steps(tier):
    M = TIERS[tier]; rp, t = M["found"]; frp, ft = M["floor"]
    bx = [B(-0.5, 0.5, -0.5, 0.0, 0, 9, rp, top=tx(t), left=tx(t), right=tx(t)), B(-0.47, 0.47, -0.47, 0.0, 9, 12, frp, top=tx(ft), left=tx("flat"), right=tx("flat"))]
    for k in range(3):   # steps down toward +y
        y0 = k / 6; bx.append(B(-0.45, 0.45, y0, y0 + 1 / 6, 0, 12 - (k + 1) * 3.5, frp, top=tx(ft), left=tx("flat"), right=tx("flat")))
    return bx, []

def foundation_stilt(tier):
    M = TIERS[tier]; frp, ft = M["frame"]; drp, dt = M["floor"]; bx = []
    for sx in (-0.38, 0.38):
        for sy in (-0.38, 0.38): bx.append(B(sx - 0.07, sx + 0.07, sy - 0.07, sy + 0.07, 0, 8, frp, left=tx(ft), right=tx(ft)))
    bx += [B(-0.5, 0.5, -0.5, 0.5, 8, 10, frp, top=flat(), left=planksH(3), right=planksH(3)), B(-0.48, 0.48, -0.48, 0.48, 10, 12, drp, top=tx(dt), left=tx("flat"), right=tx("flat"))]
    return bx, []

def _deck(M, holes):
    """floor slab (z 0..4) with rectangular holes [(x0,x1,y0,y1)] — built from the boxes around one hole."""
    rp, t = M["floor"]; (x0, x1, y0, y1), = holes; S = lambda a, b, c, d: B(a, b, c, d, 0, 4, rp, top=tx(t), left=tx("flat"), right=tx("flat"))
    return [S(-0.5, 0.5, -0.5, y0), S(-0.5, 0.5, y1, 0.5), S(-0.5, x0, y0, y1), S(x1, 0.5, y0, y1)]

def floor_stairwell(tier):
    M = TIERS[tier]; x0, x1, y0, y1 = -0.4, 0.4, -0.2, 0.2; bx = _deck(M, [(x0, x1, y0, y1)]); frp = M["trim"]
    bx.append(B(x0, x1, y0, y1, 0, 0.6, "ink", top=flat(0.05), faces="t", edge=False))
    for y in (y0 - 0.04, y1):   # railings along both long sides
        bx.append(B(x0, x1, y, y + 0.04, 13, 15, frp, top=flat()))
        for x in (x0, 0.0, x1 - 0.04): bx.append(B(x, x + 0.04, y, y + 0.04, 4, 13, frp))
    return bx, []

def floor_skylight(tier):
    M = TIERS[tier]; h = 0.24; bx = _deck(M, [(-h, h, -h, h)]); trim = M["trim"]
    bx += [B(-h, h, -h, h, 1.5, 2.5, "glass", top=flat(0.3), faces="t", edge=False), B(-0.02, 0.02, -h, h, 2.5, 3.2, trim, faces="t"), B(-h, h, -0.02, 0.02, 2.5, 3.2, trim, faces="t"),
           B(-h - 0.04, h + 0.04, -h - 0.04, -h, 4, 5, trim), B(-h - 0.04, h + 0.04, h, h + 0.04, 4, 5, trim), B(-h - 0.04, -h, -h, h, 4, 5, trim), B(h, h + 0.04, -h, h, 4, 5, trim)]
    return bx, []

ARM = 0.22   # corner stub length (tiles); edge walls already span vertex to vertex
def _corner(M, arms, extra=()):
    """vertex-snapped corner: post on the pivot (= tile corner) + short wall stubs along `arms` [(dx, dy)]"""
    wrp, wtx = M["wall"]; frp, ftx = M["frame"]; bx = []; z0 = 0; P = T + 0.06
    def arm(dx, dy, za, zb, rp, th, **kw):
        x0, x1 = sorted((0, dx * ARM)) if dx else (-th, th); y0, y1 = sorted((0, dy * ARM)) if dy else (-th, th); return B(x0, x1, y0, y1, za, zb, rp, **kw)
    if M["base"]:
        brp, btx = M["base"]; z0 = 7
        bx += [arm(dx, dy, 0, 7, brp, T + 0.03, top=tx(btx), left=tx(btx), right=tx(btx)) for dx, dy in arms]
    bx += [arm(dx, dy, z0, WALL_H - 5, wrp, T, left=tx(wtx), right=tx(wtx), top=flat()) for dx, dy in arms]
    bx += [arm(dx, dy, WALL_H - 5, WALL_H, frp, T + 0.05, top=flat()) for dx, dy in arms]
    bx.append(B(-P, P, -P, P, 0, WALL_H + 1, frp, left=tx(ftx), right=tx(ftx), top=flat()))
    return bx + list(extra)

def wall_corner_outer(tier):
    M = TIERS[tier]; frp, ftx = M["frame"]; bx = _corner(M, [(-1, 0), (0, -1)])
    for z in range(0, WALL_H - 6, 12):   # quoins wrapping the post
        bx.append(B(-T - 0.1, T + 0.1, -T - 0.1, T + 0.1, z, z + 6, frp, top=flat(), left=tx(ftx), right=tx(ftx)))
    return bx, []

def wall_corner_inner(tier):
    M = TIERS[tier]; bx = _corner(M, [(1, 0), (0, 1)])
    bx.append(B(T + 0.06, T + 0.12, T + 0.06, T + 0.12, 7 if M["base"] else 0, WALL_H - 5, M["trim"]))   # cove trim in the concave angle
    return bx, []

def wall_corner_angled(tier):
    """45-degree wall from the vertex post (pivot) to the tile centre direction (0.5,-0.5); a pair spans a tile diagonal"""
    M = TIERS[tier]; wrp, wtx = M["wall"]; frp, ftx = M["frame"]; n = 40; bx = []; P = T + 0.06; e = 0.48
    for k in range(n):
        x0, x1 = e * k / n, e * (k + 1) / n; yc = -(x0 + x1) / 2
        bx.append(B(x0, x1, yc - T, yc + T, 0, WALL_H - 5, wrp, left=tx(wtx), right=tx(wtx), top=flat(), edge=False))
        bx.append(B(x0, x1, yc - T - 0.03, yc + T + 0.03, WALL_H - 5, WALL_H, frp, top=flat(), edge=False))
    bx.append(B(-P, P, -P, P, 0, WALL_H + 1, frp, left=tx(ftx), right=tx(ftx), top=flat()))
    return bx, []

def roof_chimney(tier):
    M = TIERS[tier]; rp = M["roof"]; trim = M["trim"]; srp = "brick" if tier in ("wood", "stone") else "iron"
    stx = (lambda w, h, s: b2.tex_ashlar(w, h, s, 7, 5)) if srp == "brick" else tx("panels")
    bx = [B(-0.5, 0.5, -0.5, 0.5, 0, 4, rp, top=flat(0.15), left=flat(), right=flat()), B(-0.5, 0.5, -0.5, 0.5, 4, 7, trim, top=None, faces="lr"),
          B(-0.16, 0.16, -0.16, 0.16, 4, 40, srp, left=stx, right=stx, top=flat()), B(-0.2, 0.2, -0.2, 0.2, 40, 44, trim, top=flat()),
          B(-0.1, 0.1, -0.1, 0.1, 43.5, 44.2, "ink", top=flat(0.05), faces="t", edge=False)]
    return bx, []
CHIMNEY_SMOKE_Z = 46


def shaft_hatch(tier):
    """Ground-rim trapdoor: solid walkable lid, recessed dark shaft seam.

    Authored independently of floor_hatch_frame/foundation. Hinges face -y;
    each quarter turn is rendered, never mirrored. All geometry stays in one cell.
    """
    bx = []
    def box(x0, x1, y0, y1, z0, z1, material, texture="flat"):
        bx.append(B(x0, x1, y0, y1, z0, z1, material,
                    top=tx(texture), left=flat(), right=flat()))

    # Dark earthen throat visible around, but not through, the closed lid.
    box(-.46, .46, -.46, .46, 0, 1, "ink")
    rim, texture = {"wood": ("wood_dark", "planks"),
                    "stone": ("stone", "ashlar"),
                    "metal": ("metal_teal", "flat"),
                    "reinforced": ("slate", "plates")}[tier]
    for a, b, c, d in [(-.5, .5, -.5, -.38), (-.5, .5, .38, .5),
                        (-.5, -.38, -.38, .38), (.38, .5, -.38, .38)]:
        box(a, b, c, d, 0, 4, rim, texture)
    if tier == "wood":
        # Five individually edged boards, with two iron hinge straps.
        for i in range(5):
            x = -.345 + i * .138
            box(x, x + .132, -.345, .345, 1.8, 4.6, "wood", "deck")
        for x in (-.23, .19):
            box(x, x + .045, -.40, .18, 4.6, 5.2, "iron")
    elif tier == "stone":
        # Wide ashlar kerb joints and a single heavy beveled lifting slab.
        for x in (-.26, .23):
            for y in (-.49, .39):
                box(x, x + .025, y, y + .10, 4, 4.15, "ink")
        box(-.345, .345, -.345, .345, 1.8, 4.8, "slate")
        box(-.30, .30, -.30, .30, 4.8, 5.8, "stone")
        for x in (-.27, .20):
            box(x, x + .07, -.405, -.23, 5.8, 6.5, "iron")
    elif tier == "metal":
        # Teal folded steel lid, inset iron tread plate and corner bolt heads.
        box(-.35, .35, -.35, .35, 1.8, 4.8, "metal_teal")
        box(-.27, .27, -.27, .27, 4.8, 5.2, "iron", "diamond")
        for x in (-.29, .26):
            for y in (-.28, .25):
                box(x, x + .035, y, y + .035, 5.2, 6, "metal_teal")
        for x in (-.24, .17):
            box(x, x + .07, -.41, -.25, 4.8, 6, "iron")
    else:
        # Armoured lid with a genuine raised X brace, rivets and hazard kerb.
        box(-.35, .35, -.35, .35, 1.8, 5.2, "iron", "plates")
        for i in range(12):
            x = -.30 + i * .05
            for y in (x, -x - .05):
                box(x, x + .05, y, y + .05, 5.2, 6.5, "metal_teal")
        for x in (-.46, .42):
            for y in (-.31, -.10, .11, .29):
                box(x, x + .04, y, y + .065, 4, 4.8, "gold")
        for x in (-.29, .26):
            for y in (-.29, .26):
                box(x, x + .035, y, y + .035, 5.2, 6.5, "metal_teal")
        for x in (-.25, .16):
            box(x, x + .09, -.42, -.25, 5.2, 6.5, "slate")
    # Small recessed pull at the front; no tall handle to trip over.
    z = 6.5 if tier == "reinforced" else 6
    box(-.10, .10, .18, .29, z, z + .25, "ink")
    box(-.075, .075, .205, .24, z + .25, z + 1, "metal_teal" if tier == "metal" else "iron")
    return bx, []


# piece key -> (kind, builder/arg, layer, rows, tall, existing)
#   rows: 1 symmetric (rotationArt mirror, one row), 2 axis pieces (rows 0/1 reused for rot 2/3), 4 unique
W = lambda kind: (lambda tier: b2.wall(tier, kind))
PIECES = {
  "foundation":          ("boxes", b2.foundation, 0, 4, False, True),
  "foundation_triangle": ("boxes", foundation_triangle, 0, 4, False, False),
  "foundation_steps":    ("boxes", foundation_steps, 0, 4, False, False),
  "foundation_stilt":    ("boxes", foundation_stilt, 0, 4, False, False),
  "foundation_ramp":     ("boxes", foundation_ramp, 1, 4, False, False),
  "wall":                ("boxes", W("plain"), 1, 2, True, True),
  "wall_window":         ("boxes", W("window"), 1, 2, True, True),
  "wall_doorway":        ("boxes", W("doorway"), 1, 2, True, True),
  "wall_low":            ("boxes", W("low"), 1, 2, True, True),
  "wall_arched":         ("boxes", wall_arched, 1, 2, True, False),
  "wall_fortified":      ("boxes", wall_fortified, 1, 2, True, False),
  "floor":               ("boxes", b2.floor, 0, 4, False, True),
  "floor_hatch_frame":   ("boxes", b2.hatch_frame, 0, 4, False, True),
  "floor_stairwell":     ("boxes", floor_stairwell, 0, 2, False, False),
  "floor_skylight":      ("boxes", floor_skylight, 0, 4, False, False),
  "floor_triangle":      ("boxes", floor_triangle, 0, 4, False, False),
  "wall_corner_outer":   ("boxes", wall_corner_outer, 1, 4, True, False),
  "wall_corner_inner":   ("boxes", wall_corner_inner, 1, 4, True, False),
  "pillar":              ("boxes", b2.pillar, 1, 4, True, True),
  "wall_corner_angled":  ("boxes", wall_corner_angled, 1, 4, True, False),
  "roof_flat":           ("roof", "flat", 0, 4, False, True),
  "roof_slope":          ("roof", "slope", 0, 4, False, True),
  "roof_gable":          ("roof", "ridge", 0, 2, False, False),
  "roof_hip":            ("roof", "hip", 0, 4, False, True),
  "roof_corner":         ("roof", "corner", 0, 4, False, True),
  "roof_chimney":        ("boxes", roof_chimney, 0, 4, True, False),
  "shaft_hatch":         ("boxes", shaft_hatch, 0, 4, False, False),
}
# ADR-253: these shipped one mirrored row; now 4 drawn rotations (rot 0 unchanged, back rotations show back details from
# assets/tools/backs.py). Their extra rows go after every existing frame on the tier page so other indices do not move.
OLD_ROWS = {k: 1 for k in ("foundation", "foundation_stilt", "floor", "floor_hatch_frame", "floor_skylight", "pillar", "roof_flat", "roof_chimney")}
# New art is appended after every shipped frame, including ADR-253 rotations.
OLD_ROWS["shaft_hatch"] = 0
# extra piece keys that reuse another piece's frames (main-pack art-only keys get tier art too)
ALIAS = {"wall_corner": "wall_corner_outer", "roof_ridge": "roof_gable"}
