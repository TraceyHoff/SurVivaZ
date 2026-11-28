"""Preview sheet for the electricity-tier art from the shipped pages (what the game loads), beside the 53 px player doll.
python3 packages/assets/pack/building/src/elec_preview.py <out.png> <title> key1,key2,...
Per piece: rot-0 unlit | two active frames | night view (base darkened + emissive mask + bloom) [| facing 2 active] [| damage 3].
Yellow line = the doll's head (53 px = 1.75 m); cards at @2x (1x for the very tall classes)."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops, ImageFont
import numpy as np
ROOT = Path(__file__).resolve().parents[5]; BLD = ROOT / 'packages/assets/pack/building'
out, title, keys = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
man = json.loads((BLD / 'manifest.building.json').read_text()); S = {s['key']: s for s in man['sprites']}; A = {a['key']: a for a in man['atlases']}
BG, INK, HEAD = (118, 160, 104), (40, 30, 44), (255, 214, 60)
try: F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 13); FS = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 11)
except OSError: F = FS = ImageFont.load_default()

def doll():
    """53 px mannequin (1x): head + torso + legs, solid cel, feet on the bottom row."""
    im = Image.new('RGBA', (24, 54), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    skin, shirt, pants, ink = (246, 204, 170), (88, 140, 220), (70, 70, 96), (42, 28, 46)
    d.rectangle([7, 36, 10, 53], fill=pants, outline=ink); d.rectangle([13, 36, 16, 53], fill=pants, outline=ink)
    d.rounded_rectangle([5, 18, 18, 38], 3, fill=shirt, outline=ink); d.rectangle([2, 20, 5, 33], fill=skin, outline=ink); d.rectangle([18, 20, 21, 33], fill=skin, outline=ink)
    d.ellipse([4, 1, 19, 18], fill=skin, outline=ink); d.point([(9, 9), (14, 9)], fill=ink); d.line([(10, 13), (13, 13)], fill=ink)
    return im

def frame(page, a, i, sc):
    w, h = a['frameW'] * sc, a['frameH'] * sc; x, y = (i % a['columns']) * w, (i // a['columns']) * h
    return page.crop((x, y, x + w, y + h))

def night(col, em):
    c = np.asarray(col).astype(np.float32); e = np.asarray(em).astype(np.float32)
    base = c.copy(); base[..., :3] *= np.array([.28, .3, .46]); a = e[..., 3:4] / 255
    rgb = base[..., :3] * (1 - a) + e[..., :3] * a
    out = Image.fromarray(np.concatenate([rgb, np.maximum(base[..., 3:4], e[..., 3:4])], -1).clip(0, 255).astype(np.uint8), 'RGBA')
    bloom = em.filter(ImageFilter.GaussianBlur(4))
    return Image.alpha_composite(out, Image.fromarray((np.asarray(bloom).astype(np.float32) * [1, 1, 1, .8]).astype(np.uint8), 'RGBA'))

cards = []
for k in keys:
    s = S[k]; a = A[s['atlas']]; sc = 2 if a['frameW'] * 2 * 5 <= 1100 and a['frameH'] <= 200 else 1
    if sc == 2 and not a.get('pages'):   # 1x-only pages (building_t5, like building_t4): nearest x2 for the cards
        up = lambda im: im.resize((im.width * 2, im.height * 2), Image.NEAREST)
        col = up(Image.open(BLD / a['image']).convert('RGBA')); em = up(Image.open(BLD / a['masks']['emissive']).convert('RGBA'))
    else:
        col = Image.open(BLD / (a['pages'][0]['image'] if sc == 2 else a['image'])).convert('RGBA')
        emp = (a['masks']['emissive'].replace('.png', '@2x.png') if sc == 2 else a['masks']['emissive'])
        em = Image.open(BLD / emp).convert('RGBA')
    idle = s['animations']['idle']; un = s['animations']['unlit']
    rots = idle.get('rotations', [idle['frames']]); unr = un.get('rotations', [un['frames']])
    lit0 = rots[0]; tiles = [frame(col, a, unr[0][0], sc), frame(col, a, lit0[0], sc), frame(col, a, lit0[len(lit0) // 2], sc),
                            night(frame(col, a, lit0[0], sc), frame(em, a, lit0[0], sc))]
    if len(rots) > 1: tiles.append(frame(col, a, rots[1][0], sc))
    fr = (s.get('building') or {}).get('frames') or [[]]
    if len(set(fr[0])) == 4: tiles.append(frame(col, a, fr[0][3], sc))   # baked damage stage 3 (tiered building pieces)
    fw, fh = a['frameW'] * sc, a['frameH'] * sc; oy = round(s['anchor']['y'] * a['frameH']) * sc
    dl = doll().resize((24 * sc, 54 * sc), Image.NEAREST)
    W = 10 + dl.width + 6 + len(tiles) * (fw + 4); H = fh + 34
    card = Image.new('RGBA', (W, H), BG + (255,)); d = ImageDraw.Draw(card)
    card.alpha_composite(dl, (10, 18 + oy - dl.height + sc))
    for j, t in enumerate(tiles):
        x = 10 + dl.width + 6 + j * (fw + 4)
        if j == 3: d.rectangle([x, 18, x + fw - 1, 18 + fh - 1], fill=(24, 26, 44))
        card.alpha_composite(t, (x, 18))
    d.line([(6, 18 + oy - 53 * sc), (W - 4, 18 + oy - 53 * sc)], fill=HEAD, width=1)
    nm = f"{k}  {s['rotationArt']}  {a['frameW']}x{a['frameH']}  idle {len(lit0)}f@{idle['fps']}  ({'x2' if sc == 2 else 'x1'})"
    d.text((8, 2), nm, fill=INK, font=FS)
    d.text((10 + dl.width + 6, H - 14), 'unlit | active | active | night+emissive' + (' | facing 2' if len(rots) > 1 else ''), fill=INK, font=FS)
    cards.append(card)
MAXW = 1400; rows = [[]]; wsum = 0
for c in cards:
    if rows[-1] and wsum + c.width > MAXW: rows.append([]); wsum = 0
    rows[-1].append(c); wsum += c.width + 6
H = 30 + sum(max(c.height for c in r) + 6 for r in rows); W = min(MAXW, max(sum(c.width + 6 for c in r) for r in rows))
sheet = Image.new('RGB', (W, H), (92, 128, 84)); d = ImageDraw.Draw(sheet); d.text((8, 8), title, fill=(255, 255, 255), font=F)
y = 30
for r in rows:
    x = 0
    for c in r: sheet.paste(c, (x, y + max(cc.height for cc in r) - c.height)); x += c.width + 6
    y += max(c.height for c in r) + 6
sheet.save(out, optimize=True); print(out, sheet.size)
