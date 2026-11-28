"""Batch 1: generators, batteries, Wireless Power Extender Pylon. fn(on, ph) -> Geom; rot 0 front = +y (camera-left face),
+x = camera-right face. Heights in px = metres x 30.29 (zm)."""
import math
from .lib import (Geom, bx, cbox, cyl, zm, L, tex_grille, tex_plate, deco, glow, smoke, ring, quad, scr, facing,
                  ellipse_pts, capsule_pts, ramp, flat)

def _leds(x0, x1, y, z0, z1, n, lit_n, lit='lit_green', face='l', off='off_led', gap=.25):
    """row of n LED segments on a face: face 'l' = +y face (boxes along x), 'r' = +x face (boxes along y)."""
    out = []; step = (x1 - x0) / n
    for i in range(n):
        a = x0 + i * step + step * gap / 2; b = a + step * (1 - gap); rp = lit if i < lit_n else off
        if face == 'l': out.append(bx(a, b, y, y + .012, z0, z1, rp, edge=False))
        else: out.append(bx(y, y + .012, a, b, z0, z1, rp, edge=False))
    return out

def _vleds(x0, x1, y, z0, z1, n, lit_n, lit='lit_green', face='l', off='off_led'):
    """vertical LED gauge (n segments bottom->top) on a face."""
    out = []; step = (z1 - z0) / n
    for i in range(n):
        za = z0 + i * step + .5; zb = za + step - 1; rp = lit if i < lit_n else off
        if face == 'l': out.append(bx(x0, x1, y, y + .012, za, zb, rp, edge=False))
        else: out.append(bx(y, y + .012, x0, x1, za, zb, rp, edge=False))
    return out

# ------------------------------------------------------------------ 2 generator_fuel (2x1, 1.8 x 0.9 x 1.2 m)
def generator_fuel(on, ph):
    H = round(zm(1.2))                                  # 36 px: exhaust cap top
    f = int(ph * 6) if on else 0; jig = (1 if f % 2 else 0) if on else 0   # body vibration: 1 px bob on odd frames
    g = []
    g += [bx(-.9, .9, .3, .42, 0, 3, 'gunmetal'), bx(-.9, .9, -.42, -.3, 0, 3, 'gunmetal'),          # skid rails
          bx(-.88, .88, -.4, .4, 3, 5, 'gunmetal', t=tex_plate(9, 7))]                              # deck plate
    z0 = 5 + jig
    body = 'genset'
    g += [bx(-.8, .5, -.36, .36, z0, z0 + 22, body, l=tex_grille(3), r=flat(.06)),                 # enclosure (louvred front)
          bx(-.84, .54, -.4, .4, z0 + 22, z0 + 24, body),                                           # roof cap
          bx(-.78, -.55, .36, .375, z0 + 4, z0 + 16, 'steel', edge=False),                          # service door
          bx(-.6, -.57, .375, .39, z0 + 8, z0 + 11, 'gunmetal', edge=False),                        # door latch
          bx(.05, .42, .36, .372, z0 + 15, z0 + 20, 'hazard', edge=False),                          # warning stripe label
          bx(-.25, .02, -.36, .36, z0 + 24, z0 + 25, 'rust', edge=False),                           # scrap patch on the roof
          ]
    # control panel on the +x end (dark face: hour meter, run LED, stop button, socket)
    g += [bx(.5, .8, -.3, .24, z0, z0 + 19, 'gunmetal', r=flat(.04)),
          bx(.8, .812, -.24, .18, z0 + 2, z0 + 17, 'graphite', edge=False),
          bx(.812, .824, -.2, -.04, z0 + 11, z0 + 15, L(on, 'lit_cyan', 'off_screen'), edge=False),   # hour meter
          bx(.812, .826, .04, .1, z0 + 12, z0 + 15, L(on, 'lit_green'), edge=False),                   # run LED
          bx(.812, .828, .04, .1, z0 + 5, z0 + 8, 'brick_red', edge=False),                            # stop button
          bx(.812, .826, -.2, -.06, z0 + 4, z0 + 8, 'hazard', edge=False)]                             # socket
    # fuel cap + exhaust stack (+ rain flap) on the roof
    g += cyl(-.52, -.1, .07, z0 + 24, z0 + 27, 'safety', n=6)
    ex, ey = .25, -.2
    g += cyl(ex, ey, .045, z0 + 24, H - 3 + jig, 'gunmetal', n=5) + [cbox(ex, ey, .06, .06, H - 3 + jig, H - 1 + jig, 'rust'),
          bx(ex - .06, ex + .06, ey - .06, ey + .02, H - 1, H, 'rust')]
    # jerry can + cable coil on the skid end (survivor clutter)
    g += [bx(-.88, -.82, -.22, .1, 5, 17, 'brick_red'), bx(-.87, -.83, -.08, .02, 17, 19, 'gunmetal')]
    g += [bx(.84, .9, -.38, .38, 5, 6, 'cable', edge=False)]
    G = Geom(g, ramps={'ink'})
    # hour-meter digits tick while running (a 1 px bright segment walks across the screen)
    if on: G.bx.append(bx(.824, .83, -.19 + .04 * (f % 4), -.17 + .04 * (f % 4), z0 + 12, z0 + 14, 'lit_white', edge=False))
    if on:
        for i in range(3):
            t = (ph + i / 3) % 1
            G.soft.append(smoke(ex - .05 - t * .3, ey - t * .2, H + 2 + t * 16, 2.2 + t * 3.6, 1.8 + t * 2.8, '#4e4c54' if i == 0 else '#7a7882', .8 * (1 - t) + .1, .8))
    return G

