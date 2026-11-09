"""Oriented-box drawing for door-swing frames (SurVivaZ door open animation).

The iso toolkit (assets/tools/buildings.py render_boxes) only draws axis-aligned boxes; a door leaf part-way through
its swing is not axis-aligned. `draw_boxes` takes boxes in a leaf's local frame plus a rigid transform (rotation
about a hinge), projects all 8 corners with the canvas' own iso projection (cv.P), and paints every face that faces
the camera with the toolkit's own face() texture mapping. Lighting is cel: tone fields are rounded to whole ramp
stops (0 highlight, 1 base, 2 shade, 3 deep) and each face gets exactly one of three hard levels by its world normal
(top = highlight, +y facing = base, +x facing = shade), the same light direction as the closed/open sprites.

Works with any IsoCanvas-compatible canvas (main-pack assets/tools/iso.py or the vendored pvp_clan copy), so it
imports nothing from either.
"""
import math
import numpy as np

# local face -> (corner picks for p0, p0+eu, p0+ev), texture slot, local normal
# corners are indexed (ix, iy, iz) with 0 = min, 1 = max of the local box
FACES = {
    "+y": (((0, 1, 1), (1, 1, 1), (0, 1, 0)), "left", (0, 1, 0)),
    "-y": (((1, 0, 1), (0, 0, 1), (1, 0, 0)), "left", (0, -1, 0)),
    "+x": (((1, 1, 1), (1, 0, 1), (1, 1, 0)), "right", (1, 0, 0)),
    "-x": (((0, 0, 1), (0, 1, 1), (0, 0, 0)), "right", (-1, 0, 0)),
    "+z": (((0, 0, 1), (1, 0, 1), (0, 1, 1)), "top", (0, 0, 1)),
    "-z": (((0, 1, 0), (1, 1, 0), (0, 0, 0)), "top", (0, 0, -1)),
}
SLOT = {"left": "l", "right": "r", "top": "t"}
ZPX = 36.0   # px of height per tile of length (true 3D length of a 2:1 iso tile edge)


def flat_tone(w, h, s):
    return np.ones((h, w), np.float32)


class Xf:
    """Rigid transform local -> piece space (x, y tiles; z px): rotate about a vertical axis (yaw, radians) or about
    the x axis (pitch, radians, hinge line along x) around pivot (px, py, pz), then translate by off."""
    def __init__(self, pivot=(0.0, 0.0, 0.0), yaw=0.0, pitch=0.0, off=(0.0, 0.0, 0.0)):
        self.p = pivot; self.yaw = yaw; self.pitch = pitch; self.off = off

    def pt(self, x, y, z):
        px, py, pz = self.p
        dx, dy, dz = x - px, y - py, (z - pz) / ZPX
        if self.pitch:
            c, s = math.cos(self.pitch), math.sin(self.pitch)
            dy, dz = dy * c - dz * s, dy * s + dz * c
        if self.yaw:
            c, s = math.cos(self.yaw), math.sin(self.yaw)
            dx, dy = dx * c - dy * s, dx * s + dy * c
        return (px + dx + self.off[0], py + dy + self.off[1], pz + dz * ZPX + self.off[2])

    def vec(self, v):
        x, y, z = v
        if self.pitch:
            c, s = math.cos(self.pitch), math.sin(self.pitch)
            y, z = y * c - z * s, y * s + z * c
        if self.yaw:
            c, s = math.cos(self.yaw), math.sin(self.yaw)
            x, y = x * c - y * s, x * s + y * c
        return (x, y, z)


IDENT = Xf()


def view(rot, mirror):
    """piece space (x, y) -> view space for a rotation row (same as buildings.lw_fn / xform)."""
    def f(x, y):
        if mirror:
            return (y, x)
        for _ in range(rot % 4):
            x, y = -y, x
        return (x, y)
    return f


class OB:
    """an oriented box: local axis-aligned box B-like spec + transform."""
    def __init__(self, x0, x1, y0, y1, z0, z1, rp, top=None, left=None, right=None, faces="tlr", edge=True, xf=IDENT, ink=True):
        self.v = [x0, x1, y0, y1, z0, z1]; self.rp = rp; self.tex = {"top": top, "left": left, "right": right}
        self.faces = faces; self.edge = edge; self.xf = xf; self.ink = ink

    @classmethod
    def of(cls, b, xf=IDENT):
        """wrap a toolkit B box."""
        return cls(*b.v, b.rp, b.top, b.left, b.right, b.faces, b.edge, xf)

    def corners(self, vf):
        x0, x1, y0, y1, z0, z1 = self.v; out = {}
        for ix, x in enumerate((x0, x1)):
            for iy, y in enumerate((y0, y1)):
                for iz, z in enumerate((z0, z1)):
                    X, Y, Z = self.xf.pt(x, y, z); X, Y = vf(X, Y); out[(ix, iy, iz)] = (X, Y, Z)
        return out

    def aabb(self, vf):
        c = list(self.corners(vf).values())
        return [min(p[0] for p in c), max(p[0] for p in c), min(p[1] for p in c), max(p[1] for p in c), min(p[2] for p in c), max(p[2] for p in c)]


