"""Pack the seasons ground tileset into resident `gt_` atlases in pack/manifest.json (alongside the shipped tile_* terrain).
python3 ground_pack.py            renders missing tiles into $GROUND_CACHE (pool of 8), packs 1x + @2x pages, merges the manifest.
python3 ground_pack.py --manifest-only   rewrites only the manifest entries (no render, no page PNGs; keeps ktx2 fields).
Residency: resident (ADR-246 follow-up: the engine keeps gt_ pages hot at 1x; RESIDENT_GROUND_RE). Every sprite carries a
placeholder: bases -> legacy tile_*, fall/winter/spring overlays -> their summer twin; spring pages themselves are packed by artpass_spring_ground.py, summer edges -> the invader base,
summer shore/bank -> gt_water_shallow, fall leaf decals -> gt_water.
Cells: 64x48 art (64x32 diamond; bases carry no skirt: side faces are separate gt_side_* sprites, 16 px = one level) padded 2 px -> 68x52 (1x) / 136x104 (@2x); anchor keeps the diamond centre
(0.5, 18/52). Pages are per season (gt_<season>_p<N>), 15x19 cells -> <=1020x988 (1x), <=2040x1976 (@2x). Re-runnable."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image
import ground_preview as GPV
from ground_tiles import BLOB47

R = 'packages/assets/pack/'; PAD = 2; FW, FH = 64, 48; CW, CH = FW + 2 * PAD, FH + 2 * PAD; COLS, ROWS = 15, 19
ANCHOR = {'x': 0.5, 'y': round((FH / 3 + PAD) / CH, 6)}
MATS = ['grass', 'dirt', 'forest', 'sand', 'stone', 'mud', 'snow']
NAME = {'stone': 'rock'}
PH = {'grass': 'tile_grass', 'dirt': 'tile_dirt', 'forest': 'tile_forest', 'sand': 'tile_sand', 'stone': 'tile_rock', 'mud': 'tile_dirt', 'snow': 'tile_snow'}
INV = ['sand', 'dirt', 'mud', 'forest', 'grass', 'snow']
MASKS = [m for m in BLOB47 if m]            # mask 0 = no overlay
SUF = ['', '_b', '_c', '_d', '_e', '_f']
SEAS = ['summer', 'fall', 'winter']; TW = {'summer': '', 'fall': '_fall', 'winter': '_winter'}

from scipy.ndimage import binary_dilation
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../../../assets/tools'))
from ktx2 import dilate
def bleed(t, sc):
    """Base tiles (land, water, ice) tile seamlessly: the ice diamond continues PAD px past its edges into the cell padding (copied from the
    lattice-shifted diamond, i.e. what the neighbour shows there), so filtering / mips / sub-pixel gaps never reveal
    an outline. Front edges only (the shader keeps <=1.02 of it; the front neighbour covers the rest). RGB under alpha 0
    is push-pull dilated per page (as ktx2.py does), so filtered / downscaled pages never pull black or skirt colour in."""
    p = PAD * sc; h, w = t.shape[:2]; out = np.zeros((h + 2 * p, w + 2 * p, 4), np.uint8); out[p:p + h, p:p + w] = t
    src = out.copy(); dx, dy = FW // 2 * sc, FH // 3 * sc   # half diamond: 32 x 16 (@1x)
    near = binary_dilation(out[..., 3] == 255, np.ones((3, 3), bool), iterations=p)   # only the PAD px ring ...
    near[:p + FH // 3 * sc] = False   # ... on the front (lower) edges only: a back-edge ring would be drawn over the back
    # neighbour (a strip of this material across a different one); the front ring sits under the front neighbour
    for ox, oy in ((dx, dy), (-dx, dy), (dx, -dy), (-dx, -dy), (2 * dx, 0), (-2 * dx, 0), (0, 2 * dy), (0, -2 * dy)):
        sh = np.zeros_like(src)
        ys, yd = (slice(0, src.shape[0] - oy), slice(oy, None)) if oy >= 0 else (slice(-oy, None), slice(0, src.shape[0] + oy))
        xs, xd = (slice(0, src.shape[1] - ox), slice(ox, None)) if ox >= 0 else (slice(-ox, None), slice(0, src.shape[1] + ox))
        sh[yd, xd] = src[ys, xs]; fill = near & (out[..., 3] == 0) & (sh[..., 3] == 255); out[fill] = sh[fill]
    return out

def plan():
    """[(sprite_key, season_page, [render keys], fps, placeholder)] in manifest order."""
    S = []
    for mat in MATS:
        for v in range(6):
            base = f'gt_{NAME.get(mat, mat)}{SUF[v]}'
            for se in SEAS: S.append((base + TW[se], se, [f'base|{mat}|{se}|{v}'], 1, PH[mat]))
    for w in ('gt_water', 'gt_water_shallow'):
        ph = w.replace('gt_', 'tile_')
        S.append((w, 'summer', [f'{"ws" if w.endswith("shallow") else "w"}|summer|{f}' for f in range(4)], 4, ph))   # fall draws these too (no _fall twin)
        S.append((w + '_winter', 'winter', ['ice|0'], 1, ph))
    for v in range(6): S.append((f'gt_ice{SUF[v]}', 'winter', [f'ice|{v}'], 1, 'tile_water'))
    for v in range(3): S.append((f'gt_water_leaves_{"abc"[v]}', 'fall', [f'lv|{v}'], 1, 'gt_water'))
    for inv in INV:
        for m in MASKS:
            k0 = f'gt_{NAME.get(inv, inv)}_edge_{m}'
            for se in SEAS: S.append((k0 + TW[se], se, [f'ov|{inv}|{se}|{m}'], 1, k0 if se != 'summer' else f'gt_{NAME.get(inv, inv)}'))
    for style, nm in (('sand', 'shore'), ('bank', 'bank')):
        for m in MASKS:
            for se in SEAS:
                fr = [f'sh|{style}|{se}|{m}|0'] if se == 'winter' else [f'sh|{style}|{se}|{m}|{f}' for f in range(4)]
                S.append((f'gt_{nm}_{m}{TW[se]}', se, fr, 4 if len(fr) > 1 else 1, f'gt_{nm}_{m}' if se != 'summer' else 'gt_water_shallow'))
    for mat in MATS:   # cliff side faces (one height level; base frames carry no skirt any more)
        k0 = f'gt_side_{NAME.get(mat, mat)}'
        for se in SEAS: S.append((k0 + TW[se], se, [f'side|{mat}|{se}'], 1, k0 if se != 'summer' else f'gt_{NAME.get(mat, mat)}'))
        for se in SEAS: S.append((k0 + '_low' + TW[se], se, [f'sidel|{mat}|{se}'], 1, k0 + TW[se]))   # lower levels: no lip
    return S

def main():
    S = plan(); keys = sorted({k for s in S for k in s[2]}); only = '--manifest-only' in sys.argv
    print('sprites', len(S), 'unique cells', len(keys), 'cache', GPV.CACHE, flush=True)
    if not only: GPV.ensure(keys, 8)
    # assign cells to per-season pages (an animated sprite never straddles two pages); dedup render keys per season
    per = COLS * ROWS; pages = {}; amap = {}
    for key, se, fr, _, _ in S:
        pl = pages.setdefault(se, [[]]); new = [k for k in dict.fromkeys(fr) if (se, k) not in amap]
        if len(pl[-1]) + len(new) > per: pl.append([])
        for k in new: pl[-1].append(k); amap[(se, k)] = (f'gt_{se}_p{len(pl) - 1}', len(pl[-1]) - 1)
    atlases = []
    for se in SEAS:
        for pi, chunk in enumerate(pages[se]):
            name = f'gt_{se}_p{pi}'; cols = min(COLS, len(chunk)); rows = -(-len(chunk) // cols)
            for sc in (() if only else (1, 2)):
                im = Image.new('RGBA', (cols * CW * sc, rows * CH * sc), (0, 0, 0, 0))
                for i, k in enumerate(chunk):
                    t = np.asarray(GPV.get(k, sc)).copy(); t[..., 3] = np.where(t[..., 3] >= 128, 255, 0); t[t[..., 3] == 0] = 0
                    if k.startswith(('ice|', 'base|', 'w|', 'ws|')): im.paste(Image.fromarray(bleed(t, sc), 'RGBA'), (i % cols * CW * sc, i // cols * CH * sc)); continue
                    im.paste(Image.fromarray(t, 'RGBA'), ((i % cols * CW + PAD) * sc, (i // cols * CH + PAD) * sc))
                im = dilate(im); im.save(R + f'atlases/{name}{"" if sc == 1 else "@2x"}.png', optimize=True)
            atlases.append({'key': name, 'image': f'atlases/{name}.png', 'frameW': CW, 'frameH': CH, 'columns': cols, 'rows': rows,
                            'pages': [{'scale': 2, 'image': f'atlases/{name}@2x.png'}]})
    sprites = []
    for key, se, fr, fps, ph in S:
        at = {amap[(se, k)][0] for k in fr}; assert len(at) == 1, key
        d = {'key': key, 'category': 'tile', 'atlas': at.pop(), 'anchor': dict(ANCHOR),
             'animations': {'idle': {'frames': [amap[(se, k)][1] for k in fr], 'fps': fps}}}
        if ph: d['placeholder'] = ph
        sprites.append(d)
    m = json.load(open(R + 'manifest.json'))
    old = {a['key']: a for a in m['atlases']}
    for a in atlases:   # keep KTX2 siblings (ktx2.py re-encodes any page whose PNG is newer)
        o = old.get(a['key'])
        if o and (o['columns'], o['rows']) == (a['columns'], a['rows']):
            if 'ktx2' in o: a['ktx2'] = o['ktx2']
            for pg, po in zip(a['pages'], o.get('pages', [])):
                if 'ktx2' in po: pg['ktx2'] = po['ktx2']
    def _retain_gt(key):
        # Spring pages (artpass_spring_ground.py) and grazed grass (artpass_batch1.py) are
        # packed outside this SEAS list. Dropping them here would wipe those atlases.
        return (key.startswith('gt_spring') or key.startswith('gt_grazed')
                or key.startswith('gt_grass_grazed') or key.startswith('gt_waterfall')
                or (key.startswith('gt_') and key.endswith('_spring')))
    m['atlases'] = [a for a in m['atlases'] if not a['key'].startswith('gt_') or _retain_gt(a['key'])]
    m['sprites'] = [s for s in m['sprites'] if not s['key'].startswith('gt_') or _retain_gt(s['key'])]
    ia = next(i for i, a in enumerate(m['atlases']) if a['key'] == 'tiles') + 1
    m['atlases'][ia:ia] = atlases
    isp = max(i for i, s in enumerate(m['sprites']) if s['atlas'] == 'tiles') + 1
    m['sprites'][isp:isp] = sprites
    open(R + 'manifest.json', 'w').write(json.dumps(m, indent=2, ensure_ascii=False) + '\n')
    print('atlases', [(a['key'], a['columns'], a['rows']) for a in atlases]); print('sprites', len(sprites))

if __name__ == '__main__': main()