# ------------------------------------------------------------------ 3 generator_solar (1x1, 1.0 x 1.0 x 0.9 m)
def generator_solar(on, ph):
    H = round(zm(.9))                                   # 27 px: top edge of the tilted panel
    f = int(ph * 4) if on else 0
    g = []
    # power station box 0.6 x 0.4 x 0.5 m (z 15) in front-right
    bxx = (-.12, .42, .02, .42)
    g += [bx(bxx[0], bxx[1], bxx[2], bxx[3], 0, 13, 'teal_paint', r=tex_grille(2)),
          bx(bxx[0] - .01, bxx[1] + .01, bxx[2] - .01, bxx[3] + .01, 13, 15, 'gunmetal'),
          bx(.02, .06, .18, .26, 15, 19, 'rubber'), bx(.28, .32, .18, .26, 15, 19, 'rubber'), bx(.02, .32, .18, .26, 19, 20, 'rubber'),   # carry handle
          bx(-.08, .14, .42, .432, 7, 11.5, L(on, 'lit_cyan', 'off_screen'), edge=False)]                  # screen
    g += _leds(.18, .38, .42, 8, 10, 4, f + 1 if on else 0)                                              # charge bars
    g += [bx(-.06, .02, .42, .432, 2.5, 5, 'ink', edge=False), bx(.08, .16, .42, .432, 2.5, 5, 'ink', edge=False)]   # AC outlets
    # tilt stand + fold-out panel at the back (drawn first: behind the box)
    pz0, pz1 = 9, H; py0, py1 = .0, -.42
    back = [bx(-.42, -.38, -.42, -.38, 0, pz1 - 1, 'steel'), bx(.38, .42, -.42, -.38, 0, pz1 - 1, 'steel'),   # back legs (behind the panel)
            bx(-.42, .42, -.42, -.38, 3, 5, 'steel'), bx(-.42, -.38, -.38, -.02, 0, 2, 'steel'), bx(.38, .42, -.38, -.02, 0, 2, 'steel')]
    G = Geom(g, ramps={'solar', 'steel', 'ink'}); G.back = back
    def panel(cv, r, m):
        P = lambda x, y, z: scr(x, y, z, r, m, cv)
        pts = [P(-.42, py0, pz0), P(.42, py0, pz0), P(.42, py1, pz1), P(-.42, py1, pz1)]
        # frame (slightly bigger, steel) then the cells
        quad(cv, [P(-.44, py0 + .02, pz0 - 1), P(.44, py0 + .02, pz0 - 1), P(.44, py1 - .02, pz1 + 1), P(-.44, py1 - .02, pz1 + 1)], 'steel', tone=1, ink=True)
        quad(cv, pts, 'solar', grid=(6, 3), glint=(ph if on else None), tone=1, ink=False)
    G.pre.append(panel)
    if on: G.soft.append(glow(.03, .43, 9, 4, 3, '#84f4ff', .35, 1.2))
    return G

