"""ADR-593 powered building tier (tier 5 "powered") art, brief docs/ART_KEYS_ELECTRICITY.md section 5.

Same pieces, pivots and 84x120 frame as building_t4 (ADR-504 80 px floor): the geometry comes from the shared tier
builders (pieces.py / buildings2.py, patched to the 80 px metric by scale80.py) with a new material set - dark graphite
composite panels, brushed steel posts / beams / trim, gunmetal plinth and deck plate, precast concrete footings - plus
the powered-tier parts that are painted on top:
  * recessed warm-white LED strips: walls get a high strip under the cap beam (z 72) and a skirting strip (z 8.5) on
    both faces; pillars a vertical strip per face; floors / foundations an inset perimeter ring on the deck (hole rims
    on the hatch frame and stairwell) and step lights round the foundation sides;
  * a steel-and-glass upper band on every full wall face (glazed panel, brushed-steel mullions and sill);
  * radiant heating panels: a gunmetal grille panel on each wall face (under-window radiators on the window wall) with
    a hot element line and a status LED; floors / foundations a grille in the deck.
States: 'on' (powered: strips + elements lit, soft glow halos; phase ph drives a slow shimmer pulse travelling along
the strips) and 'unlit' (same piece, strips / elements dark). Damage stage s (0..3) knocks out LED segments
(deterministic per piece) and is baked by iso.damage in lib.render_frame.
"""
import math, os, sys, zlib
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..'))
from elec import lib                     # noqa: E402  (ramps: graphite / steel / gunmetal / concrete / lit_* / off_*)
from elec.lib import Geom, bx, glow      # noqa: E402
import scale80 as S8                     # noqa: E402  (must precede pieces: 80 px metric)
import pieces as PC                      # noqa: E402
import buildings2 as b2                  # noqa: E402
from buildings import flat               # noqa: E402

b2.TEX['composite'] = lib.tex_plate(pw=17, ph=26)   # tall composite panels, fine seams, rivet heads
b2.TEX['deckplate'] = lib.tex_plate(pw=11, ph=11)
b2.TEX['precast'] = lib.tex_plate(pw=22, ph=9)
PC.TIERS['powered'] = dict(wall=('graphite', 'composite'), base=('steel', 'flat'), frame=('gunmetal', 'flat'), floor=('gunmetal', 'deckplate'),
                           found=('concrete', 'precast'), roof='gunmetal', roof_style='corrugated', trim='steel', post_w=0.09, beam=True)

WALL_T = 2 * b2.T          # wall box thickness (0.24)
D = 0.014                  # strip / panel stand-off from a face (tiles)
STRIP_Z = (72.0, 8.5)      # LED strip bottoms (high strip under the 75 px cap beam, skirting strip above the 7 px plinth)
STRIP_H = 1.6
SEG = 0.1                  # LED segment length (tiles): shimmer + damage granularity
GLOW_COL = '#ffe2a0'
LOSS = (0.0, 0.1, 0.3, 0.55)   # fraction of LED segments dark per damage stage

# piece -> (layer, rows); rows as building_t4 (PC.PIECES)
PIECES = {k: (PC.PIECES[k][2], PC.PIECES[k][3]) for k in (
    'foundation', 'foundation_triangle', 'floor', 'floor_triangle', 'floor_hatch_frame', 'floor_stairwell',
    'wall', 'wall_low', 'wall_window', 'wall_doorway', 'wall_arched', 'wall_corner_inner', 'wall_corner_outer',
    'wall_corner_angled', 'pillar')}


class _Ctx:
    def __init__(self, key, on, ph, stage):
        self.on, self.ph, self.stage = on, ph, stage
        self.rng = np.random.default_rng(zlib.crc32(f'{key}t5'.encode()) + 7 * stage)
        self.boxes, self.soft = [], []

    def led(self, u):
        """ramp for one LED segment at perimeter parameter u in [0,1): dark when unpowered or knocked out by damage,
        else warm white with the travelling shimmer pulse (lit_white) on intact pieces."""
        dead = self.stage and self.rng.random() < LOSS[self.stage]
        if not self.on or dead: return 'off_led', False
        if self.stage == 0 and ((u - self.ph) % 1.0) < 0.16: return 'lit_white', True
        return 'lit_warm', True

    def add(self, x0, x1, y0, y1, z0, z1, rp, faces='tlr', t=None, l=None, r=None):
        self.boxes.append(bx(x0, x1, y0, y1, z0, z1, rp, t=t, l=l, r=r, edge=False, faces=faces))

    def halo(self, x, y, z, big=False, k=1.0):
        if self.on:
            a = (0.30 + 0.10 * math.cos(2 * math.pi * self.ph) if self.stage == 0 else 0.26) * k
            self.soft.append(glow(x, y, z, 5 if big else 3.5, 2.6 if big else 2.0, GLOW_COL, a, 1.6))


