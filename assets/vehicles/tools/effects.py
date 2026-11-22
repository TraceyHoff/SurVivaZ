"""2D state effects at SS: damaged / wrecked / rusty. Operate on float col(H,W,4), mat(H,W), tint(H,W), emi(H,W,3)."""
import math, numpy as np
from PIL import Image, ImageDraw
from vrender import _noise, SS, M_PAINT, M_GLASS, M_METAL, M_TRIM, M_LIGHTBODY, M_LAMP, M_TYRE, M_WOOD, M_INTERIOR

RUST = np.array([168, 86, 46], np.float32); RUST2 = np.array([120, 58, 38], np.float32); SOOT = np.array([46, 38, 44], np.float32)

def _bbox(a):
    ys, xs = np.nonzero(a > 0.5)
    return (xs.min(), xs.max(), ys.min(), ys.max()) if len(xs) else (0, 1, 0, 1)

def _cracks(H, W, glass, rng, n=2, color=(245, 252, 255)):
    im = Image.new("L", (W, H), 0); d = ImageDraw.Draw(im); ys, xs = np.nonzero(glass)
    if not len(xs): return np.zeros((H, W), np.float32)
    for _ in range(n):
        i = rng.integers(len(xs)); cx, cy = xs[i], ys[i]
        for k in range(7):
            a = rng.random() * 2 * math.pi; x, y = cx, cy; pts = [(x, y)]
            for s in range(3):
                a += rng.normal(0, 0.4); ln = SS * (2 + rng.random() * 4); x += math.cos(a) * ln; y += math.sin(a) * ln; pts.append((x, y))
            d.line(pts, fill=255, width=max(1, SS // 2))
    return np.asarray(im, np.float32) / 255.0 * glass

def _dirt(col, a, strength=0.25, color=(120, 92, 64)):
    x0, x1, y0, y1 = _bbox(a); H = col.shape[0]
    yy = np.arange(H, dtype=np.float32)[:, None]; t = np.clip((yy - (y0 + (y1 - y0) * 0.55)) / max(1, (y1 - y0) * 0.45), 0, 1) * strength
    t = np.where(t > 0.45 * strength, 0.7 * strength, 0.0).astype(np.float32)  # one hard grime band (cel), not a gradient
    col[..., :3] = col[..., :3] * (1 - t[..., None]) + np.array(color, np.float32) * t[..., None] * (col[..., :3] / 200.0)

def damaged(col, mat, tint, emi, seed, level=1.0):
    rng = np.random.default_rng(seed + 11); H, W = mat.shape; a = col[..., 3] / 255
    paint = (mat == M_PAINT) | (mat == M_LIGHTBODY) | (mat == M_TRIM) | (mat == M_WOOD)
    n = _noise(W, H, 3 * SS, seed + 3); dent = (n > 0.86 - 0.05 * level) & paint
    rim = np.zeros_like(dent); rim[:-SS, :] = dent[SS:, :]; rim &= ~dent & paint
    col[..., :3][dent] *= 0.88; col[..., :3][rim] = col[..., :3][rim] * 0.85 + 255 * 0.15
    # scratches
    im = Image.new("L", (W, H), 0); d = ImageDraw.Draw(im); ys, xs = np.nonzero(paint)
    for _ in range(int(6 * level)):
        if not len(xs): break
        i = rng.integers(len(xs)); x, y = xs[i], ys[i]; ang = rng.normal(0, 0.35); ln = SS * (4 + rng.random() * 8)
        d.line([(x, y), (x + math.cos(ang) * ln, y + math.sin(ang) * ln)], fill=255, width=max(1, SS // 2))
    s = (np.asarray(im, np.float32) / 255) * paint; col[..., :3] = col[..., :3] * (1 - s[..., None] * 0.6) + 245 * s[..., None] * 0.6
    tint *= (1 - s * 0.8); tint[dent] *= 0.9
    c = _cracks(H, W, mat == M_GLASS, rng, n=1 + int(level)); col[..., :3] = col[..., :3] * (1 - c[..., None]) + 250 * c[..., None]
    _dirt(col, a, 0.22 * level)
    emi *= 0.85
    return col, tint, emi

def scorch(col, mat, tint, seed, amt):
    H, W = mat.shape; n = _noise(W, H, 9 * SS, seed + 5) * 0.7 + _noise(W, H, 3 * SS, seed + 6) * 0.3
    s = (np.clip((n - (0.7 - 0.3 * amt)) * 2.5, 0, 1) > 0.5).astype(np.float32) * (mat != 0)  # hard-edged soot patches
    col[..., :3] = col[..., :3] * (1 - s[..., None] * 0.7) + SOOT * s[..., None] * 0.7
    tint *= (1 - s); return s

def rust(col, mat, tint, seed, amt, cell=4):
    H, W = mat.shape; n = _noise(W, H, cell * SS, seed + 8) * 0.65 + _noise(W, H, SS, seed + 9) * 0.35
    metal = (mat == M_PAINT) | (mat == M_METAL) | (mat == M_TRIM) | (mat == M_LIGHTBODY)
    a = col[..., 3] > 0; ys = np.nonzero(a.any(1))[0]; y0, y1 = (ys.min(), ys.max()) if len(ys) else (0, H)
    grad = np.clip((np.arange(H, dtype=np.float32)[:, None] - y0) / max(1, y1 - y0), 0, 1)  # rust creeps up from the sills
    s = (np.clip((n + 0.35 * grad - (0.86 - 0.32 * amt)) * 3.0, 0, 1) > 0.5).astype(np.float32) * metal  # hard-edged rust patches
    # streaks: drip down
    st = s.copy()
    for k in range(1, 6): st[k * SS // 2:, :] = np.maximum(st[k * SS // 2:, :], s[:-k * SS // 2, :] * (1 - k / 6))
    st = (st > 0.4).astype(np.float32) * metal * 0.9; c2 = np.where((n > 0.55)[..., None], RUST2, RUST)  # two flat rust tones
    lum = col[..., :3].mean(-1, keepdims=True) / 200
    col[..., :3] = col[..., :3] * (1 - st[..., None] * 0.85) + c2 * lum * st[..., None] * 0.85
    tint *= (1 - st); return st

def wrecked(col, mat, tint, emi, seed):
    col, tint, emi = damaged(col, mat, tint, emi, seed, 2.0)
    g = mat == M_GLASS; H, W = mat.shape; n = _noise(W, H, 2 * SS, seed + 13)
    hole = g & (n > 0.35)
    col[..., :3][hole] = np.array([44, 40, 58], np.float32); col[..., :3][g & ~hole] = col[..., :3][g & ~hole] * 0.8 + 50
    scorch(col, mat, tint, seed, 0.55); rust(col, mat, tint, seed, 0.3)
    tint *= 0.75; emi[:] = 0
    return col, tint, emi

def rusty(col, mat, tint, emi, seed):
    H, W = mat.shape; a = col[..., 3] / 255
    p = mat == M_PAINT; lum = col[..., :3].mean(-1)
    col[..., :3][p] = col[..., :3][p] * 0.55 + lum[p][:, None] * 0.45 * np.array([1.0, 0.97, 0.9])
    tint *= 0.5  # faded paint (tint strength halves under the mask)
    rust(col, mat, tint, seed, 0.6, cell=3)
    g = mat == M_GLASS; n = _noise(W, H, 3 * SS, seed + 21)
    col[..., :3][g] = col[..., :3][g] * (0.55 + 0.2 * (n[g][:, None] > 0.5)) + np.array([60, 66, 40]) * 0.3
    c = _cracks(H, W, g, np.random.default_rng(seed), n=2); col[..., :3] = col[..., :3] * (1 - c[..., None] * 0.7) + 220 * c[..., None] * 0.7
    _dirt(col, a, 0.45, (110, 96, 60)); emi[:] = 0
    return col, tint, emi

EFFECTS = {"intact": None, "door_open": None, "damaged": damaged, "wrecked": wrecked, "rusty": rusty}
