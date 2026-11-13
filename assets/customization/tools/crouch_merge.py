#!/usr/bin/env python3
"""Append ONLY freshly painted v1 crouch_idle / crouch_walk dirFrames, preserving all existing art.

Usage: python3 assets/customization/tools/crouch_merge.py REPO [--jobs 7] [--replace-slots slot,slot]

Clone of ride_merge's append-only extra-page convention, but packed as trimmed per-frame rects (skyline,
1 px wear / 2 px body bleed) so the streamed cz_crouch_* pages stay lean for the Pages 1 GB budget.
Physical cells are unique painted frames; blank (fully transparent) cells share one 1x1 clear rect per page.
Body frames carry frameMeta anchors handR / handL / head (ADR-128 neck reference V1_HEAD).
Workers crop each frame to its painted trim before returning (bounded memory). Only new pages are
KTX2-encoded; PNGs are then oxipng-compressed losslessly. cz_manifest.save recomputes shard hashes.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from multiprocessing import Pool
from pathlib import Path
import subprocess
import shutil
import numpy as np
from PIL import Image
import rerender
from rectpack import skyline, SLACK
from rig import FW, FH, FEET, CROUCH_ANIMS, CROUCH_FPS, V1_HEAD, pose

MAXP = 1016  # multiple of 8, same ceiling as rectpack
PAD_BODY, PAD_WEAR = 2, 1  # body: ART_body  >=2 px clear border; wear: 1 px gutter

def live_keys(m):
    keys = set()
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "sprite" and isinstance(v, str): keys.add(v)
                else: walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(m["bodyTypes"]); walk(m["wearables"])
    return keys

def fit_slack(lo, hi, pv):
    while pv > hi + SLACK * (hi - lo): hi += 1
    while pv < lo - SLACK * (hi - lo): lo -= 1
    return lo, hi

def trim_frame(a1, a1m, a2, a2m, slot):
    """Tight crop of one 1x/2x colour+tintmask frame. Pivot is (FW/2, FEET) in 1x source space."""
    al = (a1[..., 3] > 0) | (a2[..., 3] > 0).reshape(FH, 2, FW, 2).any(axis=(1, 3))
    if not al.any():
        return (int(FW / 2), int(FEET), 1, 1, None)  # blank, anchor at feet pivot
    ys, xs = np.nonzero(al)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    px, py = FW / 2, float(FEET)
    if slot == "body":
        pad = PAD_BODY
        # feet pivot + ADR-128 standing head ref (frameMeta.head) so the official head stays in-rect
        hx, hy = px, py + V1_HEAD["y"]
        x0 = min(x0, int(np.floor(px)), int(np.floor(hx))) - pad
        y0 = min(y0, int(np.floor(py)), int(np.floor(hy))) - pad
        x1 = max(x1, int(np.ceil(px)), int(np.ceil(hx))) + pad
        y1 = max(y1, int(np.ceil(py)), int(np.ceil(hy))) + pad
    else:
        x0 -= PAD_WEAR; y0 -= PAD_WEAR; x1 += PAD_WEAR; y1 += PAD_WEAR
        x0, x1 = fit_slack(x0, x1, px)
        y0, y1 = fit_slack(y0, y1, py)
    # clip to a slightly padded source so slack growth past the 48x80 cell still has zeros
    cw, ch = x1 - x0, y1 - y0
    n1 = np.zeros((ch, cw, 4), np.uint8); nt = np.zeros((ch, cw, 3), np.uint8)
    n2 = np.zeros((2 * ch, 2 * cw, 4), np.uint8); n4 = np.zeros((2 * ch, 2 * cw, 3), np.uint8)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x1, FW), min(y1, FH)
    n1[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = a1[sy0:sy1, sx0:sx1]
    nt[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = a1m[sy0:sy1, sx0:sx1, :3]
    n2[2 * (sy0 - y0):2 * (sy1 - y0), 2 * (sx0 - x0):2 * (sx1 - x0)] = a2[2 * sy0:2 * sy1, 2 * sx0:2 * sx1]
    n4[2 * (sy0 - y0):2 * (sy1 - y0), 2 * (sx0 - x0):2 * (sx1 - x0)] = a2m[2 * sy0:2 * sy1, 2 * sx0:2 * sx1, :3]
    return (x0, y0, cw, ch, (n1, nt, n2, n4))

def render_trimmed(args):
    k, plan = args
    slot = rerender.JOBS[k][2]
    _, out = rerender.render_sprite((k, plan))
    frames = []
    for fr in out:
        frames.append(trim_frame(fr[0], fr[1], fr[2], fr[3], slot))
    return k, frames

def r8(n):
    return (n + 7) // 8 * 8

def layout_sizes(sizes):
    """Pick the smallest-area skyline page <= MAXP for `sizes` (list of (w,h)). Returns (W,H,pos) or None."""
    best = None
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0], i))
    for Wd in range(64, MAXP + 1, 8):
        if any(w > Wd for w, _ in sizes):
            continue
        sk = skyline(sizes, order, Wd)
        if sk is None:
            continue
        H, pos = sk
        H = r8(H)
        if H > MAXP:
            continue
        area = Wd * H
        if best is None or area < best[0] or (area == best[0] and Wd < best[1]):
            best = (area, Wd, H, pos)
    return None if best is None else (best[1], best[2], best[3])

def pages_for(items):
    """Greedy: keep each sprite's frames on one page. items[k] = list of frame records in plan order."""
    # sort sprites by total painted area (desc) so big ones settle first
    keys = sorted(items, key=lambda k: (-sum(fr[2] * fr[3] for fr in items[k] if fr[4] is not None), k))
    pages, cur = [], []
    def sizes_of(group):
        # unique non-blank crops + one optional blank
        out = []
        for k in group:
            for fr in items[k]:
                if fr[4] is None:
                    out.append((1, 1))
                else:
                    out.append((fr[2], fr[3]))
        # packing uses per-instance sizes (shared rects are assigned after); this is a conservative fit
        return out
    for k in keys:
        trial = cur + [k]
        if cur and layout_sizes(sizes_of(trial)) is None:
            pages.append(cur); cur = [k]
        else:
            cur = trial
    if cur:
        pages.append(cur)
    return pages

