// ADR-248: the dedicated server's merged manifest is the client's: same fragments, same cosmetics catalog and hash.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cosmeticsHashes } from "@engine/core";
import { loadMergedManifestWith, servedManifestIndex } from "@engine/assets";
import { loadMergedPackManifest } from "@engine/assets/node";
import { artFile, artServed } from "../vite.config.js";

const ART = "http://client.test/art/";
/** The client's fetch, replayed against what the dev server serves (vite.config MOUNTS + manifests.index.json). */
const clientGet = async (url: string): Promise<unknown> => {
  if (!url.startsWith(ART)) return undefined;
  const rel = decodeURIComponent(url.slice(ART.length));
  if (rel === "manifests.index.json") return servedManifestIndex(artServed);
  const f = artFile(rel); return f ? JSON.parse(readFileSync(f, "utf8")) : undefined;
};

describe("ADR-248 server/client manifest parity", () => {
  it("the server's merged manifest has the client's cosmetics (18 skin tones, same wearables, same hash)", async () => {
    const idx = await clientGet(ART + "manifests.index.json") as ReturnType<typeof servedManifestIndex>;
    const client = await loadMergedManifestWith(idx.fragments, { get: clientGet, artUrl: ART });
    const server = await loadMergedPackManifest();
    const c = client.result.registry.cosmetics!, s = server.result.registry.cosmetics!;
    expect(s).toBeDefined(); expect(c).toBeDefined();
    expect(server.fragments).toEqual(client.fragments);
    expect(server.fragments).toContain("customization");
    expect(s.skinTones.length).toBe(18);
    expect(s.size).toBe(c.size);
    expect(s.skinTones.map((t) => t.key)).toEqual(c.skinTones.map((t) => t.key));
    expect(cosmeticsHashes(s)).toEqual(cosmeticsHashes(c));
    expect(server.result.registry.hash).toBe(client.result.registry.hash);
  });

  it("ADR-540: the task540 fragment (cougar + wolverine) is served to the client and in the server's merged manifest", async () => {
    const idx = await clientGet(ART + "manifests.index.json") as ReturnType<typeof servedManifestIndex>;
    const client = await loadMergedManifestWith(idx.fragments, { get: clientGet, artUrl: ART });
    const server = await loadMergedPackManifest();
    // Both sides list the fragment: the server reads MANIFEST_INDEX from disk, the client
    // only lists fragments vite.config MOUNTS actually serves — drop either registration and
    // the two lists diverge (proved by removing task540 from MOUNTS: this test fails).
    expect(server.fragments).toContain("task540");
    expect(client.fragments).toContain("task540");
    expect(server.fragments).toEqual(client.fragments);
    for (const { result } of [server, client]) {
      for (const key of ["animal_cougar", "animal_wolverine"]) {
        const s = result.registry.byKey(key);
        expect(s).toBeDefined();
        expect(s.category).toBe("critter");
        // idle / walk / run / attack / death, 8 directions each; attack is painted (no fallback).
        for (const an of ["idle", "walk", "run", "attack", "death"]) {
          const a = s.animations.get(an)!;
          expect(a, `${key}.${an}`).toBeDefined();
          expect(a.directions).toBe(8);
          expect(a.dirStride).toBe(8);
        }
        expect(s.animations.get("idle")!.frames).toEqual([0, 1, 2, 3]);
        expect(s.animations.get("walk")!.frames).toEqual([64, 65, 66, 67]);
        expect(s.animations.get("attack")!.frames).toEqual([128, 129]);
        expect(s.animations.get("death")!.frames).toEqual([192, 193]);
      }
      // Atlas grid matches the painter: cougar 56px x 8 x 32, wolverine 48px x 8 x 32.
      expect(result.registry.atlases.get("pred_cougar")).toMatchObject({ frameW: 56, frameH: 56, columns: 8, rows: 32 });
      expect(result.registry.atlases.get("pred_wolverine")).toMatchObject({ frameW: 48, frameH: 48, columns: 8, rows: 32 });
    }
    expect(server.result.registry.hash).toBe(client.result.registry.hash);
  });
});
