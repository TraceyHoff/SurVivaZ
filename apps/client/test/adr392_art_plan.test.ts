// ADR-392: dist/art ships what the client resolves. Replays the client's boot (merged manifest ->
// sourcesFromManifest -> prefetch lists) against the planned output and pins that nothing it can request is
// dropped, that only always-resident atlases lose their KTX2 fields, and that the resolved sources are
// otherwise unchanged (so every device path - KTX2 pools, PNG pools, gl=safe / ktx2=0, Canvas2D - loads the same files).
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { artCodeRoots, artFile, artMounts, artServed } from "../vite.config.js";
import { planArt, replayClient, uiDropReason, type ArtPlan } from "../art-build.js";
import { atlasPoolSets, RESIDENT_CREATURE_RE, RESIDENT_GROUND_RE, type AtlasPoolFlags } from "@engine/render/src/assets/atlasManager.js";
import { servedManifestIndex } from "@engine/assets";

const HAS_UI = existsSync(new URL("../../../assets/ui/theme.json", import.meta.url));
let plan: ArtPlan;
const readSrc = (u: string): unknown => { const f = artFile(u); return f && u.endsWith(".json") ? JSON.parse(readFileSync(f, "utf8")) : undefined; };
beforeAll(async () => { plan = await planArt(artMounts(), { codeRoots: artCodeRoots(), brandingBg: "parallax" }); }, 120_000);

const stripKtx2 = (s: unknown): unknown => { const o = structuredClone(s) as Record<string, unknown> & { pages?: Record<string, unknown>[] }; delete o["ktx2"]; delete o["masksKtx2"]; for (const p of o.pages ?? []) { delete p["ktx2"]; delete p["masksKtx2"]; } return o; };

describe("ADR-392 dist art plan", () => {
  it("every file the client resolves from the shipped manifests is shipped", async () => {
    const shipped = new Map(plan.files.map((f) => [f.url, f]));
    const read = (u: string): unknown => { const f = shipped.get(u); return f ? (f.json !== undefined ? f.json : readSrc(u)) : undefined; };
    const r = await replayClient(read, plan.index);
    const missing = [...r.refs].filter((u) => artServed(u) && !shipped.has(u));
    expect(missing).toEqual([]);
    // the manifests themselves ship
    for (const u of r.fetched) expect(shipped.has(u), u).toBe(true);
  }, 120_000);

  it("resolved sources are unchanged except KTX2 twins of always-resident atlases", async () => {
    const shipped = new Map(plan.files.map((f) => [f.url, f]));
    const before = await replayClient(readSrc, servedManifestIndex(artServed));
    const after = await replayClient((u) => { const f = shipped.get(u); return f ? (f.json !== undefined ? f.json : readSrc(u)) : undefined; }, plan.index);
    expect([...after.sources.keys()].sort()).toEqual([...before.sources.keys()].sort());
    const stripped = new Set(plan.ktx2Stripped); let changed = 0;
    for (const [k, s] of before.sources) {
      const a = after.sources.get(k)!;
      if (stripped.has(k)) { expect(a).toEqual(stripKtx2(s)); changed++; } else expect(a, k).toEqual(s);
    }
    expect(changed).toBe(stripped.size);
    expect(stripped.size).toBeGreaterThan(0);
  }, 120_000);

  it("stripped atlases are resident under every streaming configuration; pets / critters / ground keep KTX2", async () => {
    const r = await replayClient(readSrc, servedManifestIndex(artServed));
    const flags = ["streamWearables", "streamVehicles", "streamBuildingTiers", "streamSheets", "residentCreatures", "ktx2"] as const;
    for (let m = 0; m < 1 << flags.length; m++) {
      const f = Object.fromEntries(flags.map((k, i) => [k, !!(m & (1 << i))])) as unknown as AtlasPoolFlags;
      const p = atlasPoolSets(r.registry, r.sources, f);
      for (const k of plan.ktx2Stripped) for (const set of [p.lazyKeys, p.legacy, p.vehKeys, p.bldKeys, p.streamKeys, p.bodyKeys]) expect(set.has(k), `${k} lazy with flags ${m}`).toBe(false);
    }
    // the low-memory path (budget < 128 MB) streams pets / critters / ground sheets from their KTX2: kept
    const lowMem = atlasPoolSets(r.registry, r.sources, { streamWearables: true, streamVehicles: true, streamBuildingTiers: true, streamSheets: true, residentCreatures: false, ktx2: true });
    const flip = [...r.registry.atlases.values()].filter((a) => (RESIDENT_CREATURE_RE.test(a.key) || RESIDENT_GROUND_RE.test(a.key)) && lowMem.streamKeys.has(a.key)).map((a) => a.key);
    expect(flip.length).toBeGreaterThan(0);
    for (const k of flip) expect(plan.ktx2Stripped.includes(k), k).toBe(false);
  }, 120_000);

  it("drops only atlas-dir files nothing resolves or names, resident KTX2 twins and the listed UI copies", () => {
    for (const d of plan.dropped) {
      if (uiDropReason(d.url, "parallax")) continue;
      if (d.why !== "KTX2 of an always-resident atlas") expect(d.url, d.why).toMatch(/^(?:pack\/(?:[\w-]+\/)*atlases|pvp_clan\/atlases|stalls\/atlases)\//);
      expect(plan.refs.has(d.url), d.url).toBe(false);
      expect(d.url).not.toMatch(/\.hands\.json$/);
    }
    const shipped = new Set(plan.files.map((f) => f.url));
    // code-named atlas files stay (name tags, gather fx, held-item hands)
    for (const u of ["pvp_clan/atlases/nameplates@2x.png", "pack/nature/atlases/nature_adr128_fx.png", "pack/items/atlases/items_xp_chip@2x.png"]) if (artServed(u)) expect(shipped.has(u), u).toBe(true);
    if (HAS_UI) {
      expect(shipped.has("ui/branding/background/parallax/menu_bg_sky.png")).toBe(true);
      expect([...shipped].some((u) => /^ui\/(?:input|hooks)\/atlas\/engine\//.test(u))).toBe(false);
    }
    expect([...shipped].some((u) => u.endsWith(".ogg"))).toBe(false);
    const total = plan.dropped.reduce((t, d) => t + d.bytes, 0);
    console.log(`[adr392] ${plan.files.length} shipped, ${plan.dropped.length} dropped (${total} B), ${plan.ktx2Stripped.length} atlases KTX2-stripped`);
  });
});
