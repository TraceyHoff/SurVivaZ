#!/usr/bin/env python3
"""SurVivaZ audio builder (ADR-117). Procedurally synthesizes every recording listed in docs/AUDIO_ASSETS.md
(no samples), writes packages/assets/pack/audio/<dir>/<key_with_underscores>_<n>.ogg (+ .m4a), then you run
`node scripts/gen-audio-bank.mjs`. Deterministic: each variant is seeded from md5(key#n).

  python3 assets/audio/tools/build.py --group footsteps|combat|zombies|ui|ambience|music|rest|all [-j 8]
Requires: python3 numpy scipy pyloudnorm, ffmpeg with libopus + aac.  WAV masters go to $AUDIO_MASTERS (default
/tmp/survivaz_audio_masters, not shipped)."""
import argparse, hashlib, json, os, re, subprocess, sys
from multiprocessing import Pool
import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(__file__))
from dsp import *  # noqa
import sfx as S
import amb as A

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "packages/assets/pack/audio")
MASTERS = os.environ.get("AUDIO_MASTERS", "/tmp/survivaz_audio_masters")
DIRS = {"sfx": "sfx", "ui": "ui", "ambient": "ambience", "music": "music", "voice": "voice"}
GROUPS = ["footsteps", "combat", "zombies", "ui", "ambience", "music", "rest"]


def group_of(key, bus):
    if key.startswith("footstep"):
        return "footsteps"
    if key.startswith(("combat.", "weapon.", "explosion", "explosive.")):
        return "combat"
    if key.startswith("zombie."):
        return "zombies"
    if bus == "ui":
        return "ui"
    if key.startswith(("weather.", "amb.")):
        return "ambience"
    if key.startswith("music."):
        return "music"
    return "rest"


def table():
    bank = json.load(open(os.path.join(ROOT, "apps/client/src/audio/bank.json")))["sounds"]
    rows = []
    for line in open(os.path.join(ROOT, "docs/AUDIO_ASSETS.md")):
        m = re.match(r"^\| `([^`]+)` \| (\w+) \| ([\w-]+) \| (\d+) \| ([^|]+) \|", line)
        if not m:
            continue
        key, bus, typ, var, ln = m.groups()
        ln = ln.strip()
        sec = float(ln[:-3]) / 1000 if ln.endswith("ms") else float(ln[:-2])
        b = bank[key]
        rows.append(dict(key=key, bus=bus, loop=typ == "loop", variants=int(var), dur=sec, recipe=b["synth"]["r"], f=b["synth"]["f"]))
    return rows


def seed(key, i):
    return int(hashlib.md5(f"{key}#{i}".encode()).hexdigest()[:8], 16)


HEAVY = {"fists": 0.3, "blunt": 0.8, "axe": 0.6, "pickaxe": 0.7, "shovel": 0.6, "blade": 0.0, "spear": 0.1}