# ------------------------------------------------------------------ 10 battery_small (1x1, 0.5 x 0.3 x 0.6 m)
def battery_small(on, ph):
    H = round(zm(.6))                                   # 18 px incl. terminals
    f = int(ph * 4) if on else 0
    g = [bx(-.25, .25, -.15, .15, 0, 13, 'gunmetal', l=tex_plate(9, 7), r=tex_grille(2, horiz=False)),
         bx(-.26, .26, -.16, .16, 13, 15, 'graphite'),
         bx(-.17, .17, .15, .162, 9, 12, 'hazard', edge=False)]          # label strip
    g += _leds(-.16, .16, .15, 4, 7, 4, f + 1 if on else 0)
    g += cyl(-.15, 0, .045, 15, 17, 'brick_red', n=4) + cyl(.15, 0, .045, 15, 17, 'rubber', n=4)
    g += [bx(-.04, .04, -.15, .15, 15, H, 'rubber'), bx(-.18, .18, -.02, .02, H - 1, H, 'rubber')]   # strap handle
    G = Geom(g, ramps={'ink'})
    def bolt(c):   # lightning bolt on the label
        c.fill([(16.4, 13.6), (15.2, 15.6), (16.2, 15.6), (15.4, 17.6), (17.2, 15.0), (16.2, 15.0), (17, 13.6)], ramp('ink')[1])
    G.dec.append(deco(.0, .16, 10.5, bolt, 32, .5))
    if on: G.soft.append(glow(0, .16, 5.5, 5, 2, '#86ff70', .3, 1.0))
    return G

# ------------------------------------------------------------------ 11 battery_medium (1x1, 0.6 x 0.6 x 1.3 m)
def battery_medium(on, ph):
    H = round(zm(1.3))                                  # 39 px: inverter top
    f = int(ph * 4) if on else 0
    g = []
    for sx in (-.3, .27):                               # rack posts
        for sy in (-.3, .27): g.append(bx(sx, sx + .03, sy, sy + .03, 0, 30, 'steel'))
    for i, z in enumerate((2, 9, 16, 23)):              # 4 modules
        g += [bx(-.27, .27, -.27, .27, z, z + 6, 'graphite', l=tex_plate(8, 6)),
              bx(-.2, -.08, .27, .282, z + 2, z + 4, L(on and (i + f) % 4 != 3, 'lit_green'), edge=False),
              bx(.1, .2, .27, .282, z + 2, z + 4, 'hazard', edge=False)]
    g += [bx(.27, .29, .1, .16, 2, 29, 'copper', edge=False), bx(.27, .29, -.16, -.1, 2, 29, 'copper', edge=False)]   # bus bars (+x face)
    g += [bx(-.31, .31, -.31, .31, 29, 31, 'steel')]
    # inverter on top
    g += [bx(-.24, .24, -.2, .24, 31, H, 'teal_paint', r=tex_grille(2, horiz=False)),
          bx(-.18, .02, .24, .252, 33, 37, L(on, 'lit_cyan', 'off_screen'), edge=False)]
    g += _leds(.06, .2, .24, 33.5, 35.5, 5, ((f + 2) if on else 0), lit='lit_amber')
    g += [bx(.28, .31, .2, .26, 6, 30, 'cable', edge=False)]
    return Geom(g, ramps={'ink'}, soft=[glow(-.08, .25, 35, 5, 3, '#84f4ff', .3, 1.2)] if on else [])

