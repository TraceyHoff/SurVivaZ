#!/usr/bin/env python3
"""SurVivaZ mount action anims (second pass, append-only): hit 3f@10, death 6f@8 (no loop), graze 4f@4 on every mount,
swim 6f@8 on the moose (mounts.ACTS). Same renderer / scale / facings / pivot as artpass_mounts.py; new cells go on their own pages
    nature_mount_acts_<species>_<i>         mount_<species> + mount_<species>_fore action cells
    nature_mount_saddle_acts_<species>_<i>  mount_saddle_<species>_<tier> action cells (4 tiers)
and the anims are added to the existing mount_* sprites (their shipped gait anims, pages and rects stay byte-identical).
Every new non-blank cell is checked pixel-unique against all other new cells AND every shipped mount cell.
Seat anchors: frameMeta df:i anchors.seat (+ anchors.water on moose swim = rider clip row) and mount_anchors.json "acts".
Usage: python3 packages/assets/pack/nature/src/artpass_mounts_acts.py [--jobs 6]   (toktx on PATH; re-entrant)"""
import os, sys, json, hashlib, argparse, subprocess
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
import mounts
from artpass_mounts import job, shelf_pack, NATURE, MAN, ANCH, ROOT

PREFIX_FULL, PREFIX_SAD = "nature_mount_acts_", "nature_mount_saddle_acts_"

def sprite_span(raw, key):
    i = raw.index(f'"key": "{key}"'); st = raw.rindex("{", 0, i); dep = 0; ins = False; esc = False
    for j in range(st, len(raw)):
        c = raw[j]
        if ins:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': ins = False
            continue
        if c == '"': ins = True
        elif c == "{": dep += 1
        elif c == "}":
            dep -= 1
            if dep == 0: return st, j + 1

def shipped_hashes(m):
    """sha1 of every shipped (non-act) mount cell at @2x, for the cross-check."""
    A = {a["key"]: a for a in m["atlases"]}; pages = {}; out = {}
    for s in m["sprites"]:
        if not s["key"].startswith("mount_"): continue
        for an, a in s["animations"].items():
            if an in [x[0] for x in mounts.ACTS]: continue
            for i, df in enumerate(a["dirFrames"]):
                r = df["rect"]
                if r["w"] == 4 and r["h"] == 4: continue
                ak = df["atlas"]
                if ak not in pages: pages[ak] = np.asarray(Image.open(os.path.join(NATURE, A[ak]["pages"][0]["image"])).convert("RGBA"))
                c = pages[ak][2 * r["y"]:2 * (r["y"] + r["h"]), 2 * r["x"]:2 * (r["x"] + r["w"])]
                out[hashlib.sha1(np.ascontiguousarray(c).tobytes()).hexdigest()] = (s["key"], an, i)
    return out