def render_sfx(r, rng):
    key, f, dur, rec = r["key"], float(r["f"]), r["dur"], r["recipe"]
    p = key.split(".")
    if key == "footstep.water":
        return S.splash(rng, dur, f, "water")
    if key == "footstep.swim":
        return S.splash(rng, dur, f, "swim")
    if p[0] == "footstep":
        return S.footstep(rng, dur, f, p[1] if len(p) > 1 else "generic")
    if p[0] == "combat":
        if p[1] == "swing":
            return S.swing(rng, dur, f, HEAVY.get(p[2], 0.3))
        if p[1] == "punch":
            return S.smack(rng, dur, f, "punch")
        if key == "combat.hit.structure":
            return S.thud(rng, dur, 200, "wood") * 0.7 + S.clank(rng, dur, 500) * 0.4
        return S.smack(rng, dur, f, p[2] if len(p) > 2 else "hit")
    if p[0] == "weapon":
        if p[1] == "fire":
            if p[2] in ("bow", "crossbow"):
                return S.twang(rng, dur, f, p[2])
            if p[2] == "sling":
                return S.swing(rng, dur, f, 0.0) + S.click(rng, dur, 900) * 0.3
            return S.gunshot(rng, dur, f, p[2])
        if p[1] == "draw":
            return S.creak(rng, dur, f)
        if p[1] == "reload":
            return S.reload(rng, dur, f, p[2])
        if p[1] == "dry":
            return S.click(rng, dur, f)
        if p[1] == "throw":
            return S.swing(rng, dur, f, 0.2)
    if key.startswith("explosion"):
        if key == "explosion.debris":
            return S.rustle(rng, dur, f, "debris")
        return S.boom(rng, dur, f, key.endswith("fire"))
    if key == "explosive.fuse":
        return S.sizzle(rng, dur, f)
    if p[0] == "zombie":
        if p[1] == "snuffer":
            k = p[2]
            if k in ("chase", "attack", "hurt"):
                return S.shriek(rng, dur, f, k)
            return S.snuff(rng, dur, f, {"idle": "sniff", "death": "death", "snuff": "blow"}[k])
        return S.zombie(rng, dur, f, p[2])
    if p[0] == "player":
        return S.player(rng, dur, f, {"hurt": "hurt", "death": "death", "exhausted": "exhausted"}.get(p[1], "cold") if len(p) == 2 else "cold")
    if p[0] == "animal":
        if p[1] == "attack":
            return S.animal(rng, dur, f, "growl", "attack")
        return S.animal(rng, dur, f, rec, p[2])
    if p[0] == "gather":
        k = p[1]
        return {"chop": lambda: S.chop(rng, dur, f), "tree_fall": lambda: S.tree_fall(rng, dur, f), "mine": lambda: S.clank(rng, dur, f, "mine"),
                "rock_break": lambda: S.rustle(rng, dur, f, "rock"), "dig": lambda: S.dig(rng, dur, f),
                "harvest": lambda: S.rustle(rng, dur, f, "harvest"), "pick": lambda: S.rustle(rng, dur, f, "pick")}[k]()
    if key == "item.pickup":
        return S.pop(rng, dur, f, True)
    if key == "item.drop":
        return S.thud(rng, dur, f, "drop")
    if p[0] == "build":
        if p[1] == "place":
            m = p[2] if len(p) > 2 else "wood"
            return S.clank(rng, dur, f) if m == "metal" else S.thud(rng, dur, f, m)
        if p[1] == "break":
            return S.rustle(rng, dur, f, p[2] if len(p) > 2 else "generic_break")
        if p[1] == "repair":
            return S.clank(rng, dur, f, "repair")
        if p[1] == "ghost_invalid":
            return S.tick(rng, dur, f, "invalid")
    if key == "craft.start":
        return S.rustle(rng, dur, f, "craft")
    if key == "craft.loop":
        n = n_(dur)
        y = np.zeros(n)
        beat = dur / 8
        for i in range(8):  # whittle-whittle-tap
            if i % 4 == 3:
                place(y, S.wood_knock(rng, rng.uniform(280, 340), 0.2, 0.04) * 0.8, i * beat)
            else:
                place(y, S.grit(rng, beat * 0.8, 1500, 5000, beat / 3) * 0.5, i * beat + rng.uniform(0, 0.02))
        return loop_fold(np.pad(y, (0, n_(0.5))), n)
    if key in ("craft.complete", "cook.complete", "farm.grow"):
        notes = {"craft.complete": (1.0, 1.25, 1.5), "cook.complete": (1.0, 1.0), "farm.grow": (1.0, 1.5, 2.0)}[key]
        return S.chime(rng, dur, f, notes)
    if key == "cook.sizzle":
        return S.sizzle(rng, dur, f)
    if key == "fire.ignite":
        return S.ignite(rng, dur, f)
    if key in ("fire.crackle", "fire.burning"):
        return S.crackle_bed(rng, dur, stereo=True)
    if key == "fire.extinguish":
        return S.sizzle(rng, dur, f, "steam")
    if key == "fire.snuffed":
        return S.snuff(rng, dur, f, "fire")
    if p[0] in ("door", "container"):
        act = p[1]
        if key == "door.locked":
            n = n_(dur)
            y = np.zeros(n)
            for t in (0.0, 0.07, 0.15):
                place(y, S.click(rng, 0.05, f * rng.uniform(0.8, 1.2)) * 0.6 + S.wood_knock(rng, 300, 0.05, 0.01) * 0.3, t)
            return y
        if len(p) > 2 and p[2] in ("swing", "gate"):
            return S.door_swing(rng, dur, f, act, p[2] == "gate")
        metal = len(p) > 2 and p[2] == "metal"
        if act == "open":
            y = S.creak(rng, dur, f)
            return y + (S.click(rng, dur, 1500) * 0.4 if metal else S.wood_knock(rng, 350, dur, 0.02) * 0.3)
        if act == "close":
            return S.clank(rng, dur, f) if metal else S.thud(rng, dur, f)
    if key == "consume.eat":
        return S.crunch(rng, dur, f)
    if key == "consume.drink":
        return S.gulp(rng, dur, f)
    if p[0] == "vehicle":
        if p[1] == "engine":
            return S.engine_start(rng, dur, f, p[2] == "stop")
        if p[1] in ("car", "truck", "van", "camper", "semi"):
            return S.engine(rng, dur, f)
        if p[1] == "horn":
            return S.horn(rng, dur, f, len(p) > 2)
        if p[1] == "door":
            return S.click(rng, dur, f) * 0.6 + S.creak(rng, dur, 700) * 0.3 if p[2] == "open" else S.thud(rng, dur, f)
        if p[1] == "skid":
            return S.rustle(rng, dur, f, "skid")
        if p[1] == "crash":
            return S.clank(rng, dur, f, "crash")
        if p[1] == "bicycle":
            return {"ride": lambda: S.chain(rng, dur, f), "bell": lambda: S.bell(rng, dur, f), "mount": lambda: S.click(rng, dur, f) + S.thud(rng, dur, 200) * 0.4}[p[2]]()
        if p[1] == "headlights":
            return S.click(rng, dur, f)
    if key == "turret.fire":
        return S.twang(rng, dur, f, "turret")
    if key == "turret.fire.gun":
        return S.gunshot(rng, dur, f, "turret")
    if key == "trap.snap":
        return S.clank(rng, dur, f, "snap")
    if key == "trap.spike":
        return S.smack(rng, dur, f, "spike")
    if key == "farm.till":
        return S.dig(rng, dur, f)
    if key == "farm.water":
        return S.splash(rng, dur, f, "pour")
    if key in ("farm.plant", "farm.fertilize"):
        return S.rustle(rng, dur, f, "plant" if key == "farm.plant" else "")
    if p[0] in ("ui", "horde"):
        return render_ui(key, rng, dur, f)
    raise KeyError(key)


