"""SurVivaZ rideable mounts: dedicated true-scale quadruped renderer (cute cel toon style).

Every mount is authored in METRES and rendered at one shared pixels-per-metre (PX_PER_M) measured from the
player doll, so a rescale is a single constant change + re-run of artpass_mounts.py:
    player body sprite (body_male/body_female idle, every facing) = 52 px pivot->head top at 1x  ->  1.75 m
    PX_PER_M = 52 / 1.75 = 29.714 px/m (1x; @2x pages are exactly double)
SCALE_TABLE below holds each species' shoulder/withers height in metres (and so in px).

8 facings, same convention as the creature sheets (DIR8_PHI, engine order E,SE,S,SW,W,NW,N,NE).
Anims: idle 4f, walk 6f (4-beat), gallop 6f (transverse gallop with suspension). Draw modes per frame:
    full            the mount (sprite mount_<species>)
    fore            the mount parts that are nearer the camera than the saddle seat (head/neck/near legs/tail
                    depending on facing) -> drawn OVER the rider (sprite mount_<species>_fore)
    saddle:<tier>   only the visible saddle pixels, occluded by the fore parts (sprite mount_saddle_<species>_<tier>)
Seat anchors (where the rider's seat socket goes) are returned per frame in 1x px relative to the mount pivot.
"""
import os, sys, math, zlib
os.environ.setdefault("CEL", "1")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../../../.."))
sys.path.insert(0, os.path.join(REPO, "assets/tools"))
import numpy as np
from PIL import Image
import toon
from toon import Canvas, capsule_pts, ellipse_pts
import palette
from palette import ramp
from chars import Rig

# ---------------------------------------------------------------- scale (edit + re-run artpass_mounts.py to rescale)
PLAYER_HEIGHT_M = 1.75
PLAYER_PX = 52.0                     # measured: body_* idle frames, pivot -> top of head, all 8 facings (1x)
PX_PER_M = PLAYER_PX / PLAYER_HEIGHT_M
SCALE_TABLE = {   # species: (sprite key, shoulder/withers height m, note)
    "horse":  ("mount_horse",  1.60, "withers"),
    "donkey": ("mount_donkey", 1.20, "withers"),
    "moose":  ("mount_moose",  2.00, "shoulder (hump top)"),
    "deer":   ("mount_deer",   1.35, "shoulder"),
    "elk":    ("mount_elk",    1.45, "shoulder"),
    "bison":  ("mount_bison",  1.80, "shoulder hump top"),
    "yak":    ("mount_yak",    1.55, "shoulder hump top"),
}
WILD_KEY = {"moose": "animal_moose", "deer": "animal_deer", "elk": "animal_elk", "bison": "animal_bison"}
TIERS = ("leather", "reinforced", "iron", "steel")
ANIMS = [("idle", 4, 4), ("walk", 6, 8), ("gallop", 6, 12)]          # rideable gaits (rider ride_<anim> 1:1)
# action anims (second pass, appended on their own pages): (name, frames, fps, loop, species or None = all)
ACTS = [("hit", 3, 10, True, None), ("death", 6, 8, False, None), ("graze", 4, 4, True, None), ("swim", 6, 8, True, ("moose",))]
NFRAMES = {a[0]: a[1] for a in ANIMS} | {a[0]: a[1] for a in ACTS}
def acts_for(species): return [(a, n, fps, loop) for a, n, fps, loop, only in ACTS if only is None or species in only]
DIR8_PHI = [45 - 45 * i for i in range(8)]
ELEV = 0.42

palette.RAMPS.update({
    "fur_red":   ["#e0a07a", "#b86c48", "#8c4c36", "#5e3428"],
    "fur_dark":  ["#a07e66", "#6e5242", "#4e3a32", "#30242a"],
    "fur_tan":   ["#f0d6a8", "#d2aa78", "#a8805a", "#765a44"],
    "fur_grey":  ["#e6e2dc", "#bdb6ae", "#8e8680", "#625c5a"],
    "fur_black": ["#7a7280", "#4c4652", "#34303c", "#201e28"],
    "chestnut":  ["#f2b47c", "#d27f4c", "#a65c38", "#70402c"],
    "flaxen":    ["#fff2c4", "#f4dc96", "#d8b468", "#a88a4c"],
    "donkey":    ["#d8d0d4", "#a89ca6", "#7e7280", "#585060"],
    "yak":       ["#6e5a5c", "#4a3a40", "#34282e", "#221a20"],
    "horn":      ["#fff6e0", "#eadcb8", "#c4ae86", "#8e7a5c"],
    "hoof":      ["#8a7268", "#5e4a44", "#463632", "#2e2224"],
    "saddle_lt": ["#e8b07a", "#c07a46", "#8e5232", "#5e3424"],
    "saddle_dk": ["#b67650", "#874e32", "#633828", "#40241e"],
    "steel":     ["#ffffff", "#d6e2ee", "#9aacc4", "#64748e"],
    "blanket_r": ["#ff9e86", "#e4604e", "#b44444", "#7e2e3a"],
    "blanket_g": ["#c4e88c", "#86b94f", "#5f8f3c", "#40652e"],
    "blanket_b": ["#9cccf4", "#4f8fd6", "#3a66a8", "#2b4780"],
    "blanket_p": ["#dcbcf8", "#9b72d6", "#7452ad", "#523a80"],
})

# ---------------------------------------------------------------- species (metres; cute cartoon proportions on true heights)
# wh = withers/shoulder height (from SCALE_TABLE), rb body radius, L rear->front body centre distance,
# lx leg lateral offset, lw leg radius, neck (fwd, up) of head centre from the front body top, hr head radius,
# face: (snout fwd, snout down, snout r) from head centre, ears kind+length, tail kind+length.
SPEC = {
  "horse":  dict(fur="chestnut", belly="chestnut", leg="chestnut", sock="snow", hoof="hoof", mane="flaxen", mane_kind="flow",
                 rb=0.347, L=.92, lx=.13, lw=0.084, neck=(.40, .42), nw=0.230, hr=0.247, face=(.27, .14, .115), ears=("pointy", .14),
                 tail=("horse", .78), blaze="snow", muzzle="chestnut", eye=.30),
  "donkey": dict(fur="donkey", belly="cloth_cream", leg="donkey", hoof="hoof", mane="fur_black", mane_kind="brush",
                 rb=0.302, L=.70, lx=.115, lw=0.078, neck=(.28, .30), nw=0.203, hr=0.255, face=(.21, .12, .115), ears=("donkey", .34),
                 tail=("tuft", .52), muzzle="cloth_cream", eyering="cloth_cream", cross="fur_black", eye=.32),
  "moose":  dict(fur="fur_dark", belly="fur_dark", leg="fur_tan", hoof="hoof", rb=0.403, L=1.0, lx=.15, lw=0.095,
                 neck=(.38, .1), nw=0.257, hr=0.27, face=(.34, .2, .16), ears=("deer", .2), tail=("short", .1), antlers="palm",
                 hump=.16, bell="fur_dark", muzzle="fur_dark", eye=.27),
  "deer":   dict(fur="fur_orange", belly="cloth_cream", leg="fur_orange", hoof="bark", rb=0.280, L=.74, lx=.11, lw=0.068,
                 neck=(.30, .34), nw=0.176, hr=0.225, face=(.16, .07, .085), ears=("deer", .17), tail=("puff", .09), antlers="branch",
                 spots="cloth_cream", muzzle="hide", eye=.34),
  "elk":    dict(fur="fur_tan", belly="fur_tan", leg="fur_dark", hoof="bark", rb=0.314, L=.84, lx=.12, lw=0.078,
                 neck=(.32, .36), nw=0.203, hr=0.240, face=(.18, .08, .095), ears=("deer", .17), tail=("short", .08), antlers="big",
                 shag="fur_dark", rump="cloth_cream", muzzle="fur_dark", face_c="fur_dark", eye=.30),
  "bison":  dict(fur="fur_brown", belly="fur_brown", leg="fur_dark", hoof="hoof", rb=0.470, L=.95, lx=.17, lw=0.115,
                 neck=(.30, -.18), nw=0.351, hr=0.375, face=(.15, .14, .14), ears=("small", .08), tail=("tuft", .45), horns="bison",
                 hump=.22, shag="fur_dark", beard="fur_dark", muzzle="fur_dark", face_c="fur_dark", eye=.26),
  "yak":    dict(fur="yak", belly="yak", leg="yak", hoof="hoof", rb=0.426, L=.92, lx=.16, lw=0.108,
                 neck=(.26, -.06), nw=0.297, hr=0.315, face=(.15, .1, .12), ears=("small", .08), tail=("plume", .5), horns="yak",
                 hump=.12, skirt="yak", facepatch="snow", muzzle="fur_grey", eye=.28),
}
for _s, (_k, _wh, _n) in SCALE_TABLE.items(): SPEC[_s]["wh"] = _wh; SPEC[_s]["key"] = _k

