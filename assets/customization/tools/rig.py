"""Shared body keypoints + layer renderer for the paper-doll customization system.
Every part (body, hair, hats, clothes, face, eyes) is rendered from the SAME pose() keypoints per
(body type, facing, anim, frame), so layers line up frame-perfectly. Deterministic (fixed seeds, no RNG state)."""
import sys, math, numpy as np
import os
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools"))  # repo assets/tools (toon/palette/chars); appended so customization/tools/build_all wins
from PIL import Image, ImageDraw, ImageFilter
from toon import Canvas, ellipse_pts, capsule_pts, SS, downscale
from palette import ramp, hex2rgb
from chars import Rig, DIR_PHI

FW, FH, FEET = 48, 80, 74           # 1x frame, pivot at the feet (24,74) -> anchor (0.5, 0.925)
COLS, ROWS = 21, 12                  # 21*96 = 2016, 12*160 = 1920 at 2x (<= 2048)
PAD = 2
ANIMS = [("idle", 4, 4, True), ("walk", 6, 10, True), ("run", 6, 14, True), ("gather", 4, 8, True),
         ("attack", 4, 12, False), ("hit", 2, 10, False), ("death", 5, 8, False)]
NF = sum(a[1] for a in ANIMS)        # 31 frames per facing -> dirStride 31
ANIM_START = {}
_s = 0
for _a in ANIMS: ANIM_START[_a[0]] = _s; _s += _a[1]
# ADR-082 expressions: extra single-frame poses appended after the 8*31 block on face/eyes sheets only
EXPR_EXTRA = ["happy", "sleepy"]          # frame = 8*NF + d*len(EXPR_EXTRA) + i; blink/hurt reuse idle/hit frames
for _i, _n in enumerate(EXPR_EXTRA): ANIM_START[_n] = 8 * NF + _i
EXPR_SLOTS = ("face", "eyes")
SIT_N = 4                                 # sit (AnimState.Sit) frames per facing; packed as a separate block by tools/sit_merge.py
ANIM_START["sit"] = 8 * NF + 8 * len(EXPR_EXTRA)
# ADR-107 swim (AnimState.Swim = 14) + punch (AnimState.Punch = 15): separate blocks appended by tools/swim_punch_merge.py
SWIM_N, PUNCH_N = 6, 4                    # 6-frame paddle loop, 4-frame one-shot jab (own extra pages via dirFrames)
SWIM_Z = 17.0                             # world z of the waterline on the body (chest); merge sinks the frame so it sits at the pivot
ANIM_START["swim"] = ANIM_START["sit"] + 8 * SIT_N
NECK = 3.0                                # ADR-128 neck: body head drawn NECK 1x px higher (head layers shifted by the head anchor)
ANIM_START["punch"] = ANIM_START["swim"] + 8 * SWIM_N
# ADR-128 gathering / consume (AnimState harvest 16, chop 17, mine 18, drink 19, eat 14): own blocks, dirFrames only
GATHER = [("harvest", 6, 10, True), ("chop", 6, 12, True), ("mine", 6, 12, True), ("drink", 5, 8, False), ("eat", 5, 8, False)]
GATHER_N = {g[0]: g[1] for g in GATHER}
BLOCK_ANIMS = {"block": 3, "block_hit": 2}  # extra dirFrames; never part of the legacy 8x31 grid
# Mount riding (seated astride a saddle): frame i syncs 1:1 with mount idle/walk/gallop frame i (pack/mounts).
# The rider pivot stays (FW/2, FEET); body frames carry a frameMeta "seat" socket (1x px from the pivot) that the
# engine pins onto the mount's per-frame seat anchor (pack/mounts/mount_anchors.json). Far leg hidden behind the barrel.
RIDE_ANIMS = {"ride_idle": 4, "ride_walk": 6, "ride_gallop": 6}
RIDE_FPS = {"ride_idle": 4, "ride_walk": 8, "ride_gallop": 12}
HIT_N = 3                                 # ADR-134 hurt (AnimState.Hurt -> "hit"): 3 frames, dirFrames only (legacy grid block keeps 2)
_s, _n = ANIM_START["punch"], PUNCH_N
for _g in GATHER: _s += 8 * _n; ANIM_START[_g[0]] = _s; _n = _g[1]
for _name, _count in BLOCK_ANIMS.items():
    _s += 8 * _n; ANIM_START[_name] = _s; _n = _count
for _name, _count in RIDE_ANIMS.items():   # seed bases only (ride frames live on their own cz_ride_* pages)
    _s += 8 * _n; ANIM_START[_name] = _s; _n = _count
