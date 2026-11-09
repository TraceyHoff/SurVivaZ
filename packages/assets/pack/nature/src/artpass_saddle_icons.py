#!/usr/bin/env python3
"""Saddle inventory icons, one per mount tier (saddle_leather / saddle_reinforced / saddle_iron / saddle_steel).

32x32 + @2x cells blitted into the four free nature_icons cells 124-127 (0-123 used; nothing else moves),
painted with the shared items painter in CEL mode (flat fills, one hard shade, hard highlight, bold dark outline),
binary alpha (no soft ground shadow). Appends the four item sprites to manifest.nature.json, re-encodes nature_icons
KTX2. Then: pnpm --filter @engine/assets lock:ids:pack ; python3 packages/assets/pack/vehicle_items/src/gen_icon_css.py
Not the bike `item_saddle` (vehicle part) - that icon is untouched."""
import json, os, sys, subprocess, tempfile
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
sys.path.insert(0, os.path.join(ROOT, "assets/tools")); sys.path.insert(0, os.path.join(ROOT, "packages/assets/pack/items/src"))
import draw
from draw import C, lt, dk
NATURE = os.path.join(ROOT, "packages/assets/pack/nature"); ATLAS = os.path.join(NATURE, "atlases"); MAN = os.path.join(NATURE, "manifest.nature.json")
FRAMES = {"saddle_leather": 124, "saddle_reinforced": 125, "saddle_iron": 126, "saddle_steel": 127}

def blanket(c, col, y0=17.5, y1=24.5, x0=5.0, x1=27.0, scallop=False, rounded=True):
    if scallop:
        pts = [(x0, y0), (x1, y0), (x1, y1 - 1)] + [(x1 - (i + .5) * (x1 - x0) / 5, y1 + (1.4 if i % 2 == 0 else -.2)) for i in range(5)] + [(x0, y1 - 1)]
        c.poly(pts, col, shade=.25)
    else: c.rect(x0, y0, x1, y1, col, r=3.0 if rounded else 1.0, shade=.25)

def saddle_leather(c):
    """basic leather: soft rounded red blanket, plain low seat, one thin girth strap."""
    blanket(c, '#e4604e', 17, 24, 6, 26)
    c.line([(7, 18.6), (25, 18.6)], .7, '#fff2d8', 230)
    c.poly([(8, 18), (9.5, 13.5), (13, 15.2), (19, 15.2), (22, 12.8), (24.4, 13.4), (23.5, 18.2)], '#c07a46', shade=.3)
    c.line([(11, 15.6), (21, 15.6)], .5, '#7a4630', 200)
    c.rect(14.2, 18, 16.6, 28, '#874e32', r=.6)          # single girth strap
    c.shine(10.4, 14.4, .8, 200)

def saddle_reinforced(c):
    """reinforced: thicker square green pad with stitched border, raised cantle + horn, buckled double girth, saddlebag."""
    blanket(c, '#86b94f', 16.5, 24.5, 4.5, 27.5, rounded=False)
    for x in np.arange(6, 27, 2.0): c.line([(x, 17.7), (x + 1, 17.7)], .6, '#fff6dc', 240); c.line([(x, 23.3), (x + 1, 23.3)], .6, '#fff6dc', 240)
    c.poly([(7, 17.6), (7.6, 10.6), (10.4, 10.2), (12.4, 14.4), (19.6, 14.4), (22, 10.8), (23.6, 9.6), (25, 10.6), (24.4, 17.8)], '#874e32', shade=.3)
    c.ell(23.9, 10.0, 1.5, 1.2, '#633828')               # saddle horn
    for x in np.arange(10, 22, 1.6): c.dot(x, 15.4, .35, '#e8c090', 230)
    c.rect(11.6, 17.6, 13.6, 28.4, '#633828', r=.5); c.rect(17.4, 17.6, 19.4, 28.4, '#633828', r=.5)
    c.rect(11.0, 24.8, 14.2, 26.8, '#e0a032', r=.4, shade=.2); c.rect(16.8, 24.8, 20.0, 26.8, '#e0a032', r=.4, shade=.2)
    c.rect(2.6, 15.0, 7.8, 21.4, '#c07a46', r=1.2, shade=.3)   # saddlebag
    c.rect(2.8, 15.0, 7.6, 17.2, '#874e32', r=.8); c.dot(5.2, 17.6, .6, '#e0a032')
    c.shine(9.2, 12.0, .8, 200)

def saddle_iron(c):
    """iron: tall flat iron cantle + iron pommel plate with rivets, blue pad, riveted iron flank plate, chain girth."""
    blanket(c, '#4f8fd6', 16.5, 23.5, 4.5, 27.5, rounded=False)
    c.poly([(9, 22.5), (23, 22.5), (24, 28.2), (8, 28.2)], '#b4c2cc', shade=.3)       # flank plate
    for x in (10, 13, 16, 19, 22): c.dot(x, 25.4, .6, '#56637a')
    c.poly([(8.4, 17.2), (13, 14.8), (19.4, 14.8), (23.6, 17.2)], '#874e32', shade=.3)
    c.poly([(5.6, 17.6), (6.6, 7.6), (11.4, 7.0), (11.6, 16.4)], '#b4c2cc', shade=.32)  # iron cantle
    c.poly([(21, 16.4), (22.4, 9.2), (26.2, 9.0), (25.6, 16.8)], '#b4c2cc', shade=.32)  # iron pommel plate
    for x, y in ((7.6, 9.4), (9.8, 9.2), (7.6, 14.8), (9.8, 14.8), (23.4, 11.2), (24.8, 11.2), (24.0, 14.8)): c.dot(x, y, .55, '#56637a')
    for y in (18.4, 20.4): c.ell(16.2, y, 1.1, .8, '#7e8ea0', shade=.2)
    c.shine(7.6, 8.6, .8, 220)

