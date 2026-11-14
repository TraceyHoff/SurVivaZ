"""Add-only packer for the seamless neighbour-aware roof set (docs/ART_KEYS_ROOFS.md).

Run from repo root:  python3 packages/assets/pack/building/src/add_roofs.py [--material shk]
Then: oxipng the new pages, python3 assets/tools/ktx2.py packages/assets/pack/building/manifest.building.json
packages/assets/pack/items/manifest.items.json, pnpm --filter @engine/assets lock:ids:pack.
Owns only atlases `rfx_*`, sprites `rfx_*` and the roof-form build icons (`build_rfx_*`, `build_roof_{cottage,gambrel,shed}_*`); never touches build.py output, never renumbers
other sprites. Re-running rewrites its own pages/records in place."""
import json, sys, math, hashlib
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).parent))
import roofs_lib as R
from roofs_lib import S_, W_, N_, E_

ROOT = Path(__file__).resolve().parents[5]
BLD = ROOT / "packages/assets/pack/building"; ITEM = ROOT / "packages/assets/pack/items"
COLS = 28
PIECE_BASE = {"hip": "roof_slope", "cot": "roof_slope", "shd": "roof_slope", "gab": "roof_gable", "gam": "roof_gable", "flt": "roof_flat"}
PAGES = {"a": ("hip", "gab", "flt"), "b": ("cot", "gam", "shd")}

def rows_for(shape):
    if shape == "r": return [0, 1, 0, 1]
    if shape in ("p", "f"): return [0, 0, 0, 0]
    return [0, 1, 2, 3]

def sprite_specs(form, tier, mat=""):
    """-> list of (key, kind, params, rows) ; kind piece/verge/wall/chimney."""
    ms = f"_{mat}" if mat else ""
    T = f"{ms}_t{tier}"; out = []
    def piece(seg, shape, crest=False, var=0):
        sg = "" if (form == "flt" and shape == "f") else f"{seg}_"   # flat field has no eave seg (engine stem rfx_flt_f)
        k = f"rfx_{form}_{sg}{shape}{'c' if crest else ''}{f'_v{var}' if var else ''}{T}"
        out.append((k, "piece", dict(form=form, seg=seg, shape=shape, crest=crest, var=var), rows_for(shape)))
    def verge(seg, kind):
        out.append((f"rfx_{form}_{seg}_{kind}{T}", "verge", dict(form=form, seg=seg, kind=kind[1:] if kind in ("vel", "ver") else kind), [0, 1, 2, 3]))
    def wall(which=None):
        k = f"rfx_{form}_wall{'_' + which if which else ''}{T}"
        out.append((k, "wall", dict(form=form, which=which or "lo"), [0, 1, 2, 3]))
    if form in ("hip", "cot"):
        for s in "eoirhp": piece("lo", s)
        for s in "eoirhpf": piece("up", s)
        piece("lo", "e", crest=True); piece("up", "e", crest=True)
        for v in (1, 2): piece("lo", "e", var=v); piece("up", "e", var=v); piece("up", "f", var=v)
    elif form in ("gab", "gam"):
        for s in "er": piece("lo", s)
        for s in "erf": piece("up", s)
        piece("lo", "e", crest=True); piece("up", "e", crest=True)
        for v in (1, 2): piece("lo", "e", var=v); piece("up", "e", var=v); piece("up", "f", var=v)
        for k in ("vel", "ver", "vr"): verge("lo", k)
        for k in ("vel", "ver", "vr", "vf"): verge("up", k)
        if form == "gab": wall()
        else: wall("lo"); wall("up")
    elif form == "shd":
        for sg in ("lo", "up", "top", "lotop"): piece(sg, "e")
        for v in (1, 2): piece("lo", "e", var=v); piece("up", "e", var=v)
        for sg in ("lo", "up"):
            for k in ("vel", "ver"): verge(sg, k)
        wall()
    elif form == "flt":
        for s in "eoirhpf": piece("lo", s)
        for v in (1, 2): piece("lo", "f", var=v)
    return out

def render_spec(kind, p, row, tier, mat=""):
    if kind == "piece":
        pc = R.Piece(p["form"], p["seg"], p["shape"], row, p["var"], p["crest"])
        return R.render_piece(pc, tier, mat=mat)
    if kind == "verge": return R.render_verge(p["form"], p["seg"], p["kind"], row, tier, mat=mat)
    if kind == "wall": return R.render_wall(p["form"], p["which"], row, tier, mat=mat)
    return R.render_chimney(tier, mat=mat)

