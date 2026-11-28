"""Electricity tier art kit (ADR-590 brief docs/ART_KEYS_ELECTRICITY.md): iso box pieces rendered with the shared toolkit
(assets/tools: buildings.render_boxes, iso, toon) -> solid-cel colour frames (1x + @2x) + emissive frames.

Conventions (same as hearths.py / decor/lib.py, ADR-218 lit/unlit):
  * pivot = footprint centre on the ground; 1 tile = 1 m of footprint; z in px at 1x = metres x 30.29 (53 px player).
  * geometry fn(state, ph) -> Geom(boxes, decor, soft, ramps); state 'unlit' (powered off / not in use) or 'on' with
    phase ph in [0, 1) for the looping active animation.
  * colour frames are cel-snapped to the ramps the piece paints with (flat fills, one hard shade, hard highlight,
    binary alpha, bold outline); `soft` effects (glow halos, smoke, steam, shimmer, mist) are composited afterwards with
    soft alpha (the only soft pixels the house style allows).
  * emissive = the pixels painted with a `lit_*` ramp (+ the soft glow halos), RGB premultiplied by the mask, the
    rest fully transparent (compresses to a few KB like hearth_t_emissive).
"""
import math, os, sys, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..')); sys.path.insert(0, os.path.join(HERE, '../../../../../../assets/tools'))
from decor.lib import B, flat, planksH, planksV, cobble   # noqa: E402  (also registers enamel / black_iron / silver ramps)
from buildings import render_boxes, lw_fn                  # noqa: E402
from iso import add_outline, IsoCanvas                     # noqa: E402
from toon import downscale, SS, Canvas, ellipse_pts, capsule_pts, noise, INK   # noqa: E402
from palette import RAMPS, ramp, hex2rgb                   # noqa: E402
from cel import snap                                       # noqa: E402

PX_M = 30.29   # px per metre of height (player doll 53 px = 1.75 m)
def zm(m): return m * PX_M

# ---------------------------------------------------------------- ramps (body)
for k, v in {
    'steel':      ['#f0f4f7', '#bcc6ce', '#8794a2', '#5b6576'],
    'gunmetal':   ['#9aa4b4', '#6b7486', '#4b5264', '#333848'],
    'graphite':   ['#7d8596', '#565e6e', '#3e4454', '#2a2e3c'],
    'genset':     ['#d6eea8', '#93c464', '#629a48', '#3f6a35'],
    'safety':     ['#ffe7b0', '#f8a948', '#d2742e', '#924a26'],
    'hazard':     ['#fff3a6', '#f6cb45', '#d79c2c', '#9a6622'],
    'cable':      ['#6c717c', '#474c58', '#30343f', '#1f222b'],
    'solar':      ['#9cc4ff', '#4677d6', '#2c509f', '#1c3372'],
    'concrete':   ['#e6e2db', '#c4bfb7', '#9c9790', '#706c67'],
    'rubber':     ['#5a5e66', '#3c4048', '#2a2d34', '#1c1e24'],
    'teal_paint': ['#b8ece4', '#62bfb2', '#3f8f86', '#2a6260'],
    'brick_red':  ['#f2a88e', '#c8644c', '#94443a', '#62302c'],
    'cream':      ['#fffaf0', '#efe6d2', '#cbbfa6', '#9a8e78'],
    'mint_enamel':['#effff6', '#c4eedb', '#93cbb3', '#5f9a84'],
    'sky_enamel': ['#f2f8ff', '#cfe0f4', '#9fb8d6', '#6e88aa'],
    'water':      RAMPS.get('water'),
}.items():
    if v: RAMPS.setdefault(k, v)
