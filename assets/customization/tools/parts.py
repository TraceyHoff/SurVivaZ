"""Drawers for the body and every wearable. Each drawer(c: Ctx, spec) queues depth-sorted items on c and may
set c.extra (drawn after the front-arm cut, e.g. front sleeves). 'P'/'S' ramps = tint mask R/G (neutral art)."""
import math
import numpy as np
from PIL import Image, ImageChops
from rig import NECK, circle, hull, NEU, NEU_INK, ramp, ellipse_pts, capsule_pts

INK = ramp("ink")
def star(c, x, y, r, rp="gold", rot=0.0):
    pts = [(x + math.cos(rot - math.pi / 2 + i * math.pi / 5) * (r if i % 2 == 0 else r * .45),
            y + math.sin(rot - math.pi / 2 + i * math.pi / 5) * (r if i % 2 == 0 else r * .45)) for i in range(10)]
    c.cv.part(pts, rp, lw=.6, shade=.25, hl=.2)


# --- sit (AnimState.Sit, vehicles): bent legs hip -> knee -> foot. Standing anims keep the straight hip -> foot tube.
def legpath(c, side):
    K = c.K
    return [K["hips"][side], K["knees"][side], K["feet"][side]] if K.get("sit") else [K["hips"][side], K["feet"][side]]
def along(c, pts, t):
    L = [math.dist(a, b) for a, b in zip(pts, pts[1:])]; tot = sum(L) or 1; s = max(0.0, min(1.0, t)) * tot
    for (a, b), l in zip(zip(pts, pts[1:]), L):
        if s <= l or b is pts[-1]: return c.lerp3(a, b, s / l if l else 0)
        s -= l
    return pts[-1]
def legtubes(c, pts, r0, r1):
    """Capsules along a polyline (radius r0 -> r1); returns a list of polygons (one part, one outline)."""
    n = len(pts) - 1; out = []
    for i in range(n): out.append(c.tube(pts[i], pts[i + 1], r0 + (r1 - r0) * i / n, r0 + (r1 - r0) * (i + 1) / n))
    return out if n > 1 else out[0]
def cut(c, pts, t):
    """Polyline from pts[0] to the point at fraction t of its length."""
    if len(pts) == 2: return [pts[0], c.lerp3(pts[0], pts[1], t)]
    L = [math.dist(a, b) for a, b in zip(pts, pts[1:])]; s = t * sum(L); out = [pts[0]]
    for (a, b), l in zip(zip(pts, pts[1:]), L):
        if s <= l: out.append(c.lerp3(a, b, s / l if l else 0)); return out
        out.append(b); s -= l
    return out

def hv(c): return c.P(c.K["hc"])[1]
FACE_LIFT = {0: 5.0, 1: 5.0, 2: 5.0, 3: 4.0, 7: 4.0}   # px the face/eyes/glasses features sit above the bare sph() position per facing
MOUTH_LIFT = .5
def lifted(c, fn):
    """run a face-feature draw with sph() lifted onto the head (features sat on the chin/collar before)."""
    def g():
        c.fdy = FACE_LIFT.get(c.K["d"], 0.0)
        try: fn()
        finally: c.fdy = 0.0
    return g
def fv(c): return c.facev()

# ============================================================ BODY
def body(c, spec):
    K = c.K; B = K["B"]; cv = c.cv; cv.cel = True; cv.pal = []   # solid cel-shaded skin (no airbrush gradients)
    if not K.get("sit"): cv.shadow(24, 74.5, 10.5, 3.6)   # seated riders cast no ground shadow (the vehicle does)
    for side in (-1, 1):
        hip, ft = K["hips"][side], K["feet"][side]
        d = (c.P(hip)[1] + c.P(ft)[1]) / 2 - 2
        def leg(hip=hip, ft=ft, side=side):
            cv.part(legtubes(c, legpath(c, side), B["leg"], B["leg"] * .88), "P", lw=1.0, shade=.25)
            fp = c.p(c.off(ft, 0, 1.0, -.6)); cv.part(circle(fp, 2.6, 1.8, wob=.05), "P", lw=.9, shade=.25)
        c.add(d, leg)
    def torso():
        tm = cv.part(c.torso_pts(), "P", lw=1.1, shade=.24, hl=.12)
        # underwear (untinted): briefs + (female) bandeau
        hc = K["hipc"]; pts = c.solid([(c.off(hc, 0, 0, 1.2), B["hipw"] + 2.9), (c.off(hc, 0, 0, -2.4), B["hipw"] + 2.1)])
        cv.part(pts, "cloth_cream", lw=.9, shade=.25, hl=.15)
        if K["bt"] == "female":
            cv.part(circle(c.p(c.off(K["tc"], 0, 0, 3.0)), B["trx"] + 2, 2.6), "cloth_cream", lw=.8, clip=tm, shade=.3, hl=.1)
        if fv(c) > -0.2:  # belly button
            bp = c.p(c.off(K["tc"], 0, B["trx"] * .8, -2)); cv.fill(circle(bp, .55, .45), "P3")
    c.add(K["tv"], torso)
    for side in (-1, 1):
        a, b = K["sh"][side], K["hand"][side]; d = max(c.P(a)[1], c.P(b)[1]) - .5 + (.3 if side == 1 else 0)
        # Guard arms recede behind the torso from N/NW/NE, rather than crossing the nape.
        if K["anim"] in ("block", "block_hit") and not K["front"][side]: d = min(d, K["tv"] - .01)
        if K["front"][side]: d = max(d, K["tv"] + .01)
        def arm(a=a, b=b):
            cv.part(c.tube(a, b, B["arm"], B["arm"] * .9), "P", lw=1.0, shade=.25)
            cv.part(circle(c.p(b), B["hand"], B["hand"] * .95, wob=.06), "P", lw=1.0, shade=.2, hl=.15)
        c.add(d, arm)
    def neck():   # ADR-128: skin capsule from the torso top to the (raised) skull base
        r = B["arm"] * 1.12; a = c.p(c.off(K["tc"], 0, 0, B["try_"] * .45)); b = c.p(c.off(K["hc"], 0, 0, -K["hr"] * .55))
        b = (b[0], b[1] - NECK)
        cv.part(hull(circle(a, r, r * .8) + circle(b, r, r * .8)), "P", lw=1.0, shade=.32)
    c.add(hv(c) + 1.45, neck)
    def head():
        c.fdy = NECK
        try: _head()
        finally: c.fdy = 0.0
    def _head():
        for az in (-88, 88):
            p, v = c.sph(az, -4, .98)
            if v > -.75: cv.part(circle(p, 2.5, 2.9, wob=.05), "P", lw=.9, shade=.3)
        hm = cv.part(None, "P", mask=c.headmask(NECK), lw=1.15, shade=.2, hl=.14)
        f = fv(c)
        if f > -.3:
            p, v = c.sph(0, -17, 1.0)
            if v > .1: cv.part(circle((p[0], p[1] - .2), 1.3, 1.0), "P", lw=.6, shade=.35, hl=0, clip=None)
            for az in (-48, 48):
                bl, bv = c.sph(az, -24, .98)
                if bv > .1: cv.fill(circle(bl, 2.4 * max(.4, bv), 1.3), ramp("flower_pink")[1], alpha=140, clip=hm)
    c.add(hv(c) + 1.5, head)

# ============================================================ HAIR
def hair_cap(c, sc=1.1, bangs=((-42, 30), (-14, 35), (14, 30), (42, 35)), br=.27, hole=(1.04, .98), dz=1.6, part_line=None, flat=False, wob=.06, rp="P"):
    K = c.K; cv = c.cv; hr = K["hr"]; c3 = K["hc"]
    hc = c.p((c3[0], c3[1] - .8, c3[2] + dz))
    capm = cv.mask_from(circle(hc, hr * sc, hr * (sc - .05), wob=wob, seed=21))
    if fv(c) > -.35:
        fc, _ = c.sph(0, -6, .55)
        holem = cv.mask_from(circle(fc, hr * hole[0], hr * hole[1]))
        bl = []
        for az, el in bangs:
            bp, v = c.sph(az, el + 8, 1.0)
            if v > -.2: bl.append(circle(bp, hr * br, hr * br * .88))
        if bl: holem = ImageChops.subtract(holem, cv.mask_from(bl))
        capm = ImageChops.subtract(capm, holem)
    m = cv.part(None, rp, mask=capm, lw=1.1, shade=.2, hl=.14, **({} if rp in ("P","S") else {"tm": (1, 0), "ink": NEU_INK}))
    back = fv(c) < -.35
    for az in (-30, 0, 30):
        a, va = c.sph(az + 180 if back else az, 58, 1.05); b, vb = c.sph(az + 180 if back else az, 32, 1.05)
        if va > -.6: cv.line([a, b], "P2", .6, clip=m, alpha=200)
    if part_line is not None:
        a, _ = c.sph(part_line, 80, 1.08); b, v = c.sph(part_line, 40, 1.08)
        if v > -.2: cv.line([a, b], "P3", .7, clip=m)
    return m

def blob3(c, off, rx, ry=None, rp="P", lw=1.0, crown=False, back=None, seed=0):
    """queue a hair mass at head-relative 3D offset"""
    p3 = c.hoff(*off); pt, v = c.P(p3)
    if back is None: back = v < hv(c) - .5
    def f(): c.cv.part(circle(pt, rx, ry or rx, wob=.07, seed=seed), rp, lw=lw, shade=.22, hl=.12)
    c.add(v, f, back=back)

def tube3(c, a, b, r0, r1, rp="P", back=None, ties=None):
    a3, b3 = c.hoff(*a), c.hoff(*b); va, vb = c.P(a3)[1], c.P(b3)[1]; v = (va + vb) / 2
    if back is None: back = v < hv(c) - .5
    def f():
        c.cv.part(c.tube(a3, b3, r0, r1), rp, lw=1.0, shade=.22, hl=.12)
        if ties: c.cv.part(circle(c.p(c.lerp3(a3, b3, ties)), r0 * .75, r0 * .55), "berry", lw=.7)
    c.add(v, f, back=back)

def chain3(c, pts, r, rp="P", back=None):
    for i, (o, rr) in enumerate(zip(pts, r)): blob3(c, o, rr, rr * .9, rp, back=back, seed=i)

HAIR = {}
def hair(name):
    def deco(fn): HAIR[name] = fn; return fn
    return deco

def cap_item(c, **kw):
    c.add(hv(c) + 2.0, lambda: hair_cap(c, **kw))

@hair("buzz")
def _(c, hat):
    def f():
        m = hair_cap(c, sc=1.03, bangs=(), hole=(1.0, .9), dz=.6, wob=.02)
        for i in range(14):
            a, v = c.sph(-160 + i * 25, 30 + (i % 3) * 15, 1.02)
            if v > -.3: c.cv.fill(circle(a, .4), "P3", clip=m, alpha=160)
    c.add(hv(c) + 2, f)
@hair("pixie")
def _(c, hat):
    cap_item(c, sc=1.08, bangs=((-40, 28), (-20, 24), (2, 22)), br=.36)
    blob3(c, (0, -9, -5), 6.5, 4.5)
@hair("bob")
def _(c, hat):
    cap_item(c, sc=1.12, bangs=((-36, 24), (-12, 22), (12, 22), (36, 24)), br=.36)
    for s in (-1, 1): blob3(c, (s * 10.2, -3.5, -5), 5.2, 7.0)
    blob3(c, (0, -7, -4), 10.5, 8)
