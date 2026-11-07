#!/usr/bin/env python3
"""Append status-effect HUD icons painted with the uikit (same Ink style as the st_* icons in uikit/icons.py)
to the UI atlas: broken_leg plus nine dedicated temperature / wetness tier icons.

The tier motifs are original silhouettes, not copies of vital_*, st_* or icon_temp*.
Flat fills + explicit hard shades use Ink outlines without its soft interior shading.

Append-only, like add_temp_icons.py: free fully-transparent space with 2px padding in ui_atlas(.png/.json),
@2x at identical 2x coordinates; never moves existing frames. Idempotent (repaints in place).
Run after gen_kit.py if the kit is regenerated:  python3 assets/ui/tools/add_status_icons.py
"""
import json, os, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from uikit.icon import Ink
from uikit.kit import P, INK
from uikit.draw import blob, star

ATL = os.path.join(HERE, '..', 'atlas')
PAD = 2


def broken_leg(c):
    """Chunky cartoon leg whose shin kinks the wrong way: zigzag crack, puffy bruise, ouch-star. Body-part crop, no gore."""
    skin = '#FFC9A0'
    c.part([(4.5, 1.5), (13.5, 1.5), (13.0, 8.5), (5.0, 9.5)], P['blue-500'])                         # shorts
    c.part([(5.6, 8.0), (12.8, 7.4), (13.4, 15.2), (18.6, 17.4), (15.8, 23.6), (7.6, 18.2)], skin)       # thigh + knee + upper shin
    c.part([(13.4, 15.2), (20.2, 15.0), (26.4, 25.4), (20.4, 27.6), (15.4, 23.0)], skin)                               # lower shin, bent off-axis
    c.part([(20.4, 24.6), (25.8, 24.0), (30.2, 27.2), (29.8, 30.2), (20.8, 30.2)], P['red-500'])          # sneaker
    c.line([(21.2, 29.0), (29.6, 29.0)], P['white'], 1.0)
    c.part(blob(16.4, 18.6, 3.4, 2.8, wob=0.3, seed=51), P['berry-300'], ow=1.2)                         # swollen bump
    zz = [(13.8, 15.6), (16.2, 17.0), (14.8, 18.6), (18.0, 19.8), (16.8, 21.6)]
    c.line(zz, INK, 1.5); c.line(zz, P['white'], 0.6)                                                     # crack
    c.part(star(25.5, 8.5, 6.4, 2.9, 5, wob=0.2, seed=52), P['sun-300'], ow=1.2)                          # ouch!
    c.line([(20.0, 14.6), (21.8, 13.0)], INK, 1.0); c.line([(22.2, 16.6), (24.2, 15.8)], INK, 1.0)
    c.shine(7.4, 4.5, 1.0, 1.6, 190); c.shine(8.6, 12.0, 0.9, 1.6, 170)


# Keep the kit's soft antialiased ink edge, but paint opaque, hard-edged cel interiors.
def cel(c, pts, color, ow=1.25):
    return c.part(pts, color, shade=False, gloss=False, ow=ow)


def bead(c, x, y, size=4):
    """A tiny angular falling bead, never the existing thirst-drop silhouette."""
    cel(c, [(x, y-size/2), (x+size*.32, y), (x+size*.24, y+size*.4),
            (x-size*.24, y+size*.4), (x-size*.32, y)], '#54BFE5', .65)
    c.line([(x-.4, y), (x-.4, y+.6)], '#DDFBFF', .7)


def chilly(c):
    """A little exhaled breath ribbon, trailing into a pale rime-edged puff."""
    cel(c, [(3,19),(7,16),(11,17),(14,12),(17,12),(18,8),(23,7),
            (27,10),(27,13),(29,15),(28,19),(24,21),(20,20),
            (17,23),(13,21),(10,22),(7,20)], '#C5EDF4')
    c.poly([(10,19),(15,18),(19,19),(23,17),(27,17),(25,20),
            (21,20),(17,22),(13,20)], '#78B5D1')
    c.line([(16,14),(20,11),(23,11)], '#F2FFFF', 1.8)
    c.line([(3,25),(7,24)], '#7ACBDC', 1.5)
    c.line([(20,23),(20,25)], INK, 1.4)
    c.line([(25,22),(25,24)], INK, 1.2)


def cold(c):
    """Faceted ice spires: asymmetric crystal silhouette, no snowflake."""
    cel(c, [(4,25),(3,16),(8,12),(13,23),(12,8),(18,3),(23,10),
            (21,21),(26,14),(29,17),(27,27),(16,29)], '#67C7EE')
    c.poly([(12,8),(18,3),(18,24),(15,27)], '#D6F8FF')
    c.poly([(18,3),(23,10),(21,24),(18,27)], '#3E88CB')
    c.poly([(4,16),(8,13),(11,25),(8,24)], '#A9F0FA')
    c.poly([(25,18),(28,17),(26,25),(23,27)], '#B3F4FF')
    c.line([(13,9),(17,6)], '#FFFFFF', 1.1)
    c.line([(7,27),(16,28),(24,26)], '#285C99', 1.2)


