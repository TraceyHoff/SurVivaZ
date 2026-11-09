"""Door-swing frames for the clan gate (gate_clan) and clan hall door (clan_hall_door), SurVivaZ door open animation.

Runs in its own process on the vendored pvp_clan toolkit (assets/pvp_clan/tools: its iso/toon/palette shadow the
main-pack modules of the same names). Static parts (towers, lintel, pillars, arch, banners, crest, tint masks) are the
shipped builders' own drawing code from buildings_clan.py; the door leaves are re-posed about their hinges with
door_swing_lib. Both pieces swing their two leaves inward (-y), the way the shipped gate_clan "open" frame shows them.
clan_hall_door ships no open frame, so its fully-open endpoint (dark hall interior, leaves folded back) is drawn here.
Output: cel-snapped 160x256 cells (pivot (80, 248)) + R/G tint masks binarised to 0/255, damage stages 0-3, written to
a pickle for add_door_swing.py.  Usage: python3 door_swing_clan.py <out.pkl>
"""
import math, os, pickle, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '../../../../../assets/pvp_clan/tools'))
sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
import buildings_clan as BC
from buildings_clan import Piece, RP, INKC, planks_v, planks_h, cobble, missing_planks, patch_planks, mirror
from common import H, RAMPS, NEUTRAL, NEUTRAL_METAL, circle, lerp, rstar, apply_alpha_from, tint_down, downscale, SS, outline_col
from iso import add_outline, damage
from toon import capsule_pts
from fx_combat import round_poly
import door_swing_lib as L
from door_swing_lib import OB, Xf, draw_boxes, FRACS

DEG = math.pi / 180
W, HH = 160, 256


def _box(self, x0, x1, y0, y1, z0, z1, rp, top=None, left=None, right=None, seed=0, faces="tlr", **k):
    """Piece.box through the cel oriented-box painter (whole-stop tones, one hard shade, hard highlight)."""
    self.sync_in()
    q = draw_boxes(self.ic, [OB(x0, x1, y0, y1, z0, z1, rp, top, left, right, faces, ink=False)], seed=seed)
    self.ic.ink_edges(q, width=0.5, alpha=150); self.sync_out(); return q


Piece.box = _box


def leaf_boxes(pc, obs, seed):
    pc.sync_in(); q = draw_boxes(pc.ic, obs, seed=seed); pc.sync_out(); return q


def facing(xf, local_n=(0, 1, 0)):
    n = xf.vec(local_n); return n[0] + n[1]


def snap_cel(img, extra=()):
    """flat fills: every opaque pixel -> nearest colour of the ramps this art draws with; alpha binary."""
    pal = []
    for r in ("wood", "wood_dark", "cobble", "stone", "iron", "gold"):
        rr = RP(r); pal += rr + [outline_col(rr)]
    pal += list(NEUTRAL) + [outline_col(NEUTRAL)] + [H(INKC), lerp(H(INKC), (40, 25, 40), 0.2), lerp(H(RAMPS["wood_dark"][3]), H(INKC), 0.3),
                                                     lerp(H(RAMPS["wood_dark"][3]), H(INKC), 0.4), (255, 236, 150), (255, 248, 225)] + list(extra)
    P = np.array(sorted(set(tuple(int(v) for v in c) for c in pal)), np.float32)
    a = np.asarray(img.convert("RGBA")).astype(np.float32); rgb = a[..., :3]; fig = a[..., 3] >= 128
    q = P[((rgb[..., None, :] - P[None, None]) ** 2).sum(-1).argmin(-1)]
    out = np.zeros_like(a); out[fig, :3] = q[fig]; out[fig, 3] = 255
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def finish(pc, stage, seed, lean_k):
    """buildings_clan.Piece.finish with a fractional lean (stage 3 closed leans, open stands straight)."""
    img = add_outline(pc.cv.img, 1.0, seed); img = damage(img, stage, seed); tm = pc.tm.img
    if stage == 3 and lean_k:
        k = 0.06 * lean_k * (1 if seed % 2 else -1); piv = (pc.Hh - 8) * SS
        coeff = (1, k, -k * piv, 0, 1, 0)
        img, tm = (im.transform(im.size, Image.AFFINE, coeff, resample=Image.BICUBIC) for im in (img, tm))
    tm = apply_alpha_from(tm, img); out = []
    for k in (1, 2):
        col = snap_cel(downscale(img, (W * k, HH * k)))
        t = np.asarray(tint_down(tm, (W * k, HH * k))).copy()
        t = np.where(t >= 128, 255, 0).astype(np.uint8); t[np.asarray(col)[..., 3] < 128] = 0; t[..., 2] = 0
        out.append((col, Image.fromarray(t, "RGB")))
    return out   # [(colour 1x, tintmask 1x), (colour 2x, tintmask 2x)]


