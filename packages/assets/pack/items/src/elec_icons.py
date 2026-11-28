# ADR-590 / ADR-593 electricity tier icons (brief docs/ART_KEYS_ELECTRICITY.md section 6). Add-only: writes only
#   items_build_elec (stream, CSS-only like items_build): build_<key> for the 26 electric pieces (+ kit_<key> item sprites on
#                    the same cell: a kit's inventory icon is its piece's build icon) + build_<piece>_t5 for
#                    the 15 powered-tier pieces (ADR-229 naming). Source = the piece's own in-game art (active frame, rot 0,
#                    @2x), ADR-224 cel pass: figure crop (contact shadow + soft glow dropped), fit inside the 2 px inset,
#                    snap to the piece's own flat palette, binary alpha, bold outline ring (1 px / 2 px @2x).
#   items_elec       (resident): circuit_board / electric_motor / solar_cell / led_bulb (items), skill_electrician /
#                    skill_power_grid / skill_powered_tier / skill_hydroponics (ADR-113 medallions, branch colours) and the
#                    interact-prompt glyphs icon_power_on / icon_power_off / icon_battery, painted with draw.C in cel mode.
# Run from repo root: python3 packages/assets/pack/items/src/elec_icons.py [preview.png]
#   then python3 packages/assets/pack/building/src/elec_encode.py items_build_elec items_elec, gen_icon_css.py, lock:ids:pack.
import json, math, os, sys
os.environ['CEL'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ROOT = os.path.normpath(os.path.join(HERE, '../../../../..'))
BSRC = os.path.join(ROOT, 'packages/assets/pack/building/src'); sys.path.insert(0, BSRC)
import numpy as np
from PIL import Image
from draw import C, lt, dk
import skills as SK
from add_electricity import save_page

ITEMS = os.path.join(ROOT, 'packages/assets/pack/items'); BLD = os.path.join(ROOT, 'packages/assets/pack/building')
ELEC = ['generator_fuel', 'generator_solar', 'battery_small', 'battery_medium', 'battery_large', 'power_pylon', 'solar_panel', 'wind_turbine',
        'wind_turbine_large', 'water_wheel', 'water_wheel_overshot', 'water_turbine', 'electrician_workstation', 'electric_stove', 'electric_furnace',
        'power_workbench', 'power_hammer', 'fridge', 'chest_freezer', 'electric_floor_lamp', 'electric_table_lamp', 'electric_wall_light',
        'ceiling_light', 'flood_light', 'electric_heater', 'hydroponic_table']
KITS = [i['key'][4:] for i in json.load(open(os.path.join(ROOT, 'packages/gameplay/data/items.json')))['items'] if i['key'].startswith('kit_')]
T5 = ['foundation', 'foundation_triangle', 'floor', 'floor_triangle', 'floor_hatch_frame', 'floor_stairwell', 'wall', 'wall_low', 'wall_window',
      'wall_doorway', 'wall_arched', 'wall_corner_inner', 'wall_corner_outer', 'wall_corner_angled', 'pillar']


# ---------------------------------------------------------------- ADR-224 cel pass (same maths as adr224.py)
def figure(im):
    a = np.array(im).astype(np.float32); al = a[..., 3]
    sh = (al < 200) & (a[..., :3].max(-1) < 70); fig = (al >= 128) & ~sh
    a[..., 3] = np.where(fig, 255, 0); a[~fig] = 0
    o = Image.fromarray(a.astype(np.uint8)); return o.crop(o.getbbox())
def palette(im, k=16):
    a = np.array(im); px = a[a[..., 3] > 0][:, :3]
    q = Image.fromarray(px[None]).quantize(min(k, max(2, len(np.unique(px, axis=0)))), method=Image.Quantize.MEDIANCUT)
    return np.array(q.getpalette()[:3 * len(q.getcolors())], np.float32).reshape(-1, 3)
def snapto(rgb, P):
    out = np.empty_like(rgb)
    for y0 in range(0, rgb.shape[0], 32):
        r = rgb[y0:y0 + 32]; out[y0:y0 + 32] = P[((r[..., None, :] - P[None, None]) ** 2).sum(-1).argmin(-1)]
    return out
def ring(rgb, m, r):
    rgb, m = rgb.copy(), m.copy(); H, W = m.shape
    for _ in range(r):
        acc = np.zeros((H, W, 3), np.float32); n = np.zeros((H, W), np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not dx and not dy: continue
                sm = np.zeros_like(m); sc = np.zeros_like(rgb)
                ys, yd = (slice(max(0, dy), H + min(0, dy)), slice(max(0, -dy), H + min(0, -dy)))
                xs, xd = (slice(max(0, dx), W + min(0, dx)), slice(max(0, -dx), W + min(0, -dx)))
                sm[yd, xd] = m[ys, xs]; sc[yd, xd] = rgb[ys, xs]; acc += sc * sm[..., None]; n += sm
        new = (n > 0) & ~m; rgb[new] = acc[new] / n[new][:, None]; rgb[new] = rgb[new] + (np.array((40, 22, 40)) - rgb[new]) * 0.62
        m = m | new
    return rgb, m
def icon(fig, P, cell, pad, ow):
    box = cell - 2 * pad; w, h = fig.size; s = min(box / w, box / h); src = fig
    if s > 1: k = math.ceil(s); src = fig.resize((w * k, h * k), Image.NEAREST); w, h = src.size; s = min(box / w, box / h)
    tw, th = max(1, round(w * s)), max(1, round(h * s))
    a = np.array(src).astype(np.float32); pm = a.copy(); pm[..., :3] *= a[..., 3:] / 255
    sm = np.array(Image.fromarray(pm.astype(np.uint8), 'RGBA').resize((tw, th), Image.BOX)).astype(np.float32)
    al = sm[..., 3]; m = al >= 110; rgb = np.where(m[..., None], sm[..., :3] * 255 / np.maximum(al, 1)[..., None], 0)
    rgb = snapto(rgb, P)
    R = np.zeros((cell, cell, 3), np.float32); M = np.zeros((cell, cell), bool)
    x0, y0 = (cell - tw) // 2, (cell - th) // 2; R[y0:y0 + th, x0:x0 + tw] = rgb; M[y0:y0 + th, x0:x0 + tw] = m
    R2, M2 = ring(R, M, ow); ringm = M2 & ~M
    D = np.array([(np.array(c) + (np.array((40, 22, 40)) - np.array(c)) * 0.62) for c in P], np.float32)
    R2[ringm] = snapto(R2[ringm][None], D)[0]
    o = np.zeros((cell, cell, 4), np.uint8); o[M2, :3] = R2[M2].round().clip(0, 255); o[M2, 3] = 255
    return Image.fromarray(o, 'RGBA')


def elec_frame(key):
    """active frame 0, painted row 0, from the piece's @2x page (manifest.building.json)."""
    m = json.load(open(os.path.join(BLD, 'manifest.building.json'))); A = {a['key']: a for a in m['atlases']}
    s = next(x for x in m['sprites'] if x['key'] == key); a = A[s['atlas']]; fi = s['animations']['idle']['frames'][0]
    pg = next(p for p in a['pages'] if p['scale'] == 2); im = Image.open(os.path.join(BLD, pg['image'])).convert('RGBA')
    fw, fh = a['frameW'] * 2, a['frameH'] * 2; x, y = fi % a['columns'] * fw, fi // a['columns'] * fh
    return im.crop((x, y, x + fw, y + fh))


def t5_frame(piece):
    import zlib
    from elec import lib, tier5
    seed = zlib.crc32(f'{piece}5'.encode()) % 1000; layer = tier5.PIECES[piece][0]
    out = lib.render_frame(tier5.geom(piece, 'on', 0.0, 0), 0, 'BT', (1, 1), seed, shadow=False, geom=lambda: tier5.geom(piece, 'on', 0.0, 0))
    return out['col'][1]


def from_art(im):
    f = figure(im); P = palette(f); return icon(f, P, 64, 3, 2), icon(f, P, 32, 2, 1)


# ---------------------------------------------------------------- painted icons (32-unit draw.C space, cel mode)
STEEL, GUN, GRAPH, COPPER, GOLDC, PCB, LED, LEDH, GREEN, RED, BLUE = '#bcc6ce', '#6b7486', '#3e4454', '#d0782c', '#e8b848', '#3a9a5a', '#fff2b8', '#ffdc80', '#4cc25e', '#e0483c', '#3f6fd0'
def bolt(c, s=1.0, ox=0, oy=0, col='#f6cb45', **k):
    pts = [(18, 2.5), (7.5, 18), (14.5, 18), (12, 29.5), (24.5, 12.5), (17.2, 12.5), (21, 2.5)]
    c.poly([(16 + (x - 16) * s + ox, 16 + (y - 16) * s + oy) for x, y in pts], col, shade=.18, **k)
def box(c, cx, yb, ax, ay, h, col, sh=.1, **k):
    F, Rt, Lt = (cx, yb), (cx + ax, yb - ax / 2), (cx - ay, yb - ay / 2); Bk = (cx + ax - ay, yb - ax / 2 - ay / 2); up = lambda p: (p[0], p[1] - h)
    c.poly([F, Lt, up(Lt), up(F)], col, shade=sh, **k); c.poly([F, Rt, up(Rt), up(F)], dk(col, .22), shade=sh, **k)
    c.poly([up(F), up(Rt), up(Bk), up(Lt)], lt(col, .22), shade=sh, **k)

def P_circuit_board(c):
    c.poly([(3, 18.5), (17, 11), (29, 17), (15, 24.5)], PCB, shade=.12)
    c.poly([(3, 18.5), (15, 24.5), (15, 26.3), (3, 20.3)], dk(PCB, .35), ol=False); c.poly([(15, 24.5), (29, 17), (29, 18.8), (15, 26.3)], dk(PCB, .5), ol=False)
    for a, b in (((6, 18.6), (12, 15.6)), ((12, 15.6), (19, 19.1)), ((9, 20.5), (15, 17.6)), ((18, 14.3), (25, 17.6)), ((15, 21.8), (22, 18.3))):
        c.line([a, b], .55, GOLDC)
    for x, y in ((6, 18.6), (19, 19.1), (9, 20.5), (25, 17.6), (15, 21.8)): c.dot(x, y, .75, GOLDC)
    box(c, 16.5, 19.2, 3.6, 3.6, 2.2, '#2c2f38'); c.line([(14.2, 16.2), (16.8, 17.5)], .4, '#9aa4b4')
    c.ell(9.5, 15.6, 1.5, 1, '#3f6fd0'); c.rect(8, 12.6, 11, 15.6, '#3f6fd0', r=.6, owf=.6); c.ell(9.5, 12.6, 1.5, .9, lt('#3f6fd0', .3), ol=False)
    c.rect(21, 12.2, 23.4, 15, '#e8b848', r=.5, owf=.6); c.dot(25.3, 19.6, .9, '#ff5a40'); c.shine(23.6, 17.6, .5, 160)
def P_electric_motor(c):
    c.rect(7, 23, 23, 26.5, '#5b6576', r=.6)
    c.rect(5.5, 10.5, 22.5, 24, '#4f7fb0', r=3.2)
    for y in (13, 15.5, 18, 20.5): c.line([(7.5, y), (20.5, y)], .55, dk('#4f7fb0', .35))
    c.rect(10, 15, 14.5, 19.5, COPPER, r=.8, owf=.6)
    for x in (11, 12.3, 13.6): c.line([(x, 15.4), (x, 19.1)], .4, dk(COPPER, .35))
    c.ell(22.5, 17.2, 3, 6.6, STEEL, shade=.2); c.ell(22.8, 17.2, 1.4, 1.6, GUN, ol=False)
    c.rect(24.5, 16.1, 29.5, 18.3, '#d8dde4', r=.5); c.line([(26.5, 16.4), (26.5, 18)], .35, GUN)
    c.rect(9.5, 6.5, 16.5, 10.8, '#3a3f4a', r=.8); c.dot(11.5, 8.6, .7, '#e8b848'); c.dot(14.3, 8.6, .7, '#e0483c')
    c.shine(8.5, 12.5, .8, 170)
def P_solar_cell(c):
    pts = [(4, 13), (17, 6.5), (28.5, 13.5), (15.5, 20)]
    c.poly([(4, 13), (15.5, 20), (15.5, 22), (4, 15)], '#9aa4b4', ol=False); c.poly([(15.5, 20), (28.5, 13.5), (28.5, 15.5), (15.5, 22)], '#6b7486', ol=False)
    c.poly(pts, '#2c509f', shade=.15)
    for t in (1 / 3, 2 / 3):
        a = (4 + 13 * t, 13 - 6.5 * t); b = (15.5 + 13 * t, 20 - 6.5 * t); c.line([a, b], .45, '#9cc4ff')
        a = (4 + 11.5 * t, 13 + 7 * t); b = (17 + 11.5 * t, 6.5 + 7 * t); c.line([a, b], .45, '#9cc4ff')
    for t in (.25, .75):
        a = (4 + 11.5 * t, 13 + 7 * t); b = (17 + 11.5 * t, 6.5 + 7 * t); c.line([a, b], .9, '#e8edf2')
    c.line([(9, 10.5), (13.5, 8.3)], .9, '#e8f2ff', 180); c.rect(14.5, 22.2, 16.5, 26.5, '#e8edf2', r=.4, owf=.6); c.rect(20.5, 19.4, 22.5, 23.5, '#e8edf2', r=.4, owf=.6)
def P_led_bulb(c):
    for a in range(8):
        ang = a * math.pi / 4 + .2; c.line([(16 + math.cos(ang) * 11.5, 11.5 + math.sin(ang) * 11.5), (16 + math.cos(ang) * 14, 11.5 + math.sin(ang) * 14)], .9, LEDH)
    c.ell(16, 11.5, 8.6, 8.6, LED, shade=.12)
    c.rect(11.5, 16, 20.5, 20.5, LED, r=1.5, ol=False)
    for x, y in ((13.2, 10.5), (16, 9), (18.8, 10.5), (16, 12.6)): c.rect(x - 1, y - .8, x + 1, y + .8, '#f8a024', r=.3, owf=.5)
    c.rect(11.6, 19.5, 20.4, 22, '#efe6d2', r=.6)
    c.rect(12.4, 22, 19.6, 27, '#bcc6ce', r=.8)
    for y in (23.4, 25): c.line([(12.6, y), (19.4, y + .8)], .6, '#5b6576')
    c.rect(14.3, 27, 17.7, 29.2, '#5b6576', r=.8); c.shine(12.6, 8.6, 1.1, 220)

def G_electrician(c):   # plug + bolt
    c.stroke([(9, 27), (12, 22), (12.5, 18)], 1.8, '#2c2f38')
    c.rect(8, 9.5, 17, 18.5, '#efe6d2', r=2); c.rect(9.5, 4.5, 11.3, 9.8, STEEL, r=.5, owf=.6); c.rect(13.7, 4.5, 15.5, 9.8, STEEL, r=.5, owf=.6)
    bolt(c, .62, 5.5, 2)
def G_power_grid(c):    # lattice pylon carrying a line + bolt
    for a, b in (((8, 29), (13.5, 6)), ((24, 29), (18.5, 6)), ((10, 21), (22, 21)), ((11.5, 14), (20.5, 14)), ((10, 21), (20.5, 14)), ((22, 21), (11.5, 14)), ((13.5, 6), (18.5, 6))):
        c.stroke([a, b], 1.3, '#9aa4b4')
    c.stroke([(4, 9.5), (28, 9.5)], 1.2, '#6b7486'); c.dot(5, 11, 1, '#e8edf2'); c.dot(27, 11, 1, '#e8edf2')
    bolt(c, .48, 0, 7.5)
def G_powered_tier(c):  # graphite wall panel with a glowing LED strip and heat waves
    c.poly([(5, 10), (17, 4), (27, 9), (27, 26), (15, 31), (5, 26)], GRAPH, shade=.12)
    c.poly([(5, 10), (15, 15), (15, 31), (5, 26)], '#565e6e', ol=False); c.poly([(15, 15), (27, 9), (27, 26), (15, 31)], '#3e4454', ol=False)
    c.poly([(5, 10), (17, 4), (27, 9), (15, 15)], '#7d8596', ol=False)
    c.line([(6, 13.5), (14.5, 17.8)], 1.3, LED); c.line([(15.5, 17.8), (26, 12.5)], 1.3, LEDH)
    for k in range(3):
        y = 21 + k * 2.4; c.line([(16.5, y + 2.6), (25.5, y - 1.9)], .5, '#7d8596')
    for x in (8, 11):
        c.line([(x, 25), (x + 1, 23), (x, 21), (x + 1, 19)], .6, '#ff9a4a')
def G_hydroponics(c):   # sprout in a net pot under a pink grow bar
    c.rect(5, 4, 27, 7, '#3e4454', r=1); c.rect(7, 6.4, 25, 7.6, '#ff92ea', r=.5, ol=False)
    for x in (10, 16, 22): c.line([(x, 8.5), (x - 1, 11)], .5, '#ff92ea', 170)
    c.poly([(10, 21), (22, 21), (20, 28), (12, 28)], '#e8edf2', shade=.15)
    for x in (13, 16, 19): c.line([(x, 22), (x, 27.5)], .4, '#9aa4b4')
    c.stroke([(16, 21.5), (16, 14)], 1.1, '#4a9a3c')
    c.poly([(16, 15.5), (10.5, 12), (12, 17.5)], '#6cc04a', shade=.15); c.poly([(16, 14.5), (22, 10.5), (20.5, 16.5)], '#6cc04a', shade=.15)
    c.ell(16, 21, 6.2, 1.4, '#62bfe4', ol=False)

def P_icon_power_on(c):
    c.ell(16, 16, 13, 13, '#38a454', shade=.25); c.ell(16, 16, 10.4, 10.4, dk('#38a454', .45), ol=False, shade=.25)
    bolt(c, .78, 0, 0, col='#ffe66a'); c.shine(9.5, 8.5, 1.1, 200)
def P_icon_power_off(c):
    c.ell(16, 16, 13, 13, '#6b7486', shade=.25); c.ell(16, 16, 10.4, 10.4, '#3a3f4a', ol=False, shade=.25)
    bolt(c, .78, 0, 0, col='#8c9894'); c.stroke([(8.5, 23.5), (23.5, 8.5)], 2.2, '#e0483c')
def P_icon_battery(c):
    c.rect(3.5, 9.5, 26, 23.5, '#3a3f4a', r=2.4); c.rect(26, 13, 29, 20, '#9aa4b4', r=.8)
    for i, col in enumerate(('#4cc25e', '#4cc25e', '#8edc5a')):
        c.rect(6 + i * 6.6, 12, 11.2 + i * 6.6, 21, col, r=.8, owf=.5)
    c.shine(6.5, 11.2, .8, 180)

PAINT = {k[2:]: v for k, v in globals().items() if k.startswith('P_')}
GLYPH = {'skill_electrician': (G_electrician, 'crafting'), 'skill_power_grid': (G_power_grid, 'crafting'),
         'skill_powered_tier': (G_powered_tier, 'building'), 'skill_hydroponics': (G_hydroponics, 'crafting')}

def crisp(im):
    a = np.array(im); return Image.fromarray(np.where(a[..., 3:] >= 128, np.concatenate([a[..., :3], np.full(a.shape[:2] + (1,), 255, np.uint8)], -1), 0).astype(np.uint8))
def paint(k):
    c = C(32, 8); c.ow = 1.0; PAINT[k](c); return crisp(c.out(64)), crisp(c.out(32))
def skill(k):
    fn, br = GLYPH[k]; col = SK.BR[br]; out = []
    for px in (64, 32):
        c = C(32, 8); SK.frame(c, col, False, False); base = c.out(px)
        g = C(32, 8); g.ow = 1.0; fn(g); gi = g.out(int(round(px * .66)))
        base.alpha_composite(gi, ((px - gi.size[0]) // 2, int(round((px - gi.size[1]) / 2 - px * .02)))); out.append(crisp(base))
    return tuple(out)


def sheet(cells, cols, cell):
    rows = (len(cells) + cols - 1) // cols; im = Image.new('RGBA', (cols * cell, rows * cell), (0, 0, 0, 0))
    for i, c in enumerate(cells): im.paste(c, ((i % cols) * cell, (i // cols) * cell))
    return im, rows


def main():
    build = [(f'build_{k}', from_art(elec_frame(k))) for k in ELEC] + [(f'build_{k}_t5', from_art(t5_frame(k))) for k in T5]
    small = [(k, paint(k)) for k in ('circuit_board', 'electric_motor', 'solar_cell', 'led_bulb')] + [(k, skill(k)) for k in GLYPH] + \
            [(k, paint(k)) for k in ('icon_power_on', 'icon_power_off', 'icon_battery')]
    man = json.load(open(os.path.join(ITEMS, 'manifest.items.json')))
    mine = {'items_build_elec', 'items_elec'}; keys = {k for k, _ in build + small} | {'kit_' + k for k in KITS}
    man['atlases'] = [a for a in man['atlases'] if a['key'] not in mine]
    man['sprites'] = [s for s in man['sprites'] if s['key'] not in keys]
    for ak, ents, cols, res in (('items_build_elec', build, 16, 'stream'), ('items_elec', small, 11, 'resident')):
        s2, rows = sheet([e[1][0] for e in ents], cols, 64); s1, _ = sheet([e[1][1] for e in ents], cols, 32)
        save_page(s1, os.path.join(ITEMS, f'atlases/{ak}.png')); save_page(s2, os.path.join(ITEMS, f'atlases/{ak}@2x.png'))
        man['atlases'].append({'key': ak, 'image': f'atlases/{ak}.png', 'frameW': 32, 'frameH': 32, 'columns': cols, 'rows': rows, 'residency': res,
                               'pages': [{'scale': 2, 'image': f'atlases/{ak}@2x.png'}]})
        for i, (k, _) in enumerate(ents):
            cat = 'item' if k in ('circuit_board', 'electric_motor', 'solar_cell', 'led_bulb') else 'ui'
            man['sprites'].append({'key': k, 'category': cat, 'atlas': ak, 'anchor': {'x': 0.5, 'y': 0.5}, 'animations': {'idle': {'frames': [i], 'fps': 1}}})
            if ak == 'items_build_elec' and k[6:] in KITS:   # brief section 6: the kit's inventory icon IS its build_<key> cell (no second painting)
                man['sprites'].append({'key': 'kit_' + k[6:], 'category': 'item', 'atlas': ak, 'anchor': {'x': 0.5, 'y': 0.5}, 'animations': {'idle': {'frames': [i], 'fps': 1}}})
        print(ak, s1.size, len(ents))
    open(os.path.join(ITEMS, 'manifest.items.json'), 'w').write(json.dumps(man, indent=1) + '\n')
    if len(sys.argv) > 1:   # preview: @2x cells on a mid-grey card, 1x row beneath
        allc = build + small; cols = 16; rows = (len(allc) + cols - 1) // cols
        pv = Image.new('RGBA', (cols * 72 + 8, rows * 112 + 8), (74, 78, 92, 255))
        for i, (k, (b, s)) in enumerate(allc):
            x, y = 8 + (i % cols) * 72, 8 + (i // cols) * 112; pv.alpha_composite(b, (x, y)); pv.alpha_composite(s, (x + 16, y + 70))
        pv.save(sys.argv[1]); print(sys.argv[1], pv.size)


if __name__ == '__main__':
    main()
