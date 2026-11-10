#!/usr/bin/env python3
"""Re-render the away-facing mount cells (facings 4, 5, 6: rump toward the camera) of every mount sprite, its fore layer and
all 4 saddle tiers, for every anim (gaits + actions), after the mounts.py back-view redraw (broad rump + haunches, chunkier
hind legs, head turned over the shoulder in the straight-back view). Every other cell keeps its exact pixels; each mount
page is re-shelf-packed in place (every cell stays on its page; same page keys, same sprites / anims / dirFrames order and count, same frameMeta).
Seat / water anchors are recomputed and asserted unchanged. Pixel uniqueness is re-checked over all mount cells.
Usage: python3 packages/assets/pack/nature/src/artpass_mounts_backfix.py [--jobs 6]   (toktx on PATH)"""
import os, sys, json, hashlib, argparse, subprocess
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
import mounts
from artpass_mounts import job, shelf_pack, NATURE, MAN, ROOT
from artpass_mounts_acts import sprite_span

AWAY = (4, 5, 6)
GROUPS = ["nature_mounts_", "nature_mount_saddles_", "nature_mount_acts_", "nature_mount_saddle_acts_"]

def group_of(ak):
    for g in sorted(GROUPS, key=len, reverse=True):
        if ak.startswith(g): return g + ak[len(g):].rsplit("_", 1)[0]
    return None

def layer_of(key):
    if key.startswith("mount_saddle_"): return "saddle_" + key.rsplit("_", 1)[1]
    return "fore" if key.endswith("_fore") else "full"

def species_of(key):
    k = key[len("mount_saddle_"):].rsplit("_", 1)[0] if key.startswith("mount_saddle_") else key[len("mount_"):].replace("_fore", "")
    return k

