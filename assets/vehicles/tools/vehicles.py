"""Vehicle models. Each builder(state) -> Model(prims, attach{name:(x,y,z)}, lights[(name, kind, pos, normal)], xf, footprint)."""
import math, numpy as np
from vrender import *

TRIM = hexc("#4f4858"); CHROME = hexc("#dcd8d0"); TYRE = "#3b3440"; CREAM = hexc("#f4ead4"); WOOD = hexc("#b9824e")
GLASS = hexc("#a3d6ea"); HEAD = hexc("#fff3cf"); TAIL = hexc("#e4473c"); DARK = hexc("#3a3442"); WHITE = hexc("#f6f2ea")
P = PAINT_NEUTRAL
E_HEAD = (255, 236, 180); E_TAIL = (255, 60, 40)

class Model:
    def __init__(self): self.prims = []; self.attach = {}; self.lights = []; self.xf = None; self.foot = (1, 1); self.wheels = []
    def add(self, *p):
        for x in p:
            if isinstance(x, list): self.prims += x
            else: self.prims.append(x)
    def light(self, name, kind, pos, normal, size=(0.03, 0.15, 0.09), lens=None):
        x, y, z = pos; dx, dy, dz = size
        lens = lens or (HEAD if kind == "headlight" else TAIL); em = E_HEAD if kind == "headlight" else E_TAIL
        self.add(box(x - dx / 2, x + dx / 2, y - dy / 2, y + dy / 2, z - dz / 2, z + dz / 2, M_LAMP, lens, emis=em, bias=0.004))
        off = np.array(normal) * 0.06
        self.attach["light_" + name] = tuple(np.array(pos) + off); self.lights.append((name, kind, tuple(pos), tuple(normal)))

def tilt(pitch=0.0, roll=0.0, dz=0.0):
    cp, sp, cr, sr = math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    def f(p):
        p = np.asarray(p, float); x, y, z = p[..., 0], p[..., 1], p[..., 2]
        x2 = x * cp - z * sp; z2 = x * sp + z * cp
        y3 = y * cr - z2 * sr; z3 = y * sr + z2 * cr
        return np.stack([x2, y3, z3 + dz], -1)
    return f

def wheels4(m, xs, W, r, w, state, tyre=TYRE, missing=()):
    flat = 0.6 if state == "rusty" else 0.0
    names = []
    for i, x in enumerate(xs):
        for side, y in (("l", -W / 2), ("r", W / 2)):
            nm = ("f" if i == 0 else ("r" if i == len(xs) - 1 else f"m{i}")) + side
            m.attach["wheel_" + nm] = (x, y, r)
            if nm in missing: continue
            m.add(wheel(x, y, r, w, tyre, flat=flat))