# glow ramps: every colour unique so the emissive mask is an exact palette lookup after the cel snap
LIT = {
    'lit_green': ['#eaffd4', '#86ff70', '#34e25c', '#18a84a'],
    'lit_red':   ['#ffdcd0', '#ff7456', '#ea3a2e', '#ac2220'],
    'lit_amber': ['#fff6c6', '#ffd352', '#f8a024', '#c87214'],
    'lit_cyan':  ['#e4ffff', '#84f4ff', '#34cdf4', '#1a96c6'],
    'lit_warm':  ['#fffcec', '#fff2b8', '#ffdc80', '#f4b450'],
    'lit_hot':   ['#fff2c4', '#ffb656', '#ff702e', '#dc4020'],
    'lit_grow':  ['#ffecff', '#ff92ea', '#e858cc', '#ae38a0'],
    'lit_white': ['#fefeff', '#eef8ff', '#d4e8ff', '#aac8ee'],
    'lit_violet':['#f2e8ff', '#c4a0ff', '#9468f0', '#6a44c4'],
}
for k, v in LIT.items(): RAMPS[k] = v
OFF = {   # powered-off looks of the same parts (dark glass / cold coils / unlit LEDs)
    'off_led':    ['#8c9894', '#5e6866', '#434b4c', '#2d3334'],
    'off_lamp':   ['#ece6d6', '#c6bfae', '#9a9484', '#6c675e'],
    'off_hob':    ['#6a6066', '#4a4248', '#343036', '#232026'],
    'off_screen': ['#6f8c8c', '#43595c', '#2e4042', '#1e2c2e'],
    'off_grow':   ['#d8d0dc', '#aaa0b0', '#7e7686', '#58525e'],
}
for k, v in OFF.items(): RAMPS[k] = v
GLOW = {hex2rgb(c) for v in LIT.values() for c in v}
GLOW_ARR = np.array(sorted(GLOW), np.int32)

def L(on, lit, off='off_led'):
    """ramp for a light part: lit ramp while on, else its powered-off ramp."""
    return lit if on else off

# ---------------------------------------------------------------- frame classes (w, h, ox, oy) at 1x
CLS = {'S': (64, 88, 32, 70), 'T': (72, 120, 36, 102), 'W': (104, 120, 52, 94), 'WT': (144, 152, 72, 118),
       'XT': (72, 168, 36, 144), 'XW': (184, 216, 92, 180), 'XXL_T': (112, 240, 56, 216), 'XXL_L': (176, 376, 88, 348)}

class Geom:
    def __init__(self, bx, dec=(), soft=(), ramps=()):
        self.bx, self.dec, self.soft, self.ramps = list(bx), list(dec), list(soft), set(ramps); self.pre = []; self.back = []

# ---------------------------------------------------------------- box helpers
def bx(x0, x1, y0, y1, z0, z1, rp, t=None, l=None, r=None, edge=True, faces='tlr', amp=.06):
    f = flat(amp); z1 = max(z1, z0 + .5); x1 = max(x1, x0 + .004); y1 = max(y1, y0 + .004)
    return B(x0, x1, y0, y1, z0, z1, rp, top=t or f, left=l or f, right=r or f, faces=faces, edge=edge)

def cbox(cx, cy, hx, hy, z0, z1, rp, **k):
    return bx(cx - hx, cx + hx, cy - hy, cy + hy, z0, z1, rp, **k)

def cyl(cx, cy, rad, z0, z1, rp, n=10, axis='z', **k):
    """vertical cylinder from thin x-strips (no ink between strips so it reads round)."""
    out = []
    for i in range(n):
        a0 = -rad + 2 * rad * i / n; a1 = a0 + 2 * rad / n; am = (a0 + a1) / 2; hw = math.sqrt(max(0, rad * rad - am * am))
        out.append(bx(cx + a0, cx + a1, cy - hw, cy + hw, z0, z1, rp, edge=False, **k))
    return out

def tex_grille(pitch=3, horiz=True, depth=1.2):
    def f(w, h, s):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32); c = yy if horiz else xx
        return np.where((c % (pitch * SS)) < SS * .9, 2.6, 1.0 + (noise(w, h, 4 * SS, s) - .5) * .12)
    return f

def tex_cells(nx=6, ny=3, gap=.7):
    """solar cell grid (busbar lines + cell gaps) for panel tops."""
    def f(w, h, s):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32); cw, ch = w / nx, h / ny
        g = ((xx % cw) < SS * gap) | ((yy % ch) < SS * gap)
        bus = (np.abs((xx % cw) - cw / 2) < SS * .25)
        t = np.where(g, -0.6, 1.15 + (noise(w, h, 6 * SS, s) - .5) * .1)
        return np.where(bus & ~g, .5, t)
    return f