def main(jobs):
    raw = open(MAN).read(); m = json.loads(raw)
    A = {a["key"]: a for a in m["atlases"]}
    sprites = [s for s in m["sprites"] if s["key"].startswith("mount_")]
    tasks = sorted({(species_of(s["key"]), an, fi, d) for s in sprites for an, a in s["animations"].items() for fi in range(len(a["frames"])) for d in AWAY})
    res = {}
    with Pool(jobs, maxtasksperchild=40) as P:
        for i, (key, r) in enumerate(P.imap_unordered(job, tasks, chunksize=4)):
            res[key] = r
            if i % 100 == 0: print("rendered", i, "/", len(tasks), flush=True)
    pages = {}
    def page(ak, sc):
        if (ak, sc) not in pages:
            a = A[ak]; pages[(ak, sc)] = np.asarray(Image.open(os.path.join(NATURE, a["image"] if sc == 1 else a["pages"][0]["image"])).convert("RGBA"))
        return pages[(ak, sc)]
    # collect every entry per page group: (sprite key, anim, index) -> cell (c1, c2, anchor)
    groups = {}; seat_changes = []
    for s in sprites:
        sp = species_of(s["key"]); lay = layer_of(s["key"])
        for an, a in s["animations"].items():
            n = len(a["frames"])
            for i, df in enumerate(a["dirFrames"]):
                g = df["atlas"]; fi, d = divmod(i, 8)   # every cell stays on the page it was on
                if d in AWAY:
                    r = res[(sp, an, fi, d)]; c1, c2, bb = r[lay]; W, H, feet = r["size"]
                    if bb[2] <= bb[0]: cell = None
                    else: cell = (c1, c2, {"x": round((W / 2 - bb[0]) / (bb[2] - bb[0]), 6), "y": round((feet - bb[1]) / (bb[3] - bb[1]), 6)})
                    if lay == "full":
                        fm = a["frameMeta"][f"df:{i}"]["anchors"]
                        if fm["seat"] != {"x": r["seat"][0], "y": r["seat"][1]}: seat_changes.append((s["key"], an, i, fm["seat"], r["seat"]))
                        if "water" in fm and fm["water"]["y"] != r["water"]: seat_changes.append((s["key"], an, i, "water", fm["water"], r["water"]))
                else:
                    rc = df["rect"]
                    if rc["w"] == 4 and rc["h"] == 4: cell = None
                    else:
                        c1 = page(df["atlas"], 1)[rc["y"]:rc["y"] + rc["h"], rc["x"]:rc["x"] + rc["w"]]
                        c2 = page(df["atlas"], 2)[2 * rc["y"]:2 * (rc["y"] + rc["h"]), 2 * rc["x"]:2 * (rc["x"] + rc["w"])]
                        cell = (c1, c2, df["anchor"])
                groups.setdefault(g, {})[(s["key"], an, i)] = cell
    if seat_changes: print("ANCHOR CHANGES", len(seat_changes), seat_changes[:5]); raise SystemExit(1)
    # uniqueness over every non-blank mount cell
    seen = {}; dup = []
    for g, cells in groups.items():
        for cid, c in cells.items():
            if c is None: continue
            h = hashlib.sha1(np.ascontiguousarray(c[1]).tobytes()).hexdigest()
            if h in seen: dup.append((cid, seen[h]))
            seen[h] = cid
    if dup: print("DUPLICATE CELLS", len(dup), dup[:10]); raise SystemExit(1)
    print("unique non-blank mount cells:", len(seen))
    # repack each group in place
    new_atlas = {}; dfnew = {}; old_keys = [k for k in A if group_of(k)]
    for g, cells in groups.items():
        lst = [(cid, c[0].shape[1], c[0].shape[0]) for cid, c in cells.items() if c is not None] + [(("blank",), 4, 4)]
        place, dims = shelf_pack(lst, g); assert len(dims) == 1, (g, dims)
        imgs = [[np.zeros((h, w, 4), np.uint8), np.zeros((h * 2, w * 2, 4), np.uint8)] for (w, h) in dims]
        for cid, c in cells.items():
            if c is None: pi, x, y = place[("blank",)]; dfnew[cid] = {"atlas": g, "rect": {"x": x, "y": y, "w": 4, "h": 4}, "anchor": {"x": 0.5, "y": 0.5}}; continue
            pi, x, y = place[cid]; h, w = c[0].shape[:2]
            imgs[pi][0][y:y + h, x:x + w] = c[0]; imgs[pi][1][2 * y:2 * (y + h), 2 * x:2 * (x + w)] = c[1]
            dfnew[cid] = {"atlas": g, "rect": {"x": x, "y": y, "w": w, "h": h}, "anchor": c[2]}
        for pi, (p1, p2) in enumerate(imgs):
            ak = g; assert max(p1.shape[:2]) <= 1024 and max(p2.shape[:2]) <= 2048
            assert set(np.unique(p1[..., 3])) <= {0, 255} and set(np.unique(p2[..., 3])) <= {0, 255}
            Image.fromarray(p1, "RGBA").save(os.path.join(NATURE, f"atlases/{ak}.png"), optimize=True)
            Image.fromarray(p2, "RGBA").save(os.path.join(NATURE, f"atlases/{ak}@2x.png"), optimize=True)
            new_atlas[ak] = {"key": ak, "image": f"atlases/{ak}.png", "frameW": p1.shape[1], "frameH": p1.shape[0], "columns": 1, "rows": 1,
                             "pages": [{"scale": 2, "image": f"atlases/{ak}@2x.png"}], "residency": "stream", "placeholder": "placeholder_animal_l"}
            print("page", ak, p1.shape[1], "x", p1.shape[0], flush=True)
    assert set(new_atlas) == set(old_keys), (sorted(set(new_atlas) ^ set(old_keys)))   # same page keys
    enc = os.path.join(NATURE, "manifest.mount-backfix-encode.json")
    try:
        json.dump({"atlases": list(new_atlas.values())}, open(enc, "w"))
        subprocess.run([sys.executable, os.path.join(ROOT, "assets/tools/ktx2.py"), enc], cwd=NATURE, check=True)
        for a in json.load(open(enc))["atlases"]: new_atlas[a["key"]] = a
    finally:
        if os.path.exists(enc): os.remove(enc)
    # manifest text surgery: atlas objects of the mount groups + mount_* sprite objects only
    def replace_obj(raw, key, obj):
        st, en = sprite_span(raw, key); ind = raw[raw.rfind("\n", 0, st) + 1:st]
        txt = "\n".join((ind if i else "") + ln for i, ln in enumerate(json.dumps(obj, indent=1, ensure_ascii=False).splitlines()))
        return raw[:st] + txt + raw[en:]
    for ak, a in new_atlas.items():
        st, en = sprite_span(raw, ak); old = json.loads(raw[st:en]); assert old["key"] == ak
        raw = replace_obj(raw, ak, {**old, **{k: a[k] for k in ("frameW", "frameH")}, "pages": a["pages"], "ktx2": a["ktx2"]})
    for s in sprites:
        st, en = sprite_span(raw, s["key"]); obj = json.loads(raw[st:en])
        for an, a in obj["animations"].items():
            a["dirFrames"] = [dfnew[(s["key"], an, i)] for i in range(len(a["dirFrames"]))]
        raw = replace_obj(raw, s["key"], obj)
    json.loads(raw); open(MAN, "w").write(raw)
    print("backfix done:", len(tasks), "frames re-rendered,", len(new_atlas), "pages repacked")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--jobs", type=int, default=6); main(ap.parse_args().jobs)
