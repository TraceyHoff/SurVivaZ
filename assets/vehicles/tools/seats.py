"""Seat / rider anchors + true-scale measurements for the vehicles pack.  PYTHONHASHSEED=0 python3 seats.py <pack/vehicles dir> [report.json]

Writes <pack>/seats.vehicles.json: per vehicle key (aliases listed), every rider seat with its model position (metres,
vehicle-local: x forward, y right, z up) and, per facing (E, SE, S, SW, W, NW, N, NE = the sheet's dir order), the seat
H-point as 1x px offsets from the sprite pivot (@2x: double them) plus the draw-order rule:
  draw "over"   - open seat (bikes): draw the seated rider after (in front of) the vehicle sprite.
  draw "window" - cabin seat: draw the rider after the vehicle sprite but only the screen rows clipTop..clipBottom (roof
                  underside .. beltline at that seat, 1x px from the pivot); below the beltline the door hides the legs,
                  above clipTop the roof covers the head. Fallback without clipping: draw it before the sprite (occluded).
Also measures every key's E view from the shipped pages (opaque top above the pivot, opaque length) for the docs table."""
import sys, os, json, math, numpy as np
from PIL import Image
from build import VSPEC, VEH, model
from vrender import project_point, ZK, U, DIRS, M_GLASS
from vehicles import SEAT_NAMES

PACK = sys.argv[1]; REP = sys.argv[2] if len(sys.argv) > 2 else None
man = json.load(open(os.path.join(PACK, "manifest.vehicles.json")))
A = {a["key"]: a for a in man["atlases"]}; S = {s["key"]: s for s in man["sprites"]}; META = {v["key"]: v for v in man["vehicles"]}

def glass_band(m, x, y):
    """(beltline z, roof-underside z) of the glass nearest the seat (m); None when the model has no glass (open seat)."""
    best = None
    for pr in m.prims:
        for v, n_, mat, *_ in pr.polys:
            if mat != M_GLASS: continue
            x0, x1 = v[:, 0].min(), v[:, 0].max(); d = 0 if x0 - 0.05 <= x <= x1 + 0.05 else min(abs(x - x0), abs(x - x1))
            z0, z1 = v[:, 2].min(), v[:, 2].max()
            if z1 - z0 < 0.08: continue
            if best is None or d < best[0] - 1e-6 or (abs(d - best[0]) < 1e-6 and z1 - z0 > best[2] - best[1]): best = (d, z0, z1)
    return None if best is None else (round(float(best[1]), 3), round(float(best[2]), 3))

def frame_px(key, d):
    s = S[key]; an = s["animations"]["intact"]
    if an.get("dirFrames"): f = an["dirFrames"][d]; a = A[f["atlas"]]; idx = f["frame"]; anc = f["anchor"]
    else: a = A[s["atlas"]]; idx = an["frames"][0] + d * an.get("dirStride", 1); anc = s["anchor"]
    im = Image.open(os.path.join(PACK, a["image"])).convert("RGBA"); c, r = idx % a["columns"], idx // a["columns"]
    fr = np.asarray(im.crop((c * a["frameW"], r * a["frameH"], (c + 1) * a["frameW"], (r + 1) * a["frameH"])))
    return fr, (anc["x"] * a["frameW"], anc["y"] * a["frameH"]), a

out = {"$comment": __doc__.split("\n\n")[1].strip(), "scale": {"pxPerMetreLength": round(U, 3), "pxPerMetreHeight": round(ZK, 3),
       "pxPerMetreDepth": round(U / 2, 3), "playerPx": 53, "playerM": 1.75}, "dirs": DIRS, "vehicles": {}}
report = []
for key, src, Lp, Hm, Wt, seat_m, legacy in VEH:
    m = model(key, "intact"); v = VSPEC[key]; ent = {"aliases": legacy, "realSize": {"length": round(Lp / U, 2), "width": Wt, "height": Hm}, "seats": []}
    for n in SEAT_NAMES:
        if n not in m.attach: continue
        x, y, z = m.attach[n]; band = glass_band(m, x, y); draw = "window" if band else "over"
        per = {}
        for d in range(8):
            px, py, _ = project_point((x, y, z), d)
            e = {"x": round(px, 1), "y": round(py, 1)}
            if band:
                e["clipTop"] = round(project_point((x, y, band[1]), d)[1], 1); e["clipBottom"] = round(project_point((x, y, band[0]), d)[1], 1)
            per[DIRS[d]] = e
        ent["seats"].append({"name": n, "u": round(float(x), 3), "v": round(float(y), 3), "z": round(float(z), 3), "zPx": round(float(z) * ZK, 1),
                             "draw": draw, **({"window": {"beltZ": band[0], "roofZ": band[1]}} if band else {}), "facings": per})
    fr, (pvx, pvy), a = frame_px(key, 0); al = fr[..., 3] == 255; ys = np.nonzero(al.any(1))[0]; xs = np.nonzero(al.any(0))[0]
    mxz = max(float(vv[:, 2].max()) for pr in m.prims for vv, *_ in pr.polys)
    report.append({"key": key, "aliases": legacy, "L_m": round(Lp / U, 2), "W_m": Wt, "H_m": Hm, "targetL": Lp, "targetH": round(Hm * ZK),
                   "roofPx": round(mxz * ZK, 1), "topAbovePivot": round(pvy - ys.min(), 1), "opaqueLen": int(xs.max() - xs.min() + 1),
                   "seats": len(ent["seats"]), "seatZm": seat_m, "wheelR_m": None})
    out["vehicles"][key] = ent
json.dump(out, open(os.path.join(PACK, "seats.vehicles.json"), "w"), indent=1)
if REP: json.dump(report, open(REP, "w"), indent=1)
for r in report: print(r)
