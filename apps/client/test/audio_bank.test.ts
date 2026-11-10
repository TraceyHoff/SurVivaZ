import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SoundBank, playableFormats, BUSES, type SoundBankJson } from "../src/audio/bank.js";
import bank from "../src/audio/bank.json";
const J: SoundBankJson = { version: 1, basePath: "art/pack/", formats: ["ogg", "m4a", "mp3"], sounds: {
  "footstep": { bus: "sfx", files: ["audio/sfx/footstep_1", "audio/sfx/footstep_2", "audio/sfx/footstep_3"], volume: 0.8, pitchJitter: 0.1, volumeJitter: 0.1, loop: false, priority: 10, maxVoices: 4 },
  "footstep.sand": { bus: "sfx", volume: 0.7, pitchJitter: 0, volumeJitter: 0, loop: false, priority: 10, maxVoices: 4, synth: { r: "step", f: 400, len: 0.2 } },
} } as unknown as SoundBankJson;
describe("ADR-117 sound bank", () => {
  test("exact key, dotted-parent fallback, missing key is silent", () => {
    const b = new SoundBank(J, ["ogg"]);
    expect(b.lookup("footstep.sand")?.key).toBe("footstep.sand");
    expect(b.lookup("footstep.grass.wet")?.key).toBe("footstep");
    expect(b.lookup("nope.nothing")).toBeUndefined();
    expect(b.resolve("nope", "")).toBeUndefined();
  });
  test("urls honour format preference order and base path", () => {
    const b = new SoundBank(J, ["opus", "m4a"]); b.setFormats(["m4a", "mp3"]);
    expect(b.urlsFor("audio/sfx/footstep_1", "/g/")).toEqual(["/g/art/pack/audio/sfx/footstep_1.m4a", "/g/art/pack/audio/sfx/footstep_1.mp3"]);
  });
  test("playableFormats filters by canPlayType", () => {
    expect(playableFormats(["ogg", "m4a", "mp3"], (m) => (m.includes("ogg") ? "" : "maybe"))).toEqual(["m4a", "mp3"]);
  });
  test("variants never repeat back to back; jitter stays in range", () => {
    let s = 1; const rng = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const b = new SoundBank(J, ["ogg"], rng); let last = -1;
    for (let i = 0; i < 50; i++) { const r = b.resolve("footstep", "")!; expect(r.variant).not.toBe(last); last = r.variant;
      expect(r.pitch).toBeGreaterThanOrEqual(0.9 - 1e-9); expect(r.pitch).toBeLessThanOrEqual(1.1 + 1e-9); expect(r.gain).toBeLessThanOrEqual(0.88 + 1e-9); }
  });
  test("synth-only key resolves to variant -1 (placeholder)", () => { expect(new SoundBank(J, ["ogg"]).resolve("footstep.sand", "")!.variant).toBe(-1); });
  test("shipped bank: every key valid, every sound has a placeholder, buses known", () => {
    const sounds = (bank as unknown as SoundBankJson).sounds; expect(Object.keys(sounds).length).toBeGreaterThan(200);
    for (const [k, d] of Object.entries(sounds)) { expect(k).toMatch(/^[a-z0-9_.]+$/); expect(BUSES).toContain(d.bus); expect(d.synth, k).toBeTruthy(); expect(d.maxVoices).toBeGreaterThan(0); }
    for (const k of ["music.menu", "music.explore", "music.night", "music.combat.low", "music.combat.high"]) expect(sounds[k]?.bus).toBe("music");
  });
});

describe("ADR-334 m4a-only audio", () => {
  const shipped = bank as unknown as SoundBankJson;
  test("shipped bank formats are m4a-first with no ogg", () => {
    expect(shipped.formats).toEqual(["m4a", "mp3"]);
    expect(shipped.formats).not.toContain("ogg");
  });
  test("shipped bank resolves to .m4a first and never .ogg", () => {
    const b = new SoundBank(shipped);
    for (const [k, d] of Object.entries(shipped.sounds)) for (const f of d.files ?? []) {
      const urls = b.urlsFor(f, "");
      expect(urls[0], k).toMatch(/\.m4a$/);
      expect(urls.some((u) => u.endsWith(".ogg")), k).toBe(false);
    }
    expect(b.resolve("footstep", "")!.urls[0]).toMatch(/\.m4a$/);
  });
  test("every bank-referenced file has an m4a twin on disk", () => {
    const pack = fileURLToPath(new URL("../../../packages/assets/pack/", import.meta.url));
    const missing: string[] = [];
    for (const d of Object.values(shipped.sounds)) for (const f of d.files ?? []) if (!existsSync(pack + f + ".m4a")) missing.push(f);
    expect(missing).toEqual([]);
  });
});
