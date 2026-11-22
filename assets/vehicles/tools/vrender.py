"""SurVivaZ vehicle toon renderer: tiny 3D (boxes/taper prisms/cylinders/rods) -> 2:1 iso, SS=4 supersampled,
painter-sorted, 3-band cel shading (light top-left), inner part lines + soft ink outline, per-pixel material ids
(paint -> tint mask, lamp -> emissive). Local vehicle coords: x forward, y right, z up, units = tiles (64x32 iso tile)."""
import math, numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 4
U = 64 / math.sqrt(2)           # ground px per tile edge (1x)
# True scale (2026-11 vehicles pass): 1 tile = 1 m of footprint (U = 45.25 px per m along the E/W view, U/2 in depth) and
# heights at the player doll's scale: 53 px = 1.75 m -> ZK = 30.29 px per m of height. Model z units are metres.
PX_PER_M_V = 53.0 / 1.75
ZK = PX_PER_M_V
KR = ZK / U  # x-radius factor that keeps a wheel disc round on screen in the E/W view (vertical px/m != horizontal px/m)
# screen = (u*U, v*U/2 - z*ZK): the projection's null direction (the camera ray) is (0, ZK, U/2), so backface culling and
# painter depth use exactly that ray (was (0, cos30, sin30) when ZK = U*cos30).
VIEW = np.array([0.0, ZK, 0.5 * U]); VIEW /= np.linalg.norm(VIEW)  # toward camera in (u,v,z)
LIGHT = np.array([-0.55, -0.35, 0.95]); LIGHT /= np.linalg.norm(LIGHT)
INK = (52, 36, 60)
DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]
# material ids
M_NONE, M_PAINT, M_GLASS, M_TYRE, M_METAL, M_LAMP, M_TRIM, M_WOOD, M_LIGHTBODY, M_INTERIOR = range(10)

def hexc(h): h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def lerp(a, b, t): return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))
def clamp8(c): return tuple(max(0, min(255, int(v))) for v in c)

PAINT_NEUTRAL = (199, 197, 194)   # ~0.78 grey: tint formula out = base*mix(1, color/0.78, s*mask)

class Prim:
    """polys: list of (verts[np(n,3)], normal or None, mat, color, emis) ; rods: (p0,p1,radius_px,mat,color)."""
    def __init__(self, polys=None, rods=None, bias=0.0, name=""):
        self.polys = polys or []; self.rods = rods or []; self.bias = bias; self.name = name

def _quad_n(v):
    n = np.cross(v[1] - v[0], v[2] - v[0]); l = np.linalg.norm(n); return n / l if l > 1e-9 else n

def prism(bot, top, z0, z1, mat, color, emis=None, bias=0.0, skip=()):
    """bot/top = (x0,x1,y0,y1) rectangles at z0/z1 (taper allowed)."""
    bx0, bx1, by0, by1 = bot; tx0, tx1, ty0, ty1 = top
    B = [np.array(p, float) for p in [(bx0, by0, z0), (bx1, by0, z0), (bx1, by1, z0), (bx0, by1, z0)]]
    T = [np.array(p, float) for p in [(tx0, ty0, z1), (tx1, ty0, z1), (tx1, ty1, z1), (tx0, ty1, z1)]]
    faces = {"bottom": [B[0], B[3], B[2], B[1]], "top": [T[0], T[1], T[2], T[3]],
             "left": [B[0], B[1], T[1], T[0]], "front": [B[1], B[2], T[2], T[1]],
             "right": [B[2], B[3], T[3], T[2]], "back": [B[3], B[0], T[0], T[3]]}
    polys = []
    for k, f in faces.items():
        if k in skip: continue
        c = color[k] if isinstance(color, dict) else color
        m = mat[k] if isinstance(mat, dict) else mat
        e = emis[k] if isinstance(emis, dict) else emis
        if c is None: continue
        polys.append((np.array(f), None, m, c, e))
    return Prim(polys, bias=bias)