def car(kind, state):
    m = Model(); S = dict(
        sedan=dict(L=2.1, W=1.1, r=0.22, zb=0.56, c0=-0.62, c1=0.42, ta=0.22, tb=0.24, zr=1.0, wb=1.36),
        hatchback=dict(L=1.8, W=1.08, r=0.22, zb=0.56, c0=-0.86, c1=0.32, ta=0.06, tb=0.26, zr=1.04, wb=1.18),
        sports=dict(L=2.2, W=1.16, r=0.23, zb=0.46, c0=-0.5, c1=0.32, ta=0.22, tb=0.3, zr=0.8, wb=1.42),
        pickup=dict(L=2.4, W=1.16, r=0.27, zb=0.68, c0=0.02, c1=0.66, ta=0.02, tb=0.18, zr=1.18, wb=1.56),
        suv=dict(L=2.3, W=1.2, r=0.28, zb=0.72, c0=-1.0, c1=0.5, ta=0.03, tb=0.2, zr=1.32, wb=1.46),
        minivan=dict(L=2.4, W=1.2, r=0.24, zb=0.62, c0=-1.12, c1=0.72, ta=0.04, tb=0.4, zr=1.36, wb=1.6),
        wagon=dict(L=2.3, W=1.1, r=0.22, zb=0.56, c0=-1.06, c1=0.44, ta=0.22, tb=0.05, zr=1.02, wb=1.46),
        flatbed=dict(L=2.7, W=1.18, r=0.28, zb=0.7, c0=0.3, c1=0.86, ta=0.02, tb=0.14, zr=1.24, wb=1.8))[kind]
    L, W, r, zb, c0, c1, ta, tb, zr, wb = (S[k] for k in "L W r zb c0 c1 ta tb zr wb".split())
    wrecked = state == "wrecked"
    if wrecked: m.xf = tilt(pitch=-0.07, roll=0.06, dz=-0.04); zr_eff = zb + (zr - zb) * 0.72
    else: zr_eff = zr
    lowered = -0.06 if state == "rusty" else 0.0
    if state == "rusty": m.xf = tilt(pitch=0.015, roll=-0.02, dz=lowered)
    z0 = r * 0.55; h = W / 2
    # body lower with rounded (inset) top
    nose = 0.12 if kind != "sports" else 0.2
    m.add(prism((-L / 2, L / 2, -h, h), (-L / 2 + 0.06, L / 2 - nose, -h + 0.05, h - 0.05), z0, zb, M_PAINT, P))
    if kind == "sports":  # low wedge hood + spoiler + stripe
        m.add(box(0.35, L / 2 - 0.25, -0.1, 0.1, zb, zb + 0.012, M_TRIM, WHITE, bias=0.01))
        m.add(rods([((-L / 2 + 0.12, -0.35, zb), (-L / 2 + 0.12, -0.35, zb + 0.16)), ((-L / 2 + 0.12, 0.35, zb), (-L / 2 + 0.12, 0.35, zb + 0.16))], 1.2, M_TRIM, DARK))
        m.add(box(-L / 2 + 0.02, -L / 2 + 0.24, -h + 0.04, h - 0.04, zb + 0.16, zb + 0.2, M_PAINT, P, bias=0.03))
    # cabin (glass) + roof
    if kind != "pickup" or True:
        cy = h - 0.06; ty = h - 0.16
        m.add(prism((c0, c1, -cy, cy), (c0 + tb, c1 - ta if not wrecked else c1 - ta - 0.05, -ty, ty), zb, zr_eff - 0.06, M_GLASS, GLASS if state != "rusty" else hexc("#9eb8a6")))
        m.add(box(c0 + tb - 0.03, c1 - ta + 0.02, -ty - 0.02, ty + 0.02, zr_eff - 0.06, zr_eff, M_PAINT, P, inset=0.02))
        # pillars
        for y in (-cy + 0.02, cy - 0.02):
            yt = math.copysign(ty, y)
            m.add(rods([((c0 + 0.02, y, zb), (c0 + tb, yt, zr_eff - 0.05)), (((c0 + c1) / 2, y, zb), ((c0 + tb + c1 - ta) / 2, yt, zr_eff - 0.05))], 1.1, M_PAINT, P))
    m.attach["roof"] = ((c0 + c1) / 2, 0, zr_eff + 0.02)
    if kind == "flatbed":  # wooden stake deck
        bx0, bx1 = -L / 2 - 0.04, c0 - 0.05; zd = zb - 0.06
        m.add(box(bx0, bx1, -h - 0.03, h + 0.03, zd - 0.06, zd, M_TRIM, DARK))
        m.add(box(bx0, bx1, -h - 0.03, h + 0.03, zd, zd + 0.06, M_WOOD, WOOD))
        for i in range(7): x = bx0 + 0.08 + i * (bx1 - bx0 - 0.16) / 6; m.add(box(x - 0.008, x + 0.008, -h - 0.03, h + 0.03, zd + 0.06, zd + 0.064, M_TRIM, hexc("#8d5f3a"), bias=0.01))
        for x in (bx0 + 0.06, (bx0 + bx1) / 2, bx1 - 0.06):
            for y in (-h - 0.01, h + 0.01): m.add(box(x - 0.025, x + 0.025, y - 0.02, y + 0.02, zd + 0.06, zd + 0.3, M_PAINT, P, bias=0.02))
        m.add(box(bx1 - 0.05, bx1, -h, h, zd + 0.06, zr - 0.1, M_TRIM, DARK, bias=0.01))  # headache rack
        m.attach["cargo"] = ((bx0 + bx1) / 2, 0, zd + 0.07)
    if kind == "wagon":
        for y in (-h + 0.12, h - 0.12): m.add(box(c0 + 0.1, c1 - 0.3, y - 0.02, y + 0.02, zr - 0.0, zr + 0.05, M_TRIM, DARK, bias=0.02))
        m.add(box(-L / 2 + 0.04, c0 + 0.6, -h - 0.004, -h + 0.0, zb - 0.22, zb - 0.1, M_WOOD, WOOD, bias=0.01))
        m.add(box(-L / 2 + 0.04, c0 + 0.6, h - 0.0, h + 0.004, zb - 0.22, zb - 0.1, M_WOOD, WOOD, bias=0.01))
    if kind == "pickup":  # bed
        bx0, bx1 = -L / 2 + 0.02, c0 - 0.03
        m.add(box(bx0, bx1, -h + 0.02, h - 0.02, zb - 0.02, zb, M_TRIM, DARK))
        for y0, y1 in ((-h + 0.02, -h + 0.1), (h - 0.1, h - 0.02)): m.add(box(bx0, bx1, y0, y1, zb, zb + 0.2, M_PAINT, P))
        m.add(box(bx0, bx0 + 0.07, -h + 0.02, h - 0.02, zb, zb + 0.2, M_PAINT, P))
        m.attach["cargo"] = ((bx0 + bx1) / 2, 0, zb + 0.05)
    if kind == "suv":
        for x in (c0 + 0.25, c1 - 0.25): m.add(box(x - 0.03, x + 0.03, -h + 0.1, h - 0.1, zr_eff, zr_eff + 0.05, M_TRIM, DARK, bias=0.02))
        m.add(cyl((-L / 2 - 0.08, 0.0, zb - 0.05), 0.2, 0.06, "x", M_TYRE, hexc(TYRE), hub=(0.55, CHROME, M_METAL)))
    # bumpers, grille, mirrors
    m.add(box(L / 2 - 0.03, L / 2 + 0.05, -h + 0.04, h - 0.04, z0 - 0.02, z0 + 0.1, M_TRIM, TRIM))
    m.add(box(-L / 2 - 0.05, -L / 2 + 0.03, -h + 0.04, h - 0.04, z0 - 0.02, z0 + 0.1, M_TRIM, TRIM))
    m.add(box(L / 2 - 0.02, L / 2 + 0.01, -0.2, 0.2, z0 + 0.13, zb - 0.1, M_TRIM, DARK, bias=0.002))
    for y in (-h - 0.06, h + 0.02): m.add(box(c1 - 0.08, c1, y, y + 0.04, zb + 0.06, zb + 0.14, M_PAINT, P))
    # lights
    zl = zb - 0.12 if kind != "sports" else zb - 0.08
    if state != "wrecked" or True:
        m.light("head_l", "headlight", (L / 2 - nose * 0.5 + 0.01, -h + 0.17, zl), (1, 0, 0))
        m.light("head_r", "headlight", (L / 2 - nose * 0.5 + 0.01, h - 0.17, zl), (1, 0, 0))
        m.light("tail_l", "taillight", (-L / 2 - 0.0, -h + 0.14, zl), (-1, 0, 0), size=(0.03, 0.14, 0.08))
        m.light("tail_r", "taillight", (-L / 2 - 0.0, h - 0.14, zl), (-1, 0, 0), size=(0.03, 0.14, 0.08))
        xb = c0 + tb - 0.02 if kind not in ("pickup", "flatbed") else c0 - 0.0
        m.light("brake", "brake", (xb, 0, zr_eff - 0.08 if kind not in ("pickup", "flatbed") else zr_eff - 0.1), (-1, 0, 0.3), size=(0.025, 0.2, 0.035))
    wheels4(m, (wb / 2, -wb / 2), W + 0.04, r, 0.2, state, missing=("fr",) if wrecked else ())
    m.attach["driver"] = (c1 - 0.42 if kind not in ("pickup", "flatbed") else c1 - 0.3, -0.22, zb + 0.02)
    m.attach["seat_passenger"] = (m.attach["driver"][0], 0.22, zb + 0.02)
    if kind in ("sedan", "hatchback", "suv", "minivan", "wagon"):
        m.attach["seat_rear_l"] = (m.attach["driver"][0] - 0.5, -0.22, zb + 0.02); m.attach["seat_rear_r"] = (m.attach["driver"][0] - 0.5, 0.22, zb + 0.02)
    m.attach["door_driver"] = (m.attach["driver"][0], -h - 0.18, 0.3)
    m.attach["exhaust"] = (-L / 2 - 0.08, -0.3, z0 + 0.02)
    m.add(cyl((-L / 2 - 0.03, -0.3, z0 + 0.02), 0.035, 0.06, "x", M_METAL, CHROME))
    m.attach["tow_hitch"] = (-L / 2 - 0.14, 0, z0 + 0.06)
    m.add(box(-L / 2 - 0.16, -L / 2 - 0.04, -0.03, 0.03, z0 - 0.02, z0 + 0.04, M_METAL, CHROME))
    m.attach["engine"] = ((L / 2 + c1) / 2 if kind not in ("hatchback", "minivan") else L / 2 - 0.2, 0, zb + 0.02)
    m.foot = (L, W); return m

