#!/usr/bin/env python3
"""Re-render selected customization sprites from the current sources (parts/rig/catalog) for EVERY anim entry they ship
(base anims, blink/hurt/expressions, sit, swim incl. swimfx sink, punch) and hand them to rectpack.py, so art fixes in the
sources land in the pack reproducibly without a full build_all + merge chain.
  * frames go to temporary grid pages (cz_tmp_<sprite>, 1x + @2x + tintmask) referenced by rect dirFrames with the rig feet
    pivot; rectpack.py then trims/dedupes/packs them onto the normal cz_wr_* pages and deletes the temporary pages;
  * neutral-tone contract (tools/neutral.py, K=0.13) is applied per sprite exactly like swim_punch_merge.py;
  * wearable `layer` / `tintChannels` are synced from catalog.py (layered tops: the main layer).
Usage: python3 rerender.py ENGINE_DIR --keys PREFIX[,PREFIX...] --slots face,eyes,... [--tight eyes,face] [--jobs N]
Then: python3 assets/tools/ktx2.py <manifest>; pnpm --filter @engine/assets lock:ids:pack; pnpm check"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools"))
import numpy as np
from PIL import Image
from multiprocessing import Pool
import rig, build_all, catalog, swimfx, rectpack
from rig import FW, FH, FEET, PAD, SWIM_N, PUNCH_N, SIT_N, SWIM_Z
import importlib.util as _iu, os as _os  # ADR-138: manifest may be a v2 shard index
_spec = _iu.spec_from_file_location("cz_manifest", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "../../../packages/assets/scripts/cz_manifest.py"))
czm = _iu.module_from_spec(_spec); _spec.loader.exec_module(czm)
WL = FEET - 2; SHIFT = WL - round(FEET - SWIM_Z); COLS = 32
JOBS = {j[0]: j for j in build_all.jobs()}
NA = {a[0]: a[1] for a in rig.ANIMS}

def rigframe(anim, i):
    if anim in rig.BLOCK_ANIMS: return anim, i, rig.BLOCK_ANIMS[anim]
    if anim == "hit": return "hit", i, rig.HIT_N
    if anim in NA: return anim, i, NA[anim]
    if anim == "blink": return "idle", [0, 3, 0][i], 4
    if anim == "hurt": return "hit", i, 2
    if anim in rig.EXPR_EXTRA: return anim, 0, 1
    return anim, i, {"sit": SIT_N, "swim": SWIM_N, "punch": PUNCH_N, **rig.GATHER_N}[anim]

def render_one(key, anim, i, d):
    import render
    j = JOBS[key]; ra, fi, n = rigframe(anim, i)
    (i1, i2, m1, m2), _ = render.render_frame(j[1], j[2], j[3], d, ra, fi, n, j[4], j[5] if len(j) > 5 else None)
    fr = []
    for im, m, s in ((i1, m1, 1), (i2, m2, 2)):
        a = np.asarray(im).copy(); m = np.asarray(m).copy(); p = PAD * s
        if ra == "swim":
            a = swimfx.sink(a, SHIFT * s, WL * s); m = swimfx.sink(m, SHIFT * s, WL * s)
            if key.startswith("body_"):   # bodies carry the water ripple (as swim_punch_merge)
                b, f = swimfx.ripple(FW, FH, FW / 2, WL, 12.5, 3.6, fi, s); m[f[..., 3] > 100] = 0; a = swimfx.apply_base(a, b, f)
        for arr in (a, m): arr[:p] = 0; arr[-p:] = 0; arr[:, :p] = 0; arr[:, -p:] = 0
        # Water-ripple compositing happens after Ctx.out: harden its alpha too.
        a[..., 3] = np.where(a[..., 3] >= 128, 255, 0)
        m[a[..., 3] == 0] = 0; fr += [a, m]
    return fr

def render_sprite(args):
    key, plan = args          # plan: [(anim, n_entries, directions)]
    out = []
    for anim, ne, n in plan:
        for idx in range(ne): out.append(render_one(key, anim, idx // n, idx % n))
    allA = np.concatenate([f[0].reshape(-1, 4) for f in out]).astype(np.float32); allM = np.concatenate([f[1].reshape(-1, 3) for f in out]).astype(np.float32) / 255
    w = np.clip(np.maximum(allM[:, 0], allM[:, 1]), 0, 1); sel = (w > .8) & (allA[:, 3] > 250)
    if sel.any() and np.median(allA[:, :3][sel].max(1)) >= 212:
        for fr in out:
            for ai, mi in ((0, 1), (2, 3)):
                a = fr[ai].astype(np.float32); mm = fr[mi].astype(np.float32) / 255; ww = np.clip(np.maximum(mm[..., 0], mm[..., 1]), 0, 1)
                a[..., :3] *= (1 - .13 * ww)[..., None]; fr[ai] = np.clip(a + .5, 0, 255).astype(np.uint8)
    for fr in out:
        for ai in (0, 2): fr[ai][fr[ai][..., 3] == 0] = 0
    return key, out

def sync_wearables(m):
    cat = {key: (slot, kw) for key, slot, spec, kw in catalog.W}
    for w in m["wearables"]:
        if w["key"] not in cat: continue
        slot, kw = cat[w["key"]]; layer = kw.get("layer", catalog.LAYER[slot])
        if "layers" in w: w["layers"][0]["layer"] = layer
        else: w["layer"] = layer
        w["tintChannels"] = kw.get("tint", 0)

def main(eng, prefixes, slots, tight, jobs):
    D = os.path.join(eng, "packages/assets/pack/customization"); MP = os.path.join(D, "manifest.customization.json")
    m = czm.load(MP); sync_wearables(m)
    keys = sorted(s["key"] for s in m["sprites"] if any(s["key"].startswith(p) for p in prefixes))
    assert keys and all(k in JOBS for k in keys), [k for k in keys if k not in JOBS]
    S = {s["key"]: s for s in m["sprites"]}
    work = [(k, [(a, len(an["frames"]) * an.get("directions", 1), an.get("directions", 1)) for a, an in S[k]["animations"].items() if not a.startswith("sleep_lie")]) for k in keys]
    body = any(k.startswith("body_") for k in keys)
    with Pool(jobs) as P:     # stream: write each sprite's temp page as soon as it is rendered (bounded memory)
        for k, out in P.imap_unordered(render_sprite, work):
            print("rendered", k, "frames", len(out), flush=True)
            n = len(out); rows = -(-n // COLS); pk = "cz_tmp_" + k.replace("cz_", "", 1)
            o1 = np.zeros((rows * FH, COLS * FW, 4), np.uint8); ot = np.zeros((rows * FH, COLS * FW, 3), np.uint8)
            o2 = np.zeros((2 * rows * FH, 2 * COLS * FW, 4), np.uint8); t2 = np.zeros((2 * rows * FH, 2 * COLS * FW, 3), np.uint8)
            for c, fr in enumerate(out):
                x, y = c % COLS * FW, c // COLS * FH
                o1[y:y + FH, x:x + FW] = fr[0]; ot[y:y + FH, x:x + FW] = fr[1][..., :3]; o2[2 * y:2 * y + 2 * FH, 2 * x:2 * x + 2 * FW] = fr[2]
                t2[2 * y:2 * y + 2 * FH, 2 * x:2 * x + 2 * FW] = fr[3][..., :3]
            del out
            pages = [(o1, f"atlases/{pk}.png", "RGBA"), (o2, f"atlases/{pk}@2x.png", "RGBA"), (ot, f"atlases/{pk}.tintmask.png", "RGB")]
            if k.startswith("body_"): pages.append((t2, f"atlases/{pk}.tintmask@2x.png", "RGB"))   # bodies keep tintmask@2x
            for arr, p, mode in pages: Image.fromarray(arr, mode).save(os.path.join(D, p))
            m["atlases"].append({"key": pk, "image": f"atlases/{pk}.png", "frameW": FW, "frameH": FH, "columns": COLS, "rows": rows,
                                 "pages": [{"scale": 2, "image": f"atlases/{pk}@2x.png"}], "masks": {"tintmask": f"atlases/{pk}.tintmask.png"}})
            c = 0
            for a, an in S[k]["animations"].items():
                # Bed-pivot lying art is painted separately by add_sleep_lie_acc.py.
                if a.startswith("sleep_lie"): continue
                df = []
                for _ in range(len(an["frames"]) * an.get("directions", 1)):
                    df.append({"atlas": pk, "rect": {"x": c % COLS * FW, "y": c // COLS * FH, "w": FW, "h": FH}, "anchor": {"x": 0.5, "y": FEET / FH}}); c += 1
                an["dirFrames"] = df
    czm.save(MP, m)
    rectpack.main(eng, slots, False, tight, body)

if __name__ == "__main__":
    a = sys.argv; arg = lambda f, d=None: a[a.index(f) + 1] if f in a else d
    main(a[1], arg("--keys").split(","), arg("--slots").split(","), tuple((arg("--tight") or "").split(",")) if arg("--tight") else rectpack.ALL_TIGHT, int(arg("--jobs", "8")))