@hair("long")
def _(c, hat):
    cap_item(c, sc=1.12, bangs=((-40, 30), (-14, 34), (14, 30), (40, 34)))
    blob3(c, (0, -8, -9), 10, 12)
    for s in (-1, 1): tube3(c, (s * 10, -3.2, -2), (s * 10.6, -2.2, -15), 3.6, 2.8)
@hair("ponytail")
def _(c, hat):
    cap_item(c, sc=1.08, bangs=((-30, 32), (0, 36), (30, 32)))
    blob3(c, (0, -10.5, 4), 4.2, 3.6)
    tube3(c, (0, -12, 3), (0, -15, -13), 4.4, 2.6, ties=.08)
@hair("pigtails")
def _(c, hat):
    cap_item(c, sc=1.08, part_line=0)
    for s in (-1, 1): tube3(c, (s * 11, -2.5, 1), (s * 14, -1, -11), 3.9, 2.6, ties=.08, back=False)
@hair("bun")
def _(c, hat):
    cap_item(c, sc=1.06, bangs=((-30, 36), (30, 36)), br=.3)
    if not hat:
        blob3(c, (0, -4, 13.5), 6.2, 5.6, back=False)
        def tie(): c.cv.part(circle(c.p(c.hoff(0, -4, 9.6)), 3.6, 1.5), "berry", lw=.7)
        c.add(hv(c) + 2.1, tie)
@hair("afro")
def _(c, hat):
    big = not hat
    blob3(c, (0, -2, 4 if big else 0), 16.5 if big else 13.5, 15.5 if big else 13, back=True, lw=1.1)
    def f():
        m = hair_cap(c, sc=1.14, bangs=((-34, 32), (-10, 38), (14, 36), (38, 30)), br=.36, wob=.12)
    c.add(hv(c) + 2, f)
@hair("spiky")
def _(c, hat):
    cap_item(c, sc=1.07, bangs=((-40, 26), (-12, 30), (16, 26), (42, 30)), br=.3)
    if not hat:
        def sp():
            K = c.K; base = c.hoff(0, -1, 9)
            for i, (az, el) in enumerate([(-150, 40), (-60, 55), (0, 70), (60, 55), (150, 40), (-110, 50), (110, 50), (180, 55)]):
                p, v = c.sph(az, el, 1.05); tip, _ = c.sph(az, el + 10, 1.65)
                if v < -.85: continue
                dx, dy = tip[0] - p[0], tip[1] - p[1]; L = math.hypot(dx, dy) or 1; nx, ny = -dy / L * 3.2, dx / L * 3.2
                c.cv.part([(p[0] + nx, p[1] + ny), tip, (p[0] - nx, p[1] - ny)], "P", lw=1.0, shade=.25, hl=.15)
            hair_cap(c, sc=1.07, bangs=((-40, 26), (-12, 30), (16, 26), (42, 30)), br=.3)
        c.items = [it for it in c.items if not (it[0] == hv(c) + 2.0)]
        c.add(hv(c) + 2, sp)
@hair("mohawk")
def _(c, hat):
    def f():
        hair_cap(c, sc=1.02, bangs=(), hole=(1.0, .92), dz=.4, wob=.02, rp=[NEU[1], NEU[2], NEU[3], NEU[3]])
        if not hat:
            for i, az in enumerate(range(-20, 200, 22)):
                p, v = c.sph(az, 62 if az < 150 else 40, 1.12)
                c.cv.part(circle(p, 3.8, 4.6, wob=.08, seed=i), "P", lw=1.0, shade=.25, hl=.18)
    c.add(hv(c) + 2, f)
@hair("braid")
def _(c, hat):
    cap_item(c, sc=1.08, part_line=-25, bangs=((-40, 32), (40, 32)))
    chain3(c, [(0, -11.5, -1 - i * 3.4) for i in range(6)], [3.8, 3.6, 3.4, 3.1, 2.8, 2.4])
    def tie():
        p, v = c.P(c.hoff(0, -11.5, -20.5))
        c.cv.part(circle(p, 2.2, 1.5), "berry", lw=.7)
    c.add(c.P(c.hoff(0, -11.5, -20))[1] + .1, tie, back=c.P(c.hoff(0, -11.5, -20))[1] < hv(c) - 2.5)
@hair("curtains")
def _(c, hat):
    cap_item(c, sc=1.1, bangs=((-60, 10), (-34, 26), (34, 26), (60, 10)), br=.42, part_line=0)
    for s in (-1, 1): blob3(c, (s * 10.4, -3, -4), 4.4, 6.6)
    blob3(c, (0, -7, -2), 10, 8)
@hair("curly")
def _(c, hat):
    cap_item(c, sc=1.14, bangs=((-44, 26), (-20, 32), (4, 34), (28, 30), (48, 24)), br=.34, wob=.14)
    for i, (x, y, z) in enumerate([(-10, -3, -4), (10, -3, -4), (-7, -8, -8), (7, -8, -8), (0, -10, -3), (-11, 1, -9), (11, 1, -9)]):
        blob3(c, (x, y, z), 4.3, 4.0, seed=i)
    if not hat:
        for i, (x, y, z) in enumerate([(-6, -2, 10), (5, 0, 11), (0, -6, 10)]): blob3(c, (x, y, z), 4.6, 4.2, back=False, seed=9 + i)
@hair("sidepart")
def _(c, hat):
    cap_item(c, sc=1.08, bangs=((-50, 20), (-30, 30), (-8, 38), (14, 42)), br=.4, part_line=35)
    if not hat: blob3(c, (-3, 4, 10), 7, 4.5, back=False)

# ---- ADR-114 starter styles
@hair("wavy")
def _(c, hat):
    cap_item(c, sc=1.12, bangs=((-44, 24), (-16, 30), (12, 32), (40, 26)), br=.38, wob=.1)
    for i, (x, y, z) in enumerate([(-10.5, -3, -5), (10.5, -3, -5), (-9.5, -1, -10), (9.5, -1, -10), (0, -9, -6), (-5, -9, -11), (5, -9, -11)]):
        blob3(c, (x, y, z), 4.2, 4.6, seed=20 + i)
@hair("topknot")
def _(c, hat):
    cap_item(c, sc=1.05, bangs=((-34, 30), (34, 30)), br=.28, part_line=0)
    if not hat:
        blob3(c, (0, -1, 13), 4.4, 4.0, back=False, seed=31)
        def tie(): c.cv.part(circle(c.p(c.hoff(0, -1, 9.6)), 2.8, 1.2), "cloth_teal", lw=.7)
        c.add(hv(c) + 2.1, tie)
@hair("space_buns")
def _(c, hat):
    cap_item(c, sc=1.07, bangs=((-38, 30), (-12, 34), (12, 34), (38, 30)), br=.32, part_line=0)
    if not hat:
        for s in (-1, 1): blob3(c, (s * 8.5, -2, 10.5), 4.6, 4.3, back=False, seed=40 + s)
@hair("shag")
def _(c, hat):
    cap_item(c, sc=1.13, bangs=((-50, 20), (-26, 34), (0, 38), (26, 34), (50, 20)), br=.42, wob=.14)
    for i, (x, y, z) in enumerate([(-10.5, -2.5, -3), (10.5, -2.5, -3), (-8, -8, -6), (8, -8, -6), (0, -10.5, -5)]):
        blob3(c, (x, y, z), 4.6, 5.4, seed=50 + i)

HAIR_NO_SCALP = {"mohawk"}                      # shaved sides are the style
def scalp_cover(c, rk=1.035):
    """skull cover under every style (bug: bald scalp showed through cap gaps on side/back facings): the head sphere
    above the hairline (front) / around the ears (sides) / to the nape (back); the style's cap and masses draw over it."""
    cv = c.cv; pts = []; sd = c.nv(1, 0); vf = c.nv(0, 1)
    for el in range(-24, 91, 5):
        for az in range(-180, 180, 5):
            fr = math.cos(math.radians(az)); lim = 34 if fr > .35 else (6 if fr > -.15 else -22)
            if el < lim: continue
            e = math.radians(el); vis = math.cos(e) * (math.sin(math.radians(az)) * sd + fr * vf) + math.sin(e) * .55
            if vis < -.02: continue
            p, _ = c.sph(az, el, rk); pts.append(circle(p, 1.2))
    if pts: cv.no_g = True; cv.part(None, "P", mask=cv.mask_from(pts), lw=1.0, shade=.2, hl=.1); cv.no_g = False
