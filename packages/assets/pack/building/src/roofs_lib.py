"""Seamless neighbour-aware roof art (docs/ART_KEYS_ROOFS.md). Every piece is cut from one continuous roof
heightfield (distance-to-eave -> per-form profile), rendered by a 1x ray cast in world space, so neighbouring
pieces share edge pixels and course lines exactly. Solid cel: flat ramp fills, one hard shade, a hard highlight,
binary alpha, outline only on true silhouettes (eaves, verges, gable walls), none on internal seams."""
import math, sys, os
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../../../assets/tools'))
from palette import ramp, hex2rgb, RAMPS

CW, CH, PX, PY = 96, 80, 48, 44          # cell, pivot (diamond centre at the piece base). Eaves pass: was 72x68 (36,44)
OV = 0.04                                  # legacy eave lip (tiles), only bounds() (kept for reference)
# eaves pass: the roof surface runs past the tile diamond on every outer edge. 1 tile of outward shift = 32 px of
# screen drop at 1x, so OV_E = 6 px, OV_C = 8 px at outer corners (flared over the half edge next to the corner).
OV_E, OV_C = 6 / 32, 8 / 32
FASCIA_PX = 4                              # board under the camera-facing (S/E) eaves: highlight, board, shade, ink
FLT_FACE_PX = 11                           # flat roofs: parapet face 8 px + 3 px drop over the wall top
WALL_DROP = 3                              # gable / shed end strips and band-0 gable triangles reach 3 px below the seat
def set_frame(cw, ch, px, py):
    global CW, CH, PX, PY
    CW, CH, PX, PY = cw, ch, px, py
S_, W_, N_, E_ = 0, 1, 2, 3                # ADR-311 dir order
KMAX = 3
INK = np.array(hex2rgb(RAMPS["ink"][2]), np.float32)

RISES = {"hip": [14] * 12, "gab": [14] * 12, "cot": [10] + [16] * 11, "gam": [22] + [8] * 11, "shd": [9] * 16, "flt": [0] * 4}
FASCIA = {"hip": 3, "gab": 3, "cot": 3, "gam": 3, "shd": 3, "flt": 8}

def profile(form, d):
    """cumulative roof height (px) at continuous eave distance d (tiles)."""
    r = RISES[form]; d = np.asarray(d, np.float64)
    out = np.where(d < 0, d * (3.0 if form == "cot" else r[0]), 0.0)
    base = 0.0
    for k in range(len(r)):
        f = np.clip(d - k, 0, 1)
        g = f ** 1.6 if (form == "cot" and k == 0) else f
        out = out + np.where(d >= 0, r[k] * g, 0)
    return out
def zoff(form, k): return int(sum(RISES[form][:k]))

SHAPES = {"e": [S_], "o": [S_, E_], "r": [S_, N_], "h": [S_, E_, W_], "p": [S_, W_, N_, E_], "i": [S_, E_], "f": []}
def rot_sides(sides, r): return [(s + r) % 4 for s in sides]

def term(side, x, y):
    return {S_: 0.5 - y, N_: 0.5 + y, E_: 0.5 - x, W_: 0.5 + x}[side]

class Piece:
    """form, seg (lo/up/top/lotop), shape, row; k = band used for course phase."""
    def __init__(self, form, seg, shape, row, variant=0, crest=False):
        self.form, self.seg, self.shape, self.row, self.variant, self.crest = form, seg, shape, row, variant, crest
        self.sides = rot_sides(SHAPES[shape], row)
        self.k = 0 if seg in ("lo", "lotop") else 1
        if form == "shd": self.sides = [row % 4]
        bnd = set()
        if seg in ("lo", "lotop") and shape != "i": bnd |= set(self.sides)
        if seg in ("top", "lotop"): bnd.add((row + 2) % 4)
        if shape == "f" and form == "flt": bnd = set()
        self.bnd = bnd
        self.uphill = (row + 2) % 4 if (shape == "e") else None

    def dl(self, x, y):
        """local eave distance field + facet side index (-1 = flat)."""
        if self.shape == "f" or not self.sides:
            return np.zeros_like(x), np.full(x.shape, -1)
        T = np.stack([term(s, x, y) for s in self.sides])
        if self.shape == "i":
            idx = T.argmax(0); v = T.max(0)
        else:
            idx = T.argmin(0); v = T.min(0)
        return v, np.array(self.sides)[idx]

    def H(self, x, y):
        v, fac = self.dl(x, y)
        if self.form == "flt": return np.full_like(x, 4.0), v, fac
        return profile(self.form, self.k + v) - profile(self.form, self.k), v, fac

def raycast(piece, ext=0.85, zmax=44.0, zmin=-10.0, step=0.25):
    """Extended-surface ray cast over the whole cell: world hit (x, y, z), H, local d, facet."""
    py, px = np.mgrid[0:CH, 0:CW].astype(np.float64)
    sx = px + 0.5 - PX; sy = py + 0.5 - PY
    hit = np.zeros(sx.shape, bool); X = np.zeros_like(sx); Y = np.zeros_like(sx); Z = np.zeros_like(sx)
    z = zmax
    while z >= zmin:
        s = (sy + z) / 16.0; x = (s + sx / 32.0) / 2; y = (s - sx / 32.0) / 2
        xc, yc = np.clip(x, -ext, ext), np.clip(y, -ext, ext)
        h, _, _ = piece.H(xc, yc)
        new = ~hit & (z <= h) & (np.abs(x) <= ext) & (np.abs(y) <= ext)
        X = np.where(new, x, X); Y = np.where(new, y, Y); Z = np.where(new, z, Z); hit |= new
        z -= step
    h, v, fac = piece.H(X, Y)
    return hit, X, Y, Z, v, fac

