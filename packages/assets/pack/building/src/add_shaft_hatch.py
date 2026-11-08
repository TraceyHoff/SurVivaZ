"""Add-only Shaft Hatch packer; never rebuilds or renumbers existing building art.

Run from repo root: python3 packages/assets/pack/building/src/add_shaft_hatch.py
Then lock:ids:pack, gen_icon_css.py, and encode only the changed atlas pages.
The catalog also marks this piece append-only for future complete pack builds.
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import build

ROOT = Path(__file__).resolve().parents[5]
BLD = ROOT / "packages/assets/pack/building"
ITEM = ROOT / "packages/assets/pack/items"
PREVIEW = Path("/workspace/assets/preview/shaft_hatch.png")


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.write_text(json.dumps(data, indent=1) + "\n")


def last_frame(man, atlas):
    frames = []
    for s in man["sprites"]:
        if s["atlas"] != atlas:
            continue
        for anim in s["animations"].values():
            frames.extend(anim["frames"])
        b = s.get("building", {})
        for row in b.get("frames", []):
            frames.extend(row)
        for rows in b.get("states", {}).values():
            for row in rows:
                frames.extend(row)
    return max(frames, default=-1)


def append_page(path, cw, ch, cols, start, cells):
    old = Image.open(path).convert("RGBA")
    rows = max(old.height // ch, math.ceil((start + len(cells)) / cols))
    size = (cols * cw, rows * ch)
    assert max(size) <= 2048
    page = Image.new("RGBA", size)
    page.paste(old, (0, 0))
    for i, cell in enumerate(cells, start):
        xy = (i % cols * cw, i // cols * ch)
        page.paste(cell, xy)
    page.save(path, optimize=True)
    return rows


def emit():
    man = read(BLD / "manifest.building.json")
    item = read(ITEM / "manifest.items.json")
    art = {}
    for tier in range(1, 5):
        key = f"bld_shaft_hatch_t{tier}"
        ak = f"building_t{tier}"
        atlas = next(a for a in man["atlases"] if a["key"] == ak)
        existing = next((s for s in man["sprites"] if s["key"] == key), None)
        start = existing["building"]["frames"][0][0] if existing else last_frame(man, ak) + 1
        cells = []
        for rot in range(4):
            _, result = build.render((tier, "shaft_hatch", rot))
            assert not any(clip for _, clip in result), (tier, rot, "clipped")
            cells.extend(im for im, _ in result)
        art[tier] = cells
        atlas["rows"] = append_page(BLD / atlas["image"], 84, 96, 24, start, cells)
        frames = [[start + r * 4 + st for st in range(4)] for r in range(4)]
        def sprite(skey, piece):
            return {"key": skey, "category": "building", "atlas": ak,
                    "anchor": {"x": .5, "y": .75},
                    "animations": {"idle": {"frames": [start], "fps": 1}},
                    "building": {"piece": piece, "footprint": {"w": 1, "h": 1},
                                 "layer": 0, "frames": frames, "crackOverlay": "bld_crack"},
                    "rotationArt": "unique4"}
        if not existing:
            man["sprites"].append(sprite(key, f"shaft_hatch@tier{tier}"))
            if tier == 1:
                man["sprites"].append(sprite("bld_shaft_hatch", "shaft_hatch"))
        print(ak, frames)
    write(BLD / "manifest.building.json", man)

    # Existing build-window pipeline: matching dedicated icons in items_build.
    atlas = next(a for a in item["atlases"] if a["key"] == "items_build")
    old = next((s for s in item["sprites"] if s["key"] == "build_shaft_hatch_t1"), None)
    start = old["animations"]["idle"]["frames"][0] if old else last_frame(item, "items_build") + 1
    icons = []
    for tier in range(1, 5):
        im = art[tier][0]
        crop = im.crop(im.getbbox())
        crop.thumbnail((56, 48), Image.Resampling.LANCZOS)
        icon = Image.new("RGBA", (64, 64))
        icon.paste(crop, ((64 - crop.width) // 2, (64 - crop.height) // 2))
        icons.append(icon)
        if not old:
            item["sprites"].append({"key": f"build_shaft_hatch_t{tier}", "category": "ui",
                "atlas": "items_build", "anchor": {"x": .5, "y": .5},
                "animations": {"idle": {"frames": [start + tier - 1], "fps": 1}}})
    atlas["rows"] = append_page(ITEM / atlas["image"], 32, 32, atlas["columns"], start,
                                 [i.resize((32, 32), Image.Resampling.LANCZOS) for i in icons])
    append_page(ITEM / atlas["pages"][0]["image"], 64, 64, atlas["columns"], start, icons)
    write(ITEM / "manifest.items.json", item)
    print("items_build", list(range(start, start + 4)))

    # Native / enlarged required keys, rotations, baked damage, old-art comparison.
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    preview = Image.new("RGB", (1100, 1000), "#292c35")
    d = ImageDraw.Draw(preview)
    def label(x, y, text):
        d.text((x, y), text, font=font, fill="#f6e6bf")
    def tile(im, x, y, scale=1):
        im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
        preview.paste(im, (x, y), im)
    label(20, 12, "SurVivaZ | Shaft Hatch | original ground-rim trapdoors, closed and standable")
    for col, tier in enumerate([1, 1, 2, 3, 4]):
        x = 20 + col * 215
        label(x, 42, "shaft_hatch" if col == 0 else f"shaft_hatch@tier{tier}")
        tile(art[tier][0], x + 55, 45)
        tile(art[tier][0], x + 12, 120, 2)
    label(20, 330, "Four unique hinge facings (rot 0..3) | damage 0 intact, 1 scuffed, 2 cracked, 3 wrecked")
    for tier in range(1, 5):
        y = 350 + (tier - 1) * 110
        label(20, y + 5, f"Tier {tier} rots")
        for rot in range(4):
            tile(art[tier][rot * 4], 135 + rot * 100, y)
        label(560, y + 5, f"Tier {tier} damage")
        for st in range(4):
            tile(art[tier][st], 700 + st * 95, y)
    label(20, 805, "existing, not reused | floor_hatch_frame / foundation at the same tier")
    for tier in range(1, 5):
        x = 20 + (tier - 1) * 270
        label(x, 835, f"Tier {tier}")
        for j, piece in enumerate(["floor_hatch_frame", "foundation"]):
            s = next(s for s in man["sprites"] if s["key"] == f"bld_{piece}_t{tier}")
            a = next(a for a in man["atlases"] if a["key"] == s["atlas"])
            f = s["building"]["frames"][0][0]
            page = Image.open(BLD / a["image"]).convert("RGBA")
            xx, yy = f % 24 * 84, f // 24 * 96
            tile(page.crop((xx, yy, xx + 84, yy + 96)), x + j * 100, 850)
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    preview.save(PREVIEW)
    print(PREVIEW)


if __name__ == "__main__":
    emit()
