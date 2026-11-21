// @vitest-environment jsdom
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadManifest, mergeManifests } from "@engine/assets";
import { creatorOptions, showCharacterCreator } from "../src/character-creator.js";
import { readManifestJson } from "@engine/assets/read-manifest";
const CLOTHING_STARTERS = ["top_henley", "top_striped_tee", "top_polo", "top_cardigan", "bottom_capris", "bottom_cutoffs", "bottom_joggers", "bottom_pleated_skirt",
  "shoes_loafers", "shoes_moccasins", "shoes_slip_ons", "shoes_trail_runners"];
const FACE_STARTERS = ["face_chops", "face_goatee", "face_long_beard", "face_rosy"];
function catalog(): any {
  const P = "packages/assets/pack/"; const base = readManifestJson(P + "manifest.json"); const cz = readManifestJson(P + "customization/manifest.customization.json");
  const { manifest } = mergeManifests([{ name: "pack", manifest: base }, { name: "customization", manifest: cz }] as any, { resolve: (p: string) => p } as any);
  const r = loadManifest(manifest, { lock: JSON.parse(readFileSync(P + "ids.lock.json", "utf8")) }) as any; return (r.registry ?? r).cosmetics;
}
it("ADR-115 (Task 23): clothing is NOT offered by the creator — a new survivor starts with no clothes; face starters still are", () => {
  const cz = readManifestJson("packages/assets/pack/customization/manifest.customization.json");
  const list: any[] = Array.isArray(cz.wearables) ? cz.wearables : Object.entries(cz.wearables ?? {}).map(([key, v]: any) => ({ key, ...v }));
  const free = list.filter((w) => !(w.unlockTags ?? w.unlock ?? []).length).map((w) => w.key);
  const cat = catalog(); expect(cat).toBeTruthy();
  for (const b of [0, 1]) { const keys = new Set(Object.values(creatorOptions(cat, b)).flat().map((w: any) => w.key));
    for (const k of FACE_STARTERS) expect(keys.has(k), `${k} body ${b}`).toBe(true);
    for (const k of CLOTHING_STARTERS) expect(keys.has(k), `${k} body ${b} (Task 23: no starting clothes)`).toBe(false);
    expect(free.filter((k) => !keys.has(k) && !/hair_|face_/.test(k) && !/^(top|bottom|shoes|hat|acc)_/.test(k))).toEqual([]); } // Task 23: clothing, hats and accessories are wardrobe items, not starter choices
});
it("ADR-502: creator preview has no background — no preview_bg image, no tan fill; the icon buttons (aria-labelled, @2x) stay", () => {
  document.body.innerHTML = ""; const p = showCharacterCreator({ root: document.body, catalog: catalog(), artBase: "/art/ui/creator/", pads: () => [] } as any);
  const host = document.querySelector<HTMLElement>('[data-role="creator-preview-host"]')!; expect(host.dataset["bg"]).toBeUndefined(); expect(host.style.backgroundImage).toBe(""); expect(host.style.background).toBe("");
  for (const n of ["ic_rotate_left", "ic_rotate_right", "ic_randomize"]) { const img = document.querySelector<HTMLImageElement>(`img[data-icon="${n}"]`)!; expect(img.srcset).toContain(`${n}@2x.png 2x`);
    expect(img.closest("button")!.getAttribute("aria-label")).toMatch(/Rotate|Randomize/); }
  void p;
});