def box(x0, x1, y0, y1, z0, z1, mat, color, emis=None, bias=0.0, inset=0.0, skip=()):
    return prism((x0, x1, y0, y1), (x0 + inset, x1 - inset, y0 + inset, y1 - inset), z0, z1, mat, color, emis, bias, skip)

def cyl(c, r, half, axis, mat, color, cap_color=None, cap_mat=None, n=16, bias=0.0, hub=None):
    """cylinder centred c, radius r, half length along axis ('x','y','z'). hub=(r_frac,color,mat) inner disc on caps."""
    c = np.array(c, float); polys = []
    ai = "xyz".index(axis); o1, o2 = [i for i in range(3) if i != ai]
    ring = []
    for i in range(n):
        a = 2 * math.pi * (i + 0.5) / n; p = np.zeros(3); p[o1] = math.cos(a) * r; p[o2] = math.sin(a) * r; ring.append(p)
    ax = np.zeros(3); ax[ai] = half
    for i in range(n):
        p0, p1 = ring[i], ring[(i + 1) % n]
        polys.append((np.array([c + p0 - ax, c + p1 - ax, c + p1 + ax, c + p0 + ax]), None, mat, color, None))
    for s in (-1, 1):
        cap = [c + p + s * ax for p in ring]
        if s < 0: cap = cap[::-1]
        polys.append((np.array(cap if s > 0 else cap), None, cap_mat if cap_mat is not None else mat, cap_color or color, None))
        if hub:
            hr, hc, hm = hub; capi = [c + p * hr + s * ax * 1.04 for p in ring]
            if s < 0: capi = capi[::-1]
            polys.append((np.array(capi), None, hm, hc, "hub"))
    # fix cap winding so normal points outward
    fixed = []
    for v, nrm, m, col, e in polys:
        nn = _quad_n(v); cen = v.mean(0)
        if np.dot(nn, cen - c) < 0: v = v[::-1]
        fixed.append((v, None, m, col, None if e == "hub" else e))
    return Prim(fixed, bias=bias)

def rods(segs, radius_px, mat, color, bias=0.0):
    return Prim(rods=[(np.array(a, float), np.array(b, float), radius_px, mat, color) for a, b in segs], bias=bias)

def wheel(x, y, r, w, tyre="#3b3440", rim="#d8d4cc", n=18, bias=0.0, flat=0.0):
    """y-axis wheel; flat squashes bottom (rusty)."""
    cz = r * (1 - flat * 0.35)
    p = cyl((x, y, cz), r, w / 2, "y", M_TYRE, hexc(tyre), n=n, bias=bias, hub=(0.55, hexc(rim), M_METAL))
    if flat:
        for v, *_ in p.polys: v[:, 2] = np.maximum(v[:, 2], 0.0)
    p.name = "wheel"; p.center = np.array([x, y, r], float)  # kept round under anisotropic fit scaling
    return p

def bike_wheel(x, y, r, tyre_px, color="#3b3440", rim="#c9c2b8", spokes=8, n=20, z=None):
    cz = r if z is None else z
    pts = [np.array([x + math.cos(2 * math.pi * i / n) * r, y, cz + math.sin(2 * math.pi * i / n) * r]) for i in range(n)]
    segs = [(pts[i], pts[(i + 1) % n]) for i in range(n)]
    sp = [((x, y, cz), (x + math.cos(2 * math.pi * i / spokes) * r * 0.9, y, cz + math.sin(2 * math.pi * i / spokes) * r * 0.9)) for i in range(spokes)]
    out = [Prim(rods=[(a, b, tyre_px, M_TYRE, hexc(color)) for a, b in segs]), rods(sp, 0.45, M_METAL, hexc(rim))]
    for p_ in out: p_.name = "bike_wheel"; p_.center = np.array([x, y, cz], float)  # kept round on screen under the fit
    return out

# ---------------------------------------------------------------- projection
def heading(d):
    th = math.radians(45 * d); return (math.cos(th), math.sin(th))

def to_world(p, d, xf=None):
    if xf is not None: p = xf(p)
    f0, f1 = heading(d); x, y, z = p[..., 0], p[..., 1], p[..., 2]
    u = x * f0 - y * f1; v = x * f1 + y * f0
    return np.stack([u, v, z], -1)

