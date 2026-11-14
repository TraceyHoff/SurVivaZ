"""Seamless neighbour-aware roof art (docs/ART_KEYS_ROOFS.md). Every piece is cut from one continuous roof
heightfield (distance-to-eave -> per-form profile), rendered by a 1x ray cast in world space, so neighbouring
pieces share edge pixels and course lines exactly. Solid cel: flat ramp fills, one hard shade, a hard highlight,
binary alpha, outline only on true silhouettes (eaves, verges, gable walls), none on internal seams."""
import math, sys, os
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../../../assets/tools'))
from palette import ramp, hex2rgb, RAMPS

CW, CH, PX, PY = 72, 68, 36, 44          # cell, pivot (diamond centre at the piece base)
OV = 0.04                                  # eave overhang (tiles)
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

def render_piece(piece, tier, seed=0, mat=""):
    P = mat_for(piece.form, tier, mat)
    if piece.form == "flt": piece.H = _flt_H(piece)
    hit, X, Y, Z, v, fac = raycast(piece)
    Hh, _, _ = piece.H(X, Y)
    x0, x1, y0, y1 = bounds(piece)
    eps = 1e-6
    foot = hit & (X >= x0 - eps) & (X < x1 + eps) & (Y >= y0 - eps) & (Y < y1 + eps)
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
        cl = cap & ~((cap == up(cap)) & (cap == left(cap)) & (cap == right(cap)))
        # cap edge line only against roof surface (not against the tile cut)
        ed = cap & ((top & ~cap) == False) & (((~cap) & top)[[0] + list(range(CH - 1))] | left((~cap) & top) | right((~cap) & top))
        img[ed, :3] = C(P["trim"])[3]
        sl = cap & (seg_l != left(seg_l)) & ~ed
        img[sl, :3] = C(P["trim"])[2]
    if valley.any(): img[valley, :3] = tones(P["rp"], S_)[3]
    # ---- risers (flat parapet inner faces, plateau steps)
    if riser.any():
        img[riser, :3] = C(P["trim"])[2]
    # ---- fascia on visible boundary sides (world S / E)
    fasc = np.zeros(X.shape, bool)
    py, px = np.mgrid[0:CH, 0:CW].astype(np.float64); sx = px + 0.5 - PX; sy = py + 0.5 - PY
    FD = FASCIA[piece.form]
    for sd in piece.bnd:
        if sd not in (S_, E_): continue
        if sd == S_:
            Yp = y1; xx = sx / 32 + Yp; zz = (xx + Yp) * 16 - sy; ok = (xx >= x0) & (xx <= x1)
            he, _, _ = piece.H(np.clip(xx, -0.9, 0.9), np.full_like(xx, Yp))
        else:
            Xp = x1; yy = Xp - sx / 32; zz = (Xp + yy) * 16 - sy; ok = (yy >= y0) & (yy <= y1)
            he, _, _ = piece.H(np.full_like(yy, Xp), np.clip(yy, -0.9, 0.9))
        fd = he if piece.form == "flt" else FD
        m = ok & (zz <= he + 0.3) & (zz >= he - fd) & ~top & ~riser
        col = C(P["trim"])[1 if sd == S_ else 2]
        img[m, :3] = col
        bot = m & (zz < he - fd + 1.0)
        img[bot, :3] = C(P["trim"])[3]
        fasc |= m
    alpha = top | riser | fasc
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
            edge = blob & ~(up(blob) & left(blob) & right(blob))
            img[edge, :3] = mc[2]
            dots = blob & ~edge & (ihash(np.floor(X * 40).astype(np.int64), np.floor(Y * 40).astype(np.int64), seed) % 5 == 0)
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
    # ---- silhouette outline (skip internal seams)
    sil = alpha & ~(up(alpha) & left(alpha) & right(alpha) & np.vstack([alpha[1:], alpha[-1:]]))
    internal = np.zeros(X.shape, bool)
    for sd in range(4):
        if sd in piece.bnd: continue
        internal |= term(sd, X, Y) < 0.06
    sil &= ~(top & internal & ~fasc)
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
    """gable-end overlay: wall triangle under this tile's roof edge + bargeboard. kind el/er (row = downhill d),
    vr / vf (row = end side)."""
    P = mat_for(form, tier, mat)
    if kind in ("el", "er"):
        base = Piece(form, seg, "e", row); x = (row + 3) % 4 if kind == "el" else (row + 1) % 4
    elif kind == "vr":
        x = row; base = Piece(form, seg, "r", 0 if x in (E_, W_) else 1)
    else:
        x = row; base = Piece(form, seg, "f", 0)
    img = np.zeros((CH, CW, 4), np.float32)
    if x not in (S_, E_): return Image.fromarray(img.astype(np.uint8), "RGBA")
    x0, x1, y0, y1 = bounds(base)
    lo_, hi_ = (x0, x1) if x == S_ else (y0, y1)
    t, zz, X, Y, ok = _plane(x, lo_, hi_)
    he, _, _ = base.H(X, Y)
    rise = RISES[form][base.k]; rows = max(1, round(rise / 4)); rowh = rise / rows
    wall = ok & (zz >= 0) & (zz <= he - 1.0) & (np.abs(t) <= 0.5)
    board = ok & (zz > he - 1.0) & (zz <= he + 2.0)
    _paint_wall(img, wall, x, P, t, zz, rowh, seed)
    tc = C(P["trim"]); img[board, :3] = tc[1 if x == S_ else 2]
    img[board & (zz > he + 1.0), :3] = tc[0 if x == S_ else 1]
    if kind == "vr" and form in ("gab", "gam") and tier in (1, 2):   # little round attic vent
        vz = he * 0.0 + rise * 0.22
        vent = ok & ((t / 0.075) ** 2 + ((zz - vz) / 2.2) ** 2 < 1) & wall
        img[vent, :3] = tc[3]
        ring = wall & ~vent & ((t / 0.11) ** 2 + ((zz - vz) / 3.2) ** 2 < 1)
        img[ring, :3] = tc[1]
    alpha = wall | board
    return _finish(img, alpha, P["rp"], no_outline=(zz < 1.0) & wall)

