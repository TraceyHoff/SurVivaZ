"""ADR-590 electricity tier art (brief docs/ART_KEYS_ELECTRICITY.md): targeted, add-only packer for the 26 powered pieces.

Run from repo root:  python3 packages/assets/pack/building/src/add_electricity.py [--upto N] [--preview DIR]
Owns only atlases `elec_<cls>` (+ `_emissive`, + @2x) and the sprites keyed by the piece keys in elec/pieces*.py; never
touches build.py output or any other atlas, never renumbers. Frame order per class page is fixed (batch order, then
piece order, then [unlit, active 0..n-1] per painted facing), so a later batch only appends cells.
Per piece (hearth convention, ADR-218): `animations.idle` = looping active animation (rotations rows for unique4),
`animations.unlit` = 1 frame per painted facing, `building.frames` = first active frame [f,f,f,f] (damage via
bld_crack), `building.states.unlit` = the unlit frame. Emissive mask page per class (glowing pixels only).
After: oxipng + ktx2 (only these pages), `pnpm --filter @engine/assets lock:ids:pack`, shard-manifest, check size."""
import json, os, sys, subprocess, shutil, zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from PIL import Image
HERE = Path(__file__).resolve().parent; sys.path.insert(0, str(HERE))
ROOT = HERE.parents[4]; BLD = ROOT / 'packages/assets/pack/building'
from elec import lib   # noqa: E402

BATCHES = ['pieces1', 'pieces2', 'pieces3']
CLASS_ORDER = ['S', 'T', 'W', 'WT', 'XT', 'XW', 'XXL_T', 'XXL_L']

def registry(upto):
    import importlib
    reg = {}
    for b in BATCHES[:upto]:
        try: mod = importlib.import_module('elec.' + b)
        except ModuleNotFoundError: continue
        for k, v in mod.PIECES.items(): reg[k] = (b, v)
    return reg

def rot_of(v, row):
    """painted row -> render rotation: PIECES entries may carry a 7th field (rotation per row), e.g. (0, 3) for parts
    that must face the camera in both painted facings (panels, wall fixtures)."""
    return v[6][row] if len(v) > 6 else row

_REG = {}
def job(args):
    upto, key, r, f = args
    if upto not in _REG: _REG[upto] = registry(upto)
    b, v = _REG[upto][key]; fn, fp, cls, rows, nf, fps = v[:6]
    r = rot_of(v, r)
    seed = zlib.crc32(key.encode()) % 1000
    if f == 'unlit': g = fn(False, 0.0); out = lib.render_frame(g, r, cls, fp, seed)
    else: out = lib.render_frame(fn(True, f / nf), r, cls, fp, seed, geom=lambda: fn(True, f / nf))
    return (key, r, f), out

def layer_of(key):
    p = json.load(open(ROOT / 'packages/gameplay/data/pieces.json'))['pieces']
    d = next((x for x in p if x['key'] == key), {}); return d.get('layer', 2)