def _wall_axis(b):
    """wall body box -> ('x', run lo, run hi, face lo, face hi) for a box running along x (faces at y), or 'y'."""
    x0, x1, y0, y1 = b.v[0], b.v[1], b.v[2], b.v[3]
    if abs((y1 - y0) - WALL_T) < 1e-3 and abs((x1 - x0) - WALL_T) > 1e-3: return 'x', x0, x1, y0, y1
    if abs((x1 - x0) - WALL_T) < 1e-3: return 'y', y0, y1, x0, x1
    return None


def _run_box(c, ax, a0, a1, f, side, z0, z1, rp, faces='tlr', tex=None):
    """box standing off a wall face: run [a0,a1] along `ax`, on face coordinate f, side -1 / +1."""
    o0, o1 = (f, f + D) if side > 0 else (f - D, f)
    if ax == 'x': c.add(a0, a1, o0, o1, z0, z1, rp, faces=faces, l=tex, r=tex)
    else: c.add(o0, o1, a0, a1, z0, z1, rp, faces=faces, l=tex, r=tex)


def _wall_parts(c, body, post=0.0, thin_run=None):
    """LED strips + heating panels on every graphite wall-body box. post: half size of a corner post to keep clear;
    thin_run: (lo, hi) run of a wall built from thin strips (angled wall), panels only inside it."""
    grille = lib.tex_grille(pitch=3, horiz=True)
    for b in body:
        if not b.edge and not thin_run: continue   # arch voussoir strips (the arch gets one synthetic run instead)
        w = _wall_axis(b)
        if not w: continue
        ax, a0, a1, f0, f1 = w; z0, z1 = b.v[4], b.v[5]
        if post:   # corner arm: keep the strips off the post
            if a1 <= post: continue
            a0 = max(a0, post) if a0 >= -post else a0; a1 = min(a1, -post) if a1 <= post and a0 < -post else a1
        mid = (a0 + a1) / 2
        for zs in STRIP_Z:
            if z0 - 0.01 <= zs and zs + STRIP_H <= z1 + 0.01:
                n = max(1, int(round((a1 - a0) / SEG)))
                for k in range(n):
                    s0 = a0 + (a1 - a0) * k / n; s1 = a0 + (a1 - a0) * (k + 1) / n; u = ((s0 + s1) / 2 + 0.5) % 1.0
                    rp, lit = c.led(u if zs > 40 else (u + 0.5) % 1.0)
                    for side, fc in ((-1, f0), (1, f1)):
                        _run_box(c, ax, s0, s1, fc, side, zs, zs + STRIP_H, rp)
                        if lit and k % 2 == 0 and (s1 - s0) > 0.05:
                            hx, hy = ((s0 + s1) / 2, fc + side * 0.03) if ax == 'x' else (fc + side * 0.03, (s0 + s1) / 2)
                            c.halo(hx, hy, zs + 1)
        # steel-and-glass upper band: a glazed panel on each face (z 47-68) split by brushed-steel mullions + sill
        thin = (a1 - a0) < 0.18
        if z0 <= 46 and z1 >= 69 and (not thin or (thin_run and thin_run[0] + 0.05 < mid < thin_run[1] - 0.05)):
            g0, g1 = (a0 + 0.04, a1 - 0.04) if not thin else (a0, a1); nm = 1 if thin else max(1, int(round((g1 - g0) / 0.22)))
            for side, fc in ((-1, f0), (1, f1)):
                _run_box(c, ax, g0, g1, fc, side, 47, 68, 'glass')
                _run_box(c, ax, g0 - (0 if thin else 0.01), g1 + (0 if thin else 0.01), fc, side, 45.6, 47, 'steel')
                for m in range(1, nm):
                    q = g0 + (g1 - g0) * m / nm
                    _run_box(c, ax, q - 0.012, q + 0.012, fc + side * D, side, 47, 68, 'steel')
        # radiant heating panel (+ under-window radiator) with its element line and status LED
        za = max(z0, 7) + 4.5; zb = min(z1 - 2.5, 44)
        long_enough = (a1 - a0) >= 0.18 or (thin_run and thin_run[0] + 0.05 < mid < thin_run[1] - 0.05)
        if zb - za >= 6 and long_enough:
            p0, p1 = (a0 + 0.045, a1 - 0.045) if (a1 - a0) >= 0.18 else (a0, a1)
            el = ('lit_hot' if c.on else 'off_hob')
            for side, fc in ((-1, f0), (1, f1)):
                _run_box(c, ax, p0, p1, fc, side, za, zb, 'gunmetal', tex=grille)
                _run_box(c, ax, p0, p1, fc + side * D, side, za + 0.6, za + 1.8, el)
                if (a1 - a0) >= 0.18:
                    q = p1 - 0.03
                    _run_box(c, ax, q - 0.02, q, fc + side * D, side, zb - 2.6, zb - 1.2, 'lit_amber' if c.on else 'off_led')