ENDS = {S_: ((E_, "x"), (W_, "x")), N_: ((E_, "x"), (W_, "x")), E_: ((S_, "y"), (N_, "y")), W_: ((S_, "y"), (N_, "y"))}
def ext_of(bnd, s, X, Y):
    """outward reach (tiles) of outer side s at each point: OV_E, flaring to OV_C over the half edge next to a corner
    whose other side is outer too."""
    a = X if s in (S_, N_) else Y
    r = np.zeros_like(X)
    (pe, _), (me, _) = ENDS[s]
    if pe in bnd: r = np.maximum(r, np.clip(a / 0.5, 0, 1))
    if me in bnd: r = np.maximum(r, np.clip(-a / 0.5, 0, 1))
    return OV_E + (OV_C - OV_E) * r
def region(bnd, X, Y, margin=0.0, reach=None, inner=0.0):
    """world footprint of a piece: the tile diamond, pushed out by ext_of on outer sides (margin grows it). reach: extra
    plain reach on some non-outer sides; inner: how far past the other (member) sides to accept (neighbour fill)."""
    m = np.ones(X.shape, bool)
    for s in range(4):
        lim = -ext_of(bnd, s, X, Y) if s in bnd else -(reach or {}).get(s, inner)
        m &= term(s, X, Y) >= lim - margin - 1e-6
    return m
def outer_edge(bnd, X, Y, sides=None, tol=0.08):
    """surface points on the outermost band of an outer side's overhang (eave / rake line); -> mask, side index."""
    best = np.full(X.shape, np.inf); side = np.full(X.shape, -1)
    for s in (bnd if sides is None else [q for q in bnd if q in sides]):
        d = term(s, X, Y) + ext_of(bnd, s, X, Y)
        upd = (d < tol) & (d < best); best = np.where(upd, d, best); side = np.where(upd, s, side)
    return side >= 0, side

def bounds(piece, ov=OV):
    o = {s: (ov if (s in piece.bnd and piece.form != "flt") else 0.0) for s in range(4)}
    return -0.5 - o[W_], 0.5 + o[E_], -0.5 - o[N_], 0.5 + o[S_]

# ------------------------------------------------------------------ colour
def C(rp): return [np.array(c, np.float32) for c in ramp(rp)]
WARM = np.array((255, 248, 225), np.float32)
def outline_of(rp): c = C(rp); return c[3] * 0.45 + INK * 0.55
def tones(rp, fac):
    """per world facet: plane, line, highlight, deep colours."""
    c = C(rp)
    if fac == W_: return c[0], c[1], c[0] * 0.55 + WARM * 0.45, c[2]
    if fac == E_: return c[2], c[3], c[1], c[3] * 0.6 + INK * 0.4
    return c[1], c[2], c[0], c[3]

def ihash(a, b, seed):
    a = np.asarray(a, np.int64); b = np.asarray(b, np.int64)
    h = (a * 73856093) ^ (b * 19349663) ^ (seed * 83492791 + 12345)
    h = (h ^ (h >> 13)) * 1274126177
    return (h ^ (h >> 16)) & 0xFFFF

def up(a): o = np.empty_like(a); o[1:] = a[:-1]; o[0] = a[0]; return o
def left(a): o = np.empty_like(a); o[:, 1:] = a[:, :-1]; o[:, 0] = a[:, 0]; return o
def right(a): o = np.empty_like(a); o[:, :-1] = a[:, 1:]; o[:, -1] = a[:, -1]; return o

def along(X, Y, fac):
    return np.where((fac == S_) | (fac == N_), X, Y)

