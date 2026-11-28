"""Batch 3: electrician's workstation, electric stations, fridge / freezer, lamps, flood light, heater, hydroponic table.
fn(on, ph) -> Geom; rot 0 front = +y (camera-left face), +x = camera-right face. Heights px = metres x 30.29 (zm).
fn.no_shadow = True for mounted pieces (wall / ceiling)."""
import math
from .lib import (Geom, bx, cbox, cyl, zm, L, tex_grille, tex_plate, tex_cells, glow, smoke, scr,
                  ellipse_pts, ramp, flat, ss_poly, ss_line, soft_poly, planksH)

TAU = 2 * math.pi

def _iso_ell(cv, r, m, x, y, z, rx, color, ink=None, n=20):
    """flat ellipse lying on a horizontal plane (radius rx tiles) at local (x, y, z)."""
    pts = [scr(x + rx * math.cos(a), y + rx * math.sin(a), z, r, m, cv) for a in [TAU * k / n for k in range(n)]]
    ss_poly(cv, pts, color, ink=ink, lw=.5); return pts

def _flat_poly(cv, r, m, pts, z, color, ink=None):
    q = [scr(x, y, z, r, m, cv) for x, y in pts]; ss_poly(cv, q, color, ink=ink, lw=.5); return q

def _shimmer(G, x, y, z, ph, w=4, h=10, col='#fff4e0', a=.35):
    """heat shimmer: two soft puffs rising (non-emissive soft)."""
    for k in range(2):
        t = (ph + k / 2) % 1
        G.soft.append(smoke(x + .05 * math.sin(TAU * (t + k * .3)), y, z + 3 + t * h, w * (1 - .3 * t), 1.6, col, a * (1 - t) + .05, .9))

# ------------------------------------------------------------------ 1 electrician_workstation (2x1, 1.9 x 0.8 x 2.0 m)
def electrician_workstation(on, ph):
    H = round(zm(2.0)); T = round(zm(.9))               # 61 px pegboard top, 27 px bench top
    f = int(ph * 6) if on else 0
    g = []
    for x in (-.9, .84):
        for y in (-.36, .3): g.append(bx(x, x + .06, y, y + .06, 0, T - 2, 'steel'))
    g += [bx(-.9, .9, -.36, .36, 6, 8, 'gunmetal', t=tex_plate(10, 8)),
          bx(-.86, -.5, -.3, .2, 8, 13, 'safety', l=tex_grille(2)), bx(-.44, -.12, -.3, .2, 8, 12, 'teal_paint'),   # parts bins
          bx(.3, .8, -.2, .24, 8, 16, 'gunmetal', l=flat(.04))]                                                    # toolbox
    g += [bx(-.95, .95, -.4, .4, T - 2, T, 'wood_dark', l=planksH(6), r=flat(.04))]                               # bench top
    g += [bx(-.92, .92, -.44, -.38, T, H - 2, 'wood', l=tex_cells(14, 6, .4), r=flat(.04)),                       # pegboard
          bx(-.95, .95, -.46, -.36, H - 2, H, 'wood_dark')]
    for x, rp in ((-.7, 'brick_red'), (-.45, 'genset'), (-.2, 'copper'), (.05, 'sky_enamel')):                  # cable spools
        g += [bx(x - .09, x + .09, -.38, -.3, 44, 52, rp, l=tex_grille(1.4, horiz=False)), bx(x - .1, x + .1, -.38, -.29, 43, 44, 'graphite'), bx(x - .1, x + .1, -.38, -.29, 52, 53, 'graphite')]
    g += [bx(.25, .7, -.38, -.37, 36, 39, 'steel', edge=False), bx(.32, .36, -.37, -.35, 30, 39, 'steel', edge=False), bx(.5, .54, -.37, -.35, 31, 39, 'steel', edge=False)]
    # oscilloscope (right), soldering station (centre), multimeter (left)
    g += [bx(.32, .86, -.3, .12, T, T + 14, 'sky_enamel', r=tex_grille(2)), bx(.3, .88, -.32, .14, T + 14, T + 15, 'gunmetal'),
          bx(.36, .62, .12, .132, T + 4, T + 12, L(on, 'lit_green', 'off_screen'), edge=False),
          bx(.66, .7, .12, .136, T + 9, T + 11, 'gunmetal', edge=False), bx(.74, .78, .12, .136, T + 9, T + 11, 'gunmetal', edge=False),
          bx(.66, .82, .12, .136, T + 3, T + 6, 'graphite', edge=False)]
    g += [bx(-.12, .16, -.1, .2, T, T + 6, 'graphite'), bx(-.06, .08, .2, .212, T + 2, T + 4.5, L(on, 'lit_red'), edge=False),
          bx(.2, .24, .0, .04, T, T + 9, 'steel', edge=False)]
    g += [bx(-.7, -.5, .0, .2, T, T + 4, 'hazard'), bx(-.66, -.54, .2, .212, T + 2, T + 3.6, L(on, 'lit_cyan', 'off_screen'), edge=False)]
    G = Geom(g, ramps={'ink', 'lit_green', 'lit_warm', 'lit_amber', 'off_lamp', 'off_screen', 'steel', 'gunmetal', 'cable', 'safety', 'graphite'})
    def trace(cv, r, m):
        P = lambda x, z: scr(x, .134, z, r, m, cv); col = ramp('lit_green' if on else 'off_screen')[0]
        ss_line(cv, [P(.38 + .22 * i / 16, T + 8 + (2.4 * math.sin(i * .9 + ph * TAU) if on else 0)) for i in range(17)], col, .55)
    G.dec.append((-1, trace))
    def iron(cv, r, m):
        a = scr(.22, .02, T + 8, r, m, cv); b = scr(.0, .25, T + 1.5, r, m, cv)
        ss_line(cv, [a, b], ramp('graphite')[1], 1.1); ss_line(cv, [scr(.02, .23, T + 2, r, m, cv), b], ramp('steel')[1], .6)
        ss_line(cv, [scr(.1, -.05, T + 3, r, m, cv), scr(.18, .1, T + .5, r, m, cv), a], ramp('cable')[1], .5)
        ax0 = scr(-.25, -.37, 56, r, m, cv); ax1 = scr(-.2, -.1, 62, r, m, cv); hd = scr(-.18, .05, 58, r, m, cv)
        ss_line(cv, [ax0, ax1, hd], ramp('steel')[2], .9)
        ss_poly(cv, [(hd[0] - 10, hd[1] - 6), (hd[0] + 10, hd[1] - 6), (hd[0] + 14, hd[1] + 8), (hd[0] - 14, hd[1] + 8)], ramp('safety')[1], ink=tuple(ramp('safety')[3]), lw=.6)
        lit = ('lit_warm' if f != 3 else 'lit_amber') if on else 'off_lamp'
        ss_poly(cv, [(hd[0] - 13, hd[1] + 7), (hd[0] + 13, hd[1] + 7), (hd[0] + 10, hd[1] + 10), (hd[0] - 10, hd[1] + 10)], ramp(lit)[1])
        if on and f in (0, 2, 4):
            for k in range(4):
                an = TAU * (k / 4 + f * .13); s = 1.6 + (k % 2) * 1.2
                cv.poly(ellipse_pts(b[0] + math.cos(an) * s * 4, b[1] - abs(math.sin(an)) * s * 4, 1.6, 1.6, n=6), tuple(ramp('lit_amber')[0]))
    G.dec.append((-1, iron))
    if on:
        G.soft.append(glow(-.18, .1, 52, 9, 6, '#fff2b8', .26 if f != 3 else .14, 2.0))
        G.soft.append(glow(.49, .14, T + 8, 7, 4, '#86ff70', .25, 1.4))
        if f in (0, 2, 4): G.soft.append(glow(.0, .25, T + 2, 3, 2, '#ffd352', .5, .8))
    return G

