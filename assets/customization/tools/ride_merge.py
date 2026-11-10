#!/usr/bin/env python3
"""Append ONLY freshly painted v1 mount-riding dirFrames (ride_idle / ride_walk / ride_gallop), preserving all existing art.

Usage: python3 assets/customization/tools/ride_merge.py REPO [--jobs 6]
Clone of block_merge.py (same extra-page convention, slot-local trimmed grids <=2048 at both scales; physical cells
sprite-major, then anim-major, facing-major). Every live v1 body / wear / hat-hair sprite gets the three loops.
Body frames carry frameMeta anchors handR / handL (held items) and `seat` (the rider's seat socket, 1x px from the
feet pivot) that the engine pins onto the mount seat anchor (packages/assets/pack/nature/mount_anchors.json).
Workers crop each sprite to its painted union before returning (bounded memory). Only new pages are KTX2-encoded;
cz_manifest.save recomputes shard hashes.
"""
import argparse
from collections import Counter, defaultdict
import json
from multiprocessing import Pool
from pathlib import Path
import subprocess
import shutil
import numpy as np
from PIL import Image
import rerender
from rig import FW, FH, FEET, RIDE_ANIMS, RIDE_FPS, pose

NB = 8 * sum(RIDE_ANIMS.values())
MAXP = 1020

def live_keys(m):
    keys = set()
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == 'sprite' and isinstance(v, str): keys.add(v)
                else: walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(m['bodyTypes']); walk(m['wearables'])
    return keys

def bbox(out):
    al = np.zeros((FH, FW), bool)
    for fr in out: al |= fr[0][..., 3] > 0
    ys, xs = np.nonzero(al)
    # Include the feet pivot plus a 2px transparent guard around the painted union.
    x0 = max(0, min(int(xs.min()) if len(xs) else 24, 23) - 2)
    y0 = max(0, min(int(ys.min()) if len(ys) else 74, 73) - 2)
    x1 = min(FW, max(int(xs.max()) + 1 if len(xs) else 25, 25) + 2)
    y1 = min(FH, max(int(ys.max()) + 1 if len(ys) else 75, 75) + 2)
    return x0, y0, x1-x0, y1-y0

def render_cropped(args):
    k, out = rerender.render_sprite(args)
    bb = bbox(out); x0, y0, bw, bh = bb
    crops = [tuple(np.ascontiguousarray(fr[ai][y0 * sc:(y0 + bh) * sc, x0 * sc:(x0 + bw) * sc]) for ai, sc in enumerate((1, 1, 2, 2))) for fr in out]
    return k, bb, crops