def freezing(c):
    """Tiny shivering survivor gripped in an ice shell; no beanie-head reuse."""
    cel(c, [(7,27),(5,16),(9,19),(8,8),(13,12),(17,3),(21,12),
            (26,7),(25,20),(28,18),(26,29)], '#7CB9ED')
    c.poly([(8,15),(9,26),(15,28),(12,19)], '#C0F5FF')
    cel(c, [(11,11),(13,7),(19,7),(22,12),(21,18),(12,18)], '#CBEFF7', .9)
    c.line([(13,12),(15,13)], INK, 1.1)
    c.line([(18,13),(20,12)], INK, 1.1)
    c.line([(14,16),(15.5,15.3),(17,16),(18.5,15.3)], '#4C5482', .8)
    cel(c, [(11,19),(15,18),(20,20),(22,25),(17,27),(10,24)], '#647DD1', .9)
    c.line([(11,20),(19,23),(21,21)], '#D8F8FF', 1.6)
    c.line([(4,9),(2.5,12),(4,14)], '#5893C7', 1.4)
    c.line([(28,23),(29.5,26),(28,29)], '#5893C7', 1.4)


def hot(c):
    """Low half-sun over heat-haze bands, not the existing full sun badge."""
    for pts in [[(16,3),(16,6)],[(6,7),(8,9)],[(25,7),(23,9)]]:
        c.line(pts, INK, 2.4); c.line(pts, '#F4B84C', 1.1)
    cel(c, [(6,20),(6,15),(9,11),(13,9),(18,9),(23,12),(25,16),(25,20)], '#FFBC52')
    c.poly([(18,10),(23,13),(24,18),(8,18),(8,20),(25,20),(25,16),(23,12)], '#E77D36')
    c.line([(10,14),(13,12)], '#FFF4AC', 1.7)
    for pts in [[(3,22),(9,21),(16,23),(23,21),(28,22)],
                [(7,27),(13,26),(19,28),(25,26)]]:
        c.line(pts, INK, 2.7); c.line(pts, '#F5A34C', 1.2)


def sweltering(c):
    """Drooping, sweating head beneath three harsh heat strokes."""
    for x, y in [(7,4),(16,2),(25,4)]:
        c.line([(x,y),(x-1,y+3),(x+1,y+5)], '#AD4A3D', 1.7)
    cel(c, [(7,13),(11,9),(21,9),(25,13),(24,22),(20,27),
            (12,26),(7,21)], '#FFA465')
    c.poly([(20,10),(24,13),(23,21),(19,26),(14,25),(18,23),(21,18)], '#E7754E')
    cel(c, [(8,13),(10,10),(14,9),(15,12),(20,10),(24,13),
            (23,15),(18,14),(14,15),(10,14)], '#864842', .7)
    c.line([(10,18),(13,19)], INK, 1.2)
    c.line([(18,19),(21,18)], INK, 1.2)
    c.line([(13,23),(17,22),(19,23)], INK, 1.0)
    bead(c, 5, 22, 5); bead(c, 27, 18, 6)
    c.poly([(9,15),(11,15),(10,17)], '#FFF0B4')


def overheating(c):
    """Emergency heat alarm: red diamond and rising heat, no heart or skull."""
    for pts in [[(9,3),(8,5),(10,7)],[(16,2),(15,4),(17,6)],[(23,3),(22,5),(24,7)]]:
        c.line(pts, INK, 2.5); c.line(pts, '#FF754A', 1.2)
    cel(c, [(16,7),(29,18),(16,30),(3,18)], '#F26442', 1.5)
    c.poly([(16,8),(28,18),(16,29),(16,25),(23,18)], '#BD3D42')
    c.poly([(5,18),(16,9),(16,12),(8,19)], '#FFB661')
    # Large pale warning mark survives the 11px chip reduction.
    cel(c, [(14,13),(18,13),(17.5,21),(14.5,21)], '#FFF3BA', .7)
    cel(c, [(14.5,23),(17.5,23),(17.5,25.5),(14.5,25.5)], '#FFF3BA', .6)


def damp(c):
    """Small folded linen swatch, one damp corner and two sparse beads."""
    cel(c, [(5,8),(20,6),(25,12),(23,24),(6,25)], '#E8E0BA')
    c.poly([(7,21),(16,20),(18,16),(24,15),(23,24),(6,25)], '#91BBC5')
    c.poly([(6,9),(19,7),(20,10),(7,12)], '#FFF7DB')
    cel(c, [(20,6),(19,12),(25,12)], '#B7AC91', .7)
    c.line([(9,15),(15,14)], '#B7B69F', .85)
    bead(c, 27, 21, 3); bead(c, 25, 28, 3)