def oxipng_paths(paths):
    exe = shutil.which("oxipng")
    if not exe:
        print("oxipng not on PATH; leaving PNGs as Pillow optimize=True", flush=True)
        return
    # --opt max, strip safe metadata, keep bit depth; palette if lossless
    cmd = [exe, "-o", "max", "--strip", "safe", "--alpha", "-q", "--"] + paths
    subprocess.run(cmd, check=True)

def main(root, workers, replace_slots=()):
    if not shutil.which("toktx"):
        raise RuntimeError("KTX-Software toktx must be on PATH before rendering (see assets/tools/ktx2.py)")
    root = Path(root).resolve(); dest = root / "packages/assets/pack/customization"
    mp = dest / "manifest.customization.json"; m = rerender.czm.load(str(mp))
    sprites = {s["key"]: s for s in m["sprites"]}; keys = live_keys(m)
    if replace_slots:
        keys = {k for k in keys if rerender.JOBS[k][2] in replace_slots}
        prefixes = tuple(f"cz_crouch_{slot}_" for slot in replace_slots)
        m["atlases"] = [a for a in m["atlases"] if not a["key"].startswith(prefixes)]
        for k in keys:
            for name in CROUCH_ANIMS:
                sprites[k]["animations"].pop(name, None)
    assert keys and keys <= rerender.JOBS.keys(), sorted(keys - rerender.JOBS.keys())
    assert all(not (set(CROUCH_ANIMS) & sprites[k]["animations"].keys()) for k in keys), "already merged"
    groups = defaultdict(list)
    for k in sorted(keys):
        groups[rerender.JOBS[k][2]].append(k)
    new_atlases = []
    plan = [(name, n * 8, 8) for name, n in CROUCH_ANIMS.items()]
    with Pool(workers, maxtasksperchild=8) as pool:
        for slot, group in sorted(groups.items()):
            items = {}
            for k, frames in pool.imap_unordered(render_trimmed, [(k, plan) for k in group]):
                items[k] = frames
                print("rendered", k, "frames", len(frames), flush=True)
            def unique_layout(group):
                crops, blank = {}, False
                for k in group:
                    for fr in items[k]:
                        if fr[4] is None:
                            blank = True
                        else:
                            sig = hashlib.sha1(fr[4][0].tobytes()+fr[4][1].tobytes()+fr[4][2].tobytes()+fr[4][3].tobytes()).hexdigest()
                            if sig not in crops:
                                crops[sig] = (fr[2], fr[3])
                sizes = list(crops.values()) + ([(1, 1)] if blank else [])
                return layout_sizes(sizes), crops, blank

            # greedy pages: keep a sprite together; fit on unique-crop area
            keys_s = sorted(items, key=lambda k: (-sum(fr[2]*fr[3] for fr in items[k] if fr[4] is not None), k))
            pages, cur = [], []
            for k in keys_s:
                trial = cur + [k]
                if cur and unique_layout(trial)[0] is None:
                    pages.append(cur); cur = [k]
                else:
                    cur = trial
            if cur: pages.append(cur)

            for pi, g in enumerate(pages):
                # share identical non-blank crops; one blank rect per page
                crops = {}  # sig -> (w,h,arrays)
                inst = []   # (k, src_index, sig or 'blank', w, h)
                blank_used = False
                for k in g:
                    srcbase = 0
                    for name, n in CROUCH_ANIMS.items():
                        for i in range(n * 8):
                            x0, y0, cw, ch, arrs = items[k][srcbase + i]
                            if arrs is None:
                                sig = "blank"; blank_used = True; ww, hh = 1, 1
                            else:
                                sig = hashlib.sha1(arrs[0].tobytes() + arrs[1].tobytes() + arrs[2].tobytes() + arrs[3].tobytes()).hexdigest()
                                if sig not in crops:
                                    crops[sig] = (cw, ch, arrs)
                                ww, hh = crops[sig][0], crops[sig][1]
                            inst.append((k, srcbase + i, sig, ww, hh, x0, y0))
                        srcbase += n * 8
                # unique rects to pack: crops + optional blank
                uniq = list(crops.keys()) + (["blank"] if blank_used else [])
                sizes = [(crops[s][0], crops[s][1]) if s != "blank" else (1, 1) for s in uniq]
                lay = layout_sizes(sizes)
                assert lay, (slot, pi, len(g), sizes[:8])
                W, H, pos = lay
                W, H = r8(W), r8(H)
                assert max(W, H) * 2 <= 2048
                pk = f"cz_crouch_{slot}_{pi}"
                arrays = [np.zeros((H * s, W * s, c), np.uint8) for s, c in ((1, 4), (1, 3), (2, 4), (2, 3))]
                placed = {}  # sig -> (x,y,w,h)
                for i, sig in enumerate(uniq):
                    x, y = pos[i]
                    if sig == "blank":
                        placed[sig] = (x, y, 1, 1)
                        continue
                    cw, ch, arrs = crops[sig]
                    placed[sig] = (x, y, cw, ch)
                    for ai, scale in enumerate((1, 1, 2, 2)):
                        a = arrs[ai]
                        arrays[ai][y * scale:(y + ch) * scale, x * scale:(x + cw) * scale] = a[..., :arrays[ai].shape[2]]
                # write dirFrames / frameMeta in sprite-major, then anim-major, facing-major (same as ride)
                by_sprite = defaultdict(list)
                for rec in inst:
                    by_sprite[rec[0]].append(rec)
                for k in g:
                    recs = by_sprite[k]
                    srcbase = 0
                    for name, n in CROUCH_ANIMS.items():
                        df = [None] * (n * 8); fm = {}
                        for d in range(8):
                            for fi in range(n):
                                # recs order follows plan: anim-major, then fi*8+d (render_sprite order)
                                # render_one plan: for idx in range(ne): anim, idx//n, idx%n  => fi, d
                                # so within an anim, index = fi*8+d, which is also the dirFrames index
                                idx = fi * 8 + d
                                _k, _si, sig, ww, hh, x0, y0 = recs[srcbase + idx]
                                rx, ry, rw, rh = placed[sig]
                                ax = round((FW / 2 - x0) / rw, 6)
                                ay = round((FEET - y0) / rh, 6)
                                df[idx] = {"atlas": pk, "rect": {"x": rx, "y": ry, "w": rw, "h": rh}, "anchor": {"x": ax, "y": ay}}
                                if slot == "body":
                                    K = pose(rerender.JOBS[k][1], d, name, fi, n)
                                    anc = {"head": dict(V1_HEAD)}
                                    for field, hand in (("anchor", "handR"), ("anchorL", "handL")):
                                        a = K[field]
                                        if a is None:
                                            continue
                                        anc[hand] = {**a, "x": round(a["x"] - FW / 2, 2), "y": round(a["y"] - FEET, 2)}
                                    fm[f"df:{idx}"] = {"anchors": anc}
                        anim = {"frames": list(range(n)), "fps": CROUCH_FPS[name], "directions": 8, "dirStride": n, "loop": True, "dirFrames": df}
                        if fm:
                            anim["frameMeta"] = fm
                        sprites[k]["animations"][name] = anim
                        srcbase += n * 8
                # colour 1x/@2x + 1x tintmask only (wear convention). 2x tintmask is a nearest upscale of a
                # 0/255 mask, so we skip tintmask@2x to keep the Pages dist lean; the client falls back to 1x.
                paths = [f"atlases/{pk}{suffix}.png" for suffix in ("", ".tintmask", "@2x")]
                for a, path, mode in zip((arrays[0], arrays[1], arrays[2]), paths, ("RGBA", "RGB", "RGBA")):
                    assert set(np.unique(a[..., -1] if mode == "RGBA" else a)) <= {0, 255}
                    Image.fromarray(a, mode).save(dest / path, optimize=True)
                new_atlases.append({"key": pk, "image": paths[0], "frameW": W, "frameH": H, "columns": 1, "rows": 1,
                                    "pages": [{"scale": 2, "image": paths[2]}], "masks": {"tintmask": paths[1]}})
                print("packed", pk, len(g), "sprites", W, H, "unique", len(uniq), flush=True)
            del items
    encode = dest / "manifest.crouch-encode.json"
    try:
        encode.write_text(json.dumps({"atlases": new_atlases}))
        subprocess.run(["python3", str(root / "assets/tools/ktx2.py"), str(encode)], cwd=root, check=True)
        m["atlases"].extend(json.loads(encode.read_text())["atlases"])
    finally:
        encode.unlink(missing_ok=True)
    # lossless PNG recompress (does not change pixels; KTX2 already encoded)
    pngs = []
    for a in new_atlases:
        pngs.append(str(dest / a["image"]))
        pngs.append(str(dest / a["pages"][0]["image"]))
        pngs.append(str(dest / a["masks"]["tintmask"]))
    oxipng_paths(pngs)
    rerender.czm.save(str(mp), m)
    print("complete", len(keys), "sprites", dict(Counter(rerender.JOBS[k][2] for k in keys)), len(new_atlases), "new pages", flush=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("root"); ap.add_argument("--jobs", type=int, default=7)
    ap.add_argument("--replace-slots", default="", help="scoped repaint of existing crouch pages, comma-separated slots")
    args = ap.parse_args(); main(args.root, args.jobs, tuple(filter(None, args.replace_slots.split(","))))
