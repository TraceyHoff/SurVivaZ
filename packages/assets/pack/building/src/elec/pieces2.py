"""Batch 2: solar panel, wind turbines, water wheels, in-stream water turbine. fn(on, ph) -> Geom; rot 0 front = +y
(camera-left face), +x = camera-right face. Heights in px = metres x 30.29 (zm). Rotors / wheels are vertical-plane
discs drawn with plane_pt (true iso projection of the disc, so they rotate with the piece)."""
import math
from .lib import (Geom, bx, cbox, cyl, zm, L, PX_M, tex_grille, tex_plate, deco, glow, smoke, quad, scr, facing,
                  ellipse_pts, ramp, flat, plane_pt, ss_poly, ss_line, soft_poly, lw_fn, planksH, planksV, cobble)

TAU = 2 * math.pi

def _pp(cv, rot, c, u, pu, pz, w=0.0):
    """cartesian point in a vertical plane: pu metres along u, pz metres up, w metres along the plane normal."""
    ux, uy = u; nx, ny = -uy, ux
    x = c[0] + ux * pu + nx * w; y = c[1] + uy * pu + ny * w; z = c[2] + pz * PX_M
    f = lw_fn(rot, False); wx, wy = f(x, y); return cv.P(wx, wy, z)

def _depth(rot, c, u, pu, pz, w=0.0):
    ux, uy = u; nx, ny = -uy, ux
    f = lw_fn(rot, False); wx, wy = f(c[0] + ux * pu + nx * w, c[1] + uy * pu + ny * w)
    return wx + wy + pz * .9

def _near_w(rot, u, w0, w1):
    nx, ny = -u[1], u[0]; f = lw_fn(rot, False); a, b = f(nx, ny)
    return (w1, w0) if a + b > 0 else (w0, w1)

def _ring(cv, rot, c, u, r, w, n=48):
    return [plane_pt(cv, rot, c, u, TAU * k / n, r, w) for k in range(n)]

def _blades(cv, rot, c, u, ang, R, r0, chord0, chord1, rp, tip=None, n=3):
    """n tapered blades in the disc plane (w = 0), drawn far-to-near."""
    bl = []
    for i in range(n):
        a = ang + TAU * i / n; d = (math.cos(a), math.sin(a)); p = (-d[1], d[0])
        def pt(s, q): return _pp(cv, rot, c, u, d[0] * s + p[0] * q, d[1] * s + p[1] * q)
        root = [pt(r0, -chord0 * .35), pt(r0, chord0 * .65)]
        body = [pt(R * .35, chord0 * .75), pt(R * .97, chord1 * .45), pt(R, 0), pt(R * .97, -chord1 * .5), pt(R * .35, -chord0 * .3)]
        poly = [root[0]] + [root[1]] + body
        tipq = [pt(R * .86, chord1 * .62), pt(R * .97, chord1 * .45), pt(R, 0), pt(R * .97, -chord1 * .5), pt(R * .86, -chord1 * .5)]
        bl.append((_depth(rot, c, u, d[0] * R * .6, d[1] * R * .6), poly, tipq, math.sin(a)))
    for _, poly, tipq, s in sorted(bl, key=lambda t: t[0]):
        r = ramp(rp); ss_poly(cv, poly, r[1 if s > -.3 else 2])
        # shade strip along the trailing edge (cel), then tip band, then ink
        if tip: ss_poly(cv, tipq, ramp(tip)[1])
        cv.lines(poly, tuple(r[3]), .8, 255, closed=True)