def _order(obs, vf, eps=1e-6):
    """painter order on view-space AABBs (as buildings.painter_sort), centroid depth as the tie breaker."""
    bs = [o.aabb(vf) for o in obs]; n = len(bs); before = {i: set() for i in range(n)}
    def behind(A, B):
        return A[1] <= B[0] + eps or A[3] <= B[2] + eps or A[5] <= B[4] + eps
    for i in range(n):
        for j in range(n):
            if i != j and behind(bs[i], bs[j]) and not behind(bs[j], bs[i]):
                before[j].add(i)
    key = lambda i: ((bs[i][0] + bs[i][1] + bs[i][2] + bs[i][3]) / 2, bs[i][4])
    out, done = [], set()
    while len(out) < n:
        ready = [i for i in range(n) if i not in done and before[i] <= done]
        if not ready:
            ready = [min((i for i in range(n) if i not in done), key=key)]
        i = min(ready, key=key); out.append(i); done.add(i)
    return out


def cel_level(n):
    """one of three hard lighting levels for a world-space unit normal (x, y tiles, z)."""
    x, y, z = n
    if z > 0.55:
        return -1.0          # top: highlight band
    if z < -0.55:
        return 1.0           # underside: shade
    return 0.0 if y >= x else 1.0   # +y (lit) vs +x (shade)


def draw_boxes(cv, obs, rot=0, mirror=False, seed=1, ink_color=None, after=None):
    """paint oriented boxes onto an IsoCanvas-like `cv` (cv.P, cv.face, cv.lines). Returns drawn face quads.
    after: {box index: fn(cv)} decor drawn right after that box (in painter order)."""
    vf = view(rot, mirror); sign = -1.0 if mirror else 1.0
    quads_all = []
    for k, i in enumerate(_order(obs, vf)):
        o = obs[i]; C = o.corners(vf); quads = []
        for name, (pick, slot, ln) in FACES.items():
            if SLOT[slot] not in o.faces:
                continue
            p0 = cv.P(*C[pick[0]]); p1 = cv.P(*C[pick[1]]); p3 = cv.P(*C[pick[2]])
            eu = (p1[0] - p0[0], p1[1] - p0[1]); ev = (p3[0] - p0[0], p3[1] - p0[1])
            cross = (eu[0] * ev[1] - eu[1] * ev[0]) * sign
            if cross <= 1e-3:
                continue
            wn = o.xf.vec(ln); wx, wy = vf(wn[0], wn[1])
            lvl = cel_level((wx, wy, wn[2]))
            L = math.hypot(*eu); M = math.hypot(*ev)
            w = max(4, int(L / 1.118)); h = max(4, int(M / (1.118 if slot == "top" else 1.0)))
            tex = o.tex[slot] or flat_tone
            tone = np.round(np.asarray(tex(w, h, seed * 31 + i * 7 + {"left": 1, "right": 2, "top": 3}[slot]), np.float32) + lvl)
            tone = np.clip(tone, -1, 3)
            q = cv.face(p0, eu, ev, tone, o.rp, 0.0)
            quads.append(q)
        if o.edge and o.ink and quads:
            if ink_color is None:
                cv.ink_edges(quads)
            else:
                cv.ink_edges(quads, ink_color)
        quads_all += quads
        if after and i in after:
            after[i](cv)
    return quads_all


def proj_poly(cv, pts3, rot=0, mirror=False):
    """piece-space 3D points -> SS screen polygon"""
    vf = view(rot, mirror); out = []
    for x, y, z in pts3:
        X, Y = vf(x, y); out.append(cv.P(X, Y, z))
    return out


def ease(t):
    """smoothstep: frames sampled at even times land on eased swing angles (constant fps, soft start/stop)."""
    return t * t * (3 - 2 * t)


STEPS = 4                                   # in-betweens per sequence (closed + 4 + open = 6 frames)
FRACS = [ease((k + 1) / (STEPS + 1)) for k in range(STEPS)]   # 0.104, 0.352, 0.648, 0.896


def lerp(a, b, t):
    return a + (b - a) * t
