"""SurVivaZ procedural SFX recipes: warm, playful, soft-edged. Zombies are goofy groans and squelches.
Every function takes (rng, dur, f) and returns a mono float array (stereo for ambience beds)."""
import numpy as np
from dsp import *  # noqa

# ---------------------------------------------------------------- building blocks

def thump(rng, f=110, dur=0.15, tau=0.04, drop=1.6):
    n = n_(dur)
    fr = glide(f * drop, f, n, 0.3)
    return S_(sine(fr) * env_exp(n, tau, 0.001))


def grit(rng, dur, lo, hi, tau, dens=1.0):
    n = n_(dur)
    x = bp(noise(rng, n), lo, hi) * env_exp(n, tau, 0.002)
    if dens < 1:
        mask = lp((rng.random(n) < dens * 0.02).astype(float), 300, 1)
        x *= 0.3 + mask / (mask.max() + 1e-9)
    return S_(x)


def grains(rng, dur, count, lo, hi, gdur=0.01, spread=None, decay=None):
    n = n_(dur)
    out = np.zeros(n)
    spread = spread or dur * 0.8
    for i in range(count):
        at = rng.random() ** 1.5 * spread
        g = n_(gdur * rng.uniform(0.5, 1.5))
        f0 = rng.uniform(lo, hi)
        gr = reson(noise(rng, g), f0, rng.uniform(3, 8)) * env_exp(g, gdur / 3, 0.0005)
        amp = rng.uniform(0.3, 1) * (np.exp(-at / decay) if decay else 1)
        place(out, gr, at, amp)
    return S_(out)


def bubble(rng, f=None, dur=0.06):
    f = f or rng.uniform(400, 1400)
    n = n_(dur)
    fr = glide(f, f * rng.uniform(1.6, 2.6), n, 0.6)
    return S_(sine(fr) * env_exp(n, dur / 3, 0.001))


def wood_knock(rng, f=180, dur=0.2, tau=0.05):
    n = n_(dur)
    r = [1, 2.57, 4.1, 6.3]
    return S_(modal([f * k for k in r], [tau, tau * 0.5, tau * 0.3, tau * 0.2], [1, 0.5, 0.25, 0.12], n, rng, 0.03))


def metal_tink(rng, f=1200, dur=0.4, tau=0.12, soft=6000):
    n = n_(dur)
    r = [1, 2.76, 5.4, 8.93]
    return S_(lp(modal([f * k for k in r], [tau, tau * 0.6, tau * 0.35, tau * 0.2], [1, 0.45, 0.2, 0.08], n, rng, 0.02), soft))


def stone_tap(rng, f=1200, dur=0.15):
    n = n_(dur)
    return S_(modal([f, f * 1.83, f * 2.9], [0.02, 0.012, 0.008], [1, 0.5, 0.3], n, rng, 0.08) + grit(rng, dur, 1500, 6000, 0.01) * 0.4)


def squelch(rng, dur=0.25, f=None, wet=1.0):
    """Cartoon squelch: resonant filter sweeping through low noise + a couple of bubbly plips."""
    n = n_(dur)
    f = f or rng.uniform(250, 500)
    src = lp(noise(rng, n), 1500) * env_bell(n, rng.uniform(0.15, 0.35), 1.2)
    fr = glide(f, f * rng.uniform(2.5, 4), n, 0.7) * (1 + 0.2 * np.sin(np.linspace(0, rng.uniform(6, 14), n)))
    y = sweep_bp(src, fr, q=6) * 3
    for _ in range(rng.integers(1, 4)):
        place(y, bubble(rng, rng.uniform(200, 600), 0.05) * 0.4 * wet, rng.uniform(0.0, dur * 0.7))
    return S_(y)


def whoosh_core(rng, dur, f, q=2.5, peak=0.45):
    n = n_(dur)
    e = env_bell(n, peak, 1.6)
    fr = f * (0.6 + 0.8 * env_bell(n, peak + 0.05, 1.0))
    y = sweep_bp(pink(rng, n), fr, q=q) * e
    return S_(y)


def chime_note(rng, f, dur, tau=0.35, bright=0.4):
    n = n_(dur)
    return S_(modal([f, f * 2, f * 3.01, f * 4.2], [tau, tau * 0.5, tau * 0.3, tau * 0.15],
                 [1, 0.35 * bright * 2, 0.12 * bright, 0.05 * bright], n, rng, 0.002) * np.minimum(1, np.arange(n) / (0.003 * SR)))


def pop_blip(rng, f, dur=0.08, rise=2.0):
    n = n_(dur)
    return S_(sine(glide(f, f * rise, n, 0.5)) * env_exp(n, dur / 4, 0.001))


# ---------------------------------------------------------------- footsteps

def footstep(rng, dur, f, surface):
    n = n_(dur)
    y = np.zeros(n)
    heel_toe = rng.uniform(0.025, 0.05)
    for k, at in enumerate([0.0, heel_toe]):
        g = 1.0 if k == 0 else rng.uniform(0.35, 0.6)
        if surface == "grass":
            s = grit(rng, 0.14, 1800, 7000, 0.035, 0.6) * 0.6 + grains(rng, 0.14, 25, 2500, 7000, 0.006) * 0.5
            s += thump(rng, rng.uniform(80, 110), 0.1, 0.02) * 0.5
        elif surface == "sand":
            s = grains(rng, 0.2, 60, 1500, 6000, 0.005, spread=0.12, decay=0.05) * 0.8 + lp(grit(rng, 0.2, 300, 3000, 0.05), 3000) * 0.5
            s += thump(rng, 90, 0.1, 0.025) * 0.4
        elif surface == "wood":
            s = wood_knock(rng, f * rng.uniform(0.9, 1.15), 0.18, 0.04) * 0.9 + grit(rng, 0.05, 1000, 4000, 0.006) * 0.3
        elif surface == "stone":
            s = stone_tap(rng, f * rng.uniform(0.8, 1.2), 0.12) * 0.6 + thump(rng, 120, 0.08, 0.015) * 0.6
            s += grains(rng, 0.1, 8, 3000, 8000, 0.004) * 0.3
        elif surface == "dirt":
            s = lp(grit(rng, 0.16, 200, 2500, 0.03), 2500) * 0.9 + grains(rng, 0.14, 12, 1500, 4000, 0.006) * 0.4
            s += thump(rng, 90, 0.1, 0.025) * 0.6
        elif surface == "zombie":
            s = thump(rng, rng.uniform(60, 80), 0.18, 0.05) * 0.8 + squelch(rng, 0.25, rng.uniform(200, 350)) * 0.7
        elif surface == "animal":
            s = lp(grit(rng, 0.08, 300, 3000, 0.012), 3000) * 0.7 + thump(rng, 150, 0.06, 0.01) * 0.4
        else:
            s = lp(grit(rng, 0.15, 250, 3000, 0.03), 3000) * 0.8 + thump(rng, 100, 0.1, 0.025) * 0.6
        place(y, s, at, g)
        if surface == "zombie":
            break
    return S_(lp(y, 9000))


