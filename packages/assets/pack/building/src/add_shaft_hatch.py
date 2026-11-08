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
        if existing:   # shipped closed cells/records are never repainted or renumbered
            continue
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
    if not old:
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


EXTRA = Path("/workspace/assets/preview/shaft_hatch_extras.png")
TIER_LABEL = {0: "twig", 1: "wood", 2: "stone", 3: "metal", 4: "reinforced"}


def register_extras():
    """Render-only piece entries (not in PIECES, so full pack builds never emit them)."""
    import pieces as PC
    PC.TIER_NAMES[0] = "twig"
    PC.PIECES.setdefault("shaft_hatch_open", ("boxes", lambda t: PC.shaft_hatch(t, "open"), 0, 4, False, False))
    PC.PIECES.setdefault("shaft_hatch_bottom", ("boxes", PC.shaft_hatch_bottom, 0, 4, False, False))
    PC.OLD_ROWS["shaft_hatch_open"] = 0
    PC.OLD_ROWS["shaft_hatch_bottom"] = 0


def cells_for(tier, key):
    cells = []
    for rot in range(4):
        _, result = build.render((tier, key, rot))
        assert not any(clip for _, clip in result), (tier, key, rot, "clipped")
        cells.extend(im for im, _ in result)
    return cells


def grid(start):
    return [[start + r * 4 + st for st in range(4)] for r in range(4)]


def bld_sprite(key, piece, atlas, frames, idle=None):
    return {"key": key, "category": "building", "atlas": atlas, "anchor": {"x": .5, "y": .75},
            "animations": {"idle": {"frames": [idle if idle is not None else frames[0][0]], "fps": 1}},
            "building": {"piece": piece, "footprint": {"w": 1, "h": 1}, "layer": 0,
                         "frames": frames, "crackOverlay": "bld_crack"},
            "rotationArt": "unique4"}


def add_states(s, closed, opened):
    s["animations"] = {"idle": {"frames": [closed[0][0]], "fps": 1},
                       "closed": {"frames": [closed[0][0]], "fps": 1},
                       "open": {"frames": [opened[0][0]], "fps": 1}}
    s["building"]["states"] = {"closed": closed, "open": opened}