def build_page(name, specs_by_form, tier, mat=""):
    cells, index, sprites = [], {}, []
    def cell_of(im):
        h = hashlib.sha1(im.tobytes()).hexdigest()
        if h not in index: index[h] = len(cells); cells.append(im)
        return index[h]
    for form, specs in specs_by_form:
        for key, kind, p, rows in specs:
            cache = {}
            fr = []
            for r in rows:
                if r not in cache: cache[r] = cell_of(render_spec(kind, p, r, tier, mat))
                fr.append(cache[r])
            base = PIECE_BASE.get(form, "roof_chimney")
            sp = {"key": key, "category": "building", "atlas": name, "anchor": {"x": 0.5, "y": R.PY / R.CH},
                  "animations": {"idle": {"frames": [fr[0]], "fps": 1}},
                  "building": {"piece": f"{base}@{key}", "footprint": {"w": 1, "h": 1}, "layer": 0,
                               "frames": [[f, f, f, f] for f in fr], "crackOverlay": "bld_crack"},
                  "rotationArt": "unique4"}
            if kind == "chimney": sp["attach"] = {"smoke": {"x": 0.0, "y": float(-(R.CHIMNEY_TOP + 2))}}
            sprites.append(sp)
    rows_n = math.ceil(len(cells) / COLS)
    page = Image.new("RGBA", (COLS * R.CW, rows_n * R.CH))
    for i, c in enumerate(cells): page.paste(c, (i % COLS * R.CW, i // COLS * R.CH))
    assert max(page.size) <= 2048
    atlas = {"key": name, "image": f"atlases/{name}.png", "frameW": R.CW, "frameH": R.CH, "columns": COLS, "rows": rows_n,
             "residency": "stream", "placeholder": None}
    return page, atlas, sprites

def read(p): return json.loads(p.read_text())
def write(p, d): p.write_text(json.dumps(d, indent=1) + "\n")

def main(mat=""):
    man = read(BLD / "manifest.building.json")
    prefix = f"rfx_{mat}_" if mat else "rfx_t"
    forms_tiers = R.MATERIAL_SETS[mat] if mat else None
    new_atlases, new_sprites = [], []
    for tier in range(5):
        for half, forms in (PAGES.items() if not mat else [("", [f for fs_ in PAGES.values() for f in fs_])]):   # a skin: one page per tier
            fs = [f for f in forms if (forms_tiers or R.TIERS_OF).get(f) and tier in (forms_tiers or R.TIERS_OF)[f]]
            if not fs: continue
            specs = [(f, sprite_specs(f, tier, mat)) for f in fs]
            if half == "a" and tier >= 1 and not mat: specs.append(("chimney", [(f"rfx_chimney_t{tier}", "chimney", {}, [0, 0, 0, 0])]))
            if mat and (tier, mat) in R.CHIMNEY_EXTRA: specs.append(("chimney", [(f"rfx_chimney_{mat}_t{tier}", "chimney", {}, [0, 0, 0, 0])]))
            name = f"rfx_{mat}_t{tier}" if mat else f"rfx_t{tier}_{half}"
            page, atlas, sprites = build_page(name, specs, tier, mat)
            page.save(BLD / atlas["image"]); new_atlases.append(atlas); new_sprites += sprites
            print(name, page.size, len(sprites), "sprites", atlas["rows"] * COLS, "slots")
    names = {a["key"] for a in new_atlases}
    man["atlases"] = [a for a in man["atlases"] if a["key"] not in names] + new_atlases
    keys = {s["key"] for s in new_sprites}
    man["sprites"] = [s for s in man["sprites"] if s["key"] not in keys] + new_sprites
    write(BLD / "manifest.building.json", man)
    print("sprites", len(new_sprites), "frames", sum(len({f for r in s["building"]["frames"] for f in r}) for s in new_sprites))
    return new_atlases, new_sprites

# ------------------------------------------------------------------ build-menu icons (one per form per tier)
ICON_CELLS = {"hip": ([(x, y) for x in range(2) for y in range(2)], {}), "gab": ([(x, y) for x in range(2) for y in range(2)], {"axis": "EW"}),
              "cot": ([(x, y) for x in range(2) for y in range(2)], {}), "gam": ([(x, y) for x in range(2) for y in range(2)], {"axis": "EW"}),
              "shd": ([(x, y) for x in range(2) for y in range(2)], {"D": S_}), "flt": ([(x, y) for x in range(2) for y in range(2)], {})}

# new forms use the gameplay piece's own menu icon key (build_<pieceKey>_t<N>, ADR-398 icon lookup); hip/gab/flt can't
# reuse build_roof_{slope,gable,flat}_t<N> (legacy icons on items_build), so they stay build_rfx_<form>_t<N>.
ICON_KEY = {"cot": "build_roof_cottage", "gam": "build_roof_gambrel", "shd": "build_roof_shed"}

def icon_for(form, tier, mat=""):
    import roofs_preview as RP
    from cel import snap
    cells, kw = ICON_CELLS[form]
    can = RP.compose(cells, form, size=(260, 220), wall_h=30, tiers={c: tier for c in cells}, mat=mat, wall_col=R.C(R.mat_for(form, tier, mat)["wall"])[1], bg=(0, 0, 0, 0), **kw)
    bb = can.getbbox(); crop = can.crop(bb)
    out = {}
    for size, line in ((64, 2), (32, 1)):
        box = size - 2 * line - 4
        sc = min(box / crop.width, box / crop.height)
        im = crop.resize((max(1, round(crop.width * sc)), max(1, round(crop.height * sc))), Image.LANCZOS)
        pal = [tuple(int(v) for v in c) for c in np.asarray(crop).reshape(-1, 4) if c[3] > 0]
        im = snap(im, list({p[:3] for p in pal}))
        icon = Image.new("RGBA", (size, size)); icon.paste(im, ((size - im.width) // 2, (size - im.height) // 2 + 1), im)
        a = np.asarray(icon)[..., 3] > 0
        grow = a.copy()
        for _ in range(line):
            g = grow.copy(); g[1:] |= grow[:-1]; g[:-1] |= grow[1:]; g[:, 1:] |= grow[:, :-1]; g[:, :-1] |= grow[:, 1:]; grow = g
        arr = np.asarray(icon).copy(); ring = grow & ~a
        arr[ring] = (*[int(v) for v in R.INK], 255)
        out[size] = Image.fromarray(arr, "RGBA")
    return out

def icons(mat=""):
    """own small page items_build_rfx (1x 32 + @2x 64), so items_build keeps its pinned grid."""
    item = read(ITEM / "manifest.items.json")
    want = [(f, t) for f, ts in (R.MATERIAL_SETS[mat] if mat else R.TIERS_OF).items() for t in ts]
    name = "items_build_rfx" + (f"_{mat}" if mat else "")
    ms = f"_{mat}" if mat else ""
    cols = 8; rows_n = math.ceil(len(want) / cols)
    p1 = Image.new("RGBA", (cols * 32, rows_n * 32)); p2 = Image.new("RGBA", (cols * 64, rows_n * 64)); sprites = []
    for i, (f, t) in enumerate(want):
        ic = icon_for(f, t, mat)
        p1.paste(ic[32], (i % cols * 32, i // cols * 32)); p2.paste(ic[64], (i % cols * 64, i // cols * 64))
        sprites.append({"key": f"{ICON_KEY.get(f, 'build_rfx_' + f)}{ms}_t{t}", "category": "ui", "atlas": name, "anchor": {"x": .5, "y": .5},
                        "animations": {"idle": {"frames": [i], "fps": 1}}})
    p1.save(ITEM / f"atlases/{name}.png"); p2.save(ITEM / f"atlases/{name}@2x.png")
    atlas = {"key": name, "image": f"atlases/{name}.png", "frameW": 32, "frameH": 32, "columns": cols, "rows": rows_n,
             "residency": "stream", "pages": [{"scale": 2, "image": f"atlases/{name}@2x.png"}]}
    keys = {s["key"] for s in sprites}
    item["atlases"] = [a for a in item["atlases"] if a["key"] != name] + [atlas]
    item["sprites"] = [s for s in item["sprites"] if s["key"] not in keys] + sprites
    write(ITEM / "manifest.items.json", item)
    print(name, len(want))

if __name__ == "__main__":
    mat = sys.argv[sys.argv.index("--material") + 1] if "--material" in sys.argv else ""
    main(mat)
    if "--no-icons" not in sys.argv: icons(mat)