def main():
    upto = int(sys.argv[sys.argv.index('--upto') + 1]) if '--upto' in sys.argv else len(BATCHES)
    prev = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
    reg = registry(upto)
    jobs = [(upto, k, r, f) for k, (b, v) in reg.items() for r in range(v[3]) for f in ['unlit'] + list(range(v[4]))]
    with ProcessPoolExecutor(os.cpu_count()) as ex: R = dict(ex.map(job, jobs, chunksize=1))
    clipped = sorted({k for (k, r, f), v in R.items() if v['clip']})
    assert not clipped, f'clipped: {clipped}'
    man = json.loads((BLD / 'manifest.building.json').read_text())
    keys = set(reg)
    man['atlases'] = [a for a in man['atlases'] if not a['key'].startswith('elec_')]
    man['sprites'] = [s for s in man['sprites'] if s['key'] not in keys]
    stats = {}
    for cls in CLASS_ORDER:
        ks = [k for k in reg if reg[k][1][2] == cls]
        if not ks: continue
        w, h, ox, oy = lib.CLS[cls]
        cap_c = 2048 // (2 * w); cap = cap_c * (2048 // (2 * h))
        pages_k, cur = [], []
        for k in ks:   # whole pieces per page, in registry order (earlier pieces never move)
            n = reg[k][1][3] * (reg[k][1][4] + 1)
            if cur and sum(reg[x][1][3] * (reg[x][1][4] + 1) for x in cur) + n > cap: pages_k.append(cur); cur = []
            cur.append(k)
        pages_k.append(cur)
        for pi, pks in enumerate(pages_k):
            akey = f'elec_{cls.lower()}' + (f'_{pi + 1}' if pi else '')
            cells = [(k, r, f) for k in pks for r in range(reg[k][1][3]) for f in ['unlit'] + list(range(reg[k][1][4]))]
            cols = min(len(cells), cap_c); nrows = (len(cells) + cols - 1) // cols
            assert nrows * h * 2 <= 2048, (cls, nrows)
            pages = {suf: Image.new('RGBA', (cols * w * s, nrows * h * s), (0, 0, 0, 0)) for suf, s in (('', 1), ('@2x', 2), ('_emissive', 1), ('_emissive@2x', 2))}
            idx = {}
            for i, c in enumerate(cells):
                o = R[c]; x, y = i % cols, i // cols; idx[c] = i
                for suf, im, s in (('', o['col'][0], 1), ('@2x', o['col'][1], 2), ('_emissive', o['em'][0], 1), ('_emissive@2x', o['em'][1], 2)):
                    pages[suf].paste(im, (x * w * s, y * h * s))
            for suf, im in pages.items(): im.save(BLD / f'atlases/{akey}{suf}.png', optimize=True)
            man['atlases'].append({'key': akey, 'image': f'atlases/{akey}.png', 'frameW': w, 'frameH': h, 'columns': cols, 'rows': nrows,
                                   'pages': [{'scale': 2, 'image': f'atlases/{akey}@2x.png'}],
                                   'masks': {'emissive': f'atlases/{akey}_emissive.png'}, 'residency': 'stream'})
            for k in pks:
                b, v = reg[k]; fn, fp, _, rows, nf, fps = v[:6]
                lit = [[idx[(k, r, f)] for f in range(nf)] for r in range(rows)]; cold = [idx[(k, r, 'unlit')] for r in range(rows)]
                anim = {'idle': {'frames': lit[0], 'fps': fps, 'loop': True}, 'unlit': {'frames': [cold[0]], 'fps': 1}}
                if rows == 1: fr = [[lit[0][0]] * 4]; un = [[cold[0]] * 4]
                else:
                    anim['idle']['rotations'] = [lit[r % rows] for r in range(4)]; anim['unlit']['rotations'] = [[cold[r % rows]] for r in range(4)]
                    fr = [[lit[r % rows][0]] * 4 for r in range(4)]; un = [[cold[r % rows]] * 4 for r in range(4)]
                man['sprites'].append({'key': k, 'category': 'building', 'atlas': akey, 'anchor': {'x': ox / w, 'y': oy / h}, 'animations': anim,
                                       'building': {'piece': k, 'footprint': {'w': fp[0], 'h': fp[1]}, 'layer': layer_of(k), 'frames': fr,
                                                    'states': {'unlit': un}, 'crackOverlay': 'bld_crack'},
                                       'rotationArt': 'mirror' if rows == 1 else 'unique4'})
                stats[k] = dict(cls=cls, atlas=akey, rows=rows, rots=[rot_of(v, r) for r in range(rows)],
                                top=max(R[(k, r, f)]['top'] for r in range(rows) for f in ['unlit'] + list(range(nf))),
                                top_unlit=R[(k, 0, 'unlit')]['top'], frames=rows * (nf + 1))
    (BLD / 'manifest.building.json').write_text(json.dumps(man, indent=1) + '\n')
    json.dump(stats, open(os.environ.get('ELEC_STATS', '/workspace/elec-art-scratch/elec_stats.json'), 'w'), indent=1)
    for k, v in stats.items(): print(k, v)
    if prev:
        import pickle; pickle.dump({k: (v['col'][0], v['em'][0]) for k, v in R.items()}, open(prev, 'wb'))

if __name__ == '__main__':
    main()
