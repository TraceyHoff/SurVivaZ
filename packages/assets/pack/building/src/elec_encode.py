"""oxipng + KTX2 for the electricity-tier pages only (keeps every other page's bytes untouched).
Run from repo root: python3 packages/assets/pack/building/src/elec_encode.py <atlas prefix>... (e.g. elec_ building_t5 items_build_elec)
Writes a temporary manifest next to manifest.building.json / manifest.items.json holding only the matching atlases, runs
assets/tools/ktx2.py on it (same encoder settings as every pack page), and copies the ktx2 fields back."""
import json, os, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[5]
MAN = {'building': ROOT / 'packages/assets/pack/building/manifest.building.json', 'items': ROOT / 'packages/assets/pack/items/manifest.items.json'}
prefixes = sys.argv[1:]
for name, mp in MAN.items():
    m = json.loads(mp.read_text()); mine = [a for a in m['atlases'] if any(a['key'].startswith(p) for p in prefixes)]
    if not mine: continue
    base = mp.parent; pngs = []
    for a in mine:
        pngs.append(a['image']); pngs += [p['image'] for p in a.get('pages', [])]
        for v in (a.get('masks') or {}).values():
            pngs.append(v); v2 = v.replace('.png', '@2x.png')
            if (base / v2).exists(): pngs.append(v2)
    subprocess.run(['oxipng', '-q', '-o', '4', '--strip', 'safe', *[str(base / p) for p in pngs]], check=True)
    tmp = base / f'manifest.elec_tmp.json'
    tmp.write_text(json.dumps({'atlases': [dict(a) for a in mine], 'sprites': []}, indent=1) + '\n')
    try:
        subprocess.run([sys.executable, str(ROOT / 'assets/tools/ktx2.py'), str(tmp), '--force'], check=True)
        enc = {a['key']: a for a in json.loads(tmp.read_text())['atlases']}
    finally:
        tmp.unlink()
    for a in m['atlases']:
        k = a['key']
        if k in enc: a.clear(); a.update(enc[k])
    mp.write_text(json.dumps(m, indent=1) + '\n')
    print(name, [a['key'] for a in mine])