def _top_line(c, p, q, z, w, rp_of, n=None):
    """LED line on a deck top from p to q (local tiles), width w: straight runs are single boxes per segment, diagonal
    runs are built from small overlapping squares (so any angle reads as a clean line)."""
    (px, py), (qx, qy) = p, q; L = math.hypot(qx - px, qy - py); n = n or max(1, int(round(L / SEG)))
    axis = abs(qx - px) < 1e-6 or abs(qy - py) < 1e-6
    for k in range(n):
        ax_, ay_ = px + (qx - px) * k / n, py + (qy - py) * k / n; bx_, by_ = px + (qx - px) * (k + 1) / n, py + (qy - py) * (k + 1) / n
        mx, my = (ax_ + bx_) / 2, (ay_ + by_) / 2; u = (math.atan2(my, mx) / (2 * math.pi)) % 1.0
        rp, lit = rp_of(u)
        if axis:
            c.add(min(ax_, bx_) - (w / 2 if abs(qx - px) < 1e-6 else 0), max(ax_, bx_) + (w / 2 if abs(qx - px) < 1e-6 else 0),
                  min(ay_, by_) - (w / 2 if abs(qy - py) < 1e-6 else 0), max(ay_, by_) + (w / 2 if abs(qy - py) < 1e-6 else 0), z, z + 0.45, rp, faces='t')
        else:
            m = max(2, int(math.ceil(L / n / (w * 0.7))))
            for j in range(m):
                t = (j + 0.5) / m; cx, cy = ax_ + (bx_ - ax_) * t, ay_ + (by_ - ay_) * t
                c.add(cx - w / 2, cx + w / 2, cy - w / 2, cy + w / 2, z, z + 0.45, rp, faces='t')
        if lit and k % 2 == 0: c.halo(mx, my, z + 0.5, k=0.6)


def _ring(c, pts, z, w=0.026):
    for a, b in zip(pts, pts[1:] + pts[:1]): _top_line(c, a, b, z, w, c.led)


def _grille_rect(c, x0, x1, y0, y1, z):
    c.add(x0, x1, y0, y1, z, z + 0.3, 'gunmetal', faces='t', t=lib.tex_grille(pitch=3, horiz=True))
    if c.on:
        for x in (x0 + (x1 - x0) * 0.3, x0 + (x1 - x0) * 0.7):
            c.add(x - 0.01, x + 0.01, y0 + 0.03, y1 - 0.03, z + 0.3, z + 0.55, 'lit_hot', faces='t')
    else:
        for x in (x0 + (x1 - x0) * 0.3, x0 + (x1 - x0) * 0.7):
            c.add(x - 0.01, x + 0.01, y0 + 0.03, y1 - 0.03, z + 0.3, z + 0.55, 'off_hob', faces='t')


def _side_lights(c, x0, x1, y0, y1, z):
    """step lights round a slab's four sides (stand-off strips)."""
    for (a0, a1, f, side, ax) in ((x0, x1, y0, -1, 'x'), (x0, x1, y1, 1, 'x'), (y0, y1, x0, -1, 'y'), (y0, y1, x1, 1, 'y')):
        n = max(1, int(round((a1 - a0) / 0.2)))
        for k in range(n):
            s0 = a0 + (a1 - a0) * (k + 0.3) / n; s1 = a0 + (a1 - a0) * (k + 0.7) / n
            u = (math.atan2((s0 + s1) / 2 if ax == 'y' else f, (s0 + s1) / 2 if ax == 'x' else f) / (2 * math.pi)) % 1.0
            rp, lit = c.led(u)
            _run_box(c, ax, s0, s1, f, side, z, z + 1.4, rp)