def species_px():
    """report helper: shoulder/withers height per species in 1x px at PX_PER_M."""
    return {s: round(SCALE_TABLE[s][1] * PX_PER_M, 1) for s in SCALE_TABLE}

def canvas_size(sp):
    """1x canvas (W, H, feetY) big enough for every facing/frame; cells are trimmed later."""
    reach = max(sp["L"] / 2 + sp["neck"][0] + sp["hr"] + sp["face"][0] + sp["face"][2], sp["L"] / 2 + sp["rb"] + sp["tail"][1] * .9,
                .85 if sp.get("antlers") == "palm" else .55) + .45
    top = sp["wh"] + max(sp["neck"][1] + sp["hr"] + .55, sp.get("hump", 0) + .2)
    W = int(math.ceil(2 * reach * PX_PER_M / 8) * 8) + 16
    H = int(math.ceil((top + reach * ELEV) * PX_PER_M / 8) * 8) + 16
    feet = H - int(math.ceil(reach * ELEV * PX_PER_M)) - 6
    return W, H, feet

# ---------------------------------------------------------------- motion
def params(anim, fi, sp):
    n = NFRAMES[anim]; t = 2 * math.pi * fi / n
    leglen = sp["wh"] - 2 * sp["rb"] * .85
    P = dict(sw=[0.0] * 4, lift=[0.0] * 4, z=0.0, pitch=0.0, hdz=0.0, hdy=0.0, wag=0.0, ear=0.0, eyes="open", flow=0.0, mouth=0,
             spread=[0.0] * 4, fz=0.0, water=None, tongue=False, grass=False, stars=0)
    bz0 = sp["wh"] - sp["rb"] - sp.get("hump", 0) * .55; hz0 = sp["wh"] + sp["neck"][1]
    def head_at(zt, z): return zt - hz0 - z     # hdz that puts the head centre at height zt
    if anim == "hit":      # flinch: rear back, head jerks up/back, > < eyes, ears pinned, tail flick
        P["z"] = [-.03, -.05, -.015][fi]; P["pitch"] = [-.06, -.03, -.01][fi]; P["hdy"] = [-.09, -.05, -.01][fi]; P["hdz"] = [.07, .03, .0][fi]
        P["sw"] = [[.06, .06, -.05, -.05], [.03, .04, -.07, -.06], [.01, .0, -.02, -.01]][fi]; P["spread"] = [.04, .06, .02][fi:fi + 1] * 4
        P["ear"] = [-.7, -.5, .2][fi]; P["wag"] = [1.1, -.9, .3][fi]; P["eyes"] = ["ouch", "ouch", "blink"][fi]; P["mouth"] = fi < 2; P["stars"] = [3, 2, 0][fi]
        return P
    if anim == "death":    # goofy flop: dizzy stagger -> knees buckle -> belly splat with legs splayed -> bounce -> X eyes + tongue
        lie = -(bz0 - sp["rb"] * .95)
        P["z"] = [0, -.14 * leglen, -.38 * leglen, lie, lie + .05, lie][fi]
        P["pitch"] = [.04, -.03, -.05, 0, .01, 0][fi]
        sp_ = [.04, .08, .16, .34, .3, .36][fi]; P["spread"] = [sp_] * 4
        fwd = [0, .02, .06, .22, .2, .24][fi]; P["sw"] = [fwd, fwd * .9, -fwd, -fwd * .9]
        P["fz"] = 0.0; P["lift"] = [0, 0, 0, 0] if fi < 3 else [.04, .05, .03, .04]
        lay = sp["hr"] * .95
        P["hdz"] = [.05, -.1, -.3, head_at(lay, lie), head_at(lay + .07, lie + .05), head_at(lay, lie)][fi]; P["hdy"] = [-.03, .03, .08, .16, .14, .17][fi]
        P["wag"] = [.6, -.5, .2, -1.0, 1.2, .0][fi]; P["ear"] = [.3, -.3, -.5, -.8, -.6, -.9][fi]
        P["eyes"] = ["dizzy", "dizzy", "ouch", "x", "x", "x"][fi]; P["tongue"] = fi >= 3; P["stars"] = [3, 2, 1, 0, 0, 0][fi]; P["mouth"] = fi == 2
        return P
    if anim == "graze":    # head down to the grass, chewing (grass tuft in the mouth), ear flick, tail swish
        P["hdy"] = .14 + [0, .015, .03, .01][fi]; P["hdz"] = head_at(sp["hr"] * 1.15 + [0, .03, .01, .04][fi], 0)
        P["z"] = [0, .006, .012, .004][fi]; P["wag"] = [-.5, .2, .7, -.1][fi]; P["ear"] = [0, .35, -.1, .2][fi]
        P["sw"] = [.04, .02, -.02, -.01]; P["eyes"] = ["open", "happy", "blink", "open"][fi]; P["mouth"] = fi in (1, 3); P["grass"] = fi in (0, 1, 3)
        return P
    if anim == "swim":     # moose swimming: only back, neck and head above the water, legs paddling under, ripple ring + splashes
        sink = -(bz0 + sp["rb"] - .14)
        P["z"] = sink + math.sin(t) * .025; P["fz"] = P["z"]; P["pitch"] = math.sin(t + .7) * .02
        P["hdz"] = .1 + math.sin(t + 1.2) * .03; P["hdy"] = .05
        for i, ph in enumerate((0, .5, .5, 0)):
            u = t + ph * 2 * math.pi; P["sw"][i] = math.sin(u) * leglen * .3; P["lift"][i] = max(0, math.cos(u)) * leglen * .25
        P["wag"] = math.sin(t) * .6; P["ear"] = [0, .2, .35, .1, -.15, -.05][fi]; P["eyes"] = ["open", "open", "happy", "open", "blink", "open"][fi]; P["mouth"] = fi in (2, 3)
        P["water"] = fi
        return P
    if anim == "idle":
        P["z"] = [0, .008, .016, .008][fi]; P["hdz"] = [0, .012, .02, .006][fi]; P["wag"] = [0, .6, 0, -.6][fi]
        P["ear"] = [0, .25, 0, -.15][fi]; P["eyes"] = "blink" if fi == 2 else "open"; P["mouth"] = fi == 1
    elif anim == "walk":   # lateral 4-beat: LH, LF, RH, RF
        ph = [.25, .75, 0.0, .5]; a = leglen * .24
        for i in range(4):
            u = t + ph[i] * 2 * math.pi; P["sw"][i] = math.sin(u) * a; P["lift"][i] = max(0, math.cos(u)) * leglen * .16
        P["z"] = abs(math.sin(2 * t)) * .02; P["hdz"] = -math.sin(2 * t) * .03; P["wag"] = math.sin(t) * .5; P["flow"] = .15
    else:                  # transverse gallop: BL, BR, FL, FR with a suspension phase
        ph = [.47, .58, 0.0, .1]; a = leglen * .42
        for i in range(4):
            u = t + ph[i] * 2 * math.pi; P["sw"][i] = math.sin(u) * a; P["lift"][i] = max(0, math.cos(u)) * leglen * .34
        P["z"] = max(0, math.sin(t - .6)) * .09 + .02; P["pitch"] = math.sin(t + .4) * .06
        P["hdz"] = math.sin(t + 1.4) * .05; P["hdy"] = .03; P["wag"] = .9 + .3 * math.sin(t); P["ear"] = -.55; P["flow"] = .75 + .2 * math.sin(t)
        P["eyes"] = "happy" if fi in (2, 3) else "open"; P["mouth"] = fi in (1, 2)
    return P