def van(kind, state):
    m = Model(); wrecked = state == "wrecked"
    if wrecked: m.xf = tilt(pitch=0.05, roll=-0.07, dz=-0.03)
    if state == "rusty": m.xf = tilt(pitch=-0.015, roll=0.02, dz=-0.06)
    if kind == "delivery_van":
        L, W, r = 2.5, 1.2, 0.25; h = W / 2; z0 = 0.16; wb = 1.6; xc = 0.42
        m.add(prism((-L / 2, L / 2, -h, h), (-L / 2 + 0.03, L / 2 - 0.16, -h + 0.04, h - 0.04), z0, 0.72, M_PAINT, P))
        zt = 1.45 if not wrecked else 1.3
        m.add(box(-L / 2 + 0.02, xc, -h + 0.03, h - 0.03, 0.72, zt, M_LIGHTBODY, WHITE, inset=0.03))
        m.add(prism((xc, L / 2 - 0.2, -h + 0.06, h - 0.06), (xc, xc + 0.22, -h + 0.12, h - 0.12), 0.72, zt - 0.05, M_GLASS, GLASS))
        m.add(box(xc - 0.02, xc + 0.24, -h + 0.1, h - 0.1, zt - 0.05, zt, M_PAINT, P))
        m.add(box(-L / 2 + 0.3, xc - 0.1, -h + 0.025, -h + 0.03, 0.85, 1.25, M_PAINT, P, bias=0.01))  # side logo panel (tintable)
        m.add(box(-L / 2 + 0.3, xc - 0.1, h - 0.03, h - 0.025, 0.85, 1.25, M_PAINT, P, bias=0.01))
        zr = zt; c1 = xc + 0.1; front = L / 2 - 0.08; zl = 0.5; xb = -L / 2 + 0.02; zbk = zt - 0.08
        m.attach["cargo"] = (-0.4, 0, 0.75)
    elif kind == "box_truck":
        L, W, r = 3.0, 1.3, 0.3; h = W / 2; z0 = 0.2; wb = 2.0
        m.add(box(-L / 2, L / 2 - 0.1, -0.4, 0.4, z0, 0.42, M_TRIM, DARK))
        m.add(prism((0.62, L / 2, -h + 0.04, h - 0.04), (0.62, L / 2 - 0.12, -h + 0.08, h - 0.08), 0.32, 0.86, M_PAINT, P))
        m.add(prism((0.66, L / 2 - 0.1, -h + 0.08, h - 0.08), (0.66, L / 2 - 0.34, -h + 0.14, h - 0.14), 0.86, 1.36, M_GLASS, GLASS))
        m.add(box(0.64, L / 2 - 0.32, -h + 0.12, h - 0.12, 1.32, 1.4, M_PAINT, P))
        zt = 1.9 if not wrecked else 1.7
        m.add(box(-L / 2, 0.58, -h, h, 0.45, zt, M_LIGHTBODY, WHITE, inset=0.02))
        for y in (-h - 0.004, h - 0.006): m.add(box(-L / 2 + 0.05, 0.53, y, y + 0.01, 0.95, 1.15, M_PAINT, P, bias=0.01))
        for i in range(5): m.add(box(-L / 2 - 0.012, -L / 2, -h + 0.08, h - 0.08, 0.6 + i * 0.25, 0.62 + i * 0.25, M_TRIM, hexc("#cfc8bd"), bias=0.005))
        for y in (-h - 0.006, h - 0.004):  # side posts on the box body, one prim per side (sorts with its wall)
            xs_ = [-L / 2 + i * (L / 2 + 0.58) / 6 for i in range(1, 6)]
            m.add(Prim([pl for x in xs_ for pl in box(x - 0.012, x + 0.012, y, y + 0.01, 0.47, zt - 0.04, M_TRIM, hexc("#d8d0c4")).polys], bias=0.012))
        zr = 1.4; c1 = 1.05; front = L / 2 + 0.01; zl = 0.55; xb = -L / 2 - 0.01; zbk = zt - 0.08
        m.attach["cargo"] = (-0.45, 0, 0.5); m.attach["cargo_door"] = (-L / 2 - 0.2, 0, 0.3)
    else:  # minivan uses car body
        return car("minivan", state)
    if not (kind == "box_truck"):
        pass
    m.add(box(L / 2 - 0.04, L / 2 + 0.05, -h + 0.04, h - 0.04, z0, z0 + 0.13, M_TRIM, TRIM))
    m.add(box(-L / 2 - 0.05, -L / 2 + 0.02, -h + 0.04, h - 0.04, z0, z0 + 0.12, M_TRIM, TRIM))
    for y in (-h - 0.08, h + 0.02): m.add(box(c1 - 0.04, c1 + 0.04, y, y + 0.06, zr - 0.6, zr - 0.42, M_TRIM, DARK))
    m.light("head_l", "headlight", (front, -h + 0.18, zl), (1, 0, 0)); m.light("head_r", "headlight", (front, h - 0.18, zl), (1, 0, 0))
    m.light("tail_l", "taillight", (-L / 2 - 0.01, -h + 0.1, zl - 0.05), (-1, 0, 0), size=(0.03, 0.1, 0.16))
    m.light("tail_r", "taillight", (-L / 2 - 0.01, h - 0.1, zl - 0.05), (-1, 0, 0), size=(0.03, 0.1, 0.16))
    m.light("brake", "brake", (xb - 0.01, 0, zbk), (-1, 0, 0), size=(0.025, 0.24, 0.035))
    xs = (wb / 2, -wb / 2); wheels4(m, xs, W + 0.04, r, 0.22 if kind != "box_truck" else 0.3, state, missing=("rl",) if wrecked else ())
    m.attach["driver"] = (c1 - 0.25, -0.24, 0.75); m.attach["seat_passenger"] = (c1 - 0.25, 0.24, 0.75)
    m.attach["door_driver"] = (c1 - 0.25, -h - 0.18, 0.3)
    m.attach["exhaust"] = (-L / 2 + 0.25, -h + 0.15, z0 + 0.02); m.add(cyl((-L / 2 + 0.25, -h + 0.15, z0 + 0.02), 0.04, 0.12, "x", M_METAL, CHROME))
    m.attach["tow_hitch"] = (-L / 2 - 0.15, 0, z0 + 0.08); m.add(box(-L / 2 - 0.17, -L / 2 - 0.04, -0.03, 0.03, z0 + 0.02, z0 + 0.08, M_METAL, CHROME))
    m.attach["engine"] = (L / 2 - 0.3, 0, 0.8); m.attach["roof"] = (0, 0, zr)
    m.foot = (L, W); return m

