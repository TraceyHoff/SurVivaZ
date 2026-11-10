// ADR-333: `customization_v2_sample` is excluded from dist — the v2 sample is dev-only; the opt-in
// `?charArt=v2s` preview no longer has files to fetch (accepted by the user), and default (v1) players
// never fetch it (packages/assets/src/manifest-index.ts gates it behind charArt v2s/v2s-all).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { artFile, artServed } from "../vite.config.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
const V2 = "pack/customization_v2_sample/";

describe("ADR-333 customization_v2_sample excluded from dist", () => {
  it("the sample files stay in the repo for dev", () => {
    expect(existsSync(join(ROOT, "packages/assets/pack/customization_v2_sample/manifest.customization_v2_sample.json"))).toBe(true);
    expect(existsSync(join(ROOT, "packages/assets/pack/customization_v2_sample/atlases/v2s_wr_body_male.png"))).toBe(true);
  });

  it("no v2 sample file is served (manifest or atlases)", () => {
    expect(artServed(V2 + "manifest.customization_v2_sample.json")).toBe(false);
    expect(artServed(V2 + "atlases/v2s_wr_body_male.png")).toBe(false);
    expect(artServed(V2 + "atlases/v2s_wr_body_male.ktx2")).toBe(false);
    expect(artFile(V2 + "manifest.customization_v2_sample.json")).toBeUndefined();
    expect(artFile(V2 + "atlases/v2s_wr_body_male.png")).toBeUndefined();
  });

  it("neighbouring pack mounts are still served", () => {
    expect(artServed("pack/manifest.json")).toBe(true);
    expect(artServed("pack/vehicles/manifest.vehicles.json")).toBe(true);
    expect(artServed("pack/task34/manifest.task34.json")).toBe(true);
    expect(artServed("pack/customization/manifest.customization.json")).toBe(true);
  });
});
