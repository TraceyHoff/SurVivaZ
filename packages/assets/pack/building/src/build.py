# Builds the building sub-manifest: 26 base-building pieces x tiers 1-4 (wood/stone/metal/reinforced), 4 damage stages,
# rotation rows 1 (symmetric) / 2 (axis) / 4 (unique), shared crack overlay, smoke attach on chimneys.
# One 1x page per tier (cells trimmed to 84x96, pivot (42,72) = main-pack (64,96)); 2x would exceed 2048 so 1x only,
# like the main pack's buildings_* pages. Usage: cd src && python3 build.py .. <preview dir>
# ADR-504: DO NOT re-run for the building_t* pages — they are 84x120 (pivot (42,99)) since the 80 px floor; the walls,
# openings, corners, pillars and stairs come from add_building_80px.py (scale80.py), which this crop does not match.
import json, os, sys, zlib, random
from concurrent.futures import ProcessPoolExecutor
from PIL import Image, ImageDraw
import pieces as PC
import buildings2 as b2
from buildings import render_boxes, finalize
from toon import SS
import backs
OUT = sys.argv[1] if len(sys.argv) > 1 else '..'
CW, CH, OX, OY = 84, 96, 22, 24          # crop of the 128x128 render cell, pivot (64,96) -> (42,72)
COLS = 24

def render(args):
    tier, key, rot = args; kind, fn, layer, rows, tall, _ = PC.PIECES[key]; tn = PC.TIER_NAMES[tier]
    seed = zlib.crc32(f'{key}{tier}'.encode()) % 1000
    up = key in PC.OLD_ROWS and rot >= PC.OLD_ROWS[key]   # ADR-253 back rotations
    if kind == 'roof':
        cv = b2.roof_piece(tn, fn, rot, seed=seed)
        if up and fn == 'flat': backs.draw_on(cv, backs.roof_flat(rot), rot, seed)
    else:
        bx, dec = fn(tn)
        if up: bx = bx + backs.details(bx, rot, seed)
        cv = render_boxes(bx, rot, seed=seed, decor=dec)
    sr = (-0.55, 0.55, -0.55, 0.55) if layer >= 1 else None
    out = []
    for st in range(4):
        im = finalize(cv, st, seed + rot, sr); bb = im.getbbox()
        clip = bb and (bb[0] < OX or bb[1] < OY or bb[2] > OX + CW or bb[3] > OY + CH)
        out.append((im.crop((OX, OY, OX + CW, OY + CH)), bool(clip)))
    return (tier, key, rot), out