def pattern(style, P, X, Y, v, fac, seed):
    """codes: 0 plane, 1 line, 2 highlight, 3 deep."""
    N, M = P.get("N", 4), P.get("M", 5)
    flat = fac < 0
    far = (fac == N_) | (fac == W_)          # back slopes are foreshortened: half the courses, still even
    Nf = max(2, (N // 2) // 2 * 2) if style not in ("thatch", "seam") else max(1, N // 2)
    a = along(X, Y, fac); dd = np.where(flat, (Y + 0.5) * N, v * np.where(far, Nf, N))
    code = np.zeros(X.shape, np.int8)
    def lab_lines(row, col, hl=True, colline=True):
        ln = (row != up(row))
        if colline: ln |= (col != left(col)) & (row == left(row))
        h2 = (~ln) & (row == up(row)) & (row != up(up(row))) if hl else np.zeros_like(ln)
        return ln, h2
    if style in ("shingle", "slate", "flag"):
        row = np.floor(dd).astype(np.int64)
        col = np.floor((a + 0.5) * M + 0.5 * (row % 2)).astype(np.int64)
        ln, h2 = lab_lines(row, col)
        code[h2] = 2; code[ln] = 1
        if style == "slate":
            alt = ihash(row % N, col % (2 * M), seed) % 5 == 0
            code[alt & ~ln & ~h2] = 1
        if style == "shingle":   # weathered butt notches
            fr = dd - np.floor(dd); colf = (a + 0.5) * M + 0.5 * (row % 2); u = colf - np.floor(colf)
            notch = (ihash(row % N, col % (2 * M), seed + 3) % 4 == 0) & (fr < 0.28) & (np.abs(u - 0.5) < 0.12)
            code[notch & ~ln] = 1
    elif style == "thatch":
        base = np.floor(dd)
        row = np.floor(dd + 0.16 * np.sin(2 * np.pi * (a * 5) + 1.7 * base)).astype(np.int64)
        fr = dd - np.floor(dd); c16 = np.floor((a + 0.5) * 18).astype(np.int64)
        ln, h2 = lab_lines(row, row, colline=False)
        tick = (ihash(row % N, c16 % 36, seed) % 3 == 0) & (fr > 0.3) & (fr < 0.8) & (c16 != left(c16))
        code[h2] = 2; code[tick] = 1; code[ln] = 3
    elif style == "scallop":
        row0 = np.floor(dd); fr = dd - row0
        colf = (a + 0.5) * M + 0.5 * (row0 % 2); u = colf - np.floor(colf)
        arc = 0.42 * (1 - np.sqrt(np.clip(1 - (2 * u - 1) ** 2, 0, 1)))
        row = (row0 - (fr < arc)).astype(np.int64)
        col = np.floor((a + 0.5) * M + 0.5 * (row % 2)).astype(np.int64)
        ln, h2 = lab_lines(row, col, colline=False)
        code[h2] = 2; code[ln] = 1
    elif style == "tin":
        rib = (a + 0.5) * M; u = rib - np.floor(rib)
        code[u < 0.22] = 2; code[(u >= 0.55) & (u < 0.8)] = 1
        row = np.floor(dd).astype(np.int64); fr = dd - row
        ln = row != up(row); code[ln] = 3
        riv = (fr > 0.82) & (fr < 0.93) & (u < 0.2) & (np.floor(rib).astype(np.int64) % 2 == 0)
        code[riv] = 3
    elif style == "seam":   # standing-seam copper
        rib = (a + 0.5) * M; u = rib - np.floor(rib)
        code[u < 0.12] = 2; code[(u >= 0.12) & (u < 0.24)] = 1
        row = np.floor(dd).astype(np.int64); code[row != up(row)] = 1
    elif style == "plate":
        row = np.floor(dd).astype(np.int64); colf = (a + 0.5) * M + 0.5 * (row % 2); col = np.floor(colf).astype(np.int64)
        ln, h2 = lab_lines(row, col)
        fr = dd - row; u = colf - col
        riv = ((fr > 0.12) & (fr < 0.24) | (fr > 0.76) & (fr < 0.88)) & ((u > 0.06) & (u < 0.14) | (u > 0.86) & (u < 0.94))
        code[h2] = 2; code[ln] = 1; code[riv] = 3
    elif style in ("boards", "bark"):
        wob = 0.1 * np.sin(dd * 5.1 + 1.3) if style == "bark" else 0.0
        col = np.floor((a + 0.5) * M + wob).astype(np.int64)
        ln = (col != left(col)); hl = (~ln) & (left(col) == col) & (left(left(col)) != col)
        code[hl] = 2; code[ln] = 1
        row = np.floor(dd).astype(np.int64)
        if style == "boards":   # batten strips and nail rows
            fr = dd - row; uu = (a + 0.5) * M - col
            code[(fr > 0.46) & (fr < 0.56) & (np.abs(uu - 0.5) < 0.08)] = 3
        else:
            g = (ihash(col % (2 * M), np.floor(dd * 3).astype(np.int64) % (3 * N), seed) % 6 == 0)
            uu = (a + 0.5) * M + wob - col
            code[g & (np.abs(uu - 0.5) < 0.1)] = 1
    elif style == "shake":   # split-log shakes: ragged widths, thick dark butts, staggered drops, split grain
        row = np.floor(dd).astype(np.int64); fr = dd - row
        colf = (a + 0.5) * M + 0.5 * (row % 2) + 0.23 * (ihash(row % (2 * N), 7, seed) % 3)
        col = np.floor(colf).astype(np.int64); u = colf - col
        hs = ihash(row % (4 * N), col % (4 * M), seed + 11)
        split = 0.3 + 0.4 * ((hs >> 3) % 5) / 4.0                 # most shakes are split in two, at a random point
        half = (u >= split) & (hs % 3 != 0)
        sid = col * 2 + half                                       # shake id within the course
        hb = ihash(row % (4 * N), sid % (8 * M), seed + 5)
        butt = 0.16 + 0.12 * (hb % 4) / 3.0                        # thick butt end, length varies per shake
        drop = (hb >> 4) % 4 == 0                                  # an odd shake hangs a little lower
        deep = (fr < butt) | (drop & (fr > 0.9))
        ln = (row != up(row)) | ((sid != left(sid)) & (row == left(row)))
        grain = ((ihash(row % (4 * N), np.floor(colf * 4).astype(np.int64) % (16 * M), seed + 9) % 5 == 0)
                 & (fr > butt + 0.12) & (fr < 0.86) & (np.floor(colf * 4) != np.floor(left(colf) * 4)))
        hl = (~ln) & (~deep) & (fr >= butt) & (fr < butt + 0.1)
        code[hl] = 2; code[grain] = 1; code[deep] = 3; code[ln] = 1
    elif style == "diamond":
        u = (a + 0.5) * M
        i1 = np.floor(u + dd).astype(np.int64); i2 = np.floor(u - dd).astype(np.int64)
        ln = (i1 != up(i1)) | (i2 != up(i2)) | (i1 != left(i1)) | (i2 != left(i2))
        code[ln] = 1
        h2 = (~ln) & ((i1 != up(up(i1))) | (i2 != up(up(i2)))) & ~((i1 != up(i1)) | (i2 != up(i2)))
        code[h2 & (ihash(i1 % (2 * M), i2 % (2 * M), seed) % 2 == 0)] = 2
    return code

def flat_pattern(style, P, X, Y, seed):
    code = np.zeros(X.shape, np.int8)
    n = P.get("FN", 6)
    if style == "reed":     # basket weave
        i = np.floor((X + 0.5) * 4).astype(np.int64); j = np.floor((Y + 0.5) * 4).astype(np.int64)
        odd = (i + j) % 2 == 1
        sx = np.floor((X + 0.5) * 12).astype(np.int64); sy = np.floor((Y + 0.5) * 12).astype(np.int64)
        lab = np.where(odd, sx, sy) + 1000 * (i * 7 + j)
        ln = (lab != up(lab)) | (lab != left(lab)); code[ln] = 1
        code[(~ln) & (ihash(sx % 12, sy % 12, seed) % 7 == 0)] = 2
    elif style == "deck":
        col = np.floor((Y + 0.5) * n).astype(np.int64)
        seg = np.floor((X + 0.5) * 2 + 0.5 * (col % 2)).astype(np.int64)
        ln = (col != up(col)) | ((seg != left(seg)) & (col == left(col)))
        code[ln] = 1; code[(~ln) & (col == up(col)) & (col != up(up(col)))] = 2
        code[(np.abs(((X + 0.5) * 2 + 0.5 * (col % 2)) % 1 - 0.1) < 0.03) & ~ln] = 3
    elif style == "flags":
        row = np.floor((Y + 0.5) * 3).astype(np.int64)
        col = np.floor((X + 0.5) * 2 + 0.5 * (row % 2) + 0.18 * ((ihash(row % 3, 0, seed) % 3) - 1)).astype(np.int64)
        ln = (row != up(row)) | (col != left(col)) | (row != left(row)); code[ln] = 1
        code[(~ln) & (row == up(row)) & (row != up(up(row)))] = 2
    elif style == "dplate":
        u = (X + 0.5) * 8; w = (Y + 0.5) * 8
        fu = u - np.floor(u); fw = w - np.floor(w)
        d1 = (np.abs(fu - fw) < 0.12) & ((np.floor(u) + np.floor(w)) % 2 == 0)
        d2 = (np.abs(fu + fw - 1) < 0.12) & ((np.floor(u) + np.floor(w)) % 2 == 1)
        code[d1 | d2] = 2
        e = (np.abs(X) > 0.47) | (np.abs(Y) > 0.47); code[e] = 1
    elif style == "fplate":
        row = np.floor((Y + 0.5) * 2).astype(np.int64); col = np.floor((X + 0.5) * 2).astype(np.int64)
        ln = (row != up(row)) | (col != left(col)); code[ln] = 1
        code[(~ln) & ((row == up(row)) & (row != up(up(row))) | (col == left(col)) & (col != left(left(col))))] = 2
        fr = (Y + 0.5) * 2 % 1; u = (X + 0.5) * 2 % 1
        code[((fr > 0.1) & (fr < 0.2) | (fr > 0.8) & (fr < 0.9)) & ((u > 0.1) & (u < 0.2) | (u > 0.8) & (u < 0.9))] = 3
    return code

# ------------------------------------------------------------------ materials: (form, tier) -> unique look
# style, roof ramp, trim ramp (fascia / caps / bargeboards), gable-wall ramp + wall style, counts N (courses / tile) M (columns)
MAT = {
 ("hip", 0): dict(style="thatch", rp="thatch", trim="bark", wall="bark", wstyle="logs", N=4, M=5, moss="grass_deep"),
 ("hip", 1): dict(style="shingle", rp="wood", trim="wood_dark", wall="wood", wstyle="boards", N=4, M=5, moss="grass_deep"),
 ("hip", 2): dict(style="slate", rp="slate", trim="stone", wall="cobble", wstyle="stones", N=6, M=6, moss="grass"),
 ("hip", 3): dict(style="tin", rp="metal_teal", trim="iron", wall="iron", wstyle="panels", N=2, M=8, moss="copper"),
 ("hip", 4): dict(style="plate", rp="iron", trim="slate", wall="iron", wstyle="plates", N=2, M=2, moss="copper"),
 ("gab", 1): dict(style="shingle", rp="wood", trim="wood_dark", wall="wood", wstyle="boards", N=4, M=6, moss="grass_deep"),
 ("gab", 2): dict(style="slate", rp="slate", trim="wood_dark", wall="cobble", wstyle="stones", N=4, M=5, moss="grass"),
 ("gab", 3): dict(style="tin", rp="metal_teal", trim="metal_teal", wall="iron", wstyle="panels", N=2, M=6, moss="copper"),
 ("gab", 4): dict(style="plate", rp="iron", trim="brick", wall="iron", wstyle="plates", N=2, M=3, moss="copper"),
 ("cot", 1): dict(style="scallop", rp="clay", trim="wood_dark", wall="cloth_cream", wstyle="boards", N=4, M=5, moss="leaf"),
 ("cot", 2): dict(style="scallop", rp="slate", trim="stone", wall="cobble", wstyle="stones", N=6, M=6, moss="leaf"),
 ("cot", 3): dict(style="seam", rp="patina", trim="copper", wall="iron", wstyle="panels", N=2, M=5, moss="copper"),
 ("cot", 4): dict(style="scallop", rp="iron", trim="slate", wall="iron", wstyle="plates", N=4, M=4, moss="copper"),
 ("gam", 1): dict(style="boards", rp="brick", trim="cloth_cream", wall="brick", wstyle="boards", N=2, M=5, moss="grass_deep"),
 ("gam", 2): dict(style="diamond", rp="slate", trim="stone", wall="cobble", wstyle="stones", N=2, M=3, moss="grass"),
 ("gam", 3): dict(style="tin", rp="clay", trim="cloth_cream", wall="clay", wstyle="panels", N=2, M=7, moss="copper"),
 ("gam", 4): dict(style="plate", rp="slate", trim="iron", wall="iron", wstyle="plates", N=2, M=2, moss="copper"),
 ("shd", 0): dict(style="bark", rp="bark", trim="wood_dark", wall="bark", wstyle="logs", N=2, M=4, moss="grass_deep"),
 ("shd", 1): dict(style="boards", rp="wood_dark", trim="bark", wall="wood", wstyle="boards", N=2, M=4, moss="grass_deep"),
 ("shd", 2): dict(style="flag", rp="cobble", trim="wood_dark", wall="cobble", wstyle="stones", N=2, M=2, moss="grass"),
 ("shd", 3): dict(style="tin", rp="iron", trim="iron", wall="iron", wstyle="panels", N=2, M=7, moss="copper"),
 ("shd", 4): dict(style="plate", rp="metal_teal", trim="slate", wall="iron", wstyle="plates", N=2, M=2, moss="copper"),
 ("flt", 0): dict(style="reed", rp="thatch", trim="bark", wall="bark", wstyle="logs", moss="grass_deep"),
 ("flt", 1): dict(style="deck", rp="wood", trim="wood_dark", wall="wood", wstyle="boards", FN=6, moss="grass_deep"),
 ("flt", 2): dict(style="flags", rp="stone", trim="cobble", wall="cobble", wstyle="stones", moss="grass"),
 ("flt", 3): dict(style="dplate", rp="iron", trim="metal_teal", wall="iron", wstyle="panels", moss="copper"),
 ("flt", 4): dict(style="fplate", rp="slate", trim="iron", wall="iron", wstyle="plates", moss="copper"),
}
TIERS_OF = {"hip": [0, 1, 2, 3, 4], "gab": [1, 2, 3, 4], "flt": [0, 1, 2, 3, 4], "cot": [1, 2, 3, 4], "gam": [1, 2, 3, 4], "shd": [0, 1, 2, 3, 4]}

MATERIAL_SETS = {}       # extra material skins: name -> {form: [tiers]}
MATS_EXTRA = {}          # (form, tier, name) -> material dict
# ---- `shk` split-log shakes for log-wall cabins (docs/ART_KEYS_ROOFS.md §8). Own ramps, own pattern, log gable ends.
RAMPS["shake_split"] = ["#d6c49c", "#a8916c", "#7a6650", "#4f4038"]   # t0: weathered silver-brown split logs
RAMPS["shake_cedar"] = ["#e8a070", "#c0704a", "#8e4c3a", "#5e3230"]   # t1: hand-split red cedar
MATERIAL_SETS["shk"] = {"hip": [0, 1], "gab": [1], "shd": [0, 1], "cot": [1]}
MATS_EXTRA.update({
 ("hip", 0, "shk"): dict(style="shake", rp="shake_split", trim="bark", wall="bark", wstyle="logs", N=2, M=3, moss="grass_deep"),
 ("shd", 0, "shk"): dict(style="shake", rp="shake_split", trim="wood_dark", wall="wood_dark", wstyle="logs", N=2, M=2, moss="grass"),
 ("hip", 1, "shk"): dict(style="shake", rp="shake_cedar", trim="wood_dark", wall="wood", wstyle="logs", N=4, M=4, moss="grass_deep"),
 ("gab", 1, "shk"): dict(style="shake", rp="shake_cedar", trim="bark", wall="wood", wstyle="logs", N=4, M=3, moss="grass_deep"),
 ("cot", 1, "shk"): dict(style="shake", rp="shake_cedar", trim="wood_dark", wall="wood", wstyle="logs", N=6, M=5, moss="leaf"),
 ("shd", 1, "shk"): dict(style="shake", rp="shake_cedar", trim="bark", wall="wood", wstyle="logs", N=2, M=3, moss="grass_deep"),
})
def mat_for(form, tier, mat=""):
    return MATS_EXTRA[(form, tier, mat)] if mat else MAT[(form, tier)]

def _flt_H(piece):
    def H(x, y):
        if piece.shape == "f" or not piece.sides: return np.full_like(x, 4.0), np.zeros_like(x), np.full(x.shape, -1)
        T = np.stack([term(s, x, y) for s in piece.sides])
        if piece.shape == "i": rim = (T < 0.1).all(0)
        else: rim = (T < 0.1).any(0)
        return np.where(rim, 8.0, 4.0), T.min(0), np.full(x.shape, -1)
    return H

def down(a): o = np.zeros_like(a); o[1:] = a[:-1]; return o          # o[r] = a[r-1]: shift one row down

def render_piece(piece, tier, seed=0, mat="", extra=None, reach=None):
    """one roof piece. extra = an outer end side x (gable / shed rake): render ONLY the overhang the piece gains when x is
    outer too (rake strip past x + the corner flare on its eave sides), for the verge overlay."""
    P = mat_for(piece.form, tier, mat)
    if piece.form == "flt": piece.H = _flt_H(piece)
    hit, X, Y, Z, v, fac = raycast(piece)
    Hh, _, _ = piece.H(X, Y)
    bnd = set(piece.bnd) | ({extra} if extra is not None else set())
    foot = hit & region(bnd, X, Y, reach=reach)
    if extra is not None: foot &= ~region(piece.bnd, X, Y)
    riser = foot & (Hh - Z > 0.9)
    top = foot & ~riser
    img = np.zeros((CH, CW, 4), np.float32)
    # ---- surface pattern
    if piece.form == "flt": code = flat_pattern(P["style"], P, X, Y, seed)
    else: code = pattern(P["style"], P, X, Y, piece.k + v, fac, seed)
    # facet tone (flat -> S tones)
    for f in (-1, S_, W_, N_, E_):
        m = top & (fac == f)
        if not m.any(): continue
        cols = tones(P["rp"], S_ if f < 0 else f)
        for ci in range(4): img[m & (code == ci), :3] = cols[ci]
    # ---- caps / creases
    cap = np.zeros(X.shape, bool); valley = np.zeros(X.shape, bool)
    if piece.form != "flt" and len(piece.sides) >= 2:
        T = np.sort(np.stack([term(s, X, Y) for s in piece.sides]), 0)
        if piece.shape == "i": valley = top & (T[-1] - T[-2] < 0.035)
        else: cap = top & (T[1] - T[0] < 0.06)
    if piece.crest and piece.uphill is not None:
        cap |= top & (term(piece.uphill, X, Y) < 0.05)
    if piece.form == "flt" and piece.shape != "f":
        cap = foot & (Hh > 6)      # parapet rim top + riser
    if cap.any():
        for f in (-1, S_, W_, N_, E_):
            m = cap & (fac == f)
            if m.any(): img[m, :3] = tones(P["trim"], S_ if f < 0 else f)[0]
        seg_l = np.floor((along(X, Y, fac) + 0.5) * 4).astype(np.int64)
        # cap edge line only against roof surface (not against the tile cut)
        ed = cap & ((top & ~cap) == False) & (((~cap) & top)[[0] + list(range(CH - 1))] | left((~cap) & top) | right((~cap) & top))
        img[ed, :3] = C(P["trim"])[3]
        sl = cap & (seg_l != left(seg_l)) & ~ed
        img[sl, :3] = C(P["trim"])[2]
    if valley.any(): img[valley, :3] = tones(P["rp"], S_)[3]
    # ---- risers (flat parapet inner faces, plateau steps)
    if riser.any():
        img[riser, :3] = C(P["trim"])[2]
    # ---- fascia: a board hanging under the camera-facing (S/E) eave / rake line of the overhang
    surf = top | riser
    edge, eside = outer_edge(bnd, X, Y, sides=(S_, E_))
    edge &= surf & ~np.vstack([surf[1:], np.zeros((1, CW), bool)])
    FD = FLT_FACE_PX if piece.form == "flt" else FASCIA_PX
    tc = C(P["trim"]); fasc = np.zeros(X.shape, bool)
    cur, cs = edge, eside
    for i in range(1, FD + 1):
        cur = down(cur) & ~surf; cs = down(cs)
        if not cur.any(): break
        for sd in (S_, E_):
            m = cur & (cs == sd); o = 0 if sd == S_ else 1
            img[m, :3] = tc[o] if i == 1 else (tc[o + 2 if o == 0 else 3] if i == FD - 1 else tc[o + 1])
        fasc |= cur
    alpha = surf | fasc
    # ---- variants (interior only)
    if piece.variant:
        inner = top & ~cap & (np.abs(X) < 0.32) & (np.abs(Y) < 0.32)
        rng = np.random.default_rng(1000 * piece.variant + seed + 17)
        if piece.variant == 1:     # moss / lichen / rust bloom
            cx, cy = rng.uniform(-0.12, 0.12, 2)
            r = np.sqrt(((X - cx) / 0.22) ** 2 + ((Y - cy) / 0.16) ** 2)
            wob = 0.18 * np.sin(np.arctan2(Y - cy, X - cx) * 5 + rng.uniform(0, 6))
            blob = inner & (r < 1 + wob)
            mc = C(P["moss"])
            img[blob, :3] = mc[1]
            edge_ = blob & ~(up(blob) & left(blob) & right(blob))
            img[edge_, :3] = mc[2]
            dots = blob & ~edge_ & (ihash(np.floor(X * 40).astype(np.int64), np.floor(Y * 40).astype(np.int64), seed) % 5 == 0)
            img[dots, :3] = mc[0]
        else:                      # repair patch (a nailed board / new sheet)
            cx, cy = rng.uniform(-0.1, 0.1, 2)
            pm = inner & (np.abs(along(X, Y, fac) - cx) < 0.13) & (np.abs(((v if piece.form != "flt" else Y + 0.5) - 0.5) - cy * 0.5) < 0.09)
            if piece.form == "flt" or piece.shape == "f":
                pm = inner & (np.abs(X - cx) < 0.12) & (np.abs(Y - cy) < 0.09)
            pc = C(P["trim"])
            img[pm, :3] = pc[1]
            pe = pm & ~(up(pm) & left(pm) & right(pm))
            img[pe, :3] = pc[3]
            nail = pm & ~pe & (ihash(np.floor(X * 30).astype(np.int64), np.floor(Y * 30).astype(np.int64), seed + 9) % 9 == 0)
            img[nail, :3] = pc[0]
    # ---- silhouette outline, judged against the whole roof: pixels the member neighbours (or, for a rake strip, the
    # piece under it) cover count as filled, so tile cuts get no ink; the fascia is inked along its bottom only
    virt = hit & ~foot & region(bnd, X, Y, inner=0.6)
    filled = alpha | virt
    below = lambda a: np.vstack([a[1:], np.zeros((1, CW), bool)])
    sil = alpha & ~fasc & ~(up(filled) & left(filled) & right(filled) & below(filled))
    sil |= fasc & ~below(alpha)
    img[sil, :3] = outline_of(P["rp"])
    img[..., 3] = alpha * 255
    img[~alpha] = 0
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")

# ------------------------------------------------------------------ gable verges, wall strips, chimney stacks
def wall_code(wstyle, t, zz, rowh, seed):
    code = np.zeros(t.shape, np.int8)
    if wstyle == "boards":
        col = np.floor((t + 0.5) * 6).astype(np.int64); ln = col != left(col); code[ln] = 1
        code[(~ln) & (left(col) == col) & (left(left(col)) != col)] = 2
    elif wstyle == "logs":
        row = np.floor(zz / rowh).astype(np.int64); ln = row != up(row); code[ln] = 1
        code[(~ln) & (np.abs((zz / rowh) % 1 - 0.7) < 0.12)] = 2
    elif wstyle == "stones":
        row = np.floor(zz / rowh).astype(np.int64)
        col = np.floor((t + 0.5) * 4 + 0.5 * (row % 2)).astype(np.int64)
        ln = (row != up(row)) | (col != left(col)); code[ln] = 1
        code[(~ln) & (row == up(row)) & (row != up(up(row)))] = 2
    elif wstyle == "panels":
        col = np.floor((t + 0.5) * 3).astype(np.int64); ln = col != left(col); code[ln] = 1
        code[(~ln) & (left(col) == col) & (left(left(col)) != col)] = 2
    elif wstyle == "plates":
        col = np.floor((t + 0.5) * 2).astype(np.int64); row = np.floor(zz / (rowh * 2)).astype(np.int64)
        ln = (col != left(col)) | (row != up(row)); code[ln] = 1
        u = (t + 0.5) * 2 % 1
        code[(~ln) & ((u > 0.08) & (u < 0.16) | (u > 0.84) & (u < 0.92)) & (np.abs((zz / rowh) % 2 - 1) < 0.3)] = 3
    return code

def _plane(face, ext0, ext1):
    py, px = np.mgrid[0:CH, 0:CW].astype(np.float64); sx = px + 0.5 - PX; sy = py + 0.5 - PY
    if face == S_:
        t = sx / 32 + 0.5; zz = (t + 0.5) * 16 - sy; X, Y = t, np.full_like(t, 0.5)
    else:
        t = 0.5 - sx / 32; zz = (0.5 + t) * 16 - sy; X, Y = np.full_like(t, 0.5), t
    ok = (t >= ext0) & (t <= ext1)
    return t, zz, X, Y, ok

def _paint_wall(img, m, face, P, t, zz, rowh, seed):
    c = C(P["wall"]); base = 1 if face == S_ else 2
    code = wall_code(P["wstyle"], t, zz, rowh, seed)
    cols = [c[base], c[min(3, base + 1)], c[max(0, base - 1)], c[3] * 0.6 + INK * 0.4]
    for ci in range(4): img[m & (code == ci), :3] = cols[ci]

def _finish(img, alpha, rp, no_outline=None):
    sil = alpha & ~(up(alpha) & left(alpha) & right(alpha) & np.vstack([alpha[1:], alpha[-1:]]))
    if no_outline is not None: sil &= ~no_outline
    img[sil, :3] = outline_of(rp)
    img[..., 3] = alpha * 255; img[~alpha] = 0
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")

def render_verge(form, seg, kind, row, tier, seed=0, mat=""):
    """gable / shed end overlay on the end tile: gable-wall triangle under the roof edge (camera-facing ends S/E) plus
    the rake overhang: the roof surface run OV_E past the end side (OV_C flare at the eave corners) with a fascia
    bargeboard under camera-facing rakes. Back ends (N/W) carry only the rake strip. kind el/er (row = downhill d),
    vr / vf (row = end side)."""
    P = mat_for(form, tier, mat)
    if kind in ("el", "er"):
        base = Piece(form, seg, "e", row); x = (row + 3) % 4 if kind == "el" else (row + 1) % 4
    elif kind == "vr":
        x = row; base = Piece(form, seg, "r", 0 if x in (E_, W_) else 1)
    else:
        x = row; base = Piece(form, seg, "f", 0)
    img = np.zeros((CH, CW, 4), np.float32); alpha = np.zeros((CH, CW), bool)
    if x in (S_, E_):
        t, zz, X, Y, ok = _plane(x, -0.5, 0.5)
        he, _, _ = base.H(X, Y)
        rise = RISES[form][base.k]; rows = max(1, round(rise / 4)); rowh = rise / rows
        z0 = -WALL_DROP if base.k == 0 else 0
        wall = ok & (zz >= z0) & (zz <= he - 0.5) & (np.abs(t) <= 0.5)
        _paint_wall(img, wall, x, P, t, zz, rowh, seed)
        if kind == "vr" and form in ("gab", "gam") and tier in (1, 2):   # little round attic vent
            tc = C(P["trim"]); vz = rise * 0.22
            vent = ok & ((t / 0.075) ** 2 + ((zz - vz) / 2.2) ** 2 < 1) & wall
            img[vent, :3] = tc[3]
            ring = wall & ~vent & ((t / 0.11) ** 2 + ((zz - vz) / 3.2) ** 2 < 1)
            img[ring, :3] = tc[1]
        sil = wall & ~(up(wall) & left(wall) & right(wall) & np.vstack([wall[1:], wall[-1:]]))
        sil &= ~(zz < z0 + 1.0) & ~(np.abs(t) > 0.5 - 1.5 / 32)   # no ink where it meets the wall below / the next end tile
        img[sil, :3] = outline_of(P["rp"])
        alpha |= wall
    reach = {(row + 2) % 4: OV_E} if form == "shd" else None   # shed: the high end may be the roof's top edge (key has no top flag)
    rake = np.asarray(render_piece(base, tier, seed, mat, extra=x, reach=reach)).astype(np.float32)
    m = rake[..., 3] > 0
    img[m] = rake[m]; alpha |= m
    img[..., 3] = alpha * 255; img[~alpha] = 0
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")

def render_wall(form, which, row, tier, seed=0, mat=""):
    P = mat_for(form, tier, mat)
    img = np.zeros((CH, CW, 4), np.float32)
    if row not in (S_, E_): return Image.fromarray(img.astype(np.uint8), "RGBA")
    h = RISES[form][0 if which == "lo" else 1]
    rows = max(1, round(h / 4)); rowh = h / rows
    t, zz, X, Y, ok = _plane(row, -0.5, 0.5)
    m = ok & (zz >= -WALL_DROP) & (zz < h)     # eaves pass: 3 px lower, over the wall top under it
    _paint_wall(img, m, row, P, t, zz, rowh, seed)
    img[..., 3] = m * 255; img[~m] = 0
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")

CHIMNEY = {1: ("brick", "box"), 2: ("cobble", "box"), 3: ("iron", "pipe"), 4: ("slate", "box")}
CHIMNEY_TOP = 24
CHIMNEY_EXTRA = {(1, "shk"): ("stone", "field")}   # log-cabin fieldstone stack
def render_chimney(tier, seed=0, mat=""):
    rp, kind = CHIMNEY_EXTRA[(tier, mat)] if mat else CHIMNEY[tier]; c = C(rp); img = np.zeros((CH, CW, 4), np.float32)
    py, px = np.mgrid[0:CH, 0:CW].astype(np.float64); sx = px + 0.5 - PX; sy = py + 0.5 - PY
    alpha = np.zeros(sx.shape, bool)
    def box(h, z0, z1, rpb, pat=True):
        cc = C(rpb)
        for face, col in ((S_, cc[1]), (E_, cc[2])):
            if face == S_: t = sx / 32 + h; zz = (t + h) * 16 - sy
            else: t = h - sx / 32; zz = (h + t) * 16 - sy
            m = (np.abs(t) <= h) & (zz >= z0) & (zz <= z1)
            img[m, :3] = col
            if pat == "field":   # irregular fieldstones: uneven courses, random joints, a few pale stones
                row = np.floor((zz - z0) / 4.0).astype(np.int64)
                colf = (t + h) / (2 * h) * 3 + 0.37 * (ihash(row, 3, 17) % 3)
                col_ = np.floor(colf).astype(np.int64)
                ln = m & ((row != up(row)) | (col_ != left(col_)))
                pale = m & ~ln & (ihash(row, col_, 29) % 4 == 0)
                img[pale, :3] = cc[0] if face == S_ else cc[1]
                img[ln, :3] = cc[3]
            elif pat:
                row = np.floor((zz - z0) / 3.0).astype(np.int64)
                col_ = np.floor((t + h) / (2 * h) * 2 + 0.5 * (row % 2)).astype(np.int64)
                ln = m & ((row != up(row)) | (col_ != left(col_)))
                img[ln, :3] = cc[min(3, (1 if face == S_ else 2) + 1)]
            alpha[...] |= m
        s = (sy + z1) / 16.0; x = (s + sx / 32) / 2; y = (s - sx / 32) / 2
        tp = (np.abs(x) <= h) & (np.abs(y) <= h); img[tp, :3] = cc[0]; alpha[...] |= tp
        return x, y, tp
    if kind == "field":
        box(0.17, -8, CHIMNEY_TOP - 4, rp, pat="field")
        x, y, tp = box(0.2, CHIMNEY_TOP - 4, CHIMNEY_TOP, "slate", pat=False)
        hole = tp & (np.abs(x) < 0.12) & (np.abs(y) < 0.12); img[hole, :3] = INK
    elif kind == "box":
        box(0.15, -8, CHIMNEY_TOP - 3, rp)
        x, y, tp = box(0.19, CHIMNEY_TOP - 3, CHIMNEY_TOP, "iron" if tier == 4 else rp, pat=False)
        hole = tp & (np.abs(x) < 0.11) & (np.abs(y) < 0.11); img[hole, :3] = INK
    else:
        r = 0.12; a = r * 32 * math.sqrt(2); b = r * 16 * math.sqrt(2)
        side = (np.abs(sx) <= a)
        ell = lambda z: -z + b * np.sqrt(np.clip(1 - (sx / a) ** 2, 0, 1))
        m = side & (sy <= ell(-8)) & (sy >= -CHIMNEY_TOP + 0 - 0)
        u = (sx / a + 1) / 2
        img[m, :3] = np.where((u < 0.3)[m][:, None], c[0], np.where((u < 0.7)[m][:, None], c[1], c[2]))
        for zr in (2, 10, 18):
            ring = side & (np.abs(sy - ell(zr) + b * 0.0) < 0.8) & m
            img[ring, :3] = c[3]
        alpha |= m
        top = ((sx / a) ** 2 + ((sy + CHIMNEY_TOP) / b) ** 2) <= 1
        img[top, :3] = c[0]; inner = ((sx / (a * 0.7)) ** 2 + ((sy + CHIMNEY_TOP) / (b * 0.7)) ** 2) <= 1
        img[inner, :3] = INK; alpha |= top
    return _finish(img, alpha, rp)