def semi(state):
    m = Model(); wrecked = state == "wrecked"; L, W, r = 2.7, 1.36, 0.265; h = W / 2  # r -> 0.51 m tyres at 3.9 m true scale
    if wrecked: m.xf = tilt(pitch=-0.06, roll=0.08, dz=-0.03)
    if state == "rusty": m.xf = tilt(roll=-0.02, dz=-0.07)
    m.add(box(-L / 2, L / 2 - 0.1, -0.42, 0.42, 0.26, 0.46, M_TRIM, DARK))
    m.add(prism((0.82, L / 2, -h + 0.14, h - 0.14), (0.82, L / 2 - 0.08, -h + 0.2, h - 0.2), 0.42, 1.0, M_PAINT, P))  # hood
    m.add(box(L / 2 - 0.02, L / 2 + 0.02, -0.34, 0.34, 0.5, 0.92, M_METAL, CHROME, bias=0.003))  # grille
    zc = 1.62 if not wrecked else 1.42
    m.add(box(0.05, 0.84, -h + 0.02, h - 0.02, 0.42, 1.04, M_PAINT, P, inset=0.02))
    m.add(prism((0.08, 0.84, -h + 0.06, h - 0.06), (0.08, 0.7, -h + 0.1, h - 0.1), 1.04, zc - 0.06, M_GLASS, GLASS))
    m.add(box(0.06, 0.72, -h + 0.08, h - 0.08, zc - 0.06, zc, M_PAINT, P))
    m.add(box(-0.5, 0.06, -h + 0.02, h - 0.02, 0.42, zc + 0.12, M_PAINT, P, inset=0.03))  # sleeper
    m.add(prism((-0.1, 0.25, -h + 0.1, h - 0.1), (-0.1, 0.0, -h + 0.12, h - 0.12), zc, zc + 0.12, M_PAINT, P))
    for y in (-h - 0.02, h - 0.1):  # fuel tanks
        m.add(cyl((-0.15 + 0.4, y + 0.06, 0.4), 0.13, 0.22, "x", M_METAL, CHROME, bias=0.01))
    stacks = [(-0.56, -h + 0.08), (-0.56, h - 0.08)]
    for x, y in stacks: m.add(cyl((x, y, 1.15), 0.045, 0.85, "z", M_METAL, CHROME, n=10, bias=0.02))
    m.attach["exhaust"] = (stacks[0][0], stacks[0][1], 2.02); m.attach["exhaust_r"] = (stacks[1][0], stacks[1][1], 2.02)
    m.add(cyl((-0.95, 0, 0.5), 0.3, 0.03, "z", M_METAL, hexc("#6b6470")))  # fifth wheel
    m.attach["tow_hitch"] = (-0.95, 0, 0.55)
    m.add(box(L / 2 - 0.02, L / 2 + 0.08, -h + 0.04, h - 0.04, 0.3, 0.44, M_METAL, CHROME))
    for y in (-h - 0.1, h + 0.04): m.add(box(0.78, 0.84, y, y + 0.06, 1.1, 1.4, M_TRIM, DARK))
    m.light("head_l", "headlight", (L / 2 + 0.0, -h + 0.22, 0.55), (1, 0, 0), size=(0.04, 0.17, 0.1))
    m.light("head_r", "headlight", (L / 2 + 0.0, h - 0.22, 0.55), (1, 0, 0), size=(0.04, 0.17, 0.1))
    m.light("tail_l", "taillight", (-L / 2 - 0.01, -0.36, 0.36), (-1, 0, 0), size=(0.03, 0.1, 0.07))
    m.light("tail_r", "taillight", (-L / 2 - 0.01, 0.36, 0.36), (-1, 0, 0), size=(0.03, 0.1, 0.07))
    m.light("brake", "brake", (-0.51, 0, zc + 0.08), (-1, 0, 0), size=(0.025, 0.3, 0.035))
    wheels4(m, (1.0, -0.72, -1.12), W + 0.04, r, 0.3, state, missing=("m1r",) if wrecked else ())
    m.attach["driver"] = (0.45, -0.25, 0.95); m.attach["seat_passenger"] = (0.45, 0.25, 0.95); m.attach["door_driver"] = (0.45, -h - 0.2, 0.3)
    m.attach["engine"] = (1.05, 0, 1.0); m.attach["roof"] = (0.3, 0, zc); m.foot = (L, W); return m