# ------------------------------------------------------------------ 12 battery_large (2x1, 1.8 x 0.8 x 2.0 m)
def battery_large(on, ph):
    H = round(zm(2.0))                                  # 61 px: cabinet tops
    f = int(ph * 4) if on else 0
    g = []
    for k, (x0, x1) in enumerate(((-.9, -.32), (.32, .9))):
        g += [bx(x0, x1, -.38, .38, 0, 3, 'gunmetal'),
              bx(x0 + .02, x1 - .02, -.36, .36, 3, H - 2, 'cream', l=flat(.03), r=tex_grille(3)),
              bx(x0, x1, -.38, .38, H - 2, H, 'gunmetal'),
              bx(x0 + .05, x1 - .05, .36, .372, 6, H - 8, 'cream', edge=False),                        # door
              bx(x0 + .07, x1 - .07, .372, .38, 7, 12, 'gunmetal', l=tex_grille(2), edge=False),      # door louvre
              bx(x0 + .05, x1 - .05, .36, .384, H - 8, H - 7, 'gunmetal', edge=False),
              bx(x1 - .1, x1 - .07, .372, .384, 26, 34, 'gunmetal', edge=False),                       # handle
              bx(x0 + .08, x0 + .22, .372, .38, 44, 50, 'hazard', edge=False)]                         # warning label
        n_lit = ((f + 1 + k) % 5 + 1) if on else 0
        g += _vleds(x0 + .28, x0 + .36, .372, 12, 42, 6, n_lit)
    # inverter / charger between the cabinets
    g += [bx(-.3, .3, -.3, .3, 0, 3, 'gunmetal'), bx(-.28, .28, -.26, .26, 3, 38, 'teal_paint', r=tex_grille(2)),
          bx(-.2, .04, .26, .272, 26, 32, L(on, 'lit_cyan', 'off_screen'), edge=False),
          bx(.1, .2, .26, .272, 28, 31, L(on, 'lit_green'), edge=False)]
    g += [bx(-.34, .34, -.08, .02, H - 9, H - 6, 'gunmetal'), bx(-.04, .04, -.08, .02, 38, H - 8, 'gunmetal')]   # conduit
    g += [bx(.3, .34, .26, .32, 0, 20, 'cable', edge=False), bx(-.34, -.3, .24, .3, 0, 14, 'cable', edge=False)]
    G = Geom(g, ramps={'ink', 'steel', 'rubber'})
    a0 = (ph * 2 * math.pi / 3) if on else .3
    def fan(c):   # inverter fan on the front face
        c.part(ellipse_pts(16, 16, 4.4, 4.4, n=24), 'gunmetal', lw=.6, shade=.1, hl=0)
        c.fill(ellipse_pts(16, 16, 3.6, 3.6, n=24), ramp('rubber')[2])
        for i in range(3):
            a = a0 + i * 2 * math.pi / 3
            c.fill([(16, 16), (16 + 3.4 * math.cos(a), 16 + 3.4 * math.sin(a)), (16 + 3.2 * math.cos(a + .7), 16 + 3.2 * math.sin(a + .7))], ramp('steel')[1])
        c.fill(ellipse_pts(16, 16, 1, 1, n=10), ramp('steel')[2])
    # fan sits on the inverter's +y face (rot 0) / +x face (rot 1 after rotation the +y face is camera-left again)
    G.dec.append(deco(-.08, .27, 15, fan, 32, .5))
    if on: G.soft.append(glow(-.08, .28, 29, 6, 3, '#84f4ff', .3, 1.2))
    return G