def emit_extras():
    """Open lids + pit-floor landings for tiers 1-4, and the twig tier on building_tw.

    Append-only and idempotent: if a record already carries the new frames, those
    indices are reused; shipped closed frames 352-367 are never touched.
    """
    register_extras()
    man = read(BLD / "manifest.building.json")
    item = read(ITEM / "manifest.items.json")
    by = {s["key"]: s for s in man["sprites"]}
    art = {}
    for tier in range(0, 5):
        ak = "building_tw" if tier == 0 else f"building_t{tier}"
        atlas = next(a for a in man["atlases"] if a["key"] == ak)
        sfx = "" if tier == 0 else f"_t{tier}"
        pfx = "" if tier == 0 else f"@tier{tier}"
        hatch = by[f"bld_shaft_hatch{sfx}"]
        bottom = by.get(f"bld_shaft_hatch_bottom{sfx}")
        if tier == 0 and hatch["atlas"] == "building_tw" and "states" in hatch["building"]:
            start = hatch["building"]["frames"][0][0]
        elif tier == 0:
            start = last_frame(man, ak) + 1
        else:
            st = hatch["building"].get("states", {}).get("open")
            start = st[0][0] if st else last_frame(man, ak) + 1
        cells = {}
        keys = (["shaft_hatch"] if tier == 0 else []) + ["shaft_hatch_open", "shaft_hatch_bottom"]
        allc = []
        for k in keys:
            cells[k] = cells_for(tier, k)
            allc += cells[k]
        art[tier] = cells
        atlas["rows"] = append_page(BLD / atlas["image"], 84, 96, atlas["columns"], start, allc)
        off = start
        if tier == 0:
            closed = grid(off); off += 16
            hatch["atlas"] = ak
            hatch["building"]["frames"] = closed
        else:
            closed = hatch["building"]["frames"]
        opened = grid(off); off += 16
        add_states(hatch, closed, opened)
        bframes = grid(off)
        if bottom is None:
            man["sprites"].append(bld_sprite(f"bld_shaft_hatch_bottom{sfx}", f"shaft_hatch_bottom{pfx}", ak, bframes))
        print(ak, "closed", closed[0][0], "open", opened[0][0], "-", opened[-1][-1],
              "bottom", bframes[0][0], "-", bframes[-1][-1], "rows", atlas["rows"])
    write(BLD / "manifest.building.json", man)

    # Dedicated build-window icons: twig hatch, then bottom landings twig..reinforced.
    atlas = next(a for a in item["atlases"] if a["key"] == "items_build")
    ikeys = ["build_shaft_hatch_t0"] + [f"build_shaft_hatch_bottom_t{t}" for t in range(5)]
    srcs = [art[0]["shaft_hatch"][0]] + [art[t]["shaft_hatch_bottom"][0] for t in range(5)]
    existing = {s["key"]: s for s in item["sprites"]}
    start = existing[ikeys[0]]["animations"]["idle"]["frames"][0] if ikeys[0] in existing else last_frame(item, "items_build") + 1
    icons = []
    for i, (k, im) in enumerate(zip(ikeys, srcs)):
        crop = im.crop(im.getbbox())
        crop.thumbnail((56, 56), Image.Resampling.LANCZOS)
        icon = Image.new("RGBA", (64, 64))
        icon.paste(crop, ((64 - crop.width) // 2, (64 - crop.height) // 2))
        icons.append(icon)
        if k not in existing:
            item["sprites"].append({"key": k, "category": "ui", "atlas": "items_build", "anchor": {"x": .5, "y": .5},
                                    "animations": {"idle": {"frames": [start + i], "fps": 1}}})
    atlas["rows"] = append_page(ITEM / atlas["image"], 32, 32, atlas["columns"], start,
                                 [i.resize((32, 32), Image.Resampling.LANCZOS) for i in icons])
    append_page(ITEM / atlas["pages"][0]["image"], 64, 64, atlas["columns"], start, icons)
    write(ITEM / "manifest.items.json", item)
    print("items_build", dict(zip(ikeys, range(start, start + len(ikeys)))))

    # Preview: closed/open per tier at two rotations, landings, and icons.
    closed = {0: art[0]["shaft_hatch"]}
    for t in range(1, 5):
        pg = Image.open(BLD / f"atlases/building_t{t}.png").convert("RGBA")
        closed[t] = [pg.crop((f % 24 * 84, f // 24 * 96, f % 24 * 84 + 84, f // 24 * 96 + 96)) for f in range(352, 368)]
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    preview = Image.new("RGB", (1300, 1180), "#292c35")
    d = ImageDraw.Draw(preview)
    def tile(im, x, y, scale=1):
        im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
        preview.paste(im, (x, y), im)
    d.text((20, 10), "SurVivaZ | Shaft Hatch extras | closed rot0/rot1, open rot0/rot1, bottom landing rot0/rot1 (2x)",
           font=font, fill="#f6e6bf")
    heads = ["closed r0", "closed r1", "open r0", "open r1", "bottom r0", "bottom r1"]
    for j, h in enumerate(heads):
        d.text((150 + j * 180, 34), h, font=font, fill="#f6e6bf")
    for t in range(5):
        y = 52 + t * 200
        name = "shaft_hatch (twig)" if t == 0 else f"@tier{t} {TIER_LABEL[t]}"
        d.text((14, y + 80), name, font=font, fill="#f6e6bf")
        ims = [closed[t][0], closed[t][4], art[t]["shaft_hatch_open"][0], art[t]["shaft_hatch_open"][4],
               art[t]["shaft_hatch_bottom"][0], art[t]["shaft_hatch_bottom"][4]]
        for j, im in enumerate(ims):
            tile(im, 150 + j * 180, y, 2)
    for i, (k, ic) in enumerate(zip(ikeys, icons)):
        tile(ic, 150 + i * 180, 1060)
    preview.save(EXTRA)
    print(EXTRA)


if __name__ == "__main__":
    emit_extras()