def camper(kind, state):
    m = Model(); wrecked = state == "wrecked"; door_open = state == "door_open"
    if wrecked: m.xf = tilt(pitch=-0.06, roll=0.1, dz=-0.03)
    if state == "rusty": m.xf = tilt(roll=0.03, dz=-0.05)
    if kind == "trailer_camper":
        L, W, r = 2.05, 1.2, 0.22; h = W / 2; z0 = 0.3
        m.add(box(-L / 2, L / 2, -h, h, z0, 0.62, M_PAINT, P, inset=0.0))      # tintable lower band
        m.add(box(-L / 2, L / 2, -h, h, 0.62, 1.05, M_LIGHTBODY, CREAM))
        zt = 1.45 if not wrecked else 1.3
        m.add(prism((-L / 2, L / 2, -h, h), (-L / 2 + 0.28, L / 2 - 0.34, -h + 0.08, h - 0.08), 1.05, zt, M_LIGHTBODY, CREAM))
        m.add(box(-0.3, 0.2, -0.22, 0.22, zt, zt + 0.12, M_TRIM, WHITE, inset=0.03))  # roof vent
        m.add(box(L / 2 - 0.01, L / 2 + 0.01, -0.35, 0.35, 0.72, 1.0, M_GLASS, GLASS, bias=0.003))
        m.add(box(-0.5, 0.0, -h - 0.01, -h + 0.0, 0.72, 0.98, M_GLASS, GLASS, bias=0.003))
        xa = -0.1; door = (0.35, 0.75)
        tongue = L / 2 + 0.55
        m.add(rods([((L / 2, -0.4, z0 + 0.03), (tongue, 0, 0.32)), ((L / 2, 0.4, z0 + 0.03), (tongue, 0, 0.32))], 1.5, M_TRIM, DARK))
        m.add(box(tongue - 0.1, tongue + 0.05, -0.05, 0.05, 0.28, 0.38, M_METAL, CHROME))
        m.add(rods([((tongue - 0.25, 0, 0.32), (tongue - 0.25, 0, 0.0))], 1.4, M_METAL, CHROME))
        m.add(box(L / 2 + 0.05, L / 2 + 0.35, -0.2, 0.2, 0.33, 0.55, M_TRIM, hexc("#6a8fb0")))  # propane box
        m.attach["hitch"] = (tongue + 0.03, 0, 0.33)
        wheels4(m, (xa,), W + 0.06, r, 0.18, state, missing=("fl",) if wrecked else ())
        zl = 0.42; tail_x = -L / 2 - 0.01; zdoor = (z0 + 0.04, 1.2); ztop = zt
    else:  # motorhome (class C) / camper_van (pop-top campervan)
        cv = kind == "camper_van"
        L, W, r = (2.7, 1.24, 0.25) if cv else (3.3, 1.36, 0.28); h = W / 2; z0 = 0.24 if cv else 0.26
        xh = 0.72 if cv else 0.95  # hood start
        m.add(prism((xh, L / 2, -h + 0.06, h - 0.06), (xh, L / 2 - 0.12, -h + 0.1, h - 0.1), z0, 0.78 if cv else 0.82, M_PAINT, P))
        m.add(prism((xh + 0.05, L / 2 - 0.12, -h + 0.1, h - 0.1), (xh + 0.05, xh + 0.34, -h + 0.16, h - 0.16), 0.78 if cv else 0.82, 1.3, M_GLASS, GLASS))
        zt = (1.62 if not wrecked else 1.45) if cv else (2.0 if not wrecked else 1.8)
        m.add(box(-L / 2, xh + 0.07, -h, h, 0.34 if cv else 0.36, zt, M_LIGHTBODY, CREAM, inset=0.03))
        if cv:
            m.add(box(-L / 2 + 0.01, xh + 0.06, -h - 0.004, h + 0.004, 0.34, 0.8, M_PAINT, P, bias=0.004))  # two-tone lower half
            m.add(prism((-L / 2 + 0.12, xh - 0.05, -h + 0.08, h - 0.08), (-L / 2 + 0.3, xh - 0.25, -h + 0.14, h - 0.14), zt, zt + 0.2, M_PAINT, P, bias=0.02))  # pop-top
            m.add(box(-1.0, -0.2, -h - 0.01, -h + 0.0, 1.0, 1.4, M_GLASS, GLASS, bias=0.003))
            m.add(box(-1.15, -0.55, h - 0.0, h + 0.01, 1.0, 1.4, M_GLASS, GLASS, bias=0.003))
            m.add(cyl((-L / 2 - 0.06, 0.0, 0.85), 0.2, 0.05, "x", M_TYRE, hexc(TYRE), hub=(0.55, CHROME, M_METAL)))  # spare wheel
            door = (-0.1, 0.42); zl = 0.48; tail_x = -L / 2 - 0.01; zdoor = (0.38, 1.5); ztop = zt + 0.2
        else:
            m.add(prism((1.0, 1.55, -h + 0.02, h - 0.02), (1.0, 1.4, -h + 0.05, h - 0.05), 1.34, zt - 0.02, M_LIGHTBODY, CREAM))
            for y in (-h - 0.006, h - 0.004): m.add(box(-L / 2 + 0.02, 1.0, y, y + 0.01, 0.5, 0.75, M_PAINT, P, bias=0.01))  # swoosh band
            m.add(box(-L / 2 + 0.02, 1.0, -h - 0.007, -h + 0.0, 1.55, 1.64, M_PAINT, P, bias=0.01))
            m.add(box(-1.2, -0.3, -h - 0.01, -h + 0.0, 1.05, 1.45, M_GLASS, GLASS, bias=0.003))
            m.add(box(-1.4, -0.7, h - 0.0, h + 0.01, 1.05, 1.4, M_GLASS, GLASS, bias=0.003))
            m.add(box(-0.6, -0.1, -0.3, 0.3, zt, zt + 0.16, M_TRIM, WHITE, inset=0.03))  # AC unit
            m.add(box(-1.2, 0.8, h + 0.0, h + 0.08, 1.7, 1.82, M_TRIM, hexc("#7aa59a")))  # awning roll
            m.add(rods([((-L / 2 - 0.03, 0.3, 0.5), (-L / 2 - 0.03, 0.3, zt)), ((-L / 2 - 0.03, 0.5, 0.5), (-L / 2 - 0.03, 0.5, zt))], 0.9, M_METAL, CHROME))
            door = (-0.05, 0.45); zl = 0.45; tail_x = -L / 2 - 0.01; zdoor = (0.4, 1.7); ztop = zt
        m.add(box(L / 2 - 0.03, L / 2 + 0.05, -h + 0.06, h - 0.06, z0, z0 + 0.12, M_TRIM, TRIM))
        m.light("head_l", "headlight", (L / 2 - 0.05, -h + 0.2, 0.6), (1, 0, 0)); m.light("head_r", "headlight", (L / 2 - 0.05, h - 0.2, 0.6), (1, 0, 0))
        m.light("brake", "brake", (-L / 2 - 0.02, 0, zt - 0.08), (-1, 0, 0), size=(0.025, 0.26, 0.035))
        wheels4(m, (0.95, -0.85) if cv else (1.2, -0.9), W + 0.04, r, 0.24, state, missing=("rr",) if wrecked else ())
        xd = xh - 0.05 if cv else 0.95
        m.attach["driver"] = (xd, -0.25, 0.8); m.attach["seat_passenger"] = (xd, 0.25, 0.8); m.attach["door_driver"] = (xd + 0.1, -h - 0.2, 0.3)
        if cv: m.attach["seat_rear_l"] = (xd - 0.6, -0.25, 0.8); m.attach["seat_rear_r"] = (xd - 0.6, 0.25, 0.8)
        m.attach["exhaust"] = (-L / 2 + 0.2, -h + 0.15, 0.22); m.add(cyl((-L / 2 + 0.2, -h + 0.15, 0.22), 0.04, 0.1, "x", M_METAL, CHROME))
        m.attach["tow_hitch"] = (-L / 2 - 0.15, 0, 0.32); m.add(box(-L / 2 - 0.17, -L / 2, -0.03, 0.03, 0.27, 0.33, M_METAL, CHROME))
        m.attach["engine"] = (L / 2 - 0.25, 0, 0.84)
    # door on right side (+y)
    d0, d1 = door; yy = h
    if door_open:
        m.add(box(d0 - 0.02, d0 + 0.02, yy, yy + (d1 - d0), zdoor[0], zdoor[1], M_PAINT, P, bias=0.02))
        m.add(box(d0, d1, yy - 0.02, yy + 0.003, zdoor[0], zdoor[1], M_INTERIOR, hexc("#5a4038"), bias=0.006))
        m.add(box(d0 + 0.05, d1 - 0.05, yy, yy + 0.12, zdoor[0] - 0.12, zdoor[0] - 0.08, M_METAL, CHROME, bias=0.02))  # step
    else:
        m.add(box(d0, d1, yy - 0.005, yy + 0.008, zdoor[0], zdoor[1], M_PAINT, P, bias=0.006))
        m.add(box(d0 + 0.08, d1 - 0.08, yy + 0.008, yy + 0.012, zdoor[1] - 0.4, zdoor[1] - 0.12, M_GLASS, GLASS, bias=0.008))
    m.attach["door"] = ((d0 + d1) / 2, yy + 0.25, 0.0); m.attach["interior_entry"] = ((d0 + d1) / 2, yy + 0.05, zdoor[0])
    m.light("tail_l", "taillight", (tail_x, -h + 0.12, zl), (-1, 0, 0), size=(0.03, 0.1, 0.12))
    m.light("tail_r", "taillight", (tail_x, h - 0.12, zl), (-1, 0, 0), size=(0.03, 0.1, 0.12))
    m.light("porch", "porch", ((d0 + d1) / 2 + 0.25, yy + 0.02, zdoor[1] + 0.08), (0, 1, 0), size=(0.1, 0.03, 0.05), lens=HEAD)
    m.lights[-1] = ("porch", "porch", m.lights[-1][2], (0, 1, 0))
    m.attach["roof"] = (0, 0, ztop); m.attach["craft_station"] = (-0.45 if kind == "trailer_camper" else -1.0, -0.25, 0.4)
    m.attach["cook_station"] = (0.55 if kind == "trailer_camper" else 0.4, -0.3, 0.4)
    m.foot = (L, W)
    return m