def main(jobs):
    raw = open(MAN).read(); m = json.loads(raw)
    old_hash = shipped_hashes(m)
    tasks = [(s, an, fi, d) for s in mounts.SCALE_TABLE for an, n, _, _ in mounts.acts_for(s) for fi in range(n) for d in range(8)]
    res = {}
    with Pool(jobs, maxtasksperchild=40) as P:
        for i, (key, r) in enumerate(P.imap_unordered(job, tasks, chunksize=4)):
            res[key] = r
            if i % 100 == 0: print("rendered", i, "/", len(tasks), flush=True)
    atlases, add = [], {}; seen = {}; dup = []; act_seat = {}; water = {}
    for s in mounts.SCALE_TABLE:
        key = mounts.SCALE_TABLE[s][0]; acts = mounts.acts_for(s)
        groups = {"full": key, "fore": key + "_fore", **{f"saddle_{t}": f"mount_saddle_{s}_{t}" for t in mounts.TIERS}}
        for gset, prefix in ((("full", "fore"), f"{PREFIX_FULL}{s}"), (tuple(f"saddle_{t}" for t in mounts.TIERS), f"{PREFIX_SAD}{s}")):
            cells = []; crop = {}
            for g in gset:
                for an, n, _, _ in acts:
                    for fi in range(n):
                        for d in range(8):
                            c1, c2, bb = res[(s, an, fi, d)][g]; cid = (g, an, fi, d); crop[cid] = bb
                            if bb[2] > bb[0]:
                                h = hashlib.sha1(np.ascontiguousarray(c2).tobytes()).hexdigest()
                                if h in seen: dup.append((s, cid, seen[h]))
                                if h in old_hash: dup.append((s, cid, old_hash[h]))
                                seen[h] = (s, cid); cells.append((cid, bb[2] - bb[0], bb[3] - bb[1]))
            cells.append((("blank",), 4, 4))
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
                for an, n, fps, loop in acts:
                    df = []; fm = {}
                    for fi in range(n):
                        for d in range(8):
                            cid = (g, an, fi, d); r = res[(s, an, fi, d)]; W, H, feet = r["size"]; x0, y0, x1, y1 = crop[cid]
                            if x1 <= x0: pi, x, y = place[("blank",)]; rect = {"x": x, "y": y, "w": 4, "h": 4}; anc = {"x": 0.5, "y": 0.5}
                            else:
                                pi, x, y = place[cid]; rect = {"x": x, "y": y, "w": x1 - x0, "h": y1 - y0}
                                anc = {"x": round((W / 2 - x0) / (x1 - x0), 6), "y": round((feet - y0) / (y1 - y0), 6)}
                            df.append({"atlas": f"{prefix}_{pi}", "rect": rect, "anchor": anc})
                            if g == "full":
                                an_ = {"seat": {"x": r["seat"][0], "y": r["seat"][1]}}
                                if "water" in r: an_["water"] = {"x": r["seat"][0], "y": r["water"]}
                                fm[f"df:{fi * 8 + d}"] = {"anchors": an_}
                    a = {"frames": list(range(n)), "fps": fps, "directions": 8, "dirStride": n, "loop": loop, "dirFrames": df}
                    if fm: a["frameMeta"] = fm
                    anims[an] = a
                add[groups[g]] = anims
        act_seat[s] = {an: [[{"x": res[(s, an, fi, d)]["seat"][0], "y": res[(s, an, fi, d)]["seat"][1]} for d in range(8)] for fi in range(n)] for an, n, _, _ in acts}
        if any(a[0] == "swim" for a in acts):
            water[s] = [[res[(s, "swim", fi, d)]["water"] for d in range(8)] for fi in range(mounts.NFRAMES["swim"])]
    if dup:
        print("DUPLICATE CELLS", len(dup), dup[:10]); raise SystemExit(1)
    print("unique new non-blank cells:", len(seen), "checked against", len(old_hash), "shipped cells")
    # KTX2 for the new pages only
    enc = os.path.join(NATURE, "manifest.mount-acts-encode.json")
    try:
        json.dump({"atlases": atlases}, open(enc, "w"))
        subprocess.run([sys.executable, os.path.join(ROOT, "assets/tools/ktx2.py"), enc], cwd=NATURE, check=True)
        atlases = json.load(open(enc))["atlases"]
    finally:
        if os.path.exists(enc): os.remove(enc)
    # manifest text surgery: only the mount_* sprite objects (written by this art pass) and the atlas list tail change
    acts_names = {a[0] for a in mounts.ACTS}
    for key, anims in add.items():
        st, en = sprite_span(raw, key); obj = json.loads(raw[st:en])
        obj["animations"] = {k: v for k, v in obj["animations"].items() if k not in acts_names} | anims
        ind = raw.rfind("\n", 0, st); ind = raw[ind + 1:st]
        txt = "\n".join((ind if i else "") + ln for i, ln in enumerate(json.dumps(obj, indent=1, ensure_ascii=False).splitlines()))
        raw = raw[:st] + txt + raw[en:]
    m2 = json.loads(raw)
    keep = [a for a in m2["atlases"] if not a["key"].startswith((PREFIX_FULL, PREFIX_SAD))]
    if len(keep) != len(m2["atlases"]):   # re-run: drop the previous act pages (they were appended at the end)
        m2["atlases"] = keep + atlases; raw = json.dumps(m2, indent=1, ensure_ascii=False) + "\n"
    else:
        i = raw.find('"atlases"'); lb = raw.find("[", i); dep = 0
        for j in range(lb, len(raw)):
            if raw[j] == "[": dep += 1
            elif raw[j] == "]":
                dep -= 1
                if dep == 0: close = j; break
        raw = raw[:close] + ",\n" + ",\n".join("\n".join(" " + ln for ln in json.dumps(x, indent=1, ensure_ascii=False).splitlines()) for x in atlases) + raw[close:]
    json.loads(raw); open(MAN, "w").write(raw)
    # anchor table
    A = json.load(open(ANCH))
    A["acts"] = {
        "doc": "mount action anims; seat = rider seat anchor (1x px from the mount pivot) for every frame/facing; "
               "rider plays riderAnim on its own clock (pin its body seat on this seat each tick); death: the rider dismounts. "
               "moose swim: waterY[frame][facing] = water-surface row (1x px from the pivot) at the seat column - clip rider pixels below it.",
        "anims": {an: {"frames": n, "fps": fps, "msPerFrame": round(1000 / fps, 1), "loop": loop, "species": list(only) if only else "all"} for an, n, fps, loop, only in mounts.ACTS},
        "riderAnim": {"hit": "ride_idle", "graze": "ride_idle", "swim": "ride_idle", "death": None},
    }
    for s in mounts.SCALE_TABLE:
        A["species"][s]["actSeat"] = act_seat[s]
        if s in water: A["species"][s]["swimWaterY"] = water[s]
    json.dump(A, open(ANCH, "w"), indent=1); open(ANCH, "a").write("\n")
    print("acts done:", len(atlases), "pages,", len(add), "sprites extended")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--jobs", type=int, default=6); main(ap.parse_args().jobs)