def render_ui(key, rng, dur, f):
    if key.startswith("horde."):
        return S.horde(rng, dur, f if f > 200 else 523.25, key.split(".")[1])
    k = key[3:]
    if k == "click":
        return S.pop_blip(rng, f * rng.uniform(0.6, 0.7), dur, 1.5) * 0.7 + S.click(rng, dur, f) * 0.4
    if k == "hover":
        return S.tick(rng, dur, f * rng.uniform(0.9, 1.1))
    if k in ("open", "close"):
        n = n_(dur)
        y = S.whoosh_core(rng, dur, f, 2.5, 0.4 if k == "open" else 0.6) * 0.8
        b = S.pop_blip(rng, 700 if k == "open" else 900, dur * 0.6, 1.6 if k == "open" else 0.6)
        y[:len(b)] += b[:n] * 0.4
        return y
    if k == "back":
        return S.tick(rng, dur, f, "back")
    if k == "error":
        return S.tick(rng, dur, f, "error")
    if k == "slider":
        return S.tick(rng, dur, f)
    if k == "levelup":
        return S.fanfare(rng, dur, f)
    if k == "notify":
        return S.chime(rng, dur, f, (1.0, 1.5) if rng.random() < 0.5 else (1.0, 1.335))
    if k == "toast.warn":
        return S.chime(rng, dur, f, (1.0, 0.84))
    if k in ("chat", "craft_queue"):
        return S.pop(rng, dur, f)
    if k == "headlights":
        return S.click(rng, dur, f)
    raise KeyError(key)