# ------------------------------------------------------------------ 14 electric_stove (1x1, 0.76 x 0.65 x 1.1 m, worktop 0.92 m)
def electric_stove(on, ph):
    W = round(zm(.92)); H = round(zm(1.1))
    f = int(ph * 4) if on else 0
    x0, x1, y0, y1 = -.38, .38, -.3, .35
    g = [bx(x0, x1, y0, y1, 0, 2, 'graphite'),
         bx(x0, x1, y0, y1, 2, W - 1, 'cream', r=flat(.03)),
         bx(x0 - .01, x1 + .01, y0 - .01, y1 + .01, W - 1, W, 'graphite'),
         bx(x0 + .05, x1 - .05, y1, y1 + .012, 6, 21, 'cream', edge=False),
         bx(x0 + .12, x1 - .12, y1 + .012, y1 + .02, 9, 17, L(on, 'lit_amber', 'off_screen'), edge=False),
         bx(x0 + .1, x1 - .1, y1 + .012, y1 + .04, 22, 23.5, 'steel', edge=False),
         bx(x0 + .05, x1 - .05, y1, y1 + .012, 2.5, 5, 'gunmetal', edge=False),
         bx(x0, x1, y0, y0 + .08, W, H, 'cream', l=flat(.03)),
         bx(x0 + .26, x0 + .5, y0 + .08, y0 + .092, W + 1.5, W + 4, L(on, 'lit_cyan', 'off_screen'), edge=False)]
    for x in (-.3, -.2, .2, .3): g.append(bx(x - .03, x + .03, y0 + .08, y0 + .1, W + 1.5, W + 3.5, 'gunmetal', edge=False))
    G = Geom(g, ramps={'ink', 'lit_red', 'off_hob', 'graphite'})
    def hobs(cv, r, m):
        for i, (x, y, rr) in enumerate(((-.17, -.1, .12), (.17, -.1, .1), (-.17, .2, .1), (.17, .2, .12))):
            hot = on and (i + f) % 4 != 3; rp = ramp('lit_red' if hot else 'off_hob')
            _iso_ell(cv, r, m, x, y, W, rr, rp[2 if hot else 1], ink=tuple(ramp('graphite')[3]))
            _iso_ell(cv, r, m, x, y, W, rr * .62, rp[1 if hot else 2])
            if hot: _iso_ell(cv, r, m, x, y, W, rr * .3, rp[0])
    G.dec.append((-1, hobs))
    if on:
        G.soft.append(glow(0, .05, W + 1, 12, 5, '#ff7456', .3 + .1 * (f % 2), 1.6))
        G.soft.append(glow(0, y1 + .02, 13, 7, 4, '#ffd352', .28, 1.4))
    return G