# ---------------------------------------------------------------- small drawing helpers
def circ(c, r, ry=None, rot=0.0, wob=0.03, seed=0): return ellipse_pts(c[0], c[1], r, ry if ry is not None else r, rot, wob=wob, seed=seed)

def hull(pts):
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) < 3: return pts
    cr = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cr(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]

def eye(cv, p, r, mode, k):
    ink = ramp("ink")
    if mode == "x":       # cartoon knocked-out X eyes
        w = r * .85
        for sgn in (-1, 1): cv.line([(p[0] - w, p[1] - w * sgn), (p[0] + w, p[1] + w * sgn)], ink[3], max(.6 * k, r * .32))
        return
    if mode == "ouch":    # squeezed > < eyes
        w = r * .85
        cv.line([(p[0] - w, p[1] - w * .7), (p[0] + w * .3, p[1]), (p[0] - w, p[1] + w * .7)], ink[3], max(.6 * k, r * .3))
        return
    if mode == "dizzy":   # swirly ring + dot
        cv.line([(p[0] + r * .8 * math.cos(a / 3), p[1] + r * .8 * math.sin(a / 3)) for a in range(0, 19)], ink[3], max(.5 * k, r * .25))
        cv.fill(circ(p, r * .25, r * .25, wob=0), ink[3])
        return
    if mode == "open":
        cv.fill(circ(p, r * .82, r, wob=0), ink[3])
        cv.fill(circ((p[0] - r * .3, p[1] - r * .38), r * .36, r * .36, wob=0), (255, 255, 255))
        cv.fill(circ((p[0] + r * .28, p[1] + r * .34), r * .16, r * .16, wob=0), (255, 255, 255))
    else:
        w = r * .9; dy = -.45 * w if mode == "happy" else .3 * w
        cv.line([(p[0] - w, p[1]), (p[0], p[1] + dy), (p[0] + w, p[1])], ink[3], max(.6 * k, r * .3))