def splash(rng, dur, f, kind="water"):
    n = n_(dur)
    y = np.zeros(n)
    if kind == "swim":
        for at in [0.0, dur * rng.uniform(0.4, 0.5)]:
            sw = whoosh_core(rng, dur * 0.5, rng.uniform(600, 1000), 1.5, 0.3) * 1.5
            place(y, sw, at)
            for _ in range(8):
                place(y, bubble(rng) * 0.25, at + rng.uniform(0.05, dur * 0.45))
    elif kind == "pour":
        st = bp(noise(rng, n), 800, 5000) * env_bell(n, 0.15, 0.6) * 0.4
        y += st * (0.6 + 0.4 * lp(rng.random(n), 15, 1) * 2)
        for _ in range(40):
            place(y, bubble(rng, rng.uniform(800, 2500), 0.03) * 0.3, rng.uniform(0, dur * 0.9))
    else:
        y += bp(noise(rng, n), 500, 4000) * env_exp(n, 0.05, 0.003) * 0.9
        y += thump(rng, 120, dur, 0.03) * 0.4
        for _ in range(rng.integers(4, 8)):
            place(y, bubble(rng, rng.uniform(500, 1600)) * 0.35, rng.uniform(0.01, dur * 0.6))
    return S_(y)


# ---------------------------------------------------------------- combat

def swing(rng, dur, f, heavy=0.0):
    y = whoosh_core(rng, dur, f * rng.uniform(0.85, 1.15), q=2 + 2 * (1 - heavy), peak=rng.uniform(0.35, 0.55)) * 2
    if heavy:
        n = len(y)
        y += lp(noise(rng, n), 300) * env_bell(n, 0.45, 2) * heavy * 0.6
    return S_(y)


def smack(rng, dur, f, kind="hit"):
    n = n_(dur)
    y = thump(rng, f * rng.uniform(0.9, 1.1), dur, 0.04, 2.2) * 0.9
    y += lp(grit(rng, dur, 300, 3000, 0.015), 3500) * 0.7
    if kind in ("blade", "spear", "arrow"):
        y += metal_tink(rng, rng.uniform(1800, 2600), dur, 0.05, 7000) * 0.25
    if kind in ("axe", "shovel", "pickaxe"):
        y += wood_knock(rng, rng.uniform(250, 350), dur, 0.04) * 0.5
    if kind == "arrow":
        fl = sine(rng.uniform(170, 220), n) * env_exp(n, 0.06) * (0.5 + 0.5 * np.sin(2 * np.pi * 28 * np.arange(n) / SR))
        y += fl * 0.4
    if kind == "bullet":
        y = pop_blip(rng, 300, dur, 0.4) * 0.6 + lp(grit(rng, dur, 500, 5000, 0.01), 5000)
    if kind in ("hit", "blunt", "fists", "punch"):
        # cartoony "bonk": add a soft rubbery boing
        y += sine(glide(f * 2.2, f * 1.6, n, 0.4)) * env_exp(n, 0.05) * 0.3
    if kind == "spike":
        y += wood_knock(rng, 200, dur, 0.07) * 0.6
    return S_(y)


def clank(rng, dur, f, kind=""):
    n = n_(dur)
    y = metal_tink(rng, f * rng.uniform(0.9, 1.1), dur, min(0.15, dur / 3), 5000) * 0.7
    y += thump(rng, 120, dur, 0.04) * 0.5
    if kind == "mine":
        y = stone_tap(rng, f * rng.uniform(0.8, 1.2), dur) * 0.6 + metal_tink(rng, f * 1.5, dur, 0.06, 6000) * 0.35
        y += grains(rng, dur, 15, 1500, 5000, 0.006, spread=0.2, decay=0.08) * 0.5
    if kind == "crash":
        y = thump(rng, 70, dur, 0.15) * 0.8 + lp(noise(rng, n), 1500) * env_exp(n, 0.12) * 0.5
        for _ in range(10):
            place(y, metal_tink(rng, rng.uniform(500, 2000), 0.3, 0.06, 5000) * rng.uniform(0.2, 0.5), rng.uniform(0, dur * 0.7))
        place(y, sine(glide(400, 200, n_(0.4), 1)) * env_exp(n_(0.4), 0.12) * 0.3, 0.05)  # boing
    if kind == "repair":
        y = np.zeros(n)
        for at in (0.0, rng.uniform(0.2, 0.3)):
            place(y, metal_tink(rng, f * rng.uniform(0.9, 1.1), 0.3, 0.08) * 0.6 + wood_knock(rng, 300, 0.2, 0.03) * 0.5, at)
    if kind == "snap":
        y = wood_knock(rng, 600, dur, 0.03) * 0.8 + metal_tink(rng, f, dur, 0.04, 5000) * 0.4 + grit(rng, dur, 2000, 6000, 0.005) * 0.4
    return S_(y)


def twang(rng, dur, f, kind="bow"):
    n = n_(dur)
    s = lp(ks_pluck(f * rng.uniform(0.95, 1.05), n, rng, bright=0.25, decay=0.99), 4000) * env_exp(n, 0.09)
    y = s * 0.7
    w = whoosh_core(rng, dur * 0.6, 2500, 2, 0.3)
    y[:len(w)] += w * 0.8
    if kind == "crossbow":
        y += wood_knock(rng, 400, dur, 0.03) * 0.6
    if kind == "turret":
        y += wood_knock(rng, 260, dur, 0.05) * 0.6
    return S_(y)


def gunshot(rng, dur, f, kind="pistol"):
    """Cartoony 'poomf' pop, never harsh: lowpassed noise burst, low thump, puff tail."""
    n = n_(dur)
    big = {"pistol": 0.6, "rifle": 0.8, "autorifle": 0.7, "shotgun": 1.0, "musket": 0.9, "turret": 0.7}.get(kind, 0.7)
    y = lp(noise(rng, n), f * 4) * env_exp(n, 0.02 + 0.03 * big, 0.0005) * 1.0
    y += thump(rng, 70 + 30 * (1 - big), dur, 0.05 + 0.05 * big, 2.5) * (0.8 + big * 0.4)
    y += pop_blip(rng, f * 0.8, 0.05, 0.5) * 0.4
    tail = lp(pink(rng, n), 1200) * env_exp(n, 0.15 * big, 0.02) * 0.25
    y += tail
    if kind == "musket":
        y += hp(noise(rng, n), 3000) * env_ad(n, 0.05, dur * 0.8, 2) * 0.12
    return S_(y)