def wet(c):
    """Long hanging towel with a saturated, actively dripping lower edge."""
    cel(c, [(9,3),(23,5),(24,11),(22,26),(18,25),(15,28),(8,25),(7,12)], '#8DD1D9')
    c.poly([(18,5),(23,5),(24,11),(22,26),(18,25),(15,28),(12,26),(16,18)], '#398EBE')
    c.poly([(9,5),(12,4),(12,20),(9,23),(8,13)], '#DAF9EE')
    c.line([(14,8),(14,16)], '#EFFEF8', 1.4)
    c.line([(9,24),(9,28)], INK, 2.2); c.line([(9,24),(9,28)], '#52B8D9', 1)
    bead(c, 20, 29, 3); bead(c, 27, 20, 4); bead(c, 4, 18, 3)


def soaked(c):
    """Twisted waterlogged rag above a broad puddle, heavy squeeze streams."""
    cel(c, [(3,24),(8,21),(22,21),(28,24),(29,27),(24,29),
            (8,29),(3,27)], '#3388BE', 1.0)
    c.poly([(6,25),(12,23),(22,23),(26,25),(21,26),(10,27)], '#7FE0EA')
    for x, y in [(10,17),(16,18),(23,17)]:
        c.line([(x,y),(x-1,y+6)], INK, 2.5)
        c.line([(x,y),(x-1,y+6)], '#68D4EB', 1.2)
    cel(c, [(3,8),(7,6),(13,11),(21,6),(27,8),(29,13),
            (25,18),(19,15),(12,19),(6,16)], '#69B9C8')
    c.poly([(4,9),(7,7),(14,13),(20,9),(23,8),(19,14),
            (12,18),(9,15)], '#B9F1EA')
    c.poly([(20,10),(26,9),(28,13),(25,17),(19,14),(15,17)], '#317BA8')
    c.line([(9,9),(11,12),(10,15)], '#326C92', 1.2)
    bead(c, 4, 20, 4); bead(c, 28, 20, 3)


TIER_ICONS = {'chilly': chilly, 'cold': cold, 'freezing': freezing,
              'hot': hot, 'sweltering': sweltering, 'overheating': overheating,
              'damp': damp, 'wet': wet, 'soaked': soaked}
ICONS = {'broken_leg': broken_leg, **TIER_ICONS}


def render(fn, sc):
    c = Ink(32, 32, sc); fn(c); return c.out()


def main():
    j1 = json.load(open(os.path.join(ATL, 'ui_atlas.json'))); j2 = json.load(open(os.path.join(ATL, 'ui_atlas@2x.json')))
    p1 = Image.open(os.path.join(ATL, 'ui_atlas.png')).convert('RGBA'); p2 = Image.open(os.path.join(ATL, 'ui_atlas@2x.png')).convert('RGBA')
    W, H = p1.size; occ = bytearray(W * H)
    def mark(x, y, w, h):
        for yy in range(max(0, y - PAD), min(H, y + h + PAD)):
            a, b = max(0, x - PAD), min(W, x + w + PAD); occ[yy * W + a: yy * W + b] = b'\x01' * (b - a)
    for k, f in j1['frames'].items():
        if k in ICONS: continue
        r = f['frame']; mark(r['x'], r['y'], r['w'], r['h'])
    al = p1.getchannel('A').load()
    def free(x, y, w, h):
        for yy in range(y - PAD, y + h + PAD):
            if any(occ[yy * W + x - PAD: yy * W + x + w + PAD]): return False
        return all(al[xx, yy] == 0 for yy in range(y, y + h) for xx in range(x, x + w))
    for k, fn in ICONS.items():
        ims = {1: render(fn, 1), 2: render(fn, 2)}; w, h = ims[1].size
        if k in j1['frames']:
            r = j1['frames'][k]['frame']; x, y = r['x'], r['y']
        else:
            x = y = None
            for yy in range(PAD, H - h - PAD):
                for xx in range(PAD, W - w - PAD):
                    if free(xx, yy, w, h): x, y = xx, yy; break
                if x is not None: break
            if x is None: raise SystemExit('no free space for ' + k)
        mark(x, y, w, h)
        for sc, j, p in ((1, j1, p1), (2, j2, p2)):
            im = ims[sc]; X, Y = x * sc, y * sc; ww, hh = im.size
            p.paste((0, 0, 0, 0), (X, Y, X + ww, Y + hh)); p.alpha_composite(im, (X, Y))
            j['frames'][k] = {"frame": {"x": X, "y": Y, "w": ww, "h": hh}, "rotated": False, "trimmed": False,
                              "spriteSourceSize": {"x": 0, "y": 0, "w": ww, "h": hh}, "sourceSize": {"w": ww, "h": hh},
                              "pivot": {"x": 0.5, "y": 0.5}, "tags": ["icon", "hud", "status"]}
        print(k, (x, y))
    p1.save(os.path.join(ATL, 'ui_atlas.png'), optimize=True); p2.save(os.path.join(ATL, 'ui_atlas@2x.png'), optimize=True)
    json.dump(j1, open(os.path.join(ATL, 'ui_atlas.json'), 'w'), indent=1); json.dump(j2, open(os.path.join(ATL, 'ui_atlas@2x.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
