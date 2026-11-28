"""ADR-593 powered building tier (tier 5) art: targeted, add-only packer (brief docs/ART_KEYS_ELECTRICITY.md section 5).

Run from repo root:  python3 packages/assets/pack/building/src/add_tier5.py
Owns only atlases `building_t5` (walls + pillar) and `building_t5_floor` (foundations + floors) with their `_emissive`
masks, and the sprites `bld_<piece>_t5` (`<piece>@tier5`). Never runs build.py / build_all, never touches t1..t4.
Layout = building_t4 rules: 84x120 frames, anchor (0.5, 0.825), painted rows as t4 (2 for straight walls / stairwell,
4 for the rest; `frames[rot]` = [r0, r1, r0, r1] for 2-row pieces), 4 baked damage stages, `crackOverlay: bld_crack`.
Per painted row, 11 cells: powered damage 0..3 (`building.frames`), unlit damage 0..3 (`building.states.unlit`), 3 extra
intact animation frames; `animations.idle` = [powered d0, a1, a2, a3] @ 4 fps per row (`rotations`), `animations.unlit`
= unlit d0. 1x pages only (like building_t4), indexed PNG + tRNS, then oxipng + KTX2 via elec_encode.py building_t5."""
import json, os, sys, zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from PIL import Image
HERE = Path(__file__).resolve().parent; sys.path.insert(0, str(HERE))
ROOT = HERE.parents[4]; BLD = ROOT / 'packages/assets/pack/building'
from elec import lib, tier5 as T5          # noqa: E402
from add_electricity import save_page      # noqa: E402

PAGES = {'building_t5': ['wall', 'wall_low', 'wall_window', 'wall_doorway', 'wall_arched', 'wall_corner_inner', 'wall_corner_outer',
                         'wall_corner_angled', 'pillar'],
         'building_t5_floor': ['foundation', 'foundation_triangle', 'floor', 'floor_triangle', 'floor_hatch_frame', 'floor_stairwell']}
CELLS = [('on', 0, s) for s in range(4)] + [('unlit', 0, s) for s in range(4)] + [('on', ph, 0) for ph in (0.25, 0.5, 0.75)]
COLS = {'building_t5': 24, 'building_t5_floor': 22}   # building_t5 = a tier page: 24 x 17 (2016 x 2040) like building_t1..t4, so the
# ADR-503 building stream pool keeps one page geometry; the floor page is a plain stream page, packed tight
ROWS = {'building_t5': 17}
FPS = 4


def job(a):
    key, row, ci = a; st, ph, stage = CELLS[ci]; layer = T5.PIECES[key][0]
    seed = zlib.crc32(f'{key}5'.encode()) % 1000
    sr = (-0.55, 0.55, -0.55, 0.55) if layer >= 1 else None
    out = lib.render_frame(T5.geom(key, st, ph, stage), row, 'BT', (1, 1), seed + row, shadow=layer >= 1, shadow_rect=sr,
                           geom=lambda: T5.geom(key, st, ph, stage), stage=stage)
    return a, (out['col'][0], out['em'][0], out['top'], out['clip'])


def main():
    jobs = [(k, r, ci) for ks in PAGES.values() for k in ks for r in range(T5.PIECES[k][1]) for ci in range(len(CELLS))]
    with ProcessPoolExecutor(os.cpu_count()) as ex: R = dict(ex.map(job, jobs, chunksize=2))
    clipped = sorted({a[0] for a, v in R.items() if v[3]}); assert not clipped, clipped
    man = json.loads((BLD / 'manifest.building.json').read_text())
    keys = {f'bld_{k}_t5' for ks in PAGES.values() for k in ks}
    man['atlases'] = [a for a in man['atlases'] if a['key'] not in PAGES]
    man['sprites'] = [s for s in man['sprites'] if s['key'] not in keys]
    stats = {}
    for akey, ks in PAGES.items():
        cells = [(k, r, ci) for k in ks for r in range(T5.PIECES[k][1]) for ci in range(len(CELLS))]
        cols = COLS[akey]; nrows = ROWS.get(akey, (len(cells) + cols - 1) // cols); assert len(cells) <= cols * nrows and nrows * 120 <= 2048 and cols * 84 <= 2048
        col = Image.new('RGBA', (cols * 84, nrows * 120), (0, 0, 0, 0)); em = col.copy(); idx = {}
        for i, c in enumerate(cells):
            x, y = (i % cols) * 84, (i // cols) * 120; col.paste(R[c][0], (x, y)); em.paste(R[c][1], (x, y)); idx[c] = i
        save_page(col, BLD / f'atlases/{akey}.png'); save_page(em, BLD / f'atlases/{akey}_emissive.png')
        man['atlases'].append({'key': akey, 'image': f'atlases/{akey}.png', 'frameW': 84, 'frameH': 120, 'columns': cols, 'rows': nrows,
                               'masks': {'emissive': f'atlases/{akey}_emissive.png'}, 'residency': 'stream'})
        for k in ks:
            layer, rows = T5.PIECES[k]
            lit = [[idx[(k, r, s)] for s in range(4)] for r in range(rows)]
            cold = [[idx[(k, r, 4 + s)] for s in range(4)] for r in range(rows)]
            anim = [[idx[(k, r, 0)]] + [idx[(k, r, 8 + j)] for j in range(3)] for r in range(rows)]
            rr = lambda tbl: [tbl[r % rows] for r in range(4)]
            man['sprites'].append({
                'key': f'bld_{k}_t5', 'category': 'building', 'atlas': akey, 'anchor': {'x': 0.5, 'y': 0.825},
                'animations': {'idle': {'frames': anim[0], 'fps': FPS, 'loop': True, 'rotations': rr(anim)},
                               'unlit': {'frames': [cold[0][0]], 'fps': 1, 'rotations': [[c[0]] for c in rr(cold)]}},
                'building': {'piece': f'{k}@tier5', 'footprint': {'w': 1, 'h': 1}, 'layer': layer, 'frames': rr(lit),
                             'states': {'unlit': rr(cold)}, 'crackOverlay': 'bld_crack'},
                'rotationArt': 'unique4'})
            stats[f'bld_{k}_t5'] = dict(atlas=akey, rows=rows, top=max(R[(k, r, ci)][2] for r in range(rows) for ci in range(len(CELLS))),
                                        top_rot0=R[(k, 0, 0)][2], cells=rows * len(CELLS))
        print(akey, col.size, len(cells), 'cells')
    (BLD / 'manifest.building.json').write_text(json.dumps(man, indent=1) + '\n')
    json.dump(stats, open('/workspace/elec-art-scratch/t5_stats.json', 'w'), indent=1)
    for k, v in stats.items(): print(k, v)


if __name__ == '__main__':
    main()
