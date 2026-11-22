"""Before/after true-scale lineup: every vehicle key, E + SE view, beside the 53 px player doll, 1 m grid.
    python3 true_scale_preview.py <old manifest.vehicles.json> <old atlases dir> <new pack/vehicles dir> <doll.png> <out.png>
Grid: horizontal lines every 1 m of height (30.29 px), vertical lines every 1 m of length on the E view (45.25 px), from
the pivot (ground centre). Yellow line = the doll's head (53 px = 1.75 m). Default paint tint applied as in game."""
import sys, os, json, numpy as np
from PIL import Image, ImageDraw, ImageFont
OLDM, OLDA, NEWP, DOLL, OUT = sys.argv[1:6]
PXM_H, PXM_L = 53 / 1.75, 32 * 2 ** 0.5
try: font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 12); small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 10)
except Exception: font = small = ImageFont.load_default()
def hexc(h): return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
class Pack:
    def __init__(self, mpath, adir):
        self.m = json.load(open(mpath)); self.adir = adir; self.A = {a["key"]: a for a in self.m["atlases"]}; self.S = {s["key"]: s for s in self.m["sprites"]}; self.cache = {}
    def img(self, p):
        p = os.path.join(self.adir, os.path.basename(p))
        if p not in self.cache: self.cache[p] = np.asarray(Image.open(p).convert("RGBA"))
        return self.cache[p]
    def frame(self, key, d):
        s = self.S[key]; an = s["animations"]["intact"]
        if an.get("dirFrames"): f = an["dirFrames"][d]; a = self.A[f["atlas"]]; idx = f["frame"]; anc = f["anchor"]
        else: a = self.A[s["atlas"]]; idx = an["frames"][0] + d * an.get("dirStride", 1); anc = s["anchor"]
        c, r = idx % a["columns"], idx // a["columns"]; fw, fh = a["frameW"], a["frameH"]
        im = self.img(a["image"])[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw].astype(np.float32)
        tm = a.get("masks", {}).get("tintmask"); col = s.get("tints", {}).get("paint", {}).get("color")
        if tm and col:
            t = self.img(tm); t = (t[..., 0] if t.ndim == 3 else t)[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw].astype(np.float32)[..., None] / 255
            im[..., :3] = im[..., :3] * (1 + (hexc(col) / (0.78 * 255) - 1) * t)
        im = Image.fromarray(np.clip(im, 0, 255).astype(np.uint8)); bb = im.getbbox()
        return im.crop(bb), anc["x"] * fw - bb[0], anc["y"] * fh - bb[1]
old = Pack(OLDM, OLDA); new = Pack(os.path.join(NEWP, "manifest.vehicles.json"), os.path.join(NEWP, "atlases"))
doll = np.asarray(Image.open(DOLL).convert("RGBA")).copy(); g = doll[..., :3].astype(int)
doll[(g[..., 1] > g[..., 0] + 12) & (g[..., 1] > g[..., 2] + 12), 3] = 0; doll = Image.fromarray(doll)  # drop grass fringe
keys = [v["key"] for v in new.m["vehicles"] if "aliasOf" not in v and "stateOf" not in v]
BG, GRID, GRID2, HEAD, INK = (226, 232, 214, 255), (196, 205, 186, 255), (170, 182, 160, 255), (236, 178, 36, 255), (52, 36, 60, 255)
cells = []
for k in keys:
    row = []
    for tag, pk in (("before", old), ("after", new)):
        for d, dn in ((0, "E"), (1, "SE")): row.append((tag, dn) + pk.frame(k, d))
    cells.append((k, row))
LW, GAP, DW = 150, 18, 40
colw = [max(c[1][i][2].width + DW for _, c in [(None, r) for r in cells]) + GAP for i in range(4)] if False else None
colw = [max(r[1][i][2].width for r in cells) + DW + GAP for i in range(4)]
rowh = [int(max(max(c[4] for c in r[1]), 55) + max(c[2].height - c[4] for c in r[1]) + 34) for r in cells]
W = LW + sum(colw) + 20; H = 70 + sum(rowh)
sheet = Image.new("RGBA", (W, H), BG); dr = ImageDraw.Draw(sheet)
dr.text((10, 8), "SurVivaZ vehicles at true scale - before (left two columns, shipped d40bc37/211785f2 art) vs after (right two columns), E + SE views", fill=INK, font=font)
dr.text((10, 26), "player doll 53 px = 1.75 m | grid: 1 m of height = 30.3 px (horizontal lines), 1 m of length on the E view = 45.25 px (vertical lines) | yellow = doll head | roof heights are at the vehicle centreline; the sprite top also includes the far roof edge's iso depth", fill=INK, font=small)
x0s = [LW]; [x0s.append(x0s[-1] + w) for w in colw[:-1]]
for i, (t, w) in enumerate(zip(["BEFORE  E", "BEFORE  SE", "AFTER  E", "AFTER  SE"], colw)): dr.text((x0s[i] + DW, 46), t, fill=INK, font=font)
dr.line([(x0s[2] - GAP // 2, 44), (x0s[2] - GAP // 2, H)], fill=INK, width=2)
y = 70
for (k, row), rh in zip(cells, rowh):
    top_above = int(max(max(c[4] for c in row), 55)) + 6; gy = y + top_above
    dr.line([(0, y), (W, y)], fill=GRID2)
    for i, (tag, dn, im, px, py) in enumerate(row):
        x = x0s[i] + DW; cx = x + px; xe = x0s[i] + colw[i] - GAP
        for mm in range(0, 8):
            yy = gy - mm * PXM_H
            if yy < y + 2: break
            dr.line([(x0s[i] + 2, yy), (xe, yy)], fill=GRID if mm else GRID2)
        if dn == "E":
            for s_ in (-1, 1):
                for mm in range(0, 20):
                    xx = cx + s_ * mm * PXM_L
                    if xx < x0s[i] + DW - 2 or xx > xe: continue
                    dr.line([(xx, y + 4), (xx, gy + 10)], fill=GRID)
        dr.line([(x0s[i] + 2, gy - 53), (xe, gy - 53)], fill=HEAD)
        sheet.alpha_composite(doll, (x0s[i] + 4, gy - doll.height))
        sheet.alpha_composite(im, (int(round(x)), int(round(gy - py))))
    meta = next(v for v in new.m["vehicles"] if v["key"] == k)
    dr.text((8, y + 8), k, fill=INK, font=font); al = meta.get("aliases") or []
    if al: dr.text((8, y + 24), "= " + ", ".join(al), fill=INK, font=small)
    tp = meta["targetPx"]; dr.text((8, y + 38), f"target L {tp['length']} / roof {tp['height']} px", fill=INK, font=small)
    y += rh
sheet.convert("RGB").save(OUT, optimize=True); print(OUT, sheet.size)