# ------------------------------------------------------------------ 15 electric_furnace (1x1, 1.0 x 1.0 x 1.6 m)
def electric_furnace(on, ph):
    H = round(zm(1.6))
    f = int(ph * 6) if on else 0
    g = [bx(-.46, .46, -.46, .46, 0, 3, 'concrete', t=tex_plate(10, 10)),
         bx(-.4, .22, -.36, .3, 3, 28, 'steel', l=flat(.04), r=flat(.04)),
         bx(-.41, .23, -.37, .31, 17, 18.5, 'gunmetal'),
         bx(-.42, .24, -.38, .32, 28, 31, 'brick_red', t=tex_plate(5, 5)),
         bx(-.32, -.06, -.3, -.04, 31, 36, 'gunmetal'),
         bx(-.4, .22, .3, .312, 8, 12, 'hazard', edge=False),
         bx(-.08, .0, .3, .32, 14, 28, 'gunmetal', edge=False)]
    g += cyl(-.19, -.17, .06, 36, H, 'gunmetal', n=8) + [cbox(-.19, -.17, .08, .08, H - 2, H, 'rust')]
    g += [bx(.26, .44, -.3, .14, 6, 34, 'teal_paint', l=flat(.04), r=tex_grille(2)), bx(.24, .46, -.32, .16, 34, 36, 'gunmetal'),
          bx(.26, .44, .14, .152, 26, 31, L(on, 'lit_cyan', 'off_screen'), edge=False),
          bx(.3, .36, .14, .152, 20, 23, L(on, 'lit_green'), edge=False), bx(.38, .42, .14, .152, 20, 23, 'brick_red', edge=False)]
    g += [bx(.22, .26, -.2, -.16, 10, 12, 'copper', edge=False), bx(.22, .26, -.1, -.06, 16, 18, 'copper', edge=False),
          bx(.24, .28, -.2, -.16, 2, 10, 'copper', edge=False), bx(.38, .42, -.38, -.3, 2, 30, 'cable', edge=False)]
    G = Geom(g, ramps={'ink', 'lit_hot', 'graphite', 'off_hob'})
    gi = [0, 1, 1, 0, 0, 1][f] if on else 0
    def crucible(cv, r, m):
        _iso_ell(cv, r, m, .02, .08, 31, .19, ramp('graphite')[2], ink=tuple(ramp('graphite')[3]))
        _iso_ell(cv, r, m, .02, .08, 31, .15, ramp('lit_hot')[1 + gi] if on else ramp('off_hob')[2])
        if on: _iso_ell(cv, r, m, .02 + .03 * math.cos(ph * TAU), .08, 31, .06, ramp('lit_hot')[0])
        _flat_poly(cv, r, m, [(-.04, .23), (.08, .23), (.06, .31), (-.02, .31)], 31.5, ramp('graphite')[1], ink=tuple(ramp('graphite')[3]))
    G.dec.append((-1, crucible))
    if on:
        G.soft.append(glow(.02, .08, 33, 9, 5, '#ff702e', .35 + .15 * gi, 1.8)); _shimmer(G, .02, .08, 33, ph, 5, 12)
    return G