def to_screen(w):  # 1x px relative to pivot
    return np.stack([w[..., 0] * U, w[..., 1] * U * 0.5 - w[..., 2] * ZK], -1)

def depth(w): return w[..., 1] * VIEW[1] + w[..., 2] * VIEW[2] + w[..., 0] * 0.0001

def shade(color, n, mat):
    lam = float(np.dot(n, LIGHT)); up = n[2]
    if mat == M_GLASS:
        base = color; t = 0.85 + 0.25 * max(0, lam)
        return clamp8(tuple(c * t for c in base))
    if lam > 0.55: k, hue = 1.06, (255, 244, 220)
    elif lam > 0.12: k, hue = 0.88, None
    else: k, hue = 0.68, (86, 64, 120)
    c = tuple(v * k for v in color)
    if hue is not None and k < 1: c = lerp(c, hue, 0.18)
    elif hue is not None: c = lerp(c, hue, 0.12)
    if up > 0.7: c = lerp(c, (255, 250, 236), 0.08)
    return clamp8(c)

def render(prims, d, xf=None, canvas=None, pivot=None):
    """Render prims for direction d. Returns dict of SS layers + bbox. canvas=(W,H) at 1x, pivot=(px,py) at 1x."""
    items = []
    for pr in prims:
        allv = [to_world(v, d, xf) for v, *_ in pr.polys] + [to_world(np.stack([a, b]), d, xf) for a, b, *_ in pr.rods]
        if not allv: continue
        cen = np.concatenate(allv).mean(0); pd = depth(cen) + pr.bias
        for (v, nrm, m, col, e), wv in zip(pr.polys, allv[:len(pr.polys)]):
            n = _quad_n(wv)
            if np.dot(n, VIEW) <= 0.002: continue
            items.append((pd, depth(wv.mean(0)), "poly", wv, n, m, col, e))
        for (a, b, rp, m, col), wv in zip(pr.rods, allv[len(pr.polys):]):
            items.append((pd, depth(wv.mean(0)), "rod", wv, None, m, col, rp))
    items.sort(key=lambda t: (t[0], t[1]))
    if canvas is None:  # measure only
        pts = []
        for it in items:
            s = to_screen(it[3]); pad = (it[7] if it[2] == "rod" else 0) + 0.5; pts += [s.min(0) - pad, s.max(0) + pad]
        pts = np.array(pts); return pts.min(0), pts.max(0)
    W, H = canvas; px, py = pivot
    col = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0)); mat = Image.new("L", (W * SS, H * SS), 0)
    emi = Image.new("RGB", (W * SS, H * SS), (0, 0, 0))
    dc, dm, de = ImageDraw.Draw(col), ImageDraw.Draw(mat), ImageDraw.Draw(emi)
    T = lambda s: [((x + px) * SS, (y + py) * SS) for x, y in s]
    for it in items:
        _, _, kind, wv, n, m, c, e = it
        s = to_screen(wv)
        if kind == "poly":
            pts = T(s); fc = shade(c, n, m)
            if m == M_LAMP and e is not None: fc = clamp8(lerp(c, (255, 255, 255), 0.15))
            dc.polygon(pts, fill=fc + (255,)); dm.polygon(pts, fill=m)
            de.polygon(pts, fill=(tuple(e) if (m == M_LAMP and e is not None) else (0, 0, 0)))
            line = lerp(fc, INK, 0.55) if m != M_GLASS else lerp(fc, INK, 0.35)
            dc.line(pts + [pts[0]], fill=line + (255,), width=SS, joint="curve")  # 1 px part line at 1x (cel)
            if m == M_GLASS and len(pts) == 4 and n[2] < 0.8:  # glass glint streak
                a, b, cc, dd = [np.array(p) for p in pts]
                g0 = a + (b - a) * 0.25; g1 = dd + (cc - dd) * 0.45
                dc.line([tuple(g0 * 0.8 + g1 * 0.2), tuple(g0 * 0.25 + g1 * 0.75)], fill=(240, 252, 255, 200), width=int(SS * 1.1))
        else:
            rp = e; (x0, y0), (x1, y1) = T(s); w = max(1, int(rp * 2 * SS))
            fc = shade(c, np.array([0, 0, 1.0]) * 0.6 + np.array([-.3, -.2, .3]), m)
            dc.line([(x0, y0), (x1, y1)], fill=lerp(fc, INK, 0.5) + (255,), width=w + int(SS * 1.2))
            for (xx, yy) in ((x0, y0), (x1, y1)):
                r2 = (w + SS * 1.2) / 2; dc.ellipse([xx - r2, yy - r2, xx + r2, yy + r2], fill=lerp(fc, INK, 0.5) + (255,))
            dc.line([(x0, y0), (x1, y1)], fill=fc + (255,), width=w); dm.line([(x0, y0), (x1, y1)], fill=m, width=w)
            for (xx, yy) in ((x0, y0), (x1, y1)):
                r2 = w / 2; dc.ellipse([xx - r2, yy - r2, xx + r2, yy + r2], fill=fc + (255,))
    return {"col": col, "mat": mat, "emi": emi}