def front_gaps(pc, x0, x1, y, z0, z1, n, seed, leaves):
    """missing_planks() re-posed onto swinging leaves: same rng draws, each gap follows the leaf it sits on."""
    rng = np.random.default_rng(seed)
    for i in range(n):
        u = x0 + (x1 - x0) * (0.15 + 0.7 * rng.random()); w = 0.09
        zz0 = z0 + 4 + rng.random() * 10; zz1 = zz0 + 12 + rng.random() * 12
        for (a, b, xf) in leaves:
            if a <= u + w / 2 <= b and facing(xf) > 0.02:
                pts = [xf.pt(u, y + 0.005, min(z1 - 2, zz1)), xf.pt(u + w, y + 0.005, min(z1 - 2, zz1)), xf.pt(u + w, y + 0.005, zz0), xf.pt(u, y + 0.005, zz0)]
                pc.fill([pc.p(*p) for p in pts], lerp(H(RAMPS["wood_dark"][3]), INKC, 0.4))


def leaf_patch(pc, x, y, z, xf):
    if facing(xf) <= 0.02: return
    a, b = pc.p(*xf.pt(x - 0.12, y + 0.012, z - 6)), pc.p(*xf.pt(x + 0.12, y + 0.012, z + 6))
    c, d = pc.p(*xf.pt(x - 0.12, y + 0.012, z + 6)), pc.p(*xf.pt(x + 0.12, y + 0.012, z - 6))
    for p0, p1 in ((a, b), (c, d)): pc.part(capsule_pts(p0[0], p0[1], p1[0], p1[1], 1.4), RP("wood"), lw=0.6, shade=0.2)


# ------------------------------------------------------------------ gate_clan
def gate_swing(st, f, seed=7):
    pc = Piece(W, HH, 2, 1, seed); th = f * 90 * DEG

    def tower(i, x):   # buildings_clan.gate tower(), unchanged
        pc.box(x, x + 0.3, -0.42, 0.42, 0, 66, "cobble", left=cobble(6), right=cobble(6), seed=seed + i)
        pc.box(x - 0.02, x + 0.32, -0.44, 0.44, 66, 72, "wood_dark", left=planks_h(6), right=planks_h(6), seed=seed + 3)
        for j, (a, b) in enumerate(((-0.42, -0.14), (0.14, 0.42))):
            if st == 3 and i == 1 and j == 1: continue
            pc.box(x, x + 0.3, a, b, 72, 80, "stone", left=cobble(5), right=cobble(5), seed=seed + 5 + j)
        trim = pc.front(x, x + 0.3, 0.42, 58, 64); pc.part(trim, NEUTRAL, lw=0.6, shade=0.1); pc.tint(trim, 0)
        trim2 = pc.right(x + 0.3, -0.42, 0.42, 58, 64); pc.part(trim2, [lerp(c, NEUTRAL[3], 0.2) for c in NEUTRAL], lw=0.6, shade=0.1); pc.tint(trim2, 0)
    tower(0, -1.0)
    # two leaves, hinged on the towers, folding inward (-y) to the shipped open pose (x = -0.63 / 0.63, y 0 .. -0.72)
    t = L.lerp(0.06, 0.03, f)
    xl = Xf(pivot=(-0.7, 0.0, 0.0), yaw=-th, off=(L.lerp(0, 0.07, f), L.lerp(0, -0.02, f), 0.0))
    xr = Xf(pivot=(0.7, 0.0, 0.0), yaw=th, off=(L.lerp(0, -0.07, f), L.lerp(0, -0.02, f), 0.0))
    leaves = [(-0.7, 0.0, xl), (0.0, 0.7, xr)]
    for i, (a, b, xf) in enumerate(leaves):
        leaf_boxes(pc, [OB(a, b, -t, t, 0, 54, "wood", left=planks_v(6), right=planks_v(6), xf=xf)], seed + 11 + i)
        if facing(xf) > 0.02:   # iron bands, rivets and ring handle live on the outer face
            leaf_boxes(pc, [OB(a + 0.02, b - 0.02, t, t + 0.012, z, z + 4, "iron", xf=xf, ink=False) for z in (10, 38)], seed + 30 + i)
            for z in (10, 38):
                for k in range(4):
                    c = pc.p(*xf.pt(a + 0.02 + (b - a - 0.04) * (k + 0.5) / 4, t + 0.013, z + 2))
                    pc.fill(circle(c[0], c[1], 0.8, 10), H(RAMPS["iron"][3]))
            c = pc.p(*xf.pt(b - 0.12 if i == 0 else a + 0.12, t + 0.01, 26))
            pc.line([(c[0] - 2.4, c[1] - 1), (c[0], c[1] + 2.6), (c[0] + 2.4, c[1] - 1)], H(RAMPS["gold"][2]), 1.4)
            pc.part(circle(c[0], c[1] - 1.6, 1.4, 12), RP("gold"), lw=0.5)
    if st >= 2: front_gaps(pc, -0.6, 0.5, t, 0, 54, 1 if st == 2 else 3, seed, leaves)
    if st == 3: leaf_patch(pc, -0.35, t, 30, xl)
    # lintel + banner (unchanged), right tower last
    pc.box(-0.72, 0.72, -0.16, 0.16, 54, 62, "wood_dark", left=planks_h(8), right=planks_h(8), seed=seed + 9)
    pc.band_front(-0.72, 0.72, 0.16, 56, 3, 8)
    tl, tr_ = pc.p(-0.22, 0.17, 53), pc.p(0.22, 0.17, 53)
    bn = [tl, tr_, pc.p(0.22, 0.17, 38), pc.p(0.0, 0.17, 33), pc.p(-0.22, 0.17, 38)]
    pc.part(bn, NEUTRAL, lw=0.8, shade=0.15, hl=0.1); pc.tint(bn, 0)
    c = ((bn[0][0] + bn[1][0]) / 2, (bn[0][1] + bn[1][1]) / 2 + 7); d = circle(c[0], c[1], 3.4, 20); pc.part(d, NEUTRAL, lw=0.5, shade=0.1); pc.tint(d, 1)
    tower(1, 0.7)
    return finish(pc, st, seed, 1.0 - f)