def geom(key, state='on', ph=0.0, stage=0):
    on = state == 'on'
    fn = PC.PIECES[key][1]; base, dec = fn('powered'); c = _Ctx(key, on, ph, stage)
    base = list(base)
    if key == 'wall_arched':   # one strip run across the arch head (voussoirs overlap, so they are skipped)
        _wall_parts(c, [b for b in base if b.rp == 'graphite' and b.edge] + [bx(-0.3, 0.3, -b2.T, b2.T, 70, 75, 'graphite')])
    elif key.startswith('wall') and key not in ('wall_corner_inner', 'wall_corner_outer', 'wall_corner_angled'):
        _wall_parts(c, [b for b in base if b.rp == 'graphite'])
    elif key in ('wall_corner_inner', 'wall_corner_outer'):
        _wall_parts(c, [b for b in base if b.rp == 'graphite'], post=b2.T + 0.06)
    elif key == 'wall_corner_angled':
        _wall_parts(c, [b for b in base if b.rp == 'graphite'], thin_run=(0.0, 0.48))
        # post strip
    if key == 'pillar' or key.startswith('wall_corner'):
        h = 0.14 if key == 'pillar' else b2.T + 0.06
        top = 74 if key == 'pillar' else 70
        for (x0, x1, y0, y1) in ((-0.022, 0.022, h, h + D), (-0.022, 0.022, -h - D, -h), (h, h + D, -0.022, 0.022), (-h - D, -h, -0.022, 0.022)):
            for k in range(6):
                z0 = 12 + (top - 12) * k / 6; z1 = 12 + (top - 12) * (k + 1) / 6 - 0.8
                rp, lit = c.led(k / 6)
                c.add(x0, x1, y0, y1, z0, z1, rp)
                if lit and k % 2 == 1: c.halo((x0 + x1) / 2 * 1.3, (y0 + y1) / 2 * 1.3, (z0 + z1) / 2, big=False)
    if key == 'floor':
        e = 0.44; _ring(c, [(-e, -e), (e, -e), (e, e), (-e, e)], 4); _grille_rect(c, -0.24, 0.24, -0.24, 0.24, 4)
    elif key == 'floor_hatch_frame':
        e = 0.44; _ring(c, [(-e, -e), (e, -e), (e, e), (-e, e)], 4); h = 0.29; _ring(c, [(-h, -h), (h, -h), (h, h), (-h, h)], 4)
    elif key == 'floor_stairwell':
        e = 0.45; _ring(c, [(-e, -e), (e, -e), (e, e), (-e, e)], 4)
        for y in (-0.27, 0.27): _top_line(c, (-0.4, y), (0.4, y), 4, 0.022, c.led)
        for x in (-0.46, 0.46):
            pass
    elif key == 'foundation':
        e = 0.40; _ring(c, [(-e, -e), (e, -e), (e, e), (-e, e)], 12); _grille_rect(c, -0.22, 0.22, -0.22, 0.22, 12)
        _side_lights(c, -0.5, 0.5, -0.5, 0.5, 3.5)
    elif key in ('floor_triangle', 'foundation_triangle'):
        z = 4 if key == 'floor_triangle' else 12
        _ring(c, PC._shrink(PC.TRI, 0.74 if key == 'floor_triangle' else 0.68), z, 0.024)
        tri = PC._shrink(PC.TRI, 0.38)
        for b in PC._strips(tri, 16, lambda a, b_, cc, d: (a, b_, cc, d)):
            c.add(b[0], b[1], b[2], b[3], z, z + 0.3, 'gunmetal', faces='t', t=lib.tex_grille(pitch=3, horiz=True))
        xs = [p[0] for p in tri]; x0 = min(xs) + 0.04; x1 = max(xs) - 0.04
        c.add(x0, x1, -0.012, 0.012, z + 0.3, z + 0.55, 'lit_hot' if on else 'off_hob', faces='t')
        if key == 'foundation_triangle':
            for (ax_, ay_), (bx2, by2) in zip(PC.TRI, PC.TRI[1:] + PC.TRI[:1]):   # step lights on the 3 sides
                for t in (0.3, 0.7):
                    cx, cy = ax_ + (bx2 - ax_) * t, ay_ + (by2 - ay_) * t; nx, ny = cx * 1.04, cy * 1.04
                    rp, lit = c.led((math.atan2(cy, cx) / (2 * math.pi)) % 1.0)
                    c.add(min(cx, nx) - 0.03, max(cx, nx) + 0.03, min(cy, ny) - 0.03, max(cy, ny) + 0.03, 3.5, 4.9, rp)
    g = Geom(base + c.boxes, dec, c.soft, ramps={'lit_warm', 'lit_white', 'lit_hot', 'lit_amber', 'off_led', 'off_hob', 'glass', 'steel'})
    return g