def project_point(p, d, xf=None):
    w = to_world(np.array(p, float), d, xf); s = to_screen(w)
    return float(s[0]), float(s[1]), float(depth(w))

def facing_visible(n_local, d, xf=None):
    o = to_world(np.zeros(3), d, xf); w = to_world(np.array(n_local, float), d, xf) - o
    return bool(np.dot(w, VIEW) > 0.02)

# ---------------------------------------------------------------- post (2D, at SS)
def _noise(w, h, cell, seed):
    g = np.random.default_rng(seed).random((h // cell + 3, w // cell + 3))
    im = Image.fromarray((g * 255).astype(np.uint8)).resize((g.shape[1] * cell, g.shape[0] * cell), Image.BICUBIC)
    return np.asarray(im, np.float32)[:h, :w] / 255.0

def finish(L, shadow_poly=None, effects=None, seed=0, pivot=None, grass=False):
    """L: render layers. Solid cel (no grain): damage effects, optional grass. Returns (body RGBA at SS, contact shadow L at SS
    or None, tint, emi). Alpha is binarised and the bold outline added per output scale in cel() below."""
    col = np.asarray(L["col"], np.float32).copy(); mat = np.asarray(L["mat"]).copy(); emi = np.asarray(L["emi"], np.float32).copy()
    tint = (mat == M_PAINT).astype(np.float32)
    if effects: col, tint, emi = effects(col, mat, tint, emi, seed)
    col = np.clip(col, 0, 255)
    img = Image.fromarray(col.astype(np.uint8), "RGBA")
    sh = None
    if shadow_poly is not None:
        sh = Image.new("L", img.size, 0); ImageDraw.Draw(sh).polygon(shadow_poly, fill=95)
        sh = sh.filter(ImageFilter.GaussianBlur(SS * 2.2))
    if grass and pivot is not None: img = add_grass(img, shadow_poly, seed)
    return img, sh, tint, emi

OUTLINE_K = 0.62  # outline = neighbour colour pulled 62% toward INK (bold, slightly dark, not black)
SHADOW_RGB = (40, 26, 50)

def cel(body, sh, f, ring=1):
    """Downsample an SS body by f (premultiplied box filter), binarise alpha (>= 50% coverage), add a `ring`-px bold outline
    of the darkened neighbour colour, and put the soft contact shadow (the one allowed soft effect) underneath."""
    w, h = body.size[0] // f, body.size[1] // f
    b = np.asarray(body.resize((w, h), Image.BOX)).astype(np.float32)
    solid = b[..., 3] >= 128
    rgb = b[..., :3] * solid[..., None]
    # mean colour of the solid neighbours of each ring pixel (frames carry >= 2 px empty gutters, so np.roll never wraps art)
    acc = np.zeros_like(rgb); cnt = np.zeros(solid.shape, np.float32)
    for dy in range(-ring, ring + 1):
        for dx in range(-ring, ring + 1):
            r2 = np.roll(np.roll(rgb, dy, 0), dx, 1); s2 = np.roll(np.roll(solid, dy, 0), dx, 1)
            acc += r2 * s2[..., None]; cnt += s2
    edge = (~solid) & (cnt > 0)
    ink = np.array(INK, np.float32)
    nb = acc / np.maximum(cnt, 1)[..., None]
    out = np.zeros((h, w, 4), np.float32)
    if sh is not None:
        s = np.asarray(sh.resize((w, h), Image.BOX), np.float32)
        s = np.round(s / 16.0) * 16.0  # a few flat steps, not a 95-level gradient (smaller palette, still soft)
        out[..., :3] = SHADOW_RGB; out[..., 3] = s
    out[edge, :3] = nb[edge] * (1 - OUTLINE_K) + ink * OUTLINE_K; out[edge, 3] = 255
    out[solid, :3] = b[solid, :3]; out[solid, 3] = 255
    out[out[..., 3] == 0] = 0
    return np.clip(out + 0.5, 0, 255).astype(np.uint8), solid | edge

def add_grass(img, poly, seed):
    rng = np.random.default_rng(seed + 77); d = ImageDraw.Draw(img)
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    for i in range(16):
        k = rng.integers(len(poly)); j = (k + 1) % len(poly); t = rng.random()
        x = poly[k][0] + (poly[j][0] - poly[k][0]) * t + rng.normal(0, SS * 2); y = poly[k][1] + (poly[j][1] - poly[k][1]) * t + rng.normal(0, SS)
        g = lerp((92, 168, 72), (150, 196, 80), rng.random())
        for b in range(4):
            ang = -math.pi / 2 + rng.normal(0, 0.45); ln = SS * (3 + rng.random() * 4)
            x1, y1 = x + math.cos(ang) * ln, y + math.sin(ang) * ln
            d.line([(x, y), (x1, y1)], fill=lerp(g, INK, 0.45) + (255,), width=int(SS * 1.5))
            d.line([(x, y), (x1, y1)], fill=g + (255,), width=int(SS * 0.8))
    return img

def downs(img, f, mode=Image.LANCZOS):
    return img.resize((img.size[0] // f, img.size[1] // f), mode)

def save_indexed(arr, path):
    """Byte-lean RGBA page: indexed PNG with tRNS. Opaque art (alpha 255) gets <= 256 - k palette entries (exact when it has
    that few colours, else median cut, no dither), the k soft contact-shadow alpha steps one entry each, index 0 = clear."""
    arr = np.asarray(arr); a = arr[..., 3]; op = a == 255; semi = (a > 0) & (a < 255)
    levels = sorted(set(np.unique(a[semi]).tolist())); n_op = 255 - len(levels)
    idx = np.zeros(a.shape, np.uint8); pal = [(0, 0, 0)]; trns = [0]
    for lv in levels:
        idx[semi & (a == lv)] = len(pal); pal.append(SHADOW_RGB); trns.append(lv)
    rgb = arr[..., :3][op]
    if len(rgb):
        key = (rgb[:, 0].astype(np.uint32) << 16) | (rgb[:, 1].astype(np.uint32) << 8) | rgb[:, 2]
        uq, inv = np.unique(key, return_inverse=True)
        if len(uq) <= n_op:
            cols = np.stack([(uq >> 16) & 255, (uq >> 8) & 255, uq & 255], -1).astype(np.uint8); sub = inv
        else:
            q = Image.fromarray(rgb.reshape(1, -1, 3)).quantize(n_op, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            cols = np.array(q.getpalette()[:3 * n_op], np.uint8).reshape(-1, 3); sub = np.asarray(q).reshape(-1)
        base = len(pal); idx[op] = (sub + base).astype(np.uint8)
        pal += [tuple(c) for c in cols.tolist()]; trns += [255] * len(cols)
    im = Image.fromarray(idx, "P"); flat = [v for c in pal for v in c]; im.putpalette(flat + [0] * (768 - len(flat)))
    im.save(path, optimize=True, transparency=bytes(trns))