def rows_for(slot):
    n = 8 * NF + (8 * len(EXPR_EXTRA) if slot in EXPR_SLOTS else 0)
    return -(-n // COLS)
def frame_list(slot=None):
    out = []
    for d in range(8):
        for name, n, fps, loop in ANIMS:
            for fi in range(n): out.append((d, name, fi, n))
    if slot in EXPR_SLOTS:
        for d in range(8):
            for name in EXPR_EXTRA: out.append((d, name, 0, 1))
    return out  # index = d*31 + start + fi (+ expression block)

# neutral ramp for tinted regions (engine multiplies by palette colour through the tintmask)
NEU = [(255, 255, 255), (236, 230, 236), (196, 184, 204), (140, 122, 150)]
NEU_INK = (80, 57, 76)
BODY = {
    "male":   dict(shw=8.2, hipw=3.6, trx=8.1, try_=8.6, hr=11.5, arm=2.7, hand=2.9, leg=3.0, waist=1.0),
    "female": dict(shw=7.2, hipw=3.9, trx=7.5, try_=8.6, hr=11.5, arm=2.35, hand=2.6, leg=2.8, waist=0.92),
}

def pose(bt, d, anim, fi, n):
    B = BODY[bt]; ph = 2 * math.pi * fi / n
    bob = 0.0; legs = [(0, 0), (0, 0)]; crouch = 0.0; tilt = 0.0; back = 0.0; lean = 0.0; ffwd = 0.0
    expr = "normal"
    if anim == "idle": bob = [0, .5, 1, .5][fi]; expr = "blink" if fi == 3 else "normal"
    elif anim == "walk":
        bob = abs(math.sin(ph)) * 1.4 - .4; sw = 4.0
        legs = [(math.sin(ph) * sw, max(0, math.cos(ph)) * 3.4), (-math.sin(ph) * sw, max(0, -math.cos(ph)) * 3.4)]
    elif anim == "run":
        bob = abs(math.sin(ph)) * 2.4 - .8; sw = 6.2; lean = 2.6; expr = "focus"
        legs = [(math.sin(ph) * sw, max(0, math.cos(ph)) * 5.2), (-math.sin(ph) * sw, max(0, -math.cos(ph)) * 5.2)]
    elif anim == "gather": crouch = [2, 3.5, 3, 3.5][fi]; lean = 1.5; expr = "focus"
    elif anim == "attack": crouch = [0, -1, 2, .5][fi]; expr = ["focus", "yell", "yell", "focus"][fi]
    elif anim == "hit" and n == 3:   # ADR-134 hurt: impact snap back, peak recoil (head whips), recover
        back = [-3.5, -2.6, -.9][fi]; tilt = [-2.4, -3.8, -1.2][fi]; crouch = [1.4, 1.0, .4][fi]; lean = [0, -.8, .2][fi]; expr = "ouch"
    elif anim == "hit": back = [-3, -1.5][fi]; tilt = [-3, -1.5][fi]; crouch = [1, .5][fi]; expr = "ouch"
    elif anim in EXPR_EXTRA: expr = anim
    elif anim == "swim":    # doggy paddle: gentle bob, legs kicking (hidden below the waterline by the merge step)
        bob = math.sin(ph) * .6; lean = 1.2; sw = 2.0
        legs = [(math.sin(ph) * sw, 1.5 + math.cos(ph)), (-math.sin(ph) * sw, 1.5 - math.cos(ph))]
    elif anim == "punch": crouch = [0, .4, .2, 0][fi % 4]; lean = [.5, -.4, 2.6, 1.0][fi % 4]; expr = ["focus", "focus", "yell", "focus"][fi % 4]
    elif anim in BLOCK_ANIMS:
        # Dedicated v1 raised guard: plant a staggered stance, then raise both fists.
        # Only the timing/keypoint idea is shared with v2; every v1 layer is freshly painted.
        if anim == "block":
            crouch = [.8, 1.7, 1.35][fi]; back = [-.2, -.65, -.45][fi]
            tilt = [.25, .5, .35][fi]
        else:  # a blow compresses the guard, then it rebounds (not the hurt pose)
            crouch = 2.25 if fi == 0 else 1.55
            back = -2.0 if fi == 0 else -.8; tilt = -.8 if fi == 0 else -.25
        legs = [(-1.8, 0), (2.1, 0)]
        expr = "focus"
    elif anim in RIDE_ANIMS:
        # every frame differs (bob + side rock + lean breathing), so no ride cell repeats another frame or action
        if anim == "ride_idle": bob = [-.2, .5, .9, .3][fi % 4]; tilt = [0, .7, .25, -.6][fi % 4]; lean = [0, .6, .25, -.55][fi % 4]; expr = ["happy", "normal", "blink", "focus"][fi % 4]
        elif anim == "ride_walk": bob = -abs(math.sin(2 * ph + .5)) * 1.0 + .3 + .35 * math.sin(ph); lean = .4 + .7 * math.cos(ph + .5); tilt = math.sin(ph + .6) * .9; expr = ["normal", "happy", "focus", "happy", "normal", "happy"][fi % 6]
        else: bob = math.sin(ph - .9) * 1.0; lean = 2.2 + .8 * math.cos(ph - .8); tilt = math.sin(ph + .9) * .6; crouch = .4 + .5 * math.sin(ph + .6); expr = ["focus", "yell", "yell", "yell", "focus", "yell"][fi % 6]
    elif anim == "sit": bob = [0, .35, .7, .35][fi % 4]
    elif anim == "harvest": crouch = [1, 3, 4.5, 4.5, 3, 1.5][fi % 6]; lean = [1, 2, 3, 3, 2, 1][fi % 6]; expr = "focus"
    elif anim == "chop": crouch = [0, -.5, -.5, 1.5, 1, .3][fi % 6]; lean = [-.6, -1, 0, 2.6, 2.2, .8][fi % 6]; expr = ["focus", "focus", "yell", "yell", "focus", "focus"][fi % 6]
    elif anim == "mine": crouch = [0, -.3, 0, 2, 1.6, .5][fi % 6]; lean = [-.4, -.8, .5, 3, 2.6, 1][fi % 6]; expr = ["focus", "focus", "yell", "yell", "focus", "focus"][fi % 6]
    elif anim == "drink": back = [0, 0, -.4, -.6, -.2][fi % 5]; bob = [0, .2, .4, .4, .2][fi % 5]
    elif anim == "eat": bob = [0, .2, .4, .2, .4][fi % 5]    # seated rider: subtle breathing bob, legs bent, hands on the wheel
    elif anim == "death":
        crouch = [1, 4, 8, 12, 12.5][fi]; back = [-3, -2, -1, -3.5, -4.5][fi]; tilt = [-3, 4, -5, 7, 10][fi]
        ffwd = [0, 1, 3, 6.5, 7][fi]; expr = ["ouch", "dizzy", "dizzy", "dead", "dead"][fi]
    by = bob - crouch; bz = 19 + by; hipz = 11 + by * 0.5
    if anim == "death" and fi >= 3: hipz = 4.6
    sit = anim == "sit"
    if sit: by = bob * .6 - 4.0; bz = 19 + by; hipz = 7.4 + bob * .2
    ride = anim in RIDE_ANIMS
    if ride: by = bob * 1.0 - 2.6 - crouch; bz = 19 + by; hipz = 9.0 + bob * .5; sit = True   # seated astride: bent legs, no ground shadow
    rig = Rig(None, DIR_PHI[d], FW / 2, FEET)
    K = dict(ride=ride, sit=sit, bt=bt, B=B, d=d, anim=anim, fi=fi, n=n, rig=rig, expr=expr, tilt=tilt, back=back, lean=lean, bob=bob, by=by, bz=bz)
    K["hips"] = {}; K["feet"] = {}; K["knees"] = {}
    for i, side in enumerate((-1, 1)):
        fwd, lift = legs[i]
        hip = (side * B["hipw"], back * 0.3, hipz)
        foot = (side * B["hipw"] * (1.28 if anim in BLOCK_ANIMS else 1.05) + (side * 1.5 if ffwd else 0), fwd + back * 0.2 + ffwd, 2.2 + lift + (0.4 if ffwd > 5 else 0))
        K["hips"][side] = hip; K["feet"][side] = foot
        K["knees"][side] = tuple((h + f) / 2 for h, f in zip(hip, foot))
        if ride:   # astride: thigh out over the barrel, shin hanging down the flank (gallop: heels swing a little)
            sw = (math.sin(ph + side * 1.6) * 1.5 if anim == "ride_gallop" else math.sin(ph + side * 1.6) * .9 if anim == "ride_walk" else [0, .25, .4, .1][fi % 4])
            hip = (side * B["hipw"], -.3, hipz); knee = (side * (B["hipw"] + 5.2), 2.2, hipz - 1.3)
            foot = (side * (B["hipw"] + 6.0 + sw * .5), 2.4 + sw, hipz - 6.6)
            K["hips"][side] = hip; K["knees"][side] = knee; K["feet"][side] = foot
        elif sit:   # thigh forward along the seat, shin down to the floor (pivot stays the floor point under the seat)
            hip = (side * B["hipw"], -1.2, hipz); knee = (side * (B["hipw"] + .4), 5.6, hipz + .6)
            foot = (side * B["hipw"] * 1.05, 6.8, 2.2)
            K["hips"][side] = hip; K["knees"][side] = knee; K["feet"][side] = foot
    if ride:   # far leg is behind the mount's barrel in side / diagonal facings
        K["hide"] = {side for side in (-1, 1) if rig.nv(side, 0) < -.45}
        (sp_, _) = rig.proj(0, -.3, hipz - 2.4); K["seat"] = {"x": round(sp_[0] - FW / 2, 2), "y": round(sp_[1] - FEET, 2)}
    K["tc"] = (tilt * 0.25, back * 0.4 + lean * 0.4, bz)
    K["hipc"] = (0, back * 0.3, hipz + 1.0)
    shw = B["shw"]; K["sh"] = {}; K["hand"] = {}
    for side in (-1, 1):
        sh3 = (side * shw, back * 0.4 + lean * 0.5, bz + 5.5)
        if anim == "walk": hand3 = (side * (shw + 1.5), -legs[0 if side < 0 else 1][0] * 0.8, bz - 3)
        elif anim == "run":
            sw = -legs[0 if side < 0 else 1][0]; hand3 = (side * (shw + .5), sw * 1.1, bz - 1 + abs(sw) * .5)
        elif anim == "attack":
            hand3 = [(shw - 1, -5, bz + 15), (shw - 2, 6, bz + 15), (shw - 3, 11, bz - 2), (shw, 5, bz - 1)][fi] if side == 1 else (side * (shw + .5), 3, bz - 1)
        elif anim == "gather":
            up = [0, 2.5, 0, 2.5][fi] if side > 0 else [2.5, 0, 2.5, 0][fi]; hand3 = (side * 4.5, 9, bz - 7 + up)
        elif anim == "hit": hand3 = (side * (shw + 4), -2, bz + 6 + fi)
        elif anim == "death":
            hand3 = (side * (shw + 4), -2, bz + 6) if fi < 2 else (side * (shw + 2.5), -3 + back * 0.4, max(2.6, bz - 6))
        elif ride:   # both hands forward on the reins
            hand3 = (side * (shw - 3.4), 6.2 + lean * .8, bz - 4.6 + (bob * .4 if anim != "ride_idle" else 0))
        elif sit: hand3 = (side * (shw - 3.0), 7.0, bz - 5.5)
        elif anim == "swim":   # paddling circles just at the water surface, sides half a cycle apart
            a = ph + (0 if side > 0 else math.pi); hand3 = (side * (shw + .8), 6.0 + math.sin(a) * 3.5, SWIM_Z + 2.0 + bob + math.cos(a) * 2.6)
        elif anim in BLOCK_ANIMS:
            if anim == "block":
                x, y, z = [(5, 5, 5), (3, 7, 8.5), (3.2, 7, 8)][fi]
            else:
                x, y, z = (3.6, 4.8, 9.2) if fi == 0 else (3.1, 6.5, 8.3)
            hand3 = (side * x * shw / BODY["male"]["shw"], y + (.5 if side < 0 else 0), bz + z)
        elif anim == "punch":  # fists up in guard; right jab winds back, extends, recovers
            if side == 1: hand3 = [(shw - 2.5, 5, bz + 7), (shw - 1, 1, bz + 7.5), (shw - 3.5, 14, bz + 7), (shw - 2, 8, bz + 6.5)][fi % 4]
            else: hand3 = (side * (shw - 2.5), 6, bz + 7.5)       # both hands forward on the steering wheel
        elif anim == "harvest":   # crouch, reach forward-down, pull the right hand back up
            if side == 1: hand3 = [(5, 7, bz - 4), (5, 10, bz - 8), (4.5, 12, bz - 11), (4.5, 11, bz - 10), (5, 8, bz - 6), (shw, 4, bz - 3)][fi % 6]
            else: hand3 = (-4.5, 8, bz - 6 - [0, 1, 1.5, 1.5, 1, 0][fi % 6])
        elif anim in ("chop", "mine"):   # two-handed tool grip (right above left): wind up overhead, strike (impact = frame 4), recover
            g = ([(1, -4, bz + 15), (1, -2, bz + 17), (1, 4, bz + 15), (1, 11, bz + 1), (1, 10, bz - 1), (1, 6, bz + 5)] if anim == "chop" else
                 [(1, -3, bz + 14), (1, -1, bz + 16), (1, 5, bz + 13), (1, 11, bz - 4), (1, 10, bz - 5), (1, 6, bz + 3)])[fi % 6]
            hand3 = (g[0] + 1.2, g[1] + .5, g[2] + 1.2) if side == 1 else (g[0] - 1.6, g[1], g[2] - 1.2)
        elif anim in ("drink", "eat"):   # right hand (canteen / food) up to the mouth, left resting
            if side == 1: hand3 = ([(shw + 1, 1, bz - 3), (6, 6, bz + 5), (3, 11.5, bz + 13), (2.5, 12, bz + 13.5), (5, 8, bz + 7)] if anim == "drink" else
                                   [(shw + 1, 1, bz - 3), (5, 8, bz + 6), (2.5, 12, bz + 13), (2.5, 11.5, bz + 12.5), (2.5, 12, bz + 13)])[fi % 5]
            else: hand3 = (side * (shw + 1.0), 2, bz - 3)
        else: hand3 = (side * (shw + 1.2), .5, bz - 3.5 + bob * .3)
        K["sh"][side] = sh3; K["hand"][side] = hand3
    K["hc"] = (tilt * 0.5, lean + back * 0.6, 37 + by - (1.5 if expr == "dead" else 0))
    K["hr"] = B["hr"]
    # depth (view) values + front-arm flags
    P = rig.proj
    _, tv = P(*K["tc"]); K["tv"] = tv
    K["front"] = {}
    for side in (-1, 1):
        _, va = P(*K["sh"][side]); _, vb = P(*K["hand"][side])
        K["front"][side] = (vb if anim in BLOCK_ANIMS else max(va, vb)) - 0.5 + (0.3 if side == 1 else 0) >= tv
    # held-item hand anchor (right hand), same convention as tools/chars.py
    h = K["hand"][1]
    if anim == "attack": dv = [(0.1, -0.6, 0.8), (0.0, 0.7, 0.7), (0.0, 0.6, -0.8), (0.1, 0.9, -0.2)][fi]
    elif anim == "gather": dv = (0.0, 0.85, [-0.5, -0.2, -0.5, -0.2][fi])
    elif anim == "run": dv = (0.15, -0.45, 0.85)
    elif anim == "walk": dv = (0.15, 0.3 + 0.08 * math.sin(ph), 0.92)
    elif ride: dv = (0.0, 0.7, 0.6)
    elif sit: dv = (0.0, 0.55, 0.8)
    elif anim in BLOCK_ANIMS: dv = (0.0, .35, .94)
    elif anim == "punch": dv = (0.0, 0.95, 0.3)
    elif anim == "swim": dv = (0.15, 0.35, 0.92)
    elif anim in ("hit", "death"): dv = (0.4, -0.3, 0.85)
    elif anim == "harvest": dv = (0.0, 0.85, -0.5)
    elif anim == "chop": dv = [(0, -.7, .7), (0, -.4, .9), (0, .6, .8), (0, .95, -.3), (0, .9, -.4), (0, .8, .6)][fi % 6]
    elif anim == "mine": dv = [(0, -.6, .8), (0, -.3, .95), (0, .7, .7), (0, .9, -.45), (0, .85, -.5), (0, .8, .6)][fi % 6]
    elif anim in ("drink", "eat"): dv = (0.0, 0.2, 1.0)
    else: dv = (0.15, 0.35, 0.92)
    nn = math.sqrt(sum(v * v for v in dv)); dv = tuple(v / nn for v in dv)
    (a2, _), (b2, _) = P(*h), P(h[0] + dv[0] * 10, h[1] + dv[1] * 10, h[2] + dv[2] * 10)
    ang = math.degrees(math.atan2(b2[0] - a2[0], -(b2[1] - a2[1])))
    K["anchor"] = None if ((anim == "death" and fi >= 3) or anim == "swim") else {"x": round(a2[0], 2), "y": round(a2[1], 2), "angle": round(ang, 1),
        "len": round(math.hypot(b2[0] - a2[0], b2[1] - a2[1]) / 10, 3), "behind": not K["front"][1]}
    # off-hand (left) anchor: same convention, item direction mirrored across the body's x axis; always present
    hL = K["hand"][-1]; dl = (-dv[0], dv[1], dv[2])
    (a3, _), (b3, _) = P(*hL), P(hL[0] + dl[0] * 10, hL[1] + dl[1] * 10, hL[2] + dl[2] * 10)
    K["anchorL"] = {"x": round(a3[0], 2), "y": round(a3[1], 2), "angle": round(math.degrees(math.atan2(b3[0] - a3[0], -(b3[1] - a3[1]))), 1),
        "len": round(math.hypot(b3[0] - a3[0], b3[1] - a3[1]) / 10, 3), "behind": not K["front"][-1]}
    return K

def circle(c, r, ry=None, rot=0, wob=0.03, seed=0): return ellipse_pts(c[0], c[1], r, ry or r, rot, wob=wob, seed=seed)

def hull(pts):
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) < 3: return pts
    def cr(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cr(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]

def cel_hair_tips(mask):
    """Keep secondary hair colour as one solid tip band, without watercolor strands.
    Uses the visible tinted region, so it is invariant under trim/pivot packing.
    """
    out = np.asarray(mask).copy(); primary = out[..., 0] >= 128
    yy = np.nonzero(primary | (out[..., 1] >= 128))[0]
    if len(yy):
        split = int(yy.min() + (yy.max() - yy.min() + 1) * .72)
        tips = primary & (np.arange(out.shape[0])[:, None] >= split)
        out[tips, 0] = 0; out[tips, 1] = 255
    return out


class MCanvas(Canvas):
    """Canvas that also tracks a tint mask (R primary/skin/hair, G secondary) at 4x."""
    def __init__(s, w, h, seed):
        super().__init__(w, h, seed=seed); s.tm = np.zeros((s.H, s.W, 2), np.float32)
    def _upd(s, m_im, tm, ring=True):
        m = np.asarray(m_im, np.float32) / 255
        if ring: m = np.asarray(m_im.filter(ImageFilter.MaxFilter(7)), np.float32) / 255  # outline ring takes the part's tint too
        if tm is not None: s.tm = s.tm * (1 - m)[..., None] + np.array(tm, np.float32) * m[..., None]
    pal = None
    def cel_snap(s, im):
        """cel post pass: snap every pixel to a drawn palette tone (no in-between airbrush tones) and harden alpha
        (strict binary alpha; contact shadows are not baked into opaque character paint)."""
        from palette import SHADOW, SHADOW_ALPHA
        a = np.asarray(im.convert("RGBA")).astype(np.float32); P = np.array(sorted(set(s.pal)), np.float32)
        rgb = a[..., :3]; al = a[..., 3]; sh = np.array(hex2rgb(SHADOW), np.float32)
        shadow = (al < 255 * (SHADOW_ALPHA + .12)) & (np.abs(rgb - sh).sum(-1) < 60) & bool(s.shadowed)   # only layers that drew a contact shadow
        out = np.zeros_like(a); fig = (al >= 128) & ~shadow
        # Only figure texels need palette lookup (the empty canvas is usually >85%).
        colors = rgb[fig]
        if len(P) and len(colors): colors = P[((colors[:, None, :] - P[None, :]) ** 2).sum(-1).argmin(-1)]
        out[fig, :3] = colors; out[fig, 3] = 255
        sm = shadow & (al >= 255 * SHADOW_ALPHA * .5); out[sm] = 0
        return Image.fromarray(out.astype(np.uint8), "RGBA")
    shadowed = False
    cel = False     # cel look (solid fills, hard-edged shade/highlight bands, hard alpha) — set by parts.body
    def shadow(s, cx, cy, rx, ry, *a, **k):
        if not s.cel: return Canvas.shadow(s, cx, cy, rx, ry, *a, **k)
        s.shadowed = True
        import toon; g = toon.ImageFilter.GaussianBlur; toon.ImageFilter.GaussianBlur = lambda r: ImageFilter.BoxBlur(0)
        try: Canvas.shadow(s, cx, cy, rx, ry, *a, **k)
        finally: toon.ImageFilter.GaussianBlur = g
    def part(s, polys, rp, tm=None, **kw):
        if s.cel:
            # Flat cel bands and clean ink, not seed-dependent watercolor edge noise.
            s._n1.fill(.5); s._n2.fill(.5)
            import toon; sm = toon.smooth; toon.smooth = lambda e0, e1, x: (np.asarray(x) >= (e0 + e1) / 2).astype(np.float32)
            try: return s._part(polys, rp, tm, **kw)
            finally: toon.smooth = sm
        return s._part(polys, rp, tm, **kw)
    def _part(s, polys, rp, tm=None, **kw):
        if rp in ("P", "S"):
            tm = (1, 0) if rp == "P" else (0, 1); rp = NEU; kw.setdefault("ink", NEU_INK)
        elif tm is None: tm = (0, 0)
        if s.cel:
            import toon; r = ramp(rp) if isinstance(rp, str) else rp
            kw.setdefault("ink", tuple(round(v * .88) for v in toon.outline_col(r)))
            s.pal += [tuple(x) for x in r] + [tuple(kw.get("ink") or toon.outline_col(r))] + [tuple(tint_col(kw[k])) for k in ("shade_col", "base_col", "hl_col") if kw.get(k)]
        m_im = Canvas.part(s, polys, rp, **kw)
        if m_im is not None and m_im.getbbox():
            s._upd(m_im, tm, ring=kw.get("outline", True))
            if s.detail and not s.cel and tuple(tm) != (0, 0): s._wear_detail(m_im, tuple(tm))
        return m_im
    no_g = False    # True while drawing parts that must stay primary-only (scalp cover)
    detail = None   # slot name while drawing hair/wearables: surface detail pass (wear_detail, mostly visible at @2x)
    def _wear_detail(s, m_im, tm):
        """Deterministic surface detail inside a tinted part, in part-local coords (stable across frames). Periods of
        2-4 supersample px = 1-2 @2x px: twill/strands resolve at @2x and average out at 1x (1x px = 4 SS px)."""
        bb = m_im.getbbox(); x0, y0, x1, y1 = bb
        if x1 - x0 < 3 * SS or y1 - y0 < 3 * SS: return
        m = np.asarray(m_im.crop(bb), np.float32) / 255
        er = np.asarray(m_im.crop(bb).filter(ImageFilter.MinFilter(2 * SS - 1)), np.float32) / 255     # interior (~1 1x px in)
        er2 = np.asarray(m_im.crop(bb).filter(ImageFilter.MinFilter(3 * SS - 1)), np.float32) / 255
        h, w = m.shape; yy, xx = np.mgrid[0:h, 0:w].astype(np.float32); u = xx / max(w, 1); v = yy / max(h, 1)
        k = np.ones((h, w), np.float32)
        if s.detail == "hair":
            ph = xx / (1.6 * SS) + 1.3 * np.sin(v * 5.0 + u * 2.0)                       # strand clusters (wavy vertical)
            st = (np.sin(ph * 2 * np.pi) + 1) / 2
            k -= .13 * (st > .78) * er                                                    # dark strand gaps
            k += .10 * ((st < .12) & (v < .55)) * er                                      # highlight strands, upper half
            k -= .06 * np.clip(v - .55, 0, 1) * 2 * er                                    # shading toward the ends
            clu = (np.sin(xx / (5 * SS) * 2 * np.pi + v * 3) > .92)
            k -= .08 * clu * er                                                           # cluster partings
            if tm == (1, 0) and not s.no_g and h >= 4 * SS:                               # two-tone: tint G (secondary hair colour)
                tip = np.clip((v - .70) / .10, 0, 1)                                      # tips: lower ~25% of each lock/part
                stk = ((np.sin(xx / (6.5 * SS) * 2 * np.pi + 1.1) > .88) & (v > .12)).astype(np.float32)  # thin streaks
                g = np.maximum(tip, stk) * m; sub = s.tm[y0:y1, x0:x1]
                sub[:] = sub * (1 - g)[..., None] + np.array((0, 1), np.float32) * g[..., None]
        else:
            tw = (((xx + yy) // 2) % 4 < 2)                                               # twill weave (2 SS px = 1 @2x px)
            k -= .045 * tw * er
            cr = np.abs(np.sin((u * 1.6 + v * .7) * np.pi * 2.2)) < .07                   # soft fold creases
            k -= .10 * cr * er2
            ring = (er > .5) & (er2 < .5)                                                 # seam line just inside the edge
            dash = ((xx + yy) // (2 * SS)) % 2 == 0                                       # stitch dashes
            k += .16 * (ring & dash)
            if tm == (0, 1): k -= .16 * ((m > .5) & (er < .5))                            # darker trim edge: clear color2 separation
        a = np.asarray(s.img).copy(); reg = a[y0:y1, x0:x1].astype(np.float32)
        wgt = m[..., None]; reg[..., :3] = reg[..., :3] * (1 - wgt + wgt * k[..., None])
        a[y0:y1, x0:x1] = np.clip(reg + .5, 0, 255).astype(np.uint8); s.img = Image.fromarray(a, "RGBA")
    def _detail(s, m, tm):
        if tm is not None: s._upd(m, tm, ring=False)
    def fill(s, polys, color, alpha=255, clip=None, blur_r=0, tm=None):
        color = tint_col(color)
        if s.cel: s.pal.append(tuple(color)); alpha, blur_r = 255, 0   # solid fills only
        Canvas.fill(s, polys, color, alpha, clip, blur_r)
        if tm is not None:
            m = s.mask_from(polys)
            if clip is not None: m = Image.fromarray(np.minimum(np.asarray(m), np.asarray(clip)))
            s._detail(m, tm)
    def line(s, pts, color, width=1.0, clip=None, alpha=255, tm=None):
        if s.cel: s.pal.append(tuple(tint_col(color))); alpha = 255
        Canvas.line(s, pts, tint_col(color), width, clip, alpha)
        if tm is not None:
            m = Image.new("L", (s.W, s.H), 0); d = ImageDraw.Draw(m); sp = s.S(pts); rr = width * SS / 2
            d.line(sp, fill=255, width=max(1, int(width * SS)), joint="curve")
            for p in (sp[0], sp[-1]): d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=255)
            if clip is not None: m = Image.fromarray(np.minimum(np.asarray(m), np.asarray(clip)))
            s._detail(m, tm)
    def erase(s, m_im):
        if m_im is None: return
        m = np.asarray(m_im, np.float32) / 255
        a = np.asarray(s.img).copy().astype(np.float32); a[..., 3] *= (1 - m); s.img = Image.fromarray(a.astype(np.uint8), "RGBA")
        s.tm *= (1 - m)[..., None]

def tint_col(c):
    """'P0'..'P3' / 'S0'..'S3' = neutral ramp tone (stays tinted where drawn over a tinted region)."""
    if isinstance(c, str) and len(c) == 2 and c[0] in "PS" and c[1].isdigit(): return NEU[int(c[1])]
    if isinstance(c, str): return hex2rgb(c)
    return c

class Ctx:
    """One frame of one layer: shared pose + canvas + depth-sorted draw list."""
    def __init__(s, K):
        s.K = K; s.cv = MCanvas(FW, FH, seed=17 + K["d"] * 3 + K["fi"] + ANIM_START[K["anim"]] * 7)
        s.rig = K["rig"]; s.rig.cv = s.cv; s.items = []; s.fdy = 0.0  # face lift (px up) applied by sph while drawing face/eyes/glasses
    def P(s, p): return s.rig.proj(*p)
    def p(s, p): return s.rig.proj(*p)[0]
    def nv(s, x, y): return s.rig.nv(x, y)
    def add(s, depth, fn, back=False): s.items.append((depth, len(s.items), fn, back))
    def off(s, base, dx, dy, dz): return (base[0] + dx, base[1] + dy, base[2] + dz)
    def hoff(s, dx, dy, dz): return s.off(s.K["hc"], dx, dy, dz)
    def sph(s, az, el, rk=1.0, c3=None):
        c3 = c3 or s.K["hc"]; r = s.K["hr"] * rk; a, e = math.radians(az), math.radians(el)
        x = c3[0] + r * math.sin(a) * math.cos(e); y = c3[1] + r * math.cos(a) * math.cos(e); z = c3[2] + r * math.sin(e)
        q = s.p((x, y, z)); return (q[0], q[1] - s.fdy), s.nv(math.sin(a) * math.cos(e), math.cos(a) * math.cos(e))
    def facev(s): return s.nv(0, 1)
    def headmask(s, dy=0.0):
        hp = s.p(s.K["hc"]); hp = (hp[0], hp[1] - dy); hr = s.K["hr"]; rot = math.radians(s.K["tilt"] * 2.5)
        return s.cv.mask_from(circle(hp, hr, hr * 0.96, rot=rot, wob=0.025, seed=11))
    def torso_pts(s, grow=0.0, ky=1.0):
        tp = s.p(s.K["tc"]); B = s.K["B"]
        return circle(tp, B["trx"] + grow, (B["try_"] + grow) * ky, wob=0.04, seed=3)
    def disc(s, c3, r, n=28, rs=None):
        rs = rs or r; return [s.p((c3[0] + math.cos(2 * math.pi * i / n) * r, c3[1] + math.sin(2 * math.pi * i / n) * rs, c3[2])) for i in range(n)]
    def solid(s, discs):
        pts = []
        for c3, r in discs: pts += s.disc(c3, r)
        return hull(pts)
    def tube(s, a3, b3, r0, r1=None):
        a, b = s.p(a3), s.p(b3); return capsule_pts(a[0], a[1], b[0], b[1], r0, r1 if r1 is not None else r0)
    def lerp3(s, a, b, t): return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
    # --- masks used by the layering rules
    def occluder(s, grow=1.6):
        K = s.K; B = K["B"]; polys = [s.torso_pts(grow + 0.6)]
        hp = s.p(K["hc"]); polys.append(circle(hp, K["hr"] + 0.6, (K["hr"] + 0.6) * 0.96))
        for side in (-1, 1):
            polys.append(s.tube(K["sh"][side], K["hand"][side], B["arm"] + grow, B["arm"] + grow))
            polys.append(s.tube(K["hips"][side], K["feet"][side], B["leg"] + grow, B["leg"] + grow))
        return s.cv.mask_from(polys)
    def armcut(s):
        K = s.K; B = K["B"]; polys = []
        for side in (-1, 1):
            if K["front"][side]:
                a = s.lerp3(K["sh"][side], K["hand"][side], 0.25)
                polys.append(s.tube(a, K["hand"][side], B["arm"] + 1.1)); polys.append(circle(s.p(K["hand"][side]), B["hand"] + 1.2))
        return s.cv.mask_from(polys) if polys else None
    def run(s, armcut=True, extra=None):
        items = sorted(s.items, key=lambda t: (t[0], t[1]))
        backs = [t for t in items if t[3]]; fronts = [t for t in items if not t[3]]
        for t in backs: t[2]()
        if backs: s.cv.erase(s.occluder())
        for t in fronts: t[2]()
        if armcut: s.cv.erase(s.armcut())
        if extra: extra(s)
    def out(s):
        img = s.cv.img
        im1 = downscale(img, (FW, FH)); im2 = downscale(img, (FW * 2, FH * 2))
        tm = s.cv.tm * (np.asarray(img, np.float32)[..., 3:4] / 255)
        if s.cv.cel:   # solid cel look: palette-snapped colours, hard alpha, flat (0/1) tint mask per region
            im1, im2 = s.cv.cel_snap(im1), s.cv.cel_snap(im2); tm = np.round(np.clip(tm, 0, 1))
        def mk(sz):
            ch = [np.asarray(Image.fromarray(np.ascontiguousarray(tm[..., i] * 255).astype(np.uint8)).resize(sz, Image.BOX)) for i in range(2)]
            if s.cv.cel:   # strictly 0/1 per region after the box resize, and only under opaque figure texels
                A = np.asarray((im1 if sz == (FW, FH) else im2).getchannel("A")) >= 128
                ch = [np.where((c >= 128) & A, 255, 0).astype(np.uint8) for c in ch]
            return np.stack(ch + [np.zeros_like(ch[0])], -1)
        m1, m2 = mk((FW, FH)), mk((FW * 2, FH * 2))
        if s.cv.cel and s.cv.detail == "hair":
            m1, m2 = cel_hair_tips(m1), cel_hair_tips(m2)
        return im1, im2, m1, m2
