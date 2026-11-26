import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadManifest, mergeManifests, CATEGORIES, type ManifestJson } from "../src/index.js";
import { readManifestJson } from "../src/node.js";

// Real art pack (Cozy-Wild wave 1). Source of truth: assets/ (repo root) (tools/build_all.py).
const dir = fileURLToPath(new URL("../pack/", import.meta.url));
const sampleDir = fileURLToPath(new URL("../sample/", import.meta.url));
const pack = JSON.parse(readFileSync(dir + "manifest.json", "utf8"));
const lockFile = JSON.parse(readFileSync(dir + "ids.lock.json", "utf8"));
const sampleLock = JSON.parse(readFileSync(sampleDir + "ids.lock.json", "utf8"));
const pngSize = (f: string) => { const b = readFileSync(dir + f); expect(b.subarray(1, 4).toString()).toBe("PNG"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

describe("art pack", () => {
  const { registry } = loadManifest(pack, { lock: lockFile });
  // ids.lock.json covers the merged runtime manifest (pack + sub-manifests, as apps/client/src/view.ts loads it).
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const subs = [["ui-kit", root + "assets/ui/kit/manifest.ui.kit.json"], ["branding", root + "assets/ui/branding/manifest.branding.json"], ["customization", dir + "customization/manifest.customization.json"], ["vehicles", dir + "vehicles/manifest.vehicles.json"], ["items", dir + "items/manifest.items.json"], ["vehicle_items", dir + "vehicle_items/manifest.vehicle_items.json"], ["building", dir + "building/manifest.building.json"], ["nature", dir + "nature/manifest.nature.json"], ["task34", dir + "task34/manifest.task34.json"], ["task256", dir + "task256/manifest.task256.json"], ["task540", dir + "task540/manifest.task540.json"]];
  const merged = mergeManifests([{ name: "pack", manifest: pack as ManifestJson }, ...subs.filter(([, f]) => existsSync(f!)).map(([name, f]) => ({ name: name!, manifest: readManifestJson(f!) as ManifestJson }))]);
  const { lock } = loadManifest(merged.manifest, { lock: lockFile });
  it("sub-manifests do not duplicate pack keys", () => expect(merged.collisions).toEqual([]));
  it("loads, covers every category, lock is up to date", () => {
    for (const c of CATEGORIES) expect(registry.byCategory(c).length).toBeGreaterThan(0);
    expect(lock).toEqual(lockFile);
  });
  it("ADR-264: Soil owns a dedicated item frame, not an existing resource fallback", () => {
    const soil = pack.sprites.find((s: { key: string }) => s.key === "soil");
    expect(soil).toMatchObject({ category: "item", atlas: "items", animations: { idle: { frames: [49] } } });
    expect(soil.placeholder).toBeUndefined();
    for (const key of ["clay", "sand"]) {
      const other = pack.sprites.find((s: { key: string }) => s.key === key);
      expect(other.animations.idle.frames).not.toEqual(soil.animations.idle.frames);
    }
    expect(registry.byKey("soil").id).toBe(lockFile.sprites.soil);
    const tp = JSON.parse(readFileSync(dir + "atlases/items.json", "utf8"));
    expect(tp.frames.soil).toMatchObject({ index: 49, frame: { x: 32, y: 192, w: 32, h: 32 } });
  });
  it("keeps every sample key and id stable", () => {
    for (const [ns, keys] of Object.entries(sampleLock as Record<string, Record<string, number>>))
      for (const [k, id] of Object.entries(keys)) expect((lock as Record<string, Record<string, number>>)[ns]![k]).toBe(id);
  });
  it("atlas PNGs (and emissive pages) match the grid; sound files exist", () => {
    for (const a of registry.atlases.values()) {
      expect(pngSize(a.image)).toEqual({ w: a.frameW * a.columns, h: a.frameH * a.rows });
      if (a.emissiveImage) expect(pngSize(a.emissiveImage)).toEqual(pngSize(a.image));
    }
    for (const s of registry.sounds.values()) for (const f of s.files) expect(existsSync(dir + f)).toBe(true);
  });
  it("building sprites: 4 damage stages, mirror/unique4 rotation art", () => {
    for (const s of pack.sprites.filter((x: { building?: unknown }) => x.building)) {
      expect(["mirror", "unique4"]).toContain(s.rotationArt);
      if (s.rotationArt === "unique4") expect(s.building.frames.length).toBe(4); // may repeat rows: [r0,r1,r0,r1] keeps axis, no flip
      else expect(s.building.frames.length).toBeLessThanOrEqual(2); // true mirror: rot 2/3 = rows 0/1 + flipX
      const id = registry.id(s.key);
      for (let r = 0; r < 4; r++) for (let st = 0; st < 4; st++) expect(registry.buildingFrame(id, r, st).w).toBe(128);
    }
  });
  it("schema9: critter category, door states, ambience loop points", () => {
    expect(registry.byCategory("critter").map((s) => s.key)).toContain("critter_bunny");
    const door = registry.byKey("door");
    expect(door.building!.stateNames).toEqual(["closed", "open"]);
    expect(registry.buildingFrame(door.id, 1, 0, registry.stateIndex(door.id, "open")).frame).not.toBe(registry.buildingFrame(door.id, 1, 0).frame);
    expect(pack.sprites.some((s: { key: string }) => s.key === "door_open")).toBe(false);
    expect((lock as { sprites: Record<string, number> }).sprites["door_open"]).toBe(lockFile.sprites["door_open"]); // retired key keeps its id reserved
    for (const k of ["amb_campfire", "amb_rain", "amb_forest"]) {
      const snd = [...registry.sounds.values()].find((s) => s.key === k)!;
      expect(snd.loop).toBe(true); expect(snd.loopPoints!.end).toBeGreaterThan(snd.loopPoints!.start);
    }
  });
  it("wave 2: survival_fx keys yielded (ids reserved), aliases, masks", () => {
    for (const k of ["campfire", "torch_stand", "lantern", "fireplace", "wood_stove"]) {
      expect(pack.sprites.some((s: { key: string }) => s.key === k)).toBe(false);
      expect((lock as { sprites: Record<string, number> }).sprites[k] ?? lockFile.sprites[k]).toBe(lockFile.sprites[k]);
    }
    expect((lock as { sprites: Record<string, number> }).sprites["campfire"]).toBe(4);
    for (const k of ["door", "door_wood", "stone_spear", "wooden_club", "storage_box", "chest"]) expect(registry.byKey(k)).toBeDefined();
    expect(registry.byKey("player").atlas.masks.sheen).toBeDefined();
  });
  it("characters and zombies have 8 baked directions", () => {
    for (const k of ["player", "player_b", "player_c", "zombie_walker", "zombie_brute", "zombie_runner", "zombie_mummy", "zombie_pumpkin"]) {
      const s = registry.byKey(k);
      for (const a of s.animList) expect(a.directions).toBe(8);
      const walk = s.animations.get("walk")!; expect(registry.frame(s.id, "walk", Math.PI / 2, 0).frame).toBe(walk.frames[0]! + 2 * walk.dirStride);
    }
  });
});

describe("vehicles sub-manifest", () => {
  const vdir = dir + "vehicles/";
  const vm = JSON.parse(readFileSync(vdir + "manifest.vehicles.json", "utf8"));
  const size = (f: string) => { const b = readFileSync(vdir + f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  it("atlases match their grid, 2x pages <= 2048, masks share the 1x layout", () => {
    for (const a of vm.atlases) {
      // native-size vehicle pages are padded to a multiple of 16 (mip/block aligned down the chain); @2x is optional
      const s1 = size(a.image), gw = a.frameW * a.columns, gh = a.frameH * a.rows;
      expect(s1.w - gw).toBeGreaterThanOrEqual(0); expect(s1.w - gw).toBeLessThan(16); expect(s1.h - gh).toBeGreaterThanOrEqual(0); expect(s1.h - gh).toBeLessThan(16);
      expect([s1.w % 16, s1.h % 16]).toEqual([0, 0]);
      expect(Math.max(s1.w, s1.h)).toBeLessThanOrEqual(2048);
      if (a.pages?.[0]) { const p2 = size(a.pages[0].image); expect(p2.w).toBeGreaterThanOrEqual(gw * 2); expect(p2.h).toBeGreaterThanOrEqual(gh * 2); expect(Math.max(p2.w, p2.h)).toBeLessThanOrEqual(2048); }
      for (const m of Object.values(a.masks) as string[]) expect(size(m)).toEqual(size(a.image));
    }
  });
  it("vehicles: 8 directions, snake_case attach, per-frame attach for every frame, lights + tow points", () => {
    const meta = new Map(vm.vehicles.map((v: { key: string }) => [v.key, v]));
    for (const s of vm.sprites.filter((x: { category: string }) => x.category !== "building")) {
      const v = meta.get(s.key) as { lights: { name: string; dirs: unknown[] }[]; family: string; states: string[] };
      expect(v).toBeDefined();
      for (const st of v.states) { expect(s.animations[st].directions).toBe(8); for (let d = 0; d < 8; d++) expect(s.frameAttach[String(s.animations[st].frames[0] + d)]).toBeDefined(); }
      for (const am of Object.values(s.frameAttach) as Record<string, unknown>[]) for (const n of Object.keys(am)) expect(n).toMatch(/^[a-z0-9_]+$/);
      if (v.family === "trailer" || (v.family === "camper" && !s.attach.driver)) expect(s.attach.hitch).toBeDefined(); else if (v.family !== "bicycle") { expect(s.attach.tow_hitch).toBeDefined(); expect(s.attach.driver).toBeDefined(); expect(s.attach.exhaust).toBeDefined(); }
      for (const l of v.lights) { expect(l.dirs.length).toBe(8); expect(s.attach[l.name]).toBeDefined(); }
    }
    for (const s of vm.sounds) for (const f of s.files) expect(existsSync(dir + f)).toBe(true);
  });
});

describe("vehicle_items sub-manifest", () => {
  const vdir = dir + "vehicle_items/";
  const vm = JSON.parse(readFileSync(vdir + "manifest.vehicle_items.json", "utf8"));
  const size = (f: string) => { const b = readFileSync(vdir + f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  it("atlases match their grid, 2x pages <= 2048", () => {
    for (const a of vm.atlases) {
      expect(size(a.image)).toEqual({ w: a.frameW * a.columns, h: a.frameH * a.rows });
      const p2 = size(a.pages[0].image); expect(p2).toEqual({ w: a.frameW * a.columns * 2, h: a.frameH * a.rows * 2 }); expect(Math.max(p2.w, p2.h)).toBeLessThanOrEqual(2048);
    }
  });
  it("every ART_KEYS_VEHICLES item key has an icon; piece_garage has 4 rotations x 4 damage stages, tiers and a crack overlay", () => {
    const keys = new Set(vm.sprites.map((s: { key: string }) => s.key));
    const doc = readFileSync(fileURLToPath(new URL("../../gameplay/docs/ART_KEYS_VEHICLES.md", import.meta.url)), "utf8");
    for (const m of doc.matchAll(/`(item_[a-z0-9_]+|piece_[a-z0-9_]+)`/g)) expect(keys.has(m[1]!)).toBe(true);
    for (const k of ["piece_garage", "piece_garage_tier2", "piece_garage_tier3"]) {
      const s = vm.sprites.find((x: { key: string }) => x.key === k);
      expect(s.building.frames.length).toBe(4); for (const r of s.building.frames) expect(r.length).toBe(4);
      expect(s.building.crackOverlay).toBe("piece_garage_crack");
    }
  });
});

describe("nature sub-manifest: pets (ADR-145/146)", () => {
  const nm = JSON.parse(readFileSync(dir + "nature/manifest.nature.json", "utf8"));
  const sp = (k: string) => nm.sprites.find((x: { key: string }) => x.key === k);
  it("pet_trough has a local crack overlay with stage1..3 on a 3-frame atlas matching the trough frame size", () => {
    const t = sp("pet_trough"); expect(t.building.crackOverlay).toBe("pet_trough_crack");
    const c = sp("pet_trough_crack"); for (const st of ["stage1", "stage2", "stage3"]) expect(c.animations[st].frames.length).toBe(1);
    const a = nm.atlases.find((x: { key: string }) => x.key === c.atlas); const ta = nm.atlases.find((x: { key: string }) => x.key === t.atlas);
    expect([a.frameW, a.frameH, a.columns * a.rows]).toEqual([ta.frameW, ta.frameH, 3]);
  });
  it("the unused animals_small main-pack atlas is gone", () => {
    expect(JSON.parse(readFileSync(dir + "manifest.json", "utf8")).atlases.some((a: { key: string }) => a.key === "animals_small")).toBe(false);
  });
});

describe("building sub-manifest", () => {
  const bdir = dir + "building/";
  const bm = JSON.parse(readFileSync(bdir + "manifest.building.json", "utf8"));
  const size = (f: string) => { const b = readFileSync(bdir + f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  it("tier pages match their grid and are <= 2048", () => {
    for (const a of bm.atlases) { const s = size(a.image); expect(s).toEqual({ w: a.frameW * a.columns, h: a.frameH * a.rows }); expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(2048); }
  });
  it("every ART_KEYS_BUILDING.md key (and KEYS.md piece) has per-tier art with 4 damage stages, mirror or 4 unique rows, and the crack overlay", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../assets/building/KEYS.md", import.meta.url)), "utf8");
    const gdoc = readFileSync(fileURLToPath(new URL("../../gameplay/docs/ART_KEYS_BUILDING.md", import.meta.url)), "utf8");
    type B = { piece: string; frames: number[][]; crackOverlay: string; rotationArt?: string | undefined };
    const pieces = new Map<string, B>((bm.sprites as { building?: B; rotationArt?: string }[]).filter((s) => s.building).map((s): [string, B] => [s.building!.piece, { ...s.building!, rotationArt: s.rotationArt }]));
    const sec = doc.slice(doc.indexOf("## Piece keys"), doc.indexOf("## Damage"));
    const bare = [...new Set([...sec.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!))];
    const gkeys = [...new Set([...gdoc.matchAll(/`([a-z_]+@tier[1-4])`/g)].map((m) => m[1]!))];
    expect(gkeys.length).toBeGreaterThanOrEqual(104);
    const keys = [...new Set([...gkeys, ...bare.flatMap((k) => [1, 2, 3, 4].map((t) => `${k}@tier${t}`))])];
    for (const k of ["foundation_ramp", "floor_triangle"]) expect(pieces.has(k), k).toBe(true);
    for (const k of keys) {
      const b = pieces.get(k); expect(b, k).toBeDefined();
      expect(b!.frames.length).toBe(b!.rotationArt === "mirror" ? 1 : 4); for (const r of b!.frames) expect(r.length).toBe(4);
      expect(b!.crackOverlay).toBe("bld_crack");
    }
    expect(bm.sprites.find((s: { key: string }) => s.key === "bld_crack").animations.stage3).toBeDefined();
  });
});

describe("nature sub-manifest", () => {
  const ndir = dir + "nature/";
  const nm = JSON.parse(readFileSync(ndir + "manifest.nature.json", "utf8"));
  const size = (f: string) => { const b = readFileSync(ndir + f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  it("pages match their grid, are 16-aligned and <= 2048 (1x and @2x), with KTX2 twins", () => {
    for (const a of nm.atlases) {
      const s = size(a.image); expect(s).toEqual({ w: a.frameW * a.columns, h: a.frameH * a.rows });
      expect(s.w % 16).toBe(0); expect(s.h % 16).toBe(0);
      for (const p of a.pages ?? []) { const q = size(p.image); expect(q).toEqual({ w: s.w * p.scale, h: s.h * p.scale }); expect(Math.max(q.w, q.h)).toBeLessThanOrEqual(2048); expect(existsSync(ndir + p.ktx2)).toBe(true); }
      expect(existsSync(ndir + a.ktx2)).toBe(true);
      for (const m of Object.values<string>(a.masks ?? {})) expect(size(m)).toEqual(s);
    }
  });
  it("ships an icon for every ADR-110 sprite_fallbacks icon key (no duplicates across packs)", () => {
    const fb = JSON.parse(readFileSync(dir + "../../gameplay/data/sprite_fallbacks.json", "utf8"));
    const base = JSON.parse(readFileSync(dir + "manifest.json", "utf8"));
    const keys = new Set([...nm.sprites, ...base.sprites].map((s: { key: string }) => s.key));
    for (const k of Object.keys(fb.icons)) expect(keys.has(k), k).toBe(true);
    for (const s of nm.sprites) if (s.atlas === "nature_icons") expect(base.sprites.some((b: { key: string }) => b.key === s.key), s.key).toBe(false);
  });
  it("covers the ADR-110 resource keys it owns", () => {
    const keys = new Set(nm.sprites.map((s: { key: string }) => s.key));
    for (const k of ["pine_tree", "birch_tree", "maple_tree", "willow_tree", "palm_tree", "apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree",
      "raspberry_bush", "blackberry_bush", "strawberry_bush", "fiber_bush", "dry_shrub", "fallen_log", "mossy_log", "rotten_stump"]) expect(keys.has(k), k).toBe(true);
    for (const p of ["wheat", "corn", "potato", "carrot", "tomato", "pumpkin", "squash", "beans", "cabbage", "onion", "garlic", "cotton", "flax", "hemp", "herbs", "mushroom", "yarrow", "ginseng", "aloe"])
      for (const k of [`crop_${p}`, `crop_${p}_0`, `crop_${p}_1`, `crop_${p}_2`, `crop_${p}_3`]) expect(keys.has(k), k).toBe(true);
    for (const k of ["farm_soil", "fish_shoal", "clutter_pebbles", "clutter_reeds", "clutter_fern", "wild_wheat", "wild_aloe", "sapling_oak_tree_0", "sapling_peach_tree_2"]) expect(keys.has(k), k).toBe(true);
    for (const s of nm.sprites.filter((x: { key: string }) => /_(tree|bush)$/.test(x.key))) expect(s.sway, s.key).toBeDefined();
    for (const k of ["stag", "red_deer", "fox", "hare", "cow", "sheep", "goat", "duck", "turkey", "goose", "elk", "moose", "bear", "bison", "squirrel", "snake"]) {
      const sp = nm.sprites.find((x: { key: string }) => x.key === `animal_${k}`); expect(sp, k).toBeDefined();
      for (const an of ["idle", "walk", "run", "attack", "hit", "death", "swim"]) { expect(sp.animations[an]?.dirFrames?.length, `${k}.${an}`).toBe(sp.animations[an].frames.length * 8);
        for (const f of sp.animations[an].dirFrames) { expect(f.anchor.x).toBeGreaterThanOrEqual(0); expect(f.anchor.y).toBeLessThanOrEqual(1); } }
    }
  });
});

// The Canvas2D fallback renderer (237d6b3) reads atlas PNGs from the manifest; the GPU path reads the KTX2 twins.
describe("atlas PNG + KTX2 pairs in every pack manifest", () => {
  const manifests: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(dir + rel, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== "src" && e.name !== "node_modules") walk(rel + e.name + "/"); }
      else if (/^manifest.*\.json$/.test(e.name)) manifests.push(rel + e.name);
    }
  };
  walk("");
  it("finds the sub-manifests", () => { for (const p of ["items", "nature", "customization", "vehicles", "building"]) expect(manifests.some((m) => m.startsWith(p + "/"))).toBe(true); });
  for (const m of manifests) it(m, () => {
    const base = dir + m.slice(0, m.lastIndexOf("/") + 1);
    const atlases = (JSON.parse(readFileSync(dir + m, "utf8")).atlases ?? []) as { key: string; image: string; ktx2?: string; pages?: { image: string; ktx2?: string }[] }[];
    for (const a of atlases) for (const e of [a, ...(a.pages ?? [])]) {
      const tag = `${m} ${a.key} ${e.image}`;
      expect(e.image, tag).toMatch(/\.png$/);
      expect(existsSync(base + e.image), tag).toBe(true);
      expect(e.ktx2, tag).toBe(e.image.replace(/\.png$/, ".ktx2"));
      expect(existsSync(base + e.ktx2!), tag).toBe(true);
    }
  });
});

describe("bone/antler in-hand sprites", () => {
  const im = JSON.parse(readFileSync(dir + "items/manifest.items.json", "utf8")) as ManifestJson;
  it.each(["held_bone_knife", "held_bone_axe", "held_antler_pickaxe"])("%s", (k) => {
    const s = (im.sprites as any[]).find((x) => x.key === k);
    expect(s).toBeTruthy(); expect(s.category).toBe("equipment"); expect(s.anchor).toEqual({ x: 0.5, y: 0.75 });
    expect(s.animations.idle.directions).toBe(8); expect(s.animations.idle.dirStride).toBe(1);
  });
});