def trailer(kind, state):
    m = Model(); wrecked = state == "wrecked"
    if state == "rusty": m.xf = tilt(roll=0.02, dz=-0.04)
    if state == "damaged": m.xf = tilt(roll=-0.03)
    spec = dict(flatbed=(3.2, 1.3, 0.2, (0.45, -0.45)), box=(3.4, 1.3, 0.22, (0.4, -0.05)), tanker=(3.4, 1.3, 0.22, (0.42, -0.02)),
                log=(3.2, 1.3, 0.2, (0.45, -0.45)), utility=(1.25, 1.0, 0.18, (0.0,)), livestock=(3.2, 1.3, 0.2, (0.45, -0.45)),
                semi_box=(5.2, 1.0, 0.24, ()), semi_flatbed=(5.2, 1.0, 0.24, ()))[kind]  # semi r 0.24 -> 0.5 m tyres, 1.4 m deck at true scale
    L, W, r, axl = spec; h = W / 2; semi_ = kind.startswith("semi_"); kind = kind[5:] if semi_ else kind
    xs = [-L / 2 + 0.55 + a for a in axl] if kind != "utility" else [-0.05]
    if kind in ("box", "tanker"): xs = [-L / 2 + 0.55, -L / 2 + 0.98]
    zd = r * 2 + 0.06
    if semi_: xs = [-L / 2 + 0.3, -L / 2 + 0.66]; zd = r * 2 + 0.2
    m.add(box(-L / 2, L / 2, -h + 0.08, h - 0.08, zd - 0.12, zd - 0.02, M_TRIM, DARK))
    if kind == "flatbed":
        m.add(box(-L / 2, L / 2, -h, h, zd - 0.02, zd + 0.06, M_WOOD, WOOD))
        for i in range(9): x = -L / 2 + 0.1 + i * (L - 0.2) / 8; m.add(box(x - 0.01, x + 0.01, -h, h, zd + 0.06, zd + 0.065, M_TRIM, hexc("#8d5f3a"), bias=0.01))
        m.add(box(-L / 2, L / 2, -h - 0.02, -h + 0.03, zd - 0.05, zd + 0.08, M_PAINT, P)); m.add(box(-L / 2, L / 2, h - 0.03, h + 0.02, zd - 0.05, zd + 0.08, M_PAINT, P))
        m.attach["cargo"] = (0, 0, zd + 0.07)
    elif kind == "box":
        zt = 1.95 if state != "wrecked" else 1.7
        m.add(box(-L / 2, L / 2, -h, h, zd - 0.02, zt, M_LIGHTBODY, WHITE, inset=0.02))
        for y in (-h - 0.005, h - 0.005): m.add(box(-L / 2 + 0.06, L / 2 - 0.06, y, y + 0.01, zd + 0.2, zt - 0.2, M_PAINT, P, bias=0.01))
        for i in range(2): m.add(box(-L / 2 - 0.012, -L / 2, -0.01 + (i - 0.5) * 0.02, 0.01 + (i - 0.5) * 0.02, zd + 0.05, zt - 0.05, M_METAL, CHROME, bias=0.004))
        nr = 13 if semi_ else 6  # side posts: long flat walls read as a real dry-van / cargo box at true scale
        for y in (-h - 0.008, h - 0.002):  # one prim per side, so the whole row depth-sorts with its wall (not per post)
            m.add(Prim([pl for i in range(1, nr) for pl in box(-L / 2 + i * L / nr - 0.012, -L / 2 + i * L / nr + 0.012, y, y + 0.01, zd + 0.02, zt - 0.04, M_TRIM, hexc("#d8d0c4")).polys], bias=0.012))
        m.attach["cargo"] = (0, 0, zd); m.attach["cargo_door"] = (-L / 2 - 0.25, 0, 0.0)
    elif kind == "livestock":
        zt = 1.75 if state != "wrecked" else 1.55; DK = hexc("#4a3a40")
        m.add(box(-L / 2 + 0.04, L / 2 - 0.04, -h + 0.04, h - 0.04, zd - 0.02, zt - 0.06, M_INTERIOR, DK))  # dark hold seen through slats
        m.add(box(-L / 2, L / 2, -h, h, zd - 0.02, zd + 0.08, M_PAINT, P))
        for i in range(5):
            z = zd + 0.22 + i * (zt - zd - 0.4) / 4
            for y0, y1 in ((-h - 0.01, -h + 0.03), (h - 0.03, h + 0.01)): m.add(box(-L / 2, L / 2, y0, y1, z, z + 0.1, M_PAINT if i % 2 == 0 else M_LIGHTBODY, P if i % 2 == 0 else CREAM, bias=0.01))
        for x in [-L / 2 + 0.02 + k * (L - 0.04) / 5 for k in range(6)]:
            for y in (-h - 0.012, h + 0.012): m.add(box(x - 0.03, x + 0.03, y - 0.02, y + 0.02, zd, zt, M_TRIM, TRIM, bias=0.02))
        m.add(box(L / 2 - 0.04, L / 2, -h, h, zd, zt, M_PAINT, P, bias=0.01))  # solid front wall
        m.add(box(-L / 2, -L / 2 + 0.04, -h, h, zd, zt, M_WOOD, WOOD, bias=0.01))  # rear ramp gate
        m.add(box(-L / 2 - 0.02, L / 2 + 0.02, -h - 0.02, h + 0.02, zt - 0.06, zt, M_LIGHTBODY, WHITE, inset=0.02))  # roof
        m.attach["cargo"] = (0, 0, zd); m.attach["cargo_door"] = (-L / 2 - 0.25, 0, 0.0)
    elif kind == "tanker":
        m.add(cyl((0.05, 0, zd + 0.48), 0.56, L / 2 - 0.08, "x", M_PAINT, P, cap_color=P, n=22))
        for x in (-0.9, 0.0, 0.9): m.add(cyl((x, 0, zd + 1.05), 0.12, 0.04, "z", M_METAL, CHROME, n=10, bias=0.05))
        for x in (-1.2, 1.3): m.add(cyl((x, 0, zd + 0.48), 0.575, 0.03, "x", M_METAL, CHROME, n=22, bias=0.02))
        m.add(rods([((-L / 2 + 0.05, 0.25, zd), (-L / 2 + 0.05, 0.25, zd + 1.0))], 0.9, M_METAL, CHROME, bias=0.1))
        m.attach["valve"] = (-L / 2 + 0.2, 0.0, zd - 0.05); m.attach["cargo"] = (0, 0, zd + 0.5)
    elif kind == "log":
        for x in (-1.1, 0.0, 1.1):
            m.add(box(x - 0.06, x + 0.06, -h, h, zd - 0.02, zd + 0.06, M_TRIM, DARK))
            for y in (-h + 0.04, h - 0.04): m.add(rods([((x, y, zd), (x, y, zd + 0.62))], 1.3, M_METAL, hexc("#6b6470"), bias=0.05))
        BARK = hexc("#8a5a3c"); RING = hexc("#e2b878")
        logs = [(-0.42, 0.21), (0.0, 0.21), (0.42, 0.21), (-0.21, 0.56), (0.21, 0.56)] if state != "wrecked" else [(-0.42, 0.21), (0.0, 0.21), (0.21, 0.56)]
        for i, (y, z) in enumerate(logs):
            m.add(cyl((0.05 + (i % 2) * 0.06, y, zd + z), 0.2, L / 2 + 0.05, "x", M_WOOD, BARK, cap_color=RING, n=12, bias=0.002 * i))
        m.attach["cargo"] = (0, 0, zd + 0.5)
    elif kind == "utility":
        m.add(box(-L / 2, L / 2, -h, h, zd - 0.02, zd + 0.02, M_TRIM, DARK))
        for (x0, x1, y0, y1) in ((-L / 2, L / 2, -h, -h + 0.05), (-L / 2, L / 2, h - 0.05, h), (-L / 2, -L / 2 + 0.05, -h, h), (L / 2 - 0.05, L / 2, -h, h)):
            m.add(box(x0, x1, y0, y1, zd, zd + 0.36, M_PAINT, P))
        m.add(rods([((-L / 2, -h, zd + 0.36), (L / 2, -h, zd + 0.36)), ((-L / 2, h, zd + 0.36), (L / 2, h, zd + 0.36))], 0.9, M_TRIM, DARK, bias=0.1))
        for y in (-h - 0.1, h + 0.1): m.add(prism((xs[0] - 0.26, xs[0] + 0.26, y - 0.06, y + 0.06), (xs[0] - 0.18, xs[0] + 0.18, y - 0.06, y + 0.06), zd - 0.02, zd + 0.1, M_TRIM, DARK, bias=0.03))
        m.attach["cargo"] = (0, 0, zd + 0.05)
    if semi_:  # kingpin + landing gear instead of an A-frame tongue
        m.add(box(L / 2 - 0.5, L / 2, -0.3, 0.3, zd - 0.2, zd - 0.12, M_METAL, hexc("#6b6470")))
        m.attach["hitch"] = (L / 2 - 0.3, 0, zd - 0.18)
        for y in (-h + 0.1, h - 0.1):
            m.add(rods([((L / 2 - 1.0, y, zd - 0.12), (L / 2 - 1.0, y, 0.05))], 2.2, M_METAL, hexc("#8a8290")))
            m.add(box(L / 2 - 1.06, L / 2 - 0.94, y - 0.05, y + 0.05, 0.0, 0.03, M_METAL, hexc("#6b6470")))
        m.add(box(-L / 2 - 0.02, -L / 2 + 0.02, -h + 0.04, h - 0.04, 0.2, 0.3, M_TRIM, TRIM))  # under-ride guard
    tongue = L / 2 + (0.7 if kind != "utility" else 0.6)
    if not semi_: m.add(rods([((L / 2 - 0.1, -0.4, zd - 0.08), (tongue, 0, 0.32)), ((L / 2 - 0.1, 0.4, zd - 0.08), (tongue, 0, 0.32))], 1.6, M_TRIM, DARK))
    if not semi_: m.add(box(tongue - 0.12, tongue + 0.05, -0.05, 0.05, 0.27, 0.37, M_METAL, CHROME)); m.attach["hitch"] = (tongue + 0.03, 0, 0.32)
    if kind != "utility" and not semi_: m.add(rods([((L / 2 + 0.25, 0.12, zd - 0.1), (L / 2 + 0.25, 0.12, 0.02))], 1.3, M_METAL, CHROME))
    wheels4(m, xs, W + 0.06, r, 0.18, state, missing=("fl",) if wrecked else ())
    zl = zd - 0.08
    m.light("tail_l", "taillight", (-L / 2 - 0.02, -h + 0.08, zl), (-1, 0, 0), size=(0.03, 0.1, 0.06))
    m.light("tail_r", "taillight", (-L / 2 - 0.02, h - 0.08, zl), (-1, 0, 0), size=(0.03, 0.1, 0.06))
    m.foot = (L, W); return m