def _wheel(cv, rot, c, u, R, w0, w1, n, ang, spokes=6, rim='wood_dark', pad='wood', hub='gunmetal', bucket=False):
    """vertical-plane timber wheel: far rim + spokes, paddles / buckets (depth sorted), axle hub, near spokes + rim."""
    near, far = _near_w(rot, u, w0, w1)
    rr = ramp(rim); pr = ramp(pad)
    def rim_at(w, tone):
        o = _ring(cv, rot, c, u, R, w); i = _ring(cv, rot, c, u, R - .13, w)
        if bucket:   # overshot: closed side shroud (solid annulus R .. R-.34) so the wheel reads as a drum, not wire
            si = _ring(cv, rot, c, u, R - .34, w)
            for k in range(len(o)):
                k2 = (k + 1) % len(o); ss_poly(cv, [o[k], o[k2], si[k2], si[k]], rr[tone])
            for k in range(0, len(o), 3):   # plank joints
                ss_line(cv, [o[k], si[k]], tuple(rr[min(3, tone + 1)]), .5)
            cv.lines(si, tuple(rr[3]), .6, 255, closed=True)
        cv.lines(o, tuple(rr[tone]), 2.4, 255, closed=True)
        cv.lines(o, tuple(rr[3]), .6, 255, closed=True); cv.lines(i, tuple(rr[3]), .6, 255, closed=True)
    def spokes_at(w, tone):
        for k in range(spokes):
            a = ang + TAU * k / spokes
            ss_line(cv, [plane_pt(cv, rot, c, u, a, .12, w), plane_pt(cv, rot, c, u, a, R - .1, w)], tuple(rr[tone]), 1.5)
            ss_line(cv, [plane_pt(cv, rot, c, u, a + .03, .12, w), plane_pt(cv, rot, c, u, a + .02, R - .1, w)], tuple(rr[3]), .4)
    rim_at(far, 2); spokes_at(far, 2)
    ps = []
    for k in range(n):
        t = ang + TAU * k / n
        if bucket:   # overshot buckets: an L-shaped trough (floor + lip) between the rims
            q1 = [plane_pt(cv, rot, c, u, t, R, far), plane_pt(cv, rot, c, u, t, R, near), plane_pt(cv, rot, c, u, t, R - .3, near), plane_pt(cv, rot, c, u, t, R - .3, far)]
            t2 = t + .16
            q2 = [plane_pt(cv, rot, c, u, t, R - .3, far), plane_pt(cv, rot, c, u, t, R - .3, near), plane_pt(cv, rot, c, u, t2, R - .3, near), plane_pt(cv, rot, c, u, t2, R - .3, far)]
            ps.append((_depth(rot, c, u, R * math.cos(t), R * math.sin(t)), [q2, q1], math.sin(t)))
        else:
            q = [plane_pt(cv, rot, c, u, t, R + .08, far), plane_pt(cv, rot, c, u, t, R + .08, near), plane_pt(cv, rot, c, u, t, R - .24, near), plane_pt(cv, rot, c, u, t, R - .24, far)]
            ps.append((_depth(rot, c, u, R * math.cos(t), R * math.sin(t)), [q], math.sin(t)))
    for _, qs, s in sorted(ps, key=lambda t: t[0]):
        for j, q in enumerate(qs):
            ss_poly(cv, q, pr[1 if (s > 0) ^ (j == 1) else 2]); cv.lines(q, tuple(pr[3]), .55, 255, closed=True)
    # axle stub + hub
    hb = ramp(hub)
    for w, tone in ((far, 2), (near, 1)):
        ss_poly(cv, _ring(cv, rot, c, u, .16, w, 16), hb[tone], ink=tuple(hb[3]), lw=.5)
    spokes_at(near, 1); rim_at(near, 1)
    ss_poly(cv, _ring(cv, rot, c, u, .07, near, 12), hb[0])

def _draw_boxes(cv, rot, boxes, seed=7):
    """render local boxes onto cv inside a hook (painter-sorted, inked) - parts that must sit in front of a disc."""
    from buildings import xform, painter_sort
    q = []
    for i, b in enumerate(painter_sort([xform(b, rot) for b in boxes])):
        qq = cv.box(*b.v, b.rp, b.top, b.left, b.right, seed=seed + i * 3, faces=b.faces)
        if b.edge: q += qq
    cv.ink_edges(q); cv.edges = []

def _wheel_layers(G, rot_front_test, outer, draw_wheel):
    """water-side wheel: in front of the body when the +y side faces the camera (dec hook, outer trestle after it),
    else behind everything (pre hook, outer trestle before it)."""
    def front(cv, r, m):
        if facing(r, False, 0, 1): draw_wheel(cv, r, m); _draw_boxes(cv, r, outer)
    def back(cv, r, m):
        if not facing(r, False, 0, 1): _draw_boxes(cv, r, outer); draw_wheel(cv, r, m)
    G.pre.append(back); G.dec.append((-1, front))

def _water_patch(cv, rot, c, u, R, w0, w1, ph, on, foam=True):
    """water surface (z 0) where the wheel dips in: a cel patch over the wheel bottom + foam."""
    wr = ramp('water')
    ext = min(R * .62, .52)
    pts = [_pp(cv, rot, (c[0], c[1], 0), u, pu, 0, w) for pu, w in ((-ext, w0 - .08), (ext, w0 - .08), (ext, w1 + .08), (-ext, w1 + .08))]
    ss_poly(cv, pts, wr[1]); cv.lines(pts, tuple(wr[3]), .5, 255, closed=True)
    inner = [_pp(cv, rot, (c[0], c[1], 0), u, pu, 0, w) for pu, w in ((-ext * .8, w0 - .03), (ext * .8, w0 - .03), (ext * .8, w1 + .03), (-ext * .8, w1 + .03))]
    ss_poly(cv, inner, wr[0])
    if foam:
        sn = ramp('snow')
        for k in range(5):
            s = ((k * .37 + (ph if on else 0)) % 1)
            pu = -ext * .9 + ext * 1.8 * s; w = w0 + (w1 - w0) * ((k * .61) % 1)
            p = _pp(cv, rot, (c[0], c[1], 0), u, pu, .02, w); rx = 1.6 * 4 * (1.2 - s * .5); ry = rx * .5
            cv.poly(ellipse_pts(p[0], p[1], rx, ry, n=12), tuple(sn[0]))