# ------------------------------------------------------------------ 13 power_pylon (1x1, 0.6 x 0.6 x 3.0 m)
def power_pylon(on, ph):
    H = round(zm(3.0))                                  # 91 px: dish rim
    g = [bx(-.3, .3, -.3, .3, 0, 7, 'concrete', l=tex_plate(12, 7), r=tex_plate(12, 7)),     # weighted base block
         bx(-.33, -.12, .1, .34, 0, 5, 'cloth_green' if False else 'leather'),                # sandbag
         bx(.12, .34, -.33, -.1, 0, 5, 'leather'),
         bx(-.1, .1, -.1, .1, 7, 10, 'gunmetal')]
    g += cyl(0, 0, .05, 10, 72, 'steel', n=5)                                                  # mast
    g += [bx(-.15, .15, -.015, .015, 46, 48, 'steel'), bx(-.015, .015, -.15, .15, 52, 54, 'steel')]   # stays
    g += [bx(.05, .07, -.03, .03, 20, 64, 'cable', edge=False)]                                 # feed cable
    g += [bx(-.06, .06, .3, .312, 2, 5, L(on, 'lit_cyan'), edge=False)]                        # status LED on the base
    G = Geom(g, ramps={'copper', 'steel', 'lit_cyan', 'off_led', 'gunmetal', 'ink'})
    pulse = (.5 + .5 * math.sin(2 * math.pi * ph)) if on else 0
    def head(c):   # toroidal coil + hub + small dish (toon, 64 px canvas anchored at z 72)
        cx, cy = 32, 44
        ring(c, cx, cy, 11, 5.5, 5, 'copper', inner=.45, hub=ramp('gunmetal')[2], stripes=18)
        if on:   # glowing inner band of the coil
            gr = ramp('lit_cyan')[0 if pulse > .5 else 1]
            c.fill(ellipse_pts(cx, cy - 5, 7.2, 3.6, n=36), ramp('lit_cyan')[2]); c.fill(ellipse_pts(cx, cy - 5, 5.6, 2.8, n=36), gr)
        c.fill(ellipse_pts(cx, cy - 5, 4.6, 2.3, n=30), ramp('gunmetal')[1])
        c.part([(cx - 1.2, cy - 5), (cx + 1.2, cy - 5), (cx + 1.2, cy - 13), (cx - 1.2, cy - 13)], 'steel', lw=.6, shade=.3, hl=.1)   # dish post
        c.part(ellipse_pts(cx + 1, cy - 15, 6, 3.4, rot=-.35, n=30), 'steel', lw=.8, shade=.25, hl=.2)                 # dish
        c.fill(ellipse_pts(cx + 1.2, cy - 15.4, 4.2, 2.2, rot=-.35, n=24), ramp('steel')[2])
        c.part(ellipse_pts(cx + 1.4, cy - 16.4, 1, 1, n=10), L(on, 'lit_cyan'), lw=.4, shade=0, hl=0, flat=True)          # feed horn LED
    G.dec.append(deco(0, 0, 72, head, 64, 44 / 64))
    if on:
        a = .22 + .5 * pulse
        G.soft.append(glow(0, 0, 77, 13, 7, '#84f4ff', a, 1.6))
        # faint arc ring expanding with the phase
        def arc(cv, r, m, ph=ph):
            from .lib import soft_poly
            from PIL import Image, ImageDraw, ImageFilter
            px, py = scr(0, 0, 77, r, m, cv); k = 1 + ph * 1.6; rx, ry = 12 * k * 4, 6 * k * 4
            mm = Image.new('L', (cv.W, cv.H), 0); d = ImageDraw.Draw(mm)
            d.ellipse([px - rx, py - ry, px + rx, py + ry], outline=int(255 * .55 * (1 - ph)), width=4)
            mm = mm.filter(ImageFilter.GaussianBlur(3)); layer = Image.new('RGBA', (cv.W, cv.H), (132, 244, 255, 0)); layer.putalpha(mm)
            cv.img = Image.alpha_composite(cv.img, layer)
        G.soft.append(('glow', arc))
    return G

PIECES = {   # key: (fn, footprint, cls, rows, frames, fps)
    'generator_fuel': (generator_fuel, (2, 1), 'W', 2, 6, 12),
    'generator_solar': (generator_solar, (1, 1), 'S', 1, 4, 4),
    'battery_small': (battery_small, (1, 1), 'S', 1, 4, 2),
    'battery_medium': (battery_medium, (1, 1), 'T', 1, 4, 2),
    'battery_large': (battery_large, (2, 1), 'W', 2, 4, 2),
    'power_pylon': (power_pylon, (1, 1), 'XT', 1, 6, 8),
}
