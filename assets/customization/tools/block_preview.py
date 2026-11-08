#!/usr/bin/env python3
"""Live-pack v1 block contact sheet and pixel/tintmask verification (no art rebuild).
Usage: python3 assets/customization/tools/block_preview.py REPO OUTPUT.png [--verify]
"""
import argparse
from collections import Counter
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from block_merge import live_keys
import rerender

class Pack:
    def __init__(self, root):
        self.path=Path(root)/'packages/assets/pack/customization'
        self.m=rerender.czm.load(str(self.path/'manifest.customization.json'))
        self.S={s['key']:s for s in self.m['sprites']};self.A={a['key']:a for a in self.m['atlases']}
        self.W={w['key']:w for w in self.m['wearables']}

    @lru_cache(maxsize=24)
    def img(self,path): return Image.open(self.path/path).convert('RGBA')

    def frame(self,key,d,anim='idle',fi=0,scale=2,colors=None):
        s=self.S[key];an=s['animations'][anim];df=an.get('dirFrames')
        if df:
            e=df[fi*an.get('directions',1)+d];a=self.A[e['atlas']];r=e.get('rect');anchor=e.get('anchor',s['anchor'])
            f=e.get('frame',0)
        else:
            a=self.A[s['atlas']];f=an['frames'][fi]+d*an.get('dirStride',0);r=None;anchor=s['anchor']
        if not r:r=dict(x=f%a['columns']*a['frameW'],y=f//a['columns']*a['frameH'],w=a['frameW'],h=a['frameH'])
        x,y,w,h=[r[k] for k in ('x','y','w','h')]
        image=a['image'] if scale==1 else next(pg['image'] for pg in a['pages'] if pg['scale']==scale)
        im=self.img(image).crop((x*scale,y*scale,(x+w)*scale,(y+h)*scale))
        if colors and 'tintmask' in a.get('masks',{}):
            mask=np.array(self.img(a['masks']['tintmask']).crop((x,y,x+w,y+h)).resize((w*scale,h*scale),Image.Resampling.NEAREST))
            arr=np.array(im).astype(float)
            for ch,col in enumerate(colors):
                c=np.array(tuple(bytes.fromhex(col.lstrip('#'))))/255/.78;m=mask[:,:,ch:ch+1]/255
                arr[:,:,:3]=np.clip(arr[:,:,:3]*(1-m+m*c),0,255)
            im=Image.fromarray(arr.astype('uint8'))
        canvas=Image.new('RGBA',(48*scale,80*scale))
        canvas.alpha_composite(im,(round((24-anchor['x']*w)*scale),round((74-anchor['y']*h)*scale)))
        return canvas

    def doll(self,bt,keys,d,anim,fi=0):
        skin=('#dca482','#dca482') if bt=='male' else ('#a46c49','#a46c49')
        layers=[(0,'body_'+bt,skin)]
        for k in keys:
            w=self.W[k];slot=w['slot']
            colors={'hair':('#7a4a2c','#c49a6c'),'face':('#4a3228','#4a3228'),'eyes':('#3aa6a0','#4e6fa6'),
                    'top':('#86c0ea','#efe0bc'),'bottom':('#4e6fa6','#c49a6c'),'shoes':('#a8432e','#efe0bc'),
                    'hat':('#b98a1e','#3f7a46'),'accessory':('#efe0bc','#9cb88c'),'hands':('#c49a6c','#efe0bc')}[slot]
            for l in w.get('layers',[w]):
                layer=l.get('layerByDir',[l.get('layer',0)]*8)[d]
                if d in (0,1,2,3,7) and slot in ('face','eyes'):layer=41 if slot=='face' else 42
                b=l['bodies'][bt]
                if slot=='hair' and any(self.W[x]['slot']=='hat' and self.W[x].get('hatHair') for x in keys):b=b.get('hatHair',b)
                layers.append((layer,b['sprite'],colors))
        out=Image.new('RGBA',(96,160))
        for _,key,colors in sorted(layers):out.alpha_composite(self.frame(key,d,anim,fi,colors=colors))
        return out


def preview(p,out):
    outfits=[['hair_pixie','top_hoodie','bottom_jeans','shoes_sneakers','acc_bandana','face_smile','eyes_round'],
             ['hair_ponytail','hat_cap','top_flannel','bottom_shorts','shoes_hiking_boots','acc_cloth_gloves','face_freckles','eyes_lashes']]
    # Fail rather than silently omit a visible outfit layer.
    assert all(k in p.W for keys in outfits for k in keys),[k for keys in outfits for k in keys if k not in p.W]
    steps=[('idle',0,'idle'),('block',0,'raise 0'),('block',1,'peak 1'),('block',2,'hold 2'),('block_hit',0,'guard hit 0'),('block_hit',1,'recover 1')]
    im=Image.new('RGB',(1220,2660),'#d4dfd5');dr=ImageDraw.Draw(im)
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',12)
    dr.text((12,8),'SurVivaZ | LIVE V1 PACK | dedicated block raise / hold + guard-hit | E SE S SW W NW N NE',font=font,fill='#283c34')
    for bi,bt in enumerate(('male','female')):
        for oi,keys in enumerate(outfits):
            ox=oi*610;oy=35+bi*1310
            dr.text((ox+25,oy),bt+' | '+', '.join(keys[:4]),font=font,fill='#283c34')
            for ci,(_,_,label) in enumerate(steps):dr.text((ox+28+ci*96,oy+22),label,font=font,fill='#283c34')
            for d,dname in enumerate(('E','SE','S','SW','W','NW','N','NE')):
                y=oy+45+d*155;dr.text((ox+3,y+80),dname,font=font,fill='#283c34')
                for ci,(anim,fi,_) in enumerate(steps):
                    doll=p.doll(bt,keys,d,anim,fi);im.paste(doll,(ox+25+ci*96,y),doll)
    Path(out).parent.mkdir(parents=True,exist_ok=True);im.save(out)
    # Front / rear close-up without any interpolation of the live pixels.
    detail=Image.new('RGB',(1152,720),'#d4dfd5');dr=ImageDraw.Draw(detail)
    for row,bt in enumerate(('male','female')):
        for col,d in enumerate((1,2,5,6)):
            doll=p.doll(bt,outfits[row],d,'block',2).resize((288,480),Image.Resampling.NEAREST)
            detail.paste(doll,(col*288,row*350-85),doll)
            dr.text((col*288+12,row*350+315),f'{bt} hold dir {d}',font=font,fill='#283c34')
    detail.save(str(Path(out).with_name('character_v1_block_detail.png')))


def verify(p):
    keys=live_keys(p.m);matches=[];blank=0;count=0
    for key in sorted(keys):
        s=p.S[key]
        for name,n in (('block',3),('block_hit',2)):
            an=s['animations'][name]
            assert (len(an['frames']),an['fps'],an['loop'],an['directions'],len(an['dirFrames']))==(n,10,False,8,n*8)
        # Compare canonical pivot-aligned whole cells, not different trim rectangles.
        old=set()
        for anim,an in s['animations'].items():
            if anim in ('block','block_hit'):continue
            for d in range(an.get('directions',1)):
                for fi in range(len(an['frames'])):
                    old.add(sha256(p.frame(key,d,anim,fi,scale=1).tobytes()).digest())
        for anim,n in (('block',3),('block_hit',2)):
            for d in range(8):
                for fi in range(n):
                    im=p.frame(key,d,anim,fi,scale=1)
                    if not im.getbbox():blank+=1;continue # naturally hidden back-facing eyes, face, etc.
                    if sha256(im.tobytes()).digest() in old:matches.append((key,anim,d,fi))
                    count+=1
    pages=[a for a in p.A.values() if a['key'].startswith('cz_block_')]
    for a in pages:
        for path in (a['masks']['tintmask'],a['masks']['tintmask'].replace('.png','@2x.png')):
            assert set(np.unique(np.array(p.img(path))[...,:3]))<={0,255},path
        for path in (a['image'],a['pages'][0]['image']):
            assert set(np.unique(np.array(p.img(path))[...,3]))<={0,255},path
    print('sprites',len(keys),'by slot',dict(Counter(rerender.JOBS[k][2] for k in keys)))
    print('new nonempty cells',count,'naturally invisible cells',blank,'old-action nonempty matches',len(matches))
    if matches:print('MATCHES',matches)
    assert not matches,'new visible cells must not duplicate an old action'
    for key in ('body_male','body_female'):
        print(key,json_record(p.S[key]['animations']['block']))

def json_record(an):
    import json
    return json.dumps(an['dirFrames'])

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root');ap.add_argument('output');ap.add_argument('--verify',action='store_true')
    args=ap.parse_args();p=Pack(args.root);preview(p,args.output)
    if args.verify:verify(p)