def crack(stage):
    S = 4; im = Image.new('RGBA', (CW * S, CH * S), (0, 0, 0, 0)); d = ImageDraw.Draw(im); rnd = random.Random(7 + stage)
    for _ in range(stage * 3):   # hairline cracks over the wall band (z 6..44 around the pivot), faint so they read on any face
        x, y = rnd.uniform(18, 62), rnd.uniform(34, 66); pts = [(x * S, y * S)]
        for _ in range(3 + stage): x += rnd.uniform(-4, 4); y += rnd.uniform(-1, 5); pts.append((x * S, y * S))
        d.line(pts, fill=(42, 27, 46, 190), width=S); d.line([(p[0] + S, p[1] + S) for p in pts], fill=(255, 240, 220, 70), width=S // 2)
    return im.resize((CW, CH), Image.LANCZOS)

def jobs():
    for t in (1, 2, 3, 4):
        for k, v in PC.PIECES.items():
            for r in range(v[3]): yield (t, k, r)

if __name__ == '__main__':
    os.makedirs(OUT + '/atlases', exist_ok=True)
    with ProcessPoolExecutor(os.cpu_count()) as ex: R = dict(ex.map(render, list(jobs()), chunksize=2))
    clipped = [k for k, v in R.items() if any(c for _, c in v)]
    print('clipped:', clipped)
    man = {"version": 1, "name": "building", "atlases": [], "sprites": []}
    anchor = {"x": (64 - OX) / CW, "y": (96 - OY) / CH}
    for t in (1, 2, 3, 4):
        frames = []; idx = {}
        for k, v in PC.PIECES.items():
            for r in range(PC.OLD_ROWS.get(k, v[3])):
                idx[(k, r)] = len(frames); frames += [im for im, _ in R[(t, k, r)]]
        for k, v in PC.PIECES.items():   # ADR-253: rows added later go at the end of the page
            for r in range(PC.OLD_ROWS.get(k, v[3]), v[3]):
                idx[(k, r)] = len(frames); frames += [im for im, _ in R[(t, k, r)]]
        rows = (len(frames) + COLS - 1) // COLS; page = Image.new('RGBA', (CW * COLS, CH * rows), (0, 0, 0, 0))
        for i, f in enumerate(frames): page.paste(f, ((i % COLS) * CW, (i // COLS) * CH))
        assert max(page.size) <= 2048
        akey = f'building_t{t}'; page.save(f'{OUT}/atlases/{akey}.png', optimize=True)
        man["atlases"].append({"key": akey, "image": f"atlases/{akey}.png", "frameW": CW, "frameH": CH, "columns": COLS, "rows": rows})
        def sprite(skey, piece, k):
            kind, fn, layer, nrows, tall, _ = PC.PIECES[k]
            rr = [[idx[(k, r)] + s for s in range(4)] for r in range(nrows)]
            fr = rr if nrows == 1 else (rr + rr if nrows == 2 else rr)
            sp = {"key": skey, "category": "building", "atlas": akey, "anchor": anchor, "animations": {"idle": {"frames": [fr[0][0]], "fps": 1}},
                  "building": {"piece": piece, "footprint": {"w": 1, "h": 1}, "layer": layer, "frames": fr, "crackOverlay": "bld_crack"},
                  "rotationArt": "mirror" if nrows == 1 else "unique4"}
            if k == "roof_chimney": sp["attach"] = {"smoke": {"x": 0.0, "y": -float(PC.CHIMNEY_SMOKE_Z)}}
            man["sprites"].append(sp)
        for k, v in PC.PIECES.items():
            sprite(f"bld_{k}_t{t}", f"{k}@tier{t}", k)
            if t == 1 and not v[5]: sprite(f"bld_{k}", k, k)       # new piece: bare key -> tier1 art
        for a, k in PC.ALIAS.items(): sprite(f"bld_{a}_t{t}", f"{a}@tier{t}", k)
        print(akey, page.size, len(frames), 'frames')
    # Crack overlay on its own tiny always-resident page: building_t<N> pages are streamed per tier nearby (renderer
    # isStreamedBuildingAtlas = /^building_t\d+$/), so the overlay must not live on one of them.
    cp = Image.new('RGBA', (CW * 3, CH), (0, 0, 0, 0))
    for i, s in enumerate((1, 2, 3)): cp.paste(crack(s), (i * CW, 0))
    cp.save(f'{OUT}/atlases/building_fx.png', optimize=True)
    man["atlases"].append({"key": "building_fx", "image": "atlases/building_fx.png", "frameW": CW, "frameH": CH, "columns": 3, "rows": 1})
    man["sprites"].insert(0, {"key": "bld_crack", "category": "vfx", "atlas": "building_fx", "anchor": anchor,
                              "animations": {f"stage{s}": {"frames": [s - 1], "fps": 1} for s in (1, 2, 3)}})
    # ADR-112/113 decor: own pages (1x + @2x + tintmask), one per group x cell class; see decor/lib.py
    import decor
    st, dclip = decor.emit(man, OUT, decor.GROUPS, prev=os.environ.get('DECOR_PREVIEW'))
    for a in st: print(*a)
    print('decor clipped:', dclip)
    import fragment_pieces; print('fragment pieces:', *fragment_pieces.apply(man, OUT))   # clan/stall piece art from the unserved fragments
    import hearths
    for a in hearths.apply(man, OUT): print(*a)   # animated fire pieces (campfire, torch_stand, fireplace, wood_stove, lantern)
    import basic_storage_box; basic_storage_box.apply(man, OUT)   # ADR-250 scavenged starter crate (own stream page)
    import clan_palettes; clan_palettes.apply(man)   # clanPalettes for the client (pvp_clan is not served); see clan_palettes.py
    p = f'{OUT}/manifest.building.json'; json.dump(man, open(p, 'w'), indent=1); open(p, 'a').write('\n')
    import pickle; pickle.dump({k: [im for im, _ in v] for k, v in R.items()}, open('/tmp/bld_frames.pkl', 'wb'))