def tex_plate(pw=10, ph=8):
    def f(w, h, s):
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32); P, Q = pw * SS, ph * SS
        fx, fy = xx % P, yy % Q; t = 1.0 + (noise(w, h, 5 * SS, s) - .5) * .18
        t = np.where((fx < SS * .8) | (fy < SS * .8), 2.6, t)
        riv = ((np.abs(fx - SS * 2) < SS * .8) | (np.abs(fx - P + SS * 2) < SS * .8)) & ((np.abs(fy - SS * 2) < SS * .8) | (np.abs(fy - Q + SS * 2) < SS * .8))
        return np.where(riv, -.4, t)
    return f

def sprite_at(cv, x, y, z, rot, mirror, draw, size=32, cy=.5):
    """draw fn(Canvas) on a size x size toon canvas whose (size/2, size*cy) lands on local (x, y, z)."""
    f = lw_fn(rot, mirror); wx, wy = f(x, y); px, py = cv.P(wx, wy, z)
    c = Canvas(size, size, seed=int(abs(x * 100 + y * 10 + z)) + 1); draw(c)
    cv.paste_sprite(c.img, px - size * SS / 2, py - size * cy * SS)

def deco(x, y, z, draw, size=32, cy=.5):
    return (-1, lambda cv, r, m: sprite_at(cv, x, y, z, r, m, draw, size, cy))

def scr(x, y, z, rot, mirror, cv):
    """local point -> SS screen point on cv."""
    f = lw_fn(rot, mirror); wx, wy = f(x, y); return cv.P(wx, wy, z)

def facing(rot, mirror, nx, ny):
    """local face normal -> True when it faces the camera after rotation."""
    f = lw_fn(rot, mirror); a, b = f(nx, ny); return a + b > 0.05

# ---------------------------------------------------------------- soft effects (drawn on an IsoCanvas, soft alpha)
def soft_blob(cv, x, y, z, rot, mirror, rx, ry, color, alpha, blur=1.5):
    px, py = scr(x, y, z, rot, mirror, cv)
    m = Image.new('L', (cv.W, cv.H), 0); ImageDraw.Draw(m).ellipse([px - rx * SS, py - ry * SS, px + rx * SS, py + ry * SS], fill=int(255 * alpha))
    if blur: m = m.filter(ImageFilter.GaussianBlur(blur * SS))
    layer = Image.new('RGBA', (cv.W, cv.H), tuple(hex2rgb(color) if isinstance(color, str) else color) + (0,)); layer.putalpha(m)
    cv.img = Image.alpha_composite(cv.img, layer)

def soft_poly(cv, pts_ss, color, alpha, blur=1.0):
    m = Image.new('L', (cv.W, cv.H), 0); ImageDraw.Draw(m).polygon(pts_ss, fill=int(255 * alpha))
    if blur: m = m.filter(ImageFilter.GaussianBlur(blur * SS))
    layer = Image.new('RGBA', (cv.W, cv.H), tuple(hex2rgb(color) if isinstance(color, str) else color) + (0,)); layer.putalpha(m)
    cv.img = Image.alpha_composite(cv.img, layer)

def glow(x, y, z, rx, ry, color, alpha=.45, blur=2.0):
    """emissive halo (soft)."""
    return ('glow', lambda cv, r, m: soft_blob(cv, x, y, z, r, m, rx, ry, color, alpha, blur))

def smoke(x, y, z, rx, ry, color='#d8d4d0', alpha=.5, blur=1.2):
    """non-emissive soft puff (smoke / steam / frost / mist)."""
    return ('smoke', lambda cv, r, m: soft_blob(cv, x, y, z, r, m, rx, ry, color, alpha, blur))

def soft_fn(kind, fn):
    return (kind, fn)