def post(r, y):
    """Shape/normalize. Returns (audio, kind) kind in fx|loopmono|loopst|music."""
    loop, bus = r["loop"], r["bus"]
    y = np.nan_to_num(np.asarray(y, float))
    if bus == "music":
        return y, "music"
    stereo = y.ndim == 2
    if loop:
        L = n_(r["dur"])
        if len(y) > L:
            y = loop_xfade(y, L, min(n_(1.0), len(y) - L)) if len(y) - L > n_(0.05) else y[:L]
        y = y - np.mean(y, 0)
        # loops are circular: start at the quietest 10 ms so the codec's start-of-stream error is inaudible
        e = (y ** 2).reshape(len(y), -1).sum(1)
        w = n_(0.01)
        rms = np.convolve(np.concatenate([e, e[:w]]), np.ones(w), "valid")[: len(y)]
        y = np.roll(y, -int(np.argmin(rms) + w // 2), axis=0)
        y = norm_peak(y, -1.5)
        return y, ("loopst" if stereo else "loopmono")
    if stereo:
        y = y.mean(1)
    y = y - np.mean(y)
    y = lp(y, 11000)  # soft-edged top end
    y = trim_lead(y)
    tgt = n_(r["dur"] * 1.15)
    y = y[:tgt]
    y = fade(y, 0.002, min(0.03, len(y) / SR / 5))
    return norm_peak(y, -1.5), "fx"


BR = {"fx": ("32k", "48k", 1), "loopmono": ("40k", "48k", 1), "loopst": ("64k", "80k", 2), "music": ("96k", "96k", 2)}


def encode(wav, base, kind):
    ob, ab, ch = BR[kind]
    common = ["ffmpeg", "-v", "error", "-y", "-i", wav, "-map_metadata", "-1", "-ac", str(ch)]
    subprocess.run(common + ["-c:a", "libopus", "-b:a", ob, "-vbr", "on", "-application", "audio", "-ar", "48000", base + ".ogg"], check=True)
    subprocess.run(common + ["-c:a", "aac", "-b:a", ab, "-ar", "48000", "-movflags", "+faststart", base + ".m4a"], check=True)


SFX_AMB = ("fire.crackle", "fire.burning")  # ambient-bus loops rendered by sfx recipes


def job(args):
    r, i = args
    rng = np.random.default_rng(seed(r["key"], i))
    if r["bus"] == "music" or r["key"] == "music.stinger.dawn":
        import music as M
        y = M.render(r["key"], i, rng, r["dur"])
    elif r["bus"] == "ambient" and r["key"] not in SFX_AMB:
        y, _ = A.render_amb(r["key"], rng, r["dur"], float(r["f"]))
    else:
        y = render_sfx(r, rng)
        if r["loop"]:
            y = y  # recipes render dur; post() handles crossfade if longer
    if r["loop"] and r["bus"] != "music" and len(y) <= n_(r["dur"]) + 10:
        # recipes that rendered exactly dur: re-render longer for crossfade
        r2 = dict(r, dur=r["dur"] + 1.0)
        rng = np.random.default_rng(seed(r["key"], i))
        y = render_sfx(r2, rng) if r["bus"] != "ambient" or r["key"] in SFX_AMB else A.render_amb(r["key"], rng, r["dur"] + 1.0, float(r["f"]))[0]
    y, kind = post(r, y)
    name = r["key"].replace(".", "_") + f"_{i}"
    d = DIRS[r["bus"]] if r["key"] != "music.stinger.dawn" else "music"
    os.makedirs(os.path.join(MASTERS, d), exist_ok=True)
    os.makedirs(os.path.join(OUT, d), exist_ok=True)
    wav = os.path.join(MASTERS, d, name + ".wav")
    wavfile.write(wav, SR, y.astype(np.float32))
    encode(wav, os.path.join(OUT, d, name), kind)
    if kind != "music":  # opus can overshoot a little: pull gain down until the *decoded* peak is <= -1 dBFS
        for _ in range(4):
            raw = subprocess.run(["ffmpeg", "-v", "error", "-i", os.path.join(OUT, d, name) + ".ogg", "-f", "f32le", "-"], capture_output=True).stdout
            pk = 20 * np.log10(np.abs(np.frombuffer(raw, np.float32)).max() + 1e-12)
            if pk <= -1.0:
                break
            y = y * 10 ** ((-1.3 - pk) / 20)
            wavfile.write(wav, SR, y.astype(np.float32))
            encode(wav, os.path.join(OUT, d, name), kind)
    return f"{d}/{name}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="all")
    ap.add_argument("--key", default=None, help="regex filter on keys")
    ap.add_argument("-j", type=int, default=os.cpu_count())
    a = ap.parse_args()
    rows = table()
    for r in rows:
        if r["key"] == "music.stinger.dawn":
            r["bus"] = "music"
    sel = [r for r in rows if (a.group == "all" or group_of(r["key"], r["bus"]) == a.group) and (not a.key or re.search(a.key, r["key"]))]
    jobs = [(r, i) for r in sel for i in range(1, r["variants"] + 1)]
    with Pool(a.j) as p:
        for k, out in enumerate(p.imap_unordered(job, jobs)):
            pass
    print(f"{a.group}: {len(sel)} keys, {len(jobs)} recordings")


if __name__ == "__main__":
    main()