# ------------------------------------------------------------------ 16 power_workbench (2x1, 2.0 x 0.8 x 1.6 m)
def power_workbench(on, ph):
    H = round(zm(1.6)); T = round(zm(.9))
    f = int(ph * 6) if on else 0
    g = []
    for x in (-.94, .88):
        for y in (-.36, .3): g.append(bx(x, x + .06, y, y + .06, 0, T - 3, 'gunmetal'))
    g += [bx(-.94, .94, -.36, .36, 5, 7, 'wood_dark', t=planksH(6)), bx(-.8, -.3, -.28, .2, 7, 13, 'wood', l=planksH(4)),
          bx(-.98, .98, -.4, .4, T - 3, T, 'wood_dark', l=planksH(7), r=flat(.04))]
    g += [bx(-.9, -.2, -.36, .36, T, T + 1, 'gunmetal', t=tex_plate(14, 10)), bx(-.9, -.2, -.24, -.2, T + 1, T + 3, 'safety', edge=False),
          bx(-.3, -.18, .36, .45, T - 8, T - 2, 'graphite'),
          bx(-.28, -.24, .45, .462, T - 5.5, T - 3.5, L(on, 'lit_green'), edge=False), bx(-.22, -.2, .45, .462, T - 6, T - 3, 'brick_red', edge=False)]
    g += [bx(.35, .75, -.34, .0, T, T + 2, 'gunmetal')] + cyl(.55, -.24, .04, T + 2, H - 4, 'steel', n=6)
    g += [bx(.42, .7, -.32, .06, H - 13, H - 4, 'safety', l=flat(.03), r=tex_grille(2)), bx(.46, .66, -.36, -.06, H - 4, H, 'gunmetal'),
          bx(.53, .59, -.02, .04, H - 18, H - 13, 'gunmetal'), bx(.555, .565, .0, .02, H - 23, H - 18, 'steel' if f % 2 else 'graphite', edge=False)]
    g += [bx(.1, .3, .26, .4, T, T + 4, 'teal_paint'), bx(.12, .28, .38, .44, T + 1, T + 4, 'teal_paint'), bx(.18, .22, .44, .52, T + 2, T + 3, 'steel', edge=False),
          bx(-.2, .3, -.4, -.36, T, T + 16, 'wood', l=tex_cells(8, 3, .5))]
    G = Geom(g, ramps={'ink', 'steel', 'sand', 'graphite', 'gunmetal', 'brick_red'})
    ang = (ph * TAU / 4) if on else .2
    def blade(cv, r, m):
        from .pieces2 import _ring, _pp
        c = (-.55, .0, T + 1); u = (1, 0); R = .2; pts = []
        for k in range(32):
            a = ang + TAU * k / 32; rr = R * (1.1 if k % 2 == 0 else .95)
            pts.append(_pp(cv, r, c, u, rr * math.cos(a), max(0., rr * math.sin(a))))
        ss_poly(cv, pts, ramp('steel')[1], ink=tuple(ramp('steel')[3]), lw=.5)
        ss_poly(cv, [_pp(cv, r, c, u, .05 * math.cos(a), max(0., .05 * math.sin(a))) for a in [TAU * k / 12 for k in range(12)]], ramp('gunmetal')[1])
        mk = _pp(cv, r, c, u, .13 * math.cos(ang), max(0, .13 * math.sin(ang)))
        if math.sin(ang) > 0: cv.poly(ellipse_pts(mk[0], mk[1], 2, 2, n=6), tuple(ramp('brick_red')[1]))
        if on:
            for k in range(5):
                s = ((k / 5) + ph) % 1; p = scr(-.42 + .35 * s, .02 + .1 * ((k * .37) % 1), T + 2 + 4 * math.sin(s * math.pi), r, m, cv)
                cv.poly(ellipse_pts(p[0], p[1], 1.6, 1.6, n=6), tuple(ramp('sand')[k % 2]))
    G.dec.append((-1, blade))
    if on: G.soft.append(glow(-.26, .46, T - 4.5, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 17 power_hammer (1x1, 1.0 x 1.0 x 2.2 m)
def power_hammer(on, ph):
    H = round(zm(2.2))
    f = int(ph * 6) if on else 0
    rz = [44, 38, 28, 22, 30, 40][f] if on else 42
    g = [bx(-.48, .48, -.48, .48, 0, 4, 'concrete', t=tex_plate(10, 10)),
         bx(-.3, .3, -.44, -.04, 4, 12, 'teal_paint'),
         bx(-.22, .22, -.44, -.12, 12, 58, 'teal_paint', l=flat(.04), r=flat(.04)),
         bx(-.18, .18, -.12, .28, 46, 58, 'teal_paint', r=flat(.04)),
         bx(-.08, .08, .02, .26, 4, 14, 'gunmetal'), bx(-.1, .1, .0, .28, 14, 18, 'steel', t=tex_plate(4, 4)),
         bx(-.07, .07, .04, .24, rz, 46, 'steel', l=flat(.03)), bx(-.09, .09, .02, .26, rz - 3, rz, 'gunmetal'),
         bx(-.16, .16, -.13, -.12, 20, 44, 'hazard', l=tex_grille(3), edge=False)]
    g += cyl(0, -.28, .14, 58, H - 3, 'gunmetal', n=10) + [cbox(0, -.28, .1, .1, H - 3, H, 'steel')]
    g += [bx(.22, .3, -.42, -.12, 34, 64, 'hazard', r=tex_grille(2), l=flat(.03)),
          bx(.3, .312, -.38 + .04 * (f % 3), -.34 + .04 * (f % 3), 40, 58, 'rubber', edge=False),
          bx(.12, .2, -.1, -.0, 52, 56, 'gunmetal'), bx(.12, .2, -.0, .012, 53, 55, L(on, 'lit_green'), edge=False)]
    g += [bx(-.3, -.12, .3, .44, 4, 5.5 - (1.5 if on and f in (2, 3) else 0), 'gunmetal'), bx(-.24, -.2, .22, .3, 4, 8, 'steel', edge=False)]
    G = Geom(g, ramps={'ink', 'lit_amber'})
    if on and f == 3:
        def sparks(cv, r, m):
            p = scr(0, .14, 19, r, m, cv)
            for k in range(7):
                an = TAU * k / 7 + .3; s = 2 + (k % 3) * 1.6
                cv.poly(ellipse_pts(p[0] + math.cos(an) * s * 4, p[1] - abs(math.sin(an)) * s * 2.4, 1.4, 1.4, n=6), tuple(ramp('lit_amber')[k % 2]))
        G.dec.append((-1, sparks)); G.soft.append(glow(0, .14, 19, 6, 3, '#ffd352', .5, 1.2))
    if on: G.soft.append(glow(.16, .02, 54, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 18 fridge (1x1, 0.7 x 0.7 x 1.8 m)
def fridge(on, ph):
    H = round(zm(1.8))
    f = int(ph * 4) if on else 0
    x0, x1, y0, y1 = -.35, .35, -.35, .33
    g = [bx(x0 + .03, x1 - .03, y0 + .03, y1 - .03, 0, 2, 'graphite'),
         bx(x0, x1, y0, y1, 2, H - 2, 'mint_enamel', r=flat(.03)), bx(x0 + .02, x1 - .02, y0 + .02, y1 - .02, H - 2, H, 'mint_enamel'),
         bx(x0 + .02, x1 - .02, y1, y1 + .012, 38, H - 4, 'mint_enamel', edge=False), bx(x0 + .02, x1 - .02, y1, y1 + .012, 4, 37, 'mint_enamel', edge=False),
         bx(x1 - .1, x1 - .06, y1 + .012, y1 + .04, 40, 48, 'steel', edge=False), bx(x1 - .1, x1 - .06, y1 + .012, y1 + .04, 24, 34, 'steel', edge=False),
         bx(x0 + .08, x0 + .3, y1 + .012, y1 + .022, 45, 49, L(on, 'lit_cyan', 'off_screen'), edge=False),
         bx(x0 + .1, x0 + .22, y1 + .012, y1 + .016, 22, 30, 'cream', edge=False), bx(x0 + .14, x0 + .18, y1 + .016, y1 + .024, 29, 31, 'brick_red', edge=False),
         bx(x0 + .06, x1 - .06, y0 - .02, y0, 6, 30, 'gunmetal', edge=False)]
    if on: g.append(bx(x0 + .1 + .045 * f, x0 + .13 + .045 * f, y1 + .022, y1 + .026, 46, 48, 'lit_white', edge=False))
    G = Geom(g, ramps={'ink'})
    if on:
        G.soft.append(glow(x0 + .19, y1 + .03, 47, 4, 2, '#84f4ff', .3, 1.0))
        G.soft.append(smoke(.0, y0 - .06, H - 2 + 2 * math.sin(ph * TAU), 6, 2, '#f2fbff', .18, 1.4))
    return G

# ------------------------------------------------------------------ 19 chest_freezer (2x1, 1.4 x 0.7 x 0.85 m)
def chest_freezer(on, ph):
    H = round(zm(.85))
    f = int(ph * 4) if on else 0
    x0, x1, y0, y1 = -.7, .7, -.35, .35
    g = [bx(x0 + .03, x1 - .03, y0 + .03, y1 - .03, 0, 2, 'graphite'),
         bx(x0, x1, y0, y1, 2, H - 3, 'sky_enamel', r=flat(.03)),
         bx(x0 - .01, x1 + .01, y0 - .01, y1 + .01, H - 3, H - 2, 'gunmetal'),
         bx(x0, x1, y0, y1, H - 2, H, 'sky_enamel', t=flat(.03)),
         bx(-.2, .2, y1, y1 + .04, H - 4, H - 2.5, 'steel', edge=False),
         bx(.42, .66, y1, y1 + .012, 3, 10, 'gunmetal', l=tex_grille(1.6), edge=False),
         bx(-.62, -.5, y1, y1 + .012, 12, 15, 'graphite', edge=False),
         bx(-.6, -.57, y1 + .012, y1 + .02, 12.8, 14.2, L(on, 'lit_green' if f != 2 else 'lit_cyan'), edge=False),
         bx(-.55, -.52, y1 + .012, y1 + .02, 12.8, 14.2, L(on and f % 2 == 0, 'lit_amber'), edge=False),
         bx(-.68, -.3, y0 + .1, y0 + .3, H, H + 1, 'cream', edge=False)]
    G = Geom(g, ramps={'ink'})
    if on:
        for k in range(3):
            t = (ph + k / 3) % 1; x = -.4 + .5 * k
            G.soft.append(smoke(x + .1 * t, y1 + .04, H - 3 - 3 * t, 4 + 3 * t, 1.4, '#eaf8ff', .45 * (1 - t) + .1, .9))
        G.soft.append(glow(-.56, y1 + .03, 13.5, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 20 electric_floor_lamp (1x1, 0.4 x 0.4 x 1.6 m)
def electric_floor_lamp(on, ph):
    H = round(zm(1.6))
    br = .5 + .5 * math.sin(ph * TAU) if on else 0
    g = cyl(0, 0, .15, 0, 2, 'graphite', n=12) + cyl(0, 0, .02, 2, H - 12, 'steel', n=6) + cyl(0, 0, .03, 12, 14, 'gunmetal', n=6)
    g += cyl(0, 0, .19, H - 13, H, L(on, 'lit_warm', 'off_lamp'), n=14)
    g += cyl(0, 0, .2, H - 13, H - 12, 'cream', n=14) + cyl(0, 0, .2, H - 1, H, 'cream', n=14)
    G = Geom(g, ramps={'ink', 'cable', 'cream'})
    def cord(cv, r, m):
        ss_line(cv, [scr(.1, .1, 1, r, m, cv), scr(.3, .25, 0, r, m, cv), scr(.42, .1, 0, r, m, cv), scr(.44, -.2, 0, r, m, cv)], ramp('cable')[1], .6)
        p = scr(.44, -.22, 0, r, m, cv); cv.poly(ellipse_pts(p[0], p[1] - 2, 3, 2.4, n=8), tuple(ramp('cream')[1]))
    G.pre.append(cord)
    if on:
        G.soft.append(glow(0, 0, H - 6, 13 + 3 * br, 9 + 2 * br, '#fff2b8', .26 + .14 * br, 2.6))
        G.soft.append(glow(0, 0, 1, 10, 5, '#ffdc80', .12 + .06 * br, 2.0))
    return G

# ------------------------------------------------------------------ 21 electric_table_lamp (1x1, 0.3 x 0.3 x 0.5 m; sits on tables)
def electric_table_lamp(on, ph):
    br = .5 + .5 * math.sin(ph * TAU) if on else 0
    g = cyl(-.04, -.04, .1, 0, 1.5, 'graphite', n=10) + [cbox(-.04, -.04, .03, .03, 1.5, 3, 'gunmetal')]
    G = Geom(g, ramps={'ink', 'steel', 'lit_warm', 'off_lamp', 'teal_paint'})
    def arm(cv, r, m):
        a = scr(-.04, -.04, 3, r, m, cv); b = scr(-.08, .0, 11, r, m, cv); c = scr(.06, .08, 15, r, m, cv)
        ss_line(cv, [a, b, c], ramp('teal_paint')[2], 1.0); ss_line(cv, [a, b, c], ramp('teal_paint')[0], .35)
        cv.poly(ellipse_pts(b[0], b[1], 2.2, 2.2, n=8), tuple(ramp('steel')[2]))
        hd = [(c[0] - 12, c[1] - 6), (c[0] + 8, c[1] - 9), (c[0] + 18, c[1] + 6), (c[0] - 4, c[1] + 12)]
        ss_poly(cv, hd, ramp('teal_paint')[1], ink=tuple(ramp('teal_paint')[3]), lw=.6)
        ss_poly(cv, [(c[0] - 4, c[1] + 12), (c[0] + 18, c[1] + 6), (c[0] + 12, c[1] + 14), (c[0] + 2, c[1] + 16)], ramp(L(on, 'lit_warm', 'off_lamp'))[1])
    G.dec.append((-1, arm))
    if on:
        G.soft.append(glow(.1, .14, 9, 7 + 2 * br, 5 + br, '#fff2b8', .28 + .14 * br, 1.8))
        G.soft.append(glow(.14, .22, 0, 7, 3, '#ffdc80', .14 + .06 * br, 1.6))
    return G

# ------------------------------------------------------------------ 22 electric_wall_light (edge, 0.3 x 0.15 x 0.3 m at 1.8 m)
def electric_wall_light(on, ph):
    br = .5 + .5 * math.sin(ph * TAU) if on else 0
    y = .14; z0, z1 = 55, 64                              # fixture 55..64 px above the edge pivot (1.8 m), on the wall face
    g = [bx(-.15, .15, y, y + .03, z0, z1, 'gunmetal'),
         bx(-.12, .12, y + .03, y + .14, z0 + 2, z1 - 2, 'graphite', l=flat(.03)),
         bx(-.1, .1, y + .14, y + .152, z0 + 3, z1 - 3, L(on, 'lit_white', 'off_lamp'), edge=False),
         bx(-.12, .12, y + .03, y + .14, z1 - 2, z1 - 1.4, L(on, 'lit_white', 'off_lamp'), edge=False, faces='t'),
         bx(-.02, .02, y, y + .03, z0 - 6, z0, 'cable', edge=False)]
    G = Geom(g, ramps={'ink'})
    if on:
        G.soft.append(glow(0, y + .02, z1 + 4, 8 + 2 * br, 5, '#eef8ff', .2 + .1 * br, 2.0))
        G.soft.append(glow(0, y + .02, z0 - 4, 8 + 2 * br, 5, '#eef8ff', .2 + .1 * br, 2.0))
        G.soft.append(glow(0, y + .16, (z0 + z1) / 2, 6, 4, '#ffffff', .3 + .12 * br, 1.4))
    return G
electric_wall_light.no_shadow = True

# ------------------------------------------------------------------ 23 ceiling_light (1x1, 0.5 x 0.5 x 0.25 m, body 70-79 px)
def ceiling_light(on, ph):
    br = .5 + .5 * math.sin(ph * TAU) if on else 0
    g = cyl(0, 0, .09, 78, 80, 'steel', n=10) + cyl(0, 0, .015, 76, 78, 'gunmetal', n=4)
    g += cyl(0, 0, .22, 72, 76, 'graphite', n=16) + cyl(0, 0, .2, 70, 72, L(on, 'lit_white', 'off_lamp'), n=16) + cyl(0, 0, .225, 75.5, 76, 'steel', n=16)
    G = Geom(g, ramps={'ink'})
    if on:
        G.soft.append(glow(0, 0, 70, 12 + 3 * br, 6 + br, '#eef8ff', .22 + .12 * br, 2.2))
        G.soft.append(glow(0, 0, 0, 12, 6, '#eef8ff', .08 + .04 * br, 2.4))
    return G
ceiling_light.no_shadow = True

# ------------------------------------------------------------------ 24 flood_light (1x1, 0.5 x 0.5 x 3.0 m)
def flood_light(on, ph):
    H = round(zm(3.0))
    sh = .5 + .5 * math.sin(ph * TAU) if on else 0
    g = [cbox(0, 0, .2, .2, 0, 5, 'concrete', l=tex_plate(8, 5), r=tex_plate(8, 5)), cbox(0, 0, .08, .08, 5, 7, 'gunmetal')]
    g += cyl(0, 0, .045, 7, H - 5, 'steel', n=8)
    g += [bx(-.24, .24, -.025, .025, H - 7, H - 5, 'steel'),
          bx(.05, .17, .04, .14, 34, 46, 'gunmetal', l=flat(.04)), bx(.07, .1, .14, .152, 42, 44, L(on, 'lit_green'), edge=False),
          bx(.03, .06, .02, .05, 7, 34, 'cable', edge=False)]
    G = Geom(g, ramps={'ink', 'gunmetal', 'lit_white', 'off_lamp', 'steel'})
    def heads(cv, r, m):
        for x in (-.2, .2):
            p = scr(x, .04, H - 4, r, m, cv)
            ss_poly(cv, [(p[0] - 11, p[1] - 10), (p[0] + 11, p[1] - 10), (p[0] + 13, p[1] + 4), (p[0] - 13, p[1] + 4)], ramp('gunmetal')[1], ink=tuple(ramp('gunmetal')[3]), lw=.6)
            for k in range(3): ss_line(cv, [(p[0] - 8 + 8 * k, p[1] - 10), (p[0] - 8 + 8 * k, p[1] - 4)], ramp('gunmetal')[2], .5)
            ss_poly(cv, [(p[0] - 12, p[1] + 2), (p[0] + 12, p[1] + 2), (p[0] + 10, p[1] + 10), (p[0] - 10, p[1] + 10)], ramp(L(on, 'lit_white', 'off_lamp'))[1], ink=tuple(ramp('gunmetal')[3]), lw=.6)
            ss_line(cv, [(p[0], p[1] - 10), (p[0], p[1] - 14)], ramp('steel')[2], .8)
    G.dec.append((-1, heads))
    if on:
        def cone(cv, r, m):
            for x in (-.2, .2):
                a = scr(x, .04, H - 5, r, m, cv); b0 = scr(x - .35, .5, 0, r, m, cv); b1 = scr(x + .2, .6, 0, r, m, cv)
                soft_poly(cv, [a, b0, b1], '#eef8ff', .1 + .06 * sh, 1.6)
        G.soft.append(('glow', cone))
        for x in (-.2, .2): G.soft.append(glow(x, .1, H - 6, 6, 4, '#ffffff', .35, 1.4))
        G.soft.append(glow(.085, .16, 43, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 25 electric_heater (1x1, 0.6 x 0.3 x 0.65 m)
def electric_heater(on, ph):
    H = round(zm(.65))
    f = int(ph * 4) if on else 0
    x0, x1, y0, y1 = -.3, .3, -.15, .15
    g = [bx(x0 + .02, x0 + .08, y0 - .04, y1 + .04, 0, 2, 'gunmetal'), bx(x1 - .08, x1 - .02, y0 - .04, y1 + .04, 0, 2, 'gunmetal'),
         bx(x0, x1, y0, y1, 2, H - 2, 'cream', r=flat(.03)), bx(x0 - .01, x1 + .01, y0 - .01, y1 + .01, H - 2, H, 'gunmetal'),
         bx(x0 + .05, x1 - .16, y1, y1 + .01, 5, H - 5, 'graphite', edge=False)]
    for i in range(5):
        z = 6 + i * 2; hot = on and (i + f) % 4 != 0
        g.append(bx(x0 + .06, x1 - .17, y1 + .01, y1 + .016, z, z + 1, L(on, 'lit_hot' if hot else 'lit_amber', 'off_hob'), edge=False))
    for i in range(6):
        x = x0 + .07 + i * .07; g.append(bx(x, x + .015, y1 + .016, y1 + .024, 5, H - 5, 'steel', edge=False))
    g += [bx(x1 - .13, x1 - .05, y1, y1 + .02, 9, 14, 'gunmetal', edge=False), bx(x1 - .1, x1 - .08, y1 + .02, y1 + .03, 11, 14, 'steel', edge=False),
          bx(x1 - .12, x1 - .06, y1, y1 + .02, 5, 7, L(on, 'lit_red'), edge=False), bx(-.1, .1, -.02, .02, H, H + 1, 'gunmetal')]
    G = Geom(g, ramps={'ink'})
    if on:
        G.soft.append(glow(-.06, y1 + .03, 10, 7, 4, '#ff702e', .3 + .08 * (f % 2), 1.4)); _shimmer(G, -.04, .05, H, ph, 4, 9)
    return G

# ------------------------------------------------------------------ 26 hydroponic_table (2x1, 2.0 x 1.0 x 1.7 m; tray surface 27 px)
def hydroponic_table(on, ph):
    H = round(zm(1.7)); T = 27
    f = int(ph * 4) if on else 0
    g = []
    for x in (-.94, .88):
        for y in (-.44, .38): g.append(bx(x, x + .06, y, y + .06, 0, T - 4, 'steel'))
    g += [bx(-.98, .98, -.48, .48, T - 4, T - 1, 'steel', l=flat(.03), r=flat(.03)),
          bx(-.92, .92, -.42, .42, T - 2, T - 1.5, 'water', faces='t')]
    g += [bx(-.7, .2, -.36, .3, 0, 14, 'sky_enamel', l=flat(.03), r=flat(.03)), bx(-.72, .22, -.38, .32, 14, 15, 'gunmetal'),
          bx(.32, .6, -.2, .16, 0, 9, 'gunmetal', l=flat(.04)),
          bx(.38, .44, .16, .172, 5, 7, L(on, 'lit_green' if f % 2 == 0 else 'lit_cyan'), edge=False),
          bx(.42, .46, -.02, .02, 9, T - 4, 'rubber', edge=False), bx(-.3, -.26, -.1, -.06, 15, T - 4, 'rubber', edge=False)]
    for x in (-.92, .86): g += [bx(x, x + .06, -.03, .03, T - 1, H - 2, 'gunmetal')]
    g += [bx(-.96, .96, -.08, .08, H - 3, H, 'graphite', l=flat(.03)),
          bx(-.9, .9, .08, .092, H - 2.6, H - .8, L(on, 'lit_grow', 'off_grow'), edge=False)]
    G = Geom(g, ramps={'ink', 'water', 'graphite', 'rubber'})
    def pots(cv, r, m):
        wa = ramp('water')
        if on:
            for k in range(3):
                s = ((k / 3) + ph) % 1; x = -.9 + 1.8 * s
                ss_line(cv, [scr(x, -.38, T - 1.4, r, m, cv), scr(x, .38, T - 1.4, r, m, cv)], wa[0], .5)
        for y in (-.2, .2):
            for i in range(6):
                x = -.75 + i * .3
                _iso_ell(cv, r, m, x, y, T - 1.4, .085, ramp('graphite')[2], ink=tuple(ramp('graphite')[3]))
                _iso_ell(cv, r, m, x, y, T - 1.4, .05, ramp('rubber')[3])
    G.pre.append(lambda cv, r, m: None)
    G.dec.insert(0, (-1, pots))
    if on:
        p = .22 + .08 * math.sin(ph * TAU)
        G.soft.append(glow(0, .0, H - 4, 30, 6, '#ff92ea', p, 2.2))
        def wash(cv, r, m):
            q = [scr(-.9, -.4, T - 1, r, m, cv), scr(.9, -.4, T - 1, r, m, cv), scr(.9, .4, T - 1, r, m, cv), scr(-.9, .4, T - 1, r, m, cv)]
            soft_poly(cv, q, '#ffd0f4', p * .5, 1.2)
        G.soft.append(('glow', wash))
        G.soft.append(glow(.41, .18, 6, 3, 2, '#86ff70', .3, 1.0))
    return G

PIECES = {   # key: (fn, footprint, cls, rows, frames, fps[, render rotation per painted row])
    'electrician_workstation': (electrician_workstation, (2, 1), 'WT', 2, 6, 10),
    'electric_stove': (electric_stove, (1, 1), 'S', 2, 4, 6),
    'electric_furnace': (electric_furnace, (1, 1), 'T', 2, 6, 10),
    'power_workbench': (power_workbench, (2, 1), 'W', 2, 6, 10),
    'power_hammer': (power_hammer, (1, 1), 'T', 2, 6, 10),
    'fridge': (fridge, (1, 1), 'T', 2, 4, 4),
    'chest_freezer': (chest_freezer, (2, 1), 'W', 2, 4, 4),
    'electric_floor_lamp': (electric_floor_lamp, (1, 1), 'T', 1, 4, 4),
    'electric_table_lamp': (electric_table_lamp, (1, 1), 'S', 1, 4, 4),
    'electric_wall_light': (electric_wall_light, (1, 1), 'T', 4, 4, 4),   # edge mount: 4 painted facings like dec_wall_sconce
    'ceiling_light': (ceiling_light, (1, 1), 'T', 1, 4, 4),
    'flood_light': (flood_light, (1, 1), 'XT', 1, 4, 4),
    'electric_heater': (electric_heater, (1, 1), 'S', 2, 4, 4),
    'hydroponic_table': (hydroponic_table, (2, 1), 'W', 2, 4, 6),
}