def bike(kind, state):
    m = Model(); wrecked = state == "wrecked"
    if wrecked: m.xf = tilt(roll=1.25, dz=0.03)
    F = P  # paint
    S = dict(road=(0.3, 1.02, 1.6), mountain=(0.3, 1.0, 2.6), bmx=(0.22, 0.8, 2.2), cargo=(0.28, 1.7, 1.9), tandem=(0.3, 1.75, 1.6),
             basic=(0.3, 1.02, 1.8), fat_tire=(0.32, 1.04, 2.6), cruiser=(0.3, 1.12, 1.9), trike=(0.26, 1.1, 1.9))[kind]
    r, wbase, tube = S; xr, xf_ = -wbase / 2, wbase / 2
    tyre_px = {"mountain": 2.4, "bmx": 2.0, "fat_tire": 4.4, "cruiser": 2.0}.get(kind, 1.5)
    if kind == "cargo": xf_ = wbase / 2; r_f = 0.2
    else: r_f = r
    wf = bike_wheel(xf_, 0, r_f, tyre_px) if not wrecked else []
    if kind == "trike":  # twin rear wheels on an axle + rear basket
        m.add(bike_wheel(xr, -0.3, r, tyre_px), bike_wheel(xr, 0.3, r, tyre_px), wf)
        m.add(rods([((xr, -0.3, r), (xr, 0.3, r))], 1.6, M_METAL, CHROME))
        m.add(box(xr - 0.2, xr + 0.16, -0.24, 0.24, r + 0.12, r + 0.15, M_WOOD, hexc("#a87446")))
        for (x0, x1, y0, y1) in ((xr - 0.2, xr + 0.16, -0.24, -0.21), (xr - 0.2, xr + 0.16, 0.21, 0.24), (xr - 0.2, xr - 0.17, -0.24, 0.24), (xr + 0.13, xr + 0.16, -0.24, 0.24)):
            m.add(box(x0, x1, y0, y1, r + 0.15, r + 0.34, M_WOOD, WOOD, bias=0.01))
        m.attach["cargo"] = (xr, 0, r + 0.16)
    else: m.add(bike_wheel(xr, 0, r, tyre_px), wf)
    m.attach["wheel_r"] = (xr, 0, r); m.attach["wheel_f"] = (xf_, 0, r_f)
    bb = (xr + 0.38 if kind != "bmx" else xr + 0.33, 0, r * 0.95)
    seat = (bb[0] - 0.1, 0, bb[2] + (0.5 if kind != "bmx" else 0.28))
    head = (xf_ - 0.12 if kind != "cargo" else xr + 0.88, 0, seat[2] + (0.02 if kind == "road" else 0.05))
    if kind == "tandem":
        bb2 = (bb[0] + 0.62, 0, bb[2]); seat2 = (seat[0] + 0.62, 0, seat[2]); head = (xf_ - 0.12, 0, seat[2] + 0.03)
        segs = [(bb, seat), (seat, seat2), (bb, bb2), (bb2, seat2), (seat2, head), (bb2, (head[0], 0, head[2] - 0.1)), ((xr, 0, r), bb), ((xr, 0, r), seat)]
        m.add(rods([(seat, (seat[0] + 0.25, 0, seat[2] + 0.05))], 1.0, M_METAL, CHROME))
        m.attach["seat_rear"] = (seat[0], 0, seat[2] + 0.03); m.attach["seat"] = (seat2[0], 0, seat2[2] + 0.03)
        seat_main = seat2
    else:
        top = (head[0] - 0.02, 0, head[2] - 0.06) if kind != "mountain" else (head[0], 0, head[2] - 0.12)
        segs = [(bb, seat), (seat, top), (bb, (head[0] + 0.01, 0, head[2] - 0.16)), ((xr, 0, r), bb), ((xr, 0, r), seat)]
        m.attach["seat"] = (seat[0], 0, seat[2] + 0.03); seat_main = seat
    if kind == "cargo":
        segs += [((head[0], 0, head[2] - 0.16), (xf_ - 0.45, 0, r_f + 0.08)), ((xf_ - 0.45, 0, r_f + 0.08), (xf_, 0, r_f))]
        m.add(box(xf_ - 0.62, xf_ + 0.05, -0.3, 0.3, r_f + 0.08, r_f + 0.12, M_WOOD, hexc("#a87446"), bias=0.0))
        for (x0, x1, y0, y1) in ((xf_ - 0.62, xf_ + 0.05, -0.3, -0.26), (xf_ - 0.62, xf_ + 0.05, 0.26, 0.3), (xf_ + 0.01, xf_ + 0.05, -0.3, 0.3), (xf_ - 0.62, xf_ - 0.58, -0.3, 0.3)):
            m.add(box(x0, x1, y0, y1, r_f + 0.12, r_f + 0.42, M_WOOD, WOOD, bias=0.01))
        m.attach["cargo"] = (xf_ - 0.28, 0, r_f + 0.14)
        fork_top = (head[0], 0, head[2] - 0.16); steer = (head[0], 0, head[2])
        fork = [(fork_top, steer)]
    else:
        fork = [((head[0], 0, head[2] - 0.16), (xf_, 0, r_f)), ((head[0], 0, head[2] - 0.16), (head[0] - 0.02, 0, head[2] + 0.04))]
    m.add(rods(segs, tube, M_PAINT, F))
    m.add(rods(fork if not wrecked else fork[1:] or fork, tube * (1.3 if kind == "mountain" else 1.0), M_PAINT if kind != "mountain" else M_METAL, F if kind != "mountain" else hexc("#2f2a35")))
    hb = (head[0] - 0.02, 0, head[2] + 0.05)
    if kind == "road":
        bars = [((hb[0], -0.16, hb[2]), (hb[0], 0.16, hb[2])), ((hb[0], -0.16, hb[2]), (hb[0] + 0.07, -0.16, hb[2] - 0.1)), ((hb[0], 0.16, hb[2]), (hb[0] + 0.07, 0.16, hb[2] - 0.1))]
    else:
        w = {"mountain": 0.26, "fat_tire": 0.28, "cruiser": 0.3}.get(kind, 0.2)
        if kind == "cruiser": hb = (hb[0] - 0.08, 0, hb[2] + 0.06)
        bars = [((hb[0], -w, hb[2] + 0.03), (hb[0], w, hb[2] + 0.03)), ((hb[0], 0, hb[2] - 0.03), (hb[0], 0, hb[2] + 0.03))]
    if kind == "tandem": bars += [((seat[0] + 0.25, -0.14, seat[2] + 0.06), (seat[0] + 0.25, 0.14, seat[2] + 0.06))]
    m.add(rods(bars, 1.0, M_TRIM, DARK))
    for s_ in ([seat_main, seat] if kind == "tandem" else [seat_main]):
        m.add(prism((s_[0] - 0.1, s_[0] + 0.08, -0.05, 0.05), (s_[0] - 0.1, s_[0] + 0.06, -0.06, 0.06), s_[2], s_[2] + 0.04, M_TRIM, hexc("#5a3e36"), bias=0.03))
    m.add(cyl(bb, 0.06, 0.03, "y", M_METAL, CHROME, n=10, bias=0.01))
    if kind == "bmx":
        m.add(rods([((xr, -0.08, r), (xr, -0.2, r)), ((xr, 0.08, r), (xr, 0.2, r))], 1.5, M_METAL, CHROME, bias=0.02))
    if kind == "mountain":
        m.add(rods([((bb[0] - 0.1, 0, bb[2] + 0.25), (xr + 0.12, 0, r + 0.12))], 2.4, M_METAL, hexc("#e8a33c")))
    m.light("head", "headlight", (hb[0] + 0.05, 0, hb[2] - 0.06) if kind != "cargo" else (xf_ + 0.06, 0, r_f + 0.3), (1, 0, 0), size=(0.04, 0.06, 0.05))
    m.light("tail", "taillight", (seat_main[0] - 0.14 if kind != "tandem" else seat[0] - 0.14, 0, seat[2] - 0.08), (-1, 0, 0), size=(0.03, 0.05, 0.05))
    m.attach["handlebar"] = hb; m.attach["bell"] = (hb[0], 0.12, hb[2] + 0.03)
    m.add(cyl((hb[0], 0.12, hb[2] + 0.04), 0.025, 0.02, "z", M_METAL, hexc("#f1c84b"), n=8, bias=0.04))
    m.foot = (wbase + 2 * r, 0.4 if kind != "trike" else 0.8)
    if wrecked: m.foot = (wbase + 2 * r, 0.7); m.foot_c = (0.0, -0.4); m.shadow_flat = True  # lying on its side
    return m