def creak(rng, dur, f, kind=""):
    n = n_(dur)
    rate = glide(f * rng.uniform(0.08, 0.12), f * rng.uniform(0.05, 0.09), n, 1) * (1 + 0.3 * lp(noise(rng, n), 4, 1) * 8)
    ph = np.cumsum(np.abs(rate)) / SR
    pulses = (np.diff(np.floor(ph), prepend=0) > 0).astype(float)
    y = reson(pulses, f, 8) + reson(pulses, f * 2.3, 10) * 0.5 + reson(pulses, f * 3.7, 10) * 0.25
    y *= env_bell(n, rng.uniform(0.3, 0.6), 0.8)
    return S_(lp(y, 5000))


def tree_fall(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    place(y, creak(rng, 1.0, rng.uniform(100, 150)) * 1.0, 0.0)
    place(y, whoosh_core(rng, 0.9, 500, 1.5, 0.7) * 1.2, 0.8)
    place(y, thump(rng, 55, 0.8, 0.25, 1.4) * 1.4, 1.65)
    place(y, grains(rng, 0.8, 120, 1500, 6000, 0.008, spread=0.6, decay=0.25) * 0.4, 1.65)
    return S_(y)


def reload(rng, dur, f, kind="pistol"):
    n = n_(dur)
    y = np.zeros(n)
    if kind in ("bow", "sling"):
        place(y, creak(rng, dur * 0.6, 280) * 0.5, 0.0)
        place(y, wood_knock(rng, 700, 0.08, 0.01) * 0.7, dur * 0.6)
        place(y, grit(rng, 0.1, 2000, 6000, 0.02) * 0.3, dur * 0.1)
        return S_(y)
    steps = {"crossbow": 3, "pistol": 3, "rifle": 4, "autorifle": 3, "shotgun": 5, "musket": 4}.get(kind, 3)
    times = np.sort(rng.uniform(0.0, dur * 0.85, steps))
    times[0] = 0
    for i, at in enumerate(times):
        fq = f * rng.uniform(0.7, 1.6)
        c = metal_tink(rng, fq, 0.12, 0.02, 6000) * 0.5 + wood_knock(rng, fq * 0.4, 0.1, 0.012) * 0.6
        place(y, c, at)
        if kind == "musket" and i == 1:
            place(y, bp(noise(rng, n_(0.3)), 400, 1600) * env_bell(n_(0.3), 0.5) * 0.4, at)  # ramrod
    return S_(y)


def click(rng, dur, f):
    n = n_(dur)
    y = modal([f, f * 2.2, f * 3.9], [0.01, 0.006, 0.003], [1, 0.4, 0.2], n, rng, 0.05) + grit(rng, dur, 1500, 7000, 0.003) * 0.3
    return S_(y)


def boom(rng, dur, f, fire=False):
    """Soft cartoony poof-boom: big lowpassed rumble, drop, rolling tail; no crack."""
    n = n_(dur)
    y = lp(pink(rng, n), glide(2500, 200, n, 0.3)[0]) * 0
    body = sweep_lp(brown(rng, n) * 6 + noise(rng, n) * 0.4, glide(3000, 150, n, 0.25))
    y += body * env_exp(n, 0.5, 0.005)
    y += sine(glide(f * 2.2, f * 0.6, n, 0.4)) * env_exp(n, 0.35, 0.002) * 0.9
    y += grains(rng, dur, 40, 600, 3000, 0.02, spread=1.2, decay=0.4) * 0.15
    if fire:
        y += whoosh_core(rng, dur, 700, 1.2, 0.2) * 1.0 + hp(noise(rng, n), 2000) * env_ad(n, 0.1, dur, 3) * 0.08
    return S_(y)


def rustle(rng, dur, f, kind=""):
    n = n_(dur)
    if kind == "debris":
        return S_(grains(rng, dur, 70, 400, 3000, 0.015, spread=dur * 0.9, decay=0.4) * 0.8 + lp(pink(rng, n), 800) * env_exp(n, 0.3) * 0.5)
    if kind in ("stone", "rock"):
        y = thump(rng, 80, dur, 0.1) * 0.7 + grains(rng, dur, 80, 300, 2500, 0.02, spread=dur * 0.8, decay=0.25) * 0.9
        return S_(y + stone_tap(rng, 900, dur) * 0.4)
    if kind == "wood":
        y = thump(rng, 90, dur, 0.1) * 0.6
        for _ in range(14):
            place(y, wood_knock(rng, rng.uniform(150, 500), 0.25, 0.03) * rng.uniform(0.2, 0.6), rng.random() ** 1.6 * dur * 0.7)
        place(y, creak(rng, 0.4, 200) * 0.4, 0.0)
        return S_(y)
    if kind == "metal":
        y = thump(rng, 100, dur, 0.1) * 0.6
        for _ in range(10):
            place(y, metal_tink(rng, rng.uniform(600, 2200), 0.4, 0.08, 5000) * rng.uniform(0.15, 0.4), rng.random() ** 1.6 * dur * 0.7)
        return S_(y)
    if kind == "generic_break":
        return S_(rustle(rng, dur, f, "wood") * 0.6 + rustle(rng, dur, f, "debris") * 0.5)
    if kind == "harvest":
        y = grit(rng, dur, 1500, 7000, dur / 4, 0.5) * 0.6 + grains(rng, dur, 30, 2000, 7000, 0.008) * 0.5
        place(y, pop_blip(rng, rng.uniform(500, 700), 0.08, 1.8) * 0.6, dur * rng.uniform(0.4, 0.6))
        return S_(y)
    if kind == "pick":
        y = grit(rng, dur, 2000, 7000, 0.05) * 0.4
        place(y, pop_blip(rng, rng.uniform(700, 1000), 0.07, 2.2) * 0.8, 0.02)
        return S_(y)
    if kind == "craft":
        y = np.zeros(n)
        for at in np.sort(rng.uniform(0, dur * 0.7, 3)):
            place(y, wood_knock(rng, rng.uniform(250, 450), 0.15, 0.03) * 0.7, at)
        return S_(y + grit(rng, dur, 1500, 6000, dur / 3, 0.5) * 0.3)
    if kind == "skid":
        fr = 1600 + 300 * np.sin(np.linspace(0, 12, n)) + 100 * lp(noise(rng, n), 10, 1) * 20
        return S_(sweep_bp(noise(rng, n), fr, 12) * 0.6 + lp(noise(rng, n), 500) * 0.3)
    # leafy rustle (plant / fertilize)
    y = grit(rng, dur, f * 0.6, f * 3, dur / 3, 0.5) * 0.5 + grains(rng, dur, 25, f, f * 3, 0.01) * 0.5
    if kind == "plant":
        place(y, thump(rng, 120, 0.12, 0.03) * 0.6, dur * 0.5)
    return S_(y)


def sizzle(rng, dur, f, kind=""):
    n = n_(dur + 0.5)
    base = hp(noise(rng, n), f * 0.6) * (0.4 + 0.6 * lp(rng.random(n), 8, 1) * 2)
    cr = np.zeros(n)
    for _ in range(int(dur * 60)):
        place(cr, click(rng, 0.01, rng.uniform(3000, 8000)) * rng.uniform(0.2, 0.8), rng.uniform(0, dur + 0.4))
    y = base * 0.25 + cr * 0.4
    if kind == "steam":
        y = hp(noise(rng, n), 2500) * env_ad(n, 0.05, dur, 2) * 0.6 + lp(noise(rng, n), 800) * env_exp(n, 0.1) * 0.4
        for _ in range(10):
            place(y, bubble(rng, rng.uniform(300, 900)) * 0.2, rng.uniform(0, dur * 0.5))
    return S_(y)


def chop(rng, dur, f):
    n = n_(dur)
    y = wood_knock(rng, f * rng.uniform(0.85, 1.15), dur, 0.06) * 1.0 + thump(rng, 90, dur, 0.04) * 0.5
    y += grains(rng, dur, 12, 1500, 5000, 0.008, spread=0.1, decay=0.05) * 0.4
    return S_(y)


def dig(rng, dur, f):
    n = n_(dur)
    sc = sweep_bp(noise(rng, n), glide(400, 1500, n, 1), 2) * env_bell(n, 0.3, 1.2) * 0.8
    y = sc + thump(rng, f * 0.5, dur, 0.04) * 0.6 + grains(rng, dur, 30, 400, 3000, 0.012, spread=dur * 0.7, decay=0.2) * 0.6
    return S_(y)


def pop(rng, dur, f, two=False):
    n = n_(dur)
    y = pop_blip(rng, f * rng.uniform(0.95, 1.05), min(dur, 0.09), 1.8)
    if two:
        place(y, pop_blip(rng, f * 1.5, 0.07, 1.6) * 0.6, 0.06)
    return S_(np.pad(y, (0, max(0, n - len(y))))[:n] + grit(rng, dur, 2000, 6000, 0.005) * 0.1)


def thud(rng, dur, f, kind="wood"):
    n = n_(dur)
    y = thump(rng, f * rng.uniform(0.9, 1.1), dur, 0.07, 1.8) * 0.9 + wood_knock(rng, f * 1.8, dur, 0.06) * 0.6
    y += lp(grit(rng, dur, 200, 2000, 0.02), 2000) * 0.4
    if kind == "stone":
        y += stone_tap(rng, 700, dur) * 0.4 + grains(rng, dur, 15, 500, 3000, 0.01, spread=0.15, decay=0.08) * 0.4
    if kind == "drop":
        place(y, thump(rng, f * 1.3, 0.1, 0.03) * 0.4, rng.uniform(0.07, 0.11))  # little bounce
    return S_(y)


def tick(rng, dur, f, kind=""):
    n = n_(dur)
    if kind == "error":
        y = np.zeros(n)
        for i, ff in enumerate([330, 247]):
            nn = n_(0.13)
            s = (sine(ff, nn) + 0.3 * sine(ff * 2, nn)) * env_ad(nn, 0.005, 0.12, 1.5)
            place(y, lp(s, 2000), i * 0.13)
        return S_(y)
    if kind == "invalid":
        nn = n
        return S_(lp(sine(glide(260, 200, nn), None) * env_ad(nn, 0.005, dur, 1.5), 1500))
    if kind == "back":
        return S_(sine(glide(f * 1.3, f, n, 0.5)) * env_exp(n, 0.04, 0.002))
    return S_(modal([f, f * 1.5], [0.008, 0.004], [1, 0.3], n, rng, 0.02))


def chime(rng, dur, f, notes=(1.0, 1.5)):
    n = n_(dur)
    y = np.zeros(n)
    step = min(0.09, dur / (len(notes) + 1))
    for i, r in enumerate(notes):
        place(y, chime_note(rng, f * r, dur, tau=dur / 3) * (0.8 ** i), i * step)
    return S_(y)


def fanfare(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    seq = [1, 1.25, 1.5, 2.0]
    for i, r in enumerate(seq):
        nn = n_(dur - i * 0.12)
        p = ks_pluck(f * r, nn, rng, 0.55, 0.9975) * 0.6 + chime_note(rng, f * r * 2, nn / SR, 0.5, 0.3) * 0.3
        place(y, p, i * 0.12)
    for _ in range(12):  # sparkle
        place(y, chime_note(rng, f * 4 * rng.choice([1, 1.25, 1.5, 2]), 0.4, 0.1) * 0.08, rng.uniform(0.4, dur * 0.6))
    return S_(reverb(y, rng, 0.3, 0.25))


def ignite(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    place(y, hp(noise(rng, n_(0.15)), 2500) * env_bell(n_(0.15), 0.3) * 0.5, 0.0)  # match scratch
    w = whoosh_core(rng, dur - 0.1, 600, 1.0, 0.25) * 1.5 + lp(noise(rng, n_(dur - 0.1)), 400) * env_bell(n_(dur - 0.1), 0.2) * 0.5
    place(y, w, 0.1)
    place(y, sizzle(rng, dur * 0.7, 3000) * env_exp(n_(dur * 0.7 + 0.5), 0.3) * 0.5, 0.2)
    return S_(y)


def crackle_bed(rng, dur, stereo=False):
    n = n_(dur)
    chans = []
    for c in range(2 if stereo else 1):
        bed = lp(pink(rng, n), 900) * 0.35 * (0.7 + 0.3 * lp(rng.random(n), 2, 1) * 2)
        roar = bp(noise(rng, n), 150, 600) * 0.1
        cr = np.zeros(n)
        t = 0.0
        while t < dur:
            t += rng.exponential(0.06)
            g = click(rng, rng.uniform(0.008, 0.03), rng.uniform(1500, 6000)) * rng.uniform(0.1, 1) ** 2
            place(cr, g, t)
            if rng.random() < 0.05:
                place(cr, wood_knock(rng, rng.uniform(300, 600), 0.1, 0.01) * 0.4, t)
        chans.append(bed + roar + cr * 0.6)
    return np.stack(chans, 1) if stereo else chans[0]


def snuff(rng, dur, f, kind="fire"):
    n = n_(dur)
    if kind == "fire":
        y = lp(noise(rng, n), 1200) * env_exp(n, 0.08, 0.005) * 0.8 + sizzle(rng, dur, 3000)[:n] * env_exp(n, 0.4) * 0.6
        return S_(y)
    if kind == "blow":  # snuffer zombie blows out a fire: puffed-cheeks "fffooo"
        b = bp(noise(rng, n), 300, 2500) * env_bell(n, 0.25, 0.8)
        return S_(b * 1.0 + voice(glide(f, f * 0.8, n), n, rng, V("u", "o"), 0.2, breath=0.5) * env_bell(n, 0.3) * 0.15)
    if kind == "sniff":  # idle: cute sniff-sniff
        y = np.zeros(n)
        t = 0.0
        while t < dur - 0.2:
            for k in range(rng.integers(2, 4)):
                s = n_(rng.uniform(0.07, 0.11))
                place(y, bp(noise(rng, s), 1500, 5000) * env_bell(s, 0.6) * 0.6, t)
                t += rng.uniform(0.12, 0.16)
            t += rng.uniform(0.3, 0.6)
        g = voice(glide(f * 0.4, f * 0.5, n), n, rng, V("m", "m"), 0.1) * env_bell(n, 0.8) * 0.15
        return S_(y + g)
    if kind == "death":  # deflating raspberry + squeak down
        y = voice(glide(f, f * 0.3, n, 0.6), n, rng, V("e", "uh", "u"), fry=0.3, vib=(9, 0.04)) * env_ad(n, 0.02, dur, 1.2) * 0.6
        y += lp(noise(rng, n), 1200) * (0.5 + 0.5 * np.sin(2 * np.pi * 35 * np.arange(n) / SR)) * env_ad(n, 0.1, dur, 1.5) * 0.4
        place(y, pop_blip(rng, 300, 0.12, 0.5) * 0.5, dur * 0.85)
        return S_(y)
    return S_(np.zeros(n))


def crunch(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    t = 0.0
    while t < dur - 0.1:
        g = grains(rng, 0.12, 25, f * 0.5, f * 3, 0.008, spread=0.07, decay=0.04) * 0.8 + thump(rng, 140, 0.08, 0.02) * 0.3
        place(y, g, t)
        t += rng.uniform(0.14, 0.22)
    nom = voice(glide(220, 200, n_(0.12)), n_(0.12), rng, V("m", "m"), 0) * env_bell(n_(0.12)) * 0.1
    place(y, nom, dur * 0.6)
    return S_(y)


def gulp(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    t = 0.0
    while t < dur - 0.15:
        nn = n_(0.12)
        g = sine(glide(f * rng.uniform(0.9, 1.1), f * 2.2, nn, 0.4)) * env_bell(nn, 0.3) * 0.7
        g += reson(lp(noise(rng, nn), 1000), f * 1.5, 4) * env_bell(nn, 0.4) * 0.6
        place(y, g, t)
        t += rng.uniform(0.22, 0.3)
    place(y, bp(noise(rng, n_(0.15)), 600, 3000) * env_bell(n_(0.15), 0.2) * 0.25, max(0, dur - 0.18))  # "ahh"
    return S_(y)


# ---------------------------------------------------------------- voices (player, zombies, animals)

def player(rng, dur, f, kind="hurt"):
    n = n_(dur)
    if kind == "hurt":
        fr = glide(f * rng.uniform(1.0, 1.3), f * rng.uniform(0.8, 0.95), n, 0.6)
        v = rng.choice(["oof", "ow", "eh"])
        vw = {"oof": V("o", "u", "u"), "ow": V("a", "o", "u"), "eh": V("e", "uh")}[v]
        y = voice(fr, n, rng, vw, fry=0.05, vib=(6, 0.01), breath=0.08) * env_ad(n, 0.015, dur * 0.85, 1.6)
        return S_(y)
    if kind == "death":  # "uh-oh..." descending, soft
        y = np.zeros(n)
        a = n_(0.35)
        place(y, voice(glide(f * 1.2, f * 1.1, a), a, rng, V("uh", "uh"), 0.02) * env_bell(a, 0.3), 0.0)
        b = n_(dur - 0.45)
        place(y, voice(glide(f * 0.95, f * 0.6, b, 0.8), b, rng, V("o", "o", "u"), 0.08, vib=(5, 0.02), breath=0.1) * env_ad(b, 0.03, dur - 0.45, 1.3), 0.4)
        return S_(y)
    if kind == "cold":  # brrrr + teeth chatter
        y = voice(glide(f, f * 0.95, n), n, rng, V("u", "u"), 0.05, breath=0.3) * env_bell(n, 0.4) * (0.6 + 0.4 * np.sin(2 * np.pi * 24 * np.arange(n) / SR))
        for t in np.arange(0.05, dur - 0.05, rng.uniform(0.05, 0.07)):
            place(y, click(rng, 0.02, rng.uniform(2500, 3500)) * 0.15, t)
        return S_(y)
    if kind == "exhausted":
        y = np.zeros(n)
        t = 0.0
        while t < dur - 0.2:
            inn = n_(rng.uniform(0.2, 0.28))
            place(y, bp(noise(rng, inn), 700, 2500) * env_bell(inn, 0.5) * 0.3, t)
            t += inn / SR + 0.02
            out = n_(rng.uniform(0.22, 0.3))
            place(y, (voice(np.full(out, f * 0.6), out, rng, V("a", "uh"), 0.1, breath=2.0) * 0.3) * env_bell(out, 0.3), t)
            t += out / SR + 0.04
        return S_(y)
    return S_(np.zeros(n))


def zombie(rng, dur, f, kind="idle"):
    """Goofy-cute zombie vocal: wobbly low 'uuurgh/braaa' with vocal fry and the odd squelch."""
    n = n_(dur)
    f = f * rng.uniform(0.9, 1.12)
    vib = (rng.uniform(4, 7), rng.uniform(0.02, 0.05))
    if kind == "idle":
        y = np.zeros(n)
        segs = rng.integers(1, 3)
        t = 0.0
        for s in range(segs):
            L = (dur * 0.9 - t) / (segs - s) * rng.uniform(0.7, 1.0)
            m = n_(L)
            contour = f * (1 + 0.25 * np.sin(np.linspace(0, np.pi * rng.uniform(1, 2.5), m)) * rng.choice([-1, 1]))
            vw = [V("u", "a", "o"), V("uh", "aw", "u"), V("m", "a", "aw"), V("a", "e", "u")][rng.integers(4)]
            v = voice(contour, m, rng, vw, fry=0.35, vib=vib, breath=0.06) * env_bell(m, rng.uniform(0.2, 0.5), 0.9)
            place(y, v, t)
            t += L + rng.uniform(0.05, 0.15)
        if rng.random() < 0.7:
            place(y, squelch(rng, 0.2) * 0.35, rng.uniform(0, dur * 0.7))
        return S_(y)
    if kind == "chase":  # excited 'hur-hur-hur!'
        y = np.zeros(n)
        t = 0.0
        k = 0
        while t < dur - 0.15:
            m = n_(rng.uniform(0.14, 0.22))
            fr = glide(f * (1.1 + 0.08 * k), f * 0.9, m, 0.5)
            place(y, voice(fr, m, rng, V("uh", "aw"), fry=0.25, vib=vib) * env_ad(m, 0.02, m / SR, 1.5), t)
            t += m / SR + rng.uniform(0.03, 0.08)
            k += 1
        return S_(y)
    if kind == "attack":  # 'nyaaargh' + cartoony chomp
        m = n_(dur * 0.7)
        y = np.zeros(n)
        place(y, voice(glide(f * 1.3, f * 0.9, m, 0.5), m, rng, V("i", "a", "aw"), fry=0.3, vib=vib) * env_ad(m, 0.03, dur * 0.7, 1.2), 0.0)
        ch = n_(0.08)
        chomp = wood_knock(rng, rng.uniform(500, 700), 0.08, 0.012) * 0.6 + pop_blip(rng, 400, 0.06, 0.6) * 0.3
        place(y, chomp, dur * 0.62)
        place(y, chomp * 0.7, dur * 0.62 + 0.11)
        return S_(y)
    if kind == "hurt":  # surprised 'blorp!' (high yelp) + squelch
        y = voice(glide(f * 1.4, f * 0.9, n, 0.4), n, rng, V("o", "u"), fry=0.15, vib=(8, 0.03)) * env_ad(n, 0.01, dur * 0.8, 1.6)
        y += squelch(rng, dur, rng.uniform(250, 400)) * 0.5
        return S_(y)
    if kind == "death":  # sad deflating 'uuuhhh...' + plop
        y = voice(glide(f * 1.1, f * 0.45, n, 0.7), n, rng, V("o", "uh", "u"), fry=0.5, vib=(5, 0.04), breath=0.1) * env_ad(n, 0.05, dur * 0.85, 1.3)
        place(y, squelch(rng, 0.3, 200) * 0.6, dur * 0.65)
        place(y, pop_blip(rng, 220, 0.1, 0.5) * 0.4, dur * 0.85)
        return S_(y)
    return S_(np.zeros(n))


def shriek(rng, dur, f, kind="chase"):
    """Snuffer: squeaky whiny 'eeee' - cartoon, lowpassed so it's never piercing."""
    n = n_(dur)
    f = f * rng.uniform(0.9, 1.1) * 0.6
    if kind == "chase":
        fr = f * (1 + 0.15 * np.sin(2 * np.pi * rng.uniform(2, 4) * np.arange(n) / SR))
    elif kind == "attack":
        fr = glide(f * 0.8, f * 1.3, n, 0.5)
    else:
        fr = glide(f * 1.4, f * 0.8, n, 0.4)
    y = voice(fr, n, rng, V("i", "e", "i"), fry=0.1, vib=(9, 0.03), breath=0.1) * env_ad(n, 0.03, dur * 0.9, 1.3)
    return S_(lp(y, 3500))


def animal(rng, dur, f, recipe, kind):
    n = n_(dur)
    f = f * rng.uniform(0.92, 1.08)
    sad = kind == "death"
    if recipe == "squeal":
        y = np.zeros(n)
        cnt = 1 if kind != "idle" else rng.integers(1, 4)
        t = 0.0
        for i in range(cnt):
            m = n_(dur / cnt * rng.uniform(0.4, 0.8) if kind == "idle" else dur * 0.9)
            fr = glide(f * 1.2, f * (0.5 if sad else 0.9), m, 0.6)
            place(y, voice(fr, m, rng, V("i", "e"), 0.05, vib=(10, 0.02)) * env_ad(m, 0.01, m / SR, 1.4), t)
            t += m / SR + 0.05
        return S_(lp(y, 5000))
    if recipe == "howl":
        fr = glide(f * 0.8, f * 1.2, n, 0.5) if kind == "idle" else glide(f * 1.3, f * (0.6 if sad else 0.9), n, 0.5)
        return S_(voice(fr, n, rng, V("u", "o", "u"), 0.04, vib=(5, 0.015), breath=0.15) * env_bell(n, 0.4, 0.9))
    if recipe == "chirp":
        y = np.zeros(n)
        cnt = rng.integers(2, 6) if kind == "idle" else (2 if kind == "hurt" else 3)
        for i in range(cnt):
            m = n_(rng.uniform(0.05, 0.12))
            a, b = (f, f * rng.uniform(1.2, 1.8)) if rng.random() < 0.5 else (f * 1.5, f * 0.9)
            if sad:
                a, b = f * (1.2 - 0.15 * i), f * (0.8 - 0.1 * i)
            fr = glide(a, b, m, 0.7) * (1 + 0.04 * np.sin(2 * np.pi * 40 * np.arange(m) / SR))
            place(y, (sine(fr) + 0.2 * sine(fr * 2)) * env_bell(m, 0.3), i * dur / (cnt + 0.5))
        return S_(y)
    if recipe == "quack":
        y = np.zeros(n)
        cnt = 1 if kind != "idle" else rng.integers(1, 4)
        for i in range(cnt):
            m = n_(min(0.25, dur / cnt * 0.8))
            fr = glide(f, f * (0.6 if sad else 0.85), m, 0.6)
            v = voice(fr, m, rng, V("a", "a"), 0.1, breath=0.1, bright=1.8)
            place(y, softclip(v * 3, 1.5) * env_ad(m, 0.01, m / SR, 1.2) * 0.5, i * dur / cnt)
        return S_(lp(y, 4500))
    if recipe == "bleat":
        fr = glide(f, f * (0.7 if sad else 0.95), n, 0.5)
        trem = 0.6 + 0.4 * np.sin(2 * np.pi * rng.uniform(6, 9) * np.arange(n) / SR)
        return S_(voice(fr, n, rng, V("e", "a", "a"), 0.08, vib=(7, 0.03)) * env_bell(n, 0.25, 0.8) * trem)
    if recipe == "moo":
        fr = glide(f * 0.9, f * (0.7 if sad else 1.0), n, 0.5)
        return S_(voice(fr, n, rng, V("m", "o", "u"), 0.08, vib=(4, 0.01), breath=0.05) * env_bell(n, 0.4, 0.9))
    if recipe == "hiss":
        y = hp(noise(rng, n), f * 0.7) * env_bell(n, 0.2 if kind != "death" else 0.1, 0.7) * 0.6
        if kind == "hurt":
            y += voice(glide(500, 350, n), n, rng, V("i", "e"), 0.1) * env_exp(n, 0.1) * 0.1
        return S_(y)
    if recipe == "growl":
        if kind == "attack":
            m = n_(dur * 0.8)
            y = np.zeros(n)
            place(y, voice(glide(f * 1.3, f, m), m, rng, V("a", "aw"), 0.35, vib=(6, 0.03)) * env_ad(m, 0.03, m / SR, 1.3), 0)
            place(y, wood_knock(rng, 600, 0.08, 0.012) * 0.5, dur * 0.7)
            return S_(y)
        fr = glide(f * 1.1, f * (0.6 if sad else 0.9), n, 0.5)
        return S_(voice(fr, n, rng, V("u", "aw", "u"), 0.35, vib=(5, 0.03), breath=0.1) * env_bell(n, 0.3, 0.9))
    return S_(np.zeros(n))


# ---------------------------------------------------------------- vehicles

def engine(rng, dur, f):
    n = n_(dur)
    t = np.arange(n) / SR
    fr = f * (1 + 0.01 * np.sin(2 * np.pi * 0.7 * t))
    ph = np.cumsum(fr) / SR
    frac = ph % 1.0
    fire = np.exp(-frac * 6) * (1 + 0.25 * rng.standard_normal(n).cumsum()[:n] * 0)  # putt pulses
    cyl = (np.floor(ph) % 4)
    gains = np.array([1.0, 0.8, 0.9, 0.75])[cyl.astype(int)]
    y = lp(fire * gains, f * 8) * 0.8
    y += lp(noise(rng, n), f * 6) * (0.3 + 0.7 * np.exp(-frac * 4)) * 0.3
    y += sine(f * 0.5, n) * 0.15
    return S_(hp(y, 35))


def engine_start(rng, dur, f, stop=False):
    n = n_(dur)
    if stop:
        fr = glide(f * 1.2, f * 0.3, n, 0.6)
        ph = np.cumsum(fr) / SR
        y = lp(np.exp(-(ph % 1) * 6), 500) * env_ad(n, 0.01, dur, 1.5)
        place(y, pop_blip(rng, 150, 0.1, 0.5) * 0.4, dur * 0.8)
        return S_(y)
    y = np.zeros(n)
    cr = n_(0.6)
    crank = lp(np.exp(-((np.arange(cr) / SR * 7) % 1) * 5), 1200) * (0.4 + 0.6 * sine(300, cr) ** 2) * 0.6
    place(y, crank, 0)
    m = n - n_(0.55)
    fr = glide(f * 0.6, f * 1.6, m, 0.3)
    fr = np.where(np.arange(m) > m * 0.5, glide(f * 1.6, f, m, 1.0), fr)
    ph = np.cumsum(fr) / SR
    place(y, lp(np.exp(-(ph % 1) * 6), 800) * env_ad(m, 0.05, dur, 0.3) * 0.9, 0.55)
    return S_(y)


def horn(rng, dur, f, truck=False):
    n = n_(dur)
    y = np.zeros(n)
    beeps = [(0, dur * 0.4), (dur * 0.5, dur * 0.45)] if not truck else [(0, dur * 0.95)]
    for at, L in beeps:
        m = n_(L)
        ph = phase(np.full(m, f))
        s = np.tanh(3 * np.sin(ph)) + 0.5 * np.tanh(3 * np.sin(ph * 1.26))
        place(y, lp(s, 2500) * env_ad(m, 0.01, L, 0.15) * 0.5, at)
    return S_(y)


def chain(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    for t in np.arange(0, dur, 1 / 14.0):
        place(y, click(rng, 0.012, f * rng.uniform(0.9, 1.1)) * rng.uniform(0.2, 0.4), t)
    y += bp(noise(rng, n), 600, 2000) * 0.05 * (1 + 0.5 * np.sin(2 * np.pi * 1.5 * np.arange(n) / SR))
    return S_(y)


def bell(rng, dur, f):
    n = n_(dur)
    y = np.zeros(n)
    for at in (0.0, rng.uniform(0.12, 0.18)):
        place(y, modal([f, f * 1.48, f * 2.1, f * 2.76], [0.25, 0.18, 0.12, 0.08], [1, 0.6, 0.35, 0.2], n, rng, 0.003), at)
    return S_(y)


def horde(rng, dur, f, kind="warning"):
    """Horde event cues: goofy-ominous groan choir + horn, silly burst, cheerful victory flourish."""
    n = n_(dur)
    y = np.zeros(n)
    if kind == "warning":
        # a chorus of wobbly zombie groans swelling in from the distance (lowpass opens as they approach)
        for _ in range(6):
            g = zombie(rng, dur * rng.uniform(0.7, 0.95), rng.uniform(85, 150), "idle")
            place(y, fade(g, 0.02, 0.15) * rng.uniform(0.25, 0.4), rng.uniform(0, dur * 0.25))
        y = sweep_lp(y, np.geomspace(500, 4000, n)) * np.linspace(0.3, 1, n)
        # silly-ominous horn: low two-note "bwaa-BWAAH" on a rising minor third
        for at, ff, L in [(0.15, 110, 0.8), (1.05, 131, 1.5)]:
            m = n_(L)
            ph = phase(ff * (1 + 0.01 * np.sin(2 * np.pi * 5 * np.arange(m) / SR)))
            s = sum(a * np.sin(k * ph) for k, a in enumerate([1, 0.7, 0.5, 0.35, 0.2, 0.1], 1))
            place(y, fade(lp(s, 1400) * env_ad(m, 0.06, L, 0.4), 0.01, 0.08) * 0.5, at)
        y = reverb(y, rng, 0.5, 0.3)
    elif kind == "spawn":
        # silly burst: puff of dirt, a few comic pops, then a squabbling clump of groans
        place(y, boom(rng, 0.6, 70) * 0.3, 0.0)
        for i in range(5):
            place(y, pop_blip(rng, rng.uniform(250, 600), 0.09, 1.6) * 0.5, 0.05 + i * rng.uniform(0.05, 0.09))
        for _ in range(5):
            g = zombie(rng, rng.uniform(0.8, 1.5), rng.uniform(95, 170), str(rng.choice(["chase", "idle"])))
            place(y, fade(g, 0.02, 0.15) * rng.uniform(0.5, 0.7), rng.uniform(0.25, 0.8))
        y = reverb(y, rng, 0.3, 0.2)
    else:  # defeated: cheerful major flourish with a sparkle and a tiny 'ta-da'
        place(y, fade(fanfare(rng, dur * 0.8, f), 0.002, 0.35), 0.0)
        for i, r in enumerate([2.0, 2.5]):
            place(y, fade(chime_note(rng, f * r * 2, 0.6, 0.25, 0.4), 0.001, 0.2) * 0.35, 0.55 + 0.12 * i)
    return S_(fade(y[:n], 0.002, 0.35 if kind == "defeated" else 0.15))


def door_swing(rng, dur, f, act, heavy=False):
    """Door-swing SFX timed to the swing animation (doors ~312 ms, clan gates ~455 ms).
    open:  latch click, then a hinge creak whose pitch rises as the leaf speeds up and eases out at the stop.
    close: a short falling creak, the leaf meeting the frame (thud) and the latch dropping in (click).
    heavy (clan gates): lower, slower creak with iron strap rattle and a deeper thump."""
    n = n_(dur)
    y = np.zeros(n)
    if act == "open":
        place(y, click(rng, 0.05, rng.uniform(1100, 1500) * (0.7 if heavy else 1.0)) * 0.5, 0.0)
        cd = dur * 0.85
        c = creak(rng, cd, f * rng.uniform(0.92, 1.08))
        m = n_(cd)
        c *= np.linspace(0.6, 1.0, m) ** 0.5 * np.minimum(1.0, np.linspace(1.6, 0.0, m) + 0.25)
        place(y, c * 0.9, 0.03)
        if heavy:
            place(y, grains(rng, dur * 0.7, 10, 1500, 4500, 0.006, spread=dur * 0.5, decay=0.05) * 0.35, 0.05)
            place(y, wood_knock(rng, 140, 0.25, 0.05) * 0.35, dur * 0.82)
        else:
            place(y, wood_knock(rng, 320, 0.12, 0.02) * 0.2, dur * 0.8)
        return y
    cd = dur * (0.45 if heavy else 0.4)
    c = creak(rng, cd, f * rng.uniform(2.2, 2.8) if not heavy else f * rng.uniform(1.8, 2.2))
    place(y, c * np.linspace(1.0, 0.5, n_(cd)) * 0.55, 0.0)
    hit = cd * 0.9
    place(y, thud(rng, dur - hit, f * rng.uniform(0.9, 1.1)) * (1.0 if heavy else 0.9), hit)
    if heavy:
        place(y, clank(rng, min(0.3, dur - hit), 420) * 0.35, hit + 0.01)
    place(y, click(rng, 0.05, rng.uniform(1300, 1700)) * 0.4, hit + rng.uniform(0.05, 0.08))
    return y


# ---------------------------------------------------------------- mounts (rideable animals)

def hoof(rng, dur, f, surface="generic"):
    """One hoof strike for ridden mounts, per footstep ground type (grass/sand/wood/stone/dirt/water + generic).
    A hoof is a hard keratin clop on top of a heavy low body thump - deeper and harder than a footstep."""
    n = n_(dur)
    y = np.zeros(n)
    body = thump(rng, rng.uniform(55, 75), min(dur, 0.16), 0.045, 1.9) * 0.9
    if surface == "grass":
        s = body + grit(rng, 0.12, 1500, 6000, 0.03) * 0.5 + grains(rng, 0.12, 20, 2500, 6500, 0.006) * 0.45
        s += wood_knock(rng, f * rng.uniform(0.9, 1.1), 0.06, 0.008) * 0.15
    elif surface == "sand":
        s = body * 0.8 + grains(rng, 0.18, 70, 1200, 5000, 0.006, spread=0.12, decay=0.05) * 0.8 + lp(grit(rng, 0.18, 300, 2500, 0.05), 2500) * 0.5
    elif surface == "wood":
        s = body * 0.7 + wood_knock(rng, f * rng.uniform(0.9, 1.15), 0.2, 0.05) * 1.0 + click(rng, 0.04, f * 4.0) * 0.25
    elif surface == "stone":
        s = body * 0.6 + stone_tap(rng, f * rng.uniform(0.85, 1.15), 0.12) * 0.9 + click(rng, 0.05, f * 1.6) * 0.35
        s += grains(rng, 0.1, 8, 3000, 8000, 0.004) * 0.25
    elif surface == "dirt":
        s = body + lp(grit(rng, 0.14, 200, 2500, 0.03), 2500) * 0.8 + grains(rng, 0.12, 14, 1200, 3500, 0.006) * 0.4
    elif surface == "water":
        m = n_(dur)
        s = body * 0.5 + bp(noise(rng, m), 400, 3500) * env_exp(m, 0.06, 0.003) * 0.9
        for _ in range(rng.integers(5, 9)):
            place(s, bubble(rng, rng.uniform(350, 1200)) * 0.3, rng.uniform(0.01, dur * 0.6))
    else:
        s = body + lp(grit(rng, 0.12, 250, 3000, 0.025), 3000) * 0.6 + wood_knock(rng, f, 0.08, 0.012) * 0.3
    place(y, s, 0.0)
    return S_(lp(y, 9000))


def tack_jingle(rng, dur, f=2400, count=4):
    """Little buckle / ring jingles from the bridle and saddle hardware."""
    y = np.zeros(n_(dur))
    for _ in range(count):
        place(y, metal_tink(rng, f * rng.uniform(0.8, 1.3), 0.18, 0.04, 7000) * rng.uniform(0.15, 0.35), rng.uniform(0, dur * 0.8))
    return y


def mount_rider(rng, dur, f, act="mount"):
    """mount: boot into the stirrup (creak), body swing (cloth whoosh), settling into the saddle (leather creak +
    soft heavy thump), a happy little animal snort-blow.  dismount: saddle creak as weight leaves, cloth whoosh,
    two boots landing (thump + dirt grit), tack jingle."""
    n = n_(dur)
    y = np.zeros(n)
    if act == "mount":
        place(y, creak(rng, 0.18, f * rng.uniform(0.9, 1.1)) * 0.5, 0.0)
        place(y, whoosh_core(rng, 0.3, rng.uniform(700, 1000), 1.6, 0.5) * 0.9, 0.08)
        place(y, creak(rng, 0.3, f * rng.uniform(0.6, 0.75)) * 0.75, 0.32)
        place(y, thump(rng, rng.uniform(70, 90), 0.22, 0.06) * 0.8, 0.34)
        place(y, tack_jingle(rng, 0.35, 2400, 4), 0.34)
        m = n_(0.22)  # snort: breathy filtered noise burst
        place(y, bp(noise(rng, m), 500, 2500) * env_bell(m, 0.2, 1.5) * 0.35, min(dur - 0.24, 0.5))
    else:
        place(y, creak(rng, 0.22, f * rng.uniform(0.7, 0.85)) * 0.6, 0.0)
        place(y, whoosh_core(rng, 0.28, rng.uniform(800, 1100), 1.6, 0.45) * 0.8, 0.06)
        for k, at in enumerate((0.3, 0.3 + rng.uniform(0.04, 0.07))):
            place(y, thump(rng, rng.uniform(85, 110), 0.14, 0.035) * (0.8 if k == 0 else 0.55), at)
            place(y, lp(grit(rng, 0.1, 250, 2500, 0.02), 2500) * 0.4, at)
        place(y, tack_jingle(rng, 0.3, 2600, 3), 0.28)
    return S_(y)


def gallop_loop(rng, dur, f, stride=0.5):
    """Seamless gallop loop synced to the mount gallop anim (6 frames @ 12 fps = one 500 ms stride): a four-beat
    hoof pattern (hind-hind-fore-fore, then the suspension gap) on dirt/grass, a breath every stride and tack jingle."""
    n = n_(dur)
    y = np.zeros(n)

    def put(src, at, gain=1.0):
        if at < dur - 0.002:
            place(y, src, max(0.0, at), gain)
    beats = (0.0, 0.085, 0.2, 0.27)
    t = 0.0
    while t < dur:
        for k, b in enumerate(beats):
            at = t + b + rng.uniform(-0.006, 0.006)
            put(hoof(rng, 0.16, f, "dirt" if k % 2 == 0 else "grass") * (0.85 + 0.15 * (k >= 2)), at)
        m = n_(0.2)
        put(bp(noise(rng, m), 300, 1800) * env_bell(m, 0.3, 1.4) * 0.12, t + 0.32)
        put(tack_jingle(rng, 0.2, 2500, 2) * 0.6, t + 0.2)
        t += stride
    return S_(y)
