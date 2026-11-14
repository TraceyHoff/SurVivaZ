"""Composite previews of whole roofs from the per-piece art (roofs_select reference selection)."""
import numpy as np
from PIL import Image, ImageDraw
import roofs_lib as R, roofs_select as RS
_cache = {}
def art(kind, d, mat=""):
    key = (kind, tuple(sorted(d.items())), mat)
    if key not in _cache:
        if kind == "piece":
            p = R.Piece(d["form"], d["seg"], d["shape"], d["row"], d["var"], d["crest"]); _cache[key] = R.render_piece(p, d["tier"], mat=mat)
        elif kind == "verge": _cache[key] = R.render_verge(d["form"], d["seg"], d["kind"], d["row"], d["tier"], mat=mat)
        elif kind == "wall": _cache[key] = R.render_wall(d["form"], d["which"], d["row"], d["tier"], mat=mat)
        else: _cache[key] = R.render_chimney(d["tier"], mat=mat if (d["tier"], mat) in R.CHIMNEY_EXTRA else "")
    return _cache[key]

def walls(can, cells, ox, oy, H=40, col=(196, 160, 120)):
    """plain context walls (not shipped art): S and E faces of the footprint."""
    m = set(cells); dr = ImageDraw.Draw(can)
    for (x, y) in sorted(m, key=lambda c: c[0] + c[1]):
        cx, cy = ox + (x - y) * 32, oy + (x + y) * 16
        if (x, y + 1) not in m: dr.polygon([(cx - 32, cy), (cx, cy + 16), (cx, cy + 16 - H), (cx - 32, cy - H)][::-1], fill=col, outline=(90, 60, 50))
        if (x + 1, y) not in m: dr.polygon([(cx, cy + 16), (cx + 32, cy), (cx + 32, cy - H), (cx, cy + 16 - H)], fill=tuple(int(c * 0.8) for c in col), outline=(90, 60, 50))

def compose(cells, form, size=(520, 400), origin=None, wall_h=40, mat="", wall_col=(196, 160, 120), bg=(176, 214, 150, 255), **kw):
    can = Image.new("RGBA", size, bg)
    xs = [c[0] - c[1] for c in cells]; ys = [c[0] + c[1] for c in cells]
    ox = origin[0] if origin else size[0] // 2 - (max(xs) + min(xs)) * 16
    oy = origin[1] if origin else size[1] // 2 - (max(ys) + min(ys)) * 8 + 24
    walls(can, cells, ox, oy, wall_h, tuple(int(v) for v in wall_col))
    for (x, y, (kind, d), z) in RS.select(cells, form, **kw):
        im = art(kind, d, mat)
        can.alpha_composite(im, (ox + (x - y) * 32 - R.PX, oy + (x + y) * 16 - wall_h - z - R.PY))
    return can
