#!/usr/bin/env python3
"""Live-pack v1 crouch contact sheet. Usage: python3 assets/customization/tools/crouch_preview.py REPO OUTPUT.png"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from block_preview import Pack

def preview(p, out):
    outfits = [
        ["hair_pixie", "top_hoodie", "bottom_jeans", "shoes_sneakers", "acc_bandana", "face_smile", "eyes_round"],
        ["hair_ponytail", "hat_cap", "top_flannel", "bottom_shorts", "shoes_hiking_boots", "acc_gear_cloth_mask", "face_freckles", "eyes_lashes"],
    ]
    missing = [k for keys in outfits for k in keys if k not in p.W]
    assert not missing, missing
    steps = [("idle", 0, "stand"), ("crouch_idle", 0, "c-idle 0"), ("crouch_idle", 1, "c-idle 1"),
             ("crouch_walk", 0, "c-walk 0"), ("crouch_walk", 1, "c-walk 1"), ("crouch_walk", 2, "c-walk 2"), ("crouch_walk", 3, "c-walk 3")]
    colw, rowh, left, top = 96, 168, 36, 40
    im = Image.new("RGB", (left + len(steps) * colw + 16, top + 2 * 2 * 8 * rowh + 20), "#d4dfd5")
    dr = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
    dr.text((12, 8), "SurVivaZ | dedicated crouch_idle / crouch_walk  |  E SE S SW W NW N NE  |  next to standing idle", font=font, fill="#283c34")
    for bi, bt in enumerate(("male", "female")):
        for oi, keys in enumerate(outfits):
            label = "bandana" if "acc_bandana" in keys else "cloth mask"
            for d, dname in enumerate(("E", "SE", "S", "SW", "W", "NW", "N", "NE")):
                row = bi * 16 + oi * 8 + d
                y = top + row * rowh
                dr.text((6, y + 70), f"{bt[0]} {label} {dname}", font=font, fill="#283c34")
                if d == 0 and oi == 0:
                    for ci, (_, _, sl) in enumerate(steps):
                        dr.text((left + ci * colw + 8, y - 14), sl, font=font, fill="#283c34")
                for ci, (anim, fi, _) in enumerate(steps):
                    doll = p.doll(bt, keys, d, anim, fi)
                    im.paste(doll, (left + ci * colw, y), doll)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    im.save(out, optimize=True)
    print("wrote", out, im.size)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("root"); ap.add_argument("output")
    args = ap.parse_args(); preview(Pack(args.root), args.output)
