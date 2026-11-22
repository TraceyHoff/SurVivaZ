"""Facing-split pages for vehicles whose single state (8 facings) cannot fit a PAGE1 (1008px) 1x page.

    python3 split_facings.py <out_pack_vehicles_dir>      (after build.py, before assemble.py; reads /tmp/veh_frames.pkl)

Facings are grouped by silhouette (E/W, N/S, diagonals); each group gets its own tight uniform cell (union alpha bbox of
that group over all states + 2px gutter, 4px at @2x) and its own pages veh_art_<key>_f<g><p> (<= PAGE1 at 1x, 16-aligned,
+ @2x <= 2016, tintmask, emissive). Pixels are the exact build.py frames (cropped, not re-rendered).
Every sprite drawing such a vehicle gets per-animation `dirFrames` ([frameIdx * directions + dir] -> {atlas, frame,
anchor}). The renderer resolves dirFrames (render 62e770d), so the legacy uniform pages are dropped: each split sprite's
`atlas` is pointed at its first facing page (dir 0 = E, the fh page) and the old full-size page files (+@2x, masks, ktx2)
are deleted. `frames`/`frameAttach` keep their legacy indices (attach points are keyed by them); the assets validator
skips their atlas-range checks when every animation has dirFrames.

    python3 split_facings.py --retarget <manifest.json>   one-off: apply the retarget/delete to an already assembled manifest
"""
import sys, json, math, pickle, numpy as np
from PIL import Image
from build import PAGE1, r16, STATES, VSPEC
from vrender import save_indexed

OUT = sys.argv[1]
GROUPS = [("h", (0, 4)), ("v", (2, 6)), ("d", (1, 3, 5, 7))]  # Art order E,SE,S,SW,W,NW,N,NE
G1 = 2