def render_wall(form, which, row, tier, seed=0, mat=""):
    P = mat_for(form, tier, mat)
    img = np.zeros((CH, CW, 4), np.float32)
    if row not in (S_, E_): return Image.fromarray(img.astype(np.uint8), "RGBA")
    h = RISES[form][0 if which == "lo" else 1]
    rows = max(1, round(h / 4)); rowh = h / rows
    t, zz, X, Y, ok = _plane(row, -0.5, 0.5)
    m = ok & (zz >= 0) & (zz < h)
    _paint_wall(img, m, row, P, t, zz, rowh, seed)
    img[..., 3] = m * 255; img[~m] = 0
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")

CHIMNEY = {1: ("brick", "box"), 2: ("cobble", "box"), 3: ("iron", "pipe"), 4: ("slate", "box")}
CHIMNEY_TOP = 24
def render_chimney(tier, seed=0):
    rp, kind = CHIMNEY[tier]; c = C(rp); img = np.zeros((CH, CW, 4), np.float32)
    py, px = np.mgrid[0:CH, 0:CW].astype(np.float64); sx = px + 0.5 - PX; sy = py + 0.5 - PY
    alpha = np.zeros(sx.shape, bool)
    def box(h, z0, z1, rpb, pat=True):
        cc = C(rpb)
        for face, col in ((S_, cc[1]), (E_, cc[2])):
            if face == S_: t = sx / 32 + h; zz = (t + h) * 16 - sy
            else: t = h - sx / 32; zz = (h + t) * 16 - sy
            m = (np.abs(t) <= h) & (zz >= z0) & (zz <= z1)
            img[m, :3] = col
            if pat:
                row = np.floor((zz - z0) / 3.0).astype(np.int64)
                col_ = np.floor((t + h) / (2 * h) * 2 + 0.5 * (row % 2)).astype(np.int64)
                ln = m & ((row != up(row)) | (col_ != left(col_)))
                img[ln, :3] = cc[min(3, (1 if face == S_ else 2) + 1)]
            alpha[...] |= m
        s = (sy + z1) / 16.0; x = (s + sx / 32) / 2; y = (s - sx / 32) / 2
        tp = (np.abs(x) <= h) & (np.abs(y) <= h); img[tp, :3] = cc[0]; alpha[...] |= tp
        return x, y, tp
    if kind == "box":
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
