"""Targeted packer: swap the re-rendered vehicle art (build.py + split_facings.py output) into an existing
manifest.vehicles.json without touching anything else (camper interior atlas + sprites, sounds, vfx, tint sets).

    python3 merge_parts.py <build_out_dir> <pack/vehicles dir>

- deletes the pack's old veh_art_* files (PNG, @2x, masks, KTX2), copies the new veh_art_* files from <build_out_dir>/atlases
- atlases: new veh_art_* entries (build order) + the pack's non-veh_art atlases; sprites: new vehicle sprites (paint tint
  copied from the shipped sprite of the same key) + the pack's other sprites; vehicles meta: new
- fails if any sprite or vehicle key would be added or lost (ids.lock stays valid).
Then: oxipng the new PNGs, python3 ../../tools/ktx2.py <pack>/manifest.vehicles.json (KTX2 twins), pnpm art:shard-manifest."""
import sys, os, json, glob, shutil
OUT, PACK = sys.argv[1], sys.argv[2]
mp = os.path.join(PACK, "manifest.vehicles.json"); man = json.load(open(mp))
part = json.load(open(os.path.join(OUT, "_vehicles_part.json")))
old_s = {s["key"]: s for s in man["sprites"]}
veh_keys = [s["key"] for s in man["sprites"] if s["atlas"].startswith("veh_art_")]
assert [s["key"] for s in part["sprites"]] == veh_keys, "vehicle sprite keys changed"
assert [v["key"] for v in part["meta"]] == [v["key"] for v in man["vehicles"]], "vehicle meta keys changed"
for f in glob.glob(os.path.join(PACK, "atlases", "veh_art_*")): os.remove(f)
for f in glob.glob(os.path.join(OUT, "atlases", "veh_art_*")): shutil.copy2(f, os.path.join(PACK, "atlases", os.path.basename(f)))
sprites = []
for sp in part["sprites"]:
    t = old_s[sp["key"]].get("tints"); sprites.append({**sp, **({"tints": t} if t else {})})
man["atlases"] = part["atlases"] + [a for a in man["atlases"] if not a["key"].startswith("veh_art_")]
man["sprites"] = sprites + [s for s in man["sprites"] if not s["atlas"].startswith("veh_art_")]
man["vehicles"] = part["meta"]
used = {s["atlas"] for s in man["sprites"]} | {d["atlas"] for s in man["sprites"] for a in s["animations"].values() for d in a.get("dirFrames", [])}
assert used == {a["key"] for a in man["atlases"]}, ("unreferenced / missing atlases", used ^ {a["key"] for a in man["atlases"]})
for a in man["atlases"]:
    for p in [a["image"]] + [pg["image"] for pg in a.get("pages", [])] + [v for v in (a.get("masks") or {}).values() if isinstance(v, str)]:
        assert os.path.exists(os.path.join(PACK, p)), p
json.dump(man, open(mp, "w"), separators=(",", ":"))
print(len(man["atlases"]), "atlases,", len(man["sprites"]), "sprites,", os.path.getsize(mp), "bytes")