# ---------------------------------------------------------------- the mount
class Mount:
    def __init__(self, species, d, anim, fi, k=1):
        self.s = species; self.sp = sp = SPEC[species]; self.d, self.anim, self.fi, self.k = d, anim, fi, k
        W, H, feet = canvas_size(sp); self.W, self.H, self.feet = W, H, feet
        self.G = G = PX_PER_M * k
        self.seed = zlib.crc32(f"mount_{species}".encode()) % 997 + fi * 3 + d * 17 + ord(anim[0])
        self.rig = Rig(None, DIR8_PHI[d], W * k / 2, feet * k, G)
        self.P = params(anim, fi, sp); self.items = []
        self.build()

    # geometry -------------------------------------------------------
    def zc(self, y):   # body centre-line height at body-local y
        sp, P = self.sp, self.P; L = sp["L"]; t = (y + L / 2) / L
        return self.bz - P["pitch"] + 2 * P["pitch"] * t
    def proj(self, x, y, z): return self.rig.proj(x, y, z)
    def nv(self, x, y): return self.rig.nv(x, y)
    def add(self, depth, fn, tag): self.items.append((depth, len(self.items), fn, tag))

    def build(self):
        sp, P, k, G = self.sp, self.P, self.k, self.G
        rb, L = sp["rb"], sp["L"]
        self.bz = sp["wh"] - rb - sp.get("hump", 0) * .55 + P["z"]
        front, rear = (0, L / 2, self.zc(L / 2)), (0, -L / 2, self.zc(-L / 2))
        (fp, fv), (rp, rv) = self.proj(*front), self.proj(*rear)
        self.body_depth = (fv + rv) / 2
        self.fp, self.rp = fp, rp
        # seat: on the back a little behind the withers
        self.seat_y = L * .1; st = self.zc(self.seat_y) + rb + (.06 if sp.get("hump") else .05)
        (sp2, sv) = self.proj(0, self.seat_y, st); self.seat_px = sp2; self.seat_depth = sv
        # legs [FL, FR, BL, BR] (x side, y end)
        for i, (sx, fy) in enumerate([(-1, 1), (1, 1), (-1, -1), (1, -1)]):
            self.leg(i, sx, fy)
        self.tail()
        self.add(self.body_depth, self.body, "body")
        self.neck_head()

    def leg(self, i, sx, fy):
        sp, P, k, G = self.sp, self.P, self.k, self.G; rb, L = sp["rb"], sp["L"]
        hy = fy * L / 2 * .92; hipz = self.zc(hy) - rb * .25
        hip = (sx * sp["lx"], hy, hipz + rb * .1)
        foot = (sx * (sp["lx"] * 1.05 + P["spread"][i]), hy + P["sw"][i], .035 + P["lift"][i] + P["fz"])
        mid = [(a + b) / 2 for a, b in zip(hip, foot)]
        bend = (P["lift"][i] * 1.1 + .02) * (1 if fy > 0 else -1)
        knee = (mid[0], mid[1] + bend, mid[2] + .02)
        (hp, hv), (kp, kv), (fp, fv) = self.proj(*hip), self.proj(*knee), self.proj(*foot)
        dep = self.body_depth - .05 * G + ((hv + fv) / 2) * .001
        if P["spread"][i] > .2 and self.nv(sx, 0) > .3: dep = self.body_depth + .05 * G   # splayed near legs lie in front of the barrel
        lw = sp["lw"] * G; furc = sp["leg"]; dark = sx < 0
        def draw(cv):
            base = ramp(furc)[2] if dark else None
            cv.part(capsule_pts(hp[0], hp[1], kp[0], kp[1], lw * 1.35, lw * 1.05), furc, lw=1.0 * k, shade=.3, hl=.14, base_col=base)
            m = cv.part(capsule_pts(kp[0], kp[1], fp[0], fp[1] - lw * .3, lw * 1.0, lw * .85), furc, lw=1.0 * k, shade=.3, hl=.14, base_col=base)
            if sp.get("sock"):
                (sk, _) = self.proj(*[a + (b - a) * .6 for a, b in zip(knee, foot)])
                cv.part(capsule_pts(sk[0], sk[1], fp[0], fp[1] - lw * .3, lw * 1.0, lw * .9), sp["sock"], lw=1.0 * k, shade=.3, hl=.12)
            cv.part(circ((fp[0], fp[1] - lw * .1), lw * 1.15, lw * .78, wob=.02), sp["hoof"], lw=.9 * k, shade=.3, hl=.2)
        self.add(dep, draw, "leg")

    def tail(self):
        sp, P, k, G = self.sp, self.P, self.k, self.G; rb, L = sp["rb"], sp["L"]; kind, tl = sp["tail"]
        root = (0, -L / 2 - rb * .78, self.zc(-L / 2) + rb * .45)
        (tp, tv) = self.proj(*root); w = P["wag"]; fl = P["flow"]
        def draw(cv):
            if kind == "horse" or kind == "plume":
                pts3 = [root]
                for j in range(1, 6):
                    u = j / 5; pts3.append((w * .06 * u * u, root[1] - tl * (.18 + fl * .55) * u, root[2] - tl * (1 - fl * .6) * u * .95 + .04 * math.sin(u * 3)))
                P2 = [self.proj(*p)[0] for p in pts3]
                col = sp.get("mane") or sp["fur"]
                for j, (a, b) in enumerate(zip(P2, P2[1:])):
                    r0 = G * (.045 + .03 * j) * (1.3 if kind == "plume" else 1); r1 = G * (.06 + .03 * j) * (1.3 if kind == "plume" else 1)
                    cv.part(capsule_pts(a[0], a[1], b[0], b[1], r0, r1), col, lw=.95 * k, shade=.28, hl=.16)
            elif kind == "tuft":
                end = (w * .05, root[1] - tl * (.12 + fl * .4), root[2] - tl * (1 - fl * .5))
                (ep, _) = self.proj(*end)
                cv.line([tp, ep], ramp(sp["fur"])[3], max(1.2 * k, .04 * G)); cv.line([tp, ep], ramp(sp["fur"])[1], max(.6 * k, .02 * G))
                cv.part(circ(ep, .05 * G, .08 * G, wob=.12), sp.get("mane", "fur_black"), lw=.8 * k, shade=.3, hl=.15)
            elif kind == "puff":
                cv.part(circ(tp, .09 * G, .08 * G, wob=.15), "snow", lw=.9 * k, shade=.25, hl=.2)
            else:
                cv.part(circ(tp, .07 * G, .06 * G, wob=.1), sp["fur"], lw=.9 * k, shade=.3, hl=.15)
        self.add(tv, draw, "tail")

    def body(self, cv):
        sp, P, k, G = self.sp, self.P, self.k, self.G; rb, L = sp["rb"], sp["L"]; fp, rp = self.fp, self.rp
        m = cv.part(capsule_pts(rp[0], rp[1], fp[0], fp[1], rb * G, rb * G * 1.04), sp["fur"], lw=1.05 * k, shade=.24, hl=.15)
        self.body_mask = m
        (bp, _) = self.proj(0, 0, self.zc(0) - rb * .62)
        if sp["belly"] != sp["fur"]: cv.fill(circ(bp, (L * .5 + rb * .5) * G, rb * .42 * G, wob=.05), ramp(sp["belly"])[1], clip=m)
        if sp.get("rump"):
            (rp2, _) = self.proj(0, -L / 2 - rb * .45, self.zc(-L / 2) + rb * .1)
            cv.fill(circ(rp2, rb * .7 * G, rb * .6 * G, wob=.08, seed=3), ramp(sp["rump"])[1], clip=m)
        if sp.get("spots"):
            for (sx, sy) in [(-.12, -.22), (.14, -.08), (-.04, .1), (.08, -.3), (-.15, .02), (.12, .18)]:
                (s, _) = self.proj(sx, sy * L / .74 * .9, self.zc(sy) + rb * .78)
                cv.fill(circ(s, .028 * G, .022 * G, wob=0), ramp(sp["spots"])[0], clip=m)
        if sp.get("cross"):   # donkey dorsal stripe + shoulder cross
            a = self.proj(0, -L / 2 - rb * .5, self.zc(-L / 2) + rb * .98)[0]; b = self.proj(0, L / 2 + rb * .2, self.zc(L / 2) + rb * .98)[0]
            cv.line([a, b], ramp(sp["cross"])[2], max(1.0 * k, .035 * G), clip=m)
            for side in (-1, 1):
                if self.nv(side, 0) > -.3:
                    c0 = self.proj(0, L * .36, self.zc(L * .36) + rb * .98)[0]; c1 = self.proj(side * rb * .85, L * .38, self.zc(L * .38) + rb * .45)[0]
                    cv.line([c0, c1], ramp(sp["cross"])[2], max(1.0 * k, .03 * G), clip=m)
        if sp.get("shag"):
            (s, _) = self.proj(0, L * .38, self.zc(L * .38) + rb * .15)
            cv.part(circ(s, rb * 1.12 * G, rb * 1.12 * G, wob=.14, seed=5), sp["shag"], lw=.95 * k, shade=.25, hl=.12, clip=None if sp.get("hump") else m)
        if sp.get("hump"):
            (s, _) = self.proj(0, L * .3, self.zc(L * .3) + rb * .78)
            cv.part(circ(s, rb * .82 * G, (rb * .5 + sp["hump"] * .8) * G, wob=.08, seed=2), sp.get("shag", sp["fur"]), lw=1.0 * k, shade=.25, hl=.14)
        if sp.get("skirt"):   # yak: long fringe hanging under the barrel
            for side in (-1, 1):
                if self.nv(side, 0) < -.55: continue
                for j in range(9):
                    y = -L / 2 + j * L / 8
                    a = self.proj(side * rb * .7, y, self.zc(y) - rb * .1)[0]; b = self.proj(side * rb * .8, y + (.03 if j % 2 else -.02), self.zc(y) - rb * 1.55 - (.04 if j % 2 else 0))[0]
                    cv.part(capsule_pts(a[0], a[1], b[0], b[1], .09 * G, .05 * G), sp["skirt"], lw=.9 * k, shade=.3, hl=.1)

    def neck_head(self):
        sp, P, k, G = self.sp, self.P, self.k, self.G; rb, L = sp["rb"], sp["L"]
        nb3 = (0, L / 2 + rb * .1, self.zc(L / 2) + rb * .35)
        hc3 = (0, L / 2 + sp["neck"][0] + P["hdy"], sp["wh"] + sp["neck"][1] + P["hdz"] + P["z"] - P["pitch"] * .5)
        (nb, nv), (hc, hv) = self.proj(*nb3), self.proj(*hc3)
        hr = sp["hr"]; fwd = self.nv(0, 1); self.hc3 = hc3
        sn3 = (0, hc3[1] + sp["face"][0], hc3[2] - sp["face"][1]); (snp, snv) = self.proj(*sn3)
        def neck(cv):
            cv.part(capsule_pts(nb[0], nb[1], hc[0], hc[1], sp["nw"] * 1.25 * G, sp["nw"] * .9 * G), sp["fur"], lw=1.0 * k, shade=.24, hl=.14)
            if sp.get("bell"):
                (bp, _) = self.proj(0, hc3[1] - hr * .2, hc3[2] - hr * 1.5)
                cv.part(circ(bp, .05 * G, .13 * G, wob=.1), sp["bell"], lw=.85 * k, shade=.3, hl=.15)
        self.add((nv + hv) / 2 - .02 * G, neck, "neck")
        if sp.get("mane"):
            def mane(cv):
                n = 7; pts = []
                for j in range(n + 1):
                    u = j / n; p = [nb3[i] + (hc3[i] - nb3[i]) * u for i in range(3)]
                    p = (p[0], p[1] - sp["nw"] * .55, p[2] + sp["nw"] * (1.05 - .2 * u))
                    pts.append(p)
                if sp["mane_kind"] == "flow":
                    for j, p in enumerate(pts[:-1]):
                        tip = (P["wag"] * .02, p[1] - .1 - P["flow"] * .14, p[2] - .05 + P["flow"] * .05 - (.06 if j % 2 else 0))
                        a, b = self.proj(*p)[0], self.proj(*tip)[0]
                        cv.part(capsule_pts(a[0], a[1], b[0], b[1], .055 * G, .028 * G), sp["mane"], lw=.9 * k, shade=.28, hl=.18)
                    fa = self.proj(hc3[0], hc3[1] + hr * .55, hc3[2] + hr * .75)[0]; fb = self.proj(hc3[0], hc3[1] + hr * .95, hc3[2] + hr * .1)[0]
                    if fwd > -.5: cv.part(capsule_pts(fa[0], fa[1], fb[0], fb[1], .05 * G, .03 * G), sp["mane"], lw=.85 * k, shade=.28, hl=.18)
                else:   # brush mane: short upright crest
                    P2 = [self.proj(*p)[0] for p in pts]; P3 = [self.proj(p[0], p[1], p[2] + .07)[0] for p in pts]
                    cv.part(hull(P2 + P3), sp["mane"], lw=.9 * k, shade=.25, hl=.15)
            self.add((nv + hv) / 2 - .01 * G, mane, "mane")
        def ears(cv, front):
            kind, el = sp["ears"]; a = P["ear"]
            for side in (-1, 1):
                if kind == "donkey":   base = (side * hr * .45, hc3[1] - hr * .3, hc3[2] + hr * .7); tip = (side * (hr * .7 + a * .05), hc3[1] - hr * .5 - a * .1, hc3[2] + hr * .7 + el * (1 - abs(a) * .3))
                elif kind == "pointy": base = (side * hr * .45, hc3[1] - hr * .35, hc3[2] + hr * .75); tip = (side * hr * .55, hc3[1] - hr * .3 - a * .06, hc3[2] + hr * .75 + el * (1 - abs(a) * .3))
                elif kind == "deer":   base = (side * hr * .7, hc3[1] - hr * .3, hc3[2] + hr * .5); tip = (side * (hr + el * .9), hc3[1] - hr * .4, hc3[2] + hr * .6 + el * .25 - a * .05)
                else:                  base = (side * hr * .8, hc3[1] - hr * .2, hc3[2] + hr * .35); tip = (side * (hr + el), hc3[1] - hr * .2, hc3[2] + hr * .4)
                (bp, bv), (tp, _) = self.proj(*base), self.proj(*tip)
                if (bv < hv) != front: continue
                wbase = (.06 if kind == "donkey" else .045 if kind != "small" else .04) * G
                cv.part(capsule_pts(bp[0], bp[1], tp[0], tp[1], wbase * .8, wbase * 1.1), sp.get("face_c", sp["fur"]) if sp.get("face_c") != "snow" else sp["fur"], lw=.9 * k, shade=.25, hl=.15)
                if fwd > -.2 and kind != "small":
                    cv.part(capsule_pts(bp[0], bp[1], tp[0], tp[1] + wbase * .3, wbase * .3, wbase * .55), "flower_pink", outline=False, flat=True)
                if kind == "donkey":
                    cv.fill(circ(tp, wbase * .9, wbase * .9, wob=0), ramp("fur_black")[2])
        def antlers(cv):
            kind = sp["antlers"]; col = ramp("horn") if kind == "palm" else ramp("wood")
            for side in (-1, 1):
                b = (side * hr * .35, hc3[1] - hr * .4, hc3[2] + hr * .8)
                if kind == "palm":
                    p = (side * (hr + .3), hc3[1] - hr * .5, hc3[2] + hr * .85 + .08)
                    (bp, _), (pp, _) = self.proj(*b), self.proj(*p)
                    cv.line([bp, pp], ramp("wood")[3], max(1.6 * k, .05 * G))
                    cv.part(circ(pp, .26 * G, .13 * G, rot=-side * .3 if self.nv(1, 0) > -2 else 0, wob=.1, seed=side + 3), "horn", lw=.95 * k, shade=.28, hl=.15)
                    for j in range(5):
                        q = self.proj(side * (hr + .3 + (j - 2) * .1), hc3[1] - hr * .5, hc3[2] + hr * .85 + .21 - abs(j - 2) * .03)[0]
                        cv.part(circ(q, .035 * G, .06 * G, wob=0), "horn", lw=.6 * k, shade=.3, hl=.2)
                    continue
                g = 1.45 if kind == "big" else 1.0
                pts3 = [b, (side * .12 * g, hc3[1] - hr * .6, hc3[2] + hr + .16 * g), (side * .2 * g, hc3[1] - hr * .9, hc3[2] + hr + .34 * g)]
                tines = [((side * .12 * g, hc3[1] - hr * .6, hc3[2] + hr + .16 * g), (side * .09 * g, hc3[1] + .02, hc3[2] + hr + .29 * g)),
                         ((side * .17 * g, hc3[1] - hr * .8, hc3[2] + hr + .26 * g), (side * .27 * g, hc3[1] - hr * .6, hc3[2] + hr + .33 * g))]
                if kind == "big": tines.append(((side * .07, hc3[1] - hr * .5, hc3[2] + hr + .08), (side * .05, hc3[1] + .06, hc3[2] + hr + .16)))
                P2 = [self.proj(*p)[0] for p in pts3]
                for w, c in ((max(2.0 * k, .05 * G), col[3]), (max(1.0 * k, .025 * G), col[1])):
                    cv.line(P2, c, w)
                    for a3, b3 in tines: cv.line([self.proj(*a3)[0], self.proj(*b3)[0]], c, w)
        def horns(cv):
            c = ramp("horn")
            for side in (-1, 1):
                if sp["horns"] == "yak": pts3 = [(side * hr * .8, hc3[1] - hr * .1, hc3[2] + hr * .45), (side * (hr + .16), hc3[1] + .02, hc3[2] + hr * .55), (side * (hr + .22), hc3[1] + .05, hc3[2] + hr + .14), (side * (hr + .14), hc3[1] + .02, hc3[2] + hr + .26)]
                else: pts3 = [(side * hr * .8, hc3[1] - hr * .1, hc3[2] + hr * .45), (side * (hr + .08), hc3[1] + .01, hc3[2] + hr * .6), (side * (hr + .1), hc3[1] + .03, hc3[2] + hr * .95)]
                P2 = [self.proj(*p)[0] for p in pts3]
                cv.line(P2, c[3], max(2.4 * k, .06 * G)); cv.line(P2, c[1], max(1.3 * k, .035 * G))
        def snout(cv):
            r = sp["face"][2] * G
            a = self.proj(0, hc3[1] + sp["hr"] * .3, hc3[2] - sp["hr"] * .1)[0]
            cv.part(capsule_pts(a[0], a[1], snp[0], snp[1], sp["hr"] * .72 * G, r * .95), sp.get("face_c", sp["fur"]), lw=.95 * k, shade=.22, hl=.14)
            cv.part(circ(snp, r, r * .8, wob=.02), sp["muzzle"], lw=.9 * k, shade=.22, hl=.16)
            if fwd > -.1:
                for side in (-1, 1):
                    (np_, _) = self.proj(side * r / G * .4, sn3[1] + r / G * .7, sn3[2] + r / G * .15)
                    cv.fill(circ(np_, r * .16, r * .12, wob=0), ramp("ink")[3])
                if P["tongue"]:
                    (mp, _) = self.proj(0, sn3[1] + r / G * .5, sn3[2] - r / G * .55)
                    cv.part(circ((mp[0] + r * .15, mp[1] + r * .3), r * .3, r * .42, wob=0), "flower_pink", lw=.7 * k, shade=.25, hl=.2)
                if P["grass"]:
                    (mp, _) = self.proj(0, sn3[1] + r / G * .6, sn3[2] - r / G * .45)
                    for j, (dx, dy) in enumerate(((-.5, .9), (0, 1.1), (.55, .85))):
                        cv.line([mp, (mp[0] + dx * r * (1 + .2 * self.fi), mp[1] + dy * r)], ramp("leaf")[3], max(1.4 * k, r * .22))
                        cv.line([mp, (mp[0] + dx * r * (1 + .2 * self.fi), mp[1] + dy * r)], ramp("leaf")[1], max(.7 * k, r * .11))
                if P["mouth"]:
                    (mp, _) = self.proj(0, sn3[1] + r / G * .55, sn3[2] - r / G * .5)
                    cv.line([(mp[0] - r * .35, mp[1] - r * .05), (mp[0], mp[1] + r * .18), (mp[0] + r * .35, mp[1] - r * .05)], ramp("ink")[3], max(.6 * k, r * .1))
        def head(cv):
            if sp.get("antlers") and fwd < 0: antlers(cv)
            if sp.get("horns") and fwd < 0: horns(cv)
            ears(cv, True)
            if sp.get("beard"):
                (bp, _) = self.proj(0, hc3[1] + hr * .3, hc3[2] - hr * 1.1)
                cv.part([(bp[0] - .07 * G, bp[1] - .1 * G), (bp[0] + .07 * G, bp[1] - .1 * G), (bp[0], bp[1] + .14 * G)], sp["beard"], lw=.8 * k, shade=.3, hl=.15)
            if snv < hv: snout(cv)
            facec = sp.get("face_c", sp["fur"])
            m = cv.part(circ(hc, hr * G, hr * .95 * G, wob=.04), facec, lw=1.0 * k, shade=.22, hl=.16)
            if snv >= hv: snout(cv)
            if sp.get("facepatch") and fwd > -.3:
                (fc, _) = self.proj(0, hc3[1] + hr * .55, hc3[2] + hr * .05)
                cv.fill(circ(fc, hr * .62 * G, hr * .7 * G, wob=.08, seed=4), ramp(sp["facepatch"])[1], clip=m)
            if sp.get("blaze") and fwd > -.3:
                a = self.proj(0, hc3[1] + hr * .75, hc3[2] + hr * .55)[0]; b = self.proj(0, sn3[1] - sp["face"][2] * .3, sn3[2] + sp["face"][2] * .5)[0]
                cv.line([a, b], ramp(sp["blaze"])[1], max(1.2 * k, .05 * G))
            if fwd > -.35:
                for side in (-1, 1):
                    an = math.radians(side * 42); vis = self.nv(math.sin(an), math.cos(an))
                    if vis > .05:
                        p3 = (hr * .9 * math.sin(an), hc3[1] + hr * .9 * math.cos(an), hc3[2] + hr * .22)
                        (ep, _) = self.proj(*p3); r = hr * sp["eye"] * G * max(.6, vis) * .78
                        if sp.get("eyering"): cv.fill(circ(ep, r * 1.45, r * 1.5, wob=0), ramp(sp["eyering"])[1])
                        eye(cv, ep, r, P["eyes"], k)
                        (cp, _) = self.proj(hr * .95 * math.sin(an) * 1.02, hc3[1] + hr * .72 * math.cos(an), hc3[2] - hr * .3)
                        cv.fill(circ(cp, r * 1.0, r * .55, wob=0), ramp("flower_pink")[1], alpha=255)
            ears(cv, False)
            for j in range(P["stars"]):   # cartoon impact stars circling the head
                a = self.fi * 1.3 + j * 2 * math.pi / max(1, P["stars"])
                (q, _) = self.proj(math.cos(a) * hr * 1.3, hc3[1] + math.sin(a) * hr * 1.3, hc3[2] + hr * 1.35)
                rr = .045 * G; pts = [(q[0] + rr * (1 if m % 2 == 0 else .45) * math.cos(m * math.pi / 5 - math.pi / 2), q[1] + rr * (1 if m % 2 == 0 else .45) * math.sin(m * math.pi / 5 - math.pi / 2)) for m in range(10)]
                cv.part(pts, "gold" if "gold" in palette.RAMPS else "sun", lw=.6 * k, shade=.2, hl=.2)
            if sp.get("antlers") and fwd >= 0: antlers(cv)
            if sp.get("horns") and fwd >= 0: horns(cv)
        self.add(max(hv, snv) + .01 * G, head, "head")

    # saddle ---------------------------------------------------------
    def saddle_items(self, tier):
        """saddle parts as rig items (depth just above the body)."""
        sp, P, k, G = self.sp, self.P, self.k, self.G; rb, L = sp["rb"], sp["L"]; ys = self.seat_y
        dep = self.body_depth + .001 * G
        def cyl(a_deg, y, r=1.0, dz=0.0):
            a = math.radians(a_deg); return self.proj(rb * r * math.sin(a), y, self.zc(y) + rb * r * math.cos(a) + dz)[0]
        def vis_side(side): return self.nv(side, 0) > -.35
        spec = {"leather": dict(pad=(-.26, .22, 62), blanket="blanket_r", seat="saddle_lt", cant=.05, pom=.04),
                "reinforced": dict(pad=(-.3, .26, 72), blanket="blanket_g", seat="saddle_dk", cant=.09, pom=.07),
                "iron": dict(pad=(-.3, .27, 74), blanket="blanket_b", seat="saddle_dk", cant=.13, pom=.1),
                "steel": dict(pad=(-.33, .28, 80), blanket="blanket_p", seat="saddle_lt", cant=.17, pom=.12)}[tier]
        y0, y1, amax = spec["pad"]; y0 *= L / .9; y1 *= L / .9; y0 += ys; y1 += ys
        def pad(cv):
            m = self.body_mask
            pts = [cyl(a, y, 1.06) for a in np.linspace(-amax, amax, 13) for y in (y0, y1)]
            if tier == "leather":   # rounded blanket corners
                pts = [cyl(a, y0 + (y1 - y0) * (.5 + .5 * math.cos(t)), 1.06) for t in np.linspace(0, math.pi, 7) for a in (-amax * math.sin(t) ** .5, amax * math.sin(t) ** .5)]
            pm = cv.part(hull(pts), spec["blanket"], lw=.9 * k, shade=.25, hl=.12, clip=None)
            if tier == "leather":
                cv.line([cyl(a, y0 + (y1 - y0) * .15, 1.07) for a in np.linspace(-amax * .8, amax * .8, 9)], ramp("cloth_cream")[1], max(.7 * k, .02 * G), clip=pm)
            if tier == "reinforced":   # dashed stitch border
                for y in (y0 + .03, y1 - .03):
                    for a in np.linspace(-amax * .85, amax * .85, 9):
                        p = cyl(a, y, 1.07); cv.fill(circ(p, .012 * G + .3 * k, .009 * G + .3 * k, wob=0), ramp("cloth_cream")[0], clip=pm)
            if tier in ("iron", "steel"):   # trim band along the pad edge
                c = "iron" if tier == "iron" else "gold"
                for y in (y0, y1): cv.line([cyl(a, y, 1.07) for a in np.linspace(-amax, amax, 11)], ramp(c)[2], max(1.0 * k, .03 * G), clip=pm)
        def girth(cv):
            yg = ys + L * .05; pts = [cyl(a, yg, 1.03) for a in np.linspace(-120, 120, 25) if self.nv(math.sin(math.radians(a)), 0) > -.25 or abs(a) < 60]
            c = {"leather": "saddle_dk", "reinforced": "saddle_dk", "iron": "iron", "steel": "steel"}[tier]
            cv.line(pts, ramp(c)[3], max(2.0 * k, .07 * G), clip=self.body_mask); cv.line(pts, ramp(c)[1], max(1.2 * k, .045 * G), clip=self.body_mask)
            if tier != "leather":
                yg2 = ys - L * .1; pts2 = [cyl(a, yg2, 1.03) for a in np.linspace(-120, 120, 25) if self.nv(math.sin(math.radians(a)), 0) > -.25 or abs(a) < 60]
                cv.line(pts2, ramp(c)[3], max(1.8 * k, .06 * G), clip=self.body_mask); cv.line(pts2, ramp(c)[1], max(1.0 * k, .04 * G), clip=self.body_mask)
                for side in (-1, 1):
                    if vis_side(side):
                        b = cyl(side * 95, yg, 1.05); cv.part([(b[0] - .035 * G, b[1] - .04 * G), (b[0] + .035 * G, b[1] - .04 * G), (b[0] + .035 * G, b[1] + .04 * G), (b[0] - .035 * G, b[1] + .04 * G)], "gold" if tier == "steel" else "iron", lw=.6 * k, shade=.3, hl=.25)
        def flanks(cv):   # iron / steel side plates hanging below the pad (near sides only)
            if tier not in ("iron", "steel"): return
            for side in (-1, 1):
                if not vis_side(side): continue
                if tier == "iron":
                    pts = [cyl(side * a, y, 1.08, -dz) for a in (70, 100) for y, dz in ((y0 + .02, 0), (y1 - .02, 0))] + [cyl(side * 108, y, 1.08) for y in (y0 + .02, y1 - .02)]
                    pm = cv.part(hull(pts), "iron", lw=.9 * k, shade=.28, hl=.2)
                    for y in np.linspace(y0 + .06, y1 - .06, 4): cv.fill(circ(cyl(side * 100, y, 1.09), .016 * G + .3 * k, .016 * G + .3 * k, wob=0), ramp("iron")[3], clip=pm)
                else:
                    n = 3
                    for j in range(n):
                        ya, yb = y0 + (y1 - y0) * j / n, y0 + (y1 - y0) * (j + 1) / n; yc = (ya + yb) / 2
                        pts = [cyl(side * 70, ya, 1.08), cyl(side * 70, yb, 1.08), cyl(side * 100, yb, 1.08), cyl(side * 100, ya, 1.08), cyl(side * 118, yc, 1.08)]
                        pm = cv.part(hull(pts), "steel", lw=.9 * k, shade=.26, hl=.24)
                        cv.fill(circ(cyl(side * 104, yc, 1.09), .02 * G + .3 * k, .02 * G + .3 * k, wob=0), ramp("gold")[1], clip=pm)
        def seat(cv):
            sy0, sy1 = ys - L * .16, ys + L * .14
            pts = [cyl(a, y, 1.0, .03) for a in np.linspace(-42, 42, 7) for y in (sy0, sy1)]
            sm = cv.part(hull(pts), spec["seat"], lw=.95 * k, shade=.26, hl=.18)
            # cantle (back) and pommel (front) rise
            for y, hgt, wa in ((sy0, spec["cant"], 40), (sy1, spec["pom"], 22)):
                base = [cyl(a, y, 1.0, .03) for a in np.linspace(-wa, wa, 5)]
                top = [cyl(a * .8, y, 1.0, .03 + hgt) for a in np.linspace(-wa, wa, 5)]
                col = spec["seat"] if tier in ("leather", "reinforced") else ("iron" if tier == "iron" else "steel")
                cm = cv.part(hull(base + top), col, lw=.9 * k, shade=.26, hl=.2)
                if tier == "iron": cv.fill(circ(cyl(0, y, 1.0, .03 + hgt * .55), .016 * G + .3 * k, .016 * G + .3 * k, wob=0), ramp("iron")[3], clip=cm)
                if tier == "steel":
                    cv.line(top, ramp("gold")[1], max(1.0 * k, .025 * G), clip=cm)
            if tier == "steel":   # gem on the pommel + tiny pennant
                g = cyl(0, sy1, 1.0, .03 + spec["pom"] + .02); cv.part(circ(g, .03 * G + .4 * k, .03 * G + .4 * k, wob=0), "berry_blue", lw=.6 * k, shade=.25, hl=.35)
                pa = cyl(0, sy0 - .02, 1.0, .03 + spec["cant"]); pb = cyl(0, sy0 - .05, 1.0, .03 + spec["cant"] + .26)
                cv.line([pa, pb], ramp("wood_dark")[2], max(1.0 * k, .025 * G))
                cv.part([pb, (pb[0] + .02 * G, pb[1] + .05 * G), (pb[0] - .14 * G * (1 if self.nv(1, 0) >= 0 else -1), pb[1] + .03 * G + P["flow"] * .02 * G)], "cloth_red", lw=.6 * k, shade=.2, hl=.2)
            if tier == "reinforced":   # saddlebags behind the cantle
                for side in (-1, 1):
                    if not vis_side(side): continue
                    yb = sy0 - .05; pts = [cyl(side * 60, yb - .06, 1.1), cyl(side * 60, yb + .05, 1.1), cyl(side * 105, yb + .05, 1.12), cyl(side * 105, yb - .06, 1.12)]
                    bm = cv.part(hull(pts), "saddle_lt", lw=.85 * k, shade=.28, hl=.16)
                    cv.fill(circ(cyl(side * 72, yb, 1.13), .018 * G + .3 * k, .022 * G + .3 * k, wob=0), ramp("gold")[2], clip=bm)
            if tier in ("leather", "reinforced"):
                cv.line([cyl(a, (sy0 + sy1) / 2, 1.0, .035) for a in np.linspace(-30, 30, 5)], ramp(spec["seat"])[3], max(.6 * k, .015 * G), clip=sm)
        return [(dep, pad, "saddle"), (dep + .0002 * G, girth, "saddle"), (dep + .0004 * G, flanks, "saddle"), (dep + .0006 * G, seat, "saddle")]

    # render ---------------------------------------------------------
    def canvas(self):
        return Canvas(self.W * self.k, self.H * self.k, seed=self.seed)

    def draw(self, mode="full"):
        """mode: full | fore | saddle:<tier>. Returns an RGBA PIL image (binary alpha)."""
        items = list(self.items)
        thr = self.seat_depth + .02 * self.G
        if mode == "full": sel = items
        elif mode == "fore": sel = [it for it in items if it[3] not in ("body",) and it[0] > thr]
        else:
            tier = mode.split(":")[1]
            sel = [it for it in items if it[3] == "body"]
            sel += [(d, 10 ** 6 + i, f, t) for i, (d, f, t) in enumerate(self.saddle_items(tier))]
        cv = self.canvas()
        for d, _, fn, tag in sorted(sel, key=lambda t: (t[0], t[1])):
            if mode.startswith("saddle") and tag == "body":
                self.body_mask = cv.mask_from(capsule_pts(self.rp[0], self.rp[1], self.fp[0], self.fp[1], self.sp["rb"] * self.G, self.sp["rb"] * self.G * 1.04))
                continue
            fn(cv)
        im = cv.final()
        a = np.asarray(im).copy(); a[..., 3] = np.where(a[..., 3] >= 128, 255, 0); a[a[..., 3] == 0] = 0
        if self.P["water"] is not None: a = self.water(a, mode == "full")
        return a

    # swimming: the water surface (z = 0) hides everything below the near edge of the body/water intersection
    def water_outline(self, grow=1.0):
        sp = self.sp; rb, L = sp["rb"], sp["L"]; rx, ry = rb * 1.02 * grow, (L / 2 + rb * .85) * grow
        return [self.proj(rx * math.cos(u), ry * math.sin(u) + .02, 0.0)[0] for u in np.linspace(0, 2 * math.pi, 96, endpoint=False)]

    def waterline(self, shape):
        from PIL import ImageDraw
        H, W = shape[:2]; m = Image.new("L", (W, H), 0); ImageDraw.Draw(m).polygon(self.water_outline(), fill=255)
        E = np.asarray(m) > 0; rows = np.arange(H)[:, None]
        wl = np.where(E.any(0), np.where(E, rows, -1).max(0), int(round(self.proj(0, 0, 0)[0][1])))
        return wl

    def water(self, a, ripple):
        H, W = a.shape[:2]; k = self.k; wl = self.waterline(a.shape)
        below = np.arange(H)[:, None] > wl[None, :]
        a = a.copy(); a[below] = 0
        if not ripple: return a
        from PIL import ImageDraw
        fi = self.fi; cy = self.proj(0, 0, 0)[0][1]
        ring = Image.new("L", (W, H), 0); dr = ImageDraw.Draw(ring)
        for grow, w in ((1.06 + .05 * math.sin(fi * math.pi / 3), 2.2), (1.32 + .1 * ((fi % 6) / 6), 1.5)):
            pts = self.water_outline(grow); dr.line(pts + pts[:1], fill=255, width=max(1, int(round(w * k))))
        R = np.asarray(ring) > 0
        rows = np.arange(H)[:, None]
        R &= (rows >= cy) | (a[..., 3] == 0)          # far half of the ring stays behind the visible animal
        lt, dk = (189, 242, 240), (58, 156, 204)   # palette "water" highlight / dark
        from scipy.ndimage import binary_dilation
        edge = binary_dilation(R, iterations=max(1, k)) & ~R & ((rows >= cy) | (a[..., 3] == 0))
        a[edge] = (*dk, 255); a[R] = (*lt, 255)
        # splash droplets around the chest, positions change every frame
        rng = np.random.default_rng(zlib.crc32(f"swim{self.s}{self.d}{fi}".encode()))
        pts = self.water_outline(1.15)
        for j in rng.choice(len(pts), 5, replace=False):
            x, y = pts[j]; y -= (2 + rng.random() * 4) * k * (1 + .5 * math.sin(fi + j))
            r = (1.0 + rng.random() * .8) * k; xi, yi = np.ogrid[:H, :W]
            d = (xi - y) ** 2 + (yi - x) ** 2
            yy, xx = min(H - 1, max(0, int(y))), min(W - 1, max(0, int(x)))
            if yy < cy and a[yy, xx, 3] > 0: continue      # never splash over the visible animal behind the ring
            a[d <= (r + k) ** 2] = (*dk, 255); a[d <= r ** 2] = (*lt, 255)
        return a

    def seat_anchor(self):
        """seat point (1x px) relative to the mount pivot; +x right, +y down."""
        return (round((self.seat_px[0] - self.W * self.k / 2) / self.k, 2), round((self.seat_px[1] - self.feet * self.k) / self.k, 2))

def render_frame(species, d, anim, fi):
    """-> dict(full=[a1,a2], fore=[..], saddle_<tier>=[..], seat=(x,y)) with numpy RGBA arrays at 1x and @2x."""
    out = {}
    for k in (1, 2):
        m = Mount(species, d, anim, fi, k)
        full = m.draw("full"); fore = m.draw("fore")
        out.setdefault("full", []).append(full); out.setdefault("fore", []).append(fore)
        occ = fore[..., 3] > 0
        for t in TIERS:
            s = m.draw("saddle:" + t); s[occ] = 0; out.setdefault("saddle_" + t, []).append(s)
        if k == 1:
            out["seat"] = m.seat_anchor(); out["size"] = (m.W, m.H, m.feet)
            if m.P["water"] is not None:   # rider clip line: water surface row at the seat column, px from the pivot
                wl = m.waterline((m.H, m.W)); cx = int(round(m.seat_px[0])); out["water"] = round(float(wl[min(m.W - 1, max(0, cx))]) - m.feet, 2)
    return out