def _render(g, rot, seed, cell, origin):
    """buildings.render_boxes + `pre` hooks (decor drawn before every box: panels / wheels behind a body)."""
    from buildings import xform, painter_sort
    cv = IsoCanvas(cell[0], cell[1], origin[0], origin[1], seed)
    back = getattr(g, 'back', [])
    if back:
        bq = []
        for i, b in enumerate(painter_sort([xform(b, rot) for b in back])):
            q = cv.box(*b.v, b.rp, b.top, b.left, b.right, seed=seed * 17 + i * 5, faces=b.faces)
            if b.edge: bq += q
        cv.ink_edges(bq); cv.edges = []
    for fn in getattr(g, 'pre', ()): fn(cv, rot, False)
    bs = painter_sort([xform(b, rot) for b in g.bx]); quads = []
    for i, b in enumerate(bs):
        q = cv.box(*b.v, b.rp, b.top, b.left, b.right, seed=seed * 31 + i * 7, faces=b.faces)
        if b.edge: quads += q
    cv.ink_edges(quads)
    for after, fn in g.dec: fn(cv, rot, False)
    return cv

def quad(cv, pts, rp, grid=None, glint=None, lw=.9, tone=1, ink=True):
    """flat quad in SS screen coords (4 points, p0->p1 = u, p0->p3 = v): base tone, grid lines in the shade tone,
    an optional glint band at u+v phase `glint` (0..1, hard-edged highlight), ink outline."""
    r = ramp(rp); W, H = cv.W, cv.H
    m = Image.new('L', (W, H), 0); ImageDraw.Draw(m).polygon(pts, fill=255)
    layer = Image.new('RGBA', (W, H), tuple(r[tone]) + (0,)); layer.putalpha(m); cv.img = Image.alpha_composite(cv.img, layer)
    d = Image.new('L', (W, H), 0); dd = ImageDraw.Draw(d)
    p0, p1, p2, p3 = [np.array(p, np.float32) for p in pts]
    if glint is not None:
        for gph, gw in ((glint, .12), (glint + .2, .05)):
            g0, g1 = gph * 2 - .3, gph * 2 - .3 + gw
            poly = []
            for (a, b) in ((g0, 0), (g1, 0)):
                pass
            def P(u, v): return tuple(p0 + (p1 - p0) * u + (p3 - p0) * v)
            band = [P(min(1, max(0, g0)), 0), P(min(1, max(0, g1)), 0), P(min(1, max(0, g1 - 1)), 1), P(min(1, max(0, g0 - 1)), 1)]
            hm = Image.new('L', (W, H), 0); ImageDraw.Draw(hm).polygon(band, fill=255)
            from PIL import ImageChops
            hm = ImageChops.multiply(hm, m); hl = Image.new('RGBA', (W, H), tuple(r[0]) + (0,)); hl.putalpha(hm); cv.img = Image.alpha_composite(cv.img, hl)
    if grid:
        nx, ny = grid
        for i in range(1, nx): a = p0 + (p1 - p0) * i / nx; b = p3 + (p2 - p3) * i / nx; dd.line([tuple(a), tuple(b)], fill=255, width=max(1, int(SS * .6)))
        for j in range(1, ny): a = p0 + (p3 - p0) * j / ny; b = p1 + (p2 - p1) * j / ny; dd.line([tuple(a), tuple(b)], fill=255, width=max(1, int(SS * .6)))
        from PIL import ImageChops
        d = ImageChops.multiply(d, m); gl = Image.new('RGBA', (W, H), tuple(r[min(3, tone + 1)]) + (0,)); gl.putalpha(d); cv.img = Image.alpha_composite(cv.img, gl)
    if ink: cv.lines(pts, tuple(r[3]) if not isinstance(ink, tuple) else ink, lw, 255, closed=True)

