#!/usr/bin/env node
/**
 * ADR-117: single source for the audio sound bank (apps/client/src/audio/bank.json) and the Art & Assets request list
 * (docs/AUDIO_ASSETS.md). Edit the table below, then `node scripts/gen-audio-bank.mjs`.
 * Row: [key, bus, loop(0/1), variants, targetSeconds, synth recipe, synth freq, volume, priority(0-100), maxVoices, existing files?]
 * Existing files are extensionless paths under art/pack/ (Art's current ogg placeholders); everything else falls back
 * to the procedural placeholder (`synth`) until real assets land. Keys are dotted; a missing key falls back to its
 * parent ("footstep.grass.run" -> "footstep.grass" -> "footstep"), then fails silently.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
const R = new URL("..", import.meta.url).pathname;
const fs = (base, n) => Array.from({ length: n }, (_, i) => `audio/${base}_${i + 1}`);
const ANIMALS = ["rabbit", "deer", "boar", "wolf", "chicken", "stag", "red_deer", "elk", "moose", "bear", "fox", "hare", "squirrel", "turkey", "duck", "goose", "goat", "sheep", "cow", "bison", "snake"];
const ARTANIMAL = new Set(["rabbit", "deer", "boar", "wolf", "chicken"]);
const animalVoice = { rabbit: ["squeal", 900], deer: ["squeal", 520], boar: ["growl", 160], wolf: ["howl", 380], chicken: ["chirp", 1400], stag: ["howl", 260], red_deer: ["howl", 240], elk: ["howl", 300], moose: ["growl", 110],
  bear: ["growl", 90], fox: ["squeal", 700], hare: ["squeal", 950], squirrel: ["chirp", 2200], turkey: ["chirp", 600], duck: ["quack", 500], goose: ["quack", 380], goat: ["bleat", 450], sheep: ["bleat", 330], cow: ["moo", 140], bison: ["moo", 95], snake: ["hiss", 4000] };
const ZOMBIES = { walker: 110, runner: 170, brute: 70 };
const MELEE = { fists: ["smack", 180], blade: ["whoosh", 1800], blunt: ["whoosh", 700], axe: ["whoosh", 1100], pickaxe: ["whoosh", 900], spear: ["whoosh", 1400], shovel: ["whoosh", 800] };
const FIRE = { bow: ["twang", 220, 0.7], crossbow: ["twang", 160, 0.8], sling: ["whoosh", 1500, 0.6], pistol: ["gunshot", 900, 0.9], rifle: ["gunshot", 600, 1], autorifle: ["gunshot", 700, 0.95], shotgun: ["gunshot", 350, 1], musket: ["gunshot", 450, 1] };
const rows = [
  // footsteps (surface from terrain tile / floor piece; swim from Anim.Swim)
  ["footstep", "sfx", 0, 6, 0.25, "step", 300, 0.45, 20, 8, fs("sfx/footstep", 4)],
  ["footstep.grass", "sfx", 0, 6, 0.25, "step", 260, 0.4, 20, 8], ["footstep.sand", "sfx", 0, 6, 0.3, "step", 500, 0.4, 20, 8],
  ["footstep.wood", "sfx", 0, 6, 0.25, "step", 180, 0.55, 20, 8], ["footstep.stone", "sfx", 0, 6, 0.2, "step", 1200, 0.5, 20, 8],
  ["footstep.dirt", "sfx", 0, 6, 0.25, "step", 350, 0.42, 20, 8], ["footstep.water", "sfx", 0, 6, 0.35, "splash", 700, 0.45, 20, 6],
  ["footstep.swim", "sfx", 0, 4, 0.8, "splash", 400, 0.5, 25, 4], ["footstep.zombie", "sfx", 0, 4, 0.35, "step", 150, 0.35, 15, 6],
  ["footstep.animal", "sfx", 0, 4, 0.2, "step", 400, 0.25, 10, 4],
  // combat
  ...Object.entries(MELEE).map(([c, [r, f]]) => [`combat.swing.${c}`, "sfx", 0, 4, 0.35, r, f, 0.6, 50, 6]),
  ["combat.punch.hit", "sfx", 0, 4, 0.2, "smack", 140, 0.75, 55, 4],
  ["combat.hit", "sfx", 0, 4, 0.25, "smack", 220, 0.8, 55, 6, fs("sfx/hit", 2)],
  ...["blade", "blunt", "axe", "pickaxe", "spear", "shovel", "arrow", "bullet"].map((c) => [`combat.hit.${c}`, "sfx", 0, 4, 0.25, "smack", c === "bullet" ? 500 : 240, 0.8, 55, 6]),
  ["combat.hit.structure", "sfx", 0, 4, 0.3, "clank", 300, 0.7, 45, 4],
  ...Object.entries(FIRE).map(([c, [r, f, v]]) => [`weapon.fire.${c}`, "sfx", 0, 3, c === "bow" || c === "crossbow" || c === "sling" ? 0.4 : 0.8, r, f, v, 75, 6]),
  ["weapon.draw.bow", "sfx", 0, 2, 0.8, "creak", 300, 0.4, 40, 2],
  ...["bow", "crossbow", "pistol", "rifle", "autorifle", "shotgun", "musket", "sling"].map((c) => [`weapon.reload.${c}`, "sfx", 0, 2, c === "bow" || c === "sling" ? 0.5 : 1.2, "reload", 900, 0.55, 45, 3]),
  ["weapon.dry", "sfx", 0, 2, 0.15, "click", 2500, 0.5, 30, 2], ["weapon.throw", "sfx", 0, 3, 0.4, "whoosh", 1000, 0.55, 45, 4],
  ["explosion", "sfx", 0, 3, 2.5, "boom", 60, 1, 95, 4], ["explosion.fire", "sfx", 0, 3, 2.5, "boom", 90, 1, 95, 4],
  ["explosion.debris", "sfx", 0, 3, 1.5, "rustle", 1500, 0.6, 60, 3], ["explosive.fuse", "sfx", 1, 1, 2, "sizzle", 3000, 0.4, 70, 3],
  // gathering
  ["gather.chop", "sfx", 0, 4, 0.4, "crack", 400, 0.8, 45, 4, fs("sfx/chop", 3)], ["gather.tree_fall", "sfx", 0, 2, 2.5, "creak", 120, 0.9, 70, 2],
  ["gather.mine", "sfx", 0, 4, 0.4, "clank", 1400, 0.75, 45, 4, fs("sfx/mine", 3)], ["gather.rock_break", "sfx", 0, 2, 1, "rustle", 600, 0.8, 60, 2],
  ["gather.dig", "sfx", 0, 4, 0.5, "dig", 250, 0.6, 40, 4], ["gather.harvest", "sfx", 0, 4, 0.4, "rustle", 2500, 0.5, 35, 4],
  ["gather.pick", "sfx", 0, 3, 0.3, "rustle", 3500, 0.45, 30, 4], ["item.pickup", "sfx", 0, 3, 0.25, "pop", 900, 0.6, 40, 4, fs("sfx/pickup", 1)],
  ["item.drop", "sfx", 0, 3, 0.3, "thud", 200, 0.5, 30, 4],
  // building / crafting / fire
  ["build.place", "sfx", 0, 3, 0.6, "thud", 140, 0.8, 55, 4, fs("sfx/build_place", 2)],
  ...["wood", "stone", "metal"].map((m) => [`build.place.${m}`, "sfx", 0, 3, 0.6, m === "metal" ? "clank" : "thud", m === "stone" ? 220 : m === "metal" ? 700 : 140, 0.8, 55, 4]),
  ["build.break", "sfx", 0, 3, 1.2, "rustle", 500, 0.85, 65, 4], ...["wood", "stone", "metal"].map((m) => [`build.break.${m}`, "sfx", 0, 3, 1.2, "rustle", m === "wood" ? 500 : m === "stone" ? 300 : 1200, 0.85, 65, 4]),
  ["build.repair", "sfx", 0, 2, 0.6, "clank", 800, 0.6, 40, 2], ["build.ghost_invalid", "ui", 0, 1, 0.2, "tick", 200, 0.4, 20, 1],
  ["craft.start", "sfx", 0, 2, 0.6, "rustle", 2000, 0.5, 35, 2], ["craft.loop", "sfx", 1, 1, 4, "rustle", 1500, 0.3, 30, 2], ["craft.complete", "ui", 0, 2, 0.6, "chime", 880, 0.6, 50, 2],
  ["cook.sizzle", "sfx", 1, 1, 4, "sizzle", 5000, 0.4, 35, 3], ["cook.complete", "sfx", 0, 2, 0.5, "chime", 660, 0.5, 40, 2],
  ["fire.ignite", "sfx", 0, 3, 1, "ignite", 2000, 0.7, 55, 3], ["fire.crackle", "ambient", 1, 2, 8, "crackle", 0, 0.55, 40, 6, ["audio/ambience/campfire_loop"]],
  ["fire.extinguish", "sfx", 0, 2, 1, "sizzle", 3000, 0.6, 50, 3], ["fire.snuffed", "sfx", 0, 2, 1.2, "snuff", 300, 0.75, 70, 2],
  ["fire.burning", "ambient", 1, 1, 8, "crackle", 0, 0.8, 50, 4],
  // doors / containers / consumption
  ["door.open", "sfx", 0, 3, 0.6, "creak", 400, 0.6, 45, 4], ["door.close", "sfx", 0, 3, 0.5, "thud", 160, 0.6, 45, 4],
  ["door.locked", "sfx", 0, 1, 0.3, "click", 1200, 0.5, 40, 2], ["door.open.metal", "sfx", 0, 2, 0.7, "creak", 900, 0.6, 45, 2], ["door.close.metal", "sfx", 0, 2, 0.5, "clank", 500, 0.6, 45, 2],
  // door-swing animation (art: <door>_swing sprites, ~312 ms doors / ~455 ms clan gates): timed open creak + close creak-and-thud
  ["door.open.swing", "sfx", 0, 2, 0.4, "creak", 520, 0.6, 45, 4], ["door.close.swing", "sfx", 0, 2, 0.45, "thud", 170, 0.6, 45, 4],
  ["door.open.gate", "sfx", 0, 2, 0.6, "creak", 260, 0.7, 50, 2], ["door.close.gate", "sfx", 0, 2, 0.6, "thud", 110, 0.7, 50, 2],
  ["container.open", "sfx", 0, 2, 0.5, "creak", 600, 0.55, 40, 2], ["container.close", "sfx", 0, 2, 0.4, "thud", 220, 0.55, 40, 2],
  ["consume.eat", "sfx", 0, 4, 0.7, "crunch", 1500, 0.55, 40, 3], ["consume.drink", "sfx", 0, 3, 0.8, "gulp", 300, 0.55, 40, 3],
  // vitals / voices
  ["player.hurt", "voice", 0, 6, 0.5, "grunt", 220, 0.7, 80, 3], ["player.death", "voice", 0, 3, 1.5, "grunt", 160, 0.85, 90, 2],
  ["player.hurt.cold", "voice", 0, 3, 0.8, "shiver", 300, 0.4, 40, 1], ["player.exhausted", "voice", 0, 3, 1.2, "breath", 400, 0.4, 35, 1],
  ...Object.entries(ZOMBIES).flatMap(([k, f]) => [
    [`zombie.${k}.idle`, "sfx", 0, 6, 2, "groan", f, 0.55, 35, 6, k === "walker" ? fs("sfx/zombie_groan", 3) : undefined],
    [`zombie.${k}.chase`, "sfx", 0, 4, 1.2, "growl", f * 1.3, 0.65, 50, 4], [`zombie.${k}.attack`, "sfx", 0, 4, 0.6, "growl", f * 1.6, 0.75, 60, 4],
    [`zombie.${k}.hurt`, "sfx", 0, 4, 0.5, "growl", f * 1.8, 0.7, 60, 4], [`zombie.${k}.death`, "sfx", 0, 3, 1.5, "groan", f * 0.8, 0.8, 70, 3]]),
  ["zombie.snuffer.idle", "sfx", 0, 4, 2, "snuff", 520, 0.6, 45, 2], ["zombie.snuffer.chase", "sfx", 0, 3, 1.5, "shriek", 1100, 0.7, 60, 2],
  ["zombie.snuffer.attack", "sfx", 0, 3, 0.7, "shriek", 1500, 0.8, 65, 2], ["zombie.snuffer.hurt", "sfx", 0, 3, 0.5, "shriek", 1700, 0.7, 60, 2],
  ["zombie.snuffer.death", "sfx", 0, 2, 2, "snuff", 300, 0.85, 75, 2], ["zombie.snuffer.snuff", "sfx", 0, 2, 1.2, "snuff", 250, 0.8, 75, 2],
  ...ANIMALS.flatMap((a) => { const [r, f] = animalVoice[a]; const art = ARTANIMAL.has(a) ? fs(`sfx/animal_${a}`, 2) : undefined;
    return [[`animal.${a}.idle`, "sfx", 0, 3, 1, r, f, 0.5, 25, 3, art], [`animal.${a}.hurt`, "sfx", 0, 3, 0.6, r, f * 1.3, 0.65, 55, 3, art], [`animal.${a}.death`, "sfx", 0, 2, 1.2, r, f * 0.8, 0.7, 60, 2, art]]; }),
  ["animal.attack", "sfx", 0, 3, 0.5, "growl", 200, 0.7, 55, 3],
  // vehicles
  ["vehicle.engine.start", "sfx", 0, 2, 1.5, "engine_start", 60, 0.7, 60, 2], ["vehicle.engine.stop", "sfx", 0, 2, 1, "engine_start", 45, 0.6, 50, 2],
  ...["car", "truck", "van", "camper", "semi"].flatMap((c) => [[`vehicle.${c}.idle`, "sfx", 1, 1, 4, "engine", c === "semi" ? 32 : c === "car" ? 48 : 40, 0.5, 60, 4], [`vehicle.${c}.rev`, "sfx", 1, 1, 4, "engine", c === "semi" ? 50 : c === "car" ? 80 : 65, 0.6, 62, 4]]),
  ["vehicle.horn", "sfx", 0, 2, 0.8, "horn", 420, 0.8, 80, 2], ["vehicle.horn.truck", "sfx", 0, 1, 1.2, "horn", 260, 0.9, 80, 2],
  ["vehicle.door.open", "sfx", 0, 2, 0.5, "click", 600, 0.6, 50, 2], ["vehicle.door.close", "sfx", 0, 2, 0.5, "thud", 180, 0.7, 50, 2],
  ["vehicle.skid", "sfx", 1, 1, 2, "rustle", 2500, 0.5, 55, 2], ["vehicle.crash", "sfx", 0, 3, 1.2, "clank", 200, 0.9, 85, 2],
  ["vehicle.bicycle.ride", "sfx", 1, 1, 3, "chain", 1800, 0.35, 40, 3], ["vehicle.bicycle.bell", "sfx", 0, 2, 0.6, "bell", 2000, 0.6, 70, 2],
  ["vehicle.bicycle.mount", "sfx", 0, 2, 0.4, "click", 900, 0.5, 40, 2], ["vehicle.headlights", "ui", 0, 1, 0.2, "click", 1500, 0.4, 20, 1],
  // defenses / farming
  ["turret.fire", "sfx", 0, 3, 0.4, "twang", 260, 0.75, 70, 4], ["turret.fire.gun", "sfx", 0, 3, 0.6, "gunshot", 700, 0.9, 75, 4],
  ["trap.snap", "sfx", 0, 2, 0.5, "clank", 1800, 0.85, 75, 3], ["trap.spike", "sfx", 0, 2, 0.5, "smack", 300, 0.8, 70, 3],
  ["farm.till", "sfx", 0, 3, 0.5, "dig", 200, 0.6, 35, 3], ["farm.water", "sfx", 0, 1, 1.5, "splash", 1200, 0.45, 30, 2],
  ["farm.plant", "sfx", 0, 3, 0.4, "rustle", 1800, 0.5, 30, 3], ["farm.grow", "ui", 0, 1, 0.4, "chime", 1320, 0.25, 10, 1], ["farm.fertilize", "sfx", 0, 2, 0.5, "rustle", 900, 0.45, 25, 2],
  // ui
  ["ui.click", "ui", 0, 2, 0.08, "click", 1800, 0.5, 90, 4, ["audio/ui/click"]], ["ui.hover", "ui", 0, 2, 0.05, "tick", 3000, 0.2, 10, 2],
  ["ui.open", "ui", 0, 1, 0.25, "whoosh", 2600, 0.4, 80, 2], ["ui.close", "ui", 0, 1, 0.2, "whoosh", 1800, 0.35, 80, 2],
  ["ui.back", "ui", 0, 1, 0.15, "tick", 900, 0.4, 80, 2], ["ui.error", "ui", 0, 1, 0.3, "tick", 160, 0.5, 85, 2],
  ["ui.slider", "ui", 0, 1, 0.05, "tick", 2200, 0.35, 70, 2], ["ui.levelup", "ui", 0, 1, 2.5, "fanfare", 523, 0.75, 95, 1],
  ["ui.notify", "ui", 0, 2, 0.6, "chime", 990, 0.5, 85, 2], ["ui.toast.warn", "ui", 0, 1, 0.5, "chime", 440, 0.5, 85, 2],
  // roaming hordes (ADR-121): HUD cues from HordeStatus (warning -> spawn -> defeated)
  ["horde.warning", "ui", 0, 2, 3, "howl", 180, 0.75, 90, 1], ["horde.spawn", "ui", 0, 2, 2.5, "growl", 90, 0.8, 90, 1], ["horde.defeated", "ui", 0, 1, 1.5, "chime", 660, 0.6, 85, 1],
  ["ui.chat", "ui", 0, 1, 0.2, "pop", 1500, 0.35, 60, 2], ["ui.craft_queue", "ui", 0, 1, 0.2, "pop", 1100, 0.35, 50, 1],
  // weather / ambience
  ["weather.rain", "ambient", 1, 2, 12, "rain", 0, 0.5, 30, 1, ["audio/ambience/rain_loop"]], ["weather.rain.indoor", "ambient", 1, 1, 12, "rain", 0, 0.35, 30, 1],
  ["weather.wind", "ambient", 1, 2, 12, "wind", 0, 0.45, 30, 1], ["weather.thunder", "ambient", 0, 4, 4, "thunder", 0, 0.9, 80, 2],
  ["weather.snow", "ambient", 1, 1, 12, "wind", 0, 0.25, 25, 1],
  ["amb.day", "ambient", 1, 2, 20, "birds", 0, 0.35, 20, 1, ["audio/ambience/forest_loop"]], ["amb.day.forest", "ambient", 1, 2, 20, "birds", 0, 0.4, 20, 1, ["audio/ambience/forest_loop"]],
  ["amb.day.beach", "ambient", 1, 1, 20, "wind", 0, 0.3, 20, 1], ["amb.day.rocky", "ambient", 1, 1, 20, "wind", 0, 0.25, 20, 1],
  ["amb.night", "ambient", 1, 2, 20, "crickets", 0, 0.35, 20, 1], ["amb.night.forest", "ambient", 1, 1, 20, "crickets", 0, 0.4, 20, 1],
  ["amb.bird", "ambient", 0, 8, 1.5, "chirp", 2800, 0.3, 10, 2], ["amb.owl", "ambient", 0, 3, 1.5, "hoot", 420, 0.35, 10, 1],
  ["amb.zombie_distant", "ambient", 0, 6, 3, "groan", 90, 0.25, 10, 1], ["amb.water.shore", "ambient", 1, 2, 12, "water", 0, 0.45, 25, 1],
  ["amb.indoor", "ambient", 1, 1, 12, "rumble", 0, 0.2, 15, 1],
  // music (streamed; layers crossfade by state)
  ["music.menu", "music", 1, 1, 120, "music_menu", 0, 0.6, 100, 1], ["music.explore", "music", 1, 3, 150, "music_calm", 0, 0.5, 100, 1],
  ["music.night", "music", 1, 2, 150, "music_night", 0, 0.5, 100, 1], ["music.combat.low", "music", 1, 1, 90, "music_combat_low", 0, 0.5, 100, 1],
  ["music.combat.high", "music", 1, 1, 90, "music_combat_high", 0, 0.55, 100, 1], ["music.stinger.death", "music", 0, 1, 4, "music_death", 0, 0.7, 100, 1],
  ["music.stinger.dawn", "music", 0, 1, 6, "fanfare", 392, 0.5, 100, 1],
];
// Delivered recordings: packages/assets/pack/audio/<dir>/<key with dots as _>_<n>.ogg (+ .m4a) replace the placeholders.
const AUDIO_DIR = { sfx: "sfx", ui: "ui", ambient: "ambience", music: "music", voice: "voice" };
const delivered = (key, bus) => {
  const base = key.replaceAll(".", "_"); const re = new RegExp(`^${base}_(\\d+)\\.ogg$`); const out = [];
  for (const d of new Set([AUDIO_DIR[bus], "music"])) {
    const dir = `${R}packages/assets/pack/audio/${d}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) { const m = f.match(re); if (m) out.push([+m[1], `audio/${d}/${base}_${m[1]}`]); }
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
};
let deliveredCount = 0;
const sounds = {}; const md = [];
for (const [key, bus, loop, variants, len, synth, freq, volume, priority, maxVoices, placeholder] of rows) {
  const got = delivered(key, bus); deliveredCount += Math.min(got.length, variants);
  const files = got.length ? got : placeholder;
  if (sounds[key]) throw new Error(`dup ${key}`);
  const stream = bus === "music";
  sounds[key] = { bus, ...(files ? { files } : {}), volume, pitchJitter: bus === "music" || bus === "ui" ? 0.02 : loop ? 0.03 : 0.08, volumeJitter: loop || bus === "music" ? 0 : 0.12,
    loop: !!loop, ...(stream ? { stream: true } : {}), priority, maxVoices, synth: { r: synth, f: Math.round(freq), len: Math.min(len, stream ? 16 : loop ? 4 : len) } };
  const fmt = stream ? "ogg/opus 96-128 kbps stereo + m4a (AAC) fallback, -16 LUFS, seamless loop points" : bus === "ambient" && loop ? "ogg/opus 64-96 kbps stereo + m4a fallback, seamless loop" : "ogg/opus mono 48 kHz + m4a fallback, peak -1 dBFS";
  md.push(`| \`${key}\` | ${bus} | ${loop ? "loop" : "one-shot"} | ${variants} | ${len < 1 ? `${Math.round(len * 1000)} ms` : `${len} s`} | ${fmt} | ${got.length ? `delivered: ${got.length} file(s)` : files ? `has placeholder: ${files.length} file(s)` : "new"} |`);
}
const bank = { $comment: "ADR-117 sound bank, GENERATED by scripts/gen-audio-bank.mjs (edit the table there). files are extensionless under art/pack/; formats are tried in order per browser support; synth = procedural placeholder used when no file decodes.", version: 1, basePath: "art/pack/", formats: ["ogg", "m4a", "mp3"], sounds };
writeFileSync(`${R}apps/client/src/audio/bank.json`, JSON.stringify(bank, null, 1) + "\n");
writeFileSync(`${R}docs/AUDIO_ASSETS.md`, `# Audio asset request list (ADR-117)

GENERATED by \`scripts/gen-audio-bank.mjs\` from the same table as \`apps/client/src/audio/bank.json\`. For the Art & Assets agent.

Delivery: files go under \`packages/assets/pack/audio/<sfx|ambience|ui|music|voice>/\` named \`<key with dots as _>_<n>.ogg\` (+ the same name \`.m4a\` for Safari), then add them to the row's \`files\` in the generator. Keep .wav masters next to them (not shipped). Variants are picked at random (no immediate repeat) with pitch/volume jitter on top, so variants should differ in performance, not just pitch. One-shots: trim leading silence (<5 ms), no reverb tails baked in beyond the target length. Loops: sample-accurate seamless loops; positional loops (fire, engines) mono. Engine loops are pitched by RPM (0.8-1.6x), so record at a steady mid RPM. Music: stems per layer at the same tempo/key so they crossfade; each track 2-3 min with a natural end (the director adds 30-90 s silence gaps).

Total keys: ${rows.length}. Total variant files requested: ${rows.reduce((a, r) => a + r[3], 0)}. Delivered: ${deliveredCount} (procedural, generated by \`assets/audio/tools/build.py\`).

| Event key | Bus | Type | Variants | Target length | Format | Status |
|---|---|---|---|---|---|---|
${md.join("\n")}
`);
console.log(`bank: ${rows.length} keys, ${deliveredCount} delivered recordings`);