FAMILIES = {
    "bikes": [("bike_basic", lambda s: bike("basic", s)), ("bike_fat_tire", lambda s: bike("fat_tire", s)), ("bike_cruiser", lambda s: bike("cruiser", s)),
              ("bike_trike", lambda s: bike("trike", s)), ("bike_road", lambda s: bike("road", s)), ("bike_mountain", lambda s: bike("mountain", s)), ("bike_bmx", lambda s: bike("bmx", s)),
              ("bike_cargo", lambda s: bike("cargo", s)), ("bike_tandem", lambda s: bike("tandem", s))],
    "cars": [(f"car_{k}", (lambda k: lambda s: car(k, s))(k)) for k in ("sedan", "hatchback", "sports", "pickup", "suv", "wagon", "flatbed")],
    "vans": [("van_minivan", lambda s: car("minivan", s)), ("van_delivery", lambda s: van("delivery_van", s)), ("truck_box", lambda s: van("box_truck", s)),
             ("truck_semi_cab", lambda s: semi(s))],
    "campers": [("camper_trailer", lambda s: camper("trailer_camper", s)), ("camper_motorhome", lambda s: camper("motorhome", s)), ("camper_van", lambda s: camper("camper_van", s))],
    "trailers": [(f"trailer_{k}", (lambda k: lambda s: trailer(k, s))(k)) for k in ("flatbed", "box", "tanker", "log", "livestock", "semi_box", "semi_flatbed")],
    "trailers_small": [("trailer_utility", lambda s: trailer("utility", s))],
}
STATES = {"bikes": ["intact", "wrecked", "rusty"], "cars": ["intact", "damaged", "wrecked", "rusty"], "vans": ["intact", "damaged", "wrecked", "rusty"],
          "campers": ["intact", "door_open", "damaged", "wrecked", "rusty"], "trailers": ["intact", "damaged", "rusty"], "trailers_small": ["intact", "damaged", "rusty"]}

# ---------------------------------------------------------------- true-size fit (docs/VEHICLES_RENDER.md targets)
SEAT_NAMES = ("driver", "seat", "seat_passenger", "seat_rear", "seat_rear_l", "seat_rear_r")

def model_extent(m):
    pts = [v for pr in m.prims for v, *_ in pr.polys] + [np.stack([a, b]) for pr in m.prims for a, b, *_ in pr.rods]
    P_ = np.concatenate(pts); return P_.min(0), P_.max(0)

def fit_factors(m, Lpx, Hpx, Wt):
    """(sx, sy, sz) so the intact model's bumper-to-bumper length = Lpx (E view, U px/m), roof = Hpx (ZK px/m), body width = Wt m."""
    mn, mx = model_extent(m)
    sx = Lpx / U / max(1e-6, mx[0] - mn[0]); sz = Hpx / ZK / max(1e-6, mx[2]); sy = Wt / max(1e-6, m.foot[1])
    return sx, sy, sz

def apply_fit(m, f, seat_m=None):
    """Scale an authored model to its real-world size. Wheels (car discs and bike rims) stay round ON SCREEN in the E/W view:
    their radius follows the vertical scale and their x half-axis is multiplied by KR = ZK/U (30.29 vs 45.25 px per m)."""
    sx, sy, sz = f; S = np.array([sx, sy, sz]); kw = sz
    rk = math.sqrt(sx * sz); WR = np.array([kw * KR, sy, kw])
    for pr in m.prims:
        c = getattr(pr, "center", None)
        for v, *_ in pr.polys:
            if c is not None:
                d = v - c; v[:] = c * S + d * WR
            else: v *= S
        if c is not None and getattr(pr, "name", "") == "bike_wheel":
            pr.rods = [(c * S + (a - c) * WR, c * S + (b - c) * WR, rp * rk, mt, col) for a, b, rp, mt, col in pr.rods]
        else:
            pr.rods = [(a * S, b * S, rp * rk, mt, col) for a, b, rp, mt, col in pr.rods]
        if c is not None: pr.center = c * S
    m.attach = {n: tuple(np.array(p) * S) for n, p in m.attach.items()}
    if seat_m is not None:
        for n in SEAT_NAMES:
            if n in m.attach: x, y, _ = m.attach[n]; m.attach[n] = (x, y, seat_m)
    m.lights = [(n, k, tuple(np.array(p) * S), nr) for n, k, p, nr in m.lights]
    m.foot = (m.foot[0] * sx, m.foot[1] * sy)
    if hasattr(m, "foot_c"): m.foot_c = (m.foot_c[0] * sx, m.foot_c[1] * sy)
    return m
