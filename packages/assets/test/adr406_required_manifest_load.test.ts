// ADR-406: index-listed (required) manifest files must THROW with the cause instead of returning
// undefined. `loadMergedManifestWith` takes an optional `io.getRequired` for required fragment loads
// and for every shard of a v2 index; when it is absent (the dedicated server's file-based loader)
// `io.get` is used and the old "manifest shard missing" behaviour is unchanged.
import { describe, expect, it } from "vitest";
import { loadMergedManifestWith, type ManifestFragmentRef } from "../src/manifest-index.js";

const ART = "https://x/art/";
const INDEX = { version: 2, name: "customization", shards: [{ category: "top", file: "manifest.customization.top.json", bytes: 0, sha: "" }] };
const PACK = { version: 1, name: "pack", atlases: [], sprites: [] };

describe("ADR-406 required manifest loads", () => {
  it("a required shard load throws with the cause (URL + status + attempts), not 'missing'", async () => {
    const list: ManifestFragmentRef[] = [{ name: "customization", url: "pack/customization/manifest.customization.json", optional: true }];
    const get = async (u: string): Promise<unknown> => {
      if (u.endsWith("manifest.customization.json")) return INDEX;
      if (u.endsWith("ids.lock.json")) return undefined;
      return undefined;
    };
    const getRequired = async (u: string): Promise<unknown> => {
      if (u.endsWith("manifest.customization.top.json")) {
        throw new Error("manifest load failed: https://x/art/pack/customization/manifest.customization.top.json: HTTP 404 on every fetch attempt (instant, delayed, and cache-busting retries included)");
      }
      return get(u);
    };
    await expect(loadMergedManifestWith(list, { get, getRequired, artUrl: ART }))
      .rejects.toThrow(/manifest\.customization\.top\.json.*HTTP 404 on every fetch attempt/);
  });

  it("without getRequired a missing shard still throws 'manifest shard missing' (server compat)", async () => {
    const list: ManifestFragmentRef[] = [{ name: "customization", url: "pack/customization/manifest.customization.json", optional: true }];
    const get = async (u: string): Promise<unknown> => {
      if (u.endsWith("manifest.customization.json")) return INDEX;
      return undefined;
    };
    await expect(loadMergedManifestWith(list, { get, artUrl: ART }))
      .rejects.toThrow(/manifest shard missing: manifest\.customization\.top\.json/);
  });

  it("an optional fragment that 404s is still skipped even when getRequired is present", async () => {
    const list: ManifestFragmentRef[] = [
      { name: "pack", url: "pack/manifest.json" },
      { name: "customization", url: "pack/customization/manifest.customization.json", optional: true },
    ];
    const get = async (u: string): Promise<unknown> => {
      if (u.endsWith("pack/manifest.json")) return PACK;
      return undefined;
    };
    const getRequired = async (u: string): Promise<unknown> => {
      if (u.endsWith("manifest.customization.json")) throw new Error(`getRequired must not be called for optional fragments: ${u}`);
      return get(u);
    };
    const { fragments } = await loadMergedManifestWith(list, { get, getRequired, artUrl: ART });
    expect(fragments).toEqual(["pack"]);
  });

  it("a required fragment uses getRequired, so its failure carries the cause", async () => {
    const list: ManifestFragmentRef[] = [{ name: "pack", url: "pack/manifest.json" }];
    const get = async (): Promise<unknown> => undefined;
    const getRequired = async (u: string): Promise<unknown> => {
      throw new Error(`manifest load failed: ${u}: HTTP 404 on every fetch attempt (instant, delayed, and cache-busting retries included)`);
    };
    await expect(loadMergedManifestWith(list, { get, getRequired, artUrl: ART }))
      .rejects.toThrow(/pack\/manifest\.json.*HTTP 404 on every fetch attempt/);
  });
});
