"""Preview-only compositor: a default-look v1 rider (body + wear layers via the customization rerender path)
on a mount + saddle + fore stack, using the anchor math the engine uses. Not part of the shipped pack."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(HERE, "../../../../.."))
CZ = os.path.join(REPO, "assets/customization/tools")
sys.path.insert(0, CZ); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
import rerender, rig

LOOK = {"male": [("body_male", (255, 210, 173), None), ("cz_bottom_jeans_male", (90, 111, 176), (60, 70, 120)), ("cz_shoes_sneakers_male", (232, 93, 79), (250, 250, 250)),
                 ("cz_top_tee_male", (247, 200, 68), (240, 240, 240)), ("cz_top_tee_male_sleeves", (247, 200, 68), (240, 240, 240)),
                 ("cz_face_smile_male", (255, 210, 173), None), ("cz_eyes_round_male", (80, 60, 50), None), ("cz_hair_bob_male", (138, 82, 50), (100, 60, 40))]}

def tint(a, m, c1, c2):
    a = a.astype(np.float32); m = m.astype(np.float32) / 255
    for ch, c in ((0, c1), (1, c2)):
        if c is None: continue
        w = m[..., ch:ch + 1]; a[..., :3] = a[..., :3] * (1 - w) + a[..., :3] * (np.array(c, np.float32) / 255) * w
    return np.clip(a, 0, 255).astype(np.uint8)

def rider(d, anim, fi, scale=2, look="male"):
    out = None
    for key, c1, c2 in LOOK[look]:
        if key not in rerender.JOBS: continue
        fr = rerender.render_one(key, anim, fi, d); a, m = (fr[2], fr[3]) if scale == 2 else (fr[0], fr[1])
        im = Image.fromarray(tint(a, m, c1, c2))
        out = im if out is None else Image.alpha_composite(out, im)
    return out

def seat(d, anim, fi, bt="male"):
    return rig.pose(bt, d, anim, fi, rig.RIDE_ANIMS[anim])["seat"]