def saddle_steel(c):
    """steel: high curved polished steel cantle with gold trim + gem, scalloped steel barding, purple pad, pennant."""
    c.stroke([(6.2, 12), (6.2, 2.8)], .9, '#61402e')                                    # pennant pole
    c.poly([(6.6, 2.8), (12.6, 4.2), (6.6, 6.2)], '#e85d4f', shade=.2)
    blanket(c, '#9b72d6', 16.5, 23.0, 4.0, 28.0, scallop=True)
    for i in range(3):
        x0 = 6 + i * 7.0
        c.poly([(x0, 22.0), (x0 + 6.6, 22.0), (x0 + 6.6, 26.2), (x0 + 3.3, 28.8), (x0, 26.2)], '#d6e2ee', shade=.3)
        c.dot(x0 + 3.3, 25.0, .8, '#ffd45a')
    c.poly([(8.4, 17.2), (13, 15.0), (19.4, 15.0), (23.6, 17.2)], '#c07a46', shade=.3)
    c.poly([(4.8, 17.6), (5.4, 9.6), (8.0, 6.2), (11.6, 7.6), (12.0, 16.4)], '#d6e2ee', shade=.32)   # high curved cantle
    c.stroke([(5.6, 9.8), (8.0, 6.8), (11.2, 8.0)], .8, '#ffd45a', ol=False)
    c.poly([(20.6, 16.4), (21.8, 10.2), (24.2, 8.2), (26.6, 10.2), (26.0, 16.8)], '#d6e2ee', shade=.32)  # pommel
    c.ell(24.0, 11.6, 1.5, 1.5, '#4f8fd6', shade=.2); c.shine(23.5, 11.0, .5, 230)                 # gem
    c.shine(7.4, 9.6, .8, 230)

PAINTERS = {"saddle_leather": saddle_leather, "saddle_reinforced": saddle_reinforced, "saddle_iron": saddle_iron, "saddle_steel": saddle_steel}

def render_icon(fn):
    was = draw.CEL; draw.CEL = True
    try:
        c = C(32, 8); fn(c); out = []
        for px in (32, 64):
            a = np.asarray(c.out(px).convert("RGBA")).copy(); a[..., 3] = np.where(a[..., 3] >= 128, 255, 0); a[a[..., 3] == 0] = 0
            out.append(Image.fromarray(a, "RGBA"))
        return out
    finally: draw.CEL = was

def main(check_free=True):
    sheets = {sc: Image.open(os.path.join(ATLAS, n)).convert("RGBA") for sc, n in ((1, "nature_icons.png"), (2, "nature_icons@2x.png"))}
    for key, fr in FRAMES.items():
        imgs = render_icon(PAINTERS[key])
        for sc, im in ((1, imgs[0]), (2, imgs[1])):
            fw = 32 * sc; x, y = (fr % 16) * fw, (fr // 16) * fw; sh = sheets[sc]
            if check_free: assert np.asarray(sh.crop((x, y, x + fw, y + fw)))[..., 3].max() == 0 or os.environ.get("SADDLE_ICONS_REPAINT"), f"cell {fr} not free"
            cell = Image.new("RGBA", (fw, fw), (0, 0, 0, 0)); cell.paste(im, (0, 0)); sh.paste(cell, (x, y))
        print("painted", key, "->", fr)
    for sc, n in ((1, "nature_icons.png"), (2, "nature_icons@2x.png")): sheets[sc].save(os.path.join(ATLAS, n), optimize=True)
    raw = open(MAN).read(); have = {s["key"] for s in json.loads(raw)["sprites"]}
    new = [{"key": k, "category": "item", "atlas": "nature_icons", "anchor": {"x": 0.5, "y": 0.5}, "animations": {"idle": {"frames": [f], "fps": 1}}} for k, f in FRAMES.items() if k not in have]
    if new:
        i = raw.find('"sprites"'); lb = raw.find("[", i); dep = 0
        for j in range(lb, len(raw)):
            if raw[j] == "[": dep += 1
            elif raw[j] == "]":
                dep -= 1
                if dep == 0: close = j; break
        ins = ",\n" + ",\n".join("\n".join(" " + ln for ln in json.dumps(o, indent=1).splitlines()) for o in new)
        raw = raw[:close] + ins + raw[close:]; json.loads(raw); open(MAN, "w").write(raw)
    for n in ("nature_icons.png", "nature_icons@2x.png"):
        src = os.path.join(ATLAS, n); dst = os.path.splitext(src)[0] + ".ktx2"
        sys.path.insert(0, os.path.join(ROOT, "assets/tools")); from ktx2 import dilate  # noqa
        fd, tmp = tempfile.mkstemp(suffix=".png"); os.close(fd)
        try:
            dilate(Image.open(src).convert("RGBA")).save(tmp, compress_level=1)
            subprocess.run(["toktx", "--t2", "--genmipmap", "--assign_oetf", "srgb", "--encode", "etc1s", "--clevel", "2", "--qlevel", "192", dst, tmp], check=True)
        finally: os.remove(tmp)
    print("saddle icons done")

if __name__ == "__main__":
    main()