def ring(c, cx, cy, rx, ry, th, rp, inner=.55, hub=None, stripes=0, lw=.8):
    """iso horizontal ring/torus on a toon Canvas (1x coords): body of thickness th px, top face with a hole."""
    r = ramp(rp)
    for k in range(int(th * 2)):
        c.fill(ellipse_pts(cx, cy - k / 2, rx, ry, n=40), r[2])
    c.part(ellipse_pts(cx, cy - th, rx, ry, n=40), rp, lw=lw, shade=.15, hl=.2)
    if stripes:
        for i in range(stripes):
            a = 2 * math.pi * i / stripes
            if math.sin(a) > -0.2:
                x, y = cx + math.cos(a) * rx, cy - th + math.sin(a) * ry
                c.line([(x, y), (x, y + th)], r[3], .5)
    c.fill(ellipse_pts(cx, cy - th, rx * inner, ry * inner, n=32), hub or r[3])

# ---------------------------------------------------------------- render one frame
def _palette(rps):
    pal = []
    for r in sorted(rps): pal += [tuple(c) for c in ramp(r)]
    pal += [(255, 248, 225), tuple(INK)]
    from toon import lerp
    pal += [lerp(INK, (40, 25, 40), 0.2), lerp(INK, (90, 60, 70), 0.3), lerp(INK, (60, 40, 50), 0.2)]
    pal += [tuple(hex2rgb(c)) for c in RAMPS['ink']]
    return pal

def _glow_mask(im):
    a = np.asarray(im).astype(np.int32); rgb = a[..., :3]; key = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    gk = (GLOW_ARR[:, 0] << 16) | (GLOW_ARR[:, 1] << 8) | GLOW_ARR[:, 2]
    return np.isin(key, gk) & (a[..., 3] == 255)

def _compose(g, rot, cls, fp, seed, shadow, shadow_rect):
    w, h, ox, oy = CLS[cls]
    cv = _render(g, rot, seed, (w, h), (ox, oy))
    img = add_outline(cv.img, 1.0, seed + rot)
    if shadow:
        fw, fh = (fp[1], fp[0]) if rot % 2 else fp
        x0, x1, y0, y1 = shadow_rect or (-fw / 2 + .04, fw / 2 - .04, -fh / 2 + .04, fh / 2 - .04)
        if shadow_rect and rot % 2: x0, x1, y0, y1 = -y1, -y0, x0, x1
        sh = IsoCanvas(w, h, ox, oy); sh.ground_shadow(x0, x1, y0, y1, grow=.06, alpha=.26); img = Image.alpha_composite(sh.img, img)
    return img