def eye_clear(c):
    """bangs/fringe never cover the eyes on front and 3/4 facings: cut the hair layer above the eye line, inked rim"""
    if fv(c) < -.3: return
    cv = c.cv; E = []; c.fdy = FACE_LIFT.get(c.K["d"], 0.0)
    try:
        for az in (-30, 30):
            p, v = c.sph(az, -8, 1.0)
            if v <= .12: continue
            sq = max(.35, min(1, v * 1.2)); E.append(circle((p[0], p[1] - .3), 3.3 * sq + .7, 4.2))
    finally: c.fdy = 0.0
    if not E: return
    m = cv.mask_from(E); hair_a = cv.img.getchannel("A")
    if not np.any((np.asarray(m) > 0) & (np.asarray(hair_a) > 0)): return
    for e in E:                                   # ink only the upper arc (cut fringe edge), not a ring around the eye
        cy = sum(q[1] for q in e) / len(e); k0 = min(range(len(e)), key=lambda i: e[i][1])
        rot = e[k0:] + e[:k0]; arc = [q for q in rot[len(rot) // 2:] + rot[:len(rot) // 2] if q[1] <= cy]
        if len(arc) > 2: cv.line(sorted(arc), INK[3], .9, clip=hair_a)
    cv.erase(m)
def draw_hair(c, spec, hat=False):
    c.cv.cel = True; c.cv.pal = []   # solid cel-shaded hair (no airbrush gradients)
    if spec["style"] not in HAIR_NO_SCALP: c.add(hv(c) + 1.95, lambda: scalp_cover(c, 1.06 if spec["style"] == "buzz" else 1.035))  # buzz cap is the tightest
    HAIR[spec["style"]](c, hat)
    c.add(1e9, lambda: eye_clear(c))

# ============================================================ HATS
HAT_DZ = 3.6
def hz(c, x, y, z): return c.hoff(x, y, z + HAT_DZ)
def brim(c, z, r, rs=None, rp="P", dy=0, curl=0.0, lw=1.0):
    pts = c.disc(hz(c, 0, dy, z), r, 36, rs)
    if curl:
        pts = [(x, y - curl * abs(math.sin(i / 36 * 2 * math.pi + c.rig.p)) ) for i, (x, y) in enumerate(pts)]
    return c.cv.part(pts, rp, lw=lw, shade=.2, hl=.1)
def crown(c, discs, rp="P", lw=1.05, gloss=False):
    return c.cv.part(c.solid([(hz(c, *o), r) for o, r in discs]), rp, lw=lw, shade=.24, hl=.14)
def band(c, m, z0, z1, r, rp="S"):
    pts = c.solid([(hz(c, 0, 0, z0), r), (hz(c, 0, 0, z1), r)])
    c.cv.part(pts, rp, lw=.6, clip=m, shade=.25, hl=.1, outline=False)

def h_straw(c):
    brim(c, 4.5, 17.5, rp="thatch"); m = crown(c, [((0, -.5, 4), 9.6), ((0, -.5, 11.5), 8.4)], "thatch")
    band(c, m, 4.4, 6.8, 9.7)
    for i in range(3):
        p, _ = c.P(hz(c, -3 + i * 3, 0, 8)); c.cv.line([(p[0] - 2, p[1]), (p[0] + 2, p[1] + 1)], ramp("thatch")[2], .5, clip=m)
def h_beanie(c):
    m = crown(c, [((0, -.5, -.5), 12.4), ((0, -.5, 5), 11.6), ((0, -.5, 10.5), 9), ((0, -.5, 13), 4.5)])
    for k in range(-3, 4):
        a, _ = c.sph(k * 22 + (0 if fv(c) > -.3 else 180), 10, 1.12); b, _ = c.sph(k * 22 + (0 if fv(c) > -.3 else 180), 55, 1.1)
        c.cv.line([a, b], "P2", .6, clip=m)
    bm = c.cv.part(c.solid([(hz(c, 0, -.5, -1), 13.2), (hz(c, 0, -.5, 2.6), 13.2)]), "S", lw=1.0)
    c.cv.part(circle(c.p(hz(c, 0, -.5, 15.5)), 3.8, 3.5, wob=.15), "S", lw=1.0, shade=.25, hl=.2)
def h_cap(c):
    vis = c.P(hz(c, 0, 12, 2.5))[1] > hv(c)
    def visor(): c.cv.part(c.disc(hz(c, 0, 10.5, 2.6), 7.6, 30, 6.4), "S", lw=1.0, shade=.25)
    if not vis: visor()
    m = crown(c, [((0, -.3, 1.5), 12.6), ((0, -.3, 7), 11), ((0, -.3, 11.5), 6.5)])
    p, _ = c.P(hz(c, 0, -.3, 13)); c.cv.part(circle(p, 1.6, 1.2), "S", lw=.6)
    if vis: visor()
def h_cowboy(c):
    pts = c.disc(hz(c, 0, 0, 4.5), 18.5, 36, 15)
    c.cv.part(pts, "P", lw=1.05, shade=.2, hl=.12)
    m = crown(c, [((0, 0, 4.3), 9.4), ((0, 0, 11.5), 8.8), ((0, 0, 13.5), 7.2)])
    p, _ = c.P(hz(c, 0, 0, 13.5)); c.cv.line([(p[0] - 3, p[1]), (p[0] + 3, p[1])], "P3", .7, clip=m)
    band(c, m, 4.3, 6.6, 9.5)
def h_top(c):
    brim(c, 5.5, 14.5); m = crown(c, [((0, 0, 5.5), 9), ((0, 0, 20), 9.4)])
    band(c, m, 5.5, 8.5, 9.1)
    fp, v = c.P(hz(c, 8, 3, 7))
    if c.nv(1, .3) > -.2: c.cv.part(circle(fp, 2.6, 2.4, wob=.2), "flower_pink", lw=.8); c.cv.fill(circle(fp, .9), ramp("gold")[1])
def h_bucket(c):
    c.cv.part(c.solid([(hz(c, 0, 0, 1.5), 15.5), (hz(c, 0, 0, 4.5), 12)]), "P", lw=1.05, shade=.2, hl=.1)
    m = crown(c, [((0, 0, 4), 11.2), ((0, 0, 11.5), 10), ((0, 0, 12.5), 8.5)])
    for z in (5.5, 9):
        pts = c.disc(hz(c, 0, 0, z), 11.1 - (z - 5) * .15, 40); c.cv.line(pts[5:20] if fv(c) < 0 else pts, "S1", .5, clip=m, alpha=230)
def h_wizard(c):
    brim(c, 4.5, 16.5)
    m = crown(c, [((0, 0, 4.3), 10.4), ((0, -1, 12), 7), ((0, -3, 20), 3.6), ((0, -6, 27), .8)])
    band(c, m, 4.3, 7.5, 10.6)
    for i, (x, z) in enumerate([(-3.5, 12), (2.5, 18), (2, 8.5)]):
        p, _ = c.P(hz(c, x, 3, z))
        if c.nv(0, 1) > -.15: star(c, p[0], p[1], 2.7 - .3 * i, "gold", rot=i * .4)
def h_frog(c):
    K = c.K; cv = c.cv; hr = K["hr"]
    hp = c.p(c.hoff(0, -.8, 1.2)); capm = cv.mask_from(circle(hp, hr * 1.22, hr * 1.16, wob=.05, seed=5))
    capm = ImageChops.add(capm, cv.mask_from(c.solid([(c.hoff(0, -1, -9), 11), (c.hoff(0, -1, -4), 13)])))
    if fv(c) > -.35:
        fc, _ = c.sph(0, -6, .6); capm = ImageChops.subtract(capm, cv.mask_from(circle(fc, hr * 1.0, hr * .94)))
    m = cv.part(None, "P", mask=capm, lw=1.15, shade=.22, hl=.14)
    for s in (-1, 1):
        p, v = c.sph(s * 38, 62, 1.18)
        cv.part(circle(p, 4.2, 4.0), "P", lw=1.0, shade=.2, hl=.15)
        if c.nv(s * .3, 1) > -.4:
            cv.part(circle((p[0], p[1] - .4), 2.8, 2.7), "cloth_cream", lw=.6, shade=.1, hl=0)
            cv.fill(circle((p[0] + .3 * s, p[1]), 1.3, 1.6), INK[3])
    if fv(c) > -.35:
        for s in (-1, 1):
            p, v = c.sph(s * 48, -30, 1.1)
            if v > 0: cv.fill(circle(p, 2, 1.2), "S1", clip=m, tm=(0, 1))
def h_viking(c):
    def horn(s):
        pts = []
        for i in range(9):
            t = i / 8; a = c.p(hz(c, s * (10 + t * 6), -1, 4 + t * t * 11)); pts.append((a, 2.8 * (1 - t) + .4))
        poly = []
        for i in range(len(pts) - 1): poly.append(capsule_pts(pts[i][0][0], pts[i][0][1], pts[i + 1][0][0], pts[i + 1][0][1], pts[i][1], pts[i + 1][1], n=10))
        c.cv.part(poly, "cloth_cream", lw=1.0, shade=.25, hl=.15)
    order = sorted((-1, 1), key=lambda s: c.nv(s, 0))
    horn(order[0])
    m = crown(c, [((0, 0, 1.2), 12.8), ((0, 0, 7), 11.2), ((0, 0, 11), 7.5), ((0, 0, 13), 3)])
    band(c, m, 1.2, 4, 12.9); band(c, m, 1.2, 13, 1.6)
    for k in (-2, 0, 2):
        p, v = c.sph(k * 25 + (0 if fv(c) > 0 else 180), 9, 1.13)
        if v > 0: c.cv.fill(circle(p, .8), "S0", clip=m, tm=(0, 1))
    horn(order[1])
def h_mush(c):
    c.cv.part(c.solid([(hz(c, 0, 0, 2.5), 12.5), (hz(c, 0, 0, 4), 12.5)]), "cloth_cream", lw=.9)
    m = crown(c, [((0, 0, 3.5), 16.5), ((0, 0, 8), 14), ((0, 0, 12.5), 8), ((0, 0, 14), 3)])
    for i, (az, el, r) in enumerate([(-30, 30, 2.6), (35, 45, 2.2), (0, 70, 2.8), (100, 30, 2.4), (-110, 35, 2.4), (170, 50, 2.6), (-170, 25, 2.0)]):
        a, e = math.radians(az), math.radians(el); o = (14 * math.sin(a) * math.cos(e), 14 * math.cos(a) * math.cos(e), 3.5 + 10 * math.sin(e))
        p, v = c.P(hz(c, *o)); vis = c.nv(math.sin(a), math.cos(a))
        if vis > -.1: c.cv.part(circle(p, r * (.6 + .4 * vis), r * .8, wob=.1, seed=i), "S", lw=.5, clip=m, shade=.15, hl=0, outline=False)
def h_chef(c):
    m0 = c.cv.part(c.solid([(hz(c, 0, 0, 3.2), 12.2), (hz(c, 0, 0, 8.2), 12.2)]), "S", lw=1.0, shade=.2, hl=.1)
    for i, (x, y, z, r) in enumerate([(-6, -2, 11, 7.5), (6, -2, 11, 7.5), (0, -5, 13, 8), (0, 3, 12, 8)]):
        if (c.P(hz(c, x, y, z))[1] > hv(c)) == (i == 3) or i < 3:
            pass
    pts = sorted([(x, y, z, r) for x, y, z, r in [(-6, -2, 14, 7.5), (6, -2, 14, 7.5), (0, -5, 16, 8), (0, 3, 15, 8)]], key=lambda q: c.P(hz(c, q[0], q[1], q[2]))[1])
    for i, (x, y, z, r) in enumerate(pts):
        c.cv.part(circle(c.p(hz(c, x, y, z)), r, r * .85, wob=.08, seed=i), "P", lw=1.0, shade=.22, hl=.18)

def h_helmet(c):   # ADR-135 armor_head: iron dome, brow band, rivets, nasal guard, cheek plates
    K = c.K; cv = c.cv
    for sd in (-1, 1):
        p, v = c.sph(sd * 70, -25, 1.12)
        if v > -.6: cv.part(circle(p, 3.6, 5.2, wob=.04), "iron", lw=.9, shade=.25, hl=.12)
    m = crown(c, [((0, -.3, 1.2), 13.0), ((0, -.3, 7), 11.4), ((0, -.3, 11), 7.8), ((0, -.3, 13.5), 3.4)], "iron")
    band(c, m, 1.2, 3.8, 13.2, "S"); band(c, m, 1.2, 14, 1.4, "iron")
    for k in range(-3, 4):
        p, v = c.sph(k * 30 + (0 if fv(c) > 0 else 180), 9, 1.14)
        if v > 0: cv.fill(circle(p, .55), ramp("iron")[0], clip=m)
    if fv(c) > -.2:
        p, _ = c.sph(0, 8, 1.14); q, _ = c.sph(0, -14, 1.1)
        cv.part(c.tube(c.hoff(0, 12.5, -1.5 + HAT_DZ * 0), c.hoff(0, 12.8, -8), .9, .7) if False else [(p[0] - 1, p[1]), (p[0] + 1, p[1]), (q[0] + .7, q[1]), (q[0] - .7, q[1])], "iron", lw=.7, shade=.2, hl=.15)
def h_fur_hat(c):   # furhat: fur ushanka with ear flaps, tinted crown cloth
    cv = c.cv
    for sd in (-1, 1):
        p, v = c.sph(sd * 80, -18, 1.15)
        if v > -.7: cv.part(circle(p, 3.8, 5.6, wob=.12, seed=sd + 3), "fur_brown", lw=.9, shade=.22, hl=.1)
    crown(c, [((0, -.5, 4), 12.2), ((0, -.5, 10), 10.6), ((0, -.5, 13.5), 7)])
    cv.part(c.solid([(hz(c, 0, -.5, 1), 13.3), (hz(c, 0, -.5, 5), 13.5)]), "fur_brown", lw=1.0, shade=.22, hl=.12)
def h_leather_cap(c):   # leathercap: close coif with seams + chin strap
    cv = c.cv
    m = crown(c, [((0, -.5, 1.2), 12.8), ((0, -.5, 7), 11.2), ((0, -.5, 11), 7.8), ((0, -.5, 13), 3.4)], "leather")
    band(c, m, 1.2, 2.6, 12.9, "P")
    for k in (-1, 1):
        a, _ = c.sph(k * 30 + (0 if fv(c) > 0 else 180), 15, 1.12); b, v = c.sph(k * 20 + (0 if fv(c) > 0 else 180), 75, 1.1)
        if v > -.3: cv.line([a, b], "S1", .45, clip=m)
def h_hood(c):   # hood: cloth hood (hides hair), face opening, drape
    K = c.K; cv = c.cv; hr = K["hr"]
    hp = c.p(c.hoff(0, -1, 1.5)); capm = cv.mask_from(circle(hp, hr * 1.2, hr * 1.17, wob=.05, seed=7))
    capm = ImageChops.add(capm, cv.mask_from(c.solid([(c.hoff(0, -1.5, -10), 12), (c.hoff(0, -1, -4), 13.5)])))
    if fv(c) > -.35:
        fc, _ = c.sph(0, -8, .6); capm = ImageChops.subtract(capm, cv.mask_from(circle(fc, hr * .92, hr * .9)))
    m = cv.part(None, "P", mask=capm, lw=1.15, shade=.24, hl=.12)
    if fv(c) > -.35:
        fc, _ = c.sph(0, -8, .6); cv.line(circle(fc, hr * .93, hr * .91)[2:-2] if False else circle(fc, hr * .93, hr * .91), "S1", .8, clip=m, tm=(0, 1))
    else:
        p, _ = c.sph(180, 30, 1.18); q, _ = c.sph(180, -40, 1.15); cv.line([p, q], "P3", .5, clip=m)

HATS = dict(helmet=h_helmet, fur_hat=h_fur_hat, leather_cap=h_leather_cap, hood=h_hood, straw=h_straw, beanie=h_beanie, cap=h_cap, cowboy=h_cowboy, top_hat=h_top, bucket=h_bucket, wizard=h_wizard,
            frog_hood=h_frog, viking=h_viking, mushroom_cap=h_mush, chef=h_chef)
import gear_parts
HATS.update(gear_parts.hats(__import__(__name__)))
def draw_hat(c, spec):
    c.add(hv(c) + 3, lambda: HATS[spec["style"]](c))

# ============================================================ TOPS
def tsurf(c, az, dz, k=1.0):
    K = c.K; a = math.radians(az); B = K["B"]
    return c.p(c.off(K["tc"], math.sin(a) * B["trx"] * k, math.cos(a) * B["trx"] * .8 * k, dz)), c.nv(math.sin(a), math.cos(a))

def draw_top(c, spec):
    K = c.K; B = K["B"]; cv = c.cv; S = spec
    grow = S.get("grow", .9); hem = S.get("hem")  # hem: (dz below waist, flare radius)
    if K["anim"] in ("block", "block_hit"): grow += .45  # cloth pulls across the raised shoulders
    sl = S.get("sleeve", "short"); sr = B["arm"] + S.get("sleeve_grow", 1.2)
    tl = {"none": 0, "short": .42, "long": .93}[sl]
    state = {}
    def sleeve(side, after=False):
        a, b = K["sh"][side], K["hand"][side]
        if tl == 0: return
        e = c.lerp3(a, b, tl)
        cv.part(c.tube(c.off(a, 0, 0, .8), e, sr + .4, sr), S.get("sm", "P"), lw=1.0, shade=.25, hl=.12)
        if S.get("pauldron"): cv.part(circle(c.p(c.lerp3(a, b, .08)), sr + 1.6, sr + .9, wob=.04), S["pauldron"] if isinstance(S["pauldron"], str) else "iron", lw=.9, shade=.25, hl=.15)
        if S.get("cuff"):
            cp = c.lerp3(a, b, tl - .02); q = c.p(cp); cv.part(circle(q, sr + .3, sr * .7), "S", lw=.8)
        if S.get("sleevehem") and not S.get("cuff"):
            q = c.p(c.lerp3(a, b, tl - .03)); cv.part(circle(q, sr + .35, sr * .55), "S", lw=.7, shade=.15, hl=0)
        if S.get("quilt"):
            for t in (.3, .6):
                q = c.p(c.lerp3(a, e, t)); cv.line([(q[0] - sr, q[1]), (q[0] + sr, q[1] + .5)], "S3", .7, alpha=220, tm=(0, 1))
    def torso():
        polys = [c.torso_pts(grow)]
        if hem:
            dz, fr = hem; hc = K["hipc"]
            polys.append(c.solid([(c.off(K["tc"], 0, 0, -3), B["trx"] * .85 + grow), (c.off(hc, 0, 0, -dz), fr)]))
        if S.get("hood"):
            hp = c.off(K["tc"], 0, -B["trx"] * .6, 8.5)
            if c.P(hp)[1] < K["tv"]: cv.part(c.solid([(hp, 7.5), (c.off(hp, 0, -1, 2.5), 6)]), "P", lw=1.0)
        m = cv.part(polys, S.get("pm", "P"), lw=1.1, shade=.24, hl=.12); state["m"] = m
        if S.get("plates"):   # ADR-135 cuirass: lames + rivets + tinted tabard strip
            for z in (-6.5, -3, .5):
                pts = c.disc(c.off(K["tc"], 0, 0, z), B["trx"] + grow + .2, 40); cv.line(pts[0:20] if fv(c) > -.25 else pts[20:40], ramp(S["pm"] if S.get("pm", "P") not in ("P", "S") else "iron")[3], .6, clip=m)
            if fv(c) > -.25:
                p, _ = tsurf(c, 0, 5.5, .95); q, _ = tsurf(c, 0, -9, 1.0)
                cv.part([(p[0] - 1.8, p[1]), (p[0] + 1.8, p[1]), (q[0] + 2.4, q[1]), (q[0] - 2.4, q[1])], "P", clip=m, lw=.6, shade=.2, hl=.05)
            for az in (-50, 50):
                p, v = tsurf(c, az, 6, .95)
                if v > 0: cv.fill(circle(p, .55), ramp("iron")[0], clip=m)
            if S.get("tier"):
                p, v = tsurf(c, 0 if fv(c) > -.25 else 180, 1.5, .9); gear_parts.marks(c, S["tier"], p, 3.0, m, vertical=True)
        if S.get("furtrim"):
            cv.part(c.solid([(c.off(K["tc"], 0, -.5, 6.5), B["trx"] * .75 + 1.5), (c.off(K["tc"], 0, -.5, 8.5), B["trx"] * .6 + 1)]), "fur_brown", lw=.9, shade=.2, hl=.1)
        f = fv(c)
        st = S.get("style")
        if st == "stripes":
            for i, z in enumerate(range(-10, 8, 4)):
                pts = c.disc(c.off(K["tc"], 0, 0, z), B["trx"] + 3, 30)
                pts2 = c.disc(c.off(K["tc"], 0, 0, z + 1.8), B["trx"] + 3, 30)
                cv.part(hull(pts + pts2), "S", clip=m, outline=False, shade=.25, hl=.0)
        if st == "plaid":
            for z in range(-8, 8, 4):
                cv.part(hull(c.disc(c.off(K["tc"], 0, 0, z), B["trx"] + 3, 30) + c.disc(c.off(K["tc"], 0, 0, z + 1.2), B["trx"] + 3, 30)), "S", clip=m, outline=False, shade=.2, hl=0)
            for az in range(-160, 180, 40):
                a, v = tsurf(c, az, 9); b, _ = tsurf(c, az, -9)
                if v > -.2: cv.line([a, b], "S3", .8, clip=m, alpha=200)
        if st == "quilt":
            for z in (-5, -1, 3):
                pts = c.disc(c.off(K["tc"], 0, 0, z), B["trx"] + grow, 40); cv.line(pts[0:20], "S3", .75, clip=m, alpha=225, tm=(0, 1))
        if f > -.25:
            if S.get("collar") == "round":
                p, _ = tsurf(c, 0, 6.8, .55); cv.line([(p[0] - 3.2, p[1] - 1.0), (p[0], p[1] + .7), (p[0] + 3.2, p[1] - 1.0)], "S1", 1.4, clip=m, tm=(0, 1))
            if S.get("collar") == "v":
                p, _ = tsurf(c, 0, 4, .9); q, _ = tsurf(c, 0, 8, .5)
                cv.part([(q[0] - 3.4, q[1] - 1), (p[0], p[1]), (q[0] + 3.4, q[1] - 1)], "S", clip=m, lw=.6, shade=.2, hl=0)
            if S.get("collar") == "sailor":
                p, _ = tsurf(c, 0, 1.5, 1.0); q, _ = tsurf(c, 0, 8, .6)
                cv.part([(q[0] - 6, q[1] - 1), (p[0], p[1]), (q[0] + 6, q[1] - 1), (q[0] + 6.5, q[1] + 3.5), (p[0], p[1] + 2.5), (q[0] - 6.5, q[1] + 3.5)], "S", lw=.7, clip=m, shade=.15, hl=0)
                cv.part(circle((p[0], p[1] + .8), 1.6, 1.3), "cloth_red", lw=.6)
                cv.part([(p[0] - .5, p[1] + 1), (p[0] - 2.2, p[1] + 5), (p[0] - .2, p[1] + 4.2)], "cloth_red", lw=.5)
                cv.part([(p[0] + .5, p[1] + 1), (p[0] + 2.2, p[1] + 5), (p[0] + .2, p[1] + 4.2)], "cloth_red", lw=.5)
            if S.get("open"):  # vest/open jacket: inner shirt strip
                p, _ = tsurf(c, 0, 7.5, .9); q, _ = tsurf(c, 0, -8, .95)
                cv.part([(p[0] - 2.8, p[1]), (p[0] + 2.8, p[1]), (q[0] + 2.2, q[1]), (q[0] - 2.2, q[1])], "S", clip=m, lw=.8, shade=.2, hl=.05)
            if S.get("buttons"):
                p0, _ = tsurf(c, 0, 6.2, .97); p1, _ = tsurf(c, 0, -5.5, .98)
                cv.line([p0, p1], "S1", 1.6, clip=m, alpha=230, tm=(0, 1))
                for z in (3.5, -.5, -4.5):
                    p, v = tsurf(c, 0, z, .98)
                    cv.fill(circle(p, .85), "S2", clip=m, tm=(0, 1))
            if S.get("pocket"):
                p, _ = tsurf(c, 0, -5, .95)
                cv.part([(p[0] - 4, p[1] - 1.5), (p[0] + 4, p[1] - 1.5), (p[0] + 5, p[1] + 2.5), (p[0] - 5, p[1] + 2.5)], "S", clip=m, lw=.7, shade=.2, hl=.0)
            if S.get("strings"):
                for s in (-1, 1):
                    p, _ = tsurf(c, s * 14, 6.5, .9); cv.line([p, (p[0] + s * .3, p[1] + 4)], "S1", .7, clip=m)
            if S.get("bib"):  # pinafore apron bib + frill
                p, _ = tsurf(c, 0, 5.5, .95); q, _ = tsurf(c, 0, -6, 1.0)
                cv.part([(p[0] - 4, p[1]), (p[0] + 4, p[1]), (q[0] + 5, q[1]), (q[0] - 5, q[1])], "S", clip=m, lw=.7, shade=.2, hl=.1)
            if S.get("tank"):
                p, _ = tsurf(c, 0, 7.5, .6); cv.line([(p[0] - 3.5, p[1] - 1.2), (p[0], p[1] + 1.4), (p[0] + 3.5, p[1] - 1.2)], "S1", 1.4, clip=m, tm=(0, 1))
        if S.get("belt"):
            pts = hull(c.disc(c.off(K["tc"], 0, 0, -5.2), B["trx"] + grow + .4, 30) + c.disc(c.off(K["tc"], 0, 0, -3.2), B["trx"] + grow + .4, 30))
            cv.part(pts, "S", clip=m, lw=.7, shade=.25, hl=.1)
            if f > -.25:
                p, _ = tsurf(c, 0, -4.2, 1.05); cv.part(circle(p, 1.6, 1.3), "gold", lw=.6)
        if S.get("frill") and hem:
            dz, fr = hem; pts = c.disc(c.off(K["hipc"], 0, 0, -dz + .4), fr - .2, 30)
            cv.part(hull(pts + c.disc(c.off(K["hipc"], 0, 0, -dz + 1.8), fr - .6, 30)), "S", clip=m, outline=False, shade=.1, hl=0)
        if tl == 0 and not S.get("tank"):
            pass
    c.add(K["tv"] + .02, torso)
    for side in (-1, 1):
        if not K["front"][side]:
            a, b = K["sh"][side], K["hand"][side]; d = max(c.P(a)[1], c.P(b)[1]) - .5
            c.add(min(d, K["tv"] - .01), lambda side=side: sleeve(side))
    if S.get("hood"):
        def hood_front():
            hp = c.off(K["tc"], 0, -B["trx"] * .6, 8.5)
            if c.P(hp)[1] >= K["tv"]: cv.part(c.solid([(hp, 7.5), (c.off(hp, 0, -1, 2.5), 6)]), "P", lw=1.0)
        c.add(K["tv"] + .05, hood_front)
    def front_sleeves(cc):
        for side in (-1, 1):
            if K["front"][side]: sleeve(side)
    c.extra = front_sleeves

# ============================================================ BOTTOMS
def draw_bottom(c, spec):
    K = c.K; B = K["B"]; cv = c.cv; S = spec
    L = S.get("len", .93); lr = B["leg"] + S.get("grow", .9); skirt = S.get("skirt")
    def legpiece(side):
        hip, ft = K["hips"][side], K["feet"][side]; lp = legpath(c, side)
        e = along(c, lp, L); seg = cut(c, lp, L); seg[0] = c.off(hip, 0, 0, 1)
        m = cv.part(legtubes(c, seg, lr + .3, lr * (.95 if not S.get("puff") else 1.15)), "P", lw=1.0, shade=.25, hl=.1)
        if S.get("cuff"):
            q = c.p(along(c, lp, L - .03)); cv.part(circle(q, lr + .5, 1.3), "S", lw=.8)
        if S.get("patch") and side == 1:
            q = c.p(along(c, lp, .55)); cv.part(circle(q, 2.2, 1.9, wob=.12), "S", lw=.6, clip=m, shade=.2, hl=0)
            cv.line([(q[0] - 1.6, q[1] - 1), (q[0] + 1.6, q[1] + 1)], "S3", .4, clip=m)
        if S.get("cargo"):
            q = c.p(c.off(along(c, lp, .45), side * 1.8, 0, 0)); cv.part([(q[0] - 1.8, q[1] - 2), (q[0] + 1.8, q[1] - 2), (q[0] + 1.8, q[1] + 2), (q[0] - 1.8, q[1] + 2)], "S", lw=.6, clip=m, shade=.2, hl=0)
        if S.get("seam"):
            cv.line([c.p(c.off(q3, side * lr * .7, 0, 0)) for q3 in [hip] + seg[1:]], "S1", .45, clip=m, alpha=220)
        if S.get("frill_leg"):
            q = c.p(e); cv.part(circle(q, lr + 1.2, 1.4, wob=.2), "S", lw=.7)
        if S.get("greaves"):   # ADR-137 tier greaves: chunky shin plate + knee cop + tier mark
            t = S["greaves"]; a3, b3 = along(c, lp, .58), along(c, lp, L - .02)
            g = cv.part(c.tube(a3, b3, lr + 1.1, lr + .8), t, lw=.95, shade=.25, hl=.16)
            k = c.p(along(c, lp, .5)); cv.part(circle(k, lr + 1.5, lr + 1.1, wob=.04), t, lw=.9, shade=.25, hl=.15)
            gear_parts.marks(c, t, c.p(along(c, lp, .74)), 2.2, g, vertical=True)
    if not skirt:
        for side in (-1, 1):
            hip, ft = K["hips"][side], K["feet"][side]; d = (c.P(hip)[1] + c.P(ft)[1]) / 2 - 2
            c.add(d + .01, lambda side=side: legpiece(side))
    def pelvis():
        hc = K["hipc"]
        if skirt:
            dz, fr = skirt
            # A planted guard spreads the cloth over the forward knee, rather than an idle cone.
            guard = K["anim"] in ("block", "block_hit")
            sway = 1.1 if guard else 0
            if guard: fr += .65
            m = cv.part(c.solid([(c.off(hc, 0, 0, 2.5), B["hipw"] + 3.2), (c.off(hc, 0, sway, -dz), fr)]), "P", lw=1.05, shade=.22, hl=.12)
            if S.get("plaid"):
                for z in range(int(-dz), 3, 3): cv.part(hull(c.disc(c.off(hc, 0, 0, z), fr + 1, 30) + c.disc(c.off(hc, 0, 0, z + 1), fr + 1, 30)), "S", clip=m, outline=False, shade=.1, hl=0)
            for k in range(-3, 4):
                a, v = c.P(c.off(hc, math.sin(k * .45) * (B["hipw"] + 2), math.cos(k * .45) * (B["hipw"] + 2), 0))
                b, _ = c.P(c.off(hc, math.sin(k * .45) * fr, math.cos(k * .45) * fr + sway, -dz + .5))
                if c.nv(math.sin(k * .45), math.cos(k * .45)) > 0: cv.line([a, b], "P2", .5, clip=m, alpha=200)
            if S.get("hemband"):
                cv.part(hull(c.disc(c.off(hc, 0, sway, -dz), fr, 30) + c.disc(c.off(hc, 0, sway, -dz + 1.6), fr - .4, 30)), "S", clip=m, outline=False, shade=.1, hl=0)
        else:
            m = cv.part(c.solid([(c.off(hc, 0, 0, 2.3), B["hipw"] + 3.3), (c.off(hc, 0, 0, -2.4), B["hipw"] + 2.6)]), "P", lw=1.05, shade=.22, hl=.12)
        if S.get("waist"):
            cv.part(hull(c.disc(c.off(hc, 0, 0, 1.2), B["hipw"] + 3.5, 30) + c.disc(c.off(hc, 0, 0, 2.6), B["hipw"] + 3.5, 30)), "S", clip=m, lw=.6, outline=False, shade=.2, hl=0)
    c.add(K["tv"] - .02, pelvis)

# ============================================================ SHOES
def draw_shoes(c, spec):
    K = c.K; B = K["B"]; cv = c.cv; S = spec
    def shoe(side):
        ft = K["feet"][side]; kn = K["knees"][side]; st = S["style"]
        shaft = S.get("shaft", 0)
        if shaft:
            up = legpath(c, side)[::-1]; e = along(c, up, shaft); sseg = cut(c, up, shaft); sseg[0] = c.off(ft, 0, .3, -.5)
            m = cv.part(legtubes(c, sseg, B["leg"] + 1.2, B["leg"] + S.get("flare", 1.0)), "P", lw=1.0, shade=.25, hl=.15)
            if S.get("laces"):
                for t in (.25, .55, .85):
                    q = c.p(c.off(along(c, [ft] + sseg[1:], t), 0, B["leg"], 0))
                    if c.nv(0, 1) > -.3: cv.line([(q[0] - 1.3, q[1] - .5), (q[0] + 1.3, q[1] + .5)], "S1", .6, clip=m)
            if S.get("cuffS"):
                cv.part(circle(c.p(e), B["leg"] + 1.6, 1.4), "S", lw=.8)
        L = S.get("len", 3.8); W = S.get("w", 2.7)
        sole = c.solid([(c.off(ft, 0, 1.0, -1.8), W)] + [(c.off(ft, 0, 1.0 + L * .35, -1.6), W * .95)])
        if st == "sandals":
            cv.part(sole, "S", lw=.8, shade=.2, hl=.0)
            for t in (.2, .9):
                q = c.p(c.off(ft, 0, .2 + t * 2.2, -.4)); cv.part(circle(q, W + .4, .9), "P", lw=.6, shade=.2, hl=0)
            return
        top = c.solid([(c.off(ft, 0, .8, -1.6), W + .2), (c.off(ft, 0, .2, .8), W * .9), (c.off(ft, 0, 1.0 + L * .4, -1.0), W * .75)])
        if S.get("soleLow"):   # clogs: thin wooden base under a dominant primary upper
            cv.part(hull(sole), "S", lw=.7, shade=.2, hl=0); cv.part(hull(top + c.solid([(c.off(ft, 0, 1.0 + L * .35, -1.2), W * .85)])), "P", lw=1.0, shade=.25, hl=.15)
        else: cv.part(hull(sole + top), "P", lw=1.0, shade=.25, hl=.15)
        q = c.p(c.off(ft, 0, 1.2, -2.0))
        if S.get("sole", True) and not S.get("soleLow"):
            cv.part(hull(sole + c.solid([(c.off(ft, 0, 1.0, -1.0), W + .1)])), "S" if S.get("soleS") else "cloth_cream" if st != "hiking" else "wood_dark", lw=.7, shade=.2, hl=0)
        if S.get("laces") and not shaft and c.nv(0, 1) > -.3:
            q = c.p(c.off(ft, 0, 2.0, .2)); cv.line([(q[0] - 1.2, q[1]), (q[0] + 1.2, q[1])], "S1", .6)
        if S.get("bow"):
            q = c.p(c.off(ft, 0, 2.8, -.2)); cv.part(circle((q[0] - 1, q[1]), 1, .8), "S", lw=.5); cv.part(circle((q[0] + 1, q[1]), 1, .8), "S", lw=.5)
        if S.get("swoosh"):
            a, v = c.P(c.off(ft, side * W, -.5, -.6)); b, _ = c.P(c.off(ft, side * W, 2.5, -.2))
            if c.nv(side, 0) > -.1: cv.line([a, b], "S1", .7)
        if S.get("band"):
            q = c.p(c.off(ft, 0, 1.6, -.2)); cv.part(circle(q, W + .3, .8), "S", lw=.5, shade=.2, hl=0)
        if S.get("plated"):   # ADR-137 tier boots: chunky toe cap + shaft cuff plate + tier mark
            t = S["plated"]; toe = c.p(c.off(ft, 0, 1.0 + L * .32, -.9)); cv.part(circle(toe, W * .85, W * .6, wob=.04), t, lw=.8, shade=.22, hl=.18)
            if shaft:
                cv.part(circle(c.p(e), B["leg"] + 2.0, 1.7, wob=.04), t, lw=.8, shade=.22, hl=.15)
                gear_parts.marks(c, t, c.p(along(c, up, shaft * .5)), 2.0, m, vertical=True)
        if S.get("scales") and shaft:
            for i, t3 in enumerate((.25, .5, .75)):
                q = c.p(along(c, up, shaft * t3))
                for dx in (-1.1, 1.1): cv.fill(circle((q[0] + dx + (i % 2) * .6, q[1]), .5, .4), ramp("snake")[3], clip=m)
        if st == "bunny":
            for s in (-1, 1):
                a3 = c.off(ft, s * 1.2, 2.2, .3); b3 = c.off(ft, s * 1.8, 0.6, 4.2)
                cv.part(c.tube(a3, b3, .9, 1.1), "P", lw=.7, shade=.2, hl=.1)
            q = c.p(c.off(ft, 0, 3.6, -.6))
            if c.nv(0, 1) > -.2:
                for s in (-1, 1): cv.fill(circle((q[0] + s * 1.1, q[1] - .6), .45), INK[3])
                cv.fill(circle((q[0], q[1] + .4), .5, .35), "S1", tm=(0, 1))
        if st == "mush":
            for i, (dx, dy) in enumerate([(-1, 1.5), (1.2, 2.8), (.2, .2)]):
                p = c.p(c.off(ft, dx, dy, .4)); cv.fill(circle(p, .7, .55), "S0", tm=(0, 1))
    for side in (-1, 1):
        ft = K["feet"][side]; d = (c.P(K["hips"][side])[1] + c.P(ft)[1]) / 2 - 2
        c.add(d + .02, lambda side=side: shoe(side))

# ============================================================ ACCESSORIES
GLOVES = {   # ADR-135 hands gear: (main ramp, cuff ramp, cuff length t along forearm, cuff radius +, hand radius +, extras)
    "cloth_gloves": ("P", "S", .22, .35, .35, ()), "leather_gloves": ("leather", "P", .26, .55, .4, ("stitch",)),
    "fur_mittens": ("P", "fur_brown", .3, 1.1, .75, ("mitt",)), "gauntlets": ("iron", "P", .42, 1.0, .55, ("plates",)),
}
GLOVES.update({f"{t}_gauntlets": (t, "S" if t == "composite" else "P", .44, 1.2, .65, ("plates", "tier:" + t)) for t in gear_parts.TIERS})   # ADR-137 tier gauntlets
def draw_gloves(c, st):
    K = c.K; B = K["B"]; cv = c.cv; main, cuff, t, cr, hr, ex = GLOVES[st]
    def glove(side):
        a, b = K["sh"][side], K["hand"][side]; w = c.lerp3(b, a, t); hp = c.p(b)
        cv.part(c.tube(w, b, B["arm"] + cr * .55, B["arm"] + .15), main if "plates" in ex else cuff, lw=.9, shade=.25, hl=.15)
        if "plates" in ex:   # flared cuff plate at the forearm + knuckle ridge
            cv.part(circle(c.p(w), B["arm"] + cr + .6, (B["arm"] + cr) * .7), cuff, lw=.8, shade=.25, hl=.1)
        cv.part(circle(hp, B["hand"] + hr, (B["hand"] + hr) * .95, wob=.05), main, lw=1.0, shade=.24, hl=.2 if main == "iron" else .12)
        if "plates" in ex: cv.line([(hp[0] - 1.2, hp[1] - .3), (hp[0] + 1.2, hp[1] - .3)], INK[3], .5)
        tier = next((e[5:] for e in ex if e.startswith("tier:")), None)
        if tier: gear_parts.marks(c, tier, hp, 1.8, None, vertical=False)
        if "stitch" in ex: cv.line([(hp[0] - .9, hp[1] + .5), (hp[0] + .9, hp[1] + .5)], "S1", .45, tm=(0, 1))
        if "mitt" in ex: cv.part(circle((hp[0] + .9 * side, hp[1] - .6), .9, .8), main, lw=.6, shade=.2, hl=.1)   # thumb
        if not K["front"][side]: cv.erase(cv.mask_from([c.torso_pts(.4), circle(c.p(K["hc"]), K["hr"] + .4, (K["hr"] + .4) * .96)]))
    for side in (-1, 1):
        a, b = K["sh"][side], K["hand"][side]; d = max(c.P(a)[1], c.P(b)[1]) - .5 + (.3 if side == 1 else 0)
        if K["front"][side]: d = max(d, K["tv"] + .01)
        else: d = -1e3 + side   # behind hands first so the torso cut only removes them
        c.add(d + .03, lambda side=side: glove(side))

def draw_acc(c, spec):
    K = c.K; B = K["B"]; cv = c.cv; st = spec["style"]; f = fv(c)
    if st in GLOVES: draw_gloves(c, st); return
    if st in ("round_glasses", "sunglasses", "eyepatch"):
        def g():
            if f < -.2: 
                if st == "eyepatch" or True:
                    a, va = c.sph(-80, 2, 1.02); b, vb = c.sph(80, 2, 1.02); p0, _ = c.sph(180, 8, 1.02)
                    if K["anim"] in ("block", "block_hit"):
                        # Tucked-head guard: bend the rear strap, not a static idle strap translated down.
                        mid = (p0[0], p0[1] + 1.1)
                        cv.line([a, ((a[0]+mid[0])/2, mid[1]-.6), mid,
                                 ((b[0]+mid[0])/2, mid[1]-.6), b], "P2", .7)
                    else: cv.line([a, p0, b], "P2", .7)
                return
            eyes = []
            for az in (-30, 30):
                p, v = c.sph(az, -8, 1.06); eyes.append((p, v))
            if st == "eyepatch":
                p, v = eyes[0]
                a, _ = c.sph(-80, 14, 1.02); b, _ = c.sph(80, 14, 1.02)
                cv.line([a, (p[0], p[1] - 3), b], "P3", .7)
                if v > -.1: cv.part(circle(p, 3 * max(.5, v), 3.0), "P", lw=.8, shade=.2, hl=.1)
                return
            if eyes[0][1] > .1 and eyes[1][1] > .1:
                cv.line([(eyes[0][0][0] + 2.8, eyes[0][0][1] - .6), (eyes[1][0][0] - 2.8, eyes[1][0][1] - .6)], "P3", .7)
            for az, (p, v) in zip((-30, 30), eyes):
                side, sv = c.sph(az * 3, -4, 1.0)
                if v > .05:
                    sq = max(.45, min(1, v * 1.2))
                    if st == "sunglasses":
                        cv.part(circle(p, 3.6 * sq, 2.9), "ink", lw=1.0, ink=NEU_INK, shade=.2, hl=.25)
                        cv.fill(circle((p[0] - 1.1 * sq, p[1] - 1.2), .9, .6), (255, 255, 255), alpha=180)
                        cv.line(circle(p, 3.6 * sq, 2.9, wob=0) + [circle(p, 3.6 * sq, 2.9, wob=0)[0]], "P2", .7, tm=(1, 0))
                        cv._detail(cv.mask_from([]), None)
                    else:
                        ring = circle(p, 3.3 * sq, 3.2, wob=0); cv.line(ring + [ring[0]], "P3", .8)
                        cv.fill(circle(p, 3.0 * sq, 2.9), (255, 255, 255), alpha=45)
                        cv.fill(circle((p[0] - 1 * sq, p[1] - 1.2), .7, .5), (255, 255, 255), alpha=200)
                if sv > -.5 and v > -.4:
                    cv.line([(p[0] + (3.4 if az > 0 else -3.4) * max(.3, v), p[1] - .4), side], "P3", .6)
            if st == "sunglasses":  # frames tinted: paint mask over lens rims
                m = cv.mask_from([circle(p, 3.9 * max(.45, min(1, v * 1.2)), 3.2) for p, v in eyes if v > .05])
                cv._upd(m, (1, 0), ring=False)
        c.add(hv(c) + 3, lifted(c, g))
    elif st == "scarf":
        def sc():
            z = K["bz"] + 7.4; nc = (K["tc"][0], K["tc"][1], z)
            m = cv.part(c.solid([(nc, 6.6), (c.off(nc, 0, 0, 2.6), 5.8)]), "P", lw=1.05, shade=.25, hl=.15)
            for k in (-2, 0, 2):
                a, _ = c.P(c.off(nc, k * 2, 6, 0)); cv.line([(a[0], a[1] - 2), (a[0], a[1] + 2)], "S1", .9, clip=m)
            tail = c.off(nc, 3, 5.5 if f > -.3 else -5.5, -1)
            tm2 = cv.part(c.tube(tail, c.off(tail, 1.2, .5, -8), 2.4, 2.1), "P", lw=1.0, shade=.25)
            q = c.p(c.off(tail, 1.2, .5, -6)); cv.part(circle(q, 2.6, 1.0), "S", lw=.6, clip=tm2, outline=False)
        c.add(K["tv"] + .3, sc)
    elif st in ("backpack", "cape", "satchel"):
        if st == "backpack":
            pc = c.off(K["tc"], 0, -B["trx"] * .9 - 2.5, 1.0); pv = c.P(pc)[1]
            def pk():
                m = cv.part(c.solid([(c.off(pc, 0, 0, -6), 5.8), (c.off(pc, 0, 0, 5), 5.4), (c.off(pc, 0, 0, 6.5), 4.2)]), "P", lw=1.05, shade=.25, hl=.14)
                cv.part(c.solid([(c.off(pc, 0, -2.6, -5), 3.6), (c.off(pc, 0, -2.6, -1), 3.6)]), "S", lw=.8, shade=.2, hl=.1)
                cv.part(c.solid([(c.off(pc, 0, 0, 4.5), 5.6), (c.off(pc, 0, 0, 6.5), 4.4)]), "S", lw=.8, clip=m, outline=False)
                if spec.get("frame"):   # ADR-137 frame pack: wooden poles + crossbar
                    for s in (-1, 1): cv.part(c.tube(c.off(pc, s * 5.2, -.5, -8), c.off(pc, s * 5.2, -.5, 9), .9, .9), "wood_dark", lw=.6, shade=.2, hl=.1)
                    a3 = c.off(pc, -5.2, -.5, 8); b3 = c.off(pc, 5.2, -.5, 8); cv.part(c.tube(a3, b3, .8, .8), "wood_dark", lw=.6, shade=.2, hl=.1)
                if spec.get("pouches"):   # ADR-137 tactical pack: side pouches + accent stripe
                    for s in (-1, 1): cv.part(c.solid([(c.off(pc, s * 5.6, .5, -4), 2.2), (c.off(pc, s * 5.6, .5, 0), 2.2)]), "S", lw=.7, shade=.2, hl=.1)
                    gear_parts.marks(c, "composite", c.p(c.off(pc, 0, -2, 1)), 3.0, m, vertical=True)
            c.add(pv, pk, back=pv < K["tv"])
            def straps():
                if f > -.2:
                    for s in (-1, 1):
                        a, _ = tsurf(c, s * 30, 7.5, .95); b, _ = tsurf(c, s * 40, -4, 1.02)
                        cv.part(capsule_pts(a[0], a[1], b[0], b[1], 1.1, 1.0), "S", lw=.6, shade=.2, hl=0)
            c.add(K["tv"] + .2, straps)
        if st == "cape":
            nc = c.off(K["tc"], 0, -2, 7.5); pv = c.P(c.off(nc, 0, -4, -6))[1]
            def cp():
                pts = c.solid([(nc, 7.2), (c.off(K["hipc"], 0, -3.5 + K["back"], -8.5), 10.5)])
                m = cv.part(pts, "P", lw=1.1, shade=.25, hl=.12)
                cv.part(hull(c.disc(c.off(K["hipc"], 0, -3.5 + K["back"], -8.5), 10.4, 30) + c.disc(c.off(K["hipc"], 0, -3.5 + K["back"], -7), 10, 30)), "S", clip=m, outline=False, shade=.1, hl=0)
            c.add(pv, cp, back=True)
            if spec.get("furcollar"):   # ADR-137 fur cloak: chunky fur mantle over the shoulders
                c.add(K["tv"] + .22, lambda: cv.part(c.solid([(c.off(K["tc"], 0, -.5, 6), B["trx"] + 3.2), (c.off(K["tc"], 0, -.5, 8.5), B["trx"] * .7 + 2)]), "fur_brown", lw=.9, shade=.22, hl=.1))
            def clasp():
                if f > -.2:
                    p, _ = tsurf(c, 0, 7.2, .6); cv.part(circle(p, 1.6, 1.4), "gold", lw=.6)
                    for s in (-1, 1):
                        a, _ = tsurf(c, s * 50, 7.8, 1.0); cv.line([a, p], "P2", 1.0)
            c.add(K["tv"] + .25, clasp)
        if st == "satchel":
            bc = c.off(K["hipc"], -B["hipw"] - 4.2, 1.0, 1.5); bv = c.P(bc)[1]
            def bag():
                cv.part(c.solid([(c.off(bc, 0, 0, -3), 2.6), (c.off(bc, 0, 0, 3), 2.6)]), "P", lw=1.0, shade=.25, hl=.14)
                cv.part(c.solid([(c.off(bc, -.3, 0, .5), 2.8), (c.off(bc, -.3, 0, 3.2), 2.8)]), "S", lw=.7, shade=.2, hl=.1)
            c.add(bv, bag, back=bv < K["tv"] - 1)
            def strap():
                if f > -.6:
                    a, va = tsurf(c, 40, 7.5, 1.0); b, _ = tsurf(c, -60, -6, 1.05)
                    cv.part(capsule_pts(a[0], a[1], b[0], b[1], .9, .9), "P", lw=.6, shade=.2, hl=0)
            c.add(K["tv"] + .2, strap)
    elif st == "flower":
        def fl():
            p, v = c.sph(-55, 42, 1.12)
            if v > -.7:
                for i in range(5):
                    a = i * 2 * math.pi / 5; cv.part(circle((p[0] + math.cos(a) * 2.3, p[1] + math.sin(a) * 2.0), 1.9, 1.7), "P", lw=.7, shade=.2, hl=.2)
                cv.part(circle(p, 1.4), "S", lw=.6, shade=.2, hl=.3)
        c.add(hv(c) + 4, fl)
    elif st == "cloth_mask":
        # Fitted nose/mouth panel on the FRONT of the head only. Ear loops stay
        # near the ears; back views show a small high knot, never a nape band.
        def mask():
            old = c.fdy; c.fdy = NECK
            try:
                face = fv(c)
                # Ear loops: side arcs around the ears only, not a 360° wrap.
                for el in (-18, -36):
                    for az0, az1 in ((-118, -74), (74, 118)):
                        for az in range(az0, az1, 10):
                            a, va = c.sph(az, el, 1.03)
                            b, vb = c.sph(az + 10, el, 1.03)
                            if min(va, vb) > 0.04:
                                cv.line([a, b], "S2", 0.8, tm=(0, 1))
                if face > -0.28:
                    # Keep only front-facing samples so hull() cannot swing onto the nape.
                    edge = [(a, -9 - abs(a) * .16) for a in range(-58, 59, 13)]
                    edge += [(a, -52 + abs(a) * .04) for a in range(58, -59, -13)]
                    pts = []
                    for az, el in edge:
                        p, v = c.sph(az, el, 1.075)
                        if v > 0.14:
                            pts.append(p)
                    if len(pts) >= 4:
                        panel = cv.part(hull(pts), "P", lw=1.05, shade=.22, hl=.13)
                        for fraction in (.38, .68):
                            pleat = []
                            for az in range(-50, 51, 13):
                                upper, lower = -9 - abs(az) * .16, -52 + abs(az) * .04
                                p, v = c.sph(az, upper + fraction * (lower - upper), 1.09)
                                if v > 0.16:
                                    pleat.append(p)
                            if len(pleat) > 1:
                                cv.line(pleat, "P3", .95, clip=panel, tm=(1, 0))
                elif face < -0.45:
                    # Straight back: small knot at the occiput (above the nape).
                    p, v = c.sph(180, 6, 1.035)
                    if v > 0.22:
                        cv.part(circle(p, 1.15, 1.0), "S", lw=.55, shade=.2, hl=.1)
                        cv.line([(p[0], p[1]), (p[0] - 1.3, p[1] + 1.7)], "S2", 0.7, tm=(0, 1))
                        cv.line([(p[0], p[1]), (p[0] + 1.3, p[1] + 1.3)], "S2", 0.7, tm=(0, 1))
            finally: c.fdy = old
        c.add(hv(c) + 4, mask)
    elif st == "bandana":
        # Neckerchief: big downward flap on the CHEST, small knot at the nape.
        # Back views must not show a second scarf or long hanging tails.
        def bd():
            Z = K["B"]["try_"] - .7; tc = K["tc"]
            def npt(az, dz, r):
                a = math.radians(az); return c.p(c.off(tc, math.sin(a) * r, math.cos(a) * r * .8, Z + dz))
            def vis(az):
                a = math.radians(az); return c.nv(math.sin(a), math.cos(a))
            def flap():
                l, rr, t = npt(-40, .3, 6.2), npt(40, .3, 6.2), npt(0, -5.6, 6.9)
                cv.part([l, rr, t], "P", lw=1.0, shade=.22, hl=.12)
                for dx, dy in ((-1.7, -.3), (1.7, -.3), (0, 1.9)):
                    q = npt(0 + dx * 9, -1.6 - dy, 6.8)
                    cv.fill(circle(q, .55), "S0", tm=(0, 1))
            def knot():
                k = npt(180, .5, 6.0)
                cv.part(circle(k, 1.45, 1.2), "P", lw=.85, shade=.25, hl=.15)
                for s_ in (-1, 1):
                    cv.line([npt(180 + s_ * 16, .15, 6.05), npt(180 + s_ * 22, -1.05, 6.15)], "P2", .8, tm=(0, 1))
            cv.part(c.solid([(c.off(tc, 0, 0, Z - 1.1), 6.4), (c.off(tc, 0, 0, Z + 1.1), 5.6)]), "P", lw=1.0, shade=.22, hl=.12)
            if vis(0) > -.08: flap()
            if vis(180) > -.08: knot()
        c.add(K["tv"] + .3, bd)
    elif st == "earrings":
        def er():
            for s in (-1, 1):
                p, v = c.sph(s * 88, -18, 1.0)
                if v > -.45: cv.line([(p[0], p[1] - .6), (p[0], p[1] + 1.4)], "P2", .5); cv.part(circle((p[0], p[1] + 2.3), 1.2), "P", lw=.6, shade=.2, hl=.3)
        c.add(hv(c) + 3, er)

# ============================================================ FACE (brows, mouths, facial hair)  tint R = hairColors
def mouth(c, kind):
    cv = c.cv; e = c.K["expr"]; mp, mv = c.sph(0, -28, 1.0)
    if mv <= .2: return
    k = max(.45, mv); x, y = mp
    if e == "sleepy":
        cv.part(circle((x, y + .2), .8 * k, .9), [ramp("berry")[2]] * 3 + [INK[3]], lw=.45, flat=True, ink=INK[3]); return
    if e in ("yell", "happy") or kind == "grin" and e not in ("dead", "ouch", "dizzy"):
        w = 2.6 if kind == "grin" else 2.0
        cv.part([(x - w * k, y - .8), (x + w * k, y - .8), (x + .9 * w * k, y + .3), (x, y + 1.6 + (.4 if e == "yell" else 0)), (x - .9 * w * k, y + .3)], [ramp("berry")[1], ramp("berry")[1], ramp("berry")[2], INK[3]], lw=.8, shade=.2, hl=0, ink=INK[3])
        cv.fill([(x - w * k * .8, y - .7), (x + w * k * .8, y - .7), (x + w * k * .6, y - .1), (x - w * k * .6, y - .1)], (255, 250, 244))
    elif e == "ouch" or e == "dizzy":
        pts = [(x - 2 * k + i * .8 * k, y + (.4 if i % 2 else -.3)) for i in range(6)]; cv.line(pts, INK[3], 1.05)
    elif e == "dead":
        cv.part(circle((x, y + .3), 1.1 * k, 1.0), [ramp("berry")[2]] * 3 + [INK[3]], lw=.8, flat=True, ink=INK[3])
    elif kind == "cat":
        cv.line([(x - 1.8 * k, y - .5), (x - .9 * k, y + .5), (x, y - .2), (x + .9 * k, y + .5), (x + 1.8 * k, y - .5)], INK[3], 1.05)
    elif kind == "tongue":
        cv.line([(x - 1.8 * k, y - .4), (x, y + .3), (x + 1.8 * k, y - .4)], INK[3], 1.05)
        cv.part(circle((x + .6 * k, y + 1.3), 1.1 * k, 1.3), "flower_pink", lw=.8, shade=.3, hl=.2, ink=INK[3])
    elif e == "focus":
        cv.line([(x - 1.3 * k, y), (x + 1.3 * k, y - .2)], INK[3], 1.05)
    else:
        cv.line([(x - 1.7 * k, y - .5), (x - .6 * k, y + .45), (x + .6 * k, y + .45), (x + 1.7 * k, y - .5)], INK[3], 1.15)

def brows(c, thick=.7, lift=0, shape="arc", wide=1.0, uni=False):
    cv = c.cv; e = c.K["expr"]; inn = []
    for s in (-1, 1):
        p, v = c.sph(s * 30, 18 + lift, 1.0)
        if v <= .12: continue
        sq = max(.4, min(1, v * 1.2)); w = 2.15 * sq * wide
        tilt = {"sleepy": -.5, "happy": -.3, "focus": .9, "yell": 1.3, "ouch": -1.0, "dizzy": -.8, "dead": -.8}.get(e, 0) * s
        inner, outer = (p[0] - s * w, p[1] + tilt * .6), (p[0] + s * w, p[1] - tilt * .2)
        mid = (p[0], p[1] - (.7 if shape == "arc" else .2))
        cv.line([inner, mid, outer], "P3", thick + .8)
        cv._upd(cv.mask_from([capsule_pts(inner[0], inner[1], mid[0], mid[1], thick, thick), capsule_pts(mid[0], mid[1], outer[0], outer[1], thick, thick)]), (1, 0), ring=False)
        if shape == "bushy":  # shaggy upper fringe
            for k in (-.6, 0, .6):
                q = (p[0] + s * k * w, p[1] - thick * .9); cv.line([(q[0] - s * .3, q[1] + .8), (q[0] + s * .5, q[1] - .6)], "P3", .7, tm=(1, 0))
        inn.append(inner)
    if uni and len(inn) == 2 and e not in ("focus", "yell"):
        a, b = inn; cv.line([a, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + .4), b], "P3", thick * .8 + .4, tm=(1, 0))

def facial_hair(c, kind):
    cv = c.cv
    if fv(c) < -.35: return
    if kind in ("beard",):
        hm = c.headmask()
        pts = []
        for az in range(-100, 101, 20):
            p, v = c.sph(az, -30 if abs(az) < 90 else -5, 1.04); pts.append(p)
        ch, _ = c.sph(0, -62, 1.15); pts.append(ch)
        lo = [c.sph(az, -58, 1.12)[0] for az in (-60, -30, 0, 30, 60)]
        m = cv.part(hull(pts + lo), "P", lw=1.0, shade=.22, hl=.12)
        mp, mv = c.sph(0, -28, 1.02)
        if mv > .2:
            cv.fill(circle((mp[0], mp[1] + .4), 1.6 * mv, .9), ramp("berry")[2], tm=(0, 0))
    if kind in ("beard", "moustache"):
        mp, mv = c.sph(0, -21, 1.05)
        if mv > .1:
            for s in (-1, 1):
                pts = capsule_pts(mp[0], mp[1], mp[0] + s * 3.4 * mv, mp[1] + .2, 1.3, .7)
                cv.part(pts, "P", lw=.7, shade=.2, hl=.15)
                if kind == "moustache": cv.part(circle((mp[0] + s * 3.8 * mv, mp[1] - .7), .9, .8), "P", lw=.6, shade=.2, hl=0)
    if kind in ("goatee", "long_beard"):
        long = kind == "long_beard"
        pts = [c.sph(az, -40, 1.05)[0] for az in ((-60, -30, 0, 30, 60) if long else (-26, -10, 10, 26))]
        pts.append(c.sph(0, -78 if long else -60, 1.22 if long else 1.12)[0])
        if long: pts += [c.sph(az, -66, 1.16)[0] for az in (-45, 45)]
        c.cv.part(hull(pts), "P", lw=1.0, shade=.22, hl=.12)
        mp, mv = c.sph(0, -21, 1.05)
        if mv > .1:
            for s in (-1, 1): c.cv.part(capsule_pts(mp[0], mp[1], mp[0] + s * (3.6 if long else 2.6) * mv, mp[1] + .5, 1.2, .7), "P", lw=.7, shade=.2, hl=.15)
    if kind == "chops":
        for s in (-1, 1):
            pts = [c.sph(s * az, el, 1.05)[0] for az, el in ((78, 5), (92, 0), (88, -30), (60, -45), (52, -32), (66, -8))]
            if c.sph(s * 75, -20, 1.0)[1] > -.2: c.cv.part(hull(pts), "P", lw=.9, shade=.2, hl=.12)
    if kind == "stubble":
        hm = c.headmask()
        for i, (az, el) in enumerate([(a, e) for a in range(-70, 71, 14) for e in (-40, -52, -30, -46, -35)]):
            p, v = c.sph(az + (i % 3) * 3, el, 1.0)
            if v > .1: cv.fill(circle(p, .72), "P3", clip=hm, alpha=225, tm=(1, 0))

def draw_face(c, spec):
    st = spec["style"]
    def f():
        if fv(c) < -.3: return
        hm = c.headmask()
        if st == "freckles":
            for i, (az, el) in enumerate([(s * a, e) for s in (-1, 1) for a, e in ((44, -18), (36, -24), (50, -26), (40, -13), (30, -18), (54, -20), (46, -30), (24, -12))]):
                p, v = c.sph(az, el, 1.0)
                if v > .15: c.cv.fill(circle(p, .8 if i % 3 else .95), ramp("wood")[3], clip=hm, alpha=245)
        if st == "rosy":
            for s in (-1, 1):
                p, v = c.sph(s * 42, -20, 1.0)
                if v > .15:
                    c.cv.fill(circle(p, 2.7, 1.8), ramp("flower_pink")[1], clip=hm, alpha=200)
                    c.cv.fill(circle((p[0] - .4, p[1] - .3), 1.6, 1.0), ramp("flower_pink")[2], clip=hm, alpha=150)
        brows(c, thick={"bushy": 1.75, "chops": .9}.get(st, .9), lift={"bushy": 1.4}.get(st, 0), shape="bushy" if st == "bushy" else "flat" if st in ("beard", "long_beard", "chops") else "arc",
              wide=1.3 if st == "bushy" else 1.0, uni=st == "bushy")
        full = c.fdy; c.fdy = 0.0   # facial hair is jaw-anchored (body nose/chin are not lifted)
        facial_hair(c, {"beard": "beard", "moustache": "moustache", "stubble": "stubble", "goatee": "goatee", "long_beard": "long_beard", "chops": "chops"}.get(st, ""))
        c.fdy = full * MOUTH_LIFT   # mouth: half lift, stays under the body nose
        if st not in ("beard", "long_beard"): mouth(c, {"grin": "grin", "cat": "cat", "tongue": "tongue"}.get(st, "smile"))
        c.fdy = full
        if st == "cat":
            for s in (-1, 1):
                p, v = c.sph(s * 50, -30, 1.0)
                if v > .15:
                    for dy in (-.6, .6): c.cv.line([(p[0] - s * .8, p[1] + dy * .5), (p[0] + s * 2.2, p[1] + dy)], INK[2], .4, alpha=200)
    c.add(hv(c) + 2.5, lifted(c, f))

# ============================================================ EYES  tint R = clothingColors (iris)
def iris_ring(cv, p, rx, ry):
    """Outer iris ring -> tint G (secondary eye colour, ADR-130 eyes:color2); inner iris stays R."""
    o = np.asarray(cv.mask_from(circle(p, rx, ry)), np.float32); i = np.asarray(cv.mask_from(circle(p, rx * .62, ry * .66)), np.float32)
    cv._upd(Image.fromarray(np.clip(o - i, 0, 255).astype(np.uint8)), (0, 1), ring=False)

def draw_eyes(c, spec):
    st = spec["style"]; cv = c.cv
    def f():
        if fv(c) < -.3: return
        e = c.K["expr"]
        for idx, az in enumerate((-30, 30)):
            p, v = c.sph(az, -8, 1.0)
            if v <= .12: continue
            sq = max(.35, min(1, v * 1.2)); x, y = p
            if e == "dead":
                for s in (-1, 1): cv.line([(x - 1.6 * sq, y - 1.6 * s), (x + 1.6 * sq, y + 1.6 * s)], INK[3], .8)
                continue
            if e == "dizzy":
                pts = [(x + math.cos(t * .9) * t * .28 * sq, y + math.sin(t * .9) * t * .28) for t in range(0, 11)]
                cv.line(pts, INK[3], .9); continue
            if e == "ouch":
                s = 1 if idx == 0 else -1
                cv.line([(x - 1.8 * sq * s, y - 1.5), (x + 1.2 * sq * s, y), (x - 1.8 * sq * s, y + 1.5)], INK[3], .8); continue
            if e == "sleepy":
                cv.line([(x - 2.3 * sq, y + .2), (x, y + .9), (x + 2.3 * sq, y + .2)], INK[3], .9)
                cv.line([(x - 2.0 * sq, y - .9), (x + 2.0 * sq, y - .7)], INK[3], .5); continue
            if e == "happy" and st != "button":
                cv.line([(x - 2.2 * sq, y + .8), (x, y - 1.1), (x + 2.2 * sq, y + .8)], INK[3], 1.0)
                if st == "happy": cv.line([(x - 1.5 * sq, y + 1.1), (x, y + .0), (x + 1.5 * sq, y + 1.1)], "P2", .8, tm=(1, 0)); cv.line([(x - 1.9 * sq, y + 1.9), (x, y + .9), (x + 1.9 * sq, y + 1.9)], "P2", .55, tm=(0, 1))  # outer crescent -> G (eyes:color2)
                continue
            if e == "blink" or (st == "wink" and idx == 1 and e != "yell") or st == "happy":
                cv.line([(x - 2.2 * sq, y + (.3 if st != "happy" else .8)), (x, y + (1.2 if st != "happy" else -.9)), (x + 2.2 * sq, y + (.3 if st != "happy" else .8))], INK[3], .9)
                if st == "happy":  # tinted crescent under the closed arc (eye colour)
                    cv.line([(x - 1.5 * sq, y + 1.1), (x, y + .0), (x + 1.5 * sq, y + 1.1)], "P2", .8, tm=(1, 0)); cv.line([(x - 1.9 * sq, y + 1.9), (x, y + .9), (x + 1.9 * sq, y + 1.9)], "P2", .55, tm=(0, 1))  # outer crescent -> G (eyes:color2)
                if st == "lashes" or (st == "wink"): cv.line([(x + 2.2 * sq * (1 if az > 0 else -1), y + .3), (x + 3.0 * sq * (1 if az > 0 else -1), y - .4)], INK[3], .9)
                continue
            rx, ry = {"round": (2.4, 3.1), "sparkle": (2.7, 3.4), "sleepy": (2.4, 2.9), "cat": (2.5, 3.0), "button": (1.3, 1.4), "lashes": (2.4, 3.1), "wide": (2.9, 3.3), "wink": (2.4, 3.1)}[st]
            rx *= 1.08; ry *= 1.06
            if st == "button":
                cv.part(circle(p, rx * sq + .7, ry + .5), [NEU[2], NEU[3], NEU[3], NEU[3]], tm=(1, 0), lw=.75, flat=True, ink=INK[3])  # tinted ring
                iris_ring(cv, p, rx * sq + .7, ry + .5)   # outer rim of the button -> G (eyes:color2)
                cv.fill(circle(p, rx * sq * .62 + .1, ry * .62 + .1), INK[3], tm=(0, 0)); cv.fill(circle((x - .4, y - .5), .45), (255, 255, 255), tm=(0, 0)); continue
            if st == "wide":
                cv.part(circle(p, rx * sq, ry, wob=.02), "cloth_cream", lw=.6, shade=.15, hl=0, ink=INK[3])
                cv.part(circle((x + .2 * sq, y + .3), 1.6 * sq, 2.0), "P", lw=.4, ink=INK[3], shade=.3, hl=0)
                iris_ring(cv, (x + .2 * sq, y + .3), 1.6 * sq, 2.0)
                cv.fill(circle((x + .2 * sq, y + .4), .8 * sq, 1.0), INK[3]); cv.fill(circle((x - .5 * sq, y - .6), .5), (255, 255, 255))
                continue
            # iris (tinted) + pupil + shine
            cv.part(circle(p, rx * sq, ry, wob=0), [NEU[2], NEU[3], NEU[3], NEU[3]], tm=(1, 0), lw=.85, flat=True, ink=INK[3])
            iris_ring(cv, p, rx * sq, ry)
            if st == "cat":
                cv.fill(circle((x, y + .1), .55 * sq, ry * .8), INK[3])
            else:
                cv.fill(circle((x + .2 * sq, y + .6), rx * sq * .62, ry * .62), INK[3])
            cv.fill(circle((x - .7 * sq, y - 1.1), 1.1 * sq + .25, 1.25), (255, 255, 255), tm=(0, 0))
            cv.fill(circle((x + .8 * sq, y + 1.2), .5, .5), (255, 255, 255), alpha=220, tm=(0, 0))
            if st == "sparkle":
                star(c, x + 1.0 * sq, y - 1.6, 1.3, [(255, 255, 255)] * 3 + [(220, 220, 240)])
            if st in ("sleepy",) or e in ("focus", "yell"):
                lid = [(x - rx * sq - .5, y - ry + (1.8 if st == "sleepy" else 1.0)), (x + rx * sq + .5, y - ry + (1.8 if st == "sleepy" else 1.0) + (.8 * (1 if az < 0 else -1) if e in ("focus", "yell") else 0))]
                cv.fill([(lid[0][0], y - ry - 1.5), (lid[1][0], y - ry - 1.5), lid[1], lid[0]], "P1", tm=(0, 0)) if False else None
                cv.line(lid, INK[3], .9)
            if st == "lashes":
                sgn = 1 if az > 0 else -1
                for k in range(3): cv.line([(x + sgn * (rx * sq - .3), y - 1.6 + k * .9), (x + sgn * (rx * sq + 1.2), y - 2.4 + k * 1.0)], INK[3], .9)
    c.add(hv(c) + 2.6, lifted(c, f))