# ------------------------------------------------------------------ clan_hall_door
def hall_swing(st, f, seed=8):
    pc = Piece(W, HH, 2, 1, seed); th = f * 90 * DEG

    def pillar(i, x):   # buildings_clan.hall_door pillar(), unchanged
        pc.box(x, x + 0.28, -0.4, 0.4, 0, 70, "stone", left=cobble(6), right=cobble(6), seed=seed + i)
        pc.box(x - 0.03, x + 0.31, -0.43, 0.43, 70, 75, "wood_dark", seed=seed + 2)
        pc.part([pc.p(x - 0.03, 0.43, 75), pc.p(x + 0.31, 0.43, 75), pc.p(x + 0.14, 0.43, 84)], RP("cobble"), lw=0.7, shade=0.2)
        bx0, bx1 = x + 0.02, x + 0.26
        b = [pc.p(bx0, 0.41, 66), pc.p(bx1, 0.41, 66), pc.p(bx1, 0.41, 30), pc.p((bx0 + bx1) / 2, 0.41, 25), pc.p(bx0, 0.41, 30)]
        if not (st == 3 and i == 1): pc.part(b, NEUTRAL, lw=0.8, shade=0.15); pc.tint(b, 0)
        stp = [pc.p(bx0, 0.411, 40), pc.p(bx1, 0.411, 40), pc.p(bx1, 0.411, 37), pc.p(bx0, 0.411, 37)]
        if not (st == 3 and i == 1): pc.fill(stp, NEUTRAL[1]); pc.tint(stp, 1)
    pillar(0, -1.0)

    def arch(x0, x1, z0, zs, zt, y, n=24):
        pts = [pc.p(x0, y, z0)]
        for tt in np.linspace(0, 1, n):
            a = math.pi * (1 - tt); u = (x0 + x1) / 2 + math.cos(a) * (x1 - x0) / 2; pts.append(pc.p(u, y, zs + math.sin(a) * (zt - zs)))
        pts.append(pc.p(x1, y, z0)); return pts
    fr = arch(-0.72, 0.72, 0, 48, 72, 0.12); pc.part(fr, RP("cobble"), lw=1.0, shade=0.15, hl=0.15)
    dr = arch(-0.6, 0.6, 0, 44, 64, 0.125); cl = pc.cv.mask_from(dr)
    # the hall beyond: dark interior and a strip of plank floor running back from the threshold
    pc.fill(dr, lerp(H(RAMPS["wood_dark"][3]), INKC, 0.4))
    floor = [pc.p(-0.6, 0.125, 0), pc.p(0.6, 0.125, 0), pc.p(0.6, -0.5, 0), pc.p(-0.6, -0.5, 0)]
    pc.fill(floor, H(RAMPS["wood_dark"][2]), clip=cl)
    for j in range(1, 4):
        y = 0.125 - j * 0.16; pc.line([pc.p(-0.6, y, 0), pc.p(0.6, y, 0)], H(RAMPS["wood_dark"][3]), 0.6, clip=cl)

    def zt(x):   # arch-top height of the door leaf at piece x
        return 44 + math.sqrt(max(0.0, 1 - (x / 0.6) ** 2)) * 20
    for s in (-1, 1):   # s = -1 left leaf (hinge x -0.6), +1 right leaf (hinge x 0.6); both fold in toward -y
        xf = Xf(pivot=(s * 0.6, 0.125, 0.0), yaw=(-th if s < 0 else th))
        out = facing(xf) > 0.02
        xs = np.linspace(s * 0.6, 0.0, 14)
        local = [(s * 0.6, 0.125, 0.0), (0.0, 0.125, 0.0)] + [(x, 0.125, zt(x)) for x in xs[::-1]]
        poly = [pc.p(*xf.pt(*p)) for p in local]
        lit = (lambda n: n[1] >= n[0])(xf.vec((0, 1, 0)) if out else xf.vec((0, -1, 0)))
        rp = RP("wood") if lit else [RP("wood")[1], RP("wood")[2], RP("wood")[3], RP("wood")[3]]
        if f > 0:   # free edge thickness, seen as the leaf turns
            e = [xf.pt(0.0, 0.125, 0.0), xf.pt(0.0, 0.085, 0.0), xf.pt(0.0, 0.085, zt(0.0)), xf.pt(0.0, 0.125, zt(0.0))]
            pc.part([pc.p(*p) for p in e], RP("wood_dark"), lw=0.6, shade=0.0, hl=0.0, clip=cl)
        pc.part(poly, rp, lw=0.8, shade=0.12, hl=0.1, clip=cl)
        lm = pc.cv.mask_from(poly); lm = Image.fromarray(np.minimum(np.asarray(lm), np.asarray(cl)))
        for j in range(1, 4):   # vertical planks
            u = s * 0.6 * (1 - j / 4); pc.line([pc.p(*xf.pt(u, 0.126, 0)), pc.p(*xf.pt(u, 0.126, 70))], H(RAMPS["wood"][2]), 0.7, clip=lm)
        pc.line([pc.p(*xf.pt(0.0, 0.127, 0)), pc.p(*xf.pt(0.0, 0.127, 70))], H(RAMPS["wood_dark"][3]), 1.2, clip=lm)
        if out:
            for z in (12, 34):
                q = [pc.p(*xf.pt(s * 0.6, 0.128, z + 3.6)), pc.p(*xf.pt(0.0, 0.128, z + 3.6)), pc.p(*xf.pt(0.0, 0.128, z)), pc.p(*xf.pt(s * 0.6, 0.128, z))]
                pc.part(q, RP("iron"), lw=0.6, shade=0.2, clip=lm)
                for j in range(5):
                    c = pc.p(*xf.pt(s * (0.55 - j * 0.122), 0.129, z + 1.8)); pc.fill(circle(c[0], c[1], 0.8, 8), H(RAMPS["iron"][3]), clip=lm)
            c = pc.p(*xf.pt(s * 0.14, 0.13, 26))
            pc.line([(c[0] - 2.6, c[1]), (c[0], c[1] + 3), (c[0] + 2.6, c[1])], H(RAMPS["gold"][2]), 1.5, clip=cl)
            pc.part(circle(c[0], c[1] - 1, 1.6, 12), RP("gold"), lw=0.5, clip=cl)
        if st >= 2:
            front_gaps(pc, -0.5, 0.4, 0.125, 0, 44, 1 if st == 2 else 2, seed, [(-0.6, 0.0, xf)] if s < 0 else [(0.0, 0.6, xf)])
        if st == 3 and s > 0: leaf_patch(pc, 0.3, 0.13, 20, xf)
    c = pc.p(0, 0.13, 70); sh = round_poly([(c[0] - 6, c[1] - 6), (c[0] + 6, c[1] - 6), (c[0] + 6, c[1] + 1), (c[0], c[1] + 7), (c[0] - 6, c[1] + 1)], 2)
    pc.part(sh, NEUTRAL, lw=0.8, shade=0.15); pc.tint(sh, 1)
    pc.part(rstar(c[0], c[1], 3, 1.5, 5, -math.pi / 2, p=1.1), RP("gold"), lw=0.5)
    pillar(1, 0.72)
    return finish(pc, st, seed, 1.0)


def render_all(only=None):
    """-> {(piece, step, rot, stage, scale): (colour, tintmask)}; step 1..4 in-betweens, 5 = drawn open endpoint (hall door)."""
    out = {}
    jobs = [("gate_clan", gate_swing, FRACS), ("clan_hall_door", hall_swing, FRACS + [1.0])]
    for key, fn, fr in jobs:
        if only and key not in only: continue
        for k, f in enumerate(fr, 1):
            for st in range(4):
                for sc, (col, tm) in zip((1, 2), fn(st, f)):
                    out[(key, k, 0, st, sc)] = (col, tm)
                    out[(key, k, 1, st, sc)] = (mirror(col), mirror(tm))   # mirror rows, as the shipped sheets
    return out


if __name__ == "__main__":
    res = render_all(sys.argv[2:] or None)
    pickle.dump({k: (v[0].tobytes(), v[1].tobytes(), v[0].size) for k, v in res.items()}, open(sys.argv[1], "wb"))
    print(len(res), "clan swing cells")