KEYCOL = '#ff00fe'
def render_frame(g, rot, cls, fp, seed, shadow=True, shadow_rect=None, geom=None):
    """-> dict(col=(1x, 2x), em=(1x, 2x), clip=bool, top=px above pivot at 1x).
    Emissive: the frame is rendered twice, the second time with every lit_* ramp swapped to a key colour; pixels that
    differ and carry a lit_* colour are the glowing parts (exact even where body highlights snap close to a glow tint).
    `geom` = zero-arg callable rebuilding g (decor closures read RAMPS at draw time, so the swap reaches them too)."""
    w, h, ox, oy = CLS[cls]
    for b in g.bx + g.back:
        if min(b.v[1] - b.v[0], b.v[3] - b.v[2]) < .03: b.edge = False
    img = _compose(g, rot, cls, fp, seed, shadow, shadow_rect)
    rps = {b.rp for b in g.bx} | {b.rp for b in g.back} | g.ramps
    pal = _palette(rps)
    uses_lit = any(r.startswith('lit_') for r in rps)
    img_k = None
    if uses_lit:
        saved = {k: RAMPS[k] for k in LIT}
        try:
            for k in LIT: RAMPS[k] = [KEYCOL] * 4
            g2 = geom() if geom else g
            for b in g2.bx + g2.back:
                if min(b.v[1] - b.v[0], b.v[3] - b.v[2]) < .03: b.edge = False
            img_k = _compose(g2, rot, cls, fp, seed, shadow, shadow_rect)
        finally:
            RAMPS.update(saved)
    bb = img.getchannel('A').point(lambda a: 255 if a > 90 else 0).getbbox()
    clip = bool(bb and (bb[0] <= 0 or bb[1] <= 0 or bb[2] >= img.size[0] or bb[3] >= img.size[1]))
    cols, ems = [], []
    sv = gv = None
    if g.soft:
        sv = IsoCanvas(w, h, ox, oy); gv = IsoCanvas(w, h, ox, oy)
        for kind, fn in g.soft: fn(gv if kind == 'glow' else sv, rot, False)
    top = 0
    for s in (1, 2):
        c = snap(downscale(img, (w * s, h * s)), pal)
        if s == 1:
            rws = np.nonzero((np.asarray(c)[..., 3] >= 128).any(1))[0]; top = int(oy - rws.min()) if len(rws) else 0
        if img_k is not None:
            kk = np.asarray(downscale(img_k, (w * s, h * s))).astype(np.int32)
            ca0 = np.asarray(c).astype(np.int32)
            kcol = np.array(hex2rgb(KEYCOL), np.int32)
            keyish = (np.abs(kk[..., :3] - kcol).sum(-1) < 200) & (kk[..., 3] > 60)
            gm = _glow_mask(c) & keyish
        else:
            gm = np.zeros((h * s, w * s), bool)
        a = np.asarray(c).astype(np.float32); m = gm.astype(np.float32)[..., None]
        em = np.concatenate([a[..., :3] * m, m * 255], -1)
        if sv is not None:
            sl = downscale(sv.img, (w * s, h * s), sharpen=False); gl = downscale(gv.img, (w * s, h * s), sharpen=False)
            c = Image.alpha_composite(Image.alpha_composite(c, sl), gl)
            ga = np.asarray(gl).astype(np.float32); ea = Image.fromarray(em.astype(np.uint8), 'RGBA')
            ea = Image.alpha_composite(Image.fromarray(np.concatenate([ga[..., :3], ga[..., 3:4]], -1).astype(np.uint8), 'RGBA'), ea)
            em = np.asarray(ea).astype(np.float32)
            em[..., :3] *= em[..., 3:4] / 255.0
        ca = np.asarray(c).copy(); al = ca[..., 3]; soft_px = (al > 0) & (al < 255)
        ca[..., 3] = np.where(soft_px, (np.round(al / 17.0) * 17).astype(np.uint8), al); ca[ca[..., 3] == 0] = 0
        e8 = em.astype(np.uint8); e8[..., 3] = (np.round(e8[..., 3] / 17.0) * 17).astype(np.uint8); e8[e8[..., 3] == 0] = 0
        cols.append(Image.fromarray(ca, 'RGBA')); ems.append(Image.fromarray(e8, 'RGBA'))
    return dict(col=tuple(cols), em=tuple(ems), clip=clip, top=top)


# ---------------------------------------------------------------- wheels / rotors in a vertical plane
def plane_pt(cv, rot, c, u, t, r, w=0.0):
    """screen SS point of a vertical-plane circle: centre c = (x, y, z) local (x, y in tiles, z px), in-plane horizontal unit
    u = (ux, uy) local, angle t (0 = +u, pi/2 = up), radius r in metres (z uses 30.29 px/m), offset w metres along the
    plane normal (axle direction, n = (-uy, ux) rotated +90 deg)."""
    ux, uy = u; nx, ny = -uy, ux
    x = c[0] + ux * r * math.cos(t) + nx * w; y = c[1] + uy * r * math.cos(t) + ny * w; z = c[2] + r * math.sin(t) * PX_M
    f = lw_fn(rot, False); wx, wy = f(x, y); return cv.P(wx, wy, z)

def ss_poly(cv, pts, color, ink=None, lw=.7):
    m = Image.new('L', (cv.W, cv.H), 0); ImageDraw.Draw(m).polygon(pts, fill=255)
    col = tuple(color) if not isinstance(color, str) else hex2rgb(color)
    layer = Image.new('RGBA', (cv.W, cv.H), col + (0,)); layer.putalpha(m); cv.img = Image.alpha_composite(cv.img, layer)
    if ink is not None: cv.lines(pts, ink, lw, 255, closed=True)

def ss_line(cv, pts, color, width=.8):
    cv.lines(pts, tuple(color) if not isinstance(color, str) else hex2rgb(color), width, 255)
