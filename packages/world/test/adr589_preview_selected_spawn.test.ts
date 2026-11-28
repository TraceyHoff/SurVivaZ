// ADR-589: worldPreviewSvg paints the selected spawn point yellow; without a selection the
// output is byte-identical to the pre-ADR-589 markers output.
import { describe, expect, it } from "vitest";
import { sampleWorldPreview, worldPreviewSvg, worldToSurveyPixel } from "../src/preview.js";
import { computeSpawnPoints } from "../src/spawnPoints.js";
import { ProceduralGenerator } from "../src/generator.js";

const p = sampleWorldPreview(424242);
const spawns = computeSpawnPoints(new ProceduralGenerator({ seed: 424242 })).map((s) => worldToSurveyPixel(p, s.x, s.y));

describe("ADR-589 selected spawn marker", () => {
  it("overdraws exactly the selected ring and dot in yellow", () => {
    const svg = worldPreviewSvg(p, { spawns, selectedSpawn: 2 });
    const yellow = svg.split("#ffd23e").length - 1;
    expect(yellow).toBe(2); // one ring group + one dot group
    const sel = spawns[2]!;
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    expect(svg).toContain(`<g fill="none" stroke="#ffd23e" stroke-width="1.1"><circle cx="${r1(sel.px)}" cy="${r1(sel.py)}" r="3.4"/></g>`);
    expect(svg).toContain(`<g fill="#ffd23e"><circle cx="${r1(sel.px)}" cy="${r1(sel.py)}" r="1.1"/></g>`);
  });

  it("no selection = legacy output, byte for byte", () => {
    const legacy = worldPreviewSvg(p, { spawns });
    expect(legacy).not.toContain("#ffd23e");
    expect(worldPreviewSvg(p, { spawns: [...spawns] })).toBe(legacy);
  });

  it("an off-survey selection draws nothing yellow", () => {
    const far = [{ px: -40, py: -40 }, ...spawns.slice(1)];
    expect(worldPreviewSvg(p, { spawns: far, selectedSpawn: 0 })).not.toContain("#ffd23e");
  });
});
