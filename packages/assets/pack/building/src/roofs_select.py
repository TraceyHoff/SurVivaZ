"""Reference implementation of the engine-side roof selection in docs/ART_KEYS_ROOFS.md §4 (used for previews and
to keep the spec honest). Not shipped."""
import roofs_lib as R
from roofs_lib import S_, W_, N_, E_, KMAX
DV = {S_: (0, 1), W_: (-1, 0), N_: (0, -1), E_: (1, 0)}
BIT = {N_: 1, E_: 2, S_: 4, W_: 8}
DIAG = {16: (1, -1), 32: (1, 1), 64: (-1, 1), 128: (-1, -1)}

def hashU32(seed, a, b=0, c=0):
    M = 0xFFFFFFFF; imul = lambda x, y: (x * y) & M
    h = (seed ^ imul(a & M, 0x9e3779b9) ^ imul(b & M, 0x85ebca6b) ^ imul(c & M, 0xc2b2ae35)) & M
    h = imul(h ^ (h >> 16), 0x7feb352d); h = imul(h ^ (h >> 15), 0x846ca68b)
    return (h ^ (h >> 16)) & M

def bands(cells, form, axis=None, D=None):
    m = set(cells); band = {}
    for (x, y) in m:
        if form in ("hip", "cot"):
            d = 1
            while all((x + i, y + j) in m for i in range(-d, d + 1) for j in range(-d, d + 1)) and d < 50: d += 1
            band[(x, y)] = min(d - 1, KMAX)
        elif form in ("gab", "gam"):
            px, py = (0, 1) if axis == "EW" else (1, 0); a = b = 0
            while (x - px * (a + 1), y - py * (a + 1)) in m: a += 1
            while (x + px * (b + 1), y + py * (b + 1)) in m: b += 1
            band[(x, y)] = min(a, b, KMAX)
        elif form == "shd":
            dx, dy = DV[D]; n = 0
            while (x + dx * (n + 1), y + dy * (n + 1)) in m: n += 1
            band[(x, y)] = n
        else: band[(x, y)] = 0
    return band

def select(cells, form, tiers=None, axis="EW", D=S_, level=0, chimneys=()):
    """-> list of (x, y, key, z_px) in draw order (painter: x + y, then overlays)."""
    m = set(cells); band = bands(cells, form, axis, D); ops = []
    tier_of = lambda c: (tiers or {}).get(c, 1)
    for (x, y) in sorted(m, key=lambda c: (c[0] + c[1], c[0])):
        k = band[(x, y)]; t = tier_of((x, y)); z = R.zoff(form, k)
        def lower(dx, dy, perp_only=False):
            n = (x + dx, y + dy)
            return n not in m or band[n] < k
        L = 0
        for s, (dx, dy) in DV.items():
            if form in ("gab", "gam"):
                if axis == "EW" and s in (E_, W_): continue
                if axis == "NS" and s in (N_, S_): continue
            if lower(dx, dy): L |= BIT[s]
        if form not in ("gab", "gam", "shd", "flt"):
            for b, (dx, dy) in DIAG.items():
                if lower(dx, dy): L |= b
        elif form == "flt":
            for b, (dx, dy) in DIAG.items():
                if (x + dx, y + dy) not in m: L |= b
        n = L & 15
        if form in ("hip", "cot", "gab", "gam") and k == KMAX: n = 0; L = 0
        seg = "lo" if k == 0 else "up"
        if form == "shd":
            top = (x - DV[D][0], y - DV[D][1]) not in m
            seg = ("lotop" if top else "lo") if k == 0 else ("top" if top else "up")
            shape, row = "e", D
        else:
            T = {0: None, 4: ("e", 0), 8: ("e", 1), 1: ("e", 2), 2: ("e", 3), 6: ("o", 0), 12: ("o", 1), 9: ("o", 2), 3: ("o", 3),
                 5: ("r", 0), 10: ("r", 1), 14: ("h", 0), 13: ("h", 1), 11: ("h", 2), 7: ("h", 3), 15: ("p", 0)}[n]
            if T is None:
                shape, row = "f", 0
                for b, r in ((32, 0), (64, 1), (128, 2), (16, 3)):
                    if L & b: shape, row = "i", r; break
                if form in ("gab", "gam") and shape == "f" and k < KMAX: shape, row = "r", 0 if axis == "EW" else 1
            else: shape, row = T
        crest = False
        if shape == "e" and form != "shd":
            u = (row + 2) % 4; nb = (x + DV[u][0], y + DV[u][1]); crest = nb in m and band[nb] == k
        var = 0
        if shape in ("e", "f") and not crest and seg in ("lo", "up"):
            hh = hashU32(0x52F00396, x, y, level) & 3; var = 0 if hh < 2 else hh - 1
        key = dict(form=form, seg=seg, shape=shape, row=row, crest=crest, var=var, tier=t)
        ops.append((x, y, ("piece", key), z))
        # overlays
        if form in ("gab", "gam"):
            ends = (E_, W_) if axis == "EW" else (N_, S_)
            for xs in ends:
                if (x + DV[xs][0], y + DV[xs][1]) in m: continue
                if shape == "e": kind = "er" if xs == (row + 1) % 4 else "el" if xs == (row + 3) % 4 else None; vrow = row
                elif shape == "r": kind, vrow = "vr", xs
                else: kind, vrow = "vf", xs
                if kind is None: continue
                for j in range(k): ops.append((x, y, ("wall", dict(form=form, which="lo" if j == 0 else "up", row=xs, tier=t)), R.zoff(form, j)))
                ops.append((x, y, ("verge", dict(form=form, seg="lo" if k == 0 else "up", kind=kind, row=vrow, tier=t)), z))
        if form == "shd":
            for xs, kind in (((D + 1) % 4, "er"), ((D + 3) % 4, "el")):
                if (x + DV[xs][0], y + DV[xs][1]) in m: continue
                for j in range(k): ops.append((x, y, ("wall", dict(form=form, which="lo" if j == 0 else "up", row=xs, tier=t)), R.zoff(form, j)))
                ops.append((x, y, ("verge", dict(form=form, seg="lo" if k == 0 else "up", kind=kind, row=D, tier=t)), z))
            if seg in ("top", "lotop"):
                u = (D + 2) % 4
                for j in range(k + 1): ops.append((x, y, ("wall", dict(form=form, which="lo" if j == 0 else "up", row=u, tier=t)), R.zoff(form, j)))
        if (x, y) in chimneys and t >= 1:
            ops.append((x, y, ("chimney", dict(tier=t)), z + R.RISES[form][k] // 2))
    return ops