def fits(g, bb):
    cw = max(bb[k][2] for k in g); ch = max(bb[k][3] for k in g)
    return ((len(g)*NB + MAXP//cw-1)//(MAXP//cw))*ch <= MAXP

def main(root, workers, replace_slots=()):
    if not shutil.which("toktx"):
        raise RuntimeError("KTX-Software toktx must be on PATH before rendering (see assets/tools/ktx2.py)")
    root = Path(root).resolve(); dest = root/'packages/assets/pack/customization'
    mp = dest/'manifest.customization.json'; m = rerender.czm.load(str(mp))
    sprites = {s['key']:s for s in m['sprites']}; keys = live_keys(m)
    if replace_slots:
        keys = {k for k in keys if rerender.JOBS[k][2] in replace_slots}
        prefixes = tuple(f"cz_ride_{slot}_" for slot in replace_slots)
        m["atlases"] = [a for a in m["atlases"] if not a["key"].startswith(prefixes)]
        for k in keys:
            for name in RIDE_ANIMS: sprites[k]["animations"].pop(name, None)
    assert keys and keys <= rerender.JOBS.keys(), sorted(keys-rerender.JOBS.keys())
    assert all(not (set(RIDE_ANIMS) & sprites[k]['animations'].keys()) for k in keys), 'already merged'
    groups = defaultdict(list)
    for k in sorted(keys): groups[rerender.JOBS[k][2]].append(k)
    new_atlases = []
    plan = [(name, n*8, 8) for name,n in RIDE_ANIMS.items()]
    with Pool(workers, maxtasksperchild=8) as pool:
        for slot, group in sorted(groups.items()):
            rendered = {}; bb = {}
            for k, b, crops in pool.imap_unordered(render_cropped, [(k,plan) for k in group]):
                rendered[k] = crops; bb[k] = b
                print('rendered',k,flush=True)
            pages = []; cur = []
            for k in sorted(group, key=lambda k:(bb[k][3],bb[k][2],k)):
                if cur and not fits(cur+[k],bb): pages.append(cur); cur=[]
                cur.append(k)
            if cur: pages.append(cur)
            for pi,g in enumerate(pages):
                cw = max(bb[k][2] for k in g); ch = max(bb[k][3] for k in g)
                cols = MAXP//cw; rows = (len(g)*NB+cols-1)//cols
                w = (cols*cw+7)//8*8; h = (rows*ch+7)//8*8
                assert max(w,h)*2 <= 2048
                pk = f'cz_ride_{slot}_{pi}'
                arrays = [np.zeros((h*s,w*s,c),np.uint8) for s,c in ((1,4),(1,3),(2,4),(2,3))]
                for si,k in enumerate(g):
                    x0,y0,bw,bh = bb[k]; anchor = {'x':round((FW/2-x0)/cw,6),'y':round((FEET-y0)/ch,6)}
                    srcbase = 0; physicalbase = si*NB
                    for name,n in RIDE_ANIMS.items():
                        df = [None]*(n*8); fm = {}
                        for d in range(8):
                            for fi in range(n):
                                cell = physicalbase+d*n+fi; x,y = cell%cols*cw,cell//cols*ch
                                fr = rendered[k][srcbase+fi*8+d]
                                for ai,scale in enumerate((1,1,2,2)):
                                    a = fr[ai]
                                    arrays[ai][y*scale:(y+bh)*scale,x*scale:(x+bw)*scale] = a[...,:arrays[ai].shape[2]]
                                idx = fi*8+d
                                df[idx] = {'atlas':pk,'frame':cell,'anchor':anchor}
                                if slot == 'body':
                                    K = pose(rerender.JOBS[k][1],d,name,fi,n)
                                    fm[f'df:{idx}'] = {'anchors':{}}
                                    for field,hand in (('anchor','handR'),('anchorL','handL')):
                                        a=K[field]
                                        fm[f'df:{idx}']['anchors'][hand] = {**a,'x':round(a['x']-FW/2,2),'y':round(a['y']-FEET,2)}
                                    fm[f'df:{idx}']['anchors']['seat'] = dict(K['seat'])
                        anim = {'frames':list(range(n)),'fps':RIDE_FPS[name],'directions':8,'dirStride':n,'loop':True,'dirFrames':df}
                        if fm: anim['frameMeta']=fm
                        sprites[k]['animations'][name]=anim
                        srcbase += n*8; physicalbase += n*8
                paths = [f'atlases/{pk}{suffix}.png' for suffix in ('','.tintmask','@2x','.tintmask@2x')]
                for a,path,mode in zip(arrays,paths,('RGBA','RGB','RGBA','RGB')):
                    assert set(np.unique(a[...,-1] if mode=='RGBA' else a)) <= {0,255}
                    Image.fromarray(a,mode).save(dest/path,optimize=True)
                new_atlases.append({'key':pk,'image':paths[0],'frameW':cw,'frameH':ch,'columns':cols,'rows':rows,
                                    'pages':[{'scale':2,'image':paths[2]}],'masks':{'tintmask':paths[1]}})
                print('packed',pk,len(g),'sprites',w,h,flush=True)
            del rendered
    # The sanctioned encoder accepts manifests; pass ONLY the just-created atlases.
    encode = dest/'manifest.ride-encode.json'
    try:
        encode.write_text(json.dumps({'atlases':new_atlases}))
        subprocess.run(['python3',str(root/'assets/tools/ktx2.py'),str(encode)],cwd=root,check=True)
        m['atlases'].extend(json.loads(encode.read_text())['atlases'])
    finally:
        encode.unlink(missing_ok=True)
    rerender.czm.save(str(mp),m)
    print('complete',len(keys),'sprites',dict(Counter(rerender.JOBS[k][2] for k in keys)),len(new_atlases),'new pages',flush=True)

if __name__ == '__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root');ap.add_argument('--jobs',type=int,default=6)
    ap.add_argument('--replace-slots',default='',help='scoped repaint of existing ride pages, comma-separated slots')
    args=ap.parse_args();main(args.root,args.jobs,tuple(filter(None,args.replace_slots.split(','))))
