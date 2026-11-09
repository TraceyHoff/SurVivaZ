#!/usr/bin/env python3
"""SurVivaZ rideable mounts (append-only packer for the nature fragment).

Renders every mount species x anim x frame x facing with mounts.py (true scale: mounts.PX_PER_M, mounts.SCALE_TABLE),
trims each cell to its art (2px clear guard), shelf-packs rect dirFrames onto new pages (<=1024 at 1x, <=2048 @2x):
    nature_mounts_<species>_<i>         mount_<species> + mount_<species>_fore cells
    nature_mount_saddles_<species>_<i>  mount_saddle_<species>_<tier> cells (4 tiers)
appends those atlases + sprites to manifest.nature.json (existing atlases/sprites untouched), writes the standalone
anchor table packages/assets/pack/nature/mount_anchors.json, KTX2-encodes ONLY the new pages, and writes previews.
Re-entrant: a previous run's nature_mount* atlases / mount_* sprites are replaced.
Usage: python3 packages/assets/pack/nature/src/artpass_mounts.py [--jobs 6]   (toktx on PATH)
Rescale: edit mounts.PX_PER_M / SCALE_TABLE and re-run this script, then ride previews (artpass_mounts_preview.py)."""
import os, sys, json, math, hashlib, argparse, subprocess
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "../../../../.."))
sys.path.insert(0, os.path.join(ROOT, "assets/customization/tools"))
import numpy as np
from PIL import Image
import mounts

NATURE = os.path.join(ROOT, "packages/assets/pack/nature")
MAN = os.path.join(NATURE, "manifest.nature.json")
ANCH = os.path.join(NATURE, "mount_anchors.json")
MAXP = 1024; GUARD = 2

def job(args):
    s, anim, fi, d = args
    r = mounts.render_frame(s, d, anim, fi)
    for g in ["full", "fore"] + [f"saddle_{t}" for t in mounts.TIERS]:   # crop in the worker (bounded memory)
        a1, a2 = r[g]; bb = trim(a1, a2)
        if bb is None: r[g] = (None, None, (0, 0, 0, 0))
        else: x0, y0, x1, y1 = bb; r[g] = (a1[y0:y1, x0:x1].copy(), a2[2 * y0:2 * y1, 2 * x0:2 * x1].copy(), bb)
    return args, r