# ------------------------------------------------------------------ 4 solar_panel (2x1, 2.0 x 1.0 x 1.4 m)
def solar_panel(on, ph):
    H = round(zm(1.4))                                  # 42 px: top edge of the tilted panel
    zl, zh, yl, yh = 15, H, .36, -.4                     # low edge (front, +y) / high edge (back)
    g, back = [], []
    for x in (-.86, 0, .86):                            # ground screws + legs (front short, back tall: drawn before the panel)
        back += [bx(x - .03, x + .03, yh - .03, yh + .03, 0, zh - 1, 'steel'), bx(x - .05, x + .05, yh - .05, yh + .05, 0, 2, 'concrete'),
                 bx(x - .02, x + .02, yh, yl, 2, 4, 'steel', edge=False)]
        g += [bx(x - .03, x + .03, yl - .03, yl + .03, 0, zl - 1, 'steel'), bx(x - .05, x + .05, yl - .05, yl + .05, 0, 2, 'concrete')]
    back += [bx(-.86, .86, yh - .02, yh + .02, 22, 24, 'steel', edge=False)]   # back brace rail
    # junction box + MC4 cable down the front-right leg (combiner box with the charge LED)
    g += [bx(.62, .8, yl + .03, yl + .11, 4, 12, 'gunmetal', l=flat(.04)),
          bx(.66, .7, yl + .11, yl + .122, 8.5, 10.5, L(on, 'lit_green'), edge=False),
          bx(.72, .76, yl + .11, yl + .122, 8.5, 10.5, L(on and int(ph * 4) % 2 == 0, 'lit_amber'), edge=False),
          bx(.7, .74, yl + .04, yl + .1, 0, 4, 'cable', edge=False), bx(.74, .99, yl + .05, yl + .09, 0, 1, 'cable', edge=False)]
    G = Geom(g, ramps={'solar', 'steel', 'ink', 'gunmetal'}); G.back = back
    def panel(cv, r, m):
        P = lambda x, y, z: scr(x, y, z, r, m, cv)
        quad(cv, [P(-.98, yl + .03, zl - 1), P(.98, yl + .03, zl - 1), P(.98, yh - .03, zh + 1), P(-.98, yh - .03, zh + 1)], 'steel', tone=1, ink=True)
        for x0, x1 in ((-.95, -.01), (.01, .95)):    # two modules side by side
            quad(cv, [P(x0, yl, zl), P(x1, yl, zl), P(x1, yh, zh), P(x0, yh, zh)], 'solar', grid=(6, 4),
                 glint=((ph + (.0 if x0 < 0 else .25)) % 1 if on else None), tone=1, ink=False)
        quad(cv, [P(-.01, yl, zl), P(.01, yl, zl), P(.01, yh, zh), P(-.01, yh, zh)], 'steel', tone=2, ink=False)
    G.dec.append((-1, panel))
    if on: G.soft.append(glow(.68, yl + .12, 9.5, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ wind turbines
def _turbine_rotor(G, c, u, R, on, ph, rp, tip, chord, spinner, blur_rgb):
    ang = (ph * TAU / 3 + .35) if on else .35            # 8 frames = 120 deg (3-fold symmetric -> seamless loop)
    def rotor(cv, r, m):
        _blades(cv, r, c, u, ang, R, .14, chord[0], chord[1], rp, tip)
        sp = ramp(spinner)
        ss_poly(cv, _ring(cv, r, c, u, R * .11, .0, 18), sp[1], ink=tuple(sp[3]), lw=.6)
        ss_poly(cv, _ring(cv, r, c, u, R * .06, .02, 14), sp[0])
    G.dec.append((-1, rotor))
    if on:
        def disc(cv, r, m):
            pts = _ring(cv, r, c, u, R * .96, 0, 40); soft_poly(cv, pts, blur_rgb, .16, .6)
        G.soft.append(('smoke', disc))

def wind_turbine(on, ph):
    """1x1, 1.2 x 1.2 x 6.2 m: guyed tube mast, hub at 5.0 m, 2.4 m rotor facing +y, tail vane to -y."""
    HUB = round(zm(5.0)); R = 1.2                       # 151 px hub, rotor top 187 px
    g = [cbox(0, 0, .26, .26, 0, 4, 'concrete', t=tex_plate(10, 10)),
         cbox(0, 0, .1, .1, 4, 7, 'gunmetal')]
    g += cyl(0, 0, .065, 7, HUB - 6, 'steel', n=8)
    for z in (52, 104):                                  # guy collars
        g += cyl(0, 0, .085, z, z + 3, 'gunmetal', n=8)
    g += cyl(0, 0, .07, HUB - 26, HUB - 18, 'brick_red', n=8)   # scrap paint band
    g += [bx(.06, .085, -.015, .015, 7, HUB - 8, 'cable', edge=False)]       # down-lead along the mast
    # charge controller / dump-load box at the foot (+y face: status LEDs)
    g += [bx(.12, .42, .1, .4, 0, 18, 'gunmetal', l=flat(.04), r=tex_grille(2, horiz=False)),
          bx(.11, .43, .09, .41, 18, 20, 'graphite'),
          bx(.17, .23, .4, .412, 12, 14, L(on, 'lit_green'), edge=False),
          bx(.27, .33, .4, .412, 12, 14, L(on and int(ph * 8) % 4 < 2, 'lit_amber'), edge=False),
          bx(.16, .38, .4, .412, 4, 9, 'hazard', edge=False)]
    # yaw bearing, nacelle (generator), tail boom + vane
    g += cyl(0, 0, .09, HUB - 6, HUB - 3, 'gunmetal', n=8)
    g += [bx(-.08, .08, -.3, .14, HUB - 5, HUB + 5, 'safety', l=flat(.04)),
          bx(-.09, .09, -.34, -.22, HUB - 6, HUB + 6, 'gunmetal'),                    # rear cap
          bx(-.015, .015, -.82, -.3, HUB - 1, HUB + 1, 'steel'),                       # tail boom
          bx(-.012, .012, -.98, -.68, HUB - 10, HUB + 17, 'hazard', l=flat(.03), r=flat(.03))]   # tail vane
    G = Geom(g, ramps={'cream', 'brick_red', 'gunmetal', 'steel', 'cable', 'ink'})
    def guys(front):
        def fn(cv, r, m):
            for gx, gy in ((-.46, -.46), (.46, -.46), (-.46, .46), (.46, .46)):
                f = lw_fn(r, False); wx, wy = f(gx, gy)
                if (wx + wy > .5) != front: continue
                a = scr(0, 0, 104, r, m, cv); b = scr(gx, gy, 1, r, m, cv)
                ss_line(cv, [a, b], ramp('cable')[1], .55)
        return fn
    G.pre.append(guys(False)); G.dec.append((-1, guys(True)))
    _turbine_rotor(G, (0, .19, HUB), (1, 0), R, on, ph, 'cream', 'brick_red', (.2, .1), 'safety', '#eef2f6')
    if on: G.soft.append(glow(.25, .41, 13, 5, 2, '#86ff70', .3, 1.0))
    return G

def wind_turbine_large(on, ph):
    """2x2, 2.0 x 2.0 x 10.2 m: tapered tubular tower, hub at 8.0 m, 4.4 m rotor facing +y, transformer cabinet."""
    HUB = round(zm(8.0)); R = 2.2                       # 242 px hub, rotor top 309 px
    g = [cbox(0, 0, .72, .72, 0, 5, 'concrete', t=tex_plate(14, 14), l=tex_plate(14, 6), r=tex_plate(14, 6))]
    segs = 6
    for i in range(segs):                               # tapered tower in 6 can sections
        z0 = 5 + (HUB - 12 - 5) * i / segs; z1 = 5 + (HUB - 12 - 5) * (i + 1) / segs
        rad = .2 - .085 * i / (segs - 1)
        g += cyl(0, 0, rad, z0, z1, 'cream', n=10)
        g += cyl(0, 0, rad + .012, z1 - 1.2, z1, 'steel', n=10)    # flange
    g += cyl(0, 0, .19, 34, 40, 'teal_paint', n=10)                 # paint band
    # tower door + steps on the +y face, ladder cage hint
    g += [bx(-.08, .08, .19, .2, 5, 26, 'gunmetal', edge=False), bx(.03, .05, .2, .21, 14, 17, 'steel', edge=False),
          bx(-.12, .12, .2, .34, 5, 7, 'steel'), bx(-.12, .12, .3, .44, 3, 5, 'steel')]
    # transformer / grid-tie cabinet (front-right) + cable trench
    g += [bx(.32, .7, .26, .7, 5, 34, 'teal_paint', l=flat(.04), r=tex_grille(3)),
          bx(.3, .72, .24, .72, 34, 37, 'gunmetal'),
          bx(.38, .52, .7, .712, 22, 28, 'hazard', edge=False),
          bx(.56, .62, .7, .712, 25, 27, L(on, 'lit_green'), edge=False),
          bx(.56, .62, .7, .712, 21, 23, L(on and int(ph * 8) % 4 < 2, 'lit_amber'), edge=False),
          bx(.36, .66, .7, .712, 8, 16, 'teal_paint', edge=False),
          bx(.15, .33, .42, .5, 5, 6, 'cable', edge=False)]
    # nacelle: yaw ring, housing, roof hatch, anemometer mast, aviation light
    g += cyl(0, 0, .14, HUB - 12, HUB - 8, 'gunmetal', n=10)
    g += [bx(-.2, .2, -.78, .22, HUB - 9, HUB + 12, 'cream', l=tex_plate(14, 8), r=flat(.03)),
          bx(-.21, .21, -.8, -.6, HUB - 10, HUB + 13, 'steel'),
          bx(-.12, .12, -.46, -.1, HUB + 12, HUB + 14, 'steel'),
          bx(-.02, .02, -.74, -.7, HUB + 13, HUB + 30, 'gunmetal'),
          bx(-.06, .06, -.74, -.7, HUB + 29, HUB + 30, 'steel', edge=False),
          bx(-.04, .04, -.58, -.52, HUB + 14, HUB + 18, L(on, 'lit_red'), edge=False),
          bx(-.2, .2, .1, .22, HUB - 6, HUB - 4, 'teal_paint', edge=False)]
    G = Geom(g, ramps={'cream', 'brick_red', 'steel', 'ink', 'gunmetal'})
    # anemometer cups spin (toon)
    a0 = ph * TAU * 2 if on else 0
    def cups(c):
        for i in range(3):
            a = a0 + TAU * i / 3; x, y = 16 + 4 * math.cos(a), 16 + 1.8 * math.sin(a)
            c.line([(16, 16), (x, y)], ramp('gunmetal')[2], .5); c.part(ellipse_pts(x, y, 1.1, 1.1, n=8), 'steel', lw=.4, shade=.2, hl=0)
    G.dec.append(deco(0, -.72, HUB + 30, cups, 32, .5))
    _turbine_rotor(G, (0, .3, HUB), (1, 0), R, on, ph, 'cream', 'brick_red', (.32, .1), 'cream', '#eef2f6')
    if on:
        G.soft.append(glow(.59, .71, 26, 4, 2, '#86ff70', .3, 1.0))
        G.soft.append(glow(0, -.55, HUB + 17, 5, 4, '#ff7456', .45 if int(ph * 8) % 4 < 2 else .2, 1.4))
    return G

# ------------------------------------------------------------------ water wheels (rot 0: water side = +y)
def water_wheel(on, ph):
    """2x1, 2.4 x 0.9 x 2.6 m undershot wheel: 2.4 m wheel overhanging +y into the water, generator shed on the bank."""
    R = 1.2; AX = 31; C = (0., .58, AX); u = (1, 0); w0, w1 = -.17, .17          # wheel y .41 .. .75, top 67 px
    ang = (ph * TAU / 12) if on else .1                     # 12 paddles, 8 frames = one paddle pitch
    g = [bx(-.98, .98, -.5, .32, 0, 3, 'wood', t=planksH(7)),                   # bank deck
         bx(-.98, .98, .3, .36, -2, 4, 'stone', l=cobble(5))]                     # stone quay edge
    # generator shed at the -x end (low so the wheel reads over it in every facing)
    g += [bx(-.96, -.38, -.48, .02, 3, 40, 'wood_dark', l=planksV(6), r=planksV(6)),
          bx(-1.0, -.34, -.52, .06, 40, 43, 'tin'),
          bx(-.84, -.62, .02, .03, 3, 26, 'wood', edge=False),                    # door
          bx(-.52, -.42, .02, .034, 28, 33, L(on, 'lit_warm', 'off_lamp'), edge=False)]   # window glow
    # A-frame trestles carrying the axle (bank side + water side) and the gearbox
    tr = lambda y: [bx(-.18, -.12, y - .03, y + .03, 0, AX + 2, 'wood_dark'), bx(.12, .18, y - .03, y + .03, 0, AX + 2, 'wood_dark'),
                    bx(-.2, .2, y - .035, y + .035, AX - 4, AX - 2, 'wood_dark')]
    g += tr(.3); outer = tr(.86)
    g += [bx(-.14, .14, -.12, .26, 14, AX + 6, 'gunmetal', l=flat(.04), r=tex_grille(2)),     # gearbox + generator
          bx(-.1, .1, .26, .272, 22, 26, 'hazard', edge=False),
          bx(-.04, .04, .26, .272, 16, 19, L(on, 'lit_green'), edge=False),
          ]
    outer += [bx(-.03, .03, .26, .92, AX - 1.5, AX + 1.5, 'steel', edge=False)]
    # cable pole with insulator at the bank corner (tallest point: 2.6 m)
    g += [bx(.78, .84, -.44, -.38, 0, round(zm(2.6)) - 3, 'wood_dark'), bx(.7, .92, -.43, -.39, 70, 72, 'wood_dark'),
          bx(.72, .76, -.43, -.39, 72, round(zm(2.6)), 'cream', edge=False), bx(.86, .9, -.43, -.39, 72, round(zm(2.6)), 'cream', edge=False)]
    G = Geom(g, ramps={'wood', 'wood_dark', 'gunmetal', 'water', 'snow', 'ink', 'cable'})
    def cable(cv, r, m):
        ss_line(cv, [scr(.12, -.12, 30, r, m, cv), scr(.4, -.3, 36, r, m, cv), scr(.81, -.41, 60, r, m, cv)], ramp('cable')[1], .6)
    G.dec.append((-1, cable))
    def wheel(cv, r, m):
        _wheel(cv, r, C, u, R, w0, w1, 12, ang, 6)
        _water_patch(cv, r, C, u, R, w0, w1, ph, on)
    _wheel_layers(G, None, outer, wheel)
    if on:
        for k in range(2):
            t = (ph + k / 2) % 1
            G.soft.append(smoke(-.5 + .9 * t, .58 + .18 * (k - .5), 2 + 4 * math.sin(t * math.pi), 3.5, 1.6, '#e8f6ff', .5 * (1 - t) + .1, 1.0))
        G.soft.append(glow(-.47, .04, 30, 4, 3, '#fff2b8', .3, 1.2)); G.soft.append(glow(0, .27, 17.5, 3, 2, '#86ff70', .3, 1.0))
    return G

def water_wheel_overshot(on, ph):
    """2x2, 3.4 x 1.2 x 4.0 m overshot wheel fed by a timber flume on trestles; small mill house with the generator."""
    R = 1.7; AX = 57; C = (0., .66, AX); u = (1, 0); w0, w1 = -.18, .18          # wheel y .48 .. .84, top 108 px
    ang = (-ph * TAU / 16) if on else .05                  # 16 buckets, turns towards +x (water falls on the +x side)
    TOP = round(zm(4.0))                                    # 121 px: flume lip
    g = [bx(-.98, .98, -.98, .32, 0, 3, 'wood', t=planksH(7)),
         bx(-.98, .98, .3, .38, -2, 4, 'stone', l=cobble(5))]
    # mill house (back-left), generator room
    g += [bx(-.97, -.22, -.97, -.3, 3, 58, 'stone', l=cobble(6), r=cobble(6)),
          bx(-1.0, -.18, -1.0, -.26, 58, 62, 'brick_red'), bx(-.93, -.26, -.93, -.34, 62, 66, 'brick_red'), bx(-.86, -.33, -.86, -.41, 66, 69, 'brick_red'),
          bx(-.5, -.4, -.8, -.7, 66, 76, 'brick', edge=True),
          bx(-.7, -.46, -.3, -.29, 3, 30, 'wood_dark', edge=False),
          bx(-.88, -.76, -.3, -.288, 36, 44, L(on, 'lit_warm', 'off_lamp'), edge=False),
          bx(-.22, -.208, -.7, -.5, 36, 44, L(on, 'lit_warm', 'off_lamp'), edge=False)]
    # axle trestles + generator housing on the bank
    tr = lambda y: [bx(-.2, -.13, y - .04, y + .04, 0, AX + 2, 'wood_dark'), bx(.13, .2, y - .04, y + .04, 0, AX + 2, 'wood_dark'),
                    bx(-.22, .22, y - .045, y + .045, AX - 4, AX - 1, 'wood_dark')]
    g += tr(.36); outer = tr(1.0) + [bx(-.04, .04, .32, 1.06, AX - 2, AX + 2, 'steel', edge=False)]
    g += [bx(-.18, .18, -.1, .32, 30, AX + 8, 'gunmetal', l=flat(.04), r=tex_grille(2)),
          bx(-.16, .16, -.12, .34, 3, 30, 'wood_dark'),
          bx(-.12, .12, .32, .332, 44, 50, 'hazard', edge=False),
          bx(-.05, .05, .32, .332, 36, 39, L(on, 'lit_green'), edge=False)]
    # flume: trestle legs at +x, trough running along -y -> +y ending over the wheel crown
    fx, fz = .55, TOP - 8
    for y in (-.85, -.2):
        g += [bx(fx - .2, fx - .14, y - .03, y + .03, 0, fz, 'wood_dark'), bx(fx + .14, fx + .2, y - .03, y + .03, 0, fz, 'wood_dark'),
              bx(fx - .22, fx + .22, y - .035, y + .035, fz - 3, fz, 'wood_dark')]
    y0, y1 = -.98, .62
    g += [bx(fx - .13, fx + .13, y0, y1, fz, fz + 2, 'wood_dark'),
          bx(fx - .13, fx - .1, y0, y1, fz + 2, TOP, 'wood', l=planksH(5), r=planksH(5)),
          bx(fx + .1, fx + .13, y0, y1, fz + 2, TOP, 'wood', l=planksH(5), r=planksH(5)),
          bx(fx - .1, fx + .1, y0, y1, fz + 2, TOP - 1.5, 'water', faces='t'),
          bx(fx - .1, fx + .1, y0, y0 + .03, fz + 2, TOP, 'wood', edge=True)]
    G = Geom(g, ramps={'wood', 'wood_dark', 'gunmetal', 'water', 'snow', 'ink', 'stone', 'brick_red'})
    def flume_unused(cv, r, m):
        # trough (open box) from y -.98 to the crown (y .5 .. .9 above x .55): drawn after the wheel's far side
        P = lambda x, y, z: scr(x, y, z, r, m, cv)
        y0, y1 = -.98, .62; zb, zt = fz, TOP
        wd = ramp('wood'); wk = ramp('wood_dark'); wa = ramp('water')
        side = lambda x: [P(x, y0, zb), P(x, y1, zb), P(x, y1, zt), P(x, y0, zt)]
        ss_poly(cv, side(fx - .12), wk[2], ink=tuple(wk[3]), lw=.5)
        ss_poly(cv, [P(fx - .12, y0, zt - 1), P(fx + .12, y0, zt - 1), P(fx + .12, y1, zt - 1), P(fx - .12, y1, zt - 1)], wa[1])   # water in the trough
        for k in range(4):   # ripples sliding toward the wheel
            s = (k / 4 + (ph if on else 0)) % 1; yy = y0 + (y1 - y0) * s
            ss_line(cv, [P(fx - .08, yy, zt - .8), P(fx + .08, yy, zt - .8)], wa[0], .6)
        ss_poly(cv, side(fx + .12), wd[1], ink=tuple(wk[3]), lw=.5)
        ss_poly(cv, [P(fx - .12, y1, zb), P(fx + .12, y1, zb), P(fx + .12, y1, zt), P(fx - .12, y1, zt)], wd[2], ink=tuple(wk[3]), lw=.5)
        for yy in (-.7, -.3, .1, .45):
            ss_line(cv, [P(fx + .121, yy, zb), P(fx + .121, yy, zt)], wk[2], .6)
    def wheel(cv, r, m):
        _wheel(cv, r, C, u, R, w0, w1, 16, ang, 8, bucket=True)
        _water_patch(cv, r, C, u, R, w0, w1, ph, on)
    def fall(cv, r, m):
        # water spilling from the flume lip into the buckets on the crown (+x side)
        P = lambda x, y, z: scr(x, y, z, r, m, cv); wa = ramp('water')
        y = .66
        for k in range(3):
            s = ((k / 3) + (ph if on else 0)) % 1
            a = P(fx - .06 + .02 * k, y - .1 + .1 * k, fz + 2 - 26 * s); b = P(fx - .02 + .02 * k, y - .1 + .1 * k, fz - 2 - 26 * s)
            ss_line(cv, [a, b], wa[0], 1.1)
        ss_poly(cv, [P(fx - .1, y - .2, fz + 2), P(fx + .1, y - .2, fz + 2), P(fx + .1, y + .2, fz - 14), P(fx - .1, y + .2, fz - 14)], wa[1])
    def wheel_fall(cv, r, m):
        wheel(cv, r, m)
        if on: fall(cv, r, m)
    _wheel_layers(G, None, outer, wheel_fall)
    if on:
        for k in range(3):
            t = (ph + k / 3) % 1
            G.soft.append(smoke(fx - .1 + .3 * t, .66, fz - 16 - 10 * t, 3 + 3 * t, 2.2 + t * 2, '#eef8ff', .55 * (1 - t) + .1, 1.0))
        G.soft.append(glow(-.82, -.29, 40, 4, 3, '#fff2b8', .3, 1.2)); G.soft.append(glow(0, .33, 37.5, 3, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 9 water_turbine (1x1, 0.8 x 0.8 x 1.0 m, sits in water)
def water_turbine(on, ph):
    H = round(zm(1.0))                                     # 30 px: cable mast top
    f = int(ph * 6) if on else 0
    g = [bx(-.4, .4, -.26, -.2, 0, 3, 'gunmetal'), bx(-.4, .4, .2, .26, 0, 3, 'gunmetal'),          # skid rails (float pontoon tops)
         bx(-.16, .16, -.42, .3, 3, 14, 'teal_paint', l=tex_plate(8, 6), r=tex_plate(8, 6)),         # duct (flow -y -> +y)
         bx(-.21, .21, -.46, -.36, 2, 17, 'steel', r=tex_grille(2, horiz=False)),                    # intake cowl + trash rack
         bx(-.13, .13, .3, .36, 4, 13, 'gunmetal')]                                                  # outlet ring
    g += cyl(0, -.05, .07, 14, 17, 'steel', n=8)                                                     # shaft collar
    g += [bx(-.072, .072, -.06, -.04, 14.5, 16.5, 'hazard' if f % 2 == 0 else 'steel', edge=False)] if on else []
    g += cyl(0, -.05, .12, 17, 24, 'safety', n=10) + [cbox(0, -.05, .085, .085, 24, 25.5, 'gunmetal')]   # generator cap
    # cable mast + junction box (status LEDs face +y)
    g += [bx(.28, .32, -.36, -.32, 0, H, 'steel'), bx(.24, .36, -.32, -.24, 15, 22, 'gunmetal'),
          bx(.26, .29, -.24, -.228, 19, 20.5, L(on, 'lit_green'), edge=False),
          bx(.31, .34, -.24, -.228, 19, 20.5, L(on and f % 3 != 2, 'lit_amber'), edge=False)]
    G = Geom(g, ramps={'water', 'snow', 'cable', 'ink'})
    def wash(cv, r, m):   # water line around the hull (behind the boxes)
        wa = ramp('water'); P = lambda x, y, z: scr(x, y, z, r, m, cv)
        ring = [P(.46 * math.cos(a), -.04 + .46 * math.sin(a), 0) for a in [TAU * k / 32 for k in range(32)]]
        ss_poly(cv, ring, wa[2]); cv.lines(ring, tuple(ramp('snow')[0]), 1.0, 255, closed=True)
    G.pre.append(wash)
    def churn(cv, r, m):   # outlet churn (cel foam rings) on the +y side
        sn = ramp('snow'); wa = ramp('water')
        for k in range(4):
            s = ((k / 4) + (ph if on else .2)) % 1
            p = scr(-.12 + .08 * k, .4 + .12 * s, .5, r, m, cv); rx = (1.6 + 2.4 * s) * 4 if on else 3
            cv.poly(ellipse_pts(p[0], p[1], rx, rx * .45, n=14), tuple(sn[0] if on else wa[0]))
        if on:
            p = scr(0, .34, 8, r, m, cv); cv.poly(ellipse_pts(p[0], p[1], 3.2 * 4, 1.4 * 4, n=14), tuple(sn[1]))
        def cablef(cv=cv):
            ss_line(cv, [scr(.1, -.05, 21, r, m, cv), scr(.22, -.2, 18, r, m, cv), scr(.3, -.3, 17, r, m, cv)], ramp('cable')[1], .6)
        cablef()
    G.dec.append((-1, churn))
    if on:
        G.soft.append(smoke(0, .48, 3, 6, 2.4, '#eef8ff', .45, 1.0))
        G.soft.append(glow(.3, -.23, 20, 3, 2, '#86ff70', .3, 1.0))
    return G

PIECES = {   # key: (fn, footprint, cls, rows, frames, fps[, render rotation per painted row])
    'solar_panel': (solar_panel, (2, 1), 'W', 2, 4, 3, (0, 3)),   # both painted facings show the cells
    'wind_turbine': (wind_turbine, (1, 1), 'XXL_T', 1, 8, 12),
    'wind_turbine_large': (wind_turbine_large, (2, 2), 'XXL_L', 1, 8, 10),
    'water_wheel': (water_wheel, (2, 1), 'WT', 2, 8, 8, (0, 3)),                 # wheel on a camera-facing side in both facings
    'water_wheel_overshot': (water_wheel_overshot, (2, 2), 'XW', 2, 8, 8, (0, 3)),
    'water_turbine': (water_turbine, (1, 1), 'S', 1, 6, 12),
}
