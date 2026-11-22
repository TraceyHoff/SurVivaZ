# ADR-211: twig (tier 0) art for the vertex corner pieces. Tier 0 draws the bare key, which build.py mapped to the
# tier-1 wood frames (placeholder). Renders the corners with the main pack's "twig" material (thatch/wattle, bark
# frame) on a small always-resident page `building_tw` (not /^building_t\d+$/, so never streamed) and repoints the
# bare-key sprites at it. Same cell crop/pivot/rotation rows as build.py. Usage: cd src && python3 twig_corners.py ..
# ADR-504: superseded for the 80 px floor by add_building_80px.py (84x120 cells, pivot (42,99)); do not re-run.
import json, sys
from PIL import Image
import pieces as PC
import build as BD
OUT = sys.argv[1] if len(sys.argv) > 1 else '..'
KEYS = ["wall_corner_outer", "wall_corner_inner", "wall_corner_angled"]
PC.TIER_NAMES[0] = "twig"
if __name__ == '__main__':
    frames = []; idx = {}
    for k in KEYS:
        for r in range(PC.PIECES[k][3]):
            _, out = BD.render((0, k, r)); assert not any(c for _, c in out), (k, r)
            idx[(k, r)] = len(frames); frames += [im for im, _ in out]
    cols = 16; rows = (len(frames) + cols - 1) // cols
    page = Image.new('RGBA', (BD.CW * cols, BD.CH * rows), (0, 0, 0, 0))
    for i, f in enumerate(frames): page.paste(f, ((i % cols) * BD.CW, (i // cols) * BD.CH))
    akey = 'building_tw'; page.save(f'{OUT}/atlases/{akey}.png', optimize=True)
    p = f'{OUT}/manifest.building.json'; man = json.load(open(p))
    man["atlases"] = [a for a in man["atlases"] if a["key"] != akey] + [{"key": akey, "image": f"atlases/{akey}.png", "frameW": BD.CW, "frameH": BD.CH, "columns": cols, "rows": rows}]
    n = 0
    for s in man["sprites"]:
        b = s.get("building") or {}
        if b.get("piece") in KEYS:
            k = b["piece"]; nr = PC.PIECES[k][3]
            s["atlas"] = akey; b["frames"] = [[idx[(k, r)] + st for st in range(4)] for r in range(nr)]
            s["animations"] = {"idle": {"frames": [b["frames"][0][0]], "fps": 1}}; n += 1
    assert n == len(KEYS), n
    json.dump(man, open(p, 'w'), indent=1); open(p, 'a').write('\n')
    print(akey, page.size, len(frames), 'frames,', n, 'sprites repointed')