def trim(a1, a2):
    """union alpha box over both scales, 1x coords, with the 2px clear guard; None if blank."""
    m1 = a1[..., 3] > 0; m2 = a2[..., 3] > 0
    if not m1.any() and not m2.any(): return None
    ys, xs = np.nonzero(m1) if m1.any() else (np.array([10 ** 6]), np.array([10 ** 6]))
    y2, x2 = np.nonzero(m2) if m2.any() else (np.array([10 ** 6]), np.array([10 ** 6]))
    x0 = min(xs.min(), x2.min() // 2) - GUARD; y0 = min(ys.min(), y2.min() // 2) - GUARD
    x1 = max(xs.max() + 1 if m1.any() else 0, (x2.max() + 2) // 2 if m2.any() else 0) + GUARD
    y1 = max(ys.max() + 1 if m1.any() else 0, (y2.max() + 2) // 2 if m2.any() else 0) + GUARD
    H, W = a1.shape[:2]
    return max(0, int(x0)), max(0, int(y0)), min(W, int(x1)), min(H, int(y1))

def shelf_pack(cells, prefix):
    """cells: list of (id, w, h) -> {id: (page_idx, x, y)}, pages [(w,h)]. Pages <= MAXP, 16-aligned."""
    order = sorted(cells, key=lambda c: (-c[2], -c[1], c[0]))
    pages = []; place = {}; cur = None
    for cid, w, h in order:
        if cur is None: cur = dict(x=0, y=0, sh=0, W=0); pages.append(cur)
        if cur["x"] + w > MAXP: cur["x"] = 0; cur["y"] += cur["sh"]; cur["sh"] = 0
        if cur["y"] + h > MAXP:
            cur = dict(x=0, y=0, sh=0, W=0); pages.append(cur)
        place[cid] = (len(pages) - 1, cur["x"], cur["y"]); cur["x"] += w; cur["sh"] = max(cur["sh"], h); cur["W"] = max(cur["W"], cur["x"])
    dims = [(int(math.ceil(p["W"] / 16) * 16), int(math.ceil((p["y"] + p["sh"]) / 16) * 16)) for p in pages]
    return place, dims

def main(jobs):
    tasks = [(s, an, fi, d) for s in mounts.SCALE_TABLE for an, n, _ in mounts.ANIMS for fi in range(n) for d in range(8)]
    res = {}
    with Pool(jobs, maxtasksperchild=40) as P:
        for i, (key, r) in enumerate(P.imap_unordered(job, tasks, chunksize=4)):
            res[key] = r
            if i % 100 == 0: print("rendered", i, "/", len(tasks), flush=True)
    atlases, sprites = [], []; anchors = {}; seen = {}; dup = []
    for s in mounts.SCALE_TABLE:
        key, wh, note = mounts.SCALE_TABLE[s]
        groups = {"full": key, "fore": key + "_fore", **{f"saddle_{t}": f"mount_saddle_{s}_{t}" for t in mounts.TIERS}}
        for gset, prefix in ((("full", "fore"), f"nature_mounts_{s}"), (tuple(f"saddle_{t}" for t in mounts.TIERS), f"nature_mount_saddles_{s}")):
            cells = []; crop = {}
            for g in gset:
                for an, n, _ in mounts.ANIMS:
                    for fi in range(n):
                        for d in range(8):
                            r = res[(s, an, fi, d)]; c1, c2, bb = r[g]
                            cid = (g, an, fi, d); crop[cid] = bb
                            if bb[2] > bb[0]:
                                h = hashlib.sha1(c2.tobytes()).hexdigest()
                                if h in seen: dup.append((cid, s, seen[h]))
                                seen[h] = (s, cid)
                                cells.append((cid, bb[2] - bb[0], bb[3] - bb[1]))
            cells.append((("blank",), 4, 4))     # one shared fully-transparent rect for facings where a layer is hidden
            place, dims = shelf_pack(cells, prefix)
            pages = [[np.zeros((h, w, 4), np.uint8), np.zeros((h * 2, w * 2, 4), np.uint8)] for (w, h) in dims]
            for cid, (pi, x, y) in place.items():
                if cid == ("blank",): continue
                g, an, fi, d = cid; x0, y0, x1, y1 = crop[cid]; r = res[(s, an, fi, d)]
                pages[pi][0][y:y + y1 - y0, x:x + x1 - x0] = r[g][0]
                pages[pi][1][2 * y:2 * (y + y1 - y0), 2 * x:2 * (x + x1 - x0)] = r[g][1]
            for pi, (p1, p2) in enumerate(pages):
                ak = f"{prefix}_{pi}"; assert max(p1.shape[:2]) <= 1024 and max(p2.shape[:2]) <= 2048
                assert set(np.unique(p1[..., 3])) <= {0, 255} and set(np.unique(p2[..., 3])) <= {0, 255}
                Image.fromarray(p1, "RGBA").save(os.path.join(NATURE, f"atlases/{ak}.png"), optimize=True)
                Image.fromarray(p2, "RGBA").save(os.path.join(NATURE, f"atlases/{ak}@2x.png"), optimize=True)
                atlases.append({"key": ak, "image": f"atlases/{ak}.png", "frameW": p1.shape[1], "frameH": p1.shape[0], "columns": 1, "rows": 1,
                                "pages": [{"scale": 2, "image": f"atlases/{ak}@2x.png"}], "residency": "stream", "placeholder": "placeholder_animal_l"})
                print("page", ak, p1.shape[1], "x", p1.shape[0], flush=True)
            for g in gset:
                anims = {}
                for an, n, fps in mounts.ANIMS:
                    df = []; fm = {}
                    for fi in range(n):
                        for d in range(8):
                            cid = (g, an, fi, d); r = res[(s, an, fi, d)]; W, H, feet = r["size"]
                            x0, y0, x1, y1 = crop[cid]
                            if x1 <= x0:
                                pi, x, y = place[("blank",)]; rect = {"x": x, "y": y, "w": 4, "h": 4}; anc = {"x": 0.5, "y": 0.5}
                            else:
                                pi, x, y = place[cid]; rect = {"x": x, "y": y, "w": x1 - x0, "h": y1 - y0}
                                anc = {"x": round((W / 2 - x0) / (x1 - x0), 6), "y": round((feet - y0) / (y1 - y0), 6)}
                            df.append({"atlas": f"{prefix}_{pi}", "rect": rect, "anchor": anc})
                            if g == "full": fm[f"df:{fi * 8 + d}"] = {"anchors": {"seat": {"x": r["seat"][0], "y": r["seat"][1]}}}
                    a = {"frames": list(range(n)), "fps": fps, "directions": 8, "dirStride": n, "loop": True, "dirFrames": df}
                    if fm: a["frameMeta"] = fm
                    anims[an] = a
                sprites.append({"key": groups[g], "category": "critter" if g in ("full", "fore") else "equipment", "atlas": anims["idle"]["dirFrames"][0]["atlas"],
                                "anchor": {"x": 0.5, "y": 0.9}, "animations": anims})
        anchors[s] = {(an, fi, d): res[(s, an, fi, d)]["seat"] for an, n, _ in mounts.ANIMS for fi in range(n) for d in range(8)}
    if dup:
        print("DUPLICATE CELLS", len(dup), dup[:10]); raise SystemExit(1)
    print("unique non-blank cells:", len(seen))
    # ---- manifest (append-only; replace a previous run of this pass)
    raw = open(MAN).read(); m = json.loads(raw)
    old = any(a["key"].startswith(("nature_mounts_", "nature_mount_saddles_")) for a in m["atlases"])
    m["atlases"] = [a for a in m["atlases"] if not a["key"].startswith(("nature_mounts_", "nature_mount_saddles_"))]
    m["sprites"] = [x for x in m["sprites"] if not (x["key"].startswith("mount_"))]
    # KTX2 for the new pages only
    enc = os.path.join(NATURE, "manifest.mounts-encode.json")
    try:
        json.dump({"atlases": atlases}, open(enc, "w"))
        subprocess.run([sys.executable, os.path.join(ROOT, "assets/tools/ktx2.py"), enc], cwd=NATURE, check=True)
        atlases = json.load(open(enc))["atlases"]
    finally:
        if os.path.exists(enc): os.remove(enc)
    if old:
        m["atlases"] += atlases; m["sprites"] += sprites
        open(MAN, "w").write(json.dumps(m, indent=1, ensure_ascii=False) + "\n")
    else:
        def close_of(label):
            i = raw.find(f'"{label}"'); lb = raw.find("[", i); dep = 0
            for j in range(lb, len(raw)):
                if raw[j] == "[": dep += 1
                elif raw[j] == "]":
                    dep -= 1
                    if dep == 0: return j
        def dump(items): return ",\n" + ",\n".join("\n".join(" " + ln for ln in json.dumps(x, indent=1, ensure_ascii=False).splitlines()) for x in items)
        s1 = close_of("sprites"); raw = raw[:s1] + dump(sprites) + raw[s1:]
        a1 = close_of("atlases"); raw = raw[:a1] + dump(atlases) + raw[a1:]
        json.loads(raw); open(MAN, "w").write(raw)
    write_anchors(anchors)
    print("mounts done:", len(atlases), "pages,", len(sprites), "sprites")

def write_anchors(anchors):
    import rig
    rider = {bt: {f"ride_{an}": [[rig.pose(bt, d, f"ride_{an}", fi, n)["seat"] for d in range(8)] for fi in range(n)] for an, n, _ in mounts.ANIMS} for bt in ("male", "female")}
    out = {
        "version": 1,
        "doc": "docs/ART_KEYS_MOUNTS.md",
        "units": "1x px; +x screen right, +y screen down; @2x pages = double. Arrays are [frame][facing], facing = engine dir index 0..7 (E,SE,S,SW,W,NW,N,NE), same as dirFrames index frame*8+facing.",
        "pxPerMetre": round(mounts.PX_PER_M, 4), "playerHeightM": mounts.PLAYER_HEIGHT_M, "playerHeightPx": mounts.PLAYER_PX,
        "drawOrder": ["mount_<species>", "mount_saddle_<species>_<tier>", "rider doll layers (ride_<anim>)", "mount_<species>_fore"],
        "riderAnim": {an: f"ride_{an}" for an, _, _ in mounts.ANIMS},
        "anims": {an: {"frames": n, "fps": fps, "msPerFrame": round(1000 / fps, 1), "loop": True} for an, n, fps in mounts.ANIMS},
        "tiers": list(mounts.TIERS),
        "riderSeat": {"doc": "rider seat socket (body frameMeta anchors.seat), px from the rider feet pivot", **rider},
        "species": {},
    }
    for s, (key, wh, note) in mounts.SCALE_TABLE.items():
        seat = {an: [[{"x": anchors[s][(an, fi, d)][0], "y": anchors[s][(an, fi, d)][1]} for d in range(8)] for fi in range(n)] for an, n, _ in mounts.ANIMS}
        # rider pivot offset = mount seat - rider seat socket (male and female sockets are identical; asserted)
        rid = {}
        for an, n, _ in mounts.ANIMS:
            rid[an] = []
            for fi in range(n):
                row = []
                for d in range(8):
                    a = seat[an][fi][d]; b = rider["male"][f"ride_{an}"][fi][d]; assert b == rider["female"][f"ride_{an}"][fi][d]
                    row.append({"x": round(a["x"] - b["x"], 2), "y": round(a["y"] - b["y"], 2)})
                rid[an].append(row)
        out["species"][s] = {"sprite": key, "fore": key + "_fore", "saddles": {t: f"mount_saddle_{s}_{t}" for t in mounts.TIERS},
                             "wildSprite": mounts.WILD_KEY.get(s), "heightM": wh, "heightPx": round(wh * mounts.PX_PER_M, 1), "heightNote": note,
                             "seat": seat, "riderOffset": rid}
    json.dump(out, open(ANCH, "w"), indent=1); open(ANCH, "a").write("\n")
    print("anchors ->", ANCH)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--jobs", type=int, default=6); main(ap.parse_args().jobs)