def main():
    part = json.load(open(OUT + "/_vehicles_part.json"))
    if any("dirFrames" in a for s in part["sprites"] for a in s["animations"].values()): sys.exit("already split (re-run build.py)")
    frames = pickle.load(open("/tmp/veh_frames.pkl", "rb"))
    at_by = {a["key"]: a for a in part["atlases"]}
    big = {k for k, a in at_by.items() if max(r16(a["columns"] * a["frameW"]), r16(a["rows"] * a["frameH"])) > PAGE1}
    vkeys = sorted({key3[0] for (g, _), (key3, *_r) in frames.items() if g in big})
    new_atlases, report = [], []
    for vk in vkeys:
        fr = {key3[1:]: (g, k, v[1:]) for (g, k), v in frames.items() for key3 in [v[0]] if key3[0] == vk}
        # fr[(state, d)] = (legacy atlas, legacy frame, (i1, i2, t1, e1))
        states = STATES[VSPEC[vk]["fam"]]
        a0 = at_by[fr[(states[0], 0)][0]]; fw, fh = a0["frameW"], a0["frameH"]
        spr = next(s for s in part["sprites"] if s["atlas"] == fr[(states[0], 0)][0])
        piv = (spr["anchor"]["x"] * fw, spr["anchor"]["y"] * fh)
        lookup = {}  # (state, d) -> {atlas, frame, anchor}
        for gn, dirs in GROUPS:
            m = np.zeros((fh, fw), bool)
            for s in states:
                for d in dirs:
                    i1, i2, t1, e1 = fr[(s, d)][2]; m |= (i1[..., 3] > 0) | (t1 > 0) | (e1.max(-1) > 0)
            ys, xs = np.nonzero(m); x0, y0 = int(max(0, xs.min() - G1)), int(max(0, ys.min() - G1)); x1, y1 = int(min(fw, xs.max() + 1 + G1)), int(min(fh, ys.max() + 1 + G1))
            cw, ch = x1 - x0, y1 - y0; cells = [(s, d) for s in states for d in dirs]
            cols = PAGE1 // cw; rows_pp = PAGE1 // ch; per = cols * rows_pp; assert per >= 1, (vk, gn, cw, ch)
            for p in range(math.ceil(len(cells) / per)):
                chunk = cells[p * per:(p + 1) * per]; c_ = min(cols, len(chunk)); rows = math.ceil(len(chunk) / c_)
                W, H = r16(c_ * cw), r16(rows * ch); key = f"veh_art_{vk}_f{gn}{p}"
                P1 = np.zeros((H, W, 4), np.uint8); P2 = np.zeros((H * 2, W * 2, 4), np.uint8); TM = np.zeros((H, W), np.uint8); EM = np.zeros((H, W, 3), np.uint8)
                for k, sd in enumerate(chunk):
                    i1, i2, t1, e1 = fr[sd][2]; c, r = k % c_, k // c_
                    P1[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = i1[y0:y1, x0:x1]; TM[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = t1[y0:y1, x0:x1]
                    EM[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = e1[y0:y1, x0:x1]
                    P2[r * ch * 2:(r + 1) * ch * 2, c * cw * 2:(c + 1) * cw * 2] = i2[y0 * 2:y1 * 2, x0 * 2:x1 * 2]
                    lookup[sd] = {"atlas": key, "frame": k, "anchor": {"x": round((piv[0] - x0) / cw, 5), "y": round((piv[1] - y0) / ch, 5)}}
                save_indexed(P1, f"{OUT}/atlases/{key}.png"); save_indexed(P2, f"{OUT}/atlases/{key}@2x.png")
                Image.fromarray(TM, "L").save(f"{OUT}/atlases/{key}.tintmask.png", optimize=True)
                masks = {"tintmask": f"atlases/{key}.tintmask.png"}
                if EM.max() > 0: Image.fromarray(EM).save(f"{OUT}/atlases/{key}_emissive.png", optimize=True); masks["emissive"] = f"atlases/{key}_emissive.png"
                new_atlases.append({"key": key, "image": f"atlases/{key}.png", "frameW": cw, "frameH": ch, "columns": c_, "rows": rows,
                                    "pages": [{"scale": 2, "image": f"atlases/{key}@2x.png"}], "masks": masks})
                report.append((key, cw, ch, c_, rows, W, H))
        legacy = {(fr[sd][0], fr[sd][1]): sd for sd in fr}
        for s in part["sprites"]:
            for an in s["animations"].values():
                n = an.get("directions", 1)
                if n != 8 or (s["atlas"], an["frames"][0]) not in legacy: continue
                an["dirFrames"] = [lookup[legacy[(s["atlas"], f0 + d * an.get("dirStride", 1))]] for f0 in an["frames"] for d in range(8)]
    part["atlases"] += new_atlases
    retarget(part, OUT)
    txt = json.dumps(part); open(OUT + "/_vehicles_part.json", "w").write(txt)
    for r in report: print(r)

def retarget(m, base):
    """Point fully-split sprites at their first facing page; drop atlases no sprite/dirFrame references anymore and their files."""
    import os, glob
    old = set()
    for sp in m["sprites"]:
        an = list(sp["animations"].values())
        if an and all(a.get("dirFrames") for a in an):
            old.add(sp["atlas"]); sp["atlas"] = an[0]["dirFrames"][0]["atlas"]
    used = {sp["atlas"] for sp in m["sprites"]} | {d["atlas"] for sp in m["sprites"] for a in sp["animations"].values() for d in a.get("dirFrames", [])}
    gone = old - used; m["atlases"] = [a for a in m["atlases"] if a["key"] not in gone]; n = 0
    for k in gone:
        for f in glob.glob(os.path.join(base, "atlases", glob.escape(k) + "[.@_]*")):
            stem = os.path.basename(f).split(".")[0].split("@")[0]
            if stem in (k, k + "_emissive"): os.remove(f); n += 1
    print("retarget: dropped", len(gone), "legacy atlases,", n, "files"); return gone

if __name__ == "__main__":
    if sys.argv[1:2] == ["--retarget"]:
        import os; mp = sys.argv[2]; m = json.load(open(mp)); t = open(mp).read()
        retarget(m, os.path.dirname(mp)); open(mp, "w").write(json.dumps(m, indent=1 if "\n" in t.strip() else None) + ("\n" if t.endswith("\n") else ""))
    else: main()
